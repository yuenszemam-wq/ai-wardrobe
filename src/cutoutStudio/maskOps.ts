/**
 * 較昂貴的遮罩運算（魔術棒、邊緣修正、自動去背）。Web Worker 及主執行緒後備共用同一份實作。
 */
import { autoCutout } from "../cutout";
import { RgbaImage, defringeMask, featherMask, magicWand, maskFromProcessed, morphMask, smoothMask } from "./maskEngine";

export type EdgeOp = "feather" | "expand" | "contract" | "smooth" | "defringe-white" | "defringe-color";

export type HeavyOp =
  | { op: "wand"; x: number; y: number; tolerance: number; contiguous: boolean }
  | { op: "edge"; kind: EdgeOp; radius: number; mask: Uint8Array }
  | { op: "auto" };

export type HeavyResult = { mask: Uint8Array; note?: string; kind?: string; applied?: boolean };

export function runHeavy(src: RgbaImage, req: HeavyOp): HeavyResult {
  const { width: w, height: h } = src;
  if (req.op === "wand") return { mask: magicWand(src, req.x, req.y, req.tolerance, req.contiguous) };
  if (req.op === "edge") {
    const m = req.mask, r = req.radius;
    switch (req.kind) {
      case "feather": return { mask: featherMask(m, w, h, r) };
      case "expand": return { mask: morphMask(m, w, h, r) };
      case "contract": return { mask: morphMask(m, w, h, -r) };
      case "smooth": return { mask: smoothMask(m, w, h, r) };
      case "defringe-white": return { mask: defringeMask(src, m, r, "white") };
      case "defringe-color": return { mask: defringeMask(src, m, r, "color") };
    }
  }
  // 自動去背：在副本上執行現有 autoCutout，再轉換成可編輯遮罩（不覆寫原圖）
  const copy: RgbaImage = { data: new Uint8ClampedArray(src.data), width: w, height: h };
  const r = autoCutout(copy);
  if (!r.applied) return { mask: new Uint8Array(0), applied: false, kind: r.kind, note: r.kind === "transparent" ? "原圖已是真正透明，保留現有透明度" : r.reason || "未能辨認背景" };
  return { mask: maskFromProcessed(src, copy), applied: true, kind: r.kind, note: r.kind === "checkerboard" ? "已移除假透明棋盤格" : "已移除純色背景" };
}
