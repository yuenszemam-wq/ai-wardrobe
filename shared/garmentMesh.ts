// 衣物變形（Phase 3.1）：連續三角網格＋骨骼權重混合（Linear Blend Skinning）。
// 整件衣物是「一張連續的網格」：每個頂點受一至數節骨骼影響，相鄰骨骼之間的權重平滑過渡。
// 所以無論姿勢怎樣，衣物只會被拉伸或彎曲，不會像舊做法（分區各自移動）那樣斷開成碎片。
// 部件（衣身／左右袖／左右腿）只用來決定權重；辨認不可靠時整件當作衣身（完整衣物模式）。
// 全部是純函數，前端及測試共用。座標＝1200×1800 邏輯畫布像素。
import { RIG_V2 } from "./avatarV2";
import { Mat, applyMat, boneMap, multiply, rotateAbout } from "./avatarRig";
import { Fit, Follow, SkinKind, fitHeight, fromImage, toImage } from "./doll";

export interface AlphaField { w: number; h: number; data: Uint8Array }
/** 部件編號 */
export const PART = { body: 0, sleeve_r: 1, sleeve_l: 2, leg_r: 3, leg_l: 4 } as const;
export const PART_LABEL = ["衣身", "右袖", "左袖", "右腿", "左腿"];
export interface PartMap { w: number; h: number; data: Uint8Array }

type Pt = [number, number];
const B = boneMap(RIG_V2);
const piv = (id: string): Pt => B.get(id)!.pivot as Pt;
const ss = (a: number, b: number, v: number) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const MIRROR = piv("shoulder_r")[0] + piv("shoulder_l")[0];
const CENTER = MIRROR / 2;
const SR = piv("shoulder_r");
const CHEST_Y = piv("chest")[1], WAIST_Y = piv("torso")[1], CROTCH_Y = piv("hip_r")[1] - 14;
const OPAQUE = 48;
const sample = (g: AlphaField, u: number, v: number) => (u < 0 || v < 0 || u >= 1 || v >= 1 ? 0 : g.data[Math.floor(v * g.h) * g.w + Math.floor(u * g.w)]);

export interface AutoParts {
  /** 與透明度格同樣大小的部件編號 */
  labels: Uint8Array;
  sleeve_r: boolean;
  sleeve_l: boolean;
  /** 找到袖子但把握不足（已退回整件） */
  unsure: boolean;
}

/**
 * 自動分辨袖子（上身衣物）：
 * 1. 逐行由身體中線向外找「衣身」的闊度，取腋下至腰之間較窄的闊度作為衣身側線；
 * 2. 側線以外、而且與肩膊附近的布料相連的部分＝袖子（袖子與衣身之間有空隙時，分界就在空隙）；
 * 3. 衣襬、裙身即使比衣身闊，因為沒有經側線以外連到肩膊，不會被當成袖子；
 * 4. 袖子佔半件衣物的比例不合理時（例如長袖垂在裙身上連成一片）視為沒有把握，保持整件。
 * loose＝上衣／外套（袖子可以比衣身大）；連身裙的上限較嚴，避免把裙身當成袖子。
 */
