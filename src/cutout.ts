/**
 * 自動去背（純函數，只處理 RGBA 像素，不依賴 DOM，可在 Node 測試）。
 *
 * 只處理「背景有規律」的情況，不需要任何 AI 模型或付費 API：
 *  1. 真透明（alpha 通道已有透明像素）→ 不處理。
 *  2. 假透明：棋盤格被畫進圖片像素裡（網店商品圖、截圖常見）→ 去除。
 *  3. 純色／近乎純色背景（白底棚拍等）→ 去除。
 *  4. 其他（複雜實景背景）→ 不處理，原樣保留，並回報原因。
 *
 * 做法：從圖片四邊開始 flood fill，只清除「連著邊緣」而且顏色屬於背景的像素，
 * 所以衣服裡面的白玫瑰、白蕾絲不會被誤刪。再清掉 1–2 px 的灰白邊並輕微柔化邊緣。
 */

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type BackgroundKind = "transparent" | "checkerboard" | "solid" | "unknown";

export interface CutoutResult {
  /** 偵測到的背景類型 */
  kind: BackgroundKind;
  /** 是否已修改像素（true 才需要上傳去背圖） */
  applied: boolean;
  /** 被去除的面積比例（0–1） */
  removed: number;
  /** 沒有處理的原因（給使用者看） */
  reason?: string;
}

/** 超過這個像素數就不處理（iOS Safari 的 canvas 上限約 16.7 MP，並避免記憶體不足） */
export const MAX_CUTOUT_PIXELS = 12_000_000;

const lumOf = (d: Uint8ClampedArray, i: number) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
const spreadOf = (d: Uint8ClampedArray, i: number) => Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);

/** 已有真正透明像素？（含邊緣一圈） */
export function hasRealTransparency(img: RgbaImage): boolean {
  const { data, width: w, height: h } = img;
  let n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 400_000)));
  let total = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      total++;
      if (data[(y * w + x) * 4 + 3] < 250) n++;
    }
  }
  return n / total >= 0.002;
}

interface RingStats {
  indices: number[]; // 邊緣一圈的像素位置（pixel index）
}

function ringPixels(w: number, h: number): RingStats {
  const t = Math.max(2, Math.round(Math.min(w, h) * 0.008));
  const indices: number[] = [];
  const stepX = Math.max(1, Math.floor(w / 800));
  const stepY = Math.max(1, Math.floor(h / 800));
  for (let y = 0; y < h; y++) {
    if (y < t || y >= h - t) {
      for (let x = 0; x < w; x += stepX) indices.push(y * w + x);
    } else if (y % stepY === 0) {
      for (let x = 0; x < t; x++) indices.push(y * w + x);
      for (let x = w - t; x < w; x++) indices.push(y * w + x);
    }
  }
  return { indices };
}

/** 沿邊緣取一行／一列，計算兩種顏色來回切換的次數及平均格子大小 */
function edgeSwitches(img: RgbaImage, mid: number): { switches: number; medianRun: number } {
  const { data, width: w, height: h } = img;
  const lines: number[][] = [];
  const inset = Math.max(1, Math.round(Math.min(w, h) * 0.004));
  const top: number[] = [], bottom: number[] = [], left: number[] = [], right: number[] = [];
  for (let x = 0; x < w; x++) {
    top.push(lumOf(data, (inset * w + x) * 4));
    bottom.push(lumOf(data, ((h - 1 - inset) * w + x) * 4));
  }
  for (let y = 0; y < h; y++) {
    left.push(lumOf(data, (y * w + inset) * 4));
    right.push(lumOf(data, (y * w + (w - 1 - inset)) * 4));
  }
  lines.push(top, bottom, left, right);
  let switches = 0;
  const runs: number[] = [];
  for (const line of lines) {
    let prev = line[0] > mid;
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      const cur = line[i] > mid;
      if (cur === prev) run++;
      else {
        if (run >= 3) {
          switches++;
          runs.push(run);
        }
        prev = cur;
        run = 1;
      }
    }
  }
  runs.sort((a, b) => a - b);
  return { switches, medianRun: runs.length ? runs[Math.floor(runs.length / 2)] : 0 };
}

