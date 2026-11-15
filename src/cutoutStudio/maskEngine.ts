/**
 * Cutout Studio 遮罩引擎（純函數，不依賴 DOM，可在 Node 測試及 Web Worker 執行）。
 *
 * 非破壞性原則：
 * - 原始圖片像素（src）永遠不被修改。
 * - 所有擦除、還原、選取套用、邊緣修正都只修改獨立的 alpha 遮罩（Uint8Array，0＝透明、255＝保留、1–254＝半透明）。
 * - 輸出 alpha ＝ 原圖 alpha × 遮罩 alpha ÷ 255，所以「還原」不會令原圖本身透明的部分變成不透明。
 *
 * 本檔不可 import 其他模組（Node 直接載入 .ts 測試）。
 */

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 矩形範圍：x0、y0 包含；x1、y1 不包含 */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

export const EDITOR_VERSION = 1;

export const fullRect = (w: number, h: number): Rect => ({ x0: 0, y0: 0, x1: w, y1: h });
export const emptyRect = (): Rect => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
export const rectEmpty = (r: Rect) => r.x1 <= r.x0 || r.y1 <= r.y0;
export function unionRect(a: Rect, b: Rect): Rect {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
export function clipRect(r: Rect, w: number, h: number): Rect {
  return { x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)), x1: Math.min(w, Math.ceil(r.x1)), y1: Math.min(h, Math.ceil(r.y1)) };
}

// ───────────────────────── 遮罩建立 ─────────────────────────

/** 全部保留的遮罩 */
export const solidMask = (w: number, h: number) => new Uint8Array(w * h).fill(255);

/**
 * 由既有去背圖（processed，與原圖同尺寸）推算遮罩，讓重新編輯時可以從原圖還原之前刪除的區域。
 * 原圖本身半透明的地方：遮罩＝processed alpha ÷ 原圖 alpha（上限 255）；原圖完全透明的地方遮罩設 255（輸出仍然透明）。
 */
export function maskFromProcessed(src: RgbaImage, processed: RgbaImage): Uint8Array {
  if (src.width !== processed.width || src.height !== processed.height) throw new Error("去背圖尺寸與原圖不同，不能轉換成遮罩");
  const n = src.width * src.height;
  const m = new Uint8Array(n);
  const s = src.data, p = processed.data;
  for (let i = 0; i < n; i++) {
    const sa = s[i * 4 + 3], pa = p[i * 4 + 3];
    m[i] = sa === 0 ? 255 : sa === 255 ? pa : Math.min(255, Math.round((pa * 255) / sa));
  }
  return m;
}

/** 由一張「已在 alpha 寫入結果」的圖片（例如 autoCutout 就地修改後的副本）取出遮罩 */
export function maskFromAlpha(img: RgbaImage, original?: RgbaImage): Uint8Array {
  return original ? maskFromProcessed(original, img) : (() => {
    const n = img.width * img.height;
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = img.data[i * 4 + 3];
    return m;
  })();
}

// ───────────────────────── 合成及驗證 ─────────────────────────

/**
 * 原圖＋遮罩 → 輸出像素（只寫入 rect 範圍）。out 長度＝w×h×4。背景預覽不在這裏合成。
 */
export function composite(src: RgbaImage, mask: Uint8Array, out: Uint8ClampedArray, rect?: Rect) {
  const w = src.width;
  const r = rect ? clipRect(rect, w, src.height) : fullRect(w, src.height);
  const s = src.data;
  for (let y = r.y0; y < r.y1; y++) {
    let p = y * w + r.x0;
    for (let x = r.x0; x < r.x1; x++, p++) {
      const i = p * 4;
      out[i] = s[i]; out[i + 1] = s[i + 1]; out[i + 2] = s[i + 2];
      out[i + 3] = (s[i + 3] * mask[p] + 127) / 255;
    }
  }
}

export interface AlphaStats { transparent: number; semi: number; opaque: number; total: number }
export function alphaStats(data: Uint8ClampedArray | Uint8Array): AlphaStats {
  let t = 0, s = 0, o = 0;
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    if (a === 0) t++; else if (a === 255) o++; else s++;
  }
  return { transparent: t, semi: s, opaque: o, total: data.length / 4 };
}

