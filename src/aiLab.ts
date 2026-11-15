/**
 * AI Lab（Workers AI 衣物辨認）用戶端。
 * - 只在伺服器回報 active 時顯示功能；所有配額、權限由伺服器檢查。
 * - 辨認圖：在手機縮小至長邊 1024px JPEG；透明圖暫時合成中性灰底。不上傳到 R2、不覆寫原圖。
 */
import { api, Garment, GarmentImage, imageUrl, uploadImage } from "./api";
import { highResolutionBlob } from "./imageCache";
import { decode } from "./imageProcessing";

export interface AiLabStatus {
  server_enabled: boolean; active: boolean; reason: string | null;
  settings: { enabled: boolean; killed: boolean; daily_limit: number | null; monthly_limit: number | null; neuron_budget: number | null };
  provider: string; model: string; prompt_version: string; binding: boolean; environment: string | null;
  limits: { daily_requests: number; monthly_requests: number; daily_neurons: number; max_batch: number; max_concurrency: number; paid_usage: boolean };
  pricing: { input_neurons_per_m: number; output_neurons_per_m: number; usd_per_1k_neurons: number; version: string; source: string } | null;
  usage: {
    day: string; month: string;
    today: { requests: number; neurons: number; success: number; failed: number; inflight: number };
    month_requests: number; remaining: { requests_today: number; requests_month: number; neurons_today: number };
    avg_latency_ms: number | null; last_used_at: string | null; month_neurons: number; month_cost_usd_if_billed: number;
  };
  notes: string[];
}
export interface AiLabEvent { request_id: string; garment_id: string | null; operation_type: string; request_status: string; actual_neurons: number | null; estimated_neurons: number | null; usage_source: string; latency_ms: number | null; error_code: string | null; created_at: string }

export const aiLabStatus = () => api<AiLabStatus>("/api/ai-lab/status");
export const aiLabSettings = (body: Partial<AiLabStatus["settings"]>) => api<{ settings: AiLabStatus["settings"]; active: boolean; reason: string | null }>("/api/ai-lab/settings", { method: "POST", json: body });
export const aiLabTest = () => api<{ ok: boolean; latency_ms: number; reply: string }>("/api/ai-lab/test", { method: "POST" });
export const aiLabEvents = () => api<{ events: AiLabEvent[] }>("/api/ai-lab/events").then((r) => r.events);

/** 選擇辨認用圖片：優先去背圖（主圖），其次原相 */
export function aiSourceImage(g: Garment): GarmentImage | null {
  const imgs = (g.images || []).filter((i) => i.image_type !== "thumbnail" && !/heic|heif/.test(i.mime_type));
  return imgs.find((i) => i.is_primary) ?? imgs.find((i) => i.image_type === "processed") ?? imgs[0] ?? null;
}

export async function prepareAiImage(blob: Blob, maxSide = 1024): Promise<Blob> {
  const src = await decode(blob);
  try {
    const w = "naturalWidth" in src ? src.naturalWidth : src.width, h = "naturalHeight" in src ? src.naturalHeight : src.height;
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, c.width, c.height); // 透明部分暫時合成中性色（不影響原圖）
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src as CanvasImageSource, 0, 0, c.width, c.height);
    const out = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("未能準備辨認圖片"))), "image/jpeg", 0.85));
    c.width = c.height = 0;
    return out;
  } finally { if ("close" in src) src.close(); }
}

export interface RecognizeResult { cached?: boolean; replay?: boolean; ok?: boolean; suggestion_id?: number; suggestion?: { suggestion_id: number }; warnings?: string[]; retried?: boolean }

export async function recognizeGarment(g: Garment, opts: { force?: boolean; image?: GarmentImage | null } = {}): Promise<RecognizeResult> {
  const img = opts.image ?? aiSourceImage(g);
  if (!img) throw new Error("這件衣物沒有可辨認的圖片");
  const prepared = await prepareAiImage(await highResolutionBlob(imageUrl(img.id)));
  const fields: Record<string, string> = { garment_id: g.id, image_id: img.id, base_version: String(g.version ?? 1), request_id: `req_${crypto.randomUUID().replace(/-/g, "")}` };
  if (opts.force) fields.force = "1";
  return uploadImage("/api/ai-lab/recognize", fields, prepared, "ai.jpg") as unknown as Promise<RecognizeResult>;
}