export function detectSleeves(grid: AlphaField, fit: Fit, ar: number, loose = false): AutoParts {
  const labels = new Uint8Array(grid.w * grid.h);
  const out: AutoParts = { labels, sleeve_r: false, sleeve_l: false, unsure: false };
  // 衣物在畫布上的範圍
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]] as Pt[]) { const [x, y] = fromImage(fit, ar, u, v); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const s = Math.min(6, Math.max(3, fit.w / 170));
  const W = Math.min(520, Math.ceil((x1 - x0) / s)), H = Math.min(640, Math.ceil((y1 - y0) / s));
  if (W < 4 || H < 4) return out;
  const op = new Uint8Array(W * H);
  let top = H, bottom = -1;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const [u, v] = toImage(fit, ar, x0 + (i + 0.5) * s, y0 + (j + 0.5) * s);
    if (sample(grid, u, v) > OPAQUE) { op[j * W + i] = 1; if (j < top) top = j; if (j > bottom) bottom = j; }
  }
  if (bottom < 0) return out;
  const raster = new Uint8Array(W * H);
  const Y = (j: number) => y0 + (j + 0.5) * s;
  for (const side of ["r", "l"] as const) {
    // 以角色右邊（畫面左方）為準；左邊用鏡像座標
    const col = (xm: number) => Math.floor(((side === "r" ? xm : MIRROR - xm) - x0) / s);
    const at = (xm: number, j: number) => { const i = col(xm); return i >= 0 && i < W ? op[j * W + i] : 0; };
    const xmOf = (i: number) => { const x = x0 + (i + 0.5) * s; return side === "r" ? x : MIRROR - x; };
    const raw = new Float32Array(H).fill(NaN), inner: number[] = [];
    let lastBody = -1;
    for (let j = top; j <= bottom; j++) {
      let xm = CENTER - s / 2, seen = false;
      // 中線位置可以是空的（JSK 領口、打開的外套），先向外找到衣身
      for (; xm > CENTER - 130; xm -= s) if (at(xm, j)) { seen = true; break; }
      if (!seen) {
        // 衣身已經到底、外面還有布料（袖子比衣襬長）：袖子內側的位置也是衣身側線的線索
        if (lastBody >= 0 && Y(j) - Y(lastBody) < 70) for (; xm > CENTER - 420; xm -= s) if (at(xm, j)) { inner.push(CENTER - xm - s / 2); break; }
        continue;
      }
      while (at(xm - s, j)) xm -= s;
      // 很窄的不算衣身（抽繩、吊飾）
      if (CENTER - xm < 48) { if (lastBody >= 0 && Y(j) - Y(lastBody) < 70) for (xm -= s; xm > CENTER - 420; xm -= s) if (at(xm, j)) { inner.push(CENTER - xm - s / 2); break; } continue; }
      raw[j] = CENTER - xm + s / 2;
      lastBody = j;
    }
    // 上下幾行取中位數：個別行被蕾絲孔打斷不會影響分界；連續多行的空隙（真正的腋下）才算
    const wRow = new Float32Array(H).fill(NaN);
    for (let j = top; j <= bottom; j++) {
      if (Number.isNaN(raw[j])) continue;
      const a: number[] = [];
      for (let d = -2; d <= 2; d++) { const v = raw[j + d]; if (j + d >= top && j + d <= bottom && !Number.isNaN(v)) a.push(v); }
      a.sort((p, q) => p - q);
      wRow[j] = a[a.length >> 1];
    }
    const pick = (lo: number, hi: number) => { const a: number[] = []; for (let j = top; j <= bottom; j++) if (!Number.isNaN(wRow[j]) && Y(j) >= lo && Y(j) <= hi) a.push(wRow[j]); a.sort((p, q) => p - q); return a; };
    let ws = pick(SR[1] + 70, WAIST_Y + 35);
    if (ws.length < 5) ws = pick(Y(top) + (Y(bottom) - Y(top)) * 0.45, Y(bottom));
    if (ws.length < 5) continue;
    // 線索一：腋下至腰之間最窄的幾行（袖子與衣身之間看得見空隙的位置）
    let body = ws[Math.floor(ws.length * 0.1)];
    // 線索二：衣身底下已經沒有布料、但外面還有（袖子比衣襬長）→ 袖子內側就是衣身側線
    if (inner.length >= 4) { inner.sort((p, q) => p - q); body = Math.min(body, inner[Math.floor(inner.length * 0.3)] - s); }
    // 線索三：由下面看的輪廓。衣身各直行的下緣都在衣襬附近；向外走到下緣突然高很多（泡袖底下是空的）
    // 或低很多（袖口比衣襬長）的位置，就是衣身的盡頭
    const low = (xm: number) => { const i = col(xm); if (i < 0 || i >= W) return NaN; for (let j = bottom; j >= top; j--) if (op[j * W + i]) return Y(j); return NaN; };
    const mid: number[] = [];
    for (let d = s / 2; d <= 56; d += s) { const v = low(CENTER - d); if (!Number.isNaN(v)) mid.push(v); }
    if (mid.length >= 6) {
      mid.sort((p, q) => p - q);
      const hem = mid[mid.length >> 1], T = Math.max(22, 0.07 * (hem - Y(top)));
      let run = 0, empty = 0;
      for (let d = 64; d < 460; d += s) {
        const v = low(CENTER - d);
        if (Number.isNaN(v)) { if ((empty += s) > 40) break; continue; }
        empty = 0;
        if (Math.abs(v - hem) > T) { if (++run >= 3) { body = Math.min(body, d - 3 * s); break; } } else run = 0;
      }
    }
    body = Math.max(64, body);
    const cap = body + Math.max(14, body * 0.07);
    const outside = new Uint8Array(W * H);
    let half = 0;
    for (let j = top; j <= bottom; j++) {
      const y = Y(j), limit = Number.isNaN(wRow[j]) ? cap : Math.min(wRow[j] + s * 0.5, cap);
      for (let i = 0; i < W; i++) {
        if (!op[j * W + i]) continue;
        const xm = xmOf(i), d = CENTER - xm;
        if (d <= 0) continue;
        half++;
        if (d <= Math.max(64, limit)) continue;
        // 肩膊以上只限肩頭附近（泡袖頂部），避免把領子、兜帽算進袖子
        if (y < SR[1] - 15 && Math.hypot(xm - SR[0], y - SR[1]) > 140) continue;
        outside[j * W + i] = 1;
      }
    }
    // 由肩膊高度附近的布料開始，沿相連的範圍擴展
    const stack: number[] = [], mark = new Uint8Array(W * H);
    for (let j = top; j <= bottom; j++) { const y = Y(j); if (y < SR[1] - 80 || y > SR[1] + 190) continue; for (let i = 0; i < W; i++) if (outside[j * W + i]) { mark[j * W + i] = 1; stack.push(j * W + i); } }
    let area = 0, far = 0, ya = Infinity, yb = -Infinity;
    while (stack.length) {
      const k = stack.pop()!, i = k % W, j = (k - i) / W;
      area++;
      far = Math.max(far, CENTER - xmOf(i)); ya = Math.min(ya, Y(j)); yb = Math.max(yb, Y(j));
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const n = nj * W + ni;
        if (outside[n] && !mark[n]) { mark[n] = 1; stack.push(n); }
      }
    }
    // 太細小的（肩帶旁的荷葉邊、腰側的裝飾）不算袖子
    if (area * s * s < 1500 || far - cap < 60 || (far - cap < 90 && yb - ya < 110)) continue;
    // 袖根（袖子與衣身相接的位置）應該在肩膊附近；否則只找到袖子的一部分，強行變形會把布料扯長
    let rx = 0, ry = 0, rn = 0;
    for (let j = top; j <= bottom; j++) for (let i = 1; i < W - 1; i++) {
      const k = j * W + i;
      if (!mark[k]) continue;
      const inward = side === "r" ? k + 1 : k - 1;
      if (op[inward] && !mark[inward]) { rx += xmOf(i); ry += Y(j); rn++; }
    }
    if (rn && Math.hypot(rx / rn - SR[0], ry / rn - SR[1]) > 190) { out.unsure = true; continue; }
    if (area > half * (loose ? 0.78 : 0.5)) { out.unsure = true; continue; }
    const id = side === "r" ? PART.sleeve_r : PART.sleeve_l;
    for (let k = 0; k < mark.length; k++) if (mark[k]) raster[k] = id;
    if (side === "r") out.sleeve_r = true; else out.sleeve_l = true;
  }
  if (!out.sleeve_r && !out.sleeve_l) return out;
  for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) {
    const [x, y] = fromImage(fit, ar, (i + 0.5) / grid.w, (j + 0.5) / grid.h);
    const ri = Math.floor((x - x0) / s), rj = Math.floor((y - y0) / s);
    if (ri >= 0 && rj >= 0 && ri < W && rj < H) labels[j * grid.w + i] = raster[rj * W + ri];
  }
  // 清理：不與衣身主體相連、只是夾在袖子邊緣的零碎位置（取樣誤差、蝴蝶結、荷葉邊）歸入旁邊的袖子
  const n = grid.w * grid.h, core = new Uint8Array(n);
  let cur: number[] = [];
  for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) {
    const k = j * grid.w + i;
    if (grid.data[k] <= OPAQUE || labels[k]) continue;
    if (Math.abs(fromImage(fit, ar, (i + 0.5) / grid.w, (j + 0.5) / grid.h)[0] - CENTER) < 64) { core[k] = 1; cur.push(k); }
  }
  const near = (k: number) => { const i = k % grid.w, j = (k - i) / grid.w; return [i > 0 ? k - 1 : -1, i < grid.w - 1 ? k + 1 : -1, j > 0 ? k - grid.w : -1, j < grid.h - 1 ? k + grid.w : -1]; };
  while (cur.length) { const next: number[] = []; for (const k of cur) for (const q of near(k)) if (q >= 0 && !core[q] && grid.data[q] > OPAQUE && !labels[q]) { core[q] = 1; next.push(q); } cur = next; }
  for (let k = 0; k < n; k++) if (labels[k] && grid.data[k] > OPAQUE) cur.push(k);
  while (cur.length) { const next: number[] = []; for (const k of cur) for (const q of near(k)) if (q >= 0 && !core[q] && grid.data[q] > OPAQUE && !labels[q]) { labels[q] = labels[k]; next.push(q); } cur = next; }
  return out;
}

