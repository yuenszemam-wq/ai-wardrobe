/**
 * Phase 3.9A.2：創作工作室 V2 的標準化場景資料（前端畫布、保存、縮圖、匯出及伺服器驗證共用）。
 *
 * 座標：每個圖層是一個方框（x、y＝左上角，w、h＝大小，全部以「畫布寬／高的百分比」表示），
 * 圖片按比例完整放入方框（contain）；旋轉以方框中心為軸，翻轉在方框內進行。
 * 這與 Phase 3.9A.1 以前的 outfit_items 完全相同，所以舊造型載入後畫面不變。
 *
 * 圖層次序：內部陣列由底至頂（index 0＝最底）。使用者看到的列表「上方＝最前」，
 * 轉換只在 toTopFirst／fromTopFirst 進行，其他元件不要自行反轉。背景不屬於圖層，永遠在最底。
 *
 * 遮罩：以圖片本身的相對座標（0–1）保存筆畫（hide 隱藏／restore 還原），所以移動、縮放、旋轉圖層後仍然對齊；
 * 遮罩屬於圖層，不修改衣櫃原圖；複製的圖層各自擁有遮罩。
 */

export const CANVAS_W = 1200, CANVAS_H = 1600;
export const MAX_LAYERS = 60;
export const MAX_MASK_POINTS = 6000;

export type LayerType = "garment" | "garment_part" | "studio_asset";
export interface MaskStroke { mode: "hide" | "restore"; /** 筆刷直徑（相對圖片寬度 0–1） */ size: number; /** 點（相對圖片寬高 0–1），[x0,y0,x1,y1…] */ pts: number[] }
export interface LayerMask { v: 1; strokes: MaskStroke[] }
export interface Layer {
  layer_id: string;
  layer_type: LayerType;
  garment_id: string | null;
  garment_part_id: string | null;
  asset_id: string | null;
  asset_version_id: string | null;
  group_id: string | null;
  name: string;
  x: number; y: number; w: number; h: number;
  rotation: number;
  flip_x: boolean; flip_y: boolean;
  opacity: number;
  hidden: boolean; locked: boolean;
  mask: LayerMask | null;
  /** 素材圖層：使用原圖或去背圖（衣物圖層固定 original） */
  variant: "original" | "cutout";
}

