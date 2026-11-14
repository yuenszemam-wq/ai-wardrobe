/**
 * Phase 3.8B：R2 用量及費用。
 * 1. 統一的 R2 存取包裝：所有 Worker 程式經 env.IMAGES 的操作都會按「用途（物件路徑）×操作類別」計數，
 *    請求結束時一次寫入 D1 r2_usage（未建立資料表時不影響正常功能）。只計真正向 R2 發出的操作（Worker 內部），
 *    不把 HTTP 圖片請求當作 R2 讀取；瀏覽器本機快取命中由前端另外統計。
 * 2. Cloudflare 官方用量：GraphQL Analytics API（r2OperationsAdaptiveGroups、r2StorageAdaptiveGroups），
 *    需要 Worker Secret CF_API_TOKEN（Account Analytics: Read）及 CF_ACCOUNT_ID。Token 只在後端使用。
 *    結果快取 10 分鐘，避免用量頁本身產生成本；不掃描 Bucket。
 * 3. 官方數據與 App 自身統計分開標示；取不到官方數據時不顯示虛構數字。
 */
import { Env, nowIso } from "./util";

/** Cloudflare R2 Standard 官方定價（2026-11-14 於 https://developers.cloudflare.com/r2/pricing/ 核對；可能更改） */
export const R2_PRICING = { checked_at: "2026-11-14", source: "https://developers.cloudflare.com/r2/pricing/", storage_class: "Standard", free: { gb_month: 10, class_a: 1_000_000, class_b: 10_000_000 }, price: { gb_month: 0.015, class_a_per_million: 4.5, class_b_per_million: 0.36 }, egress: "免費" };
const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration"]);
const CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);
export const classOf = (action: string): "class_a" | "class_b" | "free" => (CLASS_A.has(action) ? "class_a" : CLASS_B.has(action) ? "class_b" : "free");

export const PURPOSES: [string, string][] = [["originals", "衣物原圖"], ["processed", "去背圖片（衣物高清圖）"], ["thumbnails", "舊版 R2 縮圖"], ["outfits", "穿搭圖片"], ["doll_assets", "頭部、髮件及衣物部件"], ["doll_models", "自訂身體素材"], ["home_bg", "首頁背景"], ["other", "其他 R2 物件"]];
export function purposeOf(key: string): string {
  if (key.startsWith("originals/")) return "originals";
  if (key.startsWith("processed/")) return "processed";
  if (key.startsWith("thumbnails/")) return "thumbnails";
  if (key.startsWith("outfits/")) return "outfits";
  if (key.startsWith("doll/assets/")) return "doll_assets";
  if (key.startsWith("doll/models/")) return "doll_models";
  if (key.startsWith("settings/home-bg")) return "home_bg";
  return "other";
}
export type Counter = Map<string, number>;
const bump = (c: Counter, purpose: string, op: string, n = 1) => { const k = purpose + "|" + op; c.set(k, (c.get(k) ?? 0) + n); };