// ───────────────────────── 筆刷 ─────────────────────────

export interface BrushOptions {
  /** 半徑（原圖像素） */
  radius: number;
  /** 硬度 0–1：1＝實心邊，0＝整個筆刷柔化 */
  hardness: number;
  /** 透明度 0–1 */
  opacity: number;
  mode: "erase" | "restore";
}

/**
 * 一筆畫：在筆畫開始時保存 base（遮罩副本）及 coverage 緩衝。
 * 同一筆內重疊的位置只取最大覆蓋，所以低透明度筆刷不會因重複經過而累積成全擦。
 */
export class BrushStroke {
  readonly w: number;
  readonly h: number;
  readonly base: Uint8Array;
  readonly cov: Uint8Array;
  readonly mask: Uint8Array;
  readonly opts: BrushOptions;
  dirty: Rect = emptyRect();
  private lastX = NaN;
  private lastY = NaN;
  private carry = 0;
  constructor(mask: Uint8Array, w: number, h: number, opts: BrushOptions) {
    this.mask = mask; this.w = w; this.h = h; this.opts = { ...opts, radius: Math.max(0.5, opts.radius) };
    this.base = mask.slice();
    this.cov = new Uint8Array(w * h);
  }
  /** 加入一點；與上一點之間按間距插值，拖動多快都不會斷開。回傳這次改動的範圍。 */
  to(x: number, y: number): Rect {
    const r = this.opts.radius;
    const spacing = Math.max(0.5, r * 0.2);
    let changed = emptyRect();
    if (Number.isNaN(this.lastX)) {
      changed = this.stamp(x, y);
    } else {
      const dx = x - this.lastX, dy = y - this.lastY;
      const dist = Math.hypot(dx, dy);
      let t = spacing - this.carry;
      while (t <= dist) {
        const k = t / dist;
        changed = unionRect(changed, this.stamp(this.lastX + dx * k, this.lastY + dy * k));
        t += spacing;
      }
      this.carry = dist - (t - spacing);
    }
    this.lastX = x; this.lastY = y;
    if (!rectEmpty(changed)) this.dirty = unionRect(this.dirty, changed);
    return changed;
  }
  private stamp(cx: number, cy: number): Rect {
    const { radius: r, hardness, opacity, mode } = this.opts;
    const rr = clipRect({ x0: cx - r - 1, y0: cy - r - 1, x1: cx + r + 1, y1: cy + r + 1 }, this.w, this.h);
    if (rectEmpty(rr)) return rr;
    const hard = Math.min(0.999, Math.max(0, hardness));
    const { cov, base, mask, w } = this;
    const op = Math.max(0, Math.min(1, opacity));
    for (let y = rr.y0; y < rr.y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = rr.x0; x < rr.x1; x++) {
        const dx = x + 0.5 - cx;
        const d = Math.sqrt(dx * dx + dy * dy) / r;
        if (d >= 1) continue;
        let c = d <= hard ? 1 : 1 - (d - hard) / (1 - hard);
        c = c * c * (3 - 2 * c); // smoothstep，邊緣柔和
        const v = Math.round(c * op * 255);
        const p = y * w + x;
        if (v <= cov[p]) continue;
        cov[p] = v;
        const b = base[p];
        mask[p] = mode === "erase" ? Math.round((b * (255 - v)) / 255) : Math.round(b + ((255 - b) * v) / 255);
      }
    }
    return rr;
  }
}

// ───────────────────────── 選取 ─────────────────────────

/** 兩個像素的顏色差（RGB 最大差值，並計入 alpha） */
function colorDist(d: Uint8ClampedArray, i: number, r: number, g: number, b: number, a: number) {
  return Math.max(Math.abs(d[i] - r), Math.abs(d[i + 1] - g), Math.abs(d[i + 2] - b), Math.abs(d[i + 3] - a));
}

