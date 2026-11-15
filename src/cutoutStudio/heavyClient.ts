/**
 * 昂貴運算用戶端：支援 Web Worker 時在背景執行；不支援或圖片太大（避免複製多一份原圖耗盡 iPhone 記憶體）時改在主執行緒執行。
 */
import type { RgbaImage } from "./maskEngine";
import { HeavyOp, HeavyResult, runHeavy } from "./maskOps";

const WORKER_MAX_PIXELS = 8_000_000;

export class HeavyClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: HeavyResult) => void; reject: (e: Error) => void }>();
  private ready: Promise<void> | null = null;
  readonly src: RgbaImage;
  mode: "worker" | "main" = "main";
  constructor(src: RgbaImage) {
    this.src = src;
    if (typeof Worker === "undefined" || src.width * src.height > WORKER_MAX_PIXELS) return;
    try {
      const w = new Worker(new URL("./mask.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: HeavyResult; error?: string }>) => {
        const p = this.pending.get(e.data.id); if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.result as HeavyResult); else p.reject(new Error(e.data.error || "處理失敗"));
      };
      w.onerror = () => { this.fail(new Error("工作執行緒錯誤")); };
      this.worker = w;
      this.mode = "worker";
      this.ready = this.post({ init: { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height } }).then(() => undefined);
    } catch { this.worker = null; this.mode = "main"; }
  }
  private post(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<HeavyResult> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, ...msg }, transfer);
    });
  }
  private fail(e: Error) {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.worker?.terminate(); this.worker = null; this.mode = "main";
  }
  async run(req: HeavyOp): Promise<HeavyResult> {
    if (this.worker) {
      try {
        await this.ready;
        const transfer: Transferable[] = [];
        if (req.op === "edge") { req = { ...req, mask: req.mask.slice() }; transfer.push(req.mask.buffer); }
        return await this.post({ req }, transfer);
      } catch { /* 工作執行緒失敗：改在主執行緒執行 */ this.fail(new Error("改用主執行緒")); }
    }
    await new Promise((r) => setTimeout(r, 16)); // 讓「處理中」先顯示
    return runHeavy(this.src, req);
  }
  dispose() { this.worker?.terminate(); this.worker = null; this.pending.clear(); }
}
