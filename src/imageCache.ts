/**
 * 圖片讀取及本機快取（Phase 3.8）。
 * - 縮圖：可見的縮圖合併成批量請求（最多 16 張、同時 2 批）。持久快取按圖片 ID＋版本保存，可保存整個衣櫃。
 *   重新整理不再刪除整個縮圖庫：只標記為「需要核對版本」，先取版本，只下載版本已改變或缺少的縮圖。
 * - 高清：獨立的兩條下載通道，同一張圖片的多個請求合併；已查看過的高清圖保存在手機（有容量上限，長期未用的先清走）。
 * 所有快取名稱以 aw-private- 開頭：登出或登入失效時由 Service Worker 一併清除。
 */
const memory = new Map<string, Blob>(), pending = new Map<string, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();
const flights = new Map<string, Promise<Blob>>();
let timer: ReturnType<typeof setTimeout> | undefined, active = 0, epoch = 0;
const CACHE = "aw-private-thumbs-v1", HD_CACHE = "aw-private-hd-v1";
/** 縮圖持久快取上限（張）。約 116 件衣物、582 張縮圖、9.5 MB 可以全部保存。 */
export const THUMB_CACHE_LIMIT = 4000;
/** 縮圖版本核對的間隔：在此期間直接使用本機縮圖，不連線 */
const THUMB_FRESH_MS = 7 * 24 * 3600 * 1000;
/** 高清快取預設容量上限（可在設定修改，保存在 localStorage） */
export const HD_DEFAULT_BYTES = 300 * 1024 * 1024;
const HD_LIMIT_KEY = "aw-hd-cache-limit";
/** 下拉重新整理的時間：之前保存的縮圖需要核對版本（不刪除） */
let staleBefore = 0;

export function hdCacheLimit(): number {
  try { const v = Number(localStorage.getItem(HD_LIMIT_KEY)); return v >= 20 * 1024 * 1024 ? v : HD_DEFAULT_BYTES; } catch { return HD_DEFAULT_BYTES; }
}
export function setHdCacheLimit(bytes: number) { try { localStorage.setItem(HD_LIMIT_KEY, String(Math.max(20 * 1024 * 1024, Math.round(bytes)))); } catch { /* 私人瀏覽 */ } void trimHd(); }

/** 下拉重新整理：清除記憶體，之後讀取的縮圖會先核對版本，只更新有改動的（未改動的縮圖及高清圖保留） */
export async function refreshImageCache() { clearImageMemory(); staleBefore = Date.now(); window.dispatchEvent(new Event("aw:refresh-images")); }
export interface ClearResult { thumbs: { count: number; bytes: number }; hd: { count: number; bytes: number }; keptPinned: number; errors: string[] }
/**
 * 設定 →「清除本機圖片快取」（3.8A.2 起改名，以前叫「修復圖片快取」但實際是清除）。
 * 只刪除這部手機的縮圖及／或高清圖片快取；不會刪除 R2 原圖、D1 縮圖、衣物、穿搭、角色資料、未同步修改、未上傳圖片或離線佇列。
 * 已指定保留（離線下載）的高清圖預設保留，需要明確選擇才一併刪除。如實回報實際清除的數量及錯誤。
 */
