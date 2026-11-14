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

/** Cloudflare R2 Standard 官方定價（2026-11-15 於 https://developers.cloudflare.com/r2/pricing/ 核對；可能更改）。
 * 免費額度只適用於 Standard 儲存類型（Infrequent Access 沒有免費額度，不可混合）。
 * GB-month＝計費期間（30 日）內每日「最高」儲存量的平均；計費時向上取整至下一個單位（例如 1.1 GB-month 按 2 GB-month、100 萬零 1 次按 200 萬次）。 */
export const R2_PRICING = { checked_at: "2026-11-15", source: "https://developers.cloudflare.com/r2/pricing/", storage_class: "Standard", free: { gb_month: 10, class_a: 1_000_000, class_b: 10_000_000 }, price: { gb_month: 0.015, class_a_per_million: 4.5, class_b_per_million: 0.36 }, egress: "免費", billing_period_days: 30, rounding: "向上取整至下一個計費單位" };
const CLASS_A = new Set(["ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption", "PutBucketCors", "PutBucketLifecycleConfiguration"]);
const CLASS_B = new Set(["HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors", "GetBucketLifecycleConfiguration"]);
const FREE_OPS = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload", "DeleteObjects"]);
export type OpClass = "class_a" | "class_b" | "free" | "unknown";
/** 官方分類；文件沒有列出的操作標示為 unknown（不會當作免費） */
export const classOf = (action: string): OpClass => (CLASS_A.has(action) ? "class_a" : CLASS_B.has(action) ? "class_b" : FREE_OPS.has(action) ? "free" : "unknown");

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
/** 每日官方數據；null＝該日沒有官方資料（不是零），partial＝今日尚未完結 */
export interface DayRow { date: string; class_a: number | null; class_b: number | null; free: number | null; unknown: number | null; storage_bytes: number | null; objects: number | null; partial?: boolean }
export interface BucketUse { class_a: number; class_b: number; free: number; unknown: number; storage_bytes: number | null; objects: number | null }
export interface Official { available: boolean; reason?: string; missing?: string[]; message?: string; fetched_at?: string; delay_note?: string;
  /** 官方請求失敗時，顯示的是最後一次成功取得的數據 */
  stale?: boolean; stale_reason?: string; stale_message?: string; attempted_at?: string;
  /** 手動重新整理過於頻密：沿用快取 */
  cooldown_s?: number;
  account?: { class_a: number; class_b: number; free: number; unknown: number; unknown_actions: string[]; storage_bytes: number | null; objects: number | null; gb_month_est: number | null; storage_days: number; days: number; days_in_month: number; month: string };
  buckets?: Record<string, BucketUse>;
  daily?: { available: boolean; note?: string; start: string; end: string; days: DayRow[]; truncated: boolean };
}
const CACHE_KEY = "r2_official_cache";
const LAST_OK_KEY = "r2_official_last_ok";
const FRESH_MS = 10 * 60 * 1000, FAIL_MS = 2 * 60 * 1000, COOLDOWN_MS = 30 * 1000, GQL_LIMIT = 10000;
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
type OpsRow = { sum: { requests: number }; dimensions: { actionType: string; bucketName: string; date?: string } };
type StRow = { max: { payloadSize: number; metadataSize: number; objectCount: number }; dimensions: { date: string; bucketName: string } };

async function readSetting<T>(env: Env, key: string): Promise<{ value: T; updated_at: string } | null> {
  const hit = await env.DB.prepare("SELECT value, updated_at FROM app_settings WHERE key = ?").bind(key).first<{ value: string; updated_at: string }>().catch(() => null);
  if (!hit) return null;
  try { return { value: JSON.parse(hit.value) as T, updated_at: hit.updated_at }; } catch { return null; }
}
const writeSetting = (env: Env, key: string, v: unknown) => env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, JSON.stringify(v), nowIso()).run().catch(() => undefined);

/** 官方請求失敗：有上次成功數據就顯示它（標明可能已過時），否則如實回報失敗 */
async function withStale(env: Env, fail: Official): Promise<Official> {
  if (fail.reason === "missing_config") return fail;
  const ok = await readSetting<Official>(env, LAST_OK_KEY);
  if (!ok?.value?.available) return fail;
  return { ...ok.value, stale: true, stale_reason: fail.reason, stale_message: fail.message, attempted_at: fail.attempted_at ?? nowIso() };
}

