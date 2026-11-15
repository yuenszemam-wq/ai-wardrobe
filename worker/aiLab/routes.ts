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
        license: await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'ai_lab_license'").first<{ value: string }>().then((r) => (r ? JSON.parse(r.value) : null)).catch(() => null),
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
    if (path === "/api/ai-lab/accept-license" && method === "POST") {
      // 擁有者在設定頁明確按下才執行：依官方文件向模型送出 {"prompt":"agree"}（接受 Meta License 及 Acceptable Use Policy）
      const cfg = await effectiveConfig(env);
      if (!cfg.serverEnabled) throw new HttpError(503, "ai_lab_disabled", "伺服器未開啟 AI Lab");
      if (!cfg.bindingPresent) throw new HttpError(503, "no_binding", "Workers AI Binding 不可用");
      const body = await readJson<{ confirm?: unknown }>(req);
      if (body.confirm !== true) throw new HttpError(400, "confirm_required", "需要明確確認接受授權");
      let ok = false, note = "";
      try { await env.AI!.run(cfg.model, { prompt: "agree" }); ok = true; }
      catch (e) {
        const msg = String((e as Error)?.message ?? e);
        // 已接受過時，部分情況會回傳一般錯誤訊息；只要不是 5016（未同意）就視為已接受
        if (!/5016|not agreed/i.test(msg)) { ok = true; note = "模型回應非預期內容，但沒有回報未同意授權"; } else note = msg.slice(0, 200);
      }
      const day = new Date().toISOString().slice(0, 10), now = nowIso();
      await env.DB.prepare(
        `INSERT INTO ai_usage_events (request_id, user_id, provider, model_id, prompt_version, operation_type, request_status, reserved_neurons, estimated_neurons, usage_source, day, created_at, settled_at)
         VALUES (?,?,?,?,?,'license',?,0,1,'estimate',?,?,?)`,
      ).bind(`license-${crypto.randomUUID()}`, actor.id, cfg.provider, cfg.model, PROMPT_VERSION, ok ? "success" : "failed", day, now, now).run().catch(() => {});
      if (!ok) throw new HttpError(502, "license_failed", `未能接受授權：${note}`);
      await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('ai_lab_license', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(JSON.stringify({ model: cfg.model, accepted_at: now, by: actor.id }), now).run();
      return json({ accepted: true, accepted_at: now, note: note || null });
    }
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