/** 使用者要求袖子跟隨、但輪廓找不到袖子時：按角色手臂位置劃分（保守範圍） */
function armZone(grid: AlphaField, fit: Fit, ar: number): Uint8Array {
  const labels = new Uint8Array(grid.w * grid.h);
  const E = piv("elbow_r"), Wr = piv("wrist_r");
  const line: Pt[] = [SR, E, Wr];
  const dist = (px: number, py: number) => { let d = Infinity; for (let i = 0; i < 2; i++) { const a = line[i], b = line[i + 1], dx = b[0] - a[0], dy = b[1] - a[1]; const t = Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy))); d = Math.min(d, Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy)); } return d; };
  const bound = (y: number) => (y <= SR[1] ? SR[0] : y <= E[1] ? SR[0] + ((y - SR[1]) / (E[1] - SR[1])) * (E[0] + 40 - SR[0]) : E[0] + 40 + ((y - E[1]) / (Wr[1] - E[1])) * (Wr[0] + 60 - E[0] - 40));
  for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) {
    if (grid.data[j * grid.w + i] <= OPAQUE) continue;
    const [x, y] = fromImage(fit, ar, (i + 0.5) / grid.w, (j + 0.5) / grid.h);
    for (const side of [1, 2] as const) { const xm = side === 1 ? x : MIRROR - x; if (xm < bound(y) && dist(xm, y) < 118) labels[j * grid.w + i] = side; }
  }
  return labels;
}