/**
 * 魔術棒：回傳選取遮罩（0／255）。
 * contiguous＝true：只選取與點擊位置相連的相近顏色（預設，避免衣服內同色位置被選中）。
 * tolerance：0–255 的顏色差。
 */
export function magicWand(src: RgbaImage, x: number, y: number, tolerance: number, contiguous = true): Uint8Array {
  const { data, width: w, height: h } = src;
  const sel = new Uint8Array(w * h);
  x = Math.floor(x); y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return sel;
  const s = (y * w + x) * 4;
  const r = data[s], g = data[s + 1], b = data[s + 2], a = data[s + 3];
  const tol = Math.max(0, Math.min(255, tolerance));
  if (!contiguous) {
    for (let p = 0, i = 0; p < w * h; p++, i += 4) if (colorDist(data, i, r, g, b, a) <= tol) sel[p] = 255;
    return sel;
  }
  const stack = new Int32Array(w * h);
  let sp = 0;
  const start = y * w + x;
  sel[start] = 255; stack[sp++] = start;
  while (sp > 0) {
    const p = stack[--sp];
    const px = p % w;
    // 4 鄰接
    if (px > 0) { const q = p - 1; if (!sel[q] && colorDist(data, q * 4, r, g, b, a) <= tol) { sel[q] = 255; stack[sp++] = q; } }
    if (px < w - 1) { const q = p + 1; if (!sel[q] && colorDist(data, q * 4, r, g, b, a) <= tol) { sel[q] = 255; stack[sp++] = q; } }
    if (p >= w) { const q = p - w; if (!sel[q] && colorDist(data, q * 4, r, g, b, a) <= tol) { sel[q] = 255; stack[sp++] = q; } }
    if (p < w * (h - 1)) { const q = p + w; if (!sel[q] && colorDist(data, q * 4, r, g, b, a) <= tol) { sel[q] = 255; stack[sp++] = q; } }
  }
  return sel;
}

/**
 * 多邊形（自由套索、多邊形套索、矩形共用）→ 選取遮罩。pts 為 [x0,y0,x1,y1,...]（原圖座標），自動閉合。
 * 以像素中心的 even-odd 規則判斷；邊緣做 4× 垂直超取樣，產生平滑（半透明）邊。
 */
export function polygonSelection(w: number, h: number, pts: number[], antialias = true): Uint8Array {
  const sel = new Uint8Array(w * h);
  const n = pts.length >> 1;
  if (n < 3) return sel;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { minY = Math.min(minY, pts[i * 2 + 1]); maxY = Math.max(maxY, pts[i * 2 + 1]); }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h, Math.ceil(maxY) + 1);
  const sub = antialias ? 4 : 1;
  const acc = new Float32Array(w);
  const xs: number[] = [];
  for (let y = y0; y < y1; y++) {
    acc.fill(0);
    let any = false;
    for (let s = 0; s < sub; s++) {
      const sy = y + (s + 0.5) / sub;
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ay = pts[i * 2 + 1], by = pts[j * 2 + 1];
        if ((ay > sy) !== (by > sy)) {
          const ax = pts[i * 2], bx = pts[j * 2];
          xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = xs[k], b = xs[k + 1];
        // 水平方向按覆蓋長度計算（亦是抗鋸齒）
        const xa = Math.max(0, Math.floor(a)), xb = Math.min(w - 1, Math.floor(b));
        for (let x = xa; x <= xb; x++) {
          const cover = Math.min(x + 1, b) - Math.max(x, a);
          if (cover > 0) { acc[x] += antialias ? cover : cover >= 0.5 ? 1 : 0; any = true; }
        }
      }
    }
    if (!any) continue;
    const row = y * w;
    for (let x = 0; x < w; x++) if (acc[x] > 0) sel[row + x] = Math.min(255, Math.round((acc[x] / sub) * 255));
  }
  return sel;
}

export const rectSelection = (w: number, h: number, x0: number, y0: number, x1: number, y1: number) =>
  polygonSelection(w, h, [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), Math.min(x0, x1), Math.max(y0, y1)], false);

export function invertSelection(sel: Uint8Array): Uint8Array {
  const out = new Uint8Array(sel.length);
  for (let i = 0; i < sel.length; i++) out[i] = 255 - sel[i];
  return out;
}

