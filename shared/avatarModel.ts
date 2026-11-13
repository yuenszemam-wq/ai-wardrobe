// 角色模型（Phase 3.6）：內置 Avatar V2 及使用者自訂身體。
// 自訂身體不是任意骨架：沿用 V2 的骨骼名稱、父子關係、錨點名稱及 1200×1800 邏輯畫布，
// 只記錄「與 V2 不同的地方」（ModelDef）：替換的部件圖片及位置、關節位置及活動範圍、錨點、圖層次序、頭部對位。
// 每次保存產生一個不可變版本（revision）；造型記錄所用的模型及版本，日後修改身體不會改變舊造型。
// 純函數，前端、Worker 及測試共用。
import type { Bone, Rig, RigPart } from "./avatarRig";
import { AVATAR_V2_ID, AVATAR_V2_BASE, RIG_V2, HairConfig, HeadConfig, ImageRef, isImageRef } from "./avatarV2";

/** 頭部（及頭髮）在這個身體上的對位：以 V2 頭部關節為中心縮放 s，再平移 dx、dy */
export interface HeadFit { dx: number; dy: number; s: number }
export const NO_HEAD_FIT: HeadFit = { dx: 0, dy: 0, s: 1 };
/** 一個身體部件與 V2 不同的設定 */
export interface PartDef {
  /** 替換圖片；沒有＝沿用 V2 原圖 */
  file?: ImageRef | null;
  /** 靜止姿勢下圖片在畫布上的範圍（旋轉前） */
  x: number; y: number; w: number; h: number;
  /** 以圖片中心旋轉（度） */
  rot?: number;
  /** 附接骨骼；沒有＝沿用 V2 */
  bone?: string;
  hidden?: boolean;
  /** 上傳時的原始畫布尺寸及透明留白裁剪範圍（原圖像素），方便日後重新對位 */
  src?: { w: number; h: number; crop: [number, number, number, number] };
}
/** 一節骨骼與 V2 不同的設定：靜止關節位置（旋轉中心）及活動範圍 */
export interface BoneDef { pivot?: [number, number]; min?: number; max?: number }
export interface ModelDef {
  v: 1;
  base: typeof AVATAR_V2_ID;
  parts: Record<string, PartDef>;
  bones: Record<string, BoneDef>;
  anchors: Record<string, [number, number]>;
  /** 身體部件的繪畫次序（由後到前）；沒有＝V2 次序 */
  order?: string[];
  /** 所有頭部的預設對位 */
  head: HeadFit;
  /** 個別頭部素材在這個身體上的對位（覆蓋預設） */
  heads?: Record<string, HeadFit>;
}
export const EMPTY_DEF: ModelDef = { v: 1, base: AVATAR_V2_ID, parts: {}, bones: {}, anchors: {}, head: NO_HEAD_FIT };

export interface AvatarModel {
  readonly id: string;
  readonly revision: number;
  readonly rig: Rig;
  /** Base URL of cropped body sprites. Trailing slash required. */
  readonly assetBase: string;
  readonly name?: string;
  readonly def?: ModelDef;
}

export const DEFAULT_BODY_MODEL: AvatarModel = {
  id: AVATAR_V2_ID,
  revision: RIG_V2.version,
  rig: RIG_V2,
  assetBase: AVATAR_V2_BASE,
  name: "Avatar V2",
  def: EMPTY_DEF,
};
export const isBuiltinModel = (id: string | null | undefined) => !id || id === AVATAR_V2_ID;
export const MODEL_ID = /^(avatar_v2|dm_[a-z2-7]{6,40})$/;
export const isModelId = (v: unknown): v is string => typeof v === "string" && MODEL_ID.test(v);

/** 只用於驗證外來姿勢的寬鬆骨架（任何模型的骨骼名稱相同、活動範圍可以不同）；顯示時再按實際模型限制 */
export const LOOSE_RIG: Rig = { ...RIG_V2, bones: RIG_V2.bones.map((b) => ({ ...b, min_angle: -180, max_angle: 180, ...(b.max_offset ? { max_offset: [400, 400] as [number, number] } : {}) })) };