export async function clearImageCaches(opts: { thumbs?: boolean; hd?: boolean; includePinned?: boolean } = { thumbs: true, hd: true }): Promise<ClearResult> {
  const out: ClearResult = { thumbs: { count: 0, bytes: 0 }, hd: { count: 0, bytes: 0 }, keptPinned: 0, errors: [] };
  clearImageMemory();
  if (typeof caches === "undefined") { out.errors.push("這個瀏覽器不支援 Cache Storage"); return out; }
  if (opts.thumbs) {
    try {
      const c = await caches.open(CACHE), keys = await c.keys();
      for (const k of keys) { const r = await c.match(k); out.thumbs.bytes += r ? (await r.blob()).size : 0; }
      out.thumbs.count = keys.length;
      if (!(await caches.delete(CACHE)) && keys.length) out.errors.push("縮圖快取未能刪除");
    } catch (e) { out.errors.push("縮圖：" + ((e as Error).message || "刪除失敗")); }
  }
  if (opts.hd) {
    try {
      const c = await caches.open(HD_CACHE), keys = await c.keys();
      for (const k of keys) {
        const r = await c.match(k);
        const pinned = r?.headers.get("x-aw-pinned") === "1";
        if (pinned && !opts.includePinned) { out.keptPinned++; continue; }
        const size = Number(r?.headers.get("x-aw-size")) || 0;
        if (await c.delete(k)) { out.hd.count++; out.hd.bytes += size; } else out.errors.push("高清圖未能刪除：" + new URL(k.url).pathname);
      }
    } catch (e) { out.errors.push("高清圖：" + ((e as Error).message || "刪除失敗")); }
  }
  window.dispatchEvent(new Event("aw:refresh-images"));
  return out;
}
/** 「檢查及更新圖片」：只核對版本，只重新下載有改動的圖片（不清除快取） */
export const checkImageUpdates = refreshImageCache;
export function clearImageMemory() { epoch++; memory.clear(); flights.clear(); hdFlights.clear(); hdSharedReset(); for (const p of pending.values()) p.reject(new Error("圖片快取已清除")); pending.clear(); }
if (typeof window !== "undefined") { window.addEventListener("aw:unauthorized", clearImageMemory); }
/** 修復單張縮圖前：忘記記憶體中的舊版本 */
export function forgetThumb(id: string) { memory.delete(id); flights.delete(id); }
function remember(id: string, b: Blob) { memory.delete(id); memory.set(id, b); while (memory.size > 64) memory.delete(memory.keys().next().value!); }
export function imageIdOf(src?: string) { return src?.match(/^\/api\/images\/(img_[a-z2-7]+)(?:\?|$)/)?.[1]; }
const key = (id: string) => "/api/thumbnails/" + id;
async function cached(id: string) { try { return await (await caches.open(CACHE)).match(key(id)); } catch { return undefined; } }
let trimTimer: ReturnType<typeof setTimeout> | undefined;
async function persist(id: string, blob: Blob, version: string, runEpoch: number) {
  if (epoch !== runEpoch) return;
  try {
    const c = await caches.open(CACHE);
    await c.put(key(id), new Response(blob, { headers: { "content-type": "image/webp", "x-aw-cached-at": String(Date.now()), "x-thumbnail-version": version } }));
    if (epoch !== runEpoch) { await c.delete(key(id)); return; }
    if (!trimTimer) trimTimer = setTimeout(async () => { trimTimer = undefined; try { const keys = await c.keys(); for (const old of keys.slice(0, Math.max(0, keys.length - THUMB_CACHE_LIMIT))) await c.delete(old); } catch { /* ignore */ } }, 2000);
  } catch { /* Storage eviction/private browsing must not prevent display. */ }
}
/** 版本未改變：只更新核對時間，保留同一份圖片 */
async function touch(id: string, hit: Response, runEpoch: number) {
  if (epoch !== runEpoch) return;
  try { const blob = await hit.clone().blob(); await (await caches.open(CACHE)).put(key(id), new Response(blob, { headers: { "content-type": "image/webp", "x-aw-cached-at": String(Date.now()), "x-thumbnail-version": hit.headers.get("x-thumbnail-version") ?? "" } })); } catch { /* ignore */ }
}
function schedule() { if (!timer) timer = setTimeout(() => { timer = undefined; void flush(); }, 24); }
async function request(ids: string[], data: boolean) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch("/api/thumbnails?" + (data ? "data=1&" : "") + "ids=" + ids.join(","), { credentials: "same-origin", signal: controller.signal });
    if (!res.ok) { if (res.status === 401) window.dispatchEvent(new Event("aw:unauthorized")); throw new Error(`縮圖讀取失敗（${res.status}）`); }
    return (await res.json()) as { items: Array<{ image_id: string; base64?: string; version: string }> };
  } finally { clearTimeout(timeout); }
}
async function flush() {
  if (active >= 2 || !pending.size) return;
  const entries = [...pending.entries()].slice(0, 16); entries.forEach(([id]) => pending.delete(id));
  const runEpoch = epoch; active++;
  try {
    // 有本機舊版本的縮圖：先只取版本（不含圖片資料），版本相同就沿用本機圖片
    const old = new Map<string, Response>();
    for (const [id] of entries) { const hit = await cached(id); if (hit) old.set(id, hit); }
    let need = entries;
    if (old.size) {
      const meta = await request([...old.keys()], false);
      if (epoch !== runEpoch) throw new Error("圖片快取已清除");
      const same = new Set<string>();
      for (const [id, hit] of old) { const m = meta.items.find((i) => i.image_id === id); if (m && m.version === hit.headers.get("x-thumbnail-version")) same.add(id); }
      for (const [id, p] of entries) if (same.has(id)) { const hit = old.get(id)!; const blob = await hit.clone().blob(); remember(id, blob); void touch(id, hit, runEpoch); p.resolve(blob); }
      need = entries.filter(([id]) => !same.has(id));
    }
    if (need.length) {
      const data = await request(need.map(([id]) => id), true);
      if (epoch !== runEpoch) throw new Error("圖片快取已清除");
      for (const [id, p] of need) {
        const item = data.items.find((i) => i.image_id === id);
        if (!item || !item.base64) { p.reject(new Error("縮圖準備中")); continue; }
        const bytes = Uint8Array.from(atob(item.base64), (c) => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: "image/webp" }); remember(id, blob); void persist(id, blob, item.version, runEpoch); p.resolve(blob);
      }
    }
  } catch (e) {
    // 網絡失敗：保留本機已有的縮圖，不清空畫面
    for (const [id, p] of entries) {
      const old = epoch === runEpoch ? await cached(id) : undefined;
      if (old) p.resolve(await old.blob()); else p.reject(e as Error);
    }
  } finally { active--; if (pending.size) schedule(); }
}
export function thumbnailBlob(id: string): Promise<Blob> {
  const hit = memory.get(id); if (hit) return Promise.resolve(hit);
  const existing = flights.get(id); if (existing) return existing;
  const p = (async () => {
    const hit = await cached(id);
    const at = Number(hit?.headers.get("x-aw-cached-at"));
    if (hit && (!navigator.onLine || (at > staleBefore && Date.now() - at < THUMB_FRESH_MS))) {
      const blob = await hit.blob(); remember(id, blob); return blob;
    }
    return new Promise<Blob>((resolve, reject) => { pending.set(id, { resolve, reject }); schedule(); });
  })();
  flights.set(id, p); p.finally(() => flights.delete(id)).catch(() => {}); return p;
}