export function selectionBounds(sel: Uint8Array, w: number, h: number): Rect {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) if (sel[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  }
  return x1 < 0 ? { x0: 0, y0: 0, x1: 0, y1: 0 } : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

export type SelectionAction = "keep" | "remove" | "restore";

/**
 * 把選取套用到遮罩（就地修改）。
 * keep：只保留選取範圍，範圍外全部移除；remove：移除選取範圍；restore：從原圖還原選取範圍。
 * 選取邊緣的半透明值會按比例套用，不會把半透明遮罩強制變成 0 或 255。
 */
export function applySelection(mask: Uint8Array, sel: Uint8Array, action: SelectionAction) {
  const n = mask.length;
  if (action === "keep") for (let i = 0; i < n; i++) { const s = sel[i]; if (s !== 255) mask[i] = Math.round((mask[i] * s) / 255); }
  else if (action === "remove") for (let i = 0; i < n; i++) { const s = sel[i]; if (s) mask[i] = Math.round((mask[i] * (255 - s)) / 255); }
  else for (let i = 0; i < n; i++) { const s = sel[i]; if (s) mask[i] = Math.round(mask[i] + ((255 - mask[i]) * s) / 255); }
}

// ───────────────────────── 邊緣修正 ─────────────────────────

/** 1D 盒狀模糊（滑動視窗，O(n)），用於可分離的 2D 模糊 */
function boxBlurH(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number) {
  const win = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = (sum + (win >> 1)) / win;
      const out = src[row + Math.max(0, x - r)];
      const inn = src[row + Math.min(w - 1, x + r + 1)];
      sum += inn - out;
    }
  }
}
function boxBlurV(src: Uint8Array, dst: Uint8Array, w: number, h: number, r: number) {
  const win = r * 2 + 1;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = (sum + (win >> 1)) / win;
      const out = src[Math.max(0, y - r) * w + x];
      const inn = src[Math.min(h - 1, y + r + 1) * w + x];
      sum += inn - out;
    }
  }
}
/** 近似高斯模糊（3 次盒狀模糊） */
export function blurMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const r = Math.max(0, Math.round(radius));
  if (!r) return mask.slice();
  const a = mask.slice(), b = new Uint8Array(mask.length);
  const rs = Math.max(1, Math.round(r / Math.sqrt(3)));
  for (let k = 0; k < 3; k++) { boxBlurH(a, b, w, h, rs); boxBlurV(b, a, w, h, rs); }
  return a;
}

/** van Herk / Gil-Werman 1D 最大／最小值濾波（O(n)，與半徑無關） */
function morph1D(get: (i: number) => number, set: (i: number, v: number) => void, n: number, r: number, isMax: boolean) {
  const win = 2 * r + 1;
  const g = new Uint8Array(n + win), hh = new Uint8Array(n + win);
  const pick = isMax ? (a: number, b: number) => (a > b ? a : b) : (a: number, b: number) => (a < b ? a : b);
  const pad = isMax ? 0 : 255;
  const at = (i: number) => { const j = i - r; return j < 0 || j >= n ? pad : get(j); };
  const len = n + 2 * r;
  for (let start = 0; start < len; start += win) {
    const end = Math.min(len, start + win);
    g[start] = at(start);
    for (let i = start + 1; i < end; i++) g[i] = pick(g[i - 1], at(i));
    hh[end - 1] = at(end - 1);
    for (let i = end - 2; i >= start; i--) hh[i] = pick(hh[i + 1], at(i));
  }
  for (let i = 0; i < n; i++) set(i, pick(hh[i], g[i + win - 1]));
}
/** 擴張（radius>0）或收縮（radius<0）遮罩，方形結構元素 */
export function morphMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const r = Math.round(Math.abs(radius));
  if (!r) return mask.slice();
  const isMax = radius > 0;
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) { const row = y * w; morph1D((i) => mask[row + i], (i, v) => { tmp[row + i] = v; }, w, r, isMax); }
  for (let x = 0; x < w; x++) morph1D((i) => tmp[i * w + x], (i, v) => { out[i * w + x] = v; }, h, r, isMax);
  return out;
}