/** 褲、襪、鞋：胯部以下按左右分給兩條腿；整塊都在一邊的獨立布料（一隻襪、一隻鞋）整塊跟隨那條腿 */
export function detectLegs(grid: AlphaField, fit: Fit, ar: number): Uint8Array {
  const { w, h } = grid, labels = new Uint8Array(w * h), comp = new Int32Array(w * h).fill(-1);
  const pos = new Float32Array(w * h * 2);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const [x, y] = fromImage(fit, ar, (i + 0.5) / w, (j + 0.5) / h); pos[(j * w + i) * 2] = x; pos[(j * w + i) * 2 + 1] = y; }
  let n = 0;
  for (let k0 = 0; k0 < w * h; k0++) {
    if (grid.data[k0] <= OPAQUE || comp[k0] >= 0) continue;
    const cells: number[] = [], stack = [k0];
    comp[k0] = n;
    let sx = 0, minY = Infinity, minX = Infinity, maxX = -Infinity;
    while (stack.length) {
      const k = stack.pop()!, i = k % w, j = (k - i) / w;
      cells.push(k); sx += pos[k * 2]; minY = Math.min(minY, pos[k * 2 + 1]); minX = Math.min(minX, pos[k * 2]); maxX = Math.max(maxX, pos[k * 2]);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue; const q = nj * w + ni; if (grid.data[q] > OPAQUE && comp[q] < 0) { comp[q] = n; stack.push(q); } }
    }
    n++;
    const cx = sx / cells.length;
    // 整塊都在胯部以下、而且大部分在一邊：整塊屬於那條腿
    const whole = minY > CROTCH_Y - 60 && (maxX < CENTER + 25 || minX > CENTER - 25) ? (cx < CENTER ? PART.leg_r : PART.leg_l) : 0;
    for (const k of cells) labels[k] = whole || (pos[k * 2 + 1] > CROTCH_Y ? (pos[k * 2] < CENTER ? PART.leg_r : PART.leg_l) : 0);
  }
  return labels;
}

/** 沿相連的布料量度距離（格數）：由 isSrc 的格出發，只經過不透明的格，最遠到 limit */
function spread(grid: AlphaField, isSrc: (k: number) => boolean, limit: number): Float32Array {
  const { w, h } = grid, d = new Float32Array(w * h).fill(Infinity);
  let cur: number[] = [];
  for (let k = 0; k < w * h; k++) if (isSrc(k)) { d[k] = 0; cur.push(k); }
  for (let step = 1; cur.length && step <= limit; step++) {
    const next: number[] = [];
    for (const k of cur) {
      const i = k % w, j = (k - i) / w;
      for (const q of [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, j > 0 ? k - w : -1, j < h - 1 ? k + w : -1]) if (q >= 0 && d[q] === Infinity && grid.data[q] > 6) { d[q] = step; next.push(q); }
    }
    cur = next;
  }
  return d;
}

export interface RigInput {
  grid: AlphaField;
  fit: Fit;
  ar: number;
  kind: SkinKind;
  follow: Follow;
  /** 整件附接的骨骼（整件模式，或指定了骨骼時使用） */
  bone: string;
  /** 使用者指定了整件附接的骨骼 */
  pinned: boolean;
  /** 部件圖：null＝自動；"whole"＝不拆件；PartMap＝人工標記 */
  parts: PartMap | "whole" | null;
  sleeveRot?: [number, number];
  /** 上衣／外套：袖子可以比衣身大 */
  loose?: boolean;
}
export interface RigInfo {
  /** rigid＝整件跟隨一節骨骼；body＝連續網格但沒有拆出袖子／腿；parts＝有袖子或腿跟隨 */
  mode: "rigid" | "body" | "parts";
  source: "auto" | "manual" | "whole" | "zone";
  sleeve_r: boolean;
  sleeve_l: boolean;
  /** 袖子長到前臂、會跟手肘彎曲 */
  forearm: boolean;
  legs: boolean;
  unsure: boolean;
}
/** 一個部件的連續網格。部件內部不會斷開；部件之間（袖子與衣身）在袖根位置重疊並平滑接合。 */
export interface Mesh {
  part: number;
  cols: number; rows: number;
  /** 頂點（(cols+1)×(rows+1)）在圖片內的位置（0–1）及靜止畫布座標 */
  uv: Float32Array; rest: Float32Array;
  bones: { id: string; pre: Mat | null }[];
  /** 每個頂點對每節骨骼的權重（頂點數 × 骨骼數，每個頂點的總和＝1） */
  weights: Float32Array;
  /** 每格：-2＝沒有布料；-1＝混合（要逐個三角形畫）；≥0＝整格跟隨同一節骨骼 */
  cell: Int16Array;
  /** 繪畫次序（格的編號） */
  order: Int32Array;
  /** 這個部件佔圖片的範圍（與透明度格同樣大小，0–255）；null＝整張圖 */
  matte: Uint8Array | null;
}
export interface GarmentRig {
  /** 繪畫次序：衣身在下，袖子／腿在上 */
  layers: Mesh[];
  labels: PartMap;
  /** 部件範圍的識別碼（相同＝各部件的貼圖不用重做） */
  matteKey: string;
  info: RigInfo;
}
const resample = (p: PartMap, g: AlphaField) => { const out = new Uint8Array(g.w * g.h); for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) out[j * g.w + i] = p.data[Math.min(p.h - 1, Math.floor(((j + 0.5) / g.h) * p.h)) * p.w + Math.min(p.w - 1, Math.floor(((i + 0.5) / g.w) * p.w))]; return out; };
function hashBytes(a: Uint8Array) { let h = 0x811c9dc5, g = 7; for (let i = 0; i < a.length; i++) { h = Math.imul(h ^ a[i], 0x01000193); g = (Math.imul(g, 31) + a[i] * (i & 255)) | 0; } return (h >>> 0).toString(36) + (g >>> 0).toString(36); }

