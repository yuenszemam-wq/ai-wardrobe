/**
 * Cutout Studio 載入及儲存。
 * - 載入：永遠回到真正原圖（同一衣物的 derived_from，或 cutout_edits 記錄的跨衣物來源）；既有去背圖轉換成遮罩。
 * - 儲存：原圖不變；輸出真正透明 PNG（無損）→ 驗證 alpha → 上傳私人 R2（現有 /api/images/upload）→ 縮圖 → 記錄來源關聯。
 * - 不把 Base64 存入 D1；遮罩不另存（由去背圖 alpha 還原）。
 */
import { api, Garment, GarmentImage, imageUrl, uploadImage } from "../api";
import { highResolutionBlob } from "../imageCache";
import { decode, makeThumbnail } from "../imageProcessing";
import { EDITOR_VERSION, RgbaImage, STUDIO_SAFE_PIXELS, alphaStats, composite, downscaleSize, maskFromProcessed, solidMask } from "./maskEngine";

export interface StudioSource {
  /** 原圖（或沒有原圖時的起點圖片）在 garment_images 的 id */
  imageId: string;
  /** 原圖所屬衣物（跨衣物拆件時與目前衣物不同） */
  garmentId: string | null;
  image: RgbaImage;
  /** 原圖原始尺寸（降解析度處理時 image 會較小） */
  naturalWidth: number;
  naturalHeight: number;
  /** 起始遮罩 */
  mask: Uint8Array;
  /** 起始說明（例如「從既有去背圖繼續編輯」） */
  note: string;
  /** 原圖本身已有真正透明像素 */
  sourceHasAlpha: boolean;
}

export interface CutoutEditRecord { source_image_id: string | null; source_garment_id: string | null; source_intact: boolean }

export async function fetchCutoutEdit(imageId: string): Promise<CutoutEditRecord | null> {
  try { return (await api<{ edit: CutoutEditRecord | null }>(`/api/cutout-edits/${imageId}`)).edit; } catch { return null; }
}

/** 解碼成 RGBA（套用 EXIF 方向）。maxPixels 有值時按比例縮小。 */
export async function decodeRgba(blob: Blob, maxPixels?: number): Promise<{ image: RgbaImage; naturalWidth: number; naturalHeight: number }> {
  const src = await decode(blob);
  try {
    const nw = "naturalWidth" in src ? src.naturalWidth : src.width;
    const nh = "naturalHeight" in src ? src.naturalHeight : src.height;
    const t = maxPixels ? downscaleSize(nw, nh, maxPixels) : { w: nw, h: nh };
    const c = document.createElement("canvas");
    c.width = t.w; c.height = t.h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src as CanvasImageSource, 0, 0, t.w, t.h);
    const d = ctx.getImageData(0, 0, t.w, t.h);
    c.width = c.height = 0;
    return { image: { data: d.data, width: t.w, height: t.h }, naturalWidth: nw, naturalHeight: nh };
  } finally {
    if ("close" in src) src.close();
  }
}

/** 讀取圖片尺寸（不解碼像素），用來判斷是否超過安全尺寸 */
export function needsDownscale(img: GarmentImage) { return img.width * img.height > STUDIO_SAFE_PIXELS; }

/** 找出真正原圖：processed 圖先看 cutout_edits，再看 derived_from */
export async function resolveSource(g: Garment, start: GarmentImage): Promise<{ source: { id: string; garmentId: string | null; width: number; height: number }; fromProcessed: GarmentImage | null }> {
  if (start.image_type !== "processed") return { source: { id: start.id, garmentId: g.id, width: start.width, height: start.height }, fromProcessed: null };
  const edit = await fetchCutoutEdit(start.id);
  if (edit?.source_image_id && edit.source_intact) return { source: { id: edit.source_image_id, garmentId: edit.source_garment_id, width: start.width, height: start.height }, fromProcessed: start };
  const parent = start.derived_from ? (g.images || []).find((i) => i.id === start.derived_from && i.image_type === "original") : null;
  if (parent) return { source: { id: parent.id, garmentId: g.id, width: parent.width, height: parent.height }, fromProcessed: start };
  return { source: { id: start.id, garmentId: g.id, width: start.width, height: start.height }, fromProcessed: null };
}