// ───── 高清圖片 ─────
/** 本機高清快取命中次數（每月；每次命中＝少一次 R2 GetObject）。只是這部手機的統計。 */
const HIT_KEY = () => "aw:hd-hits:" + new Date().toISOString().slice(0, 7);
let hitBuffer = 0, hitTimer: ReturnType<typeof setTimeout> | undefined;
function countLocalHit() { hitBuffer++; if (!hitTimer) hitTimer = setTimeout(() => { hitTimer = undefined; try { localStorage.setItem(HIT_KEY(), String((Number(localStorage.getItem(HIT_KEY())) || 0) + hitBuffer)); } catch { /* ignore */ } hitBuffer = 0; }, 1500); }
export function localHitCount(): number { try { return (Number(localStorage.getItem(HIT_KEY())) || 0) + hitBuffer; } catch { return hitBuffer; } }
let hdActive = 0;
const hdWaiters: Array<() => void> = [];
const hdFlights = new Map<string, Promise<Blob>>();
const hdSharedReset = () => { for (const f of hdShared.values()) f.controller.abort(); hdShared.clear(); };
/** 已保存在手機的高清圖片（沒有＝undefined）。讀取時更新最後使用時間。 */
export async function cachedHighResolution(src: string): Promise<Blob | undefined> {
  try {
    const c = await caches.open(HD_CACHE), hit = await c.match(src);
    if (!hit) return undefined;
    countLocalHit();
    const blob = await hit.blob();
    const used = Number(hit.headers.get("x-aw-used-at"));
    if (Date.now() - used > 6 * 3600 * 1000) void c.put(src, new Response(blob, { headers: hdHeaders(blob, hit.headers.get("x-aw-pinned") === "1") }));
    return blob;
  } catch { return undefined; }
}
const hdHeaders = (blob: Blob, pinned = false) => ({ "content-type": blob.type || "image/png", "x-aw-used-at": String(Date.now()), "x-aw-size": String(blob.size), ...(pinned ? { "x-aw-pinned": "1" } : {}) });
async function trimHd() {
  try {
    const c = await caches.open(HD_CACHE), keys = await c.keys();
    const rows: Array<{ req: Request; used: number; size: number; pinned: boolean }> = [];
    for (const req of keys) { const r = await c.match(req); if (r) rows.push({ req, used: Number(r.headers.get("x-aw-used-at")) || 0, size: Number(r.headers.get("x-aw-size")) || 0, pinned: r.headers.get("x-aw-pinned") === "1" }); }
    let total = rows.reduce((s, r) => s + r.size, 0);
    const limit = hdCacheLimit();
    // 先清走長期未用、非使用者主動下載的高清圖
    for (const r of rows.filter((r) => !r.pinned).sort((a, b) => a.used - b.used)) { if (total <= limit) break; await c.delete(r.req); total -= r.size; }
  } catch { /* ignore */ }
}
async function putHd(src: string, blob: Blob, pinned: boolean, runEpoch: number) {
  // 清除快取或登出之後才完成的舊下載，不會重新寫入已清除的快取
  if (runEpoch !== epoch) return;
  try {
    const c = await caches.open(HD_CACHE);
    // 已指定保留的高清圖：更新時保留「保留」標記
    const was = pinned || (await c.match(src))?.headers.get("x-aw-pinned") === "1";
    if (runEpoch !== epoch) return;
    await c.put(src, new Response(blob, { headers: hdHeaders(blob, was) }));
    if (runEpoch !== epoch) { await c.delete(src); return; }
    void trimHd();
  } catch { /* 容量不足或私人瀏覽：只是不保存 */ }
}
/** 把已在手機的高清圖標記為「保留」（離線下載）；不需要重新下載 */
export async function pinHighResolution(src: string, pinned = true): Promise<boolean> {
  try { const c = await caches.open(HD_CACHE), hit = await c.match(src); if (!hit) return false; const blob = await hit.blob(); await c.put(src, new Response(blob, { headers: hdHeaders(blob, pinned) })); return true; } catch { return false; }
}
interface HdFlight { promise: Promise<Blob>; controller: AbortController; users: number; pin: boolean }
const hdShared = new Map<string, HdFlight>();
/**
 * 讀取高清圖片：先用手機已保存的版本；同一張圖片同時只下載一次；最多兩張同時下載；失敗會重試一次。
 * 多個元件共用同一個下載：其中一個取消只影響它自己，全部使用者都取消才真正中止下載。
 */
