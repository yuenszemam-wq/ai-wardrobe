/**
 * AI Suggestion Service：單件辨認（批量亦逐件呼叫此函數）。
 * 權限、開關、配額、快取、request_id 冪等全部在伺服器檢查；結果經現有 submitSuggestion 進入「AI 待整理」，不直接改正式資料。
 */
import { submitSuggestion } from "../ai";
import { parseImage } from "../images";
import { currentTaxonomy } from "../taxonomy";
import { Actor, HttpError, nowIso, sha256Hex } from "../util";
import { AiLabEnv, Effective, effectiveConfig } from "./config";
import { PROMPT_VERSION, RETRY_INSTRUCTION, buildPrompt } from "./prompt";
import { AiProvider, ProviderError, WorkersAiProvider } from "./provider";
import { neuronsOf, reserve, settle, usdOf, utcDay, worstCaseNeurons } from "./usage";
import { extractJson, validateAiOutput } from "./validate";

export const MAX_TOKENS = 700;
const TIMEOUT_MS = 45_000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1100;

/** 測試可注入 Mock Provider */
export type ProviderFactory = (env: AiLabEnv, cfg: Effective) => AiProvider;
let providerFactory: ProviderFactory = (env, cfg) => new WorkersAiProvider(env.AI!, cfg.model);
export function setProviderFactory(f: ProviderFactory | null) { providerFactory = f ?? ((env, cfg) => new WorkersAiProvider(env.AI!, cfg.model)); }

export async function taxonomyVersion() {
  const t = currentTaxonomy();
  const sig = JSON.stringify([t.categories.map((c) => [c.id, c.name, c.subs.map((s) => [s.id, s.name])]), t.attributes.map((a) => [a.id, a.multi, a.max_select, a.show_for, a.options.map((o) => [o.id, o.name])])]);
  return (await sha256Hex(new TextEncoder().encode(sig))).slice(0, 12);
}

const REASON_TEXT: Record<string, string> = {
  daily_limit: "今日 AI 呼叫次數已達上限", monthly_limit: "本月 AI 呼叫次數已達上限",
  neuron_budget: "今日 AI Neuron 預算已用完（或不足以預留本次最壞情況用量）", concurrency: "另一個 AI 請求正在處理，請稍後再試",
};

function requireActive(cfg: Effective) {
  if (!cfg.active) throw new HttpError(503, "ai_lab_disabled", cfg.reason ?? "AI Lab 未開啟");
}

interface CallResult { text: string; event: { request_id: string } }