type Weigh = (x: number, y: number, out: Float32Array, o: number) => void;
/** 在部件範圍內建立網格 */
function meshFor(inp: RigInput, part: number, matte: Uint8Array | null, bones: Mesh["bones"], weigh: Weigh, cellSize: number): Mesh | null {
  const { grid, fit, ar } = inp;
  let i0 = grid.w, j0 = grid.h, i1 = -1, j1 = -1;
  for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) { const k = j * grid.w + i; if (grid.data[k] > 6 && (!matte || matte[k] > 4)) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; } }
  if (i1 < 0) { if (matte) return null; i0 = 0; j0 = 0; i1 = grid.w - 1; j1 = grid.h - 1; }
  const u0 = Math.max(0, (i0 - 1) / grid.w), u1 = Math.min(1, (i1 + 2) / grid.w), v0 = Math.max(0, (j0 - 1) / grid.h), v1 = Math.min(1, (j1 + 2) / grid.h);
  const H = fitHeight(fit, ar);
  const cols = Math.min(26, Math.max(2, Math.round(((u1 - u0) * fit.w) / cellSize))), rows = Math.min(40, Math.max(2, Math.round(((v1 - v0) * H) / cellSize)));
  const nv = (cols + 1) * (rows + 1), nb = bones.length;
  const uv = new Float32Array(nv * 2), rest = new Float32Array(nv * 2), weights = new Float32Array(nv * nb);
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
    const k = r * (cols + 1) + c, u = u0 + ((u1 - u0) * c) / cols, v = v0 + ((v1 - v0) * r) / rows;
    uv[k * 2] = u; uv[k * 2 + 1] = v;
    const [x, y] = fromImage(fit, ar, u, v);
    rest[k * 2] = x; rest[k * 2 + 1] = y;
    if (nb === 1) weights[k] = 1; else weigh(x, y, weights, k * nb);
  }
  const cell = new Int16Array(cols * rows), list: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const k = r * cols + c, a = r * (cols + 1) + c, vs = [a, a + 1, a + cols + 1, a + cols + 2];
    const ia = Math.max(0, Math.floor(uv[a * 2] * grid.w) - 1), ib = Math.min(grid.w - 1, Math.ceil(uv[(a + 1) * 2] * grid.w)), ja = Math.max(0, Math.floor(uv[a * 2 + 1] * grid.h) - 1), jb = Math.min(grid.h - 1, Math.ceil(uv[(a + cols + 1) * 2 + 1] * grid.h));
    let any = false;
    for (let j = ja; j <= jb && !any; j++) for (let i = ia; i <= ib; i++) { const q = j * grid.w + i; if (grid.data[q] > 4 && (!matte || matte[q] > 4)) { any = true; break; } }
    if (!any) { cell[k] = -2; continue; }
    let same = -1;
    for (let b = 0; b < nb; b++) if (vs.every((q) => weights[q * nb + b] > 0.995)) { same = b; break; }
    cell[k] = same;
    list.push(k);
  }
  // 同一節骨骼的格排在一起（可以合併成一次繪畫）；混合的格放在中間
  list.sort((p, q) => (cell[p] < 0 ? 0.5 : cell[p] === 0 ? -1 : cell[p]) - (cell[q] < 0 ? 0.5 : cell[q] === 0 ? -1 : cell[q]) || p - q);
  return { part, cols, rows, uv, rest, bones, weights, cell, order: Int32Array.from(list), matte };
}

