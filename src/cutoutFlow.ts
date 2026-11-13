/**
 * Phase 3.8 手動去背流程（單件及批量共用）。
 * 原圖永遠保留；去背成功並由使用者確認後，才上傳透明 PNG（processed，derived_from＝原圖）。
 * 失敗時不改動現有主圖。
 */
import { api, Garment, GarmentImage, imageUrl, uploadImage } from "./api";
import { highResolutionBlob } from "./imageCache";
import { makeThumbnail, manualCutout } from "./imageProcessing";

export type CutoutResult = { ok: true; blob: Blob; url: string; kind: string } | { ok: false; note: string; transparent?: boolean };

/** 選擇要去背的圖片：目前顯示的圖片；沒有指定時用原相主圖或第一張原相 */
export function cutoutSource(g: Garment, image?: GarmentImage | null): GarmentImage | null {
  if (image && image.image_type !== "thumbnail") return image;
  const full = (g.images || []).filter((i) => i.image_type === "original" && !i.variant && !/heic|heif/.test(i.mime_type));
  return full.find((i) => i.is_primary) ?? full[0] ?? null;
}
export const hasCutout = (g: Garment) => (g.images || []).some((i) => i.image_type === "processed");

export async function runCutout(image: GarmentImage, signal?: AbortSignal): Promise<CutoutResult> {
  if (image.has_alpha) return { ok: false, transparent: true, note: "這張圖片已經是透明背景，不需要去背" };
  const blob = await highResolutionBlob(imageUrl(image.id), { signal });
  const r = await manualCutout(blob);
  if ("blob" in r) return { ok: true, blob: r.blob, url: URL.createObjectURL(r.blob), kind: r.kind };
  return { ok: false, note: r.note, transparent: r.transparent };
}

/** 保存去背圖。按現有規則：衣物未有去背圖時，新的去背圖成為主圖。 */
export async function saveCutout(g: Garment, source: GarmentImage, blob: Blob): Promise<{ id: string }> {
  const primary = !hasCutout(g);
  const res = await uploadImage("/api/images/upload", { garment_id: g.id, image_type: "processed", derived_from: source.id, ...(primary ? { is_primary: "1" } : {}) }, blob, "cutout.png");
  try { const thumb = await makeThumbnail(blob); await uploadImage("/api/images/upload", { garment_id: g.id, image_type: "thumbnail", derived_from: res.id }, thumb, "thumb.webp"); } catch { /* 縮圖之後由背景工作補建 */ }
  return res;
}
export const loadGarment = (id: string) => api<Garment>(`/api/garments/${id}`);