/** 包裝 R2 bucket：計算每個操作；行為與原本完全相同 */
export function meteredBucket(bucket: R2Bucket, c: Counter): R2Bucket {
  const keyOf = (k: unknown) => (typeof k === "string" ? k : Array.isArray(k) ? String(k[0] ?? "") : "");
  return new Proxy(bucket, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        const name = String(prop);
        if (name === "get" || name === "head") bump(c, purposeOf(keyOf(args[0])), "class_b");
        else if (name === "put" || name === "createMultipartUpload") bump(c, purposeOf(keyOf(args[0])), "class_a");
        else if (name === "list") bump(c, purposeOf(String((args[0] as { prefix?: string } | undefined)?.prefix ?? "")), "class_a");
        else if (name === "delete") { const keys = Array.isArray(args[0]) ? (args[0] as string[]) : [keyOf(args[0])]; for (const k of keys) bump(c, purposeOf(k), "free"); }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
export const envName = (env: Env) => (env.AW_ENV === "production" || env.AW_ENV === "preview" ? env.AW_ENV : "test");
const month = () => new Date().toISOString().slice(0, 7);
/** 請求結束：一次寫入計數（資料表未建立或寫入失敗都不影響正常功能） */
export async function flushUsage(env: Env, c: Counter) {
  if (!c.size) return;
  const m = month(), e = envName(env), now = nowIso();
  try {
    await env.DB.batch([...c].map(([k, n]) => { const [purpose, op] = k.split("|"); return env.DB.prepare("INSERT INTO r2_usage (month, env, purpose, op, n, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(month, env, purpose, op) DO UPDATE SET n = n + excluded.n, updated_at = excluded.updated_at").bind(m, e, purpose, op, n, now); }));
  } catch (err) { console.warn("r2_usage_flush", String(err)); }
  c.clear();
}

// ───── 官方用量（GraphQL Analytics API） ─────
interface Official { available: boolean; reason?: string; missing?: string[]; message?: string; fetched_at?: string; delay_note?: string;
  account?: { class_a: number; class_b: number; free: number; storage_bytes: number | null; objects: number | null; gb_month_est: number | null; days: number };
  buckets?: Record<string, { class_a: number; class_b: number; storage_bytes: number | null; objects: number | null }> }
const CACHE_KEY = "r2_official_cache";
export async function officialUsage(env: Env, force = false): Promise<Official> {
  const missing = [!env.CF_API_TOKEN && "CF_API_TOKEN（Worker Secret，權限：Account › Account Analytics › Read）", !env.CF_ACCOUNT_ID && "CF_ACCOUNT_ID（Cloudflare 帳戶 ID）"].filter(Boolean) as string[];
  if (missing.length) return { available: false, reason: "missing_config", missing };
  if (!force) {
    const hit = await env.DB.prepare("SELECT value, updated_at FROM app_settings WHERE key = ?").bind(CACHE_KEY).first<{ value: string; updated_at: string }>().catch(() => null);
    if (hit && Date.now() - Date.parse(hit.updated_at) < 10 * 60 * 1000) { try { return JSON.parse(hit.value) as Official; } catch { /* 重新取得 */ } }
  }
  const now = new Date(), start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const days = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 864e5));
  const query = `query($a: string!, $s: Time, $e: Time, $sd: Date, $ed: Date) { viewer { accounts(filter: { accountTag: $a }) {
    ops: r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $s, datetime_leq: $e }) { sum { requests } dimensions { actionType bucketName } }
    st: r2StorageAdaptiveGroups(limit: 10000, filter: { date_geq: $sd, date_leq: $ed }) { max { payloadSize metadataSize objectCount } dimensions { date bucketName } }
  } } }`;
  let res: Response;
  try {
    res = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, s: start.toISOString(), e: now.toISOString(), sd: start.toISOString().slice(0, 10), ed: now.toISOString().slice(0, 10) } }) });
  } catch (e) { return { available: false, reason: "network", message: "暫時無法連線 Cloudflare API：" + String(e) }; }
  if (res.status === 401 || res.status === 403) return { available: false, reason: "permission", message: "Token 沒有讀取帳戶 Analytics 的權限（需要 Account › Account Analytics › Read）" };
  if (!res.ok) return { available: false, reason: "api_error", message: `Cloudflare API 暫時失敗（${res.status}）` };
  const body = (await res.json()) as { data?: { viewer?: { accounts?: { ops: { sum: { requests: number }; dimensions: { actionType: string; bucketName: string } }[]; st: { max: { payloadSize: number; metadataSize: number; objectCount: number }; dimensions: { date: string; bucketName: string } }[] }[] } }; errors?: { message: string }[] };
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join("；");
    return { available: false, reason: /auth|permission|not authorized/i.test(msg) ? "permission" : "api_error", message: msg };
  }
  const acc = body.data?.viewer?.accounts?.[0];
  if (!acc) return { available: false, reason: "api_error", message: "找不到帳戶資料（請核對 CF_ACCOUNT_ID）" };
  const buckets: NonNullable<Official["buckets"]> = {};
  const account = { class_a: 0, class_b: 0, free: 0, storage_bytes: null as number | null, objects: null as number | null, gb_month_est: null as number | null, days };
  for (const o of acc.ops) {
    const cls = classOf(o.dimensions.actionType), n = o.sum.requests;
    account[cls] += n;
    const b = (buckets[o.dimensions.bucketName] ??= { class_a: 0, class_b: 0, storage_bytes: null, objects: null });
    if (cls !== "free") b[cls] += n;
  }
  // 儲存：每個 Bucket 最新一日的容量；GB-month 由每日容量總和 ÷ 該月日數估算（官方帳單以實際計量為準）
  const byDay = new Map<string, number>(), latest = new Map<string, { date: string; size: number; objects: number }>();
  for (const s of acc.st) {
    const size = (s.max.payloadSize ?? 0) + (s.max.metadataSize ?? 0);
    byDay.set(s.dimensions.date, (byDay.get(s.dimensions.date) ?? 0) + size);
    const cur = latest.get(s.dimensions.bucketName);
    if (!cur || s.dimensions.date > cur.date) latest.set(s.dimensions.bucketName, { date: s.dimensions.date, size, objects: s.max.objectCount ?? 0 });
  }
  if (latest.size) {
    account.storage_bytes = [...latest.values()].reduce((a, b) => a + b.size, 0);
    account.objects = [...latest.values()].reduce((a, b) => a + b.objects, 0);
    for (const [name, v] of latest) { const b = (buckets[name] ??= { class_a: 0, class_b: 0, storage_bytes: null, objects: null }); b.storage_bytes = v.size; b.objects = v.objects; }
    const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    account.gb_month_est = [...byDay.values()].reduce((a, b) => a + b, 0) / 1e9 / dim;
  }
  const out: Official = { available: true, fetched_at: nowIso(), delay_note: "Cloudflare Analytics 數據可能延遲數分鐘至數小時；免費額度由整個 Cloudflare 帳戶所有 Bucket 共用。", account, buckets };
  await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(CACHE_KEY, JSON.stringify(out), nowIso()).run().catch(() => undefined);
  return out;
}