/** 邊緣平滑：模糊後重新拉回清晰邊，消除鋸齒及小凹凸，不會把整件衣服變模糊 */
export function smoothMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const b = blurMask(mask, w, h, radius);
  for (let i = 0; i < b.length; i++) {
    const orig = mask[i];
    if (orig > 0 && orig < 255 && Math.abs(b[i] - orig) < 24) { b[i] = orig; continue; } // 保留原有半透明（薄紗、蕾絲）
    const v = (b[i] - 64) * 2;
    b[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return b;
}

/** 柔化只作用於邊緣帶：遮罩內部原有的半透明不會被抹平 */
export function featherMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const r = Math.max(0, Math.round(radius));
  if (!r) return mask.slice();
  const blurred = blurMask(mask, w, h, r);
  // 邊緣帶以「有沒有覆蓋」（>0）判斷，內部半透明（薄紗）不算邊緣
  const bin = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) bin[i] = mask[i] ? 255 : 0;
  const lo = morphMask(bin, w, h, -r), hi = morphMask(bin, w, h, r);
  const out = mask.slice();
  for (let i = 0; i < out.length; i++) if (hi[i] !== lo[i]) out[i] = blurred[i];
  return out;
}

/**
 * 白邊／色邊清理：只降低邊緣帶內「接近背景色」像素的遮罩值，不改動原圖顏色。
 * kind="white"：清除灰白邊；kind="color"：取透明區旁邊的原圖顏色作為背景色。
 * 回傳新的遮罩。
 */
export function defringeMask(src: RgbaImage, mask: Uint8Array, width: number, kind: "white" | "color", strength = 1): Uint8Array {
  const { width: w, height: h, data } = src;
  const r = Math.max(1, Math.round(width));
  const out = mask.slice();
  // 邊緣帶：遮罩 >0，而 r 像素內有透明（遮罩 <128）
  const solid = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) solid[i] = mask[i] >= 128 ? 255 : 0;
  const shrunk = morphMask(solid, w, h, -r);
  let br = 0, bg = 0, bb = 0, bn = 0;
  if (kind === "color") {
    // 背景色：與保留區相鄰的透明像素（原圖顏色）
    const grown = morphMask(solid, w, h, r + 1);
    for (let p = 0; p < mask.length; p++) {
      if (grown[p] && !solid[p] && mask[p] < 128) { const i = p * 4; br += data[i]; bg += data[i + 1]; bb += data[i + 2]; bn++; }
    }
    if (!bn) return out;
    br /= bn; bg /= bn; bb /= bn;
  }
  const k = Math.max(0, Math.min(1, strength));
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || shrunk[p]) continue;
    const i = p * 4;
    let f = 0; // 0–1：越像背景越高
    if (kind === "white") {
      const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      const spread = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
      if (spread <= 40 && lum >= 185) f = Math.min(1, (lum - 185) / 50) * (1 - spread / 40);
    } else {
      const d = Math.max(Math.abs(data[i] - br), Math.abs(data[i + 1] - bg), Math.abs(data[i + 2] - bb));
      if (d < 60) f = 1 - d / 60;
    }
    if (f > 0) out[p] = Math.round(mask[p] * (1 - f * k));
  }
  return out;
}

// ───────────────────────── 歷史（Undo／Redo） ─────────────────────────