async function gql(env: Env, query: string, variables: Record<string, unknown>): Promise<{ ok: true; acc: { ops: OpsRow[]; st: StRow[] } } | { ok: false; fail: Official; schema?: boolean }> {
  let res: Response;
  try {
    res = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  } catch (e) { return { ok: false, fail: { available: false, reason: "network", message: "暫時無法連線 Cloudflare API：" + String(e) } }; }
  if (res.status === 401 || res.status === 403) return { ok: false, fail: { available: false, reason: "permission", message: "Token 沒有讀取帳戶 Analytics 的權限（需要 Account › Account Analytics › Read）" } };
  if (!res.ok) return { ok: false, fail: { available: false, reason: "api_error", message: `Cloudflare API 暫時失敗（${res.status}）` } };
  const body = (await res.json().catch(() => ({}))) as { data?: { viewer?: { accounts?: { ops: OpsRow[]; st: StRow[] }[] } }; errors?: { message: string }[] };
  if (body.errors?.length) {
    const msg = body.errors.map((e) => e.message).join("；");
    if (/auth|permission|not authorized/i.test(msg)) return { ok: false, fail: { available: false, reason: "permission", message: msg } };
    return { ok: false, fail: { available: false, reason: "api_error", message: msg }, schema: /unknown|cannot query|field|argument|dimension/i.test(msg) };
  }
  const acc = body.data?.viewer?.accounts?.[0];
  if (!acc) return { ok: false, fail: { available: false, reason: "api_error", message: "找不到帳戶資料（請核對 CF_ACCOUNT_ID）" } };
  return { ok: true, acc: { ops: acc.ops ?? [], st: acc.st ?? [] } };
}

/**
 * 由官方原始分組建立結果（純函數，方便測試）。
 * - 本月合計只計算本月（UTC）日期；每日資料涵蓋最近最多 31 日。
 * - 沒有出現的日期＝null（沒有官方資料），不當作零；今日標示 partial。
 * - GB-month（估算）＝本月每日最高儲存量總和 ÷ 30 日（官方計費期間）；缺失日期不計入並另外列出涵蓋日數。
 */
export function buildOfficial(acc: { ops: OpsRow[]; st: StRow[] }, now: Date, start: Date, daily: boolean): Official {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const ms = dayStr(monthStart), today = dayStr(now);
  const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const days = Math.max(1, Math.ceil((now.getTime() - monthStart.getTime()) / 864e5));
  const buckets: Record<string, BucketUse> = {};
  const bucket = (n: string) => (buckets[n] ??= { class_a: 0, class_b: 0, free: 0, unknown: 0, storage_bytes: null, objects: null });
  const account = { class_a: 0, class_b: 0, free: 0, unknown: 0, unknown_actions: [] as string[], storage_bytes: null as number | null, objects: null as number | null, gb_month_est: null as number | null, storage_days: 0, days, days_in_month: dim, month: ms.slice(0, 7) };
  const unknownSet = new Set<string>();
  const dayMap = new Map<string, DayRow>();
  const row = (d: string) => { let r = dayMap.get(d); if (!r) { r = { date: d, class_a: null, class_b: null, free: null, unknown: null, storage_bytes: null, objects: null }; dayMap.set(d, r); } return r; };
  for (const o of acc.ops) {
    const cls = classOf(o.dimensions.actionType), n = Number(o.sum?.requests) || 0;
    if (cls === "unknown") unknownSet.add(o.dimensions.actionType);
    const d = o.dimensions.date;
    // 沒有日期維度（舊查詢）＝整個查詢範圍就是本月
    if (!d || d >= ms) { account[cls] += n; bucket(o.dimensions.bucketName)[cls] += n; }
    if (d && daily) { const r = row(d); r[cls] = (r[cls] ?? 0) + n; }
  }
  // 有任何操作的日期：其餘類別確實為 0（同一日已有官方資料）
  for (const r of dayMap.values()) if (r.class_a != null || r.class_b != null || r.free != null || r.unknown != null) { r.class_a ??= 0; r.class_b ??= 0; r.free ??= 0; r.unknown ??= 0; }
  const latest = new Map<string, { date: string; size: number; objects: number }>();
  const storageByDay = new Map<string, { size: number; objects: number }>();
  for (const s of acc.st) {
    const size = (Number(s.max?.payloadSize) || 0) + (Number(s.max?.metadataSize) || 0), objs = Number(s.max?.objectCount) || 0;
    const t = storageByDay.get(s.dimensions.date) ?? { size: 0, objects: 0 };
    storageByDay.set(s.dimensions.date, { size: t.size + size, objects: t.objects + objs });
    const cur = latest.get(s.dimensions.bucketName);
    if (!cur || s.dimensions.date > cur.date) latest.set(s.dimensions.bucketName, { date: s.dimensions.date, size, objects: objs });
  }
  if (latest.size) {
    account.storage_bytes = [...latest.values()].reduce((a, b) => a + b.size, 0);
    account.objects = [...latest.values()].reduce((a, b) => a + b.objects, 0);
    for (const [name, v] of latest) { const b = bucket(name); b.storage_bytes = v.size; b.objects = v.objects; }
    const monthDays = [...storageByDay.entries()].filter(([d]) => d >= ms);
    account.storage_days = monthDays.length;
    account.gb_month_est = monthDays.length ? monthDays.reduce((a, [, v]) => a + v.size, 0) / 1e9 / R2_PRICING.billing_period_days : null;
  }
  account.unknown_actions = [...unknownSet].sort();
  if (daily) for (const [d, v] of storageByDay) { const r = row(d); r.storage_bytes = v.size; r.objects = v.objects; }
  const list: DayRow[] = [];
  if (daily) for (let d = new Date(start); dayStr(d) <= today; d = addDays(d, 1)) { const k = dayStr(d); const r = dayMap.get(k) ?? { date: k, class_a: null, class_b: null, free: null, unknown: null, storage_bytes: null, objects: null }; if (k === today) r.partial = true; list.push(r); }
  return {
    available: true, fetched_at: nowIso(),
    delay_note: "Cloudflare Analytics 數據可能延遲數分鐘至數小時；免費額度由整個 Cloudflare 帳戶所有 Bucket 共用。",
    account, buckets,
    daily: daily
      ? { available: true, start: dayStr(start), end: today, days: list, truncated: acc.ops.length >= GQL_LIMIT || acc.st.length >= GQL_LIMIT }
      : { available: false, note: "Cloudflare 未能提供每日操作數據，暫時只顯示本月合計。", start: ms, end: today, days: [], truncated: acc.ops.length >= GQL_LIMIT },
  };
}