/** 建立衣物的部件、網格及骨骼權重 */
export function buildRig(inp: RigInput): GarmentRig {
  const { grid, fit, ar } = inp;
  const info: RigInfo = { mode: "rigid", source: "auto", sleeve_r: false, sleeve_l: false, forearm: false, legs: false, unsure: false };
  let labels: Uint8Array = new Uint8Array(grid.w * grid.h);
  const done = (layers: (Mesh | null)[], matteKey = ""): GarmentRig => ({ layers: layers.filter((l): l is Mesh => !!l), labels: { w: grid.w, h: grid.h, data: labels }, matteKey, info });
  if (inp.kind === "rigid" || inp.pinned || inp.follow === "none") return done([meshFor(inp, 0, null, [{ id: inp.bone, pre: null }], () => undefined, 90)]);

  const cellPx = fit.w / grid.w;
  const trunk: Mesh["bones"] = ["pelvis", "torso", "chest"].map((id) => ({ id, pre: null }));
  const trunkW: Weigh = (_x, y, out, o) => { const wc = 1 - ss(CHEST_Y - 60, CHEST_Y + 60, y), wp = ss(WAIST_Y - 50, WAIST_Y + 50, y); out[o] = wp; out[o + 1] = 1 - wc - wp; out[o + 2] = wc; };
  const ids = inp.kind === "upper" ? [1, 2] : [3, 4];
  if (inp.kind === "upper") {
    if (inp.parts === "whole") info.source = "whole";
    else if (inp.parts) { labels = resample(inp.parts, grid); info.source = "manual"; for (let k = 0; k < labels.length; k++) if (labels[k] > 2) labels[k] = 0; }
    else {
      const a = detectSleeves(grid, fit, ar, !!inp.loose);
      labels = a.labels; info.unsure = a.unsure;
      // 使用者明確要求袖子跟隨，但輪廓找不到袖子：改用手臂位置的保守分區
      if (!a.sleeve_r && !a.sleeve_l && (inp.follow === "upper" || inp.follow === "full")) { labels = armZone(grid, fit, ar); info.source = "zone"; }
    }
  } else labels = detectLegs(grid, fit, ar);
  // 半透明的位置（抗鋸齒邊緣、薄紗、鏤空蕾絲）沿用最近的不透明布料的部件，否則袖子移開後會留下一圈輪廓
  {
    const { w, h } = grid, seen = new Uint8Array(w * h);
    let cur: number[] = [];
    for (let k = 0; k < w * h; k++) if (grid.data[k] > OPAQUE) { seen[k] = 1; cur.push(k); }
    while (cur.length) {
      const next: number[] = [];
      for (const k of cur) {
        const i = k % w, j = (k - i) / w;
        for (const q of [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, j > 0 ? k - w : -1, j < h - 1 ? k + w : -1]) if (q >= 0 && !seen[q] && grid.data[q] > 0) { seen[q] = 1; labels[q] = labels[k]; next.push(q); }
      }
      cur = next;
    }
  }
  const has = [false, false];
  for (let k = 0; k < labels.length; k++) if (grid.data[k] > OPAQUE) { if (labels[k] === ids[0]) has[0] = true; else if (labels[k] === ids[1]) has[1] = true; }
  if (inp.kind === "upper") { info.sleeve_r = has[0]; info.sleeve_l = has[1]; } else info.legs = has[0] || has[1];
  if (!has[0] && !has[1]) {
    info.mode = "body";
    return done([inp.kind === "upper" ? meshFor(inp, 0, null, trunk, trunkW, 32) : meshFor(inp, 0, null, [{ id: "pelvis", pre: null }], () => undefined, 90)]);
  }
  info.mode = "parts";
  // ───── 各部件佔圖片的範圍 ─────
  // 袖子／腿：自己的範圍，邊緣向衣身一側柔化少許；衣身：自己的範圍，另外伸入袖根底下一小段。
  // 靜止時兩層疊起來與原圖完全一樣；袖子移開時，袖根底下仍有布料，不會露出空洞。
  const feather = Math.max(1.5, 5 / cellPx), overlap = Math.max(2, 16 / cellPx);
  const n = grid.w * grid.h;
  const isBody = (k: number) => grid.data[k] > 6 && labels[k] !== ids[0] && labels[k] !== ids[1];
  const fromBody = spread(grid, isBody, Math.ceil(overlap + feather) + 1);
  const bodyMatte = new Uint8Array(n);
  let bodyAny = false;
  for (let k = 0; k < n; k++) { if (grid.data[k] <= 6) continue; bodyMatte[k] = isBody(k) ? 255 : Math.round(255 * (1 - ss(overlap, overlap + feather, fromBody[k]))); if (isBody(k)) bodyAny = true; }
  const limbMatte = ids.map((id, s) => {
    if (!has[s]) return null;
    const d = spread(grid, (k) => grid.data[k] > 6 && labels[k] === id, Math.ceil(feather) + 1), m = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (grid.data[k] > 6 && labels[k] !== ids[1 - s]) m[k] = labels[k] === id ? 255 : Math.round(255 * (1 - ss(0, feather, d[k])));
    return m;
  });
  const key = hashBytes(labels) + "|" + Math.round(feather * 10) + "|" + Math.round(overlap * 10);
  const layers: (Mesh | null)[] = [];
  if (inp.kind === "upper") {
    if (bodyAny) layers.push(meshFor(inp, 0, bodyMatte, trunk, trunkW, 32));
    const rot = inp.sleeveRot ?? [0, 0];
    const arms = (["r", "l"] as const).map((sd, idx) => {
      const S = piv("shoulder_" + sd), E = piv("elbow_" + sd), Wp = piv("wrist_" + sd), len = Math.hypot(Wp[0] - E[0], Wp[1] - E[1]);
      return { S, E, dir: [(Wp[0] - E[0]) / len, (Wp[1] - E[1]) / len] as Pt, pre: Math.abs(rot[idx]) >= 0.5 ? rotateAbout(rot[idx], S[0], S[1]) : null, sd };
    });
    const along = (a: (typeof arms)[number], x: number, y: number) => { const [px, py] = a.pre ? applyMat(a.pre, x, y) : [x, y]; return (px - a.E[0]) * a.dir[0] + (py - a.E[1]) * a.dir[1]; };
    // 袖子有沒有長到前臂
    let reach = -Infinity;
    if (inp.follow !== "upper") for (let j = 0; j < grid.h; j += 2) for (let i = 0; i < grid.w; i += 2) { const l = labels[j * grid.w + i]; if ((l === 1 || l === 2) && grid.data[j * grid.w + i] > OPAQUE) { const [x, y] = fromImage(fit, ar, (i + 0.5) / grid.w, (j + 0.5) / grid.h); reach = Math.max(reach, along(arms[l - 1], x, y)); } }
    info.forearm = inp.follow === "full" || (inp.follow !== "upper" && reach > 70);
    arms.forEach((a, s) => {
      if (!limbMatte[s]) return;
      const bones: Mesh["bones"] = [{ id: "chest", pre: null }, { id: "shoulder_" + a.sd, pre: a.pre }, { id: "elbow_" + a.sd, pre: a.pre }];
      // 袖根（肩關節附近）仍然跟隨上胸，向外逐漸過渡到手臂：袖子與衣身保持連接，彎曲位置平滑
      layers.push(meshFor(inp, ids[s], limbMatte[s], bones, (x, y, out, o) => {
        // 手肘的彎曲範圍：離手臂軸線愈遠（闊袖），過渡愈闊，布料才不會被扯長
        const [px, py] = a.pre ? applyMat(a.pre, x, y) : [x, y];
        const side = Math.abs((px - a.E[0]) * a.dir[1] - (py - a.E[1]) * a.dir[0]), band = 36 + side * 0.7;
        const t = ss(30, 115, Math.hypot(x - a.S[0], y - a.S[1])), lower = info.forearm ? ss(-band, band, along(a, x, y)) : 0;
        out[o] = 1 - t; out[o + 1] = t * (1 - lower); out[o + 2] = t * lower;
      }, 28));
    });
  } else {
    if (bodyAny) layers.push(meshFor(inp, 0, bodyMatte, [{ id: "pelvis", pre: null }], () => undefined, 90));
    (["r", "l"] as const).forEach((sd, s) => {
      if (!limbMatte[s]) return;
      const Hp = piv("hip_" + sd), K = piv("knee_" + sd), A = piv("ankle_" + sd), len = Math.hypot(A[0] - K[0], A[1] - K[1]), dir: Pt = [(A[0] - K[0]) / len, (A[1] - K[1]) / len];
      const bones: Mesh["bones"] = ["pelvis", "hip_" + sd, "knee_" + sd, "ankle_" + sd].map((id) => ({ id, pre: null }));
      layers.push(meshFor(inp, ids[s], limbMatte[s], bones, (x, y, out, o) => {
        const side = Math.abs((x - K[0]) * dir[1] - (y - K[1]) * dir[0]), band = 40 + side * 0.6;
        const t = bodyAny ? ss(Hp[1] - 30, Hp[1] + 70, y) : 1, shin = ss(-band, band, (x - K[0]) * dir[0] + (y - K[1]) * dir[1]), foot = ss(-30, 30, y - A[1]);
        out[o] = 1 - t; out[o + 1] = t * (1 - shin); out[o + 2] = t * shin * (1 - foot); out[o + 3] = t * shin * foot;
      }, 30));
    });
  }
  return done(layers, key);
}

