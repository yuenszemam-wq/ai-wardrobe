/**
 * AI Lab API（只限登入的 App 擁有者 session；MCP／API token 不可使用）。
 * GET  /api/ai-lab/status      狀態、用量、剩餘額度（不含任何 Token、私人圖片網址）
 * POST /api/ai-lab/settings    開關、Kill Switch、設定更低上限（不可高於伺服器上限）
 * POST /api/ai-lab/test        測試連線（實際呼叫模型，計入配額）
 * POST /api/ai-lab/recognize   單件辨認（multipart：file＝已縮小的辨認圖、garment_id、image_id、base_version、request_id、force）
 * GET  /api/ai-lab/events      最近使用記錄（技術資料）
 */
import { readUploadBody } from "../images";
import { Actor, HttpError, json, nowIso, readJson, requireSession } from "../util";
import { AiLabEnv, LabSettings, effectiveConfig, readSettings } from "./config";
import { PROMPT_VERSION } from "./prompt";
import { recognize, testConnection } from "./service";
import { usageSummary } from "./usage";

const missing = (e: unknown) => /no such table: ai_usage/i.test(String((e as Error)?.message ?? e));

export async function handleAiLab(req: Request, env: AiLabEnv, actor: Actor, path: string, method: string): Promise<Response | null> {
  if (!path.startsWith("/api/ai-lab/")) return null;
  requireSession(actor);
  try {
    if (path === "/api/ai-lab/status" && method === "GET") {
      const cfg = await effectiveConfig(env);
      return json({
        server_enabled: cfg.serverEnabled, active: cfg.active, reason: cfg.reason, settings: cfg.settings,
        provider: cfg.provider, model: cfg.model, prompt_version: PROMPT_VERSION, binding: cfg.bindingPresent, environment: env.AW_ENV ?? null,
        limits: { daily_requests: cfg.dailyLimit, monthly_requests: cfg.monthlyLimit, daily_neurons: cfg.neuronBudget, max_batch: cfg.maxBatch, max_concurrency: cfg.maxConcurrency, paid_usage: cfg.paidUsage },
        pricing: cfg.pricing ? { input_neurons_per_m: cfg.pricing.inNeuronsPerM, output_neurons_per_m: cfg.pricing.outNeuronsPerM, usd_per_1k_neurons: cfg.pricing.usdPer1kNeurons, version: cfg.pricing.version, source: cfg.pricing.source } : null,
        usage: await usageSummary(env, cfg),
        notes: ["Cloudflare 免費額度（每日 10,000 Neurons）屬整個帳戶，其他 Worker 亦可能使用；本地計數不能絕對保證整個帳戶不產生費用。", "Cloudflare Dashboard 用量有延遲，不能當作即時上限。"],
      });
    }
    if (path === "/api/ai-lab/settings" && method === "POST") {
      const body = await readJson<Partial<LabSettings>>(req);
      const cur = await readSettings(env);
      const lim = (v: unknown, cur: number | null) => (v === null ? null : typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : cur);
      const next: LabSettings = {
        enabled: typeof body.enabled === "boolean" ? body.enabled : cur.enabled,
        killed: typeof body.killed === "boolean" ? body.killed : cur.killed,
        daily_limit: "daily_limit" in body ? lim(body.daily_limit, cur.daily_limit) : cur.daily_limit,
        monthly_limit: "monthly_limit" in body ? lim(body.monthly_limit, cur.monthly_limit) : cur.monthly_limit,
        neuron_budget: "neuron_budget" in body ? lim(body.neuron_budget, cur.neuron_budget) : cur.neuron_budget,
      };
      await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('ai_lab', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify(next), nowIso()).run();
      const cfg = await effectiveConfig(env);
      return json({ settings: next, active: cfg.active, reason: cfg.reason, limits: { daily_requests: cfg.dailyLimit, monthly_requests: cfg.monthlyLimit, daily_neurons: cfg.neuronBudget } });
    }
    if (path === "/api/ai-lab/test" && method === "POST") return json(await testConnection(env, actor));
    if (path === "/api/ai-lab/recognize" && method === "POST") {
      const { bytes, fields } = await readUploadBody(req, env);
      return json(await recognize(env, actor, {
        garment_id: String(fields.garment_id || ""), image_id: String(fields.image_id || ""), base_version: Number(fields.base_version),
        request_id: String(fields.request_id || ""), force: fields.force === "1" || fields.force === "true", bytes,
      }));
    }
    if (path === "/api/ai-lab/events" && method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT request_id, garment_id, model_id, prompt_version, operation_type, request_status, actual_input_tokens, actual_output_tokens, reserved_neurons, estimated_neurons, actual_neurons, estimated_cost_usd, usage_source, latency_ms, suggestion_id, error_code, created_at FROM ai_usage_events ORDER BY created_at DESC LIMIT 50",
      ).all();
      return json({ events: results });
    }
    throw new HttpError(404, "not_found", "找不到此 AI Lab 功能");
  } catch (e) {
    if (missing(e)) throw new HttpError(503, "ai_lab_migration", "資料庫未套用 migration 0018（AI Lab），AI 功能未能使用");
    throw e;
  }
}