/** RLE 壓縮遮罩區塊（遮罩多為大片 0／255，壓縮後通常只有幾 KB） */
export function rleEncode(a: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    const v = a[i];
    let run = 1;
    while (i + run < a.length && a[i + run] === v && run < 0x3fffffff) run++;
    // varint
    let n = run;
    while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
    out.push(n, v);
    i += run;
  }
  return Uint8Array.from(out);
}
export function rleDecode(b: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let i = 0, o = 0;
  while (i < b.length && o < length) {
    let n = 0, shift = 0, byte = 0;
    do { byte = b[i++]; n |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    const v = b[i++];
    out.fill(v, o, Math.min(length, o + n));
    o += n;
  }
  return out;
}

export function extractPatch(mask: Uint8Array, w: number, r: Rect): Uint8Array {
  const pw = r.x1 - r.x0, ph = r.y1 - r.y0;
  const out = new Uint8Array(Math.max(0, pw * ph));
  for (let y = 0; y < ph; y++) out.set(mask.subarray((r.y0 + y) * w + r.x0, (r.y0 + y) * w + r.x1), y * pw);
  return out;
}
export function putPatch(mask: Uint8Array, w: number, r: Rect, patch: Uint8Array) {
  const pw = r.x1 - r.x0, ph = r.y1 - r.y0;
  for (let y = 0; y < ph; y++) mask.set(patch.subarray(y * pw, (y + 1) * pw), (r.y0 + y) * w + r.x0);
}

interface HistoryEntry { label: string; rect: Rect; before: Uint8Array; after: Uint8Array; bytes: number }

/**
 * 以「改動範圍＋RLE 壓縮的前後區塊」記錄歷史，不保存完整高清原圖。
 * 超過步數或記憶體預算時丟棄最舊的步驟；目前遮罩永遠不受影響。
 */
export class MaskHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  readonly w: number;
  readonly maxSteps: number;
  readonly maxBytes: number;
  constructor(w: number, maxSteps = 40, maxBytes = 48 * 1024 * 1024) { this.w = w; this.maxSteps = maxSteps; this.maxBytes = maxBytes; }
  /** before＝改動前整份遮罩（或 null 時用 beforePatch），after＝目前遮罩 */
  record(label: string, rect: Rect, beforeFull: Uint8Array, afterFull: Uint8Array) {
    if (rectEmpty(rect)) return;
    const before = rleEncode(extractPatch(beforeFull, this.w, rect));
    const after = rleEncode(extractPatch(afterFull, this.w, rect));
    const e: HistoryEntry = { label, rect, before, after, bytes: before.length + after.length };
    this.undoStack.push(e);
    this.redoStack = [];
    this.trim();
  }
  private trim() {
    let total = this.bytes();
    while (this.undoStack.length > this.maxSteps || (total > this.maxBytes && this.undoStack.length > 1)) {
      total -= this.undoStack.shift()!.bytes;
    }
  }
  bytes() { return [...this.undoStack, ...this.redoStack].reduce((s, e) => s + e.bytes, 0); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get size() { return this.undoStack.length; }
  undo(mask: Uint8Array): Rect | null {
    const e = this.undoStack.pop(); if (!e) return null;
    putPatch(mask, this.w, e.rect, rleDecode(e.before, (e.rect.x1 - e.rect.x0) * (e.rect.y1 - e.rect.y0)));
    this.redoStack.push(e);
    return e.rect;
  }
  redo(mask: Uint8Array): Rect | null {
    const e = this.redoStack.pop(); if (!e) return null;
    putPatch(mask, this.w, e.rect, rleDecode(e.after, (e.rect.x1 - e.rect.x0) * (e.rect.y1 - e.rect.y0)));
    this.undoStack.push(e);
    return e.rect;
  }
  clear() { this.undoStack = []; this.redoStack = []; }
}

/** 兩份遮罩不同的範圍（全圖操作後用來縮小歷史記錄） */
export function diffRect(a: Uint8Array, b: Uint8Array, w: number, h: number): Rect {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) if (a[row + x] !== b[row + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
  }
  return x1 < 0 ? { x0: 0, y0: 0, x1: 0, y1: 0 } : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// ───────────────────────── 尺寸 ─────────────────────────

/** iPhone Safari 單一 canvas 約 16.7 MP 上限；工作室需要原圖、合成圖兩份，超過此值提示可選降解析度 */
export const STUDIO_SAFE_PIXELS = 12_000_000;
export function downscaleSize(w: number, h: number, maxPixels = STUDIO_SAFE_PIXELS) {
  if (w * h <= maxPixels) return { w, h, scale: 1 };
  const s = Math.sqrt(maxPixels / (w * h));
  return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)), scale: s };
}
