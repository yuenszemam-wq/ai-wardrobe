// Avatar V2：由完整人物圖拆出來的可動角色（素材及 rig.json 由 scripts/ 內的腳本產生）。
// 這裡同時定義「角色素材」（頭部、髮型）的資料格式：內置素材與使用者上傳的素材用同一種設定，
// 所以新增髮型不用改程式。
import rigJson from "../public/doll/avatar_v2/rig.json";
import posesJson from "./avatar-v2-poses.json";
import { Bone, Pose, Rig, clampPose } from "./avatarRig";
import { normalizeManualMesh } from "./manualMesh";

export const AVATAR_V2_ID = "avatar_v2";
export const AVATAR_V2_BASE = "/doll/avatar_v2/";
export const RIG_V2 = rigJson as unknown as Rig & {
  hair: { style: string; ref_luma: { main: number; accent: number }; original: { main: number[]; accent: number[] } };
};

export type FrontPart = "hand_r" | "hand_l";
export interface PosePreset { id: string; label: string; pose: Pose; front?: FrontPart[] }
export const POSE_PRESETS: PosePreset[] = (posesJson as PosePreset[]).map((p) => ({ ...p, pose: clampPose(RIG_V2, p.pose) }));
export const DEFAULT_POSE_ID = "a_pose";

// ───── 角色素材 ─────
/** 圖片來源：「file:<doll_asset_files.id>」＝使用者上傳；以 / 開頭＝內置靜態檔 */
export type ImageRef = string;
export const refUrl = (ref: ImageRef) => (ref.startsWith("file:") ? `/api/doll/files/${ref.slice(5)}` : ref.startsWith("img:") ? `/api/images/${ref.slice(4)}` : ref);
const REF = /^(file:daf_[a-z2-7]{6,40}|img:img_[a-z2-7]{6,40}|\/doll\/[\w./-]{1,200})$/;
export const isImageRef = (v: unknown): v is ImageRef => typeof v === "string" && REF.test(v) && !v.includes("..");

export type HairLayer = "back" | "mid" | "front";
export const HAIR_LAYER_LABEL: Record<HairLayer, string> = { back: "身體後面", mid: "衣服前面", front: "臉的前面" };
export interface HairPart {
  id: string;
  label: string;
  file: ImageRef;
  /** 染色遮罩（R＝挑染比重、G＝是否頭髮）；沒有則自動分辨主髮色及挑染 */
  mask?: ImageRef | null;
  layer: HairLayer;
  /** 在 1200×1800 畫布上的位置（靜止姿勢） */
  x: number; y: number; w: number; h: number;
  /** 跟隨哪一節骨骼：內置骨骼 id，或 "own"＝這個髮束有自己的骨骼（pivot、range） */
  bone: string;
  pivot?: [number, number];
  range?: number;
  rotation?: number;
  mesh?: number[];
  hidden?: boolean;
}
export interface HairConfig { parts: HairPart[]; ref_luma?: { main: number; accent: number } | null }
export interface HeadConfig { file: ImageRef; x: number; y: number; w: number; h: number }
export interface DollAsset<C = HairConfig | HeadConfig> { id: string; kind: "hair" | "head" | "garment_part"; name: string; category: string | null; builtin?: boolean; config: C; thumb?: string | null; garment_id?: string | null }

const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 10) / 10 : null);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const LAYERS: HairLayer[] = ["back", "mid", "front"];
const FIXED_BONES = new Set(["head", "neck", "chest", "torso", "hair_tail_r", "hair_tail_l", "hair_side_r", "hair_side_l"]);

