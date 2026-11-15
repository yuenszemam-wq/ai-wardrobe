/**
 * 正式 D1 的實際 schema 偵測（Phase 3.9A.2.1）。
 *
 * 新版程式可能比資料庫遷移先部署：新增欄位／資料表未套用時，功能自動退回舊行為，不會令整個 API 出錯。
 * 結果按 D1 綁定快取 5 分鐘（遷移套用後最多 5 分鐘生效）。
 */
import { Env } from "./util";

const TTL = 5 * 60_000;
const cache = new WeakMap<object, Map<string, { at: number; p: Promise<Set<string> | null> }>>();

/** 資料表的欄位集合；資料表不存在＝null */
export function columnsOf(env: Env, table: string): Promise<Set<string> | null> {
  let m = cache.get(env.DB);
  if (!m) { m = new Map(); cache.set(env.DB, m); }
  const hit = m.get(table);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  if (!/^\w+$/.test(table)) return Promise.resolve(null);
  const p = env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    .then((r) => (r.results.length ? new Set(r.results.map((x) => x.name)) : null))
    .catch(() => null);
  m.set(table, { at: Date.now(), p });
  return p;
}
export const hasTable = async (env: Env, table: string) => (await columnsOf(env, table)) !== null;
export const hasColumn = async (env: Env, table: string, col: string) => !!(await columnsOf(env, table))?.has(col);
/** 測試用：清除快取 */
export const resetSchemaCache = (env: Env) => cache.delete(env.DB);
