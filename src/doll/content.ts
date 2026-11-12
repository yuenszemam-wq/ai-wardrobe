// 量度衣物在圖片內實際佔的範圍（透明邊界框）。只用 D1 縮圖，不讀 R2、不用 AI。
import { Content, FULL_CONTENT } from "../../shared/doll";
import { thumbnailBlob } from "../imageCache";

const cache = new Map<string, Content>();

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
  return { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h, ar: h / w };
}

/** 讀不到縮圖時回傳整張圖（之後仍可人手校正） */
export async function measureContent(imageId: string | null | undefined): Promise<Content> {
  if (!imageId) return FULL_CONTENT();
  const hit = cache.get(imageId);
  if (hit) return hit;
  try {
    const blob = await thumbnailBlob(imageId);
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const content = contentFromPixels(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      cache.set(imageId, content);
      return content;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return FULL_CONTENT();
  }
}