// ───── 可以修改的範圍 ─────
const HAIR_BONE = (id: string) => id.startsWith("hair_");
/** 身體部件（不含頭部：頭部用獨立的頭部素材） */
export const EDITABLE_PARTS = RIG_V2.body_parts.filter((p) => p !== "head");
export const EDITABLE_BONES = RIG_V2.bones.filter((b) => !HAIR_BONE(b.id)).map((b) => b.id);
export const BODY_BONES = new Set(EDITABLE_BONES);
export const PART_LABEL: Record<string, string> = {
  pelvis_under: "骨盆（後層）", pelvis: "骨盆", torso: "腰身", chest: "上胸", neck: "頸部",
  upper_arm_r: "右上臂", lower_arm_r: "右前臂", hand_r: "右手掌", upper_arm_l: "左上臂", lower_arm_l: "左前臂", hand_l: "左手掌",
  upper_leg_r: "右大腿", lower_leg_r: "右小腿", foot_r: "右腳掌", upper_leg_l: "左大腿", lower_leg_l: "左小腿", foot_l: "左腳掌", head: "頭部",
};
export const ANCHOR_LABEL: Record<string, string> = {
  head_top: "頭頂", chin: "下巴", neck: "頸根", neck_side_r: "右頸側", neck_side_l: "左頸側", shoulder_r: "右肩線", shoulder_l: "左肩線",
  bust: "胸口", bust_side_r: "右胸側", bust_side_l: "左胸側", waist: "腰線", waist_side_r: "右腰側", waist_side_l: "左腰側",
  hip: "臀線", hip_side_r: "右臀側", hip_side_l: "左臀側", elbow_r: "右手肘", elbow_l: "左手肘", wrist_r: "右手腕", wrist_l: "左手腕",
  hand_r: "右手掌", hand_l: "左手掌", knee_r: "右膝", knee_l: "左膝", ankle_r: "右腳踝", ankle_l: "左腳踝", floor: "地面",
};
export const LIMITS = { x: [-1200, 2400] as const, y: [-1200, 3000] as const, size: [4, 3600] as const, angle: 180, headShift: 600, headScale: [0.5, 2] as const };

// ───── 驗證 ─────
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r1 = (v: number) => Math.round(v * 10) / 10;
const inRange = (v: unknown, lo: number, hi: number): number | null => (fin(v) && v >= lo && v <= hi ? r1(v) : null);
const point = (v: unknown): [number, number] | null => {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const x = inRange(v[0], LIMITS.x[0], LIMITS.x[1]), y = inRange(v[1], LIMITS.y[0], LIMITS.y[1]);
  return x === null || y === null ? null : [x, y];
};
function headFit(v: unknown): HeadFit | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const dx = inRange(o.dx ?? 0, -LIMITS.headShift, LIMITS.headShift), dy = inRange(o.dy ?? 0, -LIMITS.headShift, LIMITS.headShift);
  const sv = o.s ?? 1;
  const s = fin(sv) && sv >= LIMITS.headScale[0] && sv <= LIMITS.headScale[1] ? Math.round(sv * 1000) / 1000 : null;
  return dx === null || dy === null || s === null ? null : { dx, dy, s };
}
export class ModelError extends Error {}
const bad = (msg: string): never => { throw new ModelError(msg); };

/**
 * 驗證及規範化模型定義（API、套件匯入共用）。任何不合法的資料都會拋出 ModelError（不會靜靜略過），
 * 只接受 V2 已有的部件、骨骼及錨點名稱，所以不可能出現循環骨架、不存在的父骨骼或任意外部網址。
 */