export async function officialUsage(env: Env, force = false): Promise<Official> {
  const missing = [!env.CF_API_TOKEN && "CF_API_TOKEN（Worker Secret，權限：Account › Account Analytics › Read）", !env.CF_ACCOUNT_ID && "CF_ACCOUNT_ID（Cloudflare 帳戶 ID）"].filter(Boolean) as string[];
  if (missing.length) return { available: false, reason: "missing_config", missing };
  const cache = await readSetting<Official>(env, CACHE_KEY);
  const age = cache ? Date.now() - Date.parse(cache.updated_at) : Infinity;
  if (cache) {
    const fresh = cache.value.available ? age < FRESH_MS : age < FAIL_MS;
    if (force && age < COOLDOWN_MS) {
      const v = cache.value.available ? cache.value : await withStale(env, cache.value);
      return { ...v, cooldown_s: Math.ceil((COOLDOWN_MS - age) / 1000) };
    }
    if (!force && fresh) return cache.value.available ? cache.value : withStale(env, cache.value);
  }
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // 每日資料：最近 30 日及本月（較早者），最多 31 日（GraphQL 單次查詢範圍限制內）
  const start = new Date(Math.min(monthStart.getTime(), addDays(todayStart, -29).getTime()));
  const vars = { a: env.CF_ACCOUNT_ID, s: start.toISOString(), e: now.toISOString(), sd: dayStr(start), ed: dayStr(now) };
  const daily = `query($a: string!, $s: Time, $e: Time, $sd: Date, $ed: Date) { viewer { accounts(filter: { accountTag: $a }) {
    ops: r2OperationsAdaptiveGroups(limit: ${GQL_LIMIT}, filter: { datetime_geq: $s, datetime_leq: $e }) { sum { requests } dimensions { date actionType bucketName } }
    st: r2StorageAdaptiveGroups(limit: ${GQL_LIMIT}, filter: { date_geq: $sd, date_leq: $ed }) { max { payloadSize metadataSize objectCount } dimensions { date bucketName } }
  } } }`;
  let r = await gql(env, daily, vars);
  let out: Official;
  if (r.ok) out = buildOfficial(r.acc, now, start, true);
  else if (r.schema) {
    // 舊版查詢（只取本月合計），確保每日維度不可用時仍有官方數據
    const legacy = daily.replace("dimensions { date actionType bucketName }", "dimensions { actionType bucketName }");
    r = await gql(env, legacy, { ...vars, s: monthStart.toISOString(), sd: dayStr(monthStart) });
    if (r.ok) out = buildOfficial(r.acc, now, monthStart, false);
    else out = { ...r.fail, attempted_at: nowIso() };
  } else out = { ...r.fail, attempted_at: nowIso() };
  await writeSetting(env, CACHE_KEY, out);
  if (out.available) { await writeSetting(env, LAST_OK_KEY, out); return out; }
  return withStale(env, out);
}

