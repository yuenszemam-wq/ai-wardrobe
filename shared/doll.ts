// 角色換裝的共用定義：圖層位置、預設穿著位置、穿法設定、造型資料格式。
// 全部是純函數／常數，前端及 Worker 共用，可直接單元測試。座標＝1200×1800 邏輯畫布像素。
// Phase 3：Avatar V2 是唯一角色；衣物分類只決定預設位置及圖層，不再限制可以怎樣疊穿。

import { normalizeManualMesh, manualUV } from "./manualMesh";
import { AVATAR_V2_ID, FrontPart, HairConfig, normalizeHairConfig, RIG_V2, isImageRef, normalizeColorValue } from "./avatarV2";
import { Pose, normalizePose, posedAnchors } from "./avatarRig";

export const DOLL_W = 1200;
export const DOLL_H = 1800;
export const DEFAULT_AVATAR = AVATAR_V2_ID;
/** 已淘汰的舊角色：只用於辨認及轉換舊造型／舊穿著位置 */
export const LEGACY_AVATAR = "base_v1";
export const isAvatar = (id: unknown) => id === AVATAR_V2_ID || id === LEGACY_AVATAR;

export interface Fit {
  cx: number; // 圖片中心（靜止姿勢下的畫布座標；顯示時再跟隨所附接的骨骼）
  cy: number;
  w: number; // 顯示寬度（高度＝w × 圖片高寬比）
  rotation: number; // 度
  /** 高度的額外拉伸（1＝按圖片比例）；沒有＝1。用來獨立微調衣物的高度 */
  sy?: number;
  /** 4×4 手動控制格：每點的圖片相對偏移 dx,dy。 */
  mesh?: number[];
}
/** 衣物顯示高度（已計及獨立的高度拉伸） */
export const fitHeight = (fit: Fit, ar: number) => fit.w * (ar > 0 ? ar : 4 / 3) * (fit.sy ?? 1);
/** 靜止畫布座標 → 圖片內的位置（0–1） */
export function toImage(fit: Fit, ar: number, x: number, y: number): [number, number] {
  const t = (-fit.rotation * Math.PI) / 180;
  const dx = x - fit.cx, dy = y - fit.cy;
  return [(dx * Math.cos(t) - dy * Math.sin(t)) / fit.w + 0.5, (dx * Math.sin(t) + dy * Math.cos(t)) / fitHeight(fit, ar) + 0.5];
}
/** 圖片內的位置（0–1）→ 靜止畫布座標 */
export function fromImage(fit: Fit, ar: number, u: number, v: number): [number, number] {
  const t = (fit.rotation * Math.PI) / 180;
  const lx = (u - 0.5) * fit.w, ly = (v - 0.5) * fitHeight(fit, ar);
  return [fit.cx + lx * Math.cos(t) - ly * Math.sin(t), fit.cy + lx * Math.sin(t) + ly * Math.cos(t)];
}

export { MANUAL_GRID, normalizeManualMesh, manualUV } from "./manualMesh";
export function manualPoint(fit: Fit, ar: number, u: number, v: number): [number,number] { return fromImage(fit,ar,...manualUV(fit.mesh,u,v)); }

export const ANCHORS = posedAnchors(RIG_V2, {});

// ───── 圖層位置 ─────
export const SLOTS = ["socks", "shoes", "petticoat", "top", "pants", "skirt", "dress", "set", "outer", "bag", "accessory", "headwear"] as const;
export type Slot = (typeof SLOTS)[number];
/** 預設的疊穿次序（由內到外）；使用者可以在圖層清單自由調整 */
export const SLOT_Z: Record<Slot, number> = { socks: 100, shoes: 150, petticoat: 200, top: 300, pants: 350, skirt: 400, dress: 500, set: 550, outer: 600, bag: 700, accessory: 750, headwear: 900 };
export const SLOT_LABEL: Record<Slot, string> = { socks: "襪", shoes: "鞋", petticoat: "裙撐", top: "上衣", pants: "褲", skirt: "半身裙", dress: "連身裙", set: "整套", outer: "外套", bag: "手袋", accessory: "配件", headwear: "頭飾" };
export const isSlot = (v: unknown): v is Slot => typeof v === "string" && (SLOTS as readonly string[]).includes(v);