/** 驗證髮型設定（API 及載入時共用）；不合法回傳 null */
export function normalizeHairConfig(v: unknown): HairConfig | null {
  if (!v || typeof v !== "object") return null;
  const raw = (v as { parts?: unknown }).parts;
  if (!Array.isArray(raw) || raw.length > 16) return null;
  const parts: HairPart[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    const id = text(o.id, 24).replace(/[^a-z0-9_]/gi, "");
    const x = num(o.x, -2400, 2400), y = num(o.y, -3600, 3600), w = num(o.w, 4, 4800), h = num(o.h, 4, 7200);
    if (!id || seen.has(id) || !isImageRef(o.file) || x === null || y === null || w === null || h === null) return null;
    seen.add(id);
    const layer = LAYERS.includes(o.layer as HairLayer) ? (o.layer as HairLayer) : "back";
    const part: HairPart = { id, label: text(o.label, 30) || "髮束", file: o.file, layer, x, y, w, h, bone: "head" };
    const rotation=num(o.rotation,-180,180); if(rotation) part.rotation=rotation;
    const mesh=normalizeManualMesh(o.mesh); if(mesh) part.mesh=mesh;
    if(o.hidden===true) part.hidden=true;
    if (o.mask != null) {
      if (!isImageRef(o.mask)) return null;
      part.mask = o.mask;
    }
    if (o.bone === "own") {
      const p = Array.isArray(o.pivot) ? [num(o.pivot[0], -2400, 2400), num(o.pivot[1], -3600, 3600)] : [null, null];
      part.bone = "own";
      part.pivot = [p[0] ?? x + w / 2, p[1] ?? y];
      part.range = num(o.range, 1, 60) ?? 20;
    } else if (typeof o.bone === "string" && FIXED_BONES.has(o.bone)) part.bone = o.bone;
    parts.push(part);
  }
  const rl = (v as { ref_luma?: { main?: unknown; accent?: unknown } }).ref_luma;
  const main = num(rl?.main, 0.01, 1), accent = num(rl?.accent, 0.01, 1);
  return { parts, ref_luma: main !== null ? { main, accent: accent ?? main } : null };
}
export function normalizeHeadConfig(v: unknown): HeadConfig | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const x = num(o.x, -2400, 2400), y = num(o.y, -3600, 3600), w = num(o.w, 4, 4800), h = num(o.h, 4, 7200);
  if (!isImageRef(o.file) || x === null || y === null || w === null || h === null) return null;
  return { file: o.file, x, y, w, h };
}

const P = RIG_V2.parts;
const hairPart = (id: string, label: string, layer: HairLayer): HairPart => ({
  id, label, layer, file: AVATAR_V2_BASE + P[id].src, mask: P[id].accent_mask ? AVATAR_V2_BASE + P[id].accent_mask : null,
  x: P[id].x, y: P[id].y, w: P[id].w, h: P[id].h, bone: P[id].bone,
});
export const BUILTIN_HAIR_ID = "builtin:" + RIG_V2.hair.style;
export const BUILTIN_HEAD_ID = "builtin:head_v2";
export const BUILTIN_HAIRS: DollAsset<HairConfig>[] = [
  {
    id: BUILTIN_HAIR_ID, kind: "hair", name: "長雙馬尾", category: "雙馬尾", builtin: true,
    config: {
      ref_luma: RIG_V2.hair.ref_luma,
      parts: [
        hairPart("hair_tail_r", "右馬尾", "back"), hairPart("hair_tail_l", "左馬尾", "back"), hairPart("hair_back_base", "後髮", "back"),
        hairPart("hair_side_r", "右側髮", "front"), hairPart("hair_side_l", "左側髮", "front"), hairPart("hair_bangs", "瀏海", "front"),
      ],
    },
  },
];
export const BUILTIN_HEADS: DollAsset<HeadConfig>[] = [
  { id: BUILTIN_HEAD_ID, kind: "head", name: "原創臉", category: null, builtin: true, config: { file: AVATAR_V2_BASE + P.head.src, x: P.head.x, y: P.head.y, w: P.head.w, h: P.head.h } },
];
/** 沒有頭髮（方便檢查頭部素材或配搭帽子） */
export const NO_HAIR_ID = "none";

/** 髮束的骨骼 id */
export const hairBoneId = (p: HairPart) => (p.bone === "own" ? "hp_" + p.id : p.bone);
const rigCache = new WeakMap<HairConfig, Rig>();
/** 目前髮型下的完整骨架：基本骨架＋這款髮型自帶的髮束骨骼 */
export function rigFor(hair: HairConfig | null | undefined): Rig {
  if (!hair) return RIG_V2;
  let rig = rigCache.get(hair);
  if (!rig) {
    const extra: Bone[] = hair.parts.filter((p) => p.bone === "own" && p.pivot).map((p) => ({
      id: hairBoneId(p), parent: "head", rest_position: p.pivot!, rest_angle: 0, pivot: p.pivot!, min_angle: -(p.range ?? 20), max_angle: p.range ?? 20, attached_assets: [p.id],
    }));
    rig = extra.length ? { ...RIG_V2, bones: [...RIG_V2.bones, ...extra] } : RIG_V2;
    rigCache.set(hair, rig);
  }
  return rig;
}

