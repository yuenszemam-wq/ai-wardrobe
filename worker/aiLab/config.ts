/**
 * AI Lab 設定：wrangler vars（伺服器上限）＋ app_settings 'ai_lab'（使用者只可再調低、開關、Kill Switch）。
 * 前端不能提高任何上限。AI_PAID_USAGE_ENABLED 預設 false：每日 Neuron 預算不可超過 Cloudflare 免費額度。
 */
import { Env } from "../util";

export const FREE_DAILY_NEURONS = 10_000; // Cloudflare 公布：每日 10,000 Neurons，UTC 00:00 重設（2026-11 查閱）

/** 模型價格（來源：developers.cloudflare.com/workers-ai/platform/pricing/，2026-11-16 查閱） */
export const MODEL_PRICING: Record<string, { inNeuronsPerM: number; outNeuronsPerM: number; usdPer1kNeurons: number; version: string; source: string; maxImageTokens: number }> = {
  "@cf/meta/llama-3.2-11b-vision-instruct": {
    inNeuronsPerM: 4410, outNeuronsPerM: 61493, usdPer1kNeurons: 0.011, version: "cf-pricing-2026-11-12",
    source: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    // 保守估算：Llama 3.2 Vision 最多 4 個 560×560 圖塊，每塊約 1,601 tokens
    maxImageTokens: 6404,
  },
};

export interface AiLabEnv extends Env {
  AI?: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  AI_LAB_ENABLED?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  AI_DAILY_REQUEST_LIMIT?: string;
  AI_MONTHLY_REQUEST_LIMIT?: string;
  AI_MAX_BATCH_SIZE?: string;
  AI_MAX_CONCURRENCY?: string;
  AI_DAILY_NEURON_BUDGET?: string;
  AI_PAID_USAGE_ENABLED?: string;
}

export interface LabSettings { enabled: boolean; killed: boolean; daily_limit: number | null; monthly_limit: number | null; neuron_budget: number | null }
export const DEFAULT_SETTINGS: LabSettings = { enabled: false, killed: false, daily_limit: null, monthly_limit: null, neuron_budget: null };

const int = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };

export async function readSettings(env: Env): Promise<LabSettings> {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'ai_lab'").first<{ value: string }>();
    if (!row) return { ...DEFAULT_SETTINGS };
    const v = JSON.parse(row.value) as Partial<LabSettings>;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null);
    return { enabled: v.enabled === true, killed: v.killed === true, daily_limit: num(v.daily_limit), monthly_limit: num(v.monthly_limit), neuron_budget: num(v.neuron_budget) };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export interface Effective {
  serverEnabled: boolean; settings: LabSettings; active: boolean; reason: string | null;
  provider: string; model: string; dailyLimit: number; monthlyLimit: number; neuronBudget: number; maxBatch: number; maxConcurrency: number;
  paidUsage: boolean; pricing: (typeof MODEL_PRICING)[string] | null; bindingPresent: boolean;
}

export async function effectiveConfig(env: AiLabEnv): Promise<Effective> {
  const settings = await readSettings(env);
  const serverEnabled = env.AI_LAB_ENABLED === "true";
  const model = env.AI_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct";
  const provider = env.AI_PROVIDER || "workers-ai";
  const paidUsage = env.AI_PAID_USAGE_ENABLED === "true";
  const capMin = (server: number, user: number | null) => (user === null ? server : Math.min(server, user));
  let neuronServer = int(env.AI_DAILY_NEURON_BUDGET, 5000);
  if (!paidUsage) neuronServer = Math.min(neuronServer, FREE_DAILY_NEURONS);
  const pricing = MODEL_PRICING[model] ?? null;
  const bindingPresent = Boolean(env.AI && typeof env.AI.run === "function");
  let reason: string | null = null;
  if (!serverEnabled) reason = "伺服器未開啟 AI Lab（AI_LAB_ENABLED=false）";
  else if (settings.killed) reason = "AI Kill Switch 已啟動";
  else if (!settings.enabled) reason = "AI Lab 未在設定中開啟";
  else if (provider !== "workers-ai") reason = `不支援的 AI_PROVIDER：${provider}`;
  else if (!pricing) reason = "未能確認此模型的價格，已停止新請求";
  else if (!bindingPresent) reason = "Workers AI Binding（AI）不可用";
  return {
    serverEnabled, settings, active: reason === null, reason, provider, model,
    dailyLimit: capMin(int(env.AI_DAILY_REQUEST_LIMIT, 50), settings.daily_limit),
    monthlyLimit: capMin(int(env.AI_MONTHLY_REQUEST_LIMIT, 500), settings.monthly_limit),
    neuronBudget: capMin(neuronServer, settings.neuron_budget),
    maxBatch: Math.min(10, int(env.AI_MAX_BATCH_SIZE, 10)),
    maxConcurrency: Math.max(1, int(env.AI_MAX_CONCURRENCY, 1)),
    paidUsage, pricing, bindingPresent,
  };
}