export function highResolutionBlob(src: string, opts: { signal?: AbortSignal; pin?: boolean } = {}): Promise<Blob> {
  let f = hdShared.get(src);
  if (!f) {
    const controller = new AbortController(), runEpoch = epoch;
    const flight: HdFlight = { controller, users: 0, pin: !!opts.pin, promise: null as unknown as Promise<Blob> };
    flight.promise = (async () => {
      const hit = await cachedHighResolution(src);
      if (hit) { if (flight.pin) void pinHighResolution(src); return hit; }
      if (hdActive >= 2) await new Promise<void>((r) => hdWaiters.push(r));
      else hdActive++;
      try {
        if (controller.signal.aborted) throw new DOMException("已取消", "AbortError");
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const timeout = new AbortController(); const t = setTimeout(() => timeout.abort(), 25000);
            const stop = () => timeout.abort(); controller.signal.addEventListener("abort", stop);
            try {
              const res = await fetch(src, { credentials: "same-origin", signal: timeout.signal });
              if (!res.ok) { const error = new Error(`高清圖片讀取失敗（${res.status}）`); if (res.status < 500) throw Object.assign(error, { permanent: true }); throw error; }
              if (!res.headers.get("content-type")?.startsWith("image/")) throw Object.assign(new Error("圖片格式不正確"), { permanent: true });
              const blob = await res.blob();
              void putHd(src, blob, flight.pin, runEpoch);
              return blob;
            } finally { clearTimeout(t); controller.signal.removeEventListener("abort", stop); }
          } catch (e) { if (attempt || (e as { permanent?: boolean }).permanent || controller.signal.aborted) throw e; await new Promise((r) => setTimeout(r, 450)); }
        }
        throw new Error("高清圖片讀取失敗");
      } finally { const next = hdWaiters.shift(); if (next) next(); else hdActive--; }
    })();
    hdShared.set(src, flight);
    hdFlights.set(src, flight.promise);
    flight.promise.finally(() => { if (hdShared.get(src) === flight) { hdShared.delete(src); hdFlights.delete(src); } }).catch(() => {});
    f = flight;
  }
  const flight = f;
  if (opts.pin) flight.pin = true;
  flight.users++;
  return new Promise<Blob>((resolve, reject) => {
    let done = false;
    const leave = () => { if (done) return; done = true; opts.signal?.removeEventListener("abort", onAbort); flight.users--; };
    const onAbort = () => { leave(); if (flight.users <= 0) flight.controller.abort(); reject(new DOMException("已取消", "AbortError")); };
    if (opts.signal?.aborted) { onAbort(); return; }
    opts.signal?.addEventListener("abort", onAbort);
    flight.promise.then((b) => { if (!done) { leave(); resolve(b); } }, (e) => { if (!done) { leave(); reject(e); } });
  });
}
/** Export has no thumbnail fallback. Caller must fail the entire export if this throws. */
export async function loadHighResolution(src: string): Promise<HTMLImageElement> {
  const blob = await highResolutionBlob(src), url = URL.createObjectURL(blob);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
}
/** 本機圖片快取用量（離線衣櫃頁顯示）：縮圖、衣物高清圖、角色素材、指定保留數量 */
export async function imageCacheUsage(): Promise<{ thumbs: { count: number; bytes: number }; hd: { count: number; bytes: number }; assets: { count: number; bytes: number }; pinned: number }> {
  const out = { thumbs: { count: 0, bytes: 0 }, hd: { count: 0, bytes: 0 }, assets: { count: 0, bytes: 0 }, pinned: 0 };
  try {
    const c = await caches.open(CACHE), keys = await c.keys();
    for (const k of keys) { const r = await c.match(k); if (r) out.thumbs.bytes += (await r.blob()).size; }
    out.thumbs.count = keys.length;
  } catch { /* 不支援 */ }
  try {
    const c = await caches.open(HD_CACHE), keys = await c.keys();
    for (const k of keys) {
      const r = await c.match(k); if (!r) continue;
      const size = Number(r.headers.get("x-aw-size")) || 0;
      const bucket = new URL(k.url, "https://x").pathname.startsWith("/api/doll/") ? out.assets : out.hd;
      bucket.count++; bucket.bytes += size;
      if (r.headers.get("x-aw-pinned") === "1") out.pinned++;
    }
  } catch { /* 不支援 */ }
  return out;
}
