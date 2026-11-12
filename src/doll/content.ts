// Measure canonical HD alpha in the same coordinate system as rendering.
import { Content, FULL_CONTENT } from "../../shared/doll";
import { highResolutionBlob, thumbnailBlob } from "../imageCache";
import { imageUrl } from "../api";

const cache = new Map<string, Content>();
const hd = new Map<string, Promise<Blob>>();
let epoch = 0;
function clear() { epoch++; cache.clear(); hd.clear(); sizes.clear(); }
if (typeof window !== "undefined") {
  window.addEventListener("aw:unauthorized", clear);
  window.addEventListener("aw:refresh-images", clear);
}
// Shared, bounded by compressed bytes and entry count. Image IDs are immutable in storeImage.
const sizes = new Map<string, number>();
export function canonicalDollBlob(id: string): Promise<Blob> {
  const hit = hd.get(id);
  if (hit) return hit;
  const currentEpoch = epoch;
  const p = highResolutionBlob(imageUrl(id));
  hd.set(id, p);
  p.then((blob) => {
    if (currentEpoch !== epoch || hd.get(id) !== p) return;
    sizes.set(id, blob.size);
    let total = [...sizes.values()].reduce((a, b) => a + b, 0);
    for (const [key, size] of sizes) {
      if (sizes.size <= 12 && total <= 24 * 1024 * 1024) break;
      if (key === id && sizes.size === 1) { hd.delete(key); sizes.delete(key); break; }
      hd.delete(key); sizes.delete(key); total -= size;
    }
  }).catch(() => { if (hd.get(id) === p) hd.delete(id); });
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

async function measureBlob(blob: Blob): Promise<Content> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    const factor = Math.min(1, 700 / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.max(1, Math.round(img.naturalWidth * factor));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * factor));
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { ...contentFromPixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height), ar: img.naturalHeight / img.naturalWidth };
  } finally { URL.revokeObjectURL(url); }
}
/** Only worn garments read HD. Thumbnails remain the picker source. Never save fallback fit as a canonical template. */
export async function measureContent(imageId: string | null | undefined): Promise<Content> {
  if (!imageId) return { ...FULL_CONTENT(), approximate: true };
  const hit = cache.get(imageId);
  if (hit) return hit;
  const startEpoch = epoch;
  try {
    const content = await measureBlob(await canonicalDollBlob(imageId));
    if (startEpoch === epoch) {
      cache.set(imageId, content);
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
    }
    return content;
  } catch {
    try { return { ...await measureBlob(await thumbnailBlob(imageId)), approximate: true }; }
    catch { return { ...FULL_CONTENT(), approximate: true }; }
  }
}
