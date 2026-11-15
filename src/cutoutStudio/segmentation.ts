/**
 * Segmentation Provider Interface（為日後 AI 智能選取預留）。
 *
 * 第一階段只提供 ManualFloodProvider：以正向點做相連顏色選取、負向點排除、選取矩形限制範圍，
 * 完全在瀏覽器執行，不依賴任何 AI Binding、外部 API 或模型下載。
 *
 * 日後可加入 Segment Anything／SAM 2／輕量 SAM（Transformers.js、ONNX Runtime Web、WebGPU／WASM），
 * 但必須先驗證模型授權、瀏覽器相容性、下載大小、記憶體及 iPhone 效能。手動工具永遠不依賴這個接口。
 */
import { invertSelection, magicWand, RgbaImage } from "./maskEngine";

export interface SegmentationInput {
  image: RgbaImage;
  /** 正向（保留）點，原圖座標 */
  positivePoints: Array<{ x: number; y: number }>;
  /** 負向（排除）點 */
  negativePoints: Array<{ x: number; y: number }>;
  /** 選取矩形（可作 SAM 的 bounding box） */
  box?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** 現有遮罩（可選，模型可作提示） */
  mask?: Uint8Array | null;
  /** Provider 自訂選項，例如顏色容差 */
  options?: Record<string, number | boolean | string>;
}

export interface SegmentationCandidate {
  /** 候選選取遮罩（0–255），尺寸＝width×height */
  mask: Uint8Array;
  width: number;
  height: number;
  /** 0–1，可選品質指標 */
  score?: number;
}

export interface SegmentationResult {
  candidates: SegmentationCandidate[];
  model: { id: string; name: string; version: string; local: boolean };
}

export interface SegmentationProvider {
  readonly id: string;
  readonly name: string;
  /** 是否已可使用（AI 模型未下載／不支援時為 false；UI 不可顯示為可用功能） */
  available(): boolean;
  segment(input: SegmentationInput): Promise<SegmentationResult>;
}

/** 手動／Flood Fill Provider：免費、本機、即時 */
export class ManualFloodProvider implements SegmentationProvider {
  readonly id = "manual-flood";
  readonly name = "顏色相連選取";
  available() { return true; }
  async segment(input: SegmentationInput): Promise<SegmentationResult> {
    const { image, positivePoints, negativePoints, box } = input;
    const { width: w, height: h } = image;
    const tol = Number(input.options?.tolerance ?? 32);
    const contiguous = input.options?.contiguous !== false;
    const out = new Uint8Array(w * h);
    for (const p of positivePoints) {
      const s = magicWand(image, p.x, p.y, tol, contiguous);
      for (let i = 0; i < s.length; i++) if (s[i]) out[i] = 255;
    }
    for (const p of negativePoints) {
      const s = magicWand(image, p.x, p.y, tol, contiguous);
      for (let i = 0; i < s.length; i++) if (s[i]) out[i] = 0;
    }
    if (box) {
      const x0 = Math.max(0, Math.floor(Math.min(box.x0, box.x1))), x1 = Math.min(w, Math.ceil(Math.max(box.x0, box.x1)));
      const y0 = Math.max(0, Math.floor(Math.min(box.y0, box.y1))), y1 = Math.min(h, Math.ceil(Math.max(box.y0, box.y1)));
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < x0 || x >= x1 || y < y0 || y >= y1) out[y * w + x] = 0;
    }
    const inv = invertSelection(out);
    return {
      candidates: [{ mask: out, width: w, height: h, score: 1 }, { mask: inv, width: w, height: h, score: 0.5 }],
      model: { id: this.id, name: this.name, version: "1", local: true },
    };
  }
}

/** 已登記的 Provider。AI 分割模型（SAM 等）尚未實作，不會出現在此清單。 */
export const segmentationProviders: SegmentationProvider[] = [new ManualFloodProvider()];