/** 一次（已計配額的）模型呼叫：寫事件 → 預留 → 呼叫 → 結算 */
async function meteredCall(env: AiLabEnv, cfg: Effective, actor: Actor, o: { requestId: string; garmentId: string | null; op: string; cacheKey: string | null; system: string; user: string; image: Uint8Array | null; mime: string; maxTokens: number }): Promise<CallResult> {
  const est = worstCaseNeurons(cfg, o.system.length + o.user.length, o.maxTokens);
  const reservedNeurons = o.image ? est.neurons : neuronsOf(cfg, Math.ceil((o.system.length + o.user.length) / 3) + 64, o.maxTokens);
  const day = utcDay();
  const ins = await env.DB.prepare(
    `INSERT INTO ai_usage_events (request_id, user_id, garment_id, provider, model_id, prompt_version, operation_type, request_status, cache_key, estimated_input_tokens, reserved_neurons, estimated_neurons, estimated_cost_usd, usage_source, pricing_version, day, created_at)
     VALUES (?,?,?,?,?,?,?,'reserved',?,?,?,?,?,'estimate',?,?,?) ON CONFLICT(request_id) DO NOTHING`,
  ).bind(o.requestId, actor.id, o.garmentId, cfg.provider, cfg.model, PROMPT_VERSION, o.op, o.cacheKey, est.inputTokens, reservedNeurons, reservedNeurons, usdOf(cfg, reservedNeurons), cfg.pricing!.version, day, nowIso()).run();
  if (!(ins.meta as { changes?: number })?.changes) throw new HttpError(409, "duplicate_request", "此 request_id 已處理，不會重複呼叫模型");
  const fail = await reserve(env, cfg, reservedNeurons);
  if (fail) {
    await env.DB.prepare("UPDATE ai_usage_events SET request_status = 'blocked', reserved_neurons = 0, estimated_neurons = 0, estimated_cost_usd = 0, usage_source = 'none', error_code = ?, settled_at = ? WHERE request_id = ?").bind(fail, nowIso(), o.requestId).run();
    throw new HttpError(429, fail, REASON_TEXT[fail]);
  }
  const t0 = Date.now();
  try {
    const r = await providerFactory(env, cfg).vision({ system: o.system, user: o.user, image: o.image, mime: o.mime, maxTokens: o.maxTokens, timeoutMs: TIMEOUT_MS });
    const known = r.usage.input_tokens !== null && r.usage.output_tokens !== null;
    // 有模型回傳 token 用量才計算實際 Neurons；否則保留保守估算
    const actual = known ? neuronsOf(cfg, r.usage.input_tokens!, r.usage.output_tokens!) : null;
    const final = actual ?? reservedNeurons;
    await settle(env, day, reservedNeurons, final, true);
    await env.DB.prepare("UPDATE ai_usage_events SET request_status = 'success', actual_input_tokens = ?, actual_output_tokens = ?, actual_neurons = ?, estimated_cost_usd = ?, usage_source = ?, latency_ms = ?, settled_at = ? WHERE request_id = ?")
      .bind(r.usage.input_tokens, r.usage.output_tokens, actual, usdOf(cfg, final), known ? "model_usage" : "estimate", Date.now() - t0, nowIso(), o.requestId).run();
    return { text: r.text, event: { request_id: o.requestId } };
  } catch (e) {
    const pe = e instanceof ProviderError ? e : new ProviderError("unavailable", "AI 服務錯誤", true);
    // 不確定是否已計費：保留預留；確定未計費（授權、額度）：退回
    const final = pe.maybeBilled ? reservedNeurons : 0;
    await settle(env, day, reservedNeurons, final, false);
    await env.DB.prepare("UPDATE ai_usage_events SET request_status = ?, error_code = ?, latency_ms = ?, usage_source = ?, estimated_neurons = ?, estimated_cost_usd = ?, settled_at = ? WHERE request_id = ?")
      .bind(pe.code === "timeout" ? "timeout" : pe.maybeBilled ? "uncertain" : "failed", pe.code, Date.now() - t0, pe.maybeBilled ? "estimate" : "none", final, usdOf(cfg, final), nowIso(), o.requestId).run();
    throw new HttpError(pe.code === "license_required" ? 403 : pe.code === "quota_or_capacity" ? 429 : 502, pe.code, pe.message);
  }
}

export interface RecognizeInput { garment_id: string; image_id: string; base_version: number; request_id: string; force: boolean; bytes: Uint8Array }