export function normalizeModelDef(v: unknown): ModelDef {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad("模型資料不正確");
  const o = v as Record<string, unknown>;
  if (o.base != null && o.base !== AVATAR_V2_ID) bad("目前只支援以 Avatar V2 骨架為基礎的模型");
  const parts: Record<string, PartDef> = {};
  const rawParts = (o.parts ?? {}) as Record<string, unknown>;
  if (typeof rawParts !== "object" || Array.isArray(rawParts)) bad("部件資料不正確");
  for (const [name, raw] of Object.entries(rawParts)) {
    if (!EDITABLE_PARTS.includes(name)) bad(`不認識的身體部件：${name.slice(0, 30)}`);
    if (!raw || typeof raw !== "object") bad(`部件 ${name} 資料不正確`);
    const p = raw as Record<string, unknown>;
    const x = inRange(p.x, LIMITS.x[0], LIMITS.x[1]), y = inRange(p.y, LIMITS.y[0], LIMITS.y[1]);
    const w = inRange(p.w, LIMITS.size[0], LIMITS.size[1]), h = inRange(p.h, LIMITS.size[0], LIMITS.size[1]);
    if (x === null || y === null || w === null || h === null) bad(`部件 ${name} 的位置或尺寸超出範圍`);
    const part: PartDef = { x: x!, y: y!, w: w!, h: h! };
    if (p.file != null) { if (!isImageRef(p.file) || (!p.file.startsWith("file:") && !p.file.startsWith(AVATAR_V2_BASE))) bad(`部件 ${name} 的圖片引用不正確`); part.file = p.file as string; }
    if (p.rot != null) { const rot = inRange(p.rot, -LIMITS.angle, LIMITS.angle); if (rot === null) bad(`部件 ${name} 的旋轉角度不正確`); if (rot) part.rot = rot!; }
    if (p.bone != null) { if (typeof p.bone !== "string" || !BODY_BONES.has(p.bone)) bad(`部件 ${name} 附接的骨骼不存在`); part.bone = p.bone as string; }
    if (p.hidden === true) part.hidden = true;
    if (p.src && typeof p.src === "object") {
      const s = p.src as Record<string, unknown>;
      const sw = inRange(s.w, 1, 8192), sh = inRange(s.h, 1, 8192);
      const c = Array.isArray(s.crop) && s.crop.length === 4 && s.crop.every((n) => fin(n) && n >= 0 && n <= 8192) ? (s.crop as number[]).map(Math.round) as [number, number, number, number] : null;
      if (sw && sh && c && c[2] > c[0] && c[3] > c[1]) part.src = { w: Math.round(sw), h: Math.round(sh), crop: c };
    }
    parts[name] = part;
  }
  const bones: Record<string, BoneDef> = {};
  const rawBones = (o.bones ?? {}) as Record<string, unknown>;
  if (typeof rawBones !== "object" || Array.isArray(rawBones)) bad("骨架資料不正確");
  for (const [id, raw] of Object.entries(rawBones)) {
    if (!BODY_BONES.has(id)) bad(`不認識的骨骼：${id.slice(0, 30)}`);
    const b = (raw ?? {}) as Record<string, unknown>;
    const out: BoneDef = {};
    if (b.pivot != null) { const p = point(b.pivot); if (!p) bad(`骨骼 ${id} 的關節位置超出範圍`); out.pivot = p!; }
    if (b.min != null || b.max != null) {
      const min = inRange(b.min, -LIMITS.angle, 0), max = inRange(b.max, 0, LIMITS.angle);
      if (min === null || max === null || min > max) bad(`骨骼 ${id} 的活動範圍不正確（最小值須為 −180 至 0，最大值 0 至 180）`);
      out.min = min!; out.max = max!;
    }
    if (Object.keys(out).length) bones[id] = out;
  }
  const anchors: Record<string, [number, number]> = {};
  const rawAnchors = (o.anchors ?? {}) as Record<string, unknown>;
  if (typeof rawAnchors !== "object" || Array.isArray(rawAnchors)) bad("錨點資料不正確");
  for (const [name, raw] of Object.entries(rawAnchors)) {
    if (!(name in RIG_V2.anchors)) bad(`不認識的錨點：${name.slice(0, 30)}`);
    const p = point(raw);
    if (!p) bad(`錨點 ${name} 超出範圍`);
    anchors[name] = p!;
  }
  let order: string[] | undefined;
  if (o.order != null) {
    const set = new Set(RIG_V2.body_parts);
    if (!Array.isArray(o.order) || o.order.length !== set.size || new Set(o.order).size !== set.size || !o.order.every((x) => set.has(x as string))) bad("圖層次序必須包含每個身體部件各一次");
    order = o.order as string[];
  }
  const head = o.head == null ? NO_HEAD_FIT : headFit(o.head);
  if (!head) bad("頭部對位不正確");
  const heads: Record<string, HeadFit> = {};
  if (o.heads != null) {
    if (typeof o.heads !== "object" || Array.isArray(o.heads)) bad("頭部對位不正確");
    const entries = Object.entries(o.heads as Record<string, unknown>);
    if (entries.length > 60) bad("頭部對位過多");
    for (const [id, raw] of entries) {
      if (!/^(builtin:[a-z0-9_]{1,40}|das_[a-z2-7]{6,40})$/.test(id)) bad("頭部素材識別不正確");
      const f = headFit(raw);
      if (!f) bad("頭部對位不正確");
      heads[id] = f!;
    }
  }
  return { v: 1, base: AVATAR_V2_ID, parts, bones, anchors, ...(order ? { order } : {}), head: head!, ...(Object.keys(heads).length ? { heads } : {}) };
}
/** 定義內引用的上傳圖片（file:dmf_…） */
export const modelFileRefs = (def: ModelDef) => [...new Set(Object.values(def.parts).map((p) => p.file).filter((f): f is string => !!f && f.startsWith("file:")))];