const CATEGORY_SLOT: Record<string, Slot> = {
  連身裙: "dress", 上衣: "top", 半身裙: "skirt", 外套: "outer", 褲: "pants", 內搭與裙撐: "petticoat",
  鞋: "shoes", 襪: "socks", 頭飾: "headwear", 手袋: "bag", 配件: "accessory", 其他裝飾: "accessory", 套裝: "set", 完整穿搭: "set",
};
/** 內搭與裙撐之中，不是裙撐／襯裙的（例如打底衫）當作上衣 */
export function slotFor(category: string | null | undefined, subcategory?: string | null): Slot {
  if (category === "內搭與裙撐" && subcategory && !/裙撐|襯裙|petticoat|pannier/i.test(subcategory)) return "top";
  return (category && CATEGORY_SLOT[category]) || "accessory";
}

/** 新穿上的衣物插在哪裡：放在最後一件「預設次序不高於它」的衣物之上；不會脫下任何衣物 */
export function insertIndex(current: { slot: Slot }[], slot: Slot): number {
  let at = 0;
  current.forEach((w, i) => { if (SLOT_Z[w.slot] <= SLOT_Z[slot]) at = i + 1; });
  return at;
}

/** 非強制提示：這個組合可能互相遮擋（只供顯示，不會自動脫下） */
export function layeringHints(slots: Slot[]): string[] {
  const n = (s: Slot) => slots.filter((x) => x === s).length;
  const out: string[] = [];
  if (n("dress") + n("set") > 1) out.push("多件連身裙／整套疊穿，可在「圖層」調整前後或暫時隱藏其中一件");
  if (n("set") && (n("top") || n("skirt") || n("dress"))) out.push("整套衣物是一整張圖，與其他衣物重疊的位置可用遮罩隱藏");
  if (n("outer") > 1) out.push("多件外套疊穿，較貼身的一件建議放在下面");
  return out;
}

// ───── 預設穿著位置 ─────
/** 衣物在圖片內實際佔的範圍（0–1）；ar＝圖片高÷寬 */
export interface Content { x0: number; y0: number; x1: number; y1: number; ar: number; waistBand?: { x0: number; x1: number }; shoulders?: { x0: number; x1: number; y: number }; approximate?: boolean }
export const FULL_CONTENT = (ar = 4 / 3): Content => ({ x0: 0, y0: 0, x1: 1, y1: 1, ar });

interface Rule { cx: number; top?: number; bottom?: number; cy?: number; h?: number; w?: number }
const round = (n: number) => Math.round(n * 10) / 10;
export const FIT_LIMIT = { minW: 30, maxW: 3600, pad: 1200 };
const clampW = (w: number) => Math.min(FIT_LIMIT.maxW, Math.max(FIT_LIMIT.minW, w));

/**
 * 自動估算穿著位置：按身體區域的錨點（肩線、腰線、膝、腳踝、頭頂…）對齊衣物的實際內容，
 * 有肩線／裙腰等輪廓線索時優先使用，否則按分類的常見長度。之後可以人工微調並存為衣物預設。
 */
