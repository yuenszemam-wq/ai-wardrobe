/**
 * Phase 3.8C：離線操作佇列（Outbox）。
 *
 * - 位置：本機衣櫃資料庫（aw-local-<帳戶>）已預留的 outbox 資料表；按帳戶分開，登出時連同本機資料一併刪除。
 * - 每個操作有固定的 op_id（重試沿用）：伺服器以 client_key／op_id／圖片 sha256 識別，同一操作重送不會重複建立。
 * - 依次序送出（建立衣物 → 上傳相片；上傳素材 → 保存使用該素材的造型）。後一個操作可以引用前一個操作的結果：
 *   payload 內的 "local:<op_id>:<欄位>" 在送出前換成伺服器回傳的真正 ID。
 * - 失敗分類：網絡／伺服器暫時錯誤＝保留並稍後重試（指數退避）；版本衝突（409）＝標示「衝突」，
 *   等使用者選擇「用我的修改覆寫」、「另存副本」或「捨棄」；其他 4xx＝標示「失敗」並顯示原因，不會無限重試。
 * - 圖片以 ArrayBuffer 保存（部分 Safari 版本在 IndexedDB 保存 Blob 不穩定）。
 * - 觸發：連線恢復（online 事件）、App 開啟、加入新操作時（已連線）、每 30 秒（有待送操作時）。
 */
import { api, ApiError, Garment, intakeUpload, uploadImage } from "./api";
import { kvGet, kvSet, localAccount, outboxRead, outboxWrite, patchLocalGarment, whenLocalReady } from "./localWardrobe";

export type OpKind = "garment.patch" | "garment.create" | "garment.image" | "garment.intake" | "outfit.save" | "look.save" | "studio.asset";
export type OpState = "pending" | "sending" | "failed" | "conflict";
export interface OutboxOp {
  id: string;
  kind: OpKind;
  /** 使用者看到的說明 */
  label: string;
  created_at: number;
  attempts: number;
  next_at: number;
  state: OpState;
  error?: string;
  /** 依賴的操作（必須先完成） */
  after?: string[];
  payload: Record<string, unknown>;
  /** 圖片（ArrayBuffer），鍵＝payload 內的欄位名稱 */
  files?: Record<string, { buf: ArrayBuffer; type: string; name: string }>;
  /** 完成後的結果（供後續操作換算 local: ID） */
  result?: Record<string, string>;
}

const RESULTS_KEY = "outbox:results";
const listeners = new Set<(ops: OutboxOp[]) => void>();
let cache: OutboxOp[] = [];
const emit = () => { for (const l of listeners) l([...cache]); if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("aw:outbox", { detail: cache.length })); };
export function onOutbox(fn: (ops: OutboxOp[]) => void) { listeners.add(fn); fn([...cache]); return () => { listeners.delete(fn); }; }
export const outboxOps = () => [...cache];
export const newOpId = () => { const a = new Uint8Array(10); crypto.getRandomValues(a); return "op_" + [...a].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 18); };

// ───── 儲存（本機衣櫃資料庫的 outbox 資料表，與本機衣櫃共用同一個已開啟的資料庫） ─────
export async function loadOutbox(): Promise<OutboxOp[]> {
  try { await whenLocalReady(); cache = ((await outboxRead<OutboxOp>()) ?? []).sort((a, b) => a.created_at - b.created_at); }
  catch { cache = []; /* 未登入或已登出：不顯示其他帳戶的佇列 */ }
  emit();
  return cache;
}
async function put(op: OutboxOp) { await outboxWrite(op); const i = cache.findIndex((x) => x.id === op.id); if (i >= 0) cache[i] = op; else cache.push(op); emit(); }
async function remove(id: string) { await outboxWrite(null, id); cache = cache.filter((x) => x.id !== id); emit(); }

/** 加入操作；已連線時立即嘗試送出。回傳 op_id */
export async function enqueue(op: Omit<OutboxOp, "id" | "created_at" | "attempts" | "next_at" | "state"> & { id?: string }): Promise<string> {
  const full: OutboxOp = { ...op, id: op.id ?? newOpId(), created_at: Date.now(), attempts: 0, next_at: 0, state: "pending" };
  await put(full);
  if (navigator.onLine) void flushOutbox();
  return full.id;
}
export const fileOf = async (b: Blob, name = "image") => ({ buf: await b.arrayBuffer(), type: b.type || "image/jpeg", name });