// ───── 由定義建立骨架 ─────
export const HEAD_ORIGIN: [number, number] = [600, 300];
export const headPoint = (f: HeadFit, x: number, y: number): [number, number] => [HEAD_ORIGIN[0] + (x - HEAD_ORIGIN[0]) * f.s + f.dx, HEAD_ORIGIN[1] + (y - HEAD_ORIGIN[1]) * f.s + f.dy];
export const sameHeadFit = (a: HeadFit, b: HeadFit) => Math.abs(a.dx - b.dx) < 0.05 && Math.abs(a.dy - b.dy) < 0.05 && Math.abs(a.s - b.s) < 0.0005;
/** 由模型定義建立完整骨架（V2 骨架＋差異）。頭髮骨骼跟隨頭部對位。 */
export function buildRig(def: ModelDef, id: string, revision: number): Rig {
  const bones: Bone[] = RIG_V2.bones.map((b) => {
    const o = def.bones[b.id];
    if (HAIR_BONE(b.id)) { const p = headPoint(def.head, b.pivot[0], b.pivot[1]); return { ...b, pivot: p, rest_position: p, attached_assets: [...b.attached_assets] }; }
    const pivot = o?.pivot ?? b.pivot;
    return { ...b, pivot: [pivot[0], pivot[1]], rest_position: [pivot[0], pivot[1]], min_angle: o?.min ?? b.min_angle, max_angle: o?.max ?? b.max_angle, attached_assets: [...b.attached_assets], ...(b.max_offset ? { max_offset: [b.max_offset[0], b.max_offset[1]] as [number, number] } : {}) };
  });
  const parts: Record<string, RigPart> = {};
  for (const [name, p] of Object.entries(RIG_V2.parts)) {
    const o = def.parts[name];
    parts[name] = o ? { ...p, src: o.file ?? p.src, x: o.x, y: o.y, w: o.w, h: o.h, bone: o.bone ?? p.bone, ...(o.rot ? { rot: o.rot } : {}), ...(o.hidden ? { hidden: true } : {}) } : { ...p };
  }
  // 部件附接的骨骼改變時，骨骼的 attached_assets 亦跟著更新（只作資料完整，渲染按部件的 bone）
  for (const b of bones) b.attached_assets = b.attached_assets.filter((a) => !parts[a] || parts[a].bone === b.id);
  for (const [name, p] of Object.entries(parts)) { const b = bones.find((x) => x.id === p.bone); if (b && !b.attached_assets.includes(name)) b.attached_assets.push(name); }
  const anchors: Record<string, [number, number]> = {};
  for (const [k, v] of Object.entries(RIG_V2.anchors)) anchors[k] = def.anchors[k] ? [def.anchors[k][0], def.anchors[k][1]] : [v[0], v[1]];
  return { ...RIG_V2, version: revision, avatar_id: id, bones, parts, anchors, anchor_bone: { ...RIG_V2.anchor_bone }, body_parts: def.order ? [...def.order] : [...RIG_V2.body_parts] };
}
export function buildModel(id: string, revision: number, def: ModelDef, name?: string): AvatarModel {
  if (isBuiltinModel(id)) return DEFAULT_BODY_MODEL;
  return { id, revision, rig: buildRig(def, id, revision), assetBase: AVATAR_V2_BASE, name, def };
}
/** 部件圖片的實際引用：上傳圖片（file:…）或內置靜態檔 */
export const partImage = (model: AvatarModel, p: Pick<RigPart, "src">): string => (p.src.startsWith("file:") || p.src.startsWith("/") ? p.src : model.assetBase + p.src);