export function defaultFit(slot: Slot, content: Content, category?: string | null, subcategory?: string | null, name?: string | null): Fit {
  const a = ANCHORS;
  const center = a.waist.x;
  const shoulder = Math.min(a.shoulder_l.y, a.shoulder_r.y);
  const rules: Record<Slot, Rule> = {
    dress: { cx: center, top: shoulder - 28, h: a.knee_l.y - shoulder + 28 },
    set: { cx: center, top: shoulder - 40, h: a.knee_l.y - shoulder + 40 },
    top: { cx: center, top: shoulder - 25, h: a.waist.y - shoulder + 65 },
    outer: { cx: center, top: shoulder - 35, h: a.hip.y - shoulder + 35 },
    skirt: { cx: center, top: a.waist.y - 10, h: a.knee_l.y - a.waist.y + 10 },
    petticoat: { cx: center, top: a.waist.y + 10, h: a.knee_l.y - a.waist.y - 50 },
    pants: { cx: center, top: a.waist.y - 10, h: a.ankle_l.y - a.waist.y + 10 },
    socks: { cx: center, bottom: a.floor.y - 70, h: 430 },
    shoes: { cx: center, bottom: a.floor.y + 4, h: 150 },
    headwear: { cx: a.head_top.x, cy: a.head_top.y + 55, w: 240 },
    bag: { cx: a.hand_l.x, cy: a.hand_l.y, h: 260 },
    accessory: { cx: a.neck.x, cy: a.neck.y + 10, h: 120 },
  };
  let r: Rule = slot === "set" && category === "完整穿搭" ? { cx: center, top: a.head_top.y, h: a.floor.y - a.head_top.y } : rules[slot];
  const description = (subcategory ?? "") + " " + (name ?? "");
  const short = /迷你|超短|短裙|mini/i.test(description);
  const long = /長裙|及踝|拖地|maxi|ankle.length/i.test(description);
  const midi = /中長|過膝|midi/i.test(description);
  if (slot === "skirt" || slot === "dress") {
    const bottom = short ? a.waist.y + (a.knee_l.y - a.waist.y) * 0.63 : long ? a.ankle_l.y - 35 : midi ? (a.knee_l.y + a.ankle_l.y) / 2 : a.knee_l.y;
    r = { ...r, h: bottom - (r.top ?? a.waist.y) };
  }
  if (slot === "top" || slot === "outer") {
    if (/短款|短身|crop/i.test(description)) r = { ...r, h: a.waist.y - (r.top ?? shoulder) + 10 };
    else if (/長款|長版|長身|longline/i.test(description)) r = { ...r, h: a.hip.y - (r.top ?? shoulder) + 100 };
  }
  const cw = Math.max(0.02, content.x1 - content.x0), ch = Math.max(0.02, content.y1 - content.y0);
  const ar = content.ar > 0 ? content.ar : 4 / 3;
  let w = clampW(r.h !== undefined ? r.h / ch / ar : (r.w ?? 400) / cw);
  let alignX = (content.x0 + content.x1) / 2;
  // 裙腰闊度比裙擺輪廓更可靠（限制在保守範圍內）
  const band = slot === "skirt" && !content.approximate ? content.waistBand : undefined;
  if (band && band.x1 > band.x0) {
    const candidate = ((a.waist_side_l.x - a.waist_side_r.x) * 1.08) / (band.x1 - band.x0);
    if (candidate >= w * 0.75 && candidate <= w * 1.3) w = clampW(candidate);
    alignX = (band.x0 + band.x1) / 2;
  }
  // 無袖上身（JSK、背心）的肩帶闊度對齊肩線
  const sh = (slot === "dress" || slot === "top") && !content.approximate ? content.shoulders : undefined;
  if (sh && sh.x1 > sh.x0) {
    const candidate = ((a.shoulder_l.x - a.shoulder_r.x) * 0.78) / (sh.x1 - sh.x0);
    if (candidate >= w * 0.8 && candidate <= w * 1.25) w = clampW(candidate);
    alignX = (sh.x0 + sh.x1) / 2;
  }
  const h = w * ar;
  const contentH = ch * h;
  const contentTop = r.top !== undefined ? r.top : r.bottom !== undefined ? r.bottom - contentH : (r.cy ?? DOLL_H / 2) - contentH / 2;
  const top = contentTop - content.y0 * h;
  const left = r.cx - alignX * w;
  return { cx: round(left + w / 2), cy: round(top + h / 2), w: round(w), rotation: 0 };
}

