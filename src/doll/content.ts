// 圖片讀取及分析：衣物高清透明圖、角色素材。量度與顯示使用同一張圖，座標一致。
import { Content, FULL_CONTENT } from "../../shared/doll";
import { ImageRef, refUrl } from "../../shared/avatarV2";
import { highResolutionBlob, thumbnailBlob } from "../imageCache";

export type Bitmap = HTMLImageElement | HTMLCanvasElement;
/** 低解像度的透明度格（用來判斷袖長、點選等） */
export interface AlphaGrid { w: number; h: number; data: Uint8Array }
export interface Analysis { content: Content; grid: AlphaGrid; width: number; height: number }

const images = new Map<string, Promise<HTMLImageElement>>();
const analyses = new Map<string, Promise<Analysis>>();
const sizes = new Map<string, number>();
let epoch = 0;
function clear() { epoch++; images.clear(); analyses.clear(); sizes.clear(); }
if (typeof window !== "undefined") {
  window.addEventListener("aw:unauthorized", clear);
  window.addEventListener("aw:refresh-images", clear);
}

async function decode(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    throw new Error("圖片解碼失敗");
  } finally {
    // 解碼後的圖片不再需要 blob URL（已保留在 img 內）
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/** 讀取一張圖（高清）。衣物圖有上限的記憶體快取；靜態及素材檔由瀏覽器 HTTP 快取負責。 */
export function loadImage(ref: ImageRef): Promise<HTMLImageElement> {
  const hit = images.get(ref);
  if (hit) return hit;
  const at = epoch;
  const p = (async () => {
    if (ref.startsWith("/") || ref.startsWith("data:") || ref.startsWith("blob:")) {
      // 內置靜態素材及遮罩：直接由瀏覽器讀取及快取
      const img = new Image();
      img.src = ref;
      await img.decode();
      return img;
    }
    const blob = await highResolutionBlob(refUrl(ref));
    if (at === epoch && ref.startsWith("img:")) {
      sizes.set(ref, blob.size);
      let total = [...sizes.values()].reduce((a, b) => a + b, 0);
      for (const [key, size] of sizes) {
        if (sizes.size <= 24 && total <= 48 * 1024 * 1024) break;
        if (key === ref) continue;
        images.delete(key); sizes.delete(key); total -= size;
      }
    }
    return decode(blob);
  })();
  images.set(ref, p);
  p.catch(() => { if (images.get(ref) === p) images.delete(ref); });
  return p;
}

export function contentFromPixels(data: Uint8ClampedArray | Uint8Array, w: number, h: number, threshold = 24): Content {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return FULL_CONTENT(h / w);
  const result: Content = { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h, ar: h / w };
  const row = Math.min(y1, y0 + Math.round((y1 - y0) * 0.07));
  let lo = w, hi = -1, count = 0;
  for (let x = x0; x <= x1; x++) if (data[(row * w + x) * 4 + 3] > threshold) { lo = Math.min(lo, x); hi = Math.max(hi, x); count++; }
  if (hi > lo && count / (hi - lo + 1) > 0.8 && (hi - lo + 1) / (x1 - x0 + 1) > 0.18) result.waistBand = { x0: lo / w, x1: (hi + 1) / w };
  return result;
}

export function pixelsOf(img: CanvasImageSource, w: number, h: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}
function analyzeImage(img: HTMLImageElement): Analysis {
  const factor = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * factor)), h = Math.max(1, Math.round(img.naturalHeight * factor));
  const px = pixelsOf(img, w, h).data;
  // 透明度格取每格的平均值（不是單點取樣）：蕾絲的小孔不會被當成空隙，袖子與衣身之間的窄縫仍然看得見
  const gw = Math.min(192, w), gh = Math.max(1, Math.round((gw * h) / w));
  const grid = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const ya = Math.floor((y * h) / gh), yb = Math.max(ya + 1, Math.floor(((y + 1) * h) / gh));
    for (let x = 0; x < gw; x++) {
      const xa = Math.floor((x * w) / gw), xb = Math.max(xa + 1, Math.floor(((x + 1) * w) / gw));
      let sum = 0;
      for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) sum += px[(yy * w + xx) * 4 + 3];
      grid[y * gw + x] = Math.round(sum / ((yb - ya) * (xb - xa)));
    }
  }
  return { content: { ...contentFromPixels(px, w, h), ar: img.naturalHeight / img.naturalWidth }, grid: { w: gw, h: gh, data: grid }, width: img.naturalWidth, height: img.naturalHeight };
}
const EMPTY_GRID: AlphaGrid = { w: 1, h: 1, data: new Uint8Array([255]) };