interface BgModel {
  kind: "checkerboard" | "solid";
  /** 背景像素的判斷（傳入 pixel offset，即 index*4） */
  isBg: (d: Uint8ClampedArray, i: number) => boolean;
  /** 比 isBg 寬鬆，用來清除邊緣灰白邊 */
  isHalo: (d: Uint8ClampedArray, i: number) => boolean;
  tile: number;
  lowLum?: number;
  highLum?: number;
}

function detectBackground(img: RgbaImage): BgModel | { reason: string } {
  const { data, width: w, height: h } = img;
  const ring = ringPixels(w, h).indices;
  if (ring.length < 50) return { reason: "圖片太小" };

  // ── 棋盤格：邊緣幾乎全是「中性灰白」，且分成兩種亮度並且來回交替 ──
  const lums: number[] = [];
  let neutralLight = 0;
  for (const p of ring) {
    const i = p * 4;
    if (spreadOf(data, i) <= 18 && lumOf(data, i) >= 170) {
      neutralLight++;
      lums.push(lumOf(data, i));
    }
  }
  if (neutralLight / ring.length >= 0.55 && lums.length > 40) {
    lums.sort((a, b) => a - b);
    // 2-means（以亮度）
    let lo = lums[Math.floor(lums.length * 0.05)];
    let hi = lums[Math.floor(lums.length * 0.95)];
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      let sl = 0, nl = 0, sh = 0, nh = 0;
      for (const v of lums) {
        if (v <= mid) { sl += v; nl++; } else { sh += v; nh++; }
      }
      if (nl) lo = sl / nl;
      if (nh) hi = sh / nh;
    }
    const gap = hi - lo;
    const mid = (lo + hi) / 2;
    const shareLo = lums.filter((v) => v <= mid).length / lums.length;
    if (gap >= 10 && gap <= 90 && shareLo >= 0.2 && shareLo <= 0.8) {
      const { switches, medianRun } = edgeSwitches(img, mid);
      if (switches >= 10 && medianRun >= 4) {
        const tol = Math.min(12, Math.max(6, gap * 0.4));
        return {
          kind: "checkerboard",
          tile: medianRun,
          lowLum: lo,
          highLum: hi,
          isBg: (d, i) => {
            if (spreadOf(d, i) > 20) return false;
            const l = lumOf(d, i);
            return Math.abs(l - lo) <= tol || Math.abs(l - hi) <= tol;
          },
          isHalo: (d, i) => spreadOf(d, i) <= 28 && lumOf(d, i) >= lo - 45,
        };
      }
    }
  }

  // ── 純色背景：邊緣一圈九成以上都接近同一種顏色 ──
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (const p of ring) {
    rs.push(data[p * 4]); gs.push(data[p * 4 + 1]); bs.push(data[p * 4 + 2]);
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mr = med(rs), mg = med(gs), mb = med(bs);
  const dist = (d: Uint8ClampedArray, i: number) => Math.max(Math.abs(d[i] - mr), Math.abs(d[i + 1] - mg), Math.abs(d[i + 2] - mb));
  const ds = ring.map((p) => dist(data, p * 4)).sort((a, b) => a - b);
  const p90 = ds[Math.floor(ds.length * 0.9)];
  if (p90 <= 26) {
    const tol = Math.min(40, Math.max(14, p90 * 1.5 + 8));
    return {
      kind: "solid",
      tile: 0,
      isBg: (d, i) => dist(d, i) <= tol,
      isHalo: (d, i) => dist(d, i) <= tol * 2.2,
    };
  }
  return { reason: "背景不是棋盤格或純色（需要 AI 去背）" };
}

