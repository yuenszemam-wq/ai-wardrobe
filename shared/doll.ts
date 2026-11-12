// 角色換裝（Moonlit Dressing Room）的共用定義：素體、錨點、圖層、互斥規則及預設穿著位置。
// 全部是純函數／常數，前端及 Worker 共用，可直接單元測試。座標＝1200×1800 邏輯畫布像素。

import { AVATAR_V2_ID, RIG_V2 } from "./avatarV2";
import { posedAnchors } from "./avatarRig";

export const DOLL_W = 1200;
export const DOLL_H = 1800;

export interface Fit {
  cx: number; // 圖片中心
  cy: number;
  w: number; // 顯示寬度（高度＝w × 圖片高寬比）
  rotation: number; // 度
}

export interface Avatar {
  id: string;
  /** 素體圖層（已對位到同一畫布）。under＝衣物之下，over＝衣物之上（頭飾仍在其上） */
  layers: { src: string; place: "under" | "over" }[];
  /** 定位錨點 */
  anchors: Record<string, { x: number; y: number }>;
}

export const BASE_V1: Avatar = {
  id: "base_v1",
  layers: [
    { src: "/doll/base_v1/hair_back.png", place: "under" },
    { src: "/doll/base_v1/body.png", place: "under" },
    { src: "/doll/base_v1/head.png", place: "over" },
  ],
  anchors: {
    head_top: { x: 600, y: 116 },
    chin: { x: 600, y: 442 },
    neck: { x: 600, y: 478 },
    shoulder_l: { x: 456, y: 520 },
    shoulder_r: { x: 742, y: 520 },
    bust: { x: 600, y: 630 },
    waist: { x: 598, y: 745 },
    hip: { x: 598, y: 885 },
    knee_l: { x: 516, y: 1280 },
    knee_r: { x: 678, y: 1280 },
    ankle_l: { x: 502, y: 1660 },
    ankle_r: { x: 696, y: 1660 },
    floor: { x: 600, y: 1782 },
  },
};
export const BASE_V2: Avatar = { id: AVATAR_V2_ID, layers: [], anchors: posedAnchors(RIG_V2, {}) };
export const AVATARS: Record<string, Avatar> = { [BASE_V1.id]: BASE_V1, [BASE_V2.id]: BASE_V2 };
export const DEFAULT_AVATAR = BASE_V1.id;

// ───── 圖層 ─────
// 次序由底到面。素體（後髮、身體）在全部衣物之下；頭（臉＋前髮）在 HEAD_Z，只有頭飾在它之上。
export const SLOTS = ["socks", "shoes", "petticoat", "top", "pants", "skirt", "dress", "set", "outer", "bag", "accessory", "headwear"] as const;
export type Slot = (typeof SLOTS)[number];
export const SLOT_Z: Record<Slot, number> = { socks: 100, shoes: 150, petticoat: 200, top: 300, pants: 350, skirt: 400, dress: 500, set: 550, outer: 600, bag: 700, accessory: 750, headwear: 900 };
export const HEAD_Z = 800;
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

/** 連身裙類型：OP 自帶袖，不配襯衫；JSK 可配襯衫 */
export type DressKind = "op" | "jsk" | "other";
export function dressKind(subcategory: string | null | undefined): DressKind {
  const s = (subcategory || "").toLowerCase();
  if (s === "op" || s.includes("one piece")) return "op";
  if (s === "jsk" || s.includes("jumper")) return "jsk";
  return "other";
}

// ───── 互斥 ─────
export interface Worn {
  garment_id: string;
  slot: Slot;
  subcategory?: string | null;
}
/** 每個位置最多可同時穿幾件 */
export const SLOT_LIMIT: Record<Slot, number> = { socks: 1, shoes: 1, petticoat: 1, top: 1, pants: 1, skirt: 1, dress: 1, set: 1, outer: 1, bag: 1, accessory: 6, headwear: 2 };

