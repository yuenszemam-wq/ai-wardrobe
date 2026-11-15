/**
 * Phase 3.9A.2.1／3.9A.3：創作草稿（衣服配搭及角色換裝共用，IndexedDB）。
 *
 * 取代以前的 localStorage 單一草稿（未按帳戶分開、所有新造型共用 "new"、容量錯誤被忽略）：
 * - 按帳戶分開（key＝帳戶｜草稿 ID），可同時有多份草稿；每份新造型有自己的草稿 ID。
 * - 草稿記錄編輯起點的伺服器版本（base）。打開時版本不同＝「衝突草稿」，不會自動覆蓋，由使用者選擇載入、另存副本或捨棄。
 * - 保存失敗會回報（編輯器顯示「草稿未能保存」），不再無聲忽略；pagehide／切換 App 時立即寫入。
 * - 只保存設定（圖層、背景、名稱）；圖片已在伺服器或本機圖片快取，不會複製大檔案。
 * - IndexedDB 不可用時退回 localStorage（同樣按帳戶分開），並回報「只保存在暫存空間」。
 */
import { localAccount } from "./localWardrobe";

export type DraftKind = "outfit" | "look";
export interface StudioDraft<D = unknown> {
  id: string;
  kind: DraftKind;
  /** 對應的伺服器造型 ID；新造型＝null */
  target: string | null;
  /** 開始編輯時的伺服器版本（updated_at）；新造型＝null */
  base: string | null;
  title: string;
  at: number;
  /** 預覽縮圖（細小 data URL，可選） */
  preview?: string | null;
  data: D;
}
const DB = "aw-studio-drafts", STORE = "drafts", LS = "aw:studio-draft:";
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
const acc = () => localAccount() ?? "_";
const keyOf = (id: string) => `${acc()}|${id}`;
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("草稿資料庫逾時")), ms))]);
function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then((db) => new Promise<T | undefined>((res, rej) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => res(r ? (r as IDBRequest<T>).result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error ?? new Error("草稿保存失敗"));
  }));
}

export const newDraftId = (kind: DraftKind) => `${kind === "outfit" ? "n" : "l"}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
/** 既有造型的預設草稿 ID（同一造型只有一份自動草稿；另存的衝突副本使用新的 ID） */
export const draftIdFor = (kind: DraftKind, target: string) => `${kind === "outfit" ? "o" : "k"}:${target}`;

export type SaveResult = "saved" | "fallback" | "failed";
const listeners = new Set<() => void>();
export const onDraftsChange = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((f) => { try { f(); } catch { /* ignore */ } });

export async function putStudioDraft<D>(d: StudioDraft<D>): Promise<SaveResult> {
  try { await within(tx("readwrite", (s) => s.put(d, keyOf(d.id))), 4000); emit(); return "saved"; }
  catch {
    try { localStorage.setItem(LS + keyOf(d.id), JSON.stringify(d)); emit(); return "fallback"; }
    catch { return "failed"; }
  }
}
export async function getStudioDraft<D>(id: string): Promise<StudioDraft<D> | null> {
  try { const v = await within(tx<StudioDraft<D>>("readonly", (s) => s.get(keyOf(id))), 2500); if (v) return v; } catch { /* 退回 localStorage */ }
  try { const s = localStorage.getItem(LS + keyOf(id)); return s ? (JSON.parse(s) as StudioDraft<D>) : null; } catch { return null; }
}
export async function dropStudioDraft(id: string) {
  try { await within(tx("readwrite", (s) => s.delete(keyOf(id))), 2500); } catch { /* ignore */ }
  try { localStorage.removeItem(LS + keyOf(id)); } catch { /* ignore */ }
  emit();
}
/** 這個帳戶的全部草稿（新到舊） */
export async function listStudioDrafts<D = unknown>(kind?: DraftKind): Promise<StudioDraft<D>[]> {
  const prefix = acc() + "|";
  const out = new Map<string, StudioDraft<D>>();
  try {
    const range = IDBKeyRange.bound(prefix, prefix + "￿");
    const all = await within(tx<StudioDraft<D>[]>("readonly", (s) => s.getAll(range)), 2500);
    for (const d of all ?? []) out.set(d.id, d);
  } catch { /* 退回 localStorage */ }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(LS + prefix)) continue;
      const d = JSON.parse(localStorage.getItem(k) || "null") as StudioDraft<D> | null;
      if (d && !out.has(d.id)) out.set(d.id, d);
    }
  } catch { /* ignore */ }
  return [...out.values()].filter((d) => !kind || d.kind === kind).sort((a, b) => b.at - a.at);
}

/** 舊版 localStorage 草稿（aw:outfit-draft:<id>）：搬到新格式一次，然後刪除舊資料 */
export function takeLegacyOutfitDraft(id: string | undefined): null | { at: number; base: string | null; name: string; notes: string; favorite: boolean; scene: unknown; srcs: Record<string, string | null> } {
  const k = `aw:outfit-draft:${id ?? "new"}`;
  try {
    const v = localStorage.getItem(k);
    if (!v) return null;
    localStorage.removeItem(k);
    return JSON.parse(v);
  } catch { return null; }
}