// ───── local: ID 換算 ─────
async function results(): Promise<Record<string, Record<string, string>>> { return (await kvGet<Record<string, Record<string, string>>>(RESULTS_KEY).catch(() => undefined)) ?? {}; }
async function saveResult(opId: string, r: Record<string, string>) { const all = await results(); all[opId] = r; const keys = Object.keys(all); for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k]; await kvSet(RESULTS_KEY, all).catch(() => undefined); }
/** payload 內的 local:<op>:<欄位> → 真正 ID；仍未完成的依賴＝null */
export function resolveLocal<T>(payload: T, all: Record<string, Record<string, string>>): T | null {
  let missing = false;
  const out = JSON.parse(JSON.stringify(payload), (_k, v) => {
    if (typeof v !== "string" || !v.startsWith("local:")) return v;
    const [, op, field] = v.split(":");
    const got = all[op]?.[field];
    if (!got) { missing = true; return v; }
    return got;
  });
  return missing ? null : out;
}
/** 本機暫時 ID（畫面顯示用）是否已有伺服器 ID */
export async function realIdOf(local: string): Promise<string | null> { const [, op, field] = local.split(":"); return (await results())[op]?.[field] ?? null; }

/** 離線上傳的素材：畫面使用的圖片（佇列中的檔案）；已同步＝伺服器版本 ID */
export async function localAssetSrc(localVersion: string): Promise<{ src: string | null; real: { asset: string; version: string } | null }> {
  const [, opId] = localVersion.split(":");
  const r = (await results())[opId];
  if (r?.asset && r?.version) return { src: `/api/studio/versions/${r.version}`, real: { asset: r.asset, version: r.version } };
  if (!cache.length) await loadOutbox();
  const op = cache.find((o) => o.id === opId), f = op?.files?.file;
  return { src: f ? URL.createObjectURL(new Blob([f.buf], { type: f.type })) : null, real: null };
}
/** 場景內所有 local:<op> 引用（作為依賴） */
export const localDeps = (v: unknown) => [...new Set([...JSON.stringify(v ?? null).matchAll(/"local:(op_[a-z0-9]+):/g)].map((m) => m[1]))];

// ───── 送出 ─────
let flushing: Promise<void> | null = null;
let again = false;
const transient = (e: unknown) => !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429 || e.status === 0;
export function flushOutbox(): Promise<void> {
  // 送出途中又有新操作（或使用者選擇覆寫／另存）：完成這一輪後再送一次
  if (flushing) { again = true; return flushing; }
  flushing = (async () => {
    try {
      await loadOutbox(); // 每一輪由資料庫讀取最新佇列（覆寫、另存、其他分頁加入的操作）
      const done = new Set<string>();
      for (const op of [...cache]) {
        if (!navigator.onLine) break;
        if (op.state === "conflict" || op.state === "failed") continue;
        if (op.next_at > Date.now()) continue;
        if (op.after?.some((d) => cache.some((x) => x.id === d) && !done.has(d))) continue; // 依賴未完成
        const all = await results();
        const payload = resolveLocal(op.payload, all);
        if (!payload) continue;
        await put({ ...op, state: "sending" });
        try {
          const r = await send(op, payload);
          await saveResult(op.id, r);
          await remove(op.id);
          done.add(op.id);
          window.dispatchEvent(new CustomEvent("aw:outbox-done", { detail: { id: op.id, kind: op.kind, result: r } }));
        } catch (e) {
          const msg = (e as Error).message;
          if (e instanceof ApiError && e.status === 409) await put({ ...op, state: "conflict", error: msg, attempts: op.attempts + 1 });
          else if (transient(e)) await put({ ...op, state: "pending", error: msg, attempts: op.attempts + 1, next_at: Date.now() + Math.min(10 * 60_000, 2000 * 2 ** Math.min(op.attempts, 8)) });
          else await put({ ...op, state: "failed", error: msg, attempts: op.attempts + 1 });
        }
      }
    } finally { flushing = null; if (again) { again = false; void flushOutbox(); } }
  })();
  return flushing;
}

const blobOf = (f: { buf: ArrayBuffer; type: string }) => new Blob([f.buf], { type: f.type });
async function send(op: OutboxOp, p: Record<string, unknown>): Promise<Record<string, string>> {
  switch (op.kind) {
    case "garment.patch": {
      const { id, body, expected_version } = p as { id: string; body: Record<string, unknown>; expected_version?: number };
      const g = await api<Garment>(`/api/garments/${id}`, { method: "PATCH", json: { ...body, ...(expected_version !== undefined ? { expected_version } : {}) } });
      await patchLocalGarment(g).catch(() => undefined);
      return { id: g.id };
    }
    case "garment.create": {
      // client_key＝op_id：重試取回同一件衣物
      const g = await api<Garment>("/api/garments", { method: "POST", json: { ...(p.body as object), client_key: op.id } });
      return { id: g.id };
    }
    case "garment.image": {
      // 圖片以 sha256 去重：同一張相重送不會重複
      const f = op.files?.file; if (!f) throw new ApiError(400, "no_file", "離線相片遺失");
      const r = await uploadImage("/api/images/upload", { garment_id: String(p.garment_id), image_type: String(p.image_type ?? "original"), ...(p.is_primary ? { is_primary: "1" } : {}) }, blobOf(f), f.name);
      return { id: r.id };
    }
    case "garment.intake": {
      // 與上傳中心相同的流程：手機處理（HEIC 轉換、縮圖、自動去背）→ 上傳；伺服器以 SHA-256 去重，重送不會重複建立
      const f = op.files?.file; if (!f) throw new ApiError(400, "no_file", "離線相片遺失");
      const { prepareIntake } = await import("./imageProcessing");
      const file = new File([f.buf], f.name, { type: f.type });
      const p2 = await prepareIntake(file);
      const r = await intakeUpload({ file: p2.original, filename: p2.filename, sha256: p2.sha256, preview: p2.preview, thumbnail: p2.thumbnail, analysis: p2.analysis, cutout: p2.cutout, opaque: p2.opaque });
      return { id: r.garment_id, image: r.image.id };
    }
    case "studio.asset": {
      const f = op.files?.file; if (!f) throw new ApiError(400, "no_file", "離線素材遺失");
      const fd = new FormData();
      fd.set("file", blobOf(f), f.name);
      if (op.files?.thumb) fd.set("thumb", blobOf(op.files.thumb), "thumb");
      for (const k of ["kind", "name"]) fd.set(k, String(p[k] ?? ""));
      if (p.in_library) fd.set("in_library", "1");
      fd.set("op_id", op.id);
      const a = await api<{ id: string; version: { id: string } }>("/api/studio/assets", { method: "POST", body: fd });
      return { asset: a.id, version: a.version.id };
    }
    case "outfit.save": {
      const { id, body } = p as { id: string | null; body: Record<string, unknown> };
      const o = await api<{ id: string; updated_at: string }>(id ? `/api/outfits/${id}` : "/api/outfits", { method: id ? "PATCH" : "POST", json: id ? body : { ...body, op_id: op.id } });
      return { id: o.id, updated_at: o.updated_at };
    }
    case "look.save": {
      const { id, body } = p as { id: string | null; body: Record<string, unknown> };
      const l = await api<{ id: string }>(id ? `/api/doll/looks/${id}` : "/api/doll/looks", { method: id ? "PATCH" : "POST", json: body });
      return { id: l.id };
    }
  }
}

// ───── 衝突及失敗處理 ─────
/** 用我的修改覆寫（移除版本條件後重送） */
export async function overwrite(id: string) {
  const op = cache.find((x) => x.id === id); if (!op) return;
  const payload = { ...op.payload };
  if (op.kind === "garment.patch") delete payload.expected_version;
  if (op.kind === "outfit.save" || op.kind === "look.save") payload.body = { ...(payload.body as object), base_updated_at: undefined };
  await put({ ...op, payload: JSON.parse(JSON.stringify(payload)), state: "pending", error: undefined, next_at: 0 });
  void flushOutbox();
}
/** 另存為新造型（衣服配搭／角色換裝） */
export async function saveAsCopy(id: string) {
  const op = cache.find((x) => x.id === id); if (!op || (op.kind !== "outfit.save" && op.kind !== "look.save")) return;
  const body = { ...(op.payload.body as Record<string, unknown>), base_updated_at: undefined, name: `${String((op.payload.body as { name?: string }).name ?? "造型")}（離線副本）` };
  await put({ ...op, payload: JSON.parse(JSON.stringify({ id: null, body })), state: "pending", error: undefined, next_at: 0 });
  void flushOutbox();
}
export async function retry(id: string) { const op = cache.find((x) => x.id === id); if (op) { await put({ ...op, state: "pending", next_at: 0, error: undefined }); void flushOutbox(); } }
/** 捨棄（同時捨棄依賴它的操作） */
export async function discard(id: string) {
  const drop = new Set([id]);
  let grew = true;
  while (grew) { grew = false; for (const o of cache) if (!drop.has(o.id) && o.after?.some((d) => drop.has(d))) { drop.add(o.id); grew = true; } }
  for (const d of drop) await remove(d);
  window.dispatchEvent(new CustomEvent("aw:outbox-discard", { detail: [...drop] }));
}

/** 啟動：讀取佇列、連線恢復時送出、有待送操作時定期重試 */
let started = false;
export function startOutbox() {
  if (started || typeof window === "undefined") return;
  started = true;
  void loadOutbox().then(() => { if (navigator.onLine) void flushOutbox(); });
  window.addEventListener("online", () => void flushOutbox());
  let acc = localAccount();
  window.addEventListener("aw:local-status", () => { if (localAccount() !== acc) { acc = localAccount(); void loadOutbox().then(() => { if (navigator.onLine) void flushOutbox(); }); } });
  setInterval(() => { if (navigator.onLine && cache.some((o) => o.state === "pending")) void flushOutbox(); }, 30_000);
}