/** 驗證及規範化位置；不合法回傳 null */
export function normalizeFit(v: unknown): Fit | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? (o[k] as number) : NaN);
  const cx = n("cx"), cy = n("cy"), w = n("w");
  const rot = o.rotation === undefined || o.rotation === null ? 0 : n("rotation");
  if ([cx, cy, w, rot].some(Number.isNaN)) return null;
  if (w < FIT_LIMIT.minW || w > FIT_LIMIT.maxW) return null;
  if (cx < -FIT_LIMIT.pad || cx > DOLL_W + FIT_LIMIT.pad || cy < -FIT_LIMIT.pad || cy > DOLL_H + FIT_LIMIT.pad) return null;
  let r = rot % 360;
  if (r > 180) r -= 360;
  if (r <= -180) r += 360;
  let sy = 1;
  if (o.sy !== undefined && o.sy !== null) {
    sy = n("sy");
    if (Number.isNaN(sy) || sy < SY_LIMIT.min - 1e-6 || sy > SY_LIMIT.max + 1e-6) return null;
    sy = Math.round(sy * 1000) / 1000;
  }
  return { cx: round(cx), cy: round(cy), w: round(w), rotation: round(r), ...(Math.abs(sy - 1) > 0.0005 ? { sy } : {}), ...(normalizeManualMesh(o.mesh) ? { mesh: normalizeManualMesh(o.mesh) } : {}) };
}
export const SY_LIMIT = { min: 0.5, max: 2 };
export const sameFit = (a: Fit, b: Fit) => Math.abs(a.cx - b.cx) < 0.06 && Math.abs(a.cy - b.cy) < 0.06 && Math.abs(a.w - b.w) < 0.06 && Math.abs(a.rotation - b.rotation) < 0.06 && Math.abs((a.sy ?? 1) - (b.sy ?? 1)) < 0.0006 && JSON.stringify(a.mesh ?? []) === JSON.stringify(b.mesh ?? []);

/** 點（與 fit 同一座標系）是否落在衣物的實際內容範圍內（已計及旋轉）。透明留白不會擋住下面的衣物。 */
export function hitTest(fit: Fit, content: Content, x: number, y: number, margin = 12): boolean {
  const t = (-fit.rotation * Math.PI) / 180;
  const dx = x - fit.cx, dy = y - fit.cy;
  const lx = dx * Math.cos(t) - dy * Math.sin(t), ly = dx * Math.sin(t) + dy * Math.cos(t);
  const h = fitHeight(fit, content.ar);
  const px = lx + fit.w / 2, py = ly + h / 2;
  return px >= content.x0 * fit.w - margin && px <= content.x1 * fit.w + margin && py >= content.y0 * h - margin && py <= content.y1 * h + margin;
}

// ───── 舊角色（Avatar V1）轉換 ─────
/** V1 與 V2 對應的身體高度（頭頂、下巴、頸、肩、胸、腰、臀、膝、踝、地面） */
const V1_Y = [116, 442, 478, 520, 630, 745, 885, 1280, 1660, 1782];
const V2_Y = [ANCHORS.head_top.y, ANCHORS.chin.y, ANCHORS.neck.y, ANCHORS.shoulder_l.y, ANCHORS.bust.y, ANCHORS.waist.y, ANCHORS.hip.y, ANCHORS.knee_l.y, ANCHORS.ankle_l.y, ANCHORS.floor.y];
function mapY(y: number): number {
  const n = V1_Y.length;
  let i = 0;
  while (i < n - 2 && y > V1_Y[i + 1]) i++;
  const t = (y - V1_Y[i]) / (V1_Y[i + 1] - V1_Y[i]);
  return V2_Y[i] + t * (V2_Y[i + 1] - V2_Y[i]);
}
/**
 * 把 Avatar V1 上的穿著位置換算到 V2：衣物實際內容的上下緣跟隨相同的身體部位，
 * 大小按兩個角色的身體比例調整。結果只是起點，使用者可以再校正並存為 V2 的衣物預設。
 */
