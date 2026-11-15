/**
 * 冪等操作（Phase 3.9A.2.1；Phase 3.8C Outbox 共用）。
 *
 * 用戶端為每個「建立」類操作產生一次 op_id（重試時沿用）。伺服器在同一個 D1 交易內寫入結果及 client_ops，
 * 所以網絡在提交後中斷、用戶端重試時，會取回第一次的結果，而不是再建立一份。
 * 0015 未套用時（client_ops 不存在）自動略過，行為與舊版相同。
 */
import { hasTable } from "./schema";
import { Env, nowIso } from "./util";

export const validOpId = (v: unknown): string | null => (typeof v === "string" && /^[\w-]{8,80}$/.test(v) ? v : null);

/** 已完成的操作：回傳結果 ID；未完成＝null */
export async function findOp(env: Env, opId: string | null, kind: string): Promise<string | null> {
  if (!opId || !(await hasTable(env, "client_ops"))) return null;
  const r = await env.DB.prepare("SELECT kind, result_id FROM client_ops WHERE op_id = ?").bind(opId).first<{ kind: string; result_id: string | null }>();
  return r && r.kind === kind ? r.result_id : null;
}

/** 與結果一起提交的紀錄（放在同一個 batch）；不支援時回傳空陣列 */
export async function opStatements(env: Env, opId: string | null, kind: string, resultId: string): Promise<D1PreparedStatement[]> {
  if (!opId || !(await hasTable(env, "client_ops"))) return [];
  return [env.DB.prepare("INSERT INTO client_ops (op_id, kind, result_id, created_at) VALUES (?,?,?,?)").bind(opId, kind, resultId, nowIso())];
}

/** 清理 30 日前的紀錄（每次最多 500 筆，於維護工作執行） */
export async function pruneOps(env: Env) {
  if (!(await hasTable(env, "client_ops"))) return 0;
  const cut = new Date(Date.now() - 30 * 86400_000).toISOString();
  const r = await env.DB.prepare("DELETE FROM client_ops WHERE op_id IN (SELECT op_id FROM client_ops WHERE created_at < ? LIMIT 500)").bind(cut).run();
  return r.meta.changes ?? 0;
}