/** 穿上 item 時要脫下哪些已穿的衣物（回傳 garment_id） */
export function conflicts(current: Worn[], item: Worn): string[] {
  const out = new Set<string>();
  const drop = (pred: (w: Worn) => boolean) => current.filter(pred).forEach((w) => out.add(w.garment_id));
  const kind = item.slot === "dress" ? dressKind(item.subcategory) : null;
  if (item.slot === "dress") {
    drop((w) => w.slot === "skirt" || w.slot === "pants" || w.slot === "set");
    if (kind === "op") drop((w) => w.slot === "top");
  } else if (item.slot === "skirt" || item.slot === "pants") {
    drop((w) => w.slot === "dress" || w.slot === "set" || w.slot === (item.slot === "skirt" ? "pants" : "skirt"));
  } else if (item.slot === "top") {
    drop((w) => w.slot === "set" || (w.slot === "dress" && dressKind(w.subcategory) === "op"));
  } else if (item.slot === "set") {
    drop((w) => w.slot === "dress" || w.slot === "top" || w.slot === "skirt" || w.slot === "pants");
  }
  // 同一位置超出上限：脫下最早穿上的
  const same = current.filter((w) => w.slot === item.slot && w.garment_id !== item.garment_id && !out.has(w.garment_id));
  const over = same.length + 1 - SLOT_LIMIT[item.slot];
  same.slice(0, Math.max(0, over)).forEach((w) => out.add(w.garment_id));
  out.delete(item.garment_id);
  return [...out];
}

/** 穿上（已穿則不變）。回傳新的清單，次序＝穿上的先後 */
export function wear<T extends Worn>(current: T[], item: T): T[] {
  if (current.some((w) => w.garment_id === item.garment_id)) return current;
  const off = new Set(conflicts(current, item));
  return [...current.filter((w) => !off.has(w.garment_id)), item];
}

/** 繪畫次序：先按圖層，同層按穿上的先後 */
export function drawOrder<T extends Worn>(items: T[]): T[] {
  return items.map((it, i) => ({ it, i })).sort((a, b) => SLOT_Z[a.it.slot] - SLOT_Z[b.it.slot] || a.i - b.i).map((x) => x.it);
}

// ───── 預設穿著位置 ─────
/** 衣物在圖片內實際佔的範圍（0–1）；ar＝圖片高÷寬 */
export interface Content { x0: number; y0: number; x1: number; y1: number; ar: number; waistBand?: { x0: number; x1: number }; approximate?: boolean }
export const FULL_CONTENT = (ar = 4 / 3): Content => ({ x0: 0, y0: 0, x1: 1, y1: 1, ar });

interface Rule { cx: number; top?: number; bottom?: number; cy?: number; h?: number; w?: number }
const A = BASE_V1.anchors;
/** 以衣物「實際內容」對齊錨點：top／bottom／cy 定垂直位置，h 或 w 定大小 */
const RULES: Record<Slot, Rule> = {
  dress: { cx: 600, top: A.shoulder_l.y - 28, h: 800 },
  set: { cx: 600, top: A.shoulder_l.y - 40, h: 900 },
  top: { cx: 600, top: A.shoulder_l.y - 36, h: 420 },
  outer: { cx: 600, top: A.shoulder_l.y - 44, h: 540 },
  skirt: { cx: 598, top: A.waist.y - 10, h: 540 },
  petticoat: { cx: 598, top: A.waist.y + 10, h: 470 },
  pants: { cx: 598, top: A.waist.y - 10, h: 900 },
  socks: { cx: 598, bottom: A.floor.y - 70, h: 430 },
  shoes: { cx: 598, bottom: A.floor.y + 4, h: 150 },
  headwear: { cx: 600, cy: A.head_top.y + 40, w: 340 },
  bag: { cx: 880, cy: 930, h: 260 },
  accessory: { cx: 600, cy: A.neck.y + 10, h: 120 },
};
/** 完整穿搭圖通常連頭飾和鞋，佔滿全身 */
const FULL_OUTFIT: Rule = { cx: 600, top: A.head_top.y - 30, h: A.floor.y - A.head_top.y + 30 };