/** App 自身：按用途的物件數量及容量（由 D1 圖片記錄計算，不掃描 R2）＋本月操作計數 */
export async function appUsage(env: Env) {
  const storage: Record<string, { objects: number; bytes: number }> = Object.fromEntries(PURPOSES.map(([k]) => [k, { objects: 0, bytes: 0 }]));
  // 衣物及穿搭圖片：按圖片類型分類（原圖／去背圖／縮圖），不依賴 R2 路徑格式
  const TYPE: Record<string, string> = { original: "originals", processed: "processed", thumbnail: "thumbnails" };
  const g = await env.DB.prepare("SELECT image_type AS t, COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS b FROM garment_images GROUP BY image_type").all<{ t: string; n: number; b: number }>().catch(() => ({ results: [] as { t: string; n: number; b: number }[] }));
  for (const r of g.results) { const p = TYPE[r.t] ?? "other"; storage[p].objects += r.n; storage[p].bytes += r.b; }
  const o = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS b FROM outfit_images").first<{ n: number; b: number }>().catch(() => null);
  if (o) { storage.outfits.objects += o.n; storage.outfits.bytes += o.b; }
  const dollAssets = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(file_size),0) AS b FROM doll_asset_files").first<{ n: number; b: number }>().catch(() => null);
  if (dollAssets) { storage.doll_assets.objects += dollAssets.n; storage.doll_assets.bytes += dollAssets.b; }
  const dollModels = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(file_size),0) AS b FROM doll_model_files").first<{ n: number; b: number }>().catch(() => null);
  if (dollModels) { storage.doll_models.objects += dollModels.n; storage.doll_models.bytes += dollModels.b; }
  const bg = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'home_bg'").first<{ value: string }>().catch(() => null);
  if (bg) { try { const o = JSON.parse(bg.value) as { size?: number }; storage.home_bg.objects += 1; storage.home_bg.bytes += Number(o.size) || 0; } catch { /* ignore */ } }
  let ops: { purpose: string; op: string; n: number }[] = [], table = true;
  try { ops = (await env.DB.prepare("SELECT purpose, op, SUM(n) AS n FROM r2_usage WHERE month = ? AND env = ? GROUP BY purpose, op").bind(month(), envName(env)).all<{ purpose: string; op: string; n: number }>()).results; } catch { table = false; }
  const thumbs = await env.DB.prepare("SELECT COALESCE(SUM(r2_reads),0) AS n FROM thumbnail_usage WHERE day LIKE ?").bind(month() + "%").first<{ n: number }>().catch(() => null);
  return { env: envName(env), month: month(), storage, ops, counting: table, thumbnail_backfill_reads: thumbs?.n ?? 0, note: "物件數量及容量由 D1 圖片記錄計算（不掃描 R2）；操作次數只包括這個 Worker 由統計開始後發出的 R2 操作。" };
}

