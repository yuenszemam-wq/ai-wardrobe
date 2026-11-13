// 套裝拆件（前端）：由原圖及選取遮罩製作部件圖片；自動找出原圖內互相分開的部件。
// 原圖永遠不會被修改：部件圖只在瀏覽器記憶體中產生（blob URL），需要時重新製作。
import { Piece, Slot } from "../../shared/doll";
import { loadImage } from "./content";

/** 選取遮罩：覆蓋整張原圖的低解像度格（0–255） */
export interface MaskBuf { w: number; h: number; data: Uint8Array }
export const MASK_LONG = 480;
export function maskSize(imgW: number, imgH: number): { w: number; h: number } {
  const k = Math.min(1, MASK_LONG / Math.max(imgW, imgH));
  return { w: Math.max(8, Math.round(imgW * k)), h: Math.max(8, Math.round(imgH * k)) };
}
export const emptyMask = (w: number, h: number): MaskBuf => ({ w, h, data: new Uint8Array(w * h) });
export function maskToDataURL(m: MaskBuf): string {
  const c = document.createElement("canvas");
  c.width = m.w; c.height = m.h;
  const d = new ImageData(m.w, m.h);
  for (let i = 0; i < m.data.length; i++) { d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = 255; d.data[i * 4 + 3] = m.data[i]; }
  c.getContext("2d")!.putImageData(d, 0, 0);
  return c.toDataURL("image/png");
}
export async function maskFromDataURL(url: string, w: number, h: number): Promise<MaskBuf> {
  const img = await loadImage(url);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data, m = emptyMask(w, h);
  for (let i = 0; i < m.data.length; i++) m.data[i] = px[i * 4 + 3];
  return m;
}
/** 遮罩內有選取的範圍（0–1）；沒有選取回傳 null */
export function maskBox(m: MaskBuf, pad = 1): Piece["box"] | null {
  let x0 = m.w, y0 = m.h, x1 = -1, y1 = -1;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.data[y * m.w + x] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const r = (v: number) => Math.round(v * 10000) / 10000;
  return [r(Math.max(0, x0 - pad) / m.w), r(Math.max(0, y0 - pad) / m.h), r(Math.min(m.w, x1 + 1 + pad) / m.w), r(Math.min(m.h, y1 + 1 + pad) / m.h)];
}
/** 原圖的 alpha（遮罩解像度） */
export async function alphaOf(srcRef: string): Promise<{ img: HTMLImageElement; alpha: MaskBuf }> {
  const img = await loadImage(srcRef);
  const { w, h } = maskSize(img.naturalWidth, img.naturalHeight);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data, a = emptyMask(w, h);
  for (let i = 0; i < a.data.length; i++) a.data[i] = px[i * 4 + 3];
  return { img, alpha: a };
}

export interface Component { mask: MaskBuf; box: Piece["box"]; area: number; cx: number; cy: number }
/**
 * 自動找出原圖內互相分開的部件（透明位置分隔的連通區域）。
 * 先把布料稍為擴張（蕾絲的小孔、細小縫隙不會把同一件拆開），太細小的碎片忽略。
 */
