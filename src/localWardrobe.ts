/**
 * 本機優先衣櫃（Phase 3.8B）：IndexedDB 本機資料庫＋增量同步。
 *
 * - 按帳戶隔離：資料庫名稱 aw-local-<帳戶>；不同登入帳戶不會讀到對方資料。登出時刪除該帳戶的本機資料庫；
 *   登入過期（401）時鎖定（不讀取）但保留資料，重新登入後不用重新下載。
 * - 開啟 App：先讀本機資料立即顯示 → 背景取伺服器同步清單（manifest）→ 只下載指紋有改變的衣物 →
 *   清單內沒有的衣物（已刪除／封存）從本機移除 → 通知各頁面只更新受影響的部分。
 * - 同步不依賴 offset 分頁；較舊的同步工作不會覆蓋較新的結果；網絡失敗保留最後成功資料，不會清空。
 * - 「完整重新同步」只重新下載衣物資料，不會清除圖片快取。
 * - 首頁、衣櫃、衣服設定、穿搭選單共用同一份本機資料（透過 wardrobeList.loadFullList）。
 * 預留（Phase 3.8C）：outbox 資料表名稱已保留，未啟用離線修改。
 */
import { api, ApiError, Garment } from "./api";

const VERSION = 1;
const STORES = ["garments", "meta", "kv", "outbox"] as const;
type Store = (typeof STORES)[number];
export interface SyncStatus { account: string | null; count: number; lastSync: string | null; lastAttempt: string | null; syncing: boolean; error: string | null; ready: boolean; digest: string | null }

let account: string | null = null;
let dbp: Promise<IDBDatabase> | null = null;
/** 帳戶世代：登出、切換帳戶時遞增；舊的同步工作會被丟棄 */
let gen = 0;
let memory: Garment[] | null = null;
let fps = new Map<string, string>();
let status: SyncStatus = { account: null, count: 0, lastSync: null, lastAttempt: null, syncing: false, error: null, ready: false, digest: null };
let running: Promise<SyncResult> | null = null;
let lastRun = 0;
const listeners = new Set<(s: SyncStatus) => void>();
const emit = () => { const s = { ...status }; for (const l of listeners) l(s); if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("aw:local-status", { detail: s })); };
export const localStatus = () => ({ ...status });
export function onLocalStatus(fn: (s: SyncStatus) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

const hasIdb = () => typeof indexedDB !== "undefined";
const dbName = (acc: string) => "aw-local-" + acc.replace(/[^\w.-]/g, "_").slice(0, 60);
function open(acc: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName(acc), VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // 版本 1：衣物、同步資料、其他本機副本（主頁布局、主題、統計、穿搭清單）、離線佇列（3.8C 預留）
      if (!db.objectStoreNames.contains("garments")) db.createObjectStore("garments", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "id" });
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => db.close(); resolve(db); };
    req.onerror = () => reject(req.error ?? new Error("本機資料庫無法開啟"));
    req.onblocked = () => reject(new Error("本機資料庫被其他分頁佔用"));
  });
}
const reqP = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx<T>(stores: Store[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const db = await (dbp ?? Promise.reject(new Error("本機資料庫未開啟")));
  const t = db.transaction(stores, mode);
  const done = new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error ?? new Error("交易中止")); });
  const out = await fn(t);
  await done;
  return out;
}

