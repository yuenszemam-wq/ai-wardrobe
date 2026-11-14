/**
 * 離線下載管理及快取修復（Phase 3.8B）。
 * - 下載工作一次一項，在背景執行（每張圖片之間讓出主執行緒），可暫停、繼續、取消未開始的部分；失敗項目可個別重試。
 * - 高清圖片及角色素材以「指定保留」方式保存：普通清理不會刪除。
 * - 不會在使用者未選擇時自動下載全部高清圖片。
 * - 快取修復：找出缺失、損壞（無法解碼）、版本過期、本機索引不一致及已無效的快取，只修復需要修復的項目；
 *   沒有網絡時只檢查本機狀態，不會假稱已從伺服器修復。
 */
import { api, Garment } from "./api";
import { cachedHighResolution, forgetThumb, highResolutionBlob, pinHighResolution, thumbnailBlob } from "./imageCache";
import { localGarments } from "./localWardrobe";

export type JobKind = "thumbs" | "hd" | "assets" | "missing";
export interface JobItem { key: string; label: string; src: string; kind: "thumb" | "hd"; bytes?: number }
export interface JobState { id: number; kind: JobKind; label: string; total: number; done: number; skipped: number; failed: { item: JobItem; message: string }[]; running: boolean; paused: boolean; cancelled: boolean; finished: boolean; bytes: number }

