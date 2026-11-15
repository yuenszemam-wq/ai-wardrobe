/// <reference lib="webworker" />
/** Cutout Studio Web Worker：保存一份原圖像素，執行昂貴的遮罩運算，避免手機畫面凍結。 */
import type { RgbaImage } from "./maskEngine";
import { HeavyOp, runHeavy } from "./maskOps";

let src: RgbaImage | null = null;
self.onmessage = (e: MessageEvent<{ id: number; init?: RgbaImage; req?: HeavyOp }>) => {
  const { id, init, req } = e.data;
  try {
    if (init) { src = init; (self as unknown as Worker).postMessage({ id, ok: true }); return; }
    if (!src || !req) throw new Error("工作執行緒未初始化");
    const r = runHeavy(src, req);
    (self as unknown as Worker).postMessage({ id, ok: true, result: r }, [r.mask.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error).message || String(err) });
  }
};