/** 量度衣物實際內容（高清圖）。讀不到高清圖時退回縮圖並標記 approximate：不可存為衣物預設。 */
export function analyze(ref: ImageRef | null | undefined): Promise<Analysis> {
  if (!ref) return Promise.resolve({ content: { ...FULL_CONTENT(), approximate: true }, grid: EMPTY_GRID, width: 3, height: 4 });
  const hit = analyses.get(ref);
  if (hit) return hit;
  const p = (async () => {
    try {
      return analyzeImage(await loadImage(ref));
    } catch (e) {
      analyses.delete(ref);
      if (ref.startsWith("img:")) {
        try {
          const a = analyzeImage(await decode(await thumbnailBlob(ref.slice(4))));
          return { ...a, content: { ...a.content, approximate: true } };
        } catch { /* fall through */ }
      }
      return { content: { ...FULL_CONTENT(), approximate: true }, grid: EMPTY_GRID, width: 3, height: 4 };
    }
  })();
  analyses.set(ref, p);
  if (analyses.size > 300) analyses.delete(analyses.keys().next().value!);
  return p;
}

/** 圖片內某一點（0–1）是否有內容 */
export const alphaAt = (g: AlphaGrid, u: number, v: number) => (u < 0 || v < 0 || u >= 1 || v >= 1 ? 0 : g.data[Math.floor(v * g.h) * g.w + Math.floor(u * g.w)]);

const canvasBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("圖片輸出失敗"))), type, q));
export { canvasBlob };

export interface PreparedAsset { blob: Blob; width: number; height: number; thumb: Blob; /** 內容在原圖內的位置（0–1），用作初始對位 */ box: { x0: number; y0: number; x1: number; y1: number }; sourceW: number; sourceH: number }
/**
 * 準備上傳的角色素材：清除 AI 生成圖常見的半透明霧化雜點、裁走四周留白、限制最長邊，輸出 PNG。
 * 使用者手機內的原檔不會被修改。
 */
export async function prepareAsset(file: Blob, maxSide = 1600): Promise<PreparedAsset> {
  const img = await decode(file);
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) throw new Error("讀不到這張圖片");
  if (W * H > 40_000_000) throw new Error("圖片太大（超過 4000 萬像素）");
  const data = pixelsOf(img, W, H);
  const px = data.data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1, clear = 0;
  for (let y = 0, i = 3; y < H; y++) {
    for (let x = 0; x < W; x++, i += 4) {
      if (px[i] < 28) { px[i] = 0; clear++; continue; }
      if (px[i] > 240) px[i] = 255;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error("這張圖片是全透明的");
  if (clear < W * H * 0.02) throw new Error("這張圖片沒有透明背景，請先去背");
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const src = document.createElement("canvas");
  src.width = W; src.height = H;
  src.getContext("2d")!.putImageData(data, 0, 0);
  const scale = Math.min(1, maxSide / Math.max(cw, ch));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cw * scale)); out.height = Math.max(1, Math.round(ch * scale));
  const octx = out.getContext("2d")!;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(src, x0, y0, cw, ch, 0, 0, out.width, out.height);
  const t = document.createElement("canvas");
  const ts = Math.min(1, 150 / Math.max(out.width, out.height));
  t.width = Math.max(1, Math.round(out.width * ts)); t.height = Math.max(1, Math.round(out.height * ts));
  const tctx = t.getContext("2d")!;
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(out, 0, 0, t.width, t.height);
  return { blob: await canvasBlob(out, "image/png"), width: out.width, height: out.height, thumb: await canvasBlob(t, "image/png"), box: { x0: x0 / W, y0: y0 / H, x1: (x1 + 1) / W, y1: (y1 + 1) / H }, sourceW: W, sourceH: H };
}