/** 從四邊 flood fill，回傳被標記為背景的 mask（1＝背景） */
function floodFromEdges(img: RgbaImage, isBg: (d: Uint8ClampedArray, i: number) => boolean): Uint8Array {
  const { data, width: w, height: h } = img;
  const mask = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (p: number) => {
    if (mask[p] === 0 && isBg(data, p * 4)) {
      mask[p] = 1;
      stack[sp++] = p;
    }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  return mask;
}

/**
 * 被衣服圍住、沒有連到邊緣的棋盤格洞（例如蕾絲孔、肩帶之間）：
 * 只有當一整塊都屬於背景色、面積夠大，而且同時含有兩種棋盤格顏色時才清除，
 * 單一顏色的白玫瑰、白布料不會中招。
 */
function removeEnclosedCheckerHoles(img: RgbaImage, mask: Uint8Array, model: BgModel): number {
  const { data, width: w, height: h } = img;
  const lo = model.lowLum!, hi = model.highLum!;
  const mid = (lo + hi) / 2;
  const minArea = Math.max(200, Math.round(model.tile * model.tile * 1.5));
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let removed = 0;
  for (let start = 0; start < w * h; start++) {
    if (mask[start] || seen[start] || !model.isBg(data, start * 4)) continue;
    let sp = 0, area = 0, nLo = 0, nHi = 0;
    const comp: number[] = [];
    seen[start] = 1;
    stack[sp++] = start;
    while (sp > 0) {
      const p = stack[--sp];
      area++;
      comp.push(p);
      if (lumOf(data, p * 4) <= mid) nLo++; else nHi++;
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < w * (h - 1) ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && !seen[q] && !mask[q] && model.isBg(data, q * 4)) {
          seen[q] = 1;
          stack[sp++] = q;
        }
      }
    }
    if (area >= minArea && nLo / area >= 0.25 && nHi / area >= 0.25) {
      for (const p of comp) mask[p] = 1;
      removed += area;
    }
  }
  return removed;
}

/** 清除貼著透明區的灰白邊（最多 2 圈），再把邊緣輕微柔化 */
function refineEdges(img: RgbaImage, mask: Uint8Array, model: BgModel) {
  const { data, width: w, height: h } = img;
  const touches = (p: number) => {
    const x = p % w;
    return (x > 0 && mask[p - 1] === 1) || (x < w - 1 && mask[p + 1] === 1) || (p >= w && mask[p - w] === 1) || (p < w * (h - 1) && mask[p + w] === 1);
  };
  for (let round = 0; round < 2; round++) {
    const toClear: number[] = [];
    for (let p = 0; p < w * h; p++) {
      if (mask[p] === 0 && touches(p) && model.isHalo(data, p * 4)) toClear.push(p);
    }
    if (!toClear.length) break;
    for (const p of toClear) mask[p] = 1;
  }
  // 寫入 alpha：背景＝0；貼著背景的像素依周圍 3×3 的不透明比例柔化
  for (let p = 0; p < w * h; p++) data[p * 4 + 3] = mask[p] ? 0 : 255;
  const soft: Array<[number, number]> = [];
  for (let p = 0; p < w * h; p++) {
    if (mask[p] === 0 && touches(p)) {
      const x = p % w, y = (p - x) / w;
      let solid = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          cnt++;
          if (mask[yy * w + xx] === 0) solid++;
        }
      }
      soft.push([p, Math.round(255 * Math.min(1, (solid + 1.5) / (cnt + 1.5)))]);
    }
  }
  for (const [p, a] of soft) data[p * 4 + 3] = a;
}

/**
 * 嘗試自動去背。就地修改 img.data 的 alpha（只有 applied=true 時才改）。
 */
export function autoCutout(img: RgbaImage): CutoutResult {
  const { width: w, height: h } = img;
  if (w * h > MAX_CUTOUT_PIXELS) return { kind: "unknown", applied: false, removed: 0, reason: "圖片太大，不自動去背" };
  if (hasRealTransparency(img)) return { kind: "transparent", applied: false, removed: 0 };

  const model = detectBackground(img);
  if ("reason" in model) return { kind: "unknown", applied: false, removed: 0, reason: model.reason };

  const backup = new Uint8ClampedArray(img.data); // 失敗時還原
  const mask = floodFromEdges(img, model.isBg);
  let removed = 0;
  for (let p = 0; p < mask.length; p++) removed += mask[p];
  if (model.kind === "checkerboard") removed += removeEnclosedCheckerHoles(img, mask, model);

  const frac = removed / (w * h);
  if (frac < 0.01) return { kind: model.kind, applied: false, removed: frac, reason: "沒有找到可去除的背景" };
  if (frac > 0.93) return { kind: model.kind, applied: false, removed: frac, reason: "幾乎整張圖都被判斷為背景，已放棄去背" };

  refineEdges(img, mask, model);
  let finalRemoved = 0;
  for (let p = 0; p < mask.length; p++) finalRemoved += mask[p];
  if (finalRemoved / (w * h) > 0.93) {
    img.data.set(backup);
    return { kind: model.kind, applied: false, removed: frac, reason: "邊緣處理後背景比例異常，已放棄去背" };
  }
  return { kind: model.kind, applied: true, removed: finalRemoved / (w * h) };
}