// ───── 頭部及頭髮對位 ─────
export function headFitFor(model: AvatarModel, headId: string | null | undefined): HeadFit {
  const def = model.def;
  if (!def) return NO_HEAD_FIT;
  return (headId && def.heads?.[headId]) || def.head || NO_HEAD_FIT;
}
const isIdentity = (f: HeadFit) => f.dx === 0 && f.dy === 0 && f.s === 1;
export function adjustHead(head: HeadConfig, f: HeadFit): HeadConfig {
  if (isIdentity(f)) return head;
  const [x, y] = headPoint(f, head.x, head.y);
  return { ...head, x, y, w: head.w * f.s, h: head.h * f.s };
}
const hairCache = new WeakMap<HairConfig, { key: string; out: HairConfig }>();
/** 頭髮跟隨頭部對位（位置、大小及自帶髮束的旋轉中心）；網格偏移是圖片相對值，不需要改 */
export function adjustHair(hair: HairConfig | null, f: HeadFit): HairConfig | null {
  if (!hair || isIdentity(f)) return hair;
  const key = `${f.dx}|${f.dy}|${f.s}`;
  const hit = hairCache.get(hair);
  if (hit?.key === key) return hit.out;
  const out: HairConfig = { ...hair, parts: hair.parts.map((p) => { const [x, y] = headPoint(f, p.x, p.y); return { ...p, x, y, w: p.w * f.s, h: p.h * f.s, ...(p.pivot ? { pivot: headPoint(f, p.pivot[0], p.pivot[1]) } : {}) }; }) };
  hairCache.set(hair, { key, out });
  return out;
}
/** 畫面（已對位）上的髮件位置 → 原本的髮件座標（保存用） */
export function unadjustRect<T extends { x: number; y: number; w: number; h: number; pivot?: [number, number] }>(r: T, f: HeadFit): T {
  if (isIdentity(f)) return r;
  const inv = (x: number, y: number): [number, number] => [HEAD_ORIGIN[0] + (x - f.dx - HEAD_ORIGIN[0]) / f.s, HEAD_ORIGIN[1] + (y - f.dy - HEAD_ORIGIN[1]) / f.s];
  const [x, y] = inv(r.x, r.y);
  return { ...r, x, y, w: r.w / f.s, h: r.h / f.s, ...(r.pivot ? { pivot: inv(r.pivot[0], r.pivot[1]) } : {}) };
}

// ───── 骨架編輯 ─────
/** 某節骨骼的所有下游骨骼（不含頭髮骨骼：頭髮跟隨頭部對位） */
export function subtree(rig: Rig, id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const b of rig.bones) if (b.parent === out[i] && !HAIR_BONE(b.id)) out.push(b.id);
  return out;
}
/**
 * 移動一個關節（靜止姿勢）。withChildren＝連同下游骨骼、附接的身體部件及錨點一起平移（改變比例，例如手臂加長）；
 * 否則只改變旋轉中心（部件圖片不動）。移動頭部／頸部連同下游時，頭部對位一併平移，頭及頭髮保持在頸上。
 */
