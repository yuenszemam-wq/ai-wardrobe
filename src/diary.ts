/**
 * Phase 3.9A.1：穿搭日誌（前端資料層）。
 * - 本地日期：一律以手機本地時區的年月日組成（不使用 toISOString，避免深夜紀錄被 UTC 移到前一日／後一日）。
 * - 照片：上傳前在手機壓縮（最長邊 2560px JPEG），以 Canvas 重新編碼＝移除 EXIF／GPS 等 metadata；另製作小縮圖（WebP）存 D1。
 * - 上傳失敗可重試；同一照片重試不會重複建立（伺服器按 SHA-256 去重）。
 * - 草稿：未保存的表單及未上傳照片保存在這部手機（IndexedDB，見 diaryDrafts.ts），失敗不會遺失已填寫資料。
 */
import { ApiError, api } from "./api";
import { cachedApi, localAccount } from "./localWardrobe";
import type { WearMap } from "../shared/wearSort";

export type DiaryKind = "worn" | "planned" | "inspiration";
export const KIND_LABEL: Record<DiaryKind, string> = { worn: "已穿著", planned: "計劃穿搭", inspiration: "靈感穿搭" };
export const KIND_ICON: Record<DiaryKind, string> = { worn: "●", planned: "◇", inspiration: "✦" };
export interface DiaryItem { garment_id: string; part: string; position: number; name: string; category: string | null; subcategory: string | null; style: string | null; snap_id: string | null }
export interface DiaryPhoto { id: string; width: number; height: number; position: number; file_size: number }
export interface DiaryEntry {
  id: string; title: string | null; worn_date: string; worn_time: string | null; kind: DiaryKind; outfit_id: string | null; look_id: string | null; source_name: string | null;
  occasion: string | null; location: string | null; weather: string | null; tags: string[]; notes: string | null; rating: number | null; is_favorite: boolean;
  cover_photo_id: string | null; tz: string | null; created_at: string; updated_at: string; items: DiaryItem[]; photos: DiaryPhoto[]; garment_count: number;
  /** 已保存造型的完整合成縮圖（沒有則 null） */
  source_thumb?: string | null;
}
export interface WearInfo { worn_days: number; entries: number; first: string | null; last: string | null; month: number; year: number; days_since: number | null; cost_per_wear: number | null; price: number | null; diary_since: string | null; related: DiaryEntry[] }