// ───── 背景 ─────
export type BackgroundType = "transparent" | "solid" | "gradient" | "stripes" | "dots" | "check" | "image";
export interface BackgroundImage { asset_id: string; version_id: string; variant: "original" | "cutout"; fit: "cover" | "contain"; x: number; y: number; scale: number; rotate: number; flip_x: boolean; flip_y: boolean; opacity: number; blur: number }
export interface BackgroundSpec {
  v: 1;
  type: BackgroundType;
  color: string;
  color2: string;
  /** 漸層色點（至少兩個） */
  stops: { color: string; at: number }[];
  angle: number;
  size: number;
  gap: number;
  opacity: number;
  image: BackgroundImage | null;
}
export const BACKGROUND_TYPES: [BackgroundType, string][] = [["transparent", "透明"], ["solid", "純色"], ["gradient", "漸層"], ["stripes", "條紋"], ["dots", "波點"], ["check", "格紋"], ["image", "圖片"]];
const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : d);
const num = (v: unknown, d: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p;

export const DEFAULT_BACKGROUND: BackgroundSpec = { v: 1, type: "transparent", color: "#fffaf6", color2: "#f3dcd8", stops: [{ color: "#fffaf6", at: 0 }, { color: "#f3dcd8", at: 1 }], angle: 180, size: 40, gap: 40, opacity: 1, image: null };
/** 內建風格（只保存設定，不使用 R2 圖片） */
export const BACKGROUND_PRESETS: [string, Partial<BackgroundSpec>][] = [
  ["奶油白", { type: "solid", color: "#fbf3e8" }],
  ["淺粉色", { type: "gradient", stops: [{ color: "#fde8ef", at: 0 }, { color: "#f6c9d8", at: 1 }], angle: 180 }],
  ["哥德黑紫", { type: "gradient", stops: [{ color: "#2a1526", at: 0 }, { color: "#120a14", at: 1 }], angle: 160 }],
  ["黑金", { type: "stripes", color: "#141014", color2: "#3a2f1c", size: 24, gap: 24, angle: 90 }],
  ["玫瑰桑紫", { type: "dots", color: "#4a2742", color2: "#c97aa0", size: 10, gap: 32 }],
  ["攝影棚", { type: "gradient", stops: [{ color: "#f4f1ee", at: 0 }, { color: "#d9d4cf", at: 0.75 }, { color: "#bdb6af", at: 1 }], angle: 180 }],
];

/** 驗證並修正背景（伺服器及前端共用）；null／不正確＝null（舊造型維持原本預設） */
export function normalizeBackground(v: unknown): BackgroundSpec | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const type = BACKGROUND_TYPES.some(([k]) => k === s.type) ? (s.type as BackgroundType) : null;
  if (!type) return null;
  const stopsIn = Array.isArray(s.stops) ? s.stops.slice(0, 6) : [];
  const stops = stopsIn.map((x) => ({ color: hex((x as { color?: unknown })?.color, "#ffffff"), at: round(num((x as { at?: unknown })?.at, 0, 0, 1), 3) })).sort((a, b) => a.at - b.at);
  const imgIn = s.image && typeof s.image === "object" ? (s.image as Record<string, unknown>) : null;
  const image: BackgroundImage | null = imgIn && typeof imgIn.version_id === "string" && /^[\w-]{1,64}$/.test(imgIn.version_id) && typeof imgIn.asset_id === "string" && /^[\w-]{1,64}$/.test(imgIn.asset_id)
    ? { asset_id: imgIn.asset_id, version_id: imgIn.version_id, variant: imgIn.variant === "cutout" ? "cutout" : "original", fit: imgIn.fit === "contain" ? "contain" : "cover", x: round(num(imgIn.x, 0, -100, 100)), y: round(num(imgIn.y, 0, -100, 100)), scale: round(num(imgIn.scale, 1, 0.2, 5)), rotate: round(num(imgIn.rotate, 0, -180, 180)), flip_x: !!imgIn.flip_x, flip_y: !!imgIn.flip_y, opacity: round(num(imgIn.opacity, 1, 0, 1)), blur: round(num(imgIn.blur, 0, 0, 30), 1) }
    : null;
  if (type === "image" && !image) return null;
  return {
    v: 1, type, color: hex(s.color, DEFAULT_BACKGROUND.color), color2: hex(s.color2, DEFAULT_BACKGROUND.color2),
    stops: stops.length >= 2 ? stops : DEFAULT_BACKGROUND.stops, angle: round(num(s.angle, 180, 0, 360), 1),
    size: round(num(s.size, 40, 2, 400), 1), gap: round(num(s.gap, 40, 2, 400), 1), opacity: round(num(s.opacity, 1, 0, 1)), image: type === "image" ? image : null,
  };
}
export const withPreset = (cur: BackgroundSpec | null, p: Partial<BackgroundSpec>): BackgroundSpec => normalizeBackground({ ...DEFAULT_BACKGROUND, ...(cur ?? {}), ...p, image: p.type === "image" ? cur?.image : null })!;

