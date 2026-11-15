/**
 * Phase 3.9A.1.1：穿搭日誌草稿（IndexedDB）。
 *
 * - 保存完整草稿：表單、未上傳照片的原始 Blob、每張照片的旋轉／裁切／排序、封面選擇、上傳狀態及已上傳的照片 ID。
 * - 重新打開 App（包括離線）可以恢復完整草稿；離線時照片仍保留在這部手機。
 * - 按帳戶及草稿 ID 分開（key＝帳戶｜草稿 ID）；只刪除對應草稿，不會清除其他草稿。
 * - 使用獨立資料庫（aw-drafts），不改動本機衣櫃資料庫的版本。
 * - 每張照片有穩定的 op（client operation ID）：重試上傳時伺服器以 op 識別同一張照片，不會重複建立。
 * - IndexedDB 不可用（例如私人瀏覽、容量不足）時退回 localStorage 只保存文字資料，並如實回報照片未能保存。
 */
import { localAccount } from "./localWardrobe";

export type PhotoState = "waiting" | "uploading" | "done" | "failed";
export interface DraftPhoto { key: string; op: string; blob: Blob; name: string; rotate: 0 | 90 | 180 | 270; crop: "original" | "3:4" | "1:1"; state: PhotoState; uploadedId?: string; error?: string }
export interface DiaryDraft<F = unknown> { form: F; photos: DraftPhoto[]; cover: string | null; pendingCover: string | null; order: string[]; entryId: string | null; at: number }

const DB = "aw-drafts", STORE = "diary", LS = "aw:diary-draft:";
let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error("草稿資料庫被佔用"));
    } catch (e) { rej(e); }
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
const keyOf = (id: string) => `${localAccount() ?? "_"}|${id}`;
function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((res, rej) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => res(r ? (r as IDBRequest<T>).result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error ?? new Error("草稿保存失敗"));
  }));
}

export const newOp = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20); };

/** 保存草稿；回傳 "full"（含照片）或 "text"（只保存文字，照片未能保存） */
/** 逾時保護：個別瀏覽器的 IndexedDB 可能長時間沒有回應，不可令編輯頁卡在載入中 */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("草稿資料庫逾時")), ms))]);
/** 照片以 ArrayBuffer 保存（部分 Safari 版本在 IndexedDB 保存 Blob 不穩定），讀取時還原為 File */
type Stored<F> = Omit<DiaryDraft<F>, "photos"> & { photos: (Omit<DraftPhoto, "blob"> & { buf: ArrayBuffer; type: string })[] };
async function pack<F>(d: DiaryDraft<F>): Promise<Stored<F>> { return { ...d, photos: await Promise.all(d.photos.map(async ({ blob, ...p }) => ({ ...p, buf: await blob.arrayBuffer(), type: blob.type || "image/jpeg" }))) }; }
function unpack<F>(s: Stored<F> | DiaryDraft<F>): DiaryDraft<F> {
  return { ...s, photos: (s.photos as (DraftPhoto | (Omit<DraftPhoto, "blob"> & { buf: ArrayBuffer; type: string }))[]).map((p) => ("buf" in p ? (({ buf, type, ...rest }) => ({ ...rest, blob: new File([buf], rest.name || "photo", { type }) }))(p) : p)) };
}
export async function putDraft<F>(id: string, d: DiaryDraft<F>): Promise<"full" | "text"> {
  try { const v = await pack(d); await within(run("readwrite", (s) => s.put(v, keyOf(id))), 4000); return "full"; }
  catch {
    try { localStorage.setItem(LS + keyOf(id), JSON.stringify({ ...d, photos: [] })); } catch { /* 空間不足 */ }
    return "text";
  }
}
export async function getDraft<F>(id: string): Promise<DiaryDraft<F> | null> {
  try { const v = await within(run<Stored<F>>("readonly", (s) => s.get(keyOf(id))), 2500); if (v) return unpack(v); } catch { /* 退回 localStorage */ }
  try {
    const s = localStorage.getItem(LS + keyOf(id)) ?? localStorage.getItem(LS + id);
    if (!s) return null;
    const v = JSON.parse(s);
    // 舊版（Phase 3.9A.1）草稿只有表單：{ v: form, at }
    return v && "form" in v ? v : v?.v ? { form: v.v as F, photos: [], cover: null, pendingCover: null, order: [], entryId: null, at: v.at ?? Date.now() } : null;
  } catch { return null; }
}
/** 刪除一個草稿（只刪除這個帳戶的這個草稿 ID） */
export async function dropDraft(id: string) {
  try { await within(run("readwrite", (s) => s.delete(keyOf(id))), 2500); } catch { /* ignore */ }
  try { localStorage.removeItem(LS + keyOf(id)); localStorage.removeItem(LS + id); } catch { /* ignore */ }
}
/** 把新增中的草稿搬到已建立紀錄的 ID（日誌已保存但仍有照片待上傳） */
export async function moveDraft<F>(from: string, to: string, d: DiaryDraft<F>) {
  await putDraft(to, d);
  await dropDraft(from);
}
