/**
 * 瀏覽器端圖片處理：
 * - PNG / JPEG / WebP 原檔照傳，不壓縮、不縮小。
 * - HEIC 等其他格式在瀏覽器解碼後，以原尺寸轉成高質素 JPEG（透明圖轉 PNG）。
 * - 另外產生 480px WebP 縮圖（保留透明），與高清圖分開上傳。
 */

const PASS_THROUGH = new Set(["image/png", "image/jpeg", "image/webp"]);
export const THUMB_MAX = 480;

export interface PreparedImage {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  converted: boolean;
}

async function sniff(file: Blob): Promise<string> {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return file.type || "application/octet-stream";
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    } catch {
      /* 有些格式（如 Safari 的 HEIC）要經 <img> 解碼 */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function dims(src: ImageBitmap | HTMLImageElement) {
  return src instanceof HTMLImageElement ? { w: src.naturalWidth, h: src.naturalHeight } : { w: src.width, h: src.height };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("無法轉換圖片"))), type, quality),
  );
}

export async function prepareForUpload(file: File): Promise<PreparedImage> {
  const type = await sniff(file);
  const base = file.name.replace(/\.[^.]+$/, "") || "image";
  if (PASS_THROUGH.has(type)) {
    const src = await decode(file);
    const { w, h } = dims(src);
    if ("close" in src) src.close();
    return { blob: file, filename: file.name, width: w, height: h, converted: false };
  }
  // 其他格式（多數是 iPhone HEIC）：以原尺寸轉換
  const src = await decode(file);
  const { w, h } = dims(src);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(src, 0, 0);
  if ("close" in src) src.close();
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.95);
  return { blob, filename: `${base}.jpg`, width: w, height: h, converted: true };
}

export async function makeThumbnail(file: Blob): Promise<Blob> {
  const src = await decode(file);
  const { w, h } = dims(src);
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  if ("close" in src) src.close();
  try {
    const webp = await canvasToBlob(canvas, "image/webp", 0.85);
    if (webp.type === "image/webp") return webp;
  } catch {
    /* 舊版 Safari 不支援 WebP 編碼 */
  }
  return canvasToBlob(canvas, "image/png");
}

/** 檢查圖片是否含透明像素（抽樣） */
export async function hasTransparency(file: Blob): Promise<boolean> {
  const src = await decode(file);
  const { w, h } = dims(src);
  const scale = Math.min(1, 200 / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  if ("close" in src) src.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

/** 產生穩定的檔案鍵，避免同一張相重複提交 */
export async function fileKey(file: Blob & { name?: string; lastModified?: number }): Promise<string> {
  const head = await file.slice(0, 256 * 1024).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", head);
  const hex = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}-${file.size}`;
}

// ───────────── V2 批量上傳：原檔原樣上傳，瀏覽器另外產生縮圖／辨認圖／HEIC 預覽 ─────────────

export const ANALYSIS_MAX = 1600;

export interface IntakePrepared {
  original: Blob; // 原檔，不作任何改動
  filename: string;
  sha256: string;
  mime: string;
  width: number;
  height: number;
  isHeif: boolean;
  preview: Blob | null; // HEIC 的原尺寸 JPEG 預覽
  thumbnail: Blob | null; // 480px
  analysis: Blob | null; // 約 1600px，給 AI 辨認
  warning?: string;
}

async function sniffType(file: Blob): Promise<string> {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(4, 4) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|heif)/.test(ascii(8, 4))) return "image/heic";
  return file.type || "application/octet-stream";
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function scaled(src: ImageBitmap | HTMLImageElement, max: number, alpha: boolean): Promise<Blob> {
  const { w, h } = dims(src);
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  try {
    const webp = await canvasToBlob(canvas, "image/webp", 0.86);
    if (webp.type === "image/webp") return webp;
  } catch {
    /* 舊版 Safari 不支援 WebP 編碼 */
  }
  return alpha ? canvasToBlob(canvas, "image/png") : canvasToBlob(canvas, "image/jpeg", 0.88);
}

function alphaOf(src: ImageBitmap | HTMLImageElement): boolean {
  const { w, h } = dims(src);
  const s = Math.min(1, 160 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}

/** 準備一張相：計算原檔 SHA-256、解碼一次產生縮圖及辨認圖；HEIC 另產生原尺寸 JPEG 預覽 */
export async function prepareIntake(file: File): Promise<IntakePrepared> {
  const mime = await sniffType(file);
  const isHeif = mime === "image/heic";
  const sha = await sha256Hex(file);
  let src: ImageBitmap | HTMLImageElement;
  try {
    src = await decode(file);
  } catch {
    // 例如 Windows Chrome 不能解碼 HEIC：原檔照傳，由伺服器保存
    return { original: file, filename: file.name, sha256: sha, mime, width: 0, height: 0, isHeif, preview: null, thumbnail: null, analysis: null, warning: "此瀏覽器未能預覽這張相，原檔仍會保存" };
  }
  const { w, h } = dims(src);
  try {
    const alpha = mime === "image/png" || mime === "image/webp" ? alphaOf(src) : false;
    let preview: Blob | null = null;
    if (isHeif) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d")!.drawImage(src, 0, 0);
      preview = await canvasToBlob(canvas, "image/jpeg", 0.92);
      canvas.width = canvas.height = 0; // 釋放記憶體
    }
    const thumbnail = await scaled(src, THUMB_MAX, alpha);
    const analysis = Math.max(w, h) > THUMB_MAX ? await scaled(src, ANALYSIS_MAX, alpha) : null;
    return { original: file, filename: file.name, sha256: sha, mime, width: w, height: h, isHeif, preview, thumbnail, analysis };
  } finally {
    if ("close" in src) src.close();
  }
}