let job: JobState | null = null;
let queue: JobItem[] = [];
let seq = 0;
const listeners = new Set<(j: JobState | null) => void>();
const emit = () => { const s = job ? { ...job, failed: [...job.failed] } : null; for (const l of listeners) l(s); };
export const currentJob = () => (job ? { ...job } : null);
export function onJob(fn: (j: JobState | null) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

const thumbItems = (list: Garment[]): JobItem[] => list.filter((g) => g.thumb_image_id).map((g) => ({ key: g.thumb_image_id!, label: g.name, src: g.thumb_image_id!, kind: "thumb" as const }));
const hdItems = (list: Garment[]): JobItem[] => list.filter((g) => g.primary_image_id).map((g) => ({ key: g.primary_image_id!, label: g.name, src: `/api/images/${g.primary_image_id}`, kind: "hd" as const, bytes: Number((g as Garment & { primary_bytes?: number }).primary_bytes) || undefined }));
/** 估算：高清圖平均大小（未有伺服器提供的檔案大小時） */
const AVG_HD = 1.2 * 1024 * 1024;
export interface Plan { items: JobItem[]; cached: number; toDownload: number; estBytes: number; r2Reads: number }
/** 下載前的計劃：已在手機的項目不會重新下載；估算容量及 R2 讀取次數（Class B） */
export async function planHd(filter: (g: Garment) => boolean): Promise<Plan> {
  const items = hdItems((localGarments() ?? []).filter(filter));
  let cached = 0, est = 0;
  for (const it of items) { if (await cachedHighResolution(it.src)) cached++; else est += it.bytes ?? AVG_HD; }
  return { items, cached, toDownload: items.length - cached, estBytes: est, r2Reads: items.length - cached };
}
export function planThumbs(): Plan {
  const items = thumbItems(localGarments() ?? []);
  // 縮圖來自 D1（不經 R2），每張約 15–30 KB
  return { items, cached: 0, toDownload: items.length, estBytes: items.length * 24 * 1024, r2Reads: 0 };
}
export async function planAssets(): Promise<Plan> {
  const r = await api<{ assets: { id: string; kind: string; name: string; files: { id: string; file_size?: number }[] }[] }>("/api/doll/assets");
  const items: JobItem[] = r.assets.filter((a) => a.kind === "head" || a.kind === "hair").flatMap((a) => a.files.map((f) => ({ key: f.id, label: a.name, src: `/api/doll/files/${f.id}`, kind: "hd" as const, bytes: f.file_size })));
  let cached = 0, est = 0;
  for (const it of items) { if (await cachedHighResolution(it.src)) cached++; else est += it.bytes ?? 300 * 1024; }
  return { items, cached, toDownload: items.length - cached, estBytes: est, r2Reads: items.length - cached };
}

export function startJob(kind: JobKind, label: string, items: JobItem[]) {
  if (job?.running) throw new Error("已有下載工作進行中");
  queue = [...items];
  job = { id: ++seq, kind, label, total: items.length, done: 0, skipped: 0, failed: [], running: true, paused: false, cancelled: false, finished: false, bytes: 0 };
  emit();
  void run(job.id);
}
export function pauseJob(p = true) { if (!job || job.finished) return; job.paused = p; emit(); if (!p) void run(job.id); }
/** 取消：未開始的項目不會下載；已下載的保留 */
export function cancelJob() { if (!job || job.finished) return; job.cancelled = true; queue = []; job.running = false; job.finished = true; emit(); }
export function retryFailed(item?: JobItem) {
  if (!job || job.running) return;
  const list = item ? [item] : job.failed.map((f) => f.item);
  job.failed = job.failed.filter((f) => !list.includes(f.item));
  job.total += 0; job.done -= list.length; queue = list; job.running = true; job.finished = false; job.cancelled = false; job.paused = false;
  emit(); void run(job.id);
}
let worker = 0;
async function run(id: number) {
  if (worker === id) return;
  worker = id;
  try {
    while (job && job.id === id && !job.cancelled && !job.paused && queue.length) {
      const it = queue.shift()!;
      try {
        if (it.kind === "thumb") { const b = await thumbnailBlob(it.src); job.bytes += b.size; }
        else {
          const hit = await cachedHighResolution(it.src);
          if (hit) { await pinHighResolution(it.src); job.skipped++; }
          else { const b = await highResolutionBlob(it.src, { pin: true }); job.bytes += b.size; }
        }
      } catch (e) { job.failed.push({ item: it, message: (e as Error).message || "下載失敗" }); }
      job.done++;
      emit();
      // 讓出主執行緒，避免 iPhone 記憶體及畫面卡頓
      await new Promise((r) => setTimeout(r, 30));
    }
  } finally {
    if (worker === id) worker = 0;
    if (job && job.id === id && !job.paused) { job.running = false; job.finished = true; emit(); }
  }
}

// ───── 檢查及修復快取 ─────
export interface RepairItem { id: string; kind: "thumb" | "hd"; problem: "missing" | "corrupt" | "stale" | "orphan"; label: string; status: "pending" | "fixed" | "failed" | "skipped"; message?: string }
export interface RepairState { phase: "scanning" | "repairing" | "done" | "cancelled"; scanned: number; total: number; ok: number; items: RepairItem[]; offline: boolean }
const THUMB = "aw-private-thumbs-v1", HD = "aw-private-hd-v1";
async function decodable(blob: Blob): Promise<boolean> {
  if (!blob.size) return false;
  try { if (typeof createImageBitmap === "function") { const b = await createImageBitmap(blob); b.close?.(); return true; } } catch { return false; }
  return true;
}
/**
 * 掃描本機圖片快取：缺失（衣櫃有但手機沒有的縮圖）、損壞（無法解碼）、過期版本（縮圖版本與伺服器不同）、
 * 不再有效（衣櫃已沒有引用的非保留高清圖）。onProgress 回報進度；signal 可取消。
 */
export async function scanCache(onProgress: (s: RepairState) => void, signal?: AbortSignal): Promise<RepairState> {
  const st: RepairState = { phase: "scanning", scanned: 0, total: 0, ok: 0, items: [], offline: !navigator.onLine };
  const garments = localGarments() ?? [];
  const byThumb = new Map(garments.filter((g) => g.thumb_image_id).map((g) => [g.thumb_image_id!, g.name]));
  const refs = new Set<string>(); for (const g of garments) for (const k of [g.primary_image_id, g.transparent_image_id, g.thumb_image_id]) if (k) refs.add(`/api/images/${k}`);
  const tc = await caches.open(THUMB), hc = await caches.open(HD);
  const tKeys = await tc.keys(), hKeys = await hc.keys();
  st.total = tKeys.length + hKeys.length + byThumb.size;
  const have = new Map<string, Response>();
  for (const req of tKeys) {
    if (signal?.aborted) { st.phase = "cancelled"; return st; }
    const id = new URL(req.url, location.origin).pathname.split("/").pop()!;
    const r = await tc.match(req);
    st.scanned++;
    if (!r || !(await decodable(await r.clone().blob()))) st.items.push({ id, kind: "thumb", problem: "corrupt", label: byThumb.get(id) ?? id, status: "pending" });
    else { have.set(id, r); st.ok++; }
    if (st.scanned % 20 === 0) onProgress({ ...st });
  }
  for (const req of hKeys) {
    if (signal?.aborted) { st.phase = "cancelled"; return st; }
    const path = new URL(req.url, location.origin).pathname;
    const r = await hc.match(req);
    st.scanned++;
    const pinned = r?.headers.get("x-aw-pinned") === "1";
    if (!r || !(await decodable(await r.clone().blob()))) st.items.push({ id: path, kind: "hd", problem: "corrupt", label: path, status: "pending" });
    else if (path.startsWith("/api/images/") && !refs.has(path) && !pinned && garments.length) st.items.push({ id: path, kind: "hd", problem: "orphan", label: path, status: "pending" });
    else st.ok++;
    if (st.scanned % 10 === 0) onProgress({ ...st });
  }
  for (const [id, name] of byThumb) { st.scanned++; if (!have.has(id) && !st.items.some((x) => x.id === id)) st.items.push({ id, kind: "thumb", problem: "missing", label: name, status: "pending" }); }
  // 過期版本：只取版本（不含圖片資料），與手機保存的版本比較
  if (navigator.onLine && have.size) {
    const ids = [...have.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      if (signal?.aborted) { st.phase = "cancelled"; return st; }
      try {
        const meta = await api<{ items: { image_id: string; version: string }[] }>(`/api/thumbnails?ids=${ids.slice(i, i + 100).join(",")}`);
        for (const m of meta.items) { const r = have.get(m.image_id); if (r && r.headers.get("x-thumbnail-version") !== m.version) { st.items.push({ id: m.image_id, kind: "thumb", problem: "stale", label: byThumb.get(m.image_id) ?? m.image_id, status: "pending" }); st.ok--; } }
        // 伺服器已沒有的縮圖＝不再有效
        const live = new Set(meta.items.map((m) => m.image_id));
        for (const id of ids.slice(i, i + 100)) if (!live.has(id) && !byThumb.has(id)) { st.items.push({ id, kind: "thumb", problem: "orphan", label: id, status: "pending" }); st.ok--; }
      } catch { st.offline = true; }
    }
  }
  st.phase = "done";
  onProgress({ ...st });
  return st;
}
/** 只修復需要修復的項目：刪除損壞／過期／無效的快取，需要時重新下載（離線時不重新下載，標記為略過） */
export async function repairItems(st: RepairState, onProgress: (s: RepairState) => void, only?: RepairItem, signal?: AbortSignal): Promise<RepairState> {
  const tc = await caches.open(THUMB), hc = await caches.open(HD);
  st.phase = "repairing";
  for (const it of only ? [only] : st.items) {
    if (signal?.aborted) { st.phase = "cancelled"; break; }
    if (it.status === "fixed" && !only) continue;
    try {
      if (it.kind === "thumb") {
        if (it.problem !== "missing") await tc.delete("/api/thumbnails/" + it.id);
        if (it.problem === "orphan") it.status = "fixed";
        else if (!navigator.onLine) { it.status = "skipped"; it.message = "需要網絡才能重新下載"; }
        else { forgetThumb(it.id); await thumbnailBlob(it.id); it.status = "fixed"; }
      } else {
        const old = await hc.match(it.id);
        const pinned = old?.headers.get("x-aw-pinned") === "1";
        await hc.delete(it.id);
        if (it.problem === "orphan") it.status = "fixed";
        else if (!navigator.onLine) { it.status = "skipped"; it.message = "需要網絡才能重新下載"; }
        else { await highResolutionBlob(it.id, { pin: pinned }); it.status = "fixed"; }
      }
    } catch (e) { it.status = "failed"; it.message = (e as Error).message || "修復失敗"; }
    onProgress({ ...st, items: [...st.items] });
  }
  if (st.phase !== "cancelled") st.phase = "done";
  onProgress({ ...st, items: [...st.items] });
  return st;
}