export function convertLegacyFit(fit: Fit, content: Content): Fit {
  const ar = content.ar > 0 ? content.ar : 4 / 3;
  const h = fit.w * ar;
  const top = fit.cy - h / 2 + content.y0 * h, bottom = fit.cy - h / 2 + content.y1 * h;
  const nt = mapY(top), nb = mapY(bottom);
  const scale = Math.min(1.5, Math.max(0.75, (nb - nt) / Math.max(1, bottom - top)));
  const w = clampW(fit.w * scale), nh = w * ar;
  const cxContent = fit.cx - fit.w / 2 + ((content.x0 + content.x1) / 2) * fit.w;
  const left = 600 + (cxContent - 600) * 1.03 - ((content.x0 + content.x1) / 2) * w;
  return { cx: round(left + w / 2), cy: round(nt - content.y0 * nh + nh / 2), w: round(w), rotation: fit.rotation };
}

// ───── 穿法設定 ─────
/** 衣物怎樣跟隨骨架：auto＝自動判斷；none＝整件跟隨一節骨骼；upper＝袖子跟隨上臂；full＝連前臂／小腿一起跟隨 */
export type Follow = "auto" | "none" | "upper" | "full";
export const FOLLOWS: Follow[] = ["auto", "none", "upper", "full"];
export interface WearOpts {
  follow: Follow;
  /** 頸部顯示在衣服後領的前面（解決後領蓋住頸部） */
  neck: boolean;
  /** 整件附接的骨骼；null＝按圖層位置 */
  bone: string | null;
  /** 顯示在頭髮及臉的上面（頭飾預設開啟） */
  over_head: boolean;
  /** 袖子在靜止姿勢的額外角度（度；右袖、左袖）：令平放拍攝的袖子貼近手臂。沒有＝0 */
  sleeve_r?: number;
  sleeve_l?: number;
}
export const SLEEVE_ROT_LIMIT = 80;
export const SLOT_BONE: Record<Slot, string> = { top: "chest", outer: "chest", dress: "chest", set: "chest", skirt: "pelvis", petticoat: "pelvis", pants: "pelvis", socks: "pelvis", shoes: "root", headwear: "head", bag: "wrist_l", accessory: "chest" };
export const ATTACHABLE_BONES = ["head", "neck", "chest", "torso", "pelvis", "wrist_r", "wrist_l", "elbow_r", "elbow_l", "ankle_r", "ankle_l", "root", "world"];
export type SkinKind = "upper" | "legs" | "rigid";
export const SLOT_SKIN: Record<Slot, SkinKind> = { top: "upper", outer: "upper", dress: "upper", set: "upper", pants: "legs", socks: "legs", shoes: "legs", skirt: "rigid", petticoat: "rigid", headwear: "rigid", bag: "rigid", accessory: "rigid" };
export const defaultOpts = (slot: Slot): WearOpts => ({ follow: "auto", neck: slot === "top" || slot === "dress" || slot === "outer" || slot === "set", bone: null, over_head: slot === "headwear" });
export function normalizeOpts(v: unknown, slot: Slot): WearOpts {
  const d = defaultOpts(slot);
  if (!v || typeof v !== "object") return d;
  const o = v as Record<string, unknown>;
  return {
    follow: FOLLOWS.includes(o.follow as Follow) ? (o.follow as Follow) : d.follow,
    neck: typeof o.neck === "boolean" ? o.neck : d.neck,
    bone: typeof o.bone === "string" && ATTACHABLE_BONES.includes(o.bone) ? o.bone : null,
    over_head: typeof o.over_head === "boolean" ? o.over_head : d.over_head,
    ...sleeveRot(o),
  };
}
function sleeveRot(o: Record<string, unknown>): { sleeve_r?: number; sleeve_l?: number } {
  const out: { sleeve_r?: number; sleeve_l?: number } = {};
  for (const k of ["sleeve_r", "sleeve_l"] as const) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && Math.abs(v) >= 0.5) out[k] = Math.round(Math.min(SLEEVE_ROT_LIMIT, Math.max(-SLEEVE_ROT_LIMIT, v)));
  }
  return out;
}