export async function recognize(env: AiLabEnv, actor: Actor, inp: RecognizeInput) {
  const cfg = await effectiveConfig(env);
  requireActive(cfg);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(inp.request_id)) throw new HttpError(400, "bad_request_id", "request_id 格式不正確");
  const prev = await env.DB.prepare("SELECT request_status, suggestion_id FROM ai_usage_events WHERE request_id = ?").bind(inp.request_id).first<{ request_status: string; suggestion_id: number | null }>();
  if (prev) return { replay: true, status: prev.request_status, suggestion_id: prev.suggestion_id };

  const g = await env.DB.prepare("SELECT id, name, category, subcategory, status, version FROM garments WHERE id = ?").bind(inp.garment_id).first<Record<string, unknown>>();
  if (!g) throw new HttpError(404, "garment_not_found", "找不到這件衣物");
  if (g.status === "archived") throw new HttpError(400, "archived", "衣物已封存");
  if (Number(g.version) !== inp.base_version) throw new HttpError(409, "stale_version", "衣物已被修改，請重新載入後再辨認");
  const img = await env.DB.prepare("SELECT id, sha256 FROM garment_images WHERE id = ? AND garment_id = ?").bind(inp.image_id, inp.garment_id).first<{ id: string; sha256: string }>();
  if (!img) throw new HttpError(400, "bad_image", "圖片不屬於這件衣物（或已被刪除）");
  if (inp.bytes.byteLength === 0 || inp.bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, "bad_ai_image", "辨認用圖片大小不符（上限 2 MB）");
  let info;
  try { info = parseImage(inp.bytes); } catch { throw new HttpError(400, "bad_ai_image", "辨認用圖片格式不支援"); }
  if (!["image/jpeg", "image/png"].includes(info.mime)) throw new HttpError(400, "bad_ai_image", "辨認用圖片必須是 JPEG 或 PNG");
  if (Math.max(info.width, info.height) > MAX_IMAGE_SIDE) throw new HttpError(400, "bad_ai_image", `辨認用圖片長邊不可超過 ${MAX_IMAGE_SIDE}px`);

  const taxVer = await taxonomyVersion();
  const cacheKey = `wai|${inp.garment_id}|${img.sha256}|${cfg.model}|${PROMPT_VERSION}|${taxVer}`;
  const keyBase = "wai-" + (await sha256Hex(new TextEncoder().encode(cacheKey))).slice(0, 40);
  if (!inp.force) {
    const cached = await env.DB.prepare("SELECT id, status FROM ai_suggestions WHERE idempotency_key = ? AND garment_id = ?").bind(keyBase, inp.garment_id).first<{ id: number; status: string }>();
    if (cached) return { cached: true, suggestion_id: cached.id, status: cached.status };
  }
  const idemKey = inp.force ? `${keyBase}-r-${inp.request_id}`.slice(0, 120) : keyBase;

  const { system, user } = buildPrompt({ taxonomy: currentTaxonomy(), known: { name: g.name as string, category: g.category as string, subcategory: g.subcategory as string } });
  const base = { garmentId: inp.garment_id, cacheKey, system, image: inp.bytes, mime: info.mime, maxTokens: MAX_TOKENS };
  let call = await meteredCall(env, cfg, actor, { ...base, requestId: inp.request_id, op: "recognize", user });
  let parsed: unknown = null, parseErr = "";
  try { parsed = extractJson(call.text); } catch (e) { parseErr = (e as Error).message; }
  let v = parsed ? validateAiOutput(parsed, currentTaxonomy()) : null;
  let retried = false;
  if (!v?.ok) {
    // 最多一次有預算限制的修正重試（亦計入配額）
    retried = true;
    try {
      call = await meteredCall(env, cfg, actor, { ...base, requestId: `${inp.request_id}-r1`.slice(0, 80), op: "retry", user: `${user}\n\n${RETRY_INSTRUCTION}` });
      parsed = null; parseErr = "";
      try { parsed = extractJson(call.text); } catch (e) { parseErr = (e as Error).message; }
      v = parsed ? validateAiOutput(parsed, currentTaxonomy()) : null;
    } catch (e) { if (!(e instanceof HttpError) || e.status !== 429) throw e; }
  }
  const meta = { provider: cfg.provider, model: cfg.model, prompt_version: PROMPT_VERSION, taxonomy_version: taxVer, request_id: inp.request_id, recognized_at: nowIso(), image_sha256: img.sha256, retried };
  let res;
  if (!v?.ok) {
    await env.DB.prepare("UPDATE ai_usage_events SET request_status = 'invalid_output' WHERE request_id = ?").bind(call.event.request_id).run();
    res = await submitSuggestion(env, actor, { garment_id: inp.garment_id, idempotency_key: idemKey, base_version: inp.base_version, source: "workers-ai", image_id: inp.image_id, outcome: "failed", failure_reason: `AI 輸出不合格（${v?.error ?? parseErr ?? "無效 JSON"}），需要手動整理`, ai_lab: meta });
  } else {
    res = await submitSuggestion(env, actor, { garment_id: inp.garment_id, idempotency_key: idemKey, base_version: inp.base_version, source: "workers-ai", image_id: inp.image_id, vision_checked: true, fields: v.fields!, ai_lab: { ...meta, attributes: v.attributes, warnings: v.warnings.slice(0, 20) } });
  }
  const sid = (res as { id?: number }).id ?? null;
  await env.DB.prepare("UPDATE ai_usage_events SET suggestion_id = ? WHERE request_id IN (?, ?)").bind(sid, inp.request_id, `${inp.request_id}-r1`.slice(0, 80)).run();
  return { cached: false, ok: Boolean(v?.ok), suggestion: res, attributes: v?.attributes ?? null, warnings: v?.warnings ?? [], retried };
}

/** 測試連線：實際呼叫模型（純文字、極短輸出），同樣計入配額 */
export async function testConnection(env: AiLabEnv, actor: Actor) {
  const cfg = await effectiveConfig(env);
  requireActive(cfg);
  const rid = `test-${crypto.randomUUID()}`;
  const t0 = Date.now();
  const r = await meteredCall(env, cfg, actor, { requestId: rid, garmentId: null, op: "test", cacheKey: null, system: "Reply with the single word OK.", user: "ping", image: null, mime: "", maxTokens: 5 });
  return { ok: true, latency_ms: Date.now() - t0, reply: r.text.slice(0, 20) };
}