export function findComponents(alpha: MaskBuf, minShare = 0.004): Component[] {
  const { w, h } = alpha, n = w * h;
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = alpha.data[i] > 40 ? 1 : 0;
  const grow = (src: Uint8Array) => { const out = new Uint8Array(n); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (src[i] || (x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) || (y > 0 && src[i - w]) || (y < h - 1 && src[i + w])) out[i] = 1; } return out; };
  let g = solid;
  g = grow(g);
  const label = new Int32Array(n).fill(-1), stack: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) total += solid[i];
  const comps: Component[] = [];
  for (let i = 0; i < n; i++) {
    if (!g[i] || label[i] >= 0) continue;
    const id = comps.length, m = emptyMask(w, h);
    let area = 0, sx = 0, sy = 0;
    label[i] = id; stack.push(i);
    while (stack.length) {
      const j = stack.pop()!, x = j % w, y = (j - x) / w;
      if (solid[j]) { m.data[j] = alpha.data[j] > 0 ? 255 : 0; area++; sx += x; sy += y; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (g[k] && label[k] < 0) { label[k] = id; stack.push(k); }
      }
    }
    // 選取範圍也包含擴張的邊緣（半透明的毛邊、蕾絲邊）
    for (let j = 0; j < n; j++) if (label[j] === id && alpha.data[j] > 0) m.data[j] = 255;
    const box = maskBox(m);
    if (box && area >= total * minShare) comps.push({ mask: m, box, area, cx: sx / area / w, cy: sy / area / h });
  }
  return comps.sort((a, b) => b.area - a.area);
}
/** 按位置及形狀估計部件的名稱及分類 */
export function guessPiece(c: Component, all: Component[]): { name: string; slot: Slot } {
  const [x0, y0, x1, y1] = c.box, bw = x1 - x0, bh = y1 - y0;
  if (c === all[0]) return { name: "主體", slot: "dress" };
  const main = all[0].box;
  if (y1 <= main[1] + 0.04 && c.cy < 0.3) {
    // 主體上方的部件：最接近主體、扁而窄的是頸飾；較高位置的是頭飾
    const tops = all.filter((o) => o !== all[0] && o.box[3] <= main[1] + 0.04 && o.cy < 0.3);
    const lowest = tops.reduce((a, b) => (b.cy > a.cy ? b : a), tops[0]);
    if (tops.length > 1 && c === lowest && bw < 0.35 && bh < 0.12) return { name: "頸飾", slot: "accessory" };
    if (tops.length === 1 && bh < 0.07 && bw < 0.3 && main[1] - y1 < 0.06) return { name: "頸飾", slot: "accessory" };
    return { name: "頭飾", slot: "headwear" };
  }
  if (bh > bw * 1.6 && (c.cx < main[0] + 0.08 || c.cx > main[2] - 0.08)) return { name: c.cx < 0.5 ? "右袖套（畫面左）" : "左袖套（畫面右）", slot: "accessory" };
  if (c.cy > 0.8) return { name: c.cx < 0.5 ? "右鞋／襪" : "左鞋／襪", slot: "shoes" };
  return { name: "配件", slot: "accessory" };
}

const built = new Map<string, Promise<string>>();
let seq = 0;
/** 部件的內容雜湊（遮罩或範圍改變時重新製作圖片） */
export function pieceKey(srcRef: string, p: Piece, all: Piece[]): string {
  const sum = (s: string | null | undefined) => { if (!s) return "0"; let h = 0; for (let i = 0; i < s.length; i += 7) h = (h * 31 + s.charCodeAt(i)) | 0; return s.length + ":" + h; };
  const rest = p.rest ? all.filter((q) => q.id !== p.id).map((q) => q.id + sum(q.mask) + (q.file ?? "")).join(",") : "";
  return [srcRef, p.id, p.box.join(","), sum(p.mask), p.file ?? "", rest].join("|");
}
/**
 * 部件圖片：上傳的透明圖直接使用；否則由原圖裁出範圍並套用選取遮罩（「其餘部分」＝減去其他部件）。
 * 回傳圖片參照（blob URL 或原本的參照）。
 */
export function pieceImage(srcRef: string, p: Piece, all: Piece[]): Promise<string> {
  if (p.file) return Promise.resolve(p.file);
  const key = pieceKey(srcRef, p, all);
  const hit = built.get(key);
  if (hit) return hit;
  const job = (async () => {
    const img = await loadImage(srcRef);
    const W = img.naturalWidth, H = img.naturalHeight;
    const [u0, v0, u1, v1] = p.box;
    const x = Math.floor(u0 * W), y = Math.floor(v0 * H), w = Math.max(1, Math.ceil(u1 * W) - x), h = Math.max(1, Math.ceil(v1 * H) - y);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h), px = d.data;
    const { w: mw, h: mh } = maskSize(W, H);
    const keep = p.mask ? await maskFromDataURL(p.mask, mw, mh) : null;
    const others = p.rest ? await Promise.all(all.filter((q) => q.id !== p.id && q.mask && !q.rest).map((q) => maskFromDataURL(q.mask!, mw, mh))) : [];
    for (let j = 0; j < h; j++) {
      const my = Math.min(mh - 1, Math.floor(((y + j + 0.5) / H) * mh));
      for (let i = 0; i < w; i++) {
        const k = (j * w + i) * 4 + 3;
        if (!px[k]) continue;
        const mx = Math.min(mw - 1, Math.floor(((x + i + 0.5) / W) * mw)), mi = my * mw + mx;
        let a = keep ? keep.data[mi] / 255 : 1;
        for (const o of others) a *= 1 - o.data[mi] / 255;
        if (a < 0.999) px[k] = Math.round(px[k] * a);
      }
    }
    ctx.putImageData(d, 0, 0);
    const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("未能製作部件圖片"))), "image/png"));
    c.width = c.height = 0;
    seq++;
    return URL.createObjectURL(blob);
  })();
  built.set(key, job);
  job.catch(() => built.delete(key));
  return job;
}
export const newPieceId = () => "pc_" + Math.random().toString(36).slice(2, 10);