/** 各節骨骼在目前姿勢下的矩陣（已計及袖子的靜止角度） */
export function boneMatrices(mesh: Mesh, mats: Record<string, Mat>): Mat[] {
  return mesh.bones.map((b) => { const m = mats[b.id] ?? mats.root; return b.pre ? multiply(m, b.pre) : m; });
}
/** 把網格頂點變到目前姿勢（Linear Blend Skinning） */
export function skinMesh(mesh: Mesh, mats: Record<string, Mat>, bm = boneMatrices(mesh, mats)): Float32Array {
  const nb = mesh.bones.length, nv = mesh.rest.length / 2, out = new Float32Array(nv * 2);
  for (let k = 0; k < nv; k++) {
    const x = mesh.rest[k * 2], y = mesh.rest[k * 2 + 1];
    let px = 0, py = 0;
    for (let b = 0; b < nb; b++) {
      const w = mesh.weights[k * nb + b];
      if (w <= 0) continue;
      const m = bm[b];
      px += w * (m[0] * x + m[2] * y + m[4]); py += w * (m[1] * x + m[3] * y + m[5]);
    }
    out[k * 2] = px; out[k * 2 + 1] = py;
  }
  return out;
}
/** 一格的四個頂點編號（左上、右上、左下、右下） */
export const cellVerts = (mesh: Mesh, k: number): [number, number, number, number] => { const c = k % mesh.cols, r = (k - c) / mesh.cols, a = r * (mesh.cols + 1) + c; return [a, a + 1, a + mesh.cols + 1, a + mesh.cols + 2]; };