// ───── 圖層 ─────
export function normalizeMask(v: unknown): LayerMask | null {
  if (!v || typeof v !== "object" || !Array.isArray((v as LayerMask).strokes)) return null;
  let budget = MAX_MASK_POINTS * 2;
  const strokes: MaskStroke[] = [];
  for (const raw of (v as LayerMask).strokes.slice(0, 400)) {
    if (!raw || !Array.isArray(raw.pts)) continue;
    const pts = raw.pts.slice(0, Math.max(0, budget)).map((n) => round(num(n, 0, -0.5, 1.5), 4));
    if (pts.length % 2) pts.pop();
    if (!pts.length) continue;
    budget -= pts.length;
    strokes.push({ mode: raw.mode === "restore" ? "restore" : "hide", size: round(num(raw.size, 0.05, 0.002, 1), 4), pts });
  }
  return strokes.length ? { v: 1, strokes } : null;
}
const ID = /^[\w:.-]{1,80}$/;
/** 驗證單一圖層（不合法回傳錯誤訊息） */
export function normalizeLayer(raw: unknown): Layer | string {
  if (!raw || typeof raw !== "object") return "圖層資料不正確";
  const r = raw as Record<string, unknown>;
  const type = r.layer_type === "garment_part" || r.layer_type === "studio_asset" ? r.layer_type : r.layer_type === "garment" || r.layer_type == null ? "garment" : null;
  if (!type) return "圖層類型不正確";
  const id = (k: string) => (typeof r[k] === "string" && ID.test(r[k] as string) ? (r[k] as string) : null);
  const layer_id = id("layer_id");
  if (!layer_id) return "缺少圖層識別";
  const garment_id = id("garment_id"), garment_part_id = id("garment_part_id"), asset_id = id("asset_id"), asset_version_id = id("asset_version_id");
  if ((type === "garment" || type === "garment_part") && !garment_id) return "衣物圖層缺少衣物";
  if (type === "garment_part" && !garment_part_id) return "套裝部件圖層缺少部件";
  if (type === "studio_asset" && (!asset_id || !asset_version_id)) return "素材圖層缺少素材版本";
  const w = round(num(r.w, 50, 1, 400)), h = round(num(r.h, 50, 1, 400));
  return {
    layer_id, layer_type: type, garment_id: type === "studio_asset" ? null : garment_id, garment_part_id: type === "garment_part" ? garment_part_id : null,
    asset_id: type === "studio_asset" ? asset_id : null, asset_version_id: type === "studio_asset" ? asset_version_id : null, group_id: id("group_id"),
    name: typeof r.name === "string" ? r.name.slice(0, 80) : "",
    x: round(num(r.x, 0, -300, 300)), y: round(num(r.y, 0, -300, 300)), w, h,
    rotation: round(((num(r.rotation, 0, -3600, 3600) % 360) + 540) % 360 - 180, 2),
    flip_x: !!r.flip_x, flip_y: !!r.flip_y, opacity: round(num(r.opacity, 1, 0, 1)), hidden: !!r.hidden, locked: !!r.locked, mask: normalizeMask(r.mask), variant: type === "studio_asset" && r.variant === "cutout" ? "cutout" : "original",
  };
}

/** 舊造型（outfit_items，只有衣物 ID 及位置）→ 圖層。圖層 ID 穩定（g:<衣物 ID>），次序及位置不變 */
export interface LegacyItem { garment_id: string; name?: string | null; category?: string | null; layer_order?: number | null; position?: number | null; x: number | null; y: number | null; w: number | null; h: number | null }
export function legacyLayers(items: LegacyItem[], fallback: (i: LegacyItem) => { x: number; y: number; w: number; h: number }): Layer[] {
  return [...items].sort((a, b) => (a.layer_order ?? 0) - (b.layer_order ?? 0) || (a.position ?? 0) - (b.position ?? 0)).map((i) => {
    const d = i.x == null || i.y == null || i.w == null || i.h == null ? fallback(i) : { x: i.x, y: i.y, w: i.w, h: i.h };
    return { layer_id: "g:" + i.garment_id, layer_type: "garment", garment_id: i.garment_id, garment_part_id: null, asset_id: null, asset_version_id: null, group_id: null, name: i.name ?? "", ...d, rotation: 0, flip_x: false, flip_y: false, opacity: 1, hidden: false, locked: false, mask: null, variant: "original" };
  });
}