const round = (n: number) => Math.round(n * 10) / 10;
export function defaultFit(slot: Slot, content: Content, category?: string | null, avatar: Avatar = BASE_V1, subcategory?: string | null, name?: string | null): Fit {
  let r = slot === "set" && category === "完整穿搭" ? FULL_OUTFIT : RULES[slot];
  if (avatar.id === BASE_V2.id) {
    const a = avatar.anchors;
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
    r = slot === "set" && category === "完整穿搭" ? { cx: center, top: a.head_top.y, h: a.floor.y - a.head_top.y } : rules[slot];
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
  }
  const cw = Math.max(0.02, content.x1 - content.x0), ch = Math.max(0.02, content.y1 - content.y0);
  const ar = content.ar > 0 ? content.ar : 4 / 3;
  let w = clampW(r.h !== undefined ? r.h / ch / ar : (r.w ?? 400) / cw);
  // Waistband width is a stronger clue than skirt silhouette height, within conservative limits.
  const band = avatar.id === BASE_V2.id && slot === "skirt" && !content.approximate ? content.waistBand : undefined;
  if (band && band.x1 > band.x0) {
    const target = (avatar.anchors.waist_side_l.x - avatar.anchors.waist_side_r.x) * 1.08;
    const candidate = target / (band.x1 - band.x0);
    if (candidate >= w * 0.75 && candidate <= w * 1.3) w = clampW(candidate);
  }
  const h = w * ar;
  const contentH = ch * h;
  const contentTop = r.top !== undefined ? r.top : r.bottom !== undefined ? r.bottom - contentH : (r.cy ?? DOLL_H / 2) - contentH / 2;
  const top = contentTop - content.y0 * h;
  const left = r.cx - (band ? (band.x0 + band.x1) / 2 : (content.x0 + content.x1) / 2) * w;
  return { cx: round(left + w / 2), cy: round(top + h / 2), w: round(w), rotation: 0 };
}

export const FIT_LIMIT = { minW: 30, maxW: 3600, pad: 1200 };
const clampW = (w: number) => Math.min(FIT_LIMIT.maxW, Math.max(FIT_LIMIT.minW, w));
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
  return { cx: round(cx), cy: round(cy), w: round(w), rotation: round(r) };
}

/** 顯示位置的優先次序：造型個別修改 → 衣物模板 → 分類預設 */
export function resolveFit(override: Fit | null | undefined, template: Fit | null | undefined, fallback: Fit): { fit: Fit; from: "override" | "template" | "default" } {
  if (override) return { fit: override, from: "override" };
  if (template) return { fit: template, from: "template" };
  return { fit: fallback, from: "default" };
}
export const sameFit = (a: Fit, b: Fit) => Math.abs(a.cx - b.cx) < 0.06 && Math.abs(a.cy - b.cy) < 0.06 && Math.abs(a.w - b.w) < 0.06 && Math.abs(a.rotation - b.rotation) < 0.06;

/** 點（邏輯座標）是否落在衣物的實際內容範圍內（已計及旋轉）。用於點選：透明留白不會擋住下面的衣物。 */
export function hitTest(fit: Fit, content: Content, x: number, y: number, margin = 12): boolean {
  const t = (-fit.rotation * Math.PI) / 180;
  const dx = x - fit.cx, dy = y - fit.cy;
  const lx = dx * Math.cos(t) - dy * Math.sin(t), ly = dx * Math.sin(t) + dy * Math.cos(t);
  const h = fit.w * (content.ar > 0 ? content.ar : 4 / 3);
  const px = lx + fit.w / 2, py = ly + h / 2;
  return px >= content.x0 * fit.w - margin && px <= content.x1 * fit.w + margin && py >= content.y0 * h - margin && py <= content.y1 * h + margin;
}
