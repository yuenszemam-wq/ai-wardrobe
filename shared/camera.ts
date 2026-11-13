// 畫布鏡頭（Phase 3.2）：只決定「怎樣看」角色，與造型資料完全分開。
// 放大、縮小、平移只改變 Camera；衣物的大小、位置、旋轉、骨架及已保存的造型都不會被改動。
// 全部是純函數，前端及測試共用。邏輯座標＝1200×1800 畫布像素；螢幕座標＝舞台內的 CSS 像素。
import { DOLL_H, DOLL_W } from "./doll";

/** x／y＝對準舞台中心的邏輯座標；z＝相對「全身剛好放進舞台」的倍數（1＝全身） */
export interface Camera { x: number; y: number; z: number }
export interface Size { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }
/** 邏輯 → 螢幕：sx = x·k + ox */
export interface Xf { k: number; ox: number; oy: number }

export const ZOOM = { min: 0.5, max: 16 };
export const FULL_CAMERA: Camera = { x: DOLL_W / 2, y: DOLL_H / 2, z: 1 };
/** 快速取景預設（保留原有四個） */
export const VIEW_PRESETS: Record<string, Rect & { label: string }> = {
  full: { label: "全身", x: 0, y: 0, w: DOLL_W, h: DOLL_H },
  upper: { label: "上半身", x: 220, y: 0, w: 760, h: 980 },
  head: { label: "頭部", x: 370, y: -20, w: 460, h: 520 },
  lower: { label: "下半身", x: 220, y: 900, w: 760, h: 900 },
};
const PAN_PAD = 260;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** 「全身剛好放進舞台」時，一個邏輯像素等於多少螢幕像素 */
export const baseScale = (s: Size) => (s.w > 0 && s.h > 0 ? Math.min(s.w / DOLL_W, s.h / DOLL_H) : 0);
export function clampCamera(c: Camera): Camera {
  const z = clamp(Number.isFinite(c.z) ? c.z : 1, ZOOM.min, ZOOM.max);
  return { x: clamp(Number.isFinite(c.x) ? c.x : DOLL_W / 2, -PAN_PAD, DOLL_W + PAN_PAD), y: clamp(Number.isFinite(c.y) ? c.y : DOLL_H / 2, -PAN_PAD, DOLL_H + PAN_PAD), z };
}
export function transform(c: Camera, s: Size): Xf {
  const k = baseScale(s) * c.z;
  return { k, ox: s.w / 2 - c.x * k, oy: s.h / 2 - c.y * k };
}
export const toScreen = (t: Xf, x: number, y: number): [number, number] => [x * t.k + t.ox, y * t.k + t.oy];
export const toLogical = (t: Xf, sx: number, sy: number): [number, number] => [(sx - t.ox) / t.k, (sy - t.oy) / t.k];

/** 取景：令一個邏輯範圍剛好放進舞台（pad＝四周留白，螢幕像素） */
export function frame(rect: Rect, s: Size, pad = 0): Camera {
  const b = baseScale(s);
  if (!b) return FULL_CAMERA;
  const k = Math.min(Math.max(1, s.w - pad * 2) / Math.max(1, rect.w), Math.max(1, s.h - pad * 2) / Math.max(1, rect.h));
  return clampCamera({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2, z: k / b });
}
/** 以螢幕上的一點為中心縮放：該點對著的角色位置保持不動 */
export function zoomAt(c: Camera, s: Size, factor: number, sx = s.w / 2, sy = s.h / 2): Camera {
  const t = transform(c, s);
  if (!t.k) return c;
  const [lx, ly] = toLogical(t, sx, sy);
  const z = clamp(c.z * factor, ZOOM.min, ZOOM.max), k = baseScale(s) * z;
  return clampCamera({ x: lx - (sx - s.w / 2) / k, y: ly - (sy - s.h / 2) / k, z });
}
export const zoomTo = (c: Camera, s: Size, z: number, sx?: number, sy?: number) => zoomAt(c, s, z / c.z, sx, sy);
/** 平移（螢幕像素）：畫面跟著手指走 */
export function panBy(c: Camera, s: Size, dx: number, dy: number): Camera {
  const k = baseScale(s) * c.z;
  return k ? clampCamera({ x: c.x - dx / k, y: c.y - dy / k, z: c.z }) : c;
}
/**
 * 雙指手勢：start＝手勢開始時的鏡頭；m0／d0＝開始時兩指的中點及距離；m1／d1＝目前的中點及距離。
 * 開始時兩指中點對著的角色位置會一直跟著中點（同時縮放及平移）。
 */
export function pinchCamera(start: Camera, s: Size, m0: [number, number], d0: number, m1: [number, number], d1: number): Camera {
  const t = transform(start, s);
  if (!t.k) return start;
  const [lx, ly] = toLogical(t, m0[0], m0[1]);
  const z = clamp(start.z * (d1 / Math.max(1, d0)), ZOOM.min, ZOOM.max), k = baseScale(s) * z;
  return clampCamera({ x: lx - (m1[0] - s.w / 2) / k, y: ly - (m1[1] - s.h / 2) / k, z });
}
export const sameCamera = (a: Camera, b: Camera) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.z - b.z) < 0.004;
/** 目前的鏡頭是否就是某個取景預設 */
export function presetOf(c: Camera, s: Size): string | null {
  for (const [id, r] of Object.entries(VIEW_PRESETS)) if (sameCamera(c, frame(r, s))) return id;
  return null;
}
/** 一組點的外框（加上留白，邏輯像素） */
export function boundsOf(points: [number, number][], pad = 0): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < x0) return { x: 0, y: 0, w: DOLL_W, h: DOLL_H };
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}
