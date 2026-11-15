/**
 * R2 檔案的安全清理（Phase 3.9A.2.1）。
 *
 * 1. 刪除 D1 紀錄時，同一個交易把要清理的 R2 key 寫入 r2_purge_queue（紀錄與佇列一起成功或一起失敗）。
 * 2. 交易成功後才刪除 R2；成功即移出佇列，失敗則保留並記錄次數，之後再重試。
 * 3. 每次真正刪除前，再核對所有資料表都沒有引用（共用檔案、重新使用、並行保存都不會被誤刪）。
 * 4. dry-run 只列出會刪除及會保留的檔案，不作任何修改。
 * 0015 未套用時退回舊行為（交易後直接刪除未被引用的檔案）。
 */
import { hasColumn, hasTable } from "./schema";
import { Env, nowIso } from "./util";

/** 所有保存 R2 key 的資料表（新增資料表時必須加入，否則維護清理會把檔案當作孤兒） */
export const R2_REFS: [table: string, col: string][] = [
  ["garment_images", "r2_key"], ["outfit_images", "r2_key"], ["diary_photos", "r2_key"],
  ["studio_asset_versions", "r2_key"], ["studio_asset_versions", "cutout_key"],
  ["doll_asset_files", "r2_key"], ["doll_model_files", "r2_key"], ["upload_slots", "r2_key"],
  ["package_files", "r2_key"],
];

async function activeRefs(env: Env) {
  const out: [string, string][] = [];
  for (const [t, c] of R2_REFS) if (await hasColumn(env, t, c)) out.push([t, c]);
  return out;
}
/** 已被引用的 key（一次查詢多個） */
export async function referencedKeys(env: Env, keys: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const refs = await activeRefs(env);
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50), ph = chunk.map(() => "?").join(",");
    for (const [t, c] of refs) for (const r of (await env.DB.prepare(`SELECT ${c} AS k FROM ${t} WHERE ${c} IN (${ph})`).bind(...chunk).all<{ k: string }>()).results) found.add(r.k);
  }
  return found;
}

/** 與刪除紀錄放在同一個 batch 的佇列寫入 */
export async function queueStatements(env: Env, keys: string[], reason: string): Promise<D1PreparedStatement[]> {
  if (!keys.length || !(await hasTable(env, "r2_purge_queue"))) return [];
  const now = nowIso();
  return keys.map((k) => env.DB.prepare("INSERT INTO r2_purge_queue (r2_key, reason, queued_at, attempts) VALUES (?,?,?,0) ON CONFLICT(r2_key) DO NOTHING").bind(k, reason.slice(0, 60), now));
}

export interface PurgeResult { deleted: string[]; kept: string[]; failed: { key: string; error: string }[]; dry_run: boolean; queued: number }
/**
 * 清理指定 key（交易成功後呼叫）；keys 未指定＝處理佇列最舊的 limit 個。
 * 仍被引用的 key 只移出佇列，不刪除 R2 檔案。
 */
export async function drainPurge(env: Env, opts: { keys?: string[]; limit?: number; dryRun?: boolean } = {}): Promise<PurgeResult> {
  const queue = await hasTable(env, "r2_purge_queue");
  let keys = opts.keys ? [...new Set(opts.keys)] : [];
  if (!opts.keys && queue) keys = (await env.DB.prepare("SELECT r2_key FROM r2_purge_queue ORDER BY attempts, queued_at LIMIT ?").bind(Math.min(500, opts.limit ?? 100)).all<{ r2_key: string }>()).results.map((r) => r.r2_key);
  const res: PurgeResult = { deleted: [], kept: [], failed: [], dry_run: !!opts.dryRun, queued: 0 };
  if (!keys.length) return res;
  const used = await referencedKeys(env, keys);
  const del = keys.filter((k) => !used.has(k));
  res.kept = keys.filter((k) => used.has(k));
  if (opts.dryRun) { res.deleted = del; return res; }
  for (let i = 0; i < del.length; i += 500) {
    const part = del.slice(i, i + 500);
    try { await env.IMAGES.delete(part); res.deleted.push(...part); }
    catch (e) { for (const k of part) res.failed.push({ key: k, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
  }
  if (queue) {
    const done = [...res.deleted, ...res.kept];
    for (let i = 0; i < done.length; i += 80) { const part = done.slice(i, i + 80); await env.DB.prepare(`DELETE FROM r2_purge_queue WHERE r2_key IN (${part.map(() => "?").join(",")})`).bind(...part).run(); }
    for (const f of res.failed) await env.DB.prepare("UPDATE r2_purge_queue SET attempts = attempts + 1, last_error = ? WHERE r2_key = ?").bind(f.error, f.key).run();
    res.queued = (await env.DB.prepare("SELECT COUNT(*) AS n FROM r2_purge_queue").first<{ n: number }>())?.n ?? 0;
  }
  return res;
}