// ───── 髮色 ─────
export type Rgb = [number, number, number]; // 0–255
export interface HairColor {
  id: string;
  label: string;
  /** null＝保留原圖顏色 */
  main: Rgb | null;
  accent: Rgb | null;
  /** 色票顯示用 */
  swatch: [string, string];
}
const PINK: Rgb = [232, 120, 158];
export const HAIR_COLORS: HairColor[] = [
  { id: "brown_pink", label: "啡粉挑染", main: null, accent: null, swatch: ["#644950", "#e0899f"] },
  { id: "dark_brown", label: "深啡色", main: null, accent: [100, 73, 79], swatch: ["#644950", "#644950"] },
  { id: "black", label: "黑色", main: [44, 40, 50], accent: [44, 40, 50], swatch: ["#2c2832", "#2c2832"] },
  { id: "black_pink", label: "黑粉挑染", main: [44, 40, 50], accent: PINK, swatch: ["#2c2832", "#e8789e"] },
  { id: "silver", label: "銀灰色", main: [176, 180, 196], accent: [176, 180, 196], swatch: ["#b0b4c4", "#b0b4c4"] },
  { id: "purple", label: "紫色", main: [126, 84, 170], accent: [126, 84, 170], swatch: ["#7e54aa", "#7e54aa"] },
  { id: "pink", label: "粉色", main: [236, 150, 182], accent: [236, 150, 182], swatch: ["#ec96b6", "#ec96b6"] },
];
export const DEFAULT_HAIR_COLOR = "brown_pink";

const HEX = /^#[0-9a-f]{6}$/i;
export const rgbToHex = (c: Rgb) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
export function hexToRgb(hex: string): Rgb | null {
  if (!HEX.test(hex)) return null;
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
/** 儲存用的顏色值：預設 id，或 #rrggbb；不合法回傳 null */
export function normalizeColorValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (HAIR_COLORS.some((c) => c.id === v)) return v;
  return HEX.test(v) ? v.toLowerCase() : null;
}
/** 由儲存值得出實際的主髮色及挑染色（accent 可獨立指定） */
export function resolveHairColors(hairColor: string | null | undefined, accentColor: string | null | undefined): { main: Rgb | null; accent: Rgb | null } {
  const preset = HAIR_COLORS.find((c) => c.id === hairColor);
  let main = preset ? preset.main : (hairColor && hexToRgb(hairColor)) || null;
  let accent = preset ? preset.accent : main;
  if (accentColor) {
    const a = HAIR_COLORS.find((c) => c.id === accentColor);
    if (accentColor === "original") accent = null;
    else if (a) accent = a.accent ?? a.main;
    else accent = hexToRgb(accentColor) ?? accent;
  }
  if (!preset && !hairColor) main = null;
  return { main, accent };
}

const LR = 0.2126, LG = 0.7152, LB = 0.0722;
/** 把一個像素按原本的亮度重新著色：暗部按比例變暗，高光向白色過渡，保留髮絲明暗 */
function tint(r: number, g: number, b: number, target: Rgb, refLuma: number): Rgb {
  const l = (LR * r + LG * g + LB * b) / 255;
  const ratio = l / Math.max(0.02, refLuma);
  if (ratio <= 1) return [target[0] * ratio, target[1] * ratio, target[2] * ratio];
  const t = Math.min(1, (ratio - 1) / Math.max(0.05, 1 / Math.max(0.02, refLuma) - 1));
  return [target[0] + (255 - target[0]) * t, target[1] + (255 - target[1]) * t, target[2] + (255 - target[2]) * t];
}

export interface HairStats { cb: number; cr: number; main: number; accent: number; hasAccent: boolean }
const chroma = (r: number, g: number, b: number): [number, number] => [-0.1146 * r - 0.3854 * g + 0.5 * b, 0.5 * r - 0.4542 * g - 0.0458 * b];
const accentWeight = (r: number, g: number, b: number, s: HairStats) => {
  const [cb, cr] = chroma(r, g, b);
  const d = Math.hypot(cb - s.cb, cr - s.cr);
  return d <= 12 ? 0 : d >= 26 ? 1 : (d - 12) / 14;
};
/**
 * 沒有染色遮罩的髮型：由像素自動找出「主髮色」（佔最多的色調）及參考亮度，
 * 色調明顯不同的髮絲當作挑染。只需計算一次（可合併多個部件的像素）。
 */
export function analyzeHair(images: (Uint8ClampedArray | Uint8Array)[]): HairStats {
  const bins = new Map<number, { n: number; cb: number; cr: number }>();
  const step = 4 * 3;
  for (const px of images) {
    for (let i = 0; i < px.length; i += step) {
      if (px[i + 3] < 200) continue;
      const [cb, cr] = chroma(px[i], px[i + 1], px[i + 2]);
      const key = Math.round(cb / 10) * 1000 + Math.round(cr / 10);
      const bin = bins.get(key) ?? { n: 0, cb: 0, cr: 0 };
      bin.n++; bin.cb += cb; bin.cr += cr;
      bins.set(key, bin);
    }
  }
  let top = { n: 0, cb: 0, cr: 0 };
  for (const b of bins.values()) if (b.n > top.n) top = b;
  const stats: HairStats = { cb: top.n ? top.cb / top.n : 0, cr: top.n ? top.cr / top.n : 0, main: 0.35, accent: 0.6, hasAccent: false };
  let mainL = 0, mainN = 0, accL = 0, accN = 0;
  for (const px of images) {
    for (let i = 0; i < px.length; i += step) {
      if (px[i + 3] < 200) continue;
      const l = (LR * px[i] + LG * px[i + 1] + LB * px[i + 2]) / 255;
      const w = accentWeight(px[i], px[i + 1], px[i + 2], stats);
      if (w < 0.2) { mainL += l; mainN++; } else if (w > 0.8) { accL += l; accN++; }
    }
  }
  if (mainN) stats.main = Math.max(0.05, mainL / mainN);
  stats.hasAccent = accN > Math.max(40, (mainN + accN) * 0.02);
  stats.accent = stats.hasAccent ? Math.max(0.05, accL / accN) : stats.main;
  return stats;
}