export async function loadStudioSource(g: Garment, start: GarmentImage, opts: { downscale?: boolean; signal?: AbortSignal } = {}): Promise<StudioSource> {
  const { source, fromProcessed } = await resolveSource(g, start);
  const max = opts.downscale ? STUDIO_SAFE_PIXELS : undefined;
  const srcBlob = await highResolutionBlob(imageUrl(source.id), { signal: opts.signal });
  const dec = await decodeRgba(srcBlob, max);
  const st = alphaStats(dec.image.data);
  const sourceHasAlpha = st.transparent + st.semi > st.total * 0.002;
  let mask: Uint8Array = solidMask(dec.image.width, dec.image.height);
  let note = start.image_type === "processed" && !fromProcessed ? "找不到這張去背圖的原圖，只能在現有去背圖上編輯（不能還原已刪除的部分）" : sourceHasAlpha ? "原圖已有真正透明背景，已保留現有透明度" : "從原圖開始";
  if (fromProcessed) {
    const p = await decodeRgba(await highResolutionBlob(imageUrl(fromProcessed.id), { signal: opts.signal }), max);
    if (p.image.width === dec.image.width && p.image.height === dec.image.height) {
      mask = maskFromProcessed(dec.image, p.image);
      note = "從既有去背圖繼續編輯；還原筆刷可從原圖恢復之前刪除的部分";
    } else {
      note = "既有去背圖與原圖尺寸不同，已從原圖重新開始";
    }
  }
  return { imageId: source.id, garmentId: source.garmentId, image: dec.image, naturalWidth: dec.naturalWidth, naturalHeight: dec.naturalHeight, mask, note, sourceHasAlpha };
}

const canvasBlob = (c: HTMLCanvasElement, type: string) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("未能輸出圖片（可能是記憶體不足）"))), type));

export interface Rendered { blob: Blob; width: number; height: number; transparent: number; semi: number }

/** 原圖＋遮罩 → 原解析度透明 PNG（背景預覽不會寫入） */
export async function renderCutout(src: RgbaImage, mask: Uint8Array): Promise<Rendered> {
  const out = new Uint8ClampedArray(src.width * src.height * 4);
  composite(src, mask, out);
  const st = alphaStats(out);
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  c.getContext("2d")!.putImageData(new ImageData(out, src.width, src.height), 0, 0);
  try {
    const blob = await canvasBlob(c, "image/png");
    return { blob, width: src.width, height: src.height, transparent: st.transparent, semi: st.semi };
  } finally { c.width = c.height = 0; }
}

/** 驗證輸出真的有透明像素 */
export function verifyAlpha(r: Rendered): string | null {
  if (r.transparent + r.semi === 0) return "輸出圖片沒有任何透明像素，請先移除背景再保存";
  if (r.blob.type !== "image/png") return "此瀏覽器未能輸出 PNG";
  return null;
}

export interface SaveSummary { tools: string[]; steps: number; downscaled: boolean }

async function uploadProcessed(garmentId: string, r: Rendered, opts: { derivedFrom?: string | null; primary: boolean; sourceId: string; summary: SaveSummary }) {
  const fields: Record<string, string> = { garment_id: garmentId, image_type: "processed" };
  if (opts.derivedFrom) fields.derived_from = opts.derivedFrom;
  if (opts.primary) fields.is_primary = "1";
  const res = await uploadImage("/api/images/upload", fields, r.blob, "cutout.png");
  let thumbOk = true;
  try {
    const thumb = await makeThumbnail(r.blob);
    await uploadImage("/api/images/upload", { garment_id: garmentId, image_type: "thumbnail", derived_from: res.id }, thumb, "thumb.webp");
  } catch { thumbOk = false; /* 縮圖之後由背景工作補建 */ }
  let note: string | undefined;
  try {
    const rec = await api<{ recorded: boolean; note?: string }>("/api/cutout-edits", { method: "POST", json: { image_id: res.id, source_image_id: opts.sourceId, mask_width: r.width, mask_height: r.height, editor_version: EDITOR_VERSION, edit_summary: opts.summary } });
    if (!rec.recorded) note = rec.note;
  } catch (e) { note = `來源關聯未記錄：${(e as Error).message}`; }
  return { id: res.id, deduplicated: res.deduplicated, warnings: res.warnings, thumbOk, note };
}

/** 儲存為目前衣物的去背圖 */
export function saveToGarment(g: Garment, src: StudioSource, r: Rendered, primary: boolean, summary: SaveSummary) {
  return uploadProcessed(g.id, r, { derivedFrom: src.garmentId === g.id ? src.imageId : null, primary, sourceId: src.imageId, summary });
}

/** 另存為新衣物（待整理）：只上傳新的去背圖；原圖不重複儲存，以 cutout_edits 參照原本的原圖 */
export async function saveAsNewGarment(name: string, src: StudioSource, r: Rendered, summary: SaveSummary) {
  const created = await api<Garment>("/api/garments", { method: "POST", json: { name, needs_review: true } });
  const up = await uploadProcessed(created.id, r, { derivedFrom: null, primary: true, sourceId: src.imageId, summary });
  return { garmentId: created.id, ...up };
}

/** 另存為換裝素材（創作工作室素材庫），保持原解析度 PNG */
export async function saveAsStudioAsset(name: string, r: Rendered) {
  const { uploadStudioAsset } = await import("../studio/assets");
  const thumb = await makeThumbnail(r.blob);
  return uploadStudioAsset({ blob: r.blob, thumb, width: r.width, height: r.height, hasAlpha: true, preview: "" }, { kind: "accessory", name, inLibrary: true });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