export interface AlertSettings { warn: number[]; soft_limit: number }
export const DEFAULT_ALERTS: AlertSettings = { warn: [70, 85, 95], soft_limit: 90 };
export async function alertSettings(env: Env): Promise<AlertSettings> {
  const r = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'r2_alerts'").first<{ value: string }>().catch(() => null);
  try { const o = r ? (JSON.parse(r.value) as Partial<AlertSettings>) : {}; const warn = (Array.isArray(o.warn) ? o.warn : DEFAULT_ALERTS.warn).map(Number).filter((x) => x > 0 && x <= 100).sort((a, b) => a - b).slice(0, 5); return { warn: warn.length ? warn : DEFAULT_ALERTS.warn, soft_limit: Math.min(100, Math.max(10, Number(o.soft_limit) || DEFAULT_ALERTS.soft_limit)) }; }
  catch { return DEFAULT_ALERTS; }
}
/** 免費額度使用比例（以官方數據為主；沒有官方數據時用 App 自身統計，並標示為估算） */
export function freeTierUse(off: Official, app: Awaited<ReturnType<typeof appUsage>>) {
  if (off.available && off.account) {
    const a = off.account;
    return { source: "official" as const, class_a: a.class_a / R2_PRICING.free.class_a, class_b: a.class_b / R2_PRICING.free.class_b, storage: a.gb_month_est == null ? null : a.gb_month_est / R2_PRICING.free.gb_month };
  }
  const sum = (op: string) => app.ops.filter((o) => o.op === op).reduce((s, o) => s + o.n, 0);
  const bytes = Object.values(app.storage).reduce((s, x) => s + x.bytes, 0);
  return { source: "app_estimate" as const, class_a: sum("class_a") / R2_PRICING.free.class_a, class_b: sum("class_b") / R2_PRICING.free.class_b, storage: bytes / 1e9 / R2_PRICING.free.gb_month };
}
/** 預計費用（只計超出免費額度的部分；只是估算，以 Cloudflare 帳單為準） */
export function estimateCost(off: Official) {
  if (!off.available || !off.account) return null;
  const a = off.account, f = R2_PRICING.free, p = R2_PRICING.price;
  const storage = a.gb_month_est == null ? null : Math.max(0, a.gb_month_est - f.gb_month) * p.gb_month;
  const ca = Math.max(0, a.class_a - f.class_a) / 1e6 * p.class_a_per_million, cb = Math.max(0, a.class_b - f.class_b) / 1e6 * p.class_b_per_million;
  return { storage, class_a: ca, class_b: cb, total: (storage ?? 0) + ca + cb, currency: "USD" };
}
/**
 * 保守軟上限：接近免費額度時，優先限制「非必要背景工作」（縮圖補建、批量離線下載）。
 * 正常查看、上傳及保存不受影響。這不是 Cloudflare 官方硬上限；數據延遲、其他專案共用額度或並行操作都可能令實際用量更高。
 */
export async function backgroundAllowed(env: Env): Promise<{ allowed: boolean; reason?: string }> {
  const hit = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(CACHE_KEY).first<{ value: string }>().catch(() => null);
  if (!hit) return { allowed: true };
  try {
    const off = JSON.parse(hit.value) as Official;
    if (!off.available || !off.account) return { allowed: true };
    const al = await alertSettings(env);
    const use = Math.max(off.account.class_a / R2_PRICING.free.class_a, off.account.class_b / R2_PRICING.free.class_b, off.account.gb_month_est == null ? 0 : off.account.gb_month_est / R2_PRICING.free.gb_month);
    return use * 100 >= al.soft_limit ? { allowed: false, reason: `R2 免費額度已用 ${Math.round(use * 100)}%（軟上限 ${al.soft_limit}%）：暫停非必要背景工作` } : { allowed: true };
  } catch { return { allowed: true }; }
}
