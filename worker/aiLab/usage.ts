/**
 * AI Usage Service：每日／每月配額及 Neuron 預算的原子預留與結算。
 * - 預留：條件式 UPDATE（只有未超過上限才成功）＝同時多個請求亦不能突破預算。
 * - 結算：有模型回傳的 token 用量時按官方價格計算；沒有時保留保守估算（標示 estimate）。
 * - 失敗或逾時：可能已計費 → 保留預留（uncertain），不當作零成本。
 */
import { Env, nowIso } from "../util";
import { Effective } from "./config";

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
export const utcMonth = (d = new Date()) => d.toISOString().slice(0, 7);

/** 最壞情況估算：圖片最多 tokens ＋ 文字 prompt（約 4 字元 1 token）＋ max_tokens 輸出 */
export function worstCaseNeurons(cfg: Effective, promptChars: number, maxTokens: number) {
  const p = cfg.pricing!;
  const inTok = p.maxImageTokens + Math.ceil(promptChars / 3) + 64;
  return { inputTokens: inTok, neurons: (inTok * p.inNeuronsPerM) / 1e6 + (maxTokens * p.outNeuronsPerM) / 1e6 };
}
export function neuronsOf(cfg: Effective, inTok: number, outTok: number) {
  const p = cfg.pricing!;
  return (inTok * p.inNeuronsPerM) / 1e6 + (outTok * p.outNeuronsPerM) / 1e6;
}
export const usdOf = (cfg: Effective, neurons: number) => (neurons / 1000) * cfg.pricing!.usdPer1kNeurons;

export type ReserveFail = "daily_limit" | "monthly_limit" | "neuron_budget" | "concurrency";

/** 原子預留一次呼叫。成功回傳 null；失敗回傳原因（已回滾） */
export async function reserve(env: Env, cfg: Effective, neurons: number): Promise<ReserveFail | null> {
  const day = utcDay(), month = utcMonth(), now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO ai_usage_daily (day, updated_at) VALUES (?, ?) ON CONFLICT(day) DO NOTHING").bind(day, now),
    env.DB.prepare("INSERT INTO ai_usage_monthly (month, updated_at) VALUES (?, ?) ON CONFLICT(month) DO NOTHING").bind(month, now),
  ]);
  const d = await env.DB.prepare(
    `UPDATE ai_usage_daily SET requests = requests + 1, neurons = neurons + ?, inflight = inflight + 1, updated_at = ?
     WHERE day = ? AND requests + 1 <= ? AND neurons + ? <= ? AND inflight < ? RETURNING requests`,
  ).bind(neurons, now, day, cfg.dailyLimit, neurons, cfg.neuronBudget, cfg.maxConcurrency).first();
  if (!d) {
    const row = await env.DB.prepare("SELECT requests, neurons, inflight FROM ai_usage_daily WHERE day = ?").bind(day).first<{ requests: number; neurons: number; inflight: number }>();
    if (row && row.requests + 1 > cfg.dailyLimit) return "daily_limit";
    if (row && row.inflight >= cfg.maxConcurrency) return "concurrency";
    return "neuron_budget";
  }
  const m = await env.DB.prepare("UPDATE ai_usage_monthly SET requests = requests + 1, updated_at = ? WHERE month = ? AND requests + 1 <= ? RETURNING requests").bind(now, month, cfg.monthlyLimit).first();
  if (!m) {
    await env.DB.prepare("UPDATE ai_usage_daily SET requests = requests - 1, neurons = MAX(0, neurons - ?), inflight = MAX(0, inflight - 1), updated_at = ? WHERE day = ?").bind(neurons, now, day).run();
    return "monthly_limit";
  }
  return null;
}

/** 結算：delta＝實際（或保守估算）− 預留；成功／失敗計數；釋放並行名額 */
export async function settle(env: Env, day: string, reserved: number, final: number, ok: boolean) {
  await env.DB.prepare(
    `UPDATE ai_usage_daily SET neurons = MAX(0, neurons + ?), inflight = MAX(0, inflight - 1), success = success + ?, failed = failed + ?, updated_at = ? WHERE day = ?`,
  ).bind(final - reserved, ok ? 1 : 0, ok ? 0 : 1, nowIso(), day).run();
}

/** 清理：超過 10 分鐘仍是 reserved 的事件（Worker 中斷）→ 釋放並行名額，但保留 Neuron 預留（可能已計費） */
export async function releaseStale(env: Env) {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
  const { results } = await env.DB.prepare("SELECT request_id, day FROM ai_usage_events WHERE request_status = 'reserved' AND created_at < ? LIMIT 20").bind(cutoff).all<{ request_id: string; day: string }>();
  for (const r of results) {
    const upd = await env.DB.prepare("UPDATE ai_usage_events SET request_status = 'uncertain', usage_source = 'estimate', settled_at = ? WHERE request_id = ? AND request_status = 'reserved'").bind(nowIso(), r.request_id).run();
    if ((upd.meta as { changes?: number })?.changes) await env.DB.prepare("UPDATE ai_usage_daily SET inflight = MAX(0, inflight - 1), failed = failed + 1 WHERE day = ?").bind(r.day).run();
  }
}

export async function usageSummary(env: Env, cfg: Effective) {
  await releaseStale(env).catch(() => {});
  const day = utcDay(), month = utcMonth();
  const d = await env.DB.prepare("SELECT * FROM ai_usage_daily WHERE day = ?").bind(day).first<Record<string, number>>();
  const m = await env.DB.prepare("SELECT * FROM ai_usage_monthly WHERE month = ?").bind(month).first<Record<string, number>>();
  const lat = await env.DB.prepare("SELECT AVG(latency_ms) AS avg, MAX(created_at) AS last, SUM(COALESCE(actual_neurons, estimated_neurons, reserved_neurons)) AS neurons, SUM(estimated_cost_usd) AS usd FROM ai_usage_events WHERE substr(day,1,7) = ? AND request_status IN ('success','invalid_output')").bind(month).first<{ avg: number | null; last: string | null; neurons: number | null; usd: number | null }>();
  const neuronsToday = Number(d?.neurons ?? 0);
  return {
    day, month,
    today: { requests: Number(d?.requests ?? 0), neurons: Math.round(neuronsToday * 10) / 10, success: Number(d?.success ?? 0), failed: Number(d?.failed ?? 0), inflight: Number(d?.inflight ?? 0) },
    month_requests: Number(m?.requests ?? 0),
    remaining: { requests_today: Math.max(0, cfg.dailyLimit - Number(d?.requests ?? 0)), requests_month: Math.max(0, cfg.monthlyLimit - Number(m?.requests ?? 0)), neurons_today: Math.max(0, Math.round((cfg.neuronBudget - neuronsToday) * 10) / 10) },
    avg_latency_ms: lat?.avg ? Math.round(lat.avg) : null,
    last_used_at: lat?.last ?? null,
    month_neurons: lat?.neurons ? Math.round(lat.neurons * 10) / 10 : 0,
    month_cost_usd_if_billed: lat?.usd ? Math.round(lat.usd * 10000) / 10000 : 0,
  };
}