/**
 * 逆向映射：畫面上的一點（邏輯座標，已變形）→ 圖片內的位置（0–1）。
 * 沿著實際變形後的網格尋找（由最上面的部件開始），所以任何姿勢下點選／塗抹的都是眼睛看到的那塊布料。找不到回傳 null。
 */
export function locate(rig: GarmentRig, posed: Float32Array[], x: number, y: number): [number, number] | null {
  const g = rig.labels;
  for (let li = rig.layers.length - 1; li >= 0; li--) {
    const mesh = rig.layers[li], P = posed[li];
    for (let n = mesh.order.length - 1; n >= 0; n--) {
      const [a, b, c, d] = cellVerts(mesh, mesh.order[n]);
      for (const [p, q, r] of [[a, b, c], [b, d, c]]) {
        const ax = P[p * 2], ay = P[p * 2 + 1], bx = P[q * 2] - ax, by = P[q * 2 + 1] - ay, cx = P[r * 2] - ax, cy = P[r * 2 + 1] - ay;
        const det = bx * cy - by * cx;
        if (Math.abs(det) < 1e-9) continue;
        const s = ((x - ax) * cy - (y - ay) * cx) / det, t = (bx * (y - ay) - by * (x - ax)) / det;
        if (s < -1e-4 || t < -1e-4 || s + t > 1 + 1e-4) continue;
        const w = 1 - s - t, u = w * mesh.uv[p * 2] + s * mesh.uv[q * 2] + t * mesh.uv[r * 2], v = w * mesh.uv[p * 2 + 1] + s * mesh.uv[q * 2 + 1] + t * mesh.uv[r * 2 + 1];
        // 這個位置要真的屬於這個部件（例如袖子的網格範圍內、但圖片上其實是衣身的位置，留給衣身那一層）
        if (mesh.matte && mesh.matte[Math.min(g.h - 1, Math.max(0, Math.floor(v * g.h))) * g.w + Math.min(g.w - 1, Math.max(0, Math.floor(u * g.w)))] < 128) continue;
        return [u, v];
      }
    }
  }
  return null;
}
/** 變形後衣物實際佔的範圍 [x0, y0, x1, y1] */
export function posedBounds(rig: GarmentRig, posed: Float32Array[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  rig.layers.forEach((mesh, li) => { for (const k of mesh.order) for (const v of cellVerts(mesh, k)) { const x = posed[li][v * 2], y = posed[li][v * 2 + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } });
  return [x0, y0, x1, y1];
}
/** 自動建議的袖子靜止角度：令袖子的方向貼近上臂（平放拍攝、袖子向外張開的衣物用） */
export function suggestSleeveRot(rig: GarmentRig, fit: Fit, ar: number): [number, number] {
  const out: [number, number] = [0, 0], g = rig.labels;
  for (const s of [1, 2] as const) {
    const S = piv(s === 1 ? "shoulder_r" : "shoulder_l"), E = piv(s === 1 ? "elbow_r" : "elbow_l");
    // 袖子的方向＝由肩膊指向袖子布料的重心
    let sx = 0, sy = 0, n = 0;
    for (let j = 0; j < g.h; j += 2) for (let i = 0; i < g.w; i += 2) if (g.data[j * g.w + i] === s) { const [x, y] = fromImage(fit, ar, (i + 0.5) / g.w, (j + 0.5) / g.h); sx += x; sy += y; n++; }
    if (n < 6) continue;
    let d = ((Math.atan2(E[1] - S[1], E[0] - S[0]) - Math.atan2(sy / n - S[1], sx / n - S[0])) * 180) / Math.PI;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    out[s - 1] = Math.round(Math.min(80, Math.max(-80, d * 0.8)));
  }
  return out;
}

/** 兩個姿勢相差多遠（最大的關節角度差，度）：用來提示「這個姿勢有對應的衣物校正」 */
export function poseDistance(a: Record<string, number> | null | undefined, b: Record<string, number> | null | undefined): number {
  let d = 0;
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    if (k.startsWith("hair") || k.startsWith("hp_")) continue;
    d = Math.max(d, Math.abs((a?.[k] ?? 0) - (b?.[k] ?? 0)) * (k.includes(".") ? 0.4 : 1));
  }
  return d;
}