/** 設定目前帳戶（登入後）；null＝鎖定（登出或登入過期）。切換帳戶會取消舊帳戶的同步工作。 */
export async function setLocalAccount(acc: string | null) {
  if (acc === account && (acc === null || dbp)) return;
  gen++;
  running = null;
  account = acc;
  memory = null; fps = new Map();
  dbp = acc && hasIdb() ? open(acc) : null;
  status = { account: acc, count: 0, lastSync: null, lastAttempt: null, syncing: false, error: null, ready: false, digest: null };
  if (dbp) {
    const g = gen;
    try {
      await loadMemory(g);
    } catch (e) { if (g === gen) { status.error = (e as Error).message; status.ready = true; } }
  } else status.ready = true;
  emit();
}
export const localAccount = () => account;
async function loadMemory(g: number) {
  const [rows, meta] = await tx(["garments", "meta"], "readonly", async (t) => [
    await reqP(t.objectStore("garments").getAll() as IDBRequest<Garment[]>),
    await reqP(t.objectStore("meta").get("sync") as IDBRequest<{ lastSync: string | null; digest: string | null; fps: [string, string][] } | undefined>),
  ] as const);
  if (g !== gen) return;
  memory = rows.length || meta ? rows : null;
  fps = new Map(meta?.fps ?? []);
  status = { ...status, count: rows.length, lastSync: meta?.lastSync ?? null, digest: meta?.digest ?? null, ready: true };
}
/** 登出：刪除該帳戶的本機資料庫（私人資料不留在手機） */
export async function deleteLocalAccount(acc: string | null) {
  const target = acc ?? account;
  if (target === account) { gen++; const db = await dbp?.catch(() => null); db?.close(); dbp = null; account = null; memory = null; fps = new Map(); status = { ...status, account: null, count: 0, ready: true, lastSync: null, digest: null }; emit(); }
  if (!target || !hasIdb()) return;
  await new Promise<void>((res) => { const r = indexedDB.deleteDatabase(dbName(target)); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}

/** 本機衣物（未同步過＝null）。在記憶體保留一份，不會每次讀 IndexedDB。 */
export function localGarments(): Garment[] | null { return memory; }
export async function whenLocalReady(): Promise<void> {
  if (status.ready || !dbp) return;
  await new Promise<void>((res) => { const off = onLocalStatus((s) => { if (s.ready) { off(); res(); } }); });
}

export interface SyncResult { changed: number; removed: number; total: number; same: boolean }
/**
 * 增量同步。throttleMs：距離上一次成功同步不足這段時間就不連線（背景更新用）。
 * full：完整重新同步（重新下載全部衣物資料；不清除圖片快取）。
 */
export function syncWardrobe(opts: { throttleMs?: number; full?: boolean } = {}): Promise<SyncResult> {
  if (!account || !dbp) return Promise.reject(new Error("未登入"));
  if (running && !opts.full) return running;
  if (!opts.full && opts.throttleMs && Date.now() - lastRun < opts.throttleMs && memory) return Promise.resolve({ changed: 0, removed: 0, total: memory.length, same: true });
  const g = gen;
  const p = (async (): Promise<SyncResult> => {
    status = { ...status, syncing: true, lastAttempt: new Date().toISOString(), error: null }; emit();
    try {
      const since = opts.full || !memory ? null : status.digest;
      const man = await api<{ same: boolean; digest: string; count: number; at: string; items?: [string, string][] }>(`/api/sync/garments/manifest${since ? `?since=${encodeURIComponent(since)}` : ""}`);
      if (g !== gen) throw new Error("帳戶已切換");
      if (man.same) {
        lastRun = Date.now();
        await saveMeta(g, man.at, man.digest);
        return { changed: 0, removed: 0, total: memory?.length ?? 0, same: true };
      }
      const next = new Map(man.items!);
      const need = opts.full ? [...next.keys()] : [...next].filter(([id, fp]) => fps.get(id) !== fp).map(([id]) => id);
      const gone = [...fps.keys()].filter((id) => !next.has(id));
      if (!opts.full && memory) for (const g2 of memory) if (!next.has(g2.id) && !gone.includes(g2.id)) gone.push(g2.id);
      const rows: (Garment & { _fp?: string })[] = [];
      for (let i = 0; i < need.length; i += 200) {
        const r = await api<{ garments: (Garment & { _fp?: string })[] }>("/api/sync/garments", { method: "POST", json: { ids: need.slice(i, i + 200) } });
        if (g !== gen) throw new Error("帳戶已切換");
        rows.push(...r.garments);
      }
      // 在清單與讀取之間被刪除的衣物：不在回應內＝刪除
      const got = new Set(rows.map((r) => r.id));
      for (const id of need) if (!got.has(id)) { gone.push(id); next.delete(id); }
      if (g !== gen) throw new Error("帳戶已切換");
      await tx(["garments", "meta"], "readwrite", (t) => {
        const st = t.objectStore("garments");
        if (opts.full) st.clear();
        for (const r of rows) { const { _fp, ...row } = r; st.put(row); if (_fp) next.set(r.id, _fp); }
        for (const id of gone) st.delete(id);
        t.objectStore("meta").put({ lastSync: man.at, digest: man.digest, fps: [...next] }, "sync");
      });
      if (g !== gen) throw new Error("帳戶已切換");
      fps = next;
      const byId = new Map((opts.full ? [] : memory ?? []).map((x) => [x.id, x]));
      for (const id of gone) byId.delete(id);
      for (const r of rows) { const { _fp, ...row } = r; void _fp; byId.set(r.id, row as Garment); }
      memory = [...byId.values()];
      status = { ...status, count: memory.length, lastSync: man.at, digest: man.digest };
      lastRun = Date.now();
      const res = { changed: rows.length, removed: new Set(gone).size, total: memory.length, same: false };
      if (typeof window !== "undefined" && (res.changed || res.removed)) window.dispatchEvent(new CustomEvent("aw:wardrobe-synced", { detail: res }));
      return res;
    } catch (e) {
      // 網絡失敗：保留最後成功的資料
      if (g === gen) status = { ...status, error: (e as Error).message || "同步失敗" };
      throw e;
    } finally {
      if (g === gen) { status = { ...status, syncing: false }; running = null; emit(); }
    }
  })();
  running = p;
  p.catch(() => undefined);
  return p;
}
async function saveMeta(g: number, at: string, digest: string) {
  if (g !== gen) return;
  await tx(["meta"], "readwrite", (t) => { t.objectStore("meta").put({ lastSync: at, digest, fps: [...fps] }, "sync"); });
  status = { ...status, lastSync: at, digest };
}

/** 單件衣物已在本機修改（衣物詳情保存後）：更新本機資料，並令下一次同步重新核對 */
export async function patchLocalGarment(g: Partial<Garment> & { id: string }) {
  if (!memory || !dbp) return;
  const i = memory.findIndex((x) => x.id === g.id);
  if (i < 0) return;
  memory[i] = { ...memory[i], ...g };
  fps.delete(g.id); status.digest = null;
  try { await tx(["garments", "meta"], "readwrite", (t) => { t.objectStore("garments").put(memory![i]); t.objectStore("meta").put({ lastSync: status.lastSync, digest: null, fps: [...fps] }, "sync"); }); } catch { /* 下次同步修正 */ }
}
export async function dropLocalGarment(id: string) {
  if (!memory || !dbp) return;
  memory = memory.filter((x) => x.id !== id); fps.delete(id); status.digest = null; status.count = memory.length;
  try { await tx(["garments", "meta"], "readwrite", (t) => { t.objectStore("garments").delete(id); t.objectStore("meta").put({ lastSync: status.lastSync, digest: null, fps: [...fps] }, "sync"); }); } catch { /* 下次同步修正 */ }
}

// ───── 其他本機副本（主頁布局、主題、統計、分析、穿搭清單） ─────
export async function kvGet<T>(key: string): Promise<T | undefined> {
  if (!dbp) return undefined;
  try { return await tx(["kv"], "readonly", (t) => reqP(t.objectStore("kv").get(key) as IDBRequest<T | undefined>)); } catch { return undefined; }
}
export async function kvSet(key: string, value: unknown) {
  if (!dbp) return;
  try { await tx(["kv"], "readwrite", (t) => { t.objectStore("kv").put(value, key); }); } catch { /* 容量不足：只是不保存 */ }
}
/** 讀取伺服器資料並保存本機副本；失敗時使用最後成功的本機副本（離線） */
export async function cachedApi<T>(path: string, key = "api:" + path): Promise<{ data: T; offline: boolean }> {
  try { const data = await api<T>(path); void kvSet(key, { data, at: new Date().toISOString() }); return { data, offline: false }; }
  catch (e) {
    // 只在網絡失敗（離線）時使用本機副本；伺服器回覆錯誤時如實顯示並可重試
    if (e instanceof ApiError) throw e;
    const hit = await kvGet<{ data: T }>(key); if (hit) return { data: hit.data, offline: true }; throw e;
  }
}

// ───── 本機篩選及排序（與伺服器 /api/garments 相同的條件） ─────
const LOCAL_KEYS = new Set(["category", "subcategory", "style", "color", "season", "brand", "ai_status", "transparent", "identified", "favorite", "needs_image", "q", "sort", "priced", "status"]);
/** 這個查詢可以在本機完成嗎？（封存衣物、自訂屬性篩選仍由伺服器處理） */
export function localQueryable(q: URLSearchParams): boolean {
  for (const [k, v] of q) { if (!LOCAL_KEYS.has(k)) return false; if (k === "status" && (v === "all" || v === "archived")) return false; }
  return true;
}
const multi = (s: string | null | undefined) => (s ? s.split("、") : []);
export function filterLocal(all: Garment[], q: URLSearchParams): Garment[] {
  const p = (k: string) => q.get(k) || "";
  const status = p("status"), qtext = p("q").trim().replace(/[%_]/g, "").toLowerCase();
  const ai = p("ai_status").split(",").filter(Boolean);
  const out = all.filter((g) => {
    const x = g as Garment & Record<string, unknown>;
    if (status ? g.status !== status : g.status === "archived") return false;
    if (p("category") && g.category !== p("category")) return false;
    if (p("subcategory") && g.subcategory !== p("subcategory")) return false;
    if (p("style") && !multi(g.style).includes(p("style"))) return false;
    if (p("color") && !multi(g.primary_color).includes(p("color")) && !(g.secondary_colors ?? []).includes(p("color"))) return false;
    if (p("season") && !multi(g.season).includes(p("season"))) return false;
    if (p("brand") === "__none__") { if (g.brand) return false; } else if (p("brand") && g.brand !== p("brand")) return false;
    if (ai.length && !ai.includes(String(g.ai_status))) return false;
    if (p("transparent") === "1" && !g.transparent_image_id) return false;
    if (p("identified") === "1" && g.ai_status && g.ai_status !== "done") return false;
    if (p("identified") === "0" && (!g.ai_status || g.ai_status === "done")) return false;
    if (p("favorite") === "1" && !g.is_favorite) return false;
    if (p("needs_image") === "1" && (g.primary_image_id || g.thumb_image_id || Number(x.image_count) > 0)) return false;
    if (p("priced") === "1" && g.price == null) return false;
    if (p("priced") === "0" && g.price != null) return false;
    if (qtext) { const hay = [g.name, g.brand, g.notes, g.pattern, g.subcategory, JSON.stringify(g.attributes ?? {})].filter(Boolean).join(" ").toLowerCase(); if (!hay.includes(qtext)) return false; }
    return true;
  });
  const sort = p("sort");
  const byId = (a: Garment, b: Garment) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const cmp: Record<string, (a: Garment, b: Garment) => number> = {
    name: (a, b) => a.name.localeCompare(b.name, "zh-Hant", { sensitivity: "base" }) || byId(a, b),
    updated: (a, b) => b.updated_at.localeCompare(a.updated_at) || byId(a, b),
    price_desc: (a, b) => (a.price == null ? 1 : 0) - (b.price == null ? 1 : 0) || (b.price ?? 0) - (a.price ?? 0) || b.created_at.localeCompare(a.created_at) || byId(a, b),
    price_asc: (a, b) => (a.price == null ? 1 : 0) - (b.price == null ? 1 : 0) || (a.price ?? 0) - (b.price ?? 0) || b.created_at.localeCompare(a.created_at) || byId(a, b),
    oldest: (a, b) => a.created_at.localeCompare(b.created_at) || byId(a, b),
  };
  return out.sort(cmp[sort] ?? ((a, b) => b.created_at.localeCompare(a.created_at) || byId(a, b)));
}

/** 由本機衣物推導首頁統計（離線或統計 API 失敗時使用；與伺服器 /api/stats 相同規則） */
export function deriveStats(all: Garment[]) {
  const live = all.filter((g) => g.status !== "archived");
  const ai = (s: string) => live.filter((g) => g.ai_status === s).length;
  const priced = live.filter((g) => g.price != null);
  const cats = new Map<string, number>();
  for (const g of live) cats.set(g.category || "未分類", (cats.get(g.category || "未分類") ?? 0) + 1);
  return {
    total: live.length, review: live.filter((g) => g.status === "review").length, favorites: live.filter((g) => g.is_favorite).length,
    missing_image: live.filter((g) => !g.primary_image_id && !g.thumb_image_id && !Number((g as Garment & { image_count?: number }).image_count)).length,
    open_batches: 0, ai_todo: ai("pending_ai") + ai("ai_processing") + ai("failed") + ai("needs_rework"), ai_review: ai("pending_review"), ai_done: ai("done"),
    total_value: priced.reduce((s, g) => s + (g.price ?? 0), 0), priced_count: priced.length,
    by_category: [...cats].map(([category, n]) => ({ category, n })).sort((a, b) => b.n - a.n),
    recent: [...live].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 12), favorite_items: live.filter((g) => g.is_favorite).slice(0, 12),
  };
}

/** 本機資料庫容量估算（瀏覽器配額） */
export async function storageEstimate(): Promise<{ usage: number | null; quota: number | null; persisted: boolean | null }> {
  try {
    const e = await navigator.storage?.estimate?.();
    const persisted = (await navigator.storage?.persisted?.()) ?? null;
    return { usage: e?.usage ?? null, quota: e?.quota ?? null, persisted };
  } catch { return { usage: null, quota: null, persisted: null }; }
}
/** 本機衣物資料大約佔用（JSON 長度） */
export const localDataBytes = () => (memory ? new Blob([JSON.stringify(memory)]).size : 0);