export interface RecolorOptions {
  main: Rgb | null;
  accent: Rgb | null;
  ref: { main: number; accent: number };
  /** 沒有遮罩時用來分辨挑染 */
  stats?: HairStats | null;
  /** 髮尾漸層：由 row0 開始漸變，到 row1 完全變成 tip 色（圖片的列數） */
  tip?: { color: Rgb; row0: number; row1: number } | null;
  width?: number;
}
/**
 * 重新著色頭髮（就地修改 RGBA 像素；alpha 不變，所以輪廓及位置不變）。
 * mask：同尺寸 RGBA，R＝挑染比重（0＝主髮色，255＝挑染），G＝是否頭髮（瀏海投在皮膚上的陰影為 0，不著色）。
 * main／accent 為 null 時該部分保留原色。
 */
export function recolorHair(pixels: Uint8ClampedArray | Uint8Array, mask: Uint8ClampedArray | Uint8Array | null, o: RecolorOptions): void {
  const { main, accent, ref, tip } = o;
  if (!main && !accent && !tip) return;
  const stats = !mask && o.stats?.hasAccent ? o.stats : null;
  const rowLen = (o.width ?? 0) * 4;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const wa = mask ? mask[i] / 255 : stats ? accentWeight(r, g, b, stats) : 0;
    const wh = mask ? mask[i + 1] / 255 : 1;
    if (wh <= 0) continue;
    const m = main ? tint(r, g, b, main, ref.main) : [r, g, b];
    const a = wa > 0 ? (accent ? tint(r, g, b, accent, ref.accent) : [r, g, b]) : m;
    let nr = m[0] * (1 - wa) + a[0] * wa, ng = m[1] * (1 - wa) + a[1] * wa, nb = m[2] * (1 - wa) + a[2] * wa;
    if (tip && rowLen) {
      const row = Math.floor(i / rowLen);
      const t = row <= tip.row0 ? 0 : row >= tip.row1 ? 1 : (row - tip.row0) / (tip.row1 - tip.row0);
      if (t > 0) {
        const c = tint(r, g, b, tip.color, wa > 0.5 ? ref.accent : ref.main);
        const k = t * t * (3 - 2 * t);
        nr += (c[0] - nr) * k; ng += (c[1] - ng) * k; nb += (c[2] - nb) * k;
      }
    }
    pixels[i] = r + (nr - r) * wh;
    pixels[i + 1] = g + (ng - g) * wh;
    pixels[i + 2] = b + (nb - b) * wh;
  }
}

export const BONE_LABEL: Record<string, string> = {
  root: "整體重心", pelvis: "骨盆", torso: "腰", chest: "上胸", neck: "頸", head: "頭",
  shoulder_r: "右肩", elbow_r: "右手肘", wrist_r: "右手掌", shoulder_l: "左肩", elbow_l: "左手肘", wrist_l: "左手掌",
  hip_r: "右大腿", knee_r: "右膝", ankle_r: "右腳掌", hip_l: "左大腿", knee_l: "左膝", ankle_l: "左腳掌",
  hair_tail_r: "右馬尾", hair_tail_l: "左馬尾", hair_side_r: "右側髮", hair_side_l: "左側髮",
};
/** 身體區域（重設某一區的姿勢時使用） */
export const BONE_GROUPS: { id: string; label: string; bones: string[] }[] = [
  { id: "body", label: "頭及身", bones: ["root", "pelvis", "torso", "chest", "neck", "head"] },
  { id: "arms", label: "手臂", bones: ["shoulder_r", "elbow_r", "wrist_r", "shoulder_l", "elbow_l", "wrist_l"] },
  { id: "legs", label: "腿", bones: ["hip_r", "knee_r", "ankle_r", "hip_l", "knee_l", "ankle_l"] },
  { id: "hair", label: "頭髮", bones: ["hair_tail_r", "hair_tail_l", "hair_side_r", "hair_side_l"] },
];