const pad = (n: number) => String(n).padStart(2, "0");
/** 手機本地日期 YYYY-MM-DD */
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } };
export const monthOf = (date: string) => date.slice(0, 7);
export function shiftMonth(month: string, delta: number) { const [y, m] = month.split("-").map(Number); const d = new Date(y, m - 1 + delta, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
export function addDays(date: string, n: number) { const [y, m, d] = date.split("-").map(Number); return localDate(new Date(y, m - 1, d + n)); }
export const weekday = (date: string) => { const [y, m, d] = date.split("-").map(Number); return new Date(y, m - 1, d).getDay(); };
export const daysInMonth = (month: string) => { const [y, m] = month.split("-").map(Number); return new Date(y, m, 0).getDate(); };
export const fmtDate = (date: string) => { const [, m, d] = date.split("-").map(Number); return `${m}月${d}日（${"日一二三四五六"[weekday(date)]}）`; };

export const photoThumb = (id: string) => `/api/diary/photos/${id}/thumb`;
export const photoFull = (id: string) => `/api/diary/photos/${id}`;
export const snapUrl = (id: string) => `/api/diary/snaps/${id}`;

/** 月份紀錄：離線時使用最後一次成功取得的本機副本（唯讀） */
export async function loadMonth(month: string) { return cachedApi<{ entries: DiaryEntry[] }>(`/api/diary?month=${month}&order=asc&limit=500`, "diary:" + month); }
export const loadEntry = (id: string) => cachedApi<DiaryEntry>(`/api/diary/${id}`, "diary-entry:" + id);
export const loadWear = (gid: string) => cachedApi<WearInfo>(`/api/garments/${gid}/wear?today=${localDate()}`, "wear:" + gid);

// ───── 共用快取（Phase 3.9A.1.1）─────
// 首頁多個元件、衣櫃穿著排序共用同一個請求（60 秒內不重複讀取）。快取按帳戶分開；
// 新增、修改、刪除日誌或照片後主動清除（invalidateDiary），並通知已開啟的元件重新讀取，不需等候逾時。
const shared = new Map<string, { at: number; p: Promise<unknown> }>();
export const DIARY_CHANGED = "aw:diary-changed";
export function sharedApi<T>(path: string, key: string, ttl = 60_000): Promise<T> {
  const k = (localAccount() ?? "") + "|" + path;
  const hit = shared.get(k);
  if (hit && Date.now() - hit.at < ttl) return hit.p as Promise<T>;
  const p = cachedApi<T>(path, key).then((r) => r.data);
  shared.set(k, { at: Date.now(), p });
  p.catch(() => shared.delete(k));
  return p;
}
export function invalidateDiary() { shared.clear(); try { window.dispatchEvent(new Event(DIARY_CHANGED)); } catch { /* 非瀏覽器 */ } }
/** 衣櫃穿著排序：全部衣物的穿著日數及最近穿著日期（一次請求） */
export const loadWearSummary = () => sharedApi<{ today: string; garments: WearMap }>(`/api/diary/wear-summary?today=${localDate()}`, "wear-summary");
/** 一段日期範圍（例如跨月的一週、最近紀錄），由舊至新 */
export const loadRange = (from: string, to: string, limit = 500) => sharedApi<{ entries: DiaryEntry[] }>(`/api/diary?from=${from}&to=${to}&order=asc&limit=${limit}`, `diary-range:${from}:${to}`);
/** 最近的紀錄（不限本月；例如 12 月 1 日仍可顯示 11 月 30 日） */
export const loadRecent = (limit = 12) => sharedApi<{ entries: DiaryEntry[] }>(`/api/diary?to=${localDate()}&order=desc&limit=${limit}`, "diary-recent");

// ───── 照片處理 ─────
export interface PendingPhoto { key: string; file: File; rotate: 0 | 90 | 180 | 270; crop: "original" | "3:4" | "1:1"; preview: string; state: "waiting" | "uploading" | "done" | "failed"; progress: number; error?: string; size?: number; uploadedId?: string }
async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions); }
  catch {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
  }
}
/** 旋轉、裁切並重新編碼（移除 EXIF／GPS）。回傳上傳用 JPEG 及小縮圖 WebP */
export async function processPhoto(file: Blob, opt: { rotate: number; crop: "original" | "3:4" | "1:1" }, maxSide = 2560): Promise<{ main: Blob; thumb: Blob; width: number; height: number }> {
  const img = await decode(file);
  const iw = "naturalWidth" in img ? img.naturalWidth : img.width, ih = "naturalHeight" in img ? img.naturalHeight : img.height;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  const ratio = opt.crop === "1:1" ? 1 : opt.crop === "3:4" ? (opt.rotate % 180 ? 4 / 3 : 3 / 4) : 0;
  if (ratio) { if (sw / sh > ratio) { sw = sh * ratio; sx = (iw - sw) / 2; } else { sh = sw / ratio; sy = (ih - sh) / 2; } }
  const render = (max: number, type: string, quality: number) => {
    const scale = Math.min(1, max / Math.max(sw, sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const rot = opt.rotate % 180 !== 0;
    const c = document.createElement("canvas");
    c.width = rot ? h : w; c.height = rot ? w : h;
    const ctx = c.getContext("2d")!;
    ctx.translate(c.width / 2, c.height / 2); ctx.rotate((opt.rotate * Math.PI) / 180);
    ctx.drawImage(img as CanvasImageSource, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    return new Promise<{ blob: Blob; w: number; h: number }>((res, rej) => c.toBlob((b) => (b ? res({ blob: b, w: c.width, h: c.height }) : rej(new Error("照片處理失敗"))), type, quality));
  };
  const main = await render(maxSide, "image/jpeg", 0.86);
  let thumb = await render(320, "image/webp", 0.72);
  if (thumb.blob.size > 60 * 1024 || thumb.blob.type !== "image/webp") thumb = await render(240, "image/jpeg", 0.7);
  if ("close" in img) img.close();
  return { main: main.blob, thumb: thumb.blob, width: main.w, height: main.h };
}

/** 上傳一張照片（顯示進度）；伺服器按內容去重，重試安全 */
export function uploadPhoto(entryId: string, main: Blob, thumb: Blob, onProgress: (p: number) => void, op?: string): Promise<{ photo: { id: string }; duplicate?: boolean }> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.set("file", main, "photo.jpg"); fd.set("thumb", thumb, "thumb");
    if (op) fd.set("op", op);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/diary/${entryId}/photos`);
    xhr.setRequestHeader("x-requested-with", "ai-wardrobe");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data: { error?: { code: string; message: string } } | null = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) { invalidateDiary(); resolve(data as never); }
      else { if (xhr.status === 401) window.dispatchEvent(new Event("aw:unauthorized")); reject(new ApiError(xhr.status, data?.error?.code || "upload_failed", data?.error?.message || `上傳失敗（${xhr.status}）`)); }
    };
    xhr.onerror = () => reject(new Error("網絡中斷，可以稍後重試"));
    xhr.send(fd);
  });
}

// 草稿：見 diaryDrafts.ts（IndexedDB，包括未上傳照片）

const changed = <T>(p: Promise<T>) => p.then((v) => { invalidateDiary(); return v; });
export const diaryApi = {
  create: (body: unknown) => changed(api<DiaryEntry>("/api/diary", { method: "POST", json: body })),
  update: (id: string, body: unknown) => changed(api<DiaryEntry>(`/api/diary/${id}`, { method: "PATCH", json: body })),
  duplicate: (id: string, body: unknown) => changed(api<DiaryEntry>(`/api/diary/${id}/duplicate`, { method: "POST", json: body })),
  remove: (id: string) => changed(api(`/api/diary/${id}`, { method: "DELETE" })),
  removePhoto: (id: string, pid: string) => changed(api(`/api/diary/${id}/photos/${pid}`, { method: "DELETE" })),
};