// 新加入的單品按類別放在人台的大約位置（與 Phase 3.9A.1 以前相同；舊造型缺少位置時亦使用）
export interface Box { x: number; y: number; w: number; h: number }
const SLOT: Record<string, Box> = {
  頭飾: { y: 0, h: 16, x: 30, w: 40 }, 外套: { y: 12, h: 46, x: 14, w: 72 }, 上衣: { y: 14, h: 34, x: 20, w: 60 }, 連身裙: { y: 16, h: 60, x: 12, w: 76 },
  套裝: { y: 14, h: 66, x: 12, w: 76 }, 完整穿搭: { y: 4, h: 92, x: 8, w: 84 }, 半身裙: { y: 38, h: 38, x: 12, w: 76 }, 內搭與裙撐: { y: 40, h: 36, x: 10, w: 80 },
  褲: { y: 40, h: 44, x: 22, w: 56 }, 襪: { y: 70, h: 22, x: 30, w: 40 }, 鞋: { y: 84, h: 15, x: 28, w: 44 }, 手袋: { y: 46, h: 22, x: 66, w: 32 },
  配件: { y: 30, h: 18, x: 2, w: 26 }, 其他裝飾: { y: 8, h: 30, x: 70, w: 28 },
};
export const DEFAULT_SLOT: Box = { y: 20, h: 50, x: 20, w: 60 };
export const slotFor = (category: string | null | undefined): Box => ({ ...((category && SLOT[category]) || DEFAULT_SLOT) });

// ───── 次序（唯一的轉換位置） ─────
/** 內部（底→頂）→ 列表（頂→底） */
export const toTopFirst = <T>(bottomFirst: T[]): T[] => [...bottomFirst].reverse();
/** 列表（頂→底）→ 內部（底→頂） */
export const fromTopFirst = <T>(topFirst: T[]): T[] => [...topFirst].reverse();
export function reorderByTopFirstIds(layers: Layer[], ids: string[]): Layer[] {
  const map = new Map(layers.map((l) => [l.layer_id, l]));
  const listed = ids.map((id) => map.get(id)).filter((l): l is Layer => !!l);
  const rest = layers.filter((l) => !ids.includes(l.layer_id));
  return [...rest, ...fromTopFirst(listed)];
}
export function moveLayer(layers: Layer[], id: string, op: "forward" | "backward" | "front" | "back"): Layer[] {
  const i = layers.findIndex((l) => l.layer_id === id);
  if (i < 0) return layers;
  const out = [...layers];
  const [l] = out.splice(i, 1);
  const to = op === "front" ? out.length : op === "back" ? 0 : op === "forward" ? Math.min(out.length, i + 1) : Math.max(0, i - 1);
  out.splice(to, 0, l);
  return out;
}
export function duplicateLayer(layers: Layer[], id: string, newId: string): Layer[] {
  const i = layers.findIndex((l) => l.layer_id === id);
  if (i < 0) return layers;
  const src = layers[i];
  const copy: Layer = { ...src, layer_id: newId, x: round(src.x + 3), y: round(src.y + 3), locked: false, hidden: false, mask: src.mask ? { v: 1, strokes: src.mask.strokes.map((s) => ({ ...s, pts: [...s.pts] })) } : null };
  const out = [...layers];
  out.splice(i + 1, 0, copy); // 放在原圖層之上
  return out;
}
export const garmentIdsOf = (layers: Layer[]) => [...new Set(layers.map((l) => l.garment_id).filter((x): x is string => !!x))];
export const sameScene = (a: { layers: Layer[]; background: BackgroundSpec | null }, b: { layers: Layer[]; background: BackgroundSpec | null }) => JSON.stringify(a) === JSON.stringify(b);

/** 圖層（含旋轉、翻轉）的畫布座標 → 圖層內相對座標（0–1，用於命中判斷及遮罩筆刷） */
export function toLayerLocal(l: Pick<Layer, "x" | "y" | "w" | "h" | "rotation" | "flip_x" | "flip_y">, px: number, py: number, imgAspect: number, canvasAspect = CANVAS_W / CANVAS_H): { u: number; v: number } {
  // 以「畫布寬度百分比」為統一單位，避免非正方形畫布令旋轉變形
  const cx = l.x + l.w / 2, cy = (l.y + l.h / 2) / canvasAspect;
  const dx = px - cx, dy = py / canvasAspect - cy;
  const a = (-l.rotation * Math.PI) / 180;
  let rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
  if (l.flip_x) rx = -rx;
  if (l.flip_y) ry = -ry;
  // 方框內 contain：實際圖片大小
  const bw = l.w, bh = l.h / canvasAspect;
  const s = Math.min(bw / imgAspect, bh);
  const iw = s * imgAspect, ih = s;
  return { u: rx / iw + 0.5, v: ry / ih + 0.5 };
}
