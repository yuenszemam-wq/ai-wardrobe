/**
 * Phase 3.9A.2：工作室素材（前端資料層）。
 * - 上傳前在手機解碼及壓縮（最長邊 3000px；有透明的保留 PNG，否則 JPEG）。HEIC 只在瀏覽器能解碼時轉換，否則如實提示。
 * - 小縮圖（WebP，最長邊 256px）存 D1，列表不讀取 R2 原圖。
 * - 去背沿用現有手動去背模組（imageProcessing.manualCutout，在手機執行，不使用外部服務）。
 */
import { api, ApiError } from "../api";
import { manualCutout } from "../imageProcessing";

export type AssetKind = "background" | "decoration" | "prop" | "accessory" | "other";
export const ASSET_KIND_LABEL: Record<AssetKind, string> = { background: "背景", decoration: "裝飾", prop: "道具", accessory: "配件", other: "其他" };
export interface StudioVersion { id: string; width: number; height: number; has_alpha: boolean; has_cutout: boolean; url: string; cutout_url: string | null; thumb_url: string }
export interface StudioAsset { id: string; kind: AssetKind; name: string; is_favorite: boolean; in_library: boolean; created_at: string; updated_at: string; version: StudioVersion | null; used_by?: number; usage?: { id: string; name: string; kind: "outfit" | "look" }[] }

export async function listStudioAssets(p: { kind?: AssetKind; q?: string; favorite?: boolean } = {}): Promise<StudioAsset[]> {
  const qs = new URLSearchParams();
  if (p.kind) qs.set("kind", p.kind);
  if (p.q) qs.set("q", p.q);
  if (p.favorite) qs.set("favorite", "1");
  return (await api<{ assets: StudioAsset[] }>(`/api/studio/assets?${qs}`)).assets;
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions); }
  catch {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
  }
}
const canvasBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("圖片處理失敗"))), type, q));

export interface PreparedImage { blob: Blob; thumb: Blob; width: number; height: number; hasAlpha: boolean; preview: string }
/** 解碼、壓縮及製作縮圖 */
export async function prepareImage(file: Blob, maxSide = 3000): Promise<PreparedImage> {
  let src: ImageBitmap | HTMLImageElement;
  try { src = await decode(file); }
  catch { throw new Error(/heic|heif/i.test((file as File).name ?? file.type) || /heic|heif/.test(file.type) ? "這部裝置的瀏覽器未能解碼 HEIC 相片；請在相簿以「最相容」格式分享，或先轉為 JPG" : "這個檔案未能作為圖片開啟"); }
  const iw = "naturalWidth" in src ? src.naturalWidth : src.width, ih = "naturalHeight" in src ? src.naturalHeight : src.height;
  const s = Math.min(1, maxSide / Math.max(iw, ih));
  const c = document.createElement("canvas");
  c.width = Math.round(iw * s); c.height = Math.round(ih * s);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src as CanvasImageSource, 0, 0, c.width, c.height);
  if ("close" in src) src.close();
  // 真正 Alpha：檢查實際像素（不只看檔案格式）
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 16) if (d[i] < 250) { hasAlpha = true; break; }
  const blob = hasAlpha ? await canvasBlob(c, "image/png") : await canvasBlob(c, "image/jpeg", 0.9);
  const thumb = await thumbOf(c);
  return { blob, thumb, width: c.width, height: c.height, hasAlpha, preview: URL.createObjectURL(blob) };
}
async function thumbOf(src: HTMLCanvasElement | ImageBitmap) {
  const t = document.createElement("canvas");
  const s = Math.min(1, 256 / Math.max(src.width, src.height));
  t.width = Math.max(1, Math.round(src.width * s)); t.height = Math.max(1, Math.round(src.height * s));
  t.getContext("2d")!.drawImage(src as CanvasImageSource, 0, 0, t.width, t.height);
  let b = await canvasBlob(t, "image/webp", 0.8);
  if (b.type !== "image/webp") b = await canvasBlob(t, "image/png");
  return b;
}

export async function uploadStudioAsset(img: PreparedImage, opts: { kind: AssetKind; name: string; inLibrary: boolean; opId?: string }): Promise<StudioAsset> {
  if (!navigator.onLine) throw new Error("目前離線：素材需要連線才可以上傳");
  const fd = new FormData();
  fd.set("file", img.blob, img.hasAlpha ? "asset.png" : "asset.jpg");
  fd.set("thumb", img.thumb, "thumb");
  fd.set("kind", opts.kind);
  fd.set("name", opts.name);
  if (opts.inLibrary) fd.set("in_library", "1");
  // 冪等：同一次上傳重試（網絡中斷後）沿用同一個 op_id，伺服器取回第一次建立的素材
  if (opts.opId) fd.set("op_id", opts.opId);
  return api<StudioAsset>("/api/studio/assets", { method: "POST", body: fd });
}

/** 手動去背：在手機執行現有去背流程，回傳透明 PNG（失敗時回傳原因，不改動素材） */
export async function cutoutBlob(src: Blob): Promise<{ ok: true; blob: Blob; url: string } | { ok: false; note: string }> {
  const r = await manualCutout(src);
  if ("blob" in r) return { ok: true, blob: r.blob, url: URL.createObjectURL(r.blob) };
  return { ok: false, note: r.note };
}
export async function saveCutout(versionId: string, cut: Blob): Promise<StudioAsset & { version_id: string }> {
  if (!navigator.onLine) throw new Error("目前離線：去背結果需要連線才可以保存");
  const bmp = await decode(cut);
  const fd = new FormData();
  fd.set("file", cut, "cutout.png");
  fd.set("thumb", await thumbOf(bmp as ImageBitmap), "thumb");
  return api(`/api/studio/versions/${versionId}/cutout`, { method: "POST", body: fd });
}
export const patchStudioAsset = (id: string, body: Partial<Pick<StudioAsset, "name" | "kind" | "is_favorite" | "in_library">>) => api<StudioAsset>(`/api/studio/assets/${id}`, { method: "PATCH", json: body });
export const deleteStudioAsset = (id: string) => api<{ deleted: boolean; removed_from_library?: boolean; used_by?: { id: string; name: string }[] }>(`/api/studio/assets/${id}`, { method: "DELETE" });
export const getStudioAsset = (id: string) => api<StudioAsset>(`/api/studio/assets/${id}`);
export const versionToGarment = (versionId: string, body: { name: string; category: string; variant: "original" | "cutout" }) => api<{ garment_id: string }>(`/api/studio/versions/${versionId}/to-garment`, { method: "POST", json: body });
export { ApiError };