/** 最後一次成功的官方數據（背景保護使用；不會觸發 API 請求） */
export async function lastOfficial(env: Env): Promise<{ off: Official; age_ms: number } | null> {
  const ok = await readSetting<Official>(env, LAST_OK_KEY) ?? await readSetting<Official>(env, CACHE_KEY);
  if (!ok?.value?.available || !ok.value.account) return null;
  return { off: ok.value, age_ms: Date.now() - Date.parse(ok.value.fetched_at ?? ok.updated_at) };
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
/**
 * 免費額度使用比例。
 * - 官方數據（可能是過時的最後一次成功數據，會標示 stale）。
 * - 沒有官方數據時用 App 自身操作次數估算；App 只知道「目前容量」，不能當作 GB-month，所以 storage＝null。
 */
export function freeTierUse(off: Official, app: Awaited<ReturnType<typeof appUsage>>) {
  if (off.available && off.account) {
    const a = off.account;
    return { source: "official" as const, stale: !!off.stale, class_a: a.class_a / R2_PRICING.free.class_a, class_b: a.class_b / R2_PRICING.free.class_b, storage: a.gb_month_est == null ? null : a.gb_month_est / R2_PRICING.free.gb_month };
  }
  const sum = (op: string) => app.ops.filter((o) => o.op === op).reduce((s, o) => s + o.n, 0);
  return { source: "app_estimate" as const, stale: false, class_a: sum("class_a") / R2_PRICING.free.class_a, class_b: sum("class_b") / R2_PRICING.free.class_b, storage: null };
}

/** 超額費用（按官方規則向上取整至下一個計費單位）。未知數值＝null，不會當作 0。 */
export function costOf(use: { class_a: number; class_b: number; gb_month: number | null; unknown?: number }) {
  const f = R2_PRICING.free, p = R2_PRICING.price;
  const units = (x: number, unit: number) => Math.max(0, Math.ceil(x / unit - 1e-9));
  const storage = use.gb_month == null ? null : units(Math.max(0, use.gb_month - f.gb_month), 1) * p.gb_month;
  const ca = units(Math.max(0, use.class_a - f.class_a), 1e6) * p.class_a_per_million;
  const cb = units(Math.max(0, use.class_b - f.class_b), 1e6) * p.class_b_per_million;
  const known = ca + cb + (storage ?? 0);
  return { storage, class_a: ca, class_b: cb, known, total: storage == null ? null : known, partial: storage == null || (use.unknown ?? 0) > 0, unknown_ops: use.unknown ?? 0, currency: "USD" };
}
/** 本月預計費用（只計超出免費額度；只是估算，以 Cloudflare 帳單為準） */
export function estimateCost(off: Official) {
  if (!off.available || !off.account) return null;
  const a = off.account;
  return { ...costOf({ class_a: a.class_a, class_b: a.class_b, gb_month: a.gb_month_est, unknown: a.unknown }), stale: !!off.stale };
}

/**
 * 月底預測（估算）：只使用本月「已完結」日子的官方每日數據（今日未完結，不計）。
 * 至少需要 3 個完整日子，而且有數據的日子佔已完結日子一半以上；否則回傳「暫未有足夠資料」。
 * 操作：有數據日子的實際總和＋每日平均 ×（餘下日數＋缺少數據的日子）。
 * GB-month：已有日子的每日儲存量總和＋最新一日容量 × 餘下日數，÷ 30 日。
 */
export function forecast(off: Official) {
  const a = off.account, d = off.daily;
  if (!off.available || !a || !d?.available) return { available: false as const, reason: "暫未有足夠資料：未有官方每日數據" };
  const ms = a.month + "-01";
  const done = d.days.filter((r) => r.date >= ms && !r.partial);
  const ops = done.filter((r) => r.class_a != null && r.class_b != null);
  if (ops.length < 3 || ops.length < done.length * 0.5) return { available: false as const, reason: `暫未有足夠資料：本月 ${done.length} 個完整日子中只有 ${ops.length} 日有官方數據（最少需要 3 日及一半日子）` };
  // 餘下日數（包括今日）及缺少官方數據的日子，都以已有日子的平均值估算
  const missing = done.length - ops.length, remaining = a.days_in_month - done.length;
  const sumA = ops.reduce((s, r) => s + (r.class_a ?? 0), 0), sumB = ops.reduce((s, r) => s + (r.class_b ?? 0), 0);
  const projA = Math.round(sumA + (sumA / ops.length) * (remaining + missing)), projB = Math.round(sumB + (sumB / ops.length) * (remaining + missing));
  const st = done.filter((r) => r.storage_bytes != null);
  const latest = [...d.days].reverse().find((r) => r.storage_bytes != null)?.storage_bytes ?? null;
  const gbm = st.length && latest != null ? (st.reduce((s, r) => s + (r.storage_bytes ?? 0), 0) + latest * (a.days_in_month - st.length)) / 1e9 / R2_PRICING.billing_period_days : null;
  return {
    available: true as const,
    basis: { from: ops[0].date, to: ops[ops.length - 1].date, days: ops.length, storage_days: st.length, missing_days: missing },
    assumptions: "以本月已完結日子的官方每日平均推算餘下日數（缺少官方數據的日子亦以平均值估算）；容量假設維持最新一日水平。不包括今日未完結的數據，最終以 Cloudflare 帳單為準。",
    class_a: projA, class_b: projB, gb_month: gbm,
    cost: costOf({ class_a: projA, class_b: projB, gb_month: gbm }),
    stale: !!off.stale,
  };
}

/**
 * 保守軟上限：接近免費額度時，優先限制「非必要背景工作」（縮圖補建、批量離線下載）。
 * 正常查看、上傳及保存不受影響。這不是 Cloudflare 官方硬上限；數據延遲、其他專案共用額度或並行操作都可能令實際用量更高。
 * 官方數據過時或缺失時：仍以最後一次官方數據判斷；沒有官方數據則用 App 自身操作次數（只會低估，不會誤停）。
 * 本函數不會發出官方 API 請求。
 */
export async function backgroundAllowed(env: Env): Promise<{ allowed: boolean; reason?: string; source: "official" | "app_estimate" | "none"; stale?: boolean }> {
  const al = await alertSettings(env);
  const last = await lastOfficial(env);
  const STALE_MS = 36 * 3600 * 1000;
  if (last) {
    const a = last.off.account!;
    const use = Math.max(a.class_a / R2_PRICING.free.class_a, a.class_b / R2_PRICING.free.class_b, a.gb_month_est == null ? 0 : a.gb_month_est / R2_PRICING.free.gb_month);
    const stale = last.age_ms > STALE_MS || a.month !== new Date().toISOString().slice(0, 7);
    // 跨月：上月數據不再代表本月用量
    if (a.month === new Date().toISOString().slice(0, 7) && use * 100 >= al.soft_limit)
      return { allowed: false, source: "official", stale, reason: `R2 免費額度已用 ${Math.round(use * 100)}%（軟上限 ${al.soft_limit}%${stale ? "；官方數據可能已過時" : ""}）：暫停非必要背景工作` };
    if (!stale) return { allowed: true, source: "official" };
  }
  try {
    const rows = (await env.DB.prepare("SELECT op, SUM(n) AS n FROM r2_usage WHERE month = ? GROUP BY op").bind(new Date().toISOString().slice(0, 7)).all<{ op: string; n: number }>()).results;
    const n = (op: string) => rows.find((r) => r.op === op)?.n ?? 0;
    const use = Math.max(n("class_a") / R2_PRICING.free.class_a, n("class_b") / R2_PRICING.free.class_b);
    if (use * 100 >= al.soft_limit) return { allowed: false, source: "app_estimate", reason: `App 統計的 R2 操作已達免費額度 ${Math.round(use * 100)}%（軟上限 ${al.soft_limit}%；官方數據${last ? "已過時" : "未能取得"}）：暫停非必要背景工作` };
    return { allowed: true, source: last ? "official" : "app_estimate", stale: !!last };
  } catch { return { allowed: true, source: "none" }; }
}