export function moveJoint(def: ModelDef, rig: Rig, id: string, to: [number, number], withChildren: boolean): ModelDef {
  const b = rig.bones.find((x) => x.id === id);
  if (!b || !BODY_BONES.has(id)) return def;
  const dx = r1(to[0] - b.pivot[0]), dy = r1(to[1] - b.pivot[1]);
  if (!dx && !dy) return def;
  const next: ModelDef = { ...def, bones: { ...def.bones }, parts: { ...def.parts }, anchors: { ...def.anchors } };
  const ids = withChildren ? subtree(rig, id) : [id];
  for (const bid of ids) {
    const cur = rig.bones.find((x) => x.id === bid)!;
    next.bones[bid] = { ...next.bones[bid], pivot: [r1(cur.pivot[0] + dx), r1(cur.pivot[1] + dy)] };
  }
  if (withChildren) {
    const moved = new Set(ids);
    for (const [name, p] of Object.entries(rig.parts)) {
      if (p.group !== "body" || name === "head" || !moved.has(p.bone)) continue;
      // 關節本身那一節（例如移動手肘時的前臂）一起移動；上一節（上臂）不動
      const prev = next.parts[name] ?? { x: p.x, y: p.y, w: p.w, h: p.h };
      next.parts[name] = { ...prev, x: r1(prev.x + dx), y: r1(prev.y + dy) };
    }
    for (const [name, at] of Object.entries(rig.anchors)) {
      const ab = rig.anchor_bone[name];
      // 跟隨下游骨骼的錨點，以及位於這個關節上的錨點（例如手肘錨點附接在上臂，但位置就是手肘）
      const onJoint = Math.hypot(at[0] - b.pivot[0], at[1] - b.pivot[1]) < 1.5;
      if (moved.has(ab) || onJoint) next.anchors[name] = [r1(at[0] + dx), r1(at[1] + dy)];
    }
    if (moved.has("head")) next.head = { ...def.head, dx: r1(def.head.dx + dx), dy: r1(def.head.dy + dy) };
  }
  return next;
}
/** 由完整部件設定與 V2 比較，移除沒有改變的項目（保存較細的定義） */
export function compactDef(def: ModelDef): ModelDef {
  const parts: Record<string, PartDef> = {};
  for (const [k, p] of Object.entries(def.parts)) {
    const o = RIG_V2.parts[k];
    if (!o) continue;
    const same = !p.file && !p.rot && !p.hidden && (!p.bone || p.bone === o.bone) && Math.abs(p.x - o.x) < 0.05 && Math.abs(p.y - o.y) < 0.05 && Math.abs(p.w - o.w) < 0.05 && Math.abs(p.h - o.h) < 0.05;
    if (!same) parts[k] = p;
  }
  const bones: Record<string, BoneDef> = {};
  for (const [k, b] of Object.entries(def.bones)) {
    const o = RIG_V2.bones.find((x) => x.id === k);
    if (!o) continue;
    const out: BoneDef = {};
    if (b.pivot && (Math.abs(b.pivot[0] - o.pivot[0]) >= 0.05 || Math.abs(b.pivot[1] - o.pivot[1]) >= 0.05)) out.pivot = b.pivot;
    if (b.min != null && b.max != null && (b.min !== o.min_angle || b.max !== o.max_angle)) { out.min = b.min; out.max = b.max; }
    if (Object.keys(out).length) bones[k] = out;
  }
  const anchors: Record<string, [number, number]> = {};
  for (const [k, a] of Object.entries(def.anchors)) { const o = RIG_V2.anchors[k]; if (o && (Math.abs(a[0] - o[0]) >= 0.05 || Math.abs(a[1] - o[1]) >= 0.05)) anchors[k] = a; }
  const order = def.order && def.order.some((p, i) => RIG_V2.body_parts[i] !== p) ? def.order : undefined;
  return { v: 1, base: AVATAR_V2_ID, parts, bones, anchors, ...(order ? { order } : {}), head: def.head, ...(def.heads && Object.keys(def.heads).length ? { heads: def.heads } : {}) };
}