/** 遮罩：低解像度 PNG（data URL）。R＝隱藏、G＝移到身體後面。上限約 60 KB。 */
export const MASK_MAX = 80_000;
export const isMask = (v: unknown): v is string => typeof v === "string" && v.length <= MASK_MAX && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v);

/**
 * 衣物部件圖：低解像度 PNG（data URL），R 通道＝部件編號 × 50（0＝衣身、1＝右袖、2＝左袖、3＝右腿、4＝左腿）。
 * "whole"＝不拆件（整件衣物）；"auto"＝明確使用自動分辨（蓋過衣物預設的人工標記）；null＝跟隨衣物預設／自動分辨。
 */
export const PARTS_MAX = 40_000;
export type PartsRef = string;
export const isParts = (v: unknown): v is PartsRef => v === "whole" || v === "auto" || (typeof v === "string" && v.length <= PARTS_MAX && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v));

/** 一種穿法：位置、跟隨方式、遮罩，以及（可選）另一張透明圖，例如外套打開的版本 */
export interface Variant {
  name: string;
  /** null＝衣物本身的透明圖 */
  image: string | null;
  fit: Fit | null;
  opts: WearOpts;
  mask: string | null;
  parts?: PartsRef | null;
  /** 這個穿法是為哪個姿勢校正的（可選）：角色擺出相近姿勢時會提示套用 */
  pose?: Pose | null;
}
/** 每件衣物的預設穿著設定（doll_fit_templates.data）。預設穿法的位置存在資料表欄位 cx／cy／w／rotation。 */
export interface TemplateData {
  opts: WearOpts;
  mask: string | null;
  /** 部件圖（衣身／袖子…）；null＝自動分辨 */
  parts?: PartsRef | null;
  /** 預設穿法的高度拉伸（位置的其他數值存在資料表欄位） */
  sy?: number;
  mesh?: number[];
  /** 適合這件衣物的姿勢（可選擇套用） */
  pose: Pose | null;
  front: FrontPart[];
  /** 其他穿法（id → 設定） */
  variants: Record<string, Variant>;
  /** 由舊角色換算而來，尚未在 V2 上校正 */
  converted?: boolean;
}
const frontOf = (v: unknown): FrontPart[] => (Array.isArray(v) ? (["hand_r", "hand_l"] as FrontPart[]).filter((k) => v.includes(k)) : []);
export function normalizeTemplateData(v: unknown, slot: Slot): TemplateData {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const variants: Record<string, Variant> = {};
  if (o.variants && typeof o.variants === "object") {
    for (const [id, raw] of Object.entries(o.variants as Record<string, unknown>).slice(0, 8)) {
      if (!/^[a-z0-9_]{1,24}$/.test(id) || !raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      variants[id] = {
        name: (typeof r.name === "string" ? r.name.trim().slice(0, 20) : "") || "穿法",
        image: isImageRef(r.image) ? r.image : null,
        fit: normalizeFit(r.fit),
        opts: normalizeOpts(r.opts, slot),
        mask: isMask(r.mask) ? r.mask : null,
        ...(isParts(r.parts) ? { parts: r.parts } : {}),
        ...(r.pose ? { pose: normalizePose(RIG_V2, r.pose) } : {}),
      };
    }
  }
  const sy = typeof o.sy === "number" && o.sy >= SY_LIMIT.min && o.sy <= SY_LIMIT.max && Math.abs(o.sy - 1) > 0.0005 ? Math.round(o.sy * 1000) / 1000 : undefined;
  return { opts: normalizeOpts(o.opts, slot), mask: isMask(o.mask) ? o.mask : null, ...(isParts(o.parts) ? { parts: o.parts } : {}), ...(sy ? { sy } : {}), ...(normalizeManualMesh(o.mesh) ? { mesh: normalizeManualMesh(o.mesh) } : {}), pose: o.pose ? normalizePose(RIG_V2, o.pose) : null, front: frontOf(o.front), variants, ...(o.converted ? { converted: true } : {}) };
}

// ───── 造型 ─────
/** 造型內的一件衣物。fit／opts／mask 為 null＝跟隨衣物預設；有值＝只用於這個造型。 */
export interface LookItem {
  /** 完整造型快照：null 遮罩／部件表示確實沒有，不再繼承預設。 */
  snapshot?: boolean;
  garment_id: string;
  slot: Slot;
  hidden: boolean;
  /** 穿法 id；null＝預設穿法 */
  variant: string | null;
  fit: Fit | null;
  opts: WearOpts | null;
  mask: string | null;
  parts?: PartsRef | null;
}
/** 完整造型狀態（doll_looks.state）。items 的次序＝由內到外的圖層次序。 */
export interface LookState {
  v: 3;
  head: string | null;
  hair: string | null;
  /** 已穿髮件的獨立快照；缺少時沿用原本髮型 id。 */
  hair_config?: HairConfig | null;
  hair_color: string;
  accent_color: string | null;
  tip_color: string | null;
  pose: Pose;
  front: FrontPart[];
  items: LookItem[];
}
export const MAX_ITEMS = 40;
const assetId = (v: unknown) => (typeof v === "string" && /^(builtin:[a-z0-9_]{1,40}|das_[a-z2-7]{6,40}|none)$/.test(v) ? v : null);
/** 驗證造型狀態；posePass＝姿勢驗證（髮束骨骼因髮型而異，所以只檢查數值）。不合法回傳 null */
export function normalizeLookState(v: unknown): LookState | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.items) || o.items.length > MAX_ITEMS) return null;
  const pose: Pose = {};
  if (o.pose != null) {
    if (typeof o.pose !== "object" || Array.isArray(o.pose)) return null;
    const entries = Object.entries(o.pose as Record<string, unknown>);
    if (entries.length > 200) return null;
    for (const [k, val] of entries) {
      if (!/^[a-z0-9_]{1,40}(\.[xy])?$/.test(k) || typeof val !== "number" || !Number.isFinite(val) || Math.abs(val) > 400) return null;
      if (val !== 0) pose[k] = Math.round(val * 10) / 10;
    }
  }
  const items: LookItem[] = [];
  const seen = new Set<string>();
  for (const raw of o.items) {
    if (!raw || typeof raw !== "object") return null;
    const it = raw as Record<string, unknown>;
    const gid = typeof it.garment_id === "string" ? it.garment_id : "";
    if (!/^[\w-]{1,64}$/.test(gid)) return null;
    if (seen.has(gid)) continue;
    seen.add(gid);
    const slot = isSlot(it.slot) ? it.slot : "accessory";
    let fit: Fit | null = null;
    if (it.fit != null) {
      fit = normalizeFit(it.fit);
      if (!fit) return null;
    }
    items.push({
      garment_id: gid, slot, hidden: it.hidden === true, ...(it.snapshot===true?{snapshot:true}:{}),
      variant: typeof it.variant === "string" && /^[a-z0-9_]{1,24}$/.test(it.variant) ? it.variant : null,
      fit, opts: it.opts ? normalizeOpts(it.opts, slot) : null, mask: isMask(it.mask) ? it.mask : null,
      ...(isParts(it.parts) ? { parts: it.parts } : {}),
    });
  }
  const hairConfig = o.hair_config == null ? null : normalizeHairConfig(o.hair_config);
  if(o.hair_config != null && !hairConfig) return null;
  return {
    v: 3, head: assetId(o.head), hair: assetId(o.hair), ...(hairConfig ? {hair_config:hairConfig} : {}),
    hair_color: normalizeColorValue(o.hair_color) ?? "brown_pink",
    accent_color: o.accent_color === "original" ? "original" : normalizeColorValue(o.accent_color),
    tip_color: typeof o.tip_color === "string" && /^#[0-9a-f]{6}$/i.test(o.tip_color) ? o.tip_color.toLowerCase() : null,
    pose, front: frontOf(o.front), items,
  };
}
