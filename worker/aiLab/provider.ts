/**
 * AI Provider Interface。第一個實作：Cloudflare Workers AI（env.AI.run）。
 * 日後可加入其他多模態模型；本階段不接駁任何付費第三方 API。
 */
export interface VisionRequest {
  system: string;
  user: string;
  /** 已縮小的 JPEG／PNG 位元組（不保存、不寫入日誌） */
  image?: Uint8Array | null;
  mime?: string;
  maxTokens: number;
  timeoutMs: number;
}
export interface VisionResponse {
  text: string;
  usage: { input_tokens: number | null; output_tokens: number | null };
}
export class ProviderError extends Error {
  code: string;
  /** 是否可能已產生費用（不確定時要保留預算預留） */
  maybeBilled: boolean;
  constructor(code: string, message: string, maybeBilled: boolean) { super(message); this.code = code; this.maybeBilled = maybeBilled; }
}
export interface AiProvider {
  readonly id: string;
  readonly model: string;
  vision(req: VisionRequest): Promise<VisionResponse>;
}

function toBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class WorkersAiProvider implements AiProvider {
  readonly id = "workers-ai";
  readonly model: string;
  private ai: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  constructor(ai: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> }, model: string) { this.ai = ai; this.model = model; }
  async vision(req: VisionRequest): Promise<VisionResponse> {
    // 依官方 schema：messages ＋ image（base64 data URL）；max_tokens 限制輸出
    const input = {
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
      ...(req.image ? { image: `data:${req.mime};base64,${toBase64(req.image)}` } : {}),
      max_tokens: req.maxTokens,
      temperature: 0.1,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        this.ai.run(this.model, input),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new ProviderError("timeout", "AI 請求逾時", true)), req.timeoutMs); }),
      ]);
      const o = (out ?? {}) as { response?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
      const text = typeof o.response === "string" ? o.response : o.response && typeof o.response === "object" ? JSON.stringify(o.response) : "";
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
      return { text, usage: { input_tokens: n(o.usage?.prompt_tokens), output_tokens: n(o.usage?.completion_tokens) } };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      const msg = String((e as Error)?.message ?? e);
      if (/5016|agree/i.test(msg)) throw new ProviderError("license_required", "需要先接受 Meta Llama 3.2 授權（須由擁有者確認）", false);
      if (/429|capacity|3040|daily|neurons|quota|4006/i.test(msg)) throw new ProviderError("quota_or_capacity", "Workers AI 額度用完或暫時沒有容量", false);
      throw new ProviderError("unavailable", "Workers AI 服務不可用", true);
    } finally { if (timer) clearTimeout(timer); }
  }
}
