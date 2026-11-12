// 衣物跟隨骨架的方法：不要求每件衣服預先拆件，而是按身體區域把同一張圖分成幾個「柔邊區域」，
// 每個區域跟隨一節骨骼（上臂、前臂、上胸、腰、骨盆、大腿、小腿、腳掌）。
// 區域在靜止姿勢的畫布座標下定義；相鄰區域在關節位置互相重疊（像球形關節），
// 所以靜止時與原圖完全一樣，活動時袖子、褲管、鞋襪會跟著手腳走。
import { RIG_V2 } from "./avatarV2";
import { boneMap } from "./avatarRig";

export interface SkinSegment { bone: string; alpha: (x: number, y: number) => number }
type Pt = [number, number];

const B = boneMap(RIG_V2);
const piv = (id: string): Pt => B.get(id)!.pivot as Pt;
const ss = (a: number, b: number, v: number) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
function distSeg(px: number, py: number, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}
const distLine = (px: number, py: number, pts: Pt[]) => { let d = Infinity; for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, distSeg(px, py, pts[i], pts[i + 1])); return d; };
const F = 14; // 柔邊闊度
const disc = (px: number, py: number, c: Pt, r: number) => 1 - ss(r, r + F, Math.hypot(px - c[0], py - c[1]));
/** 角色左右對稱軸；左邊（畫面右方）的區域由右邊鏡像得出 */
const MIRROR = piv("shoulder_r")[0] + piv("shoulder_l")[0];

// ───── 手臂（以角色右手＝畫面左方為準） ─────
const S = piv("shoulder_r"), E = piv("elbow_r"), W = piv("wrist_r");
const T: Pt = [W[0] - 62, W[1] + 95];
const ARMPIT_KEEP = 8;
const ARM_R = 118, SHOULDER_DISC = 42, ELBOW_DISC = 52;
const armLen = Math.hypot(W[0] - S[0], W[1] - S[1]);
const armDir: Pt = [(W[0] - S[0]) / armLen, (W[1] - S[1]) / armLen];
/** 手臂與身體之間的分界線（x 隨 y 變化） */
function armBoundary(y: number) {
  const pts: Pt[] = [[S[1], S[0]], [S[1] + 47, S[0] + 10], [E[1], E[0] + 47], [W[1], W[0] + 71]];
  if (y <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) if (y <= pts[i + 1][0]) return pts[i][1] + ((y - pts[i][0]) / (pts[i + 1][0] - pts[i][0])) * (pts[i + 1][1] - pts[i][1]);
  return pts[3][1] - (y - pts[3][0]) * 0.37;
}
/**
 * 由衣物本身的輪廓找出的「袖子與衣身之間的空隙」：at(y)＝該高度的分界 x（以角色右手一側為準）。
 * 有這項資料時，袖子按衣物實際形狀劃分，不受手臂位置限制（闊袖、垂袖也能整隻跟隨）。
 */
export interface SleeveGap { top: number; bottom: number; at: (y: number) => number }
function arm(x: number, y: number, full: boolean, gap?: SleeveGap | null) {
  const u = (x - E[0]) * armDir[0] + (y - E[1]) * armDir[1];
  // 短袖：只到手肘下少許。按衣物輪廓找到袖子時，整隻袖（連袖口）一起跟隨上臂
  const limit = full || gap ? 1 : 1 - ss(24, 24 + F, u);
  const dS = disc(x, y, S, SHOULDER_DISC), dE = disc(x, y, E, ELBOW_DISC);
  let zone: number, core: number;
  if (gap) {
    // 肩膊以上仍限制在手臂附近（避免把領子、兜帽算進袖子）；空隙以上由肩關節連到空隙頂部
    const cap = y < S[1] ? 1 - ss(ARM_R, ARM_R + F, Math.hypot(x - S[0], y - S[1])) : 1;
    const bx = y <= S[1] ? S[0] : y < gap.top ? S[0] + ((y - S[1]) / Math.max(1, gap.top - S[1])) * (gap.at(gap.top) - S[0]) : gap.at(Math.min(y, gap.bottom));
    const out = bx - x;
    const end = Number.isFinite(gap.bottom) ? 1 - ss(gap.bottom, gap.bottom + F, y) : 1;
    zone = cap * ss(-F, 0, out) * end * limit;
    core = cap * ss(0, F, out) * end;
  } else {
    const d = distLine(x, y, [S, E, W, T]);
    const out = armBoundary(y) - x;
    zone = (1 - ss(ARM_R, ARM_R + F, d)) * ss(-F, 0, out) * limit;
    // 身體一側保留一小段袖根（向外漸隱）：手臂外展時腋下不會出現空隙
    core = (1 - ss(ARM_R - F, ARM_R, d)) * ss(ARMPIT_KEEP, ARMPIT_KEEP + 30, out) * (full ? 1 : 1 - ss(24 - F, 24, u));
  }
  const lowerCore = full ? ss(0, F, u) * (1 - dE) : 0;
  return {
    upper: Math.max(zone, dS) * (1 - lowerCore),
    lower: full ? zone * Math.max(ss(-F, 0, u), dE) : 0,
    core: core * (1 - dS),
  };
}

// ───── 腿 ─────
const H = piv("hip_r"), K = piv("knee_r"), A = piv("ankle_r");
const TOE: Pt = [A[0], A[1] + 130];
const LEG_R = 128, HIP_DISC = 56, KNEE_DISC = 54, ANKLE_DISC = 44;
const legLen = Math.hypot(A[0] - H[0], A[1] - H[1]);
const legDir: Pt = [(A[0] - H[0]) / legLen, (A[1] - H[1]) / legLen];
function leg(x: number, y: number) {
  const d = distLine(x, y, [H, K, A, TOE]);
  const side = MIRROR / 2 - x; // 右腿在中線左邊
  const below = y - (H[1] - 12);
  const zone = (1 - ss(LEG_R, LEG_R + F, d)) * ss(-F, 0, side) * ss(-F, 0, below);
  const core = (1 - ss(LEG_R - F, LEG_R, d)) * ss(0, F, side) * ss(0, F, below);
  const uK = (x - K[0]) * legDir[0] + (y - K[1]) * legDir[1], uA = y - A[1];
  const dH = disc(x, y, H, HIP_DISC), dK = disc(x, y, K, KNEE_DISC), dA = disc(x, y, A, ANKLE_DISC);
  const shinCore = ss(0, F, uK) * (1 - dK), footCore = ss(0, F, uA) * (1 - dA);
  return {
    thigh: Math.max(zone, dH * ss(-F, 0, side)) * (1 - shinCore),
    shin: zone * Math.max(ss(-F, 0, uK), dK) * (1 - footCore),
    foot: zone * Math.max(ss(-F, 0, uA), dA),
    core: core * (1 - dH),
  };
}

const CHEST_Y = piv("chest")[1], WAIST_Y = piv("torso")[1], BAND = 20;

export interface MaskGrid { x0: number; y0: number; w: number; h: number; step: number }
export interface SkinMask { bone: string; alpha: Uint8ClampedArray }
/**
 * 計算各骨骼區域的柔邊遮罩（一次過掃描）。grid＝要計算的範圍（靜止畫布座標，step＝每格的像素）。
 * kind＝衣物類型；full＝連前臂／小腿及腳掌一起跟隨；gaps＝由衣物輪廓找到的袖子空隙（可選）。
 * 回傳的次序＝繪畫次序（先畫的在下面）。
 */
export function skinMasks(kind: "upper" | "legs", full: boolean, grid: MaskGrid, gaps?: { r: SleeveGap | null; l: SleeveGap | null }): SkinMask[] {
  const n = grid.w * grid.h;
  const bones = kind === "upper" ? ["pelvis", "torso", "chest", "shoulder_r", "shoulder_l", ...(full ? ["elbow_r", "elbow_l"] : [])] : ["pelvis", "hip_r", "hip_l", "knee_r", "knee_l", "ankle_r", "ankle_l"];
  const out = bones.map((bone) => ({ bone, alpha: new Uint8ClampedArray(n) }));
  for (let j = 0; j < grid.h; j++) {
    const y = grid.y0 + (j + 0.5) * grid.step;
    for (let i = 0; i < grid.w; i++) {
      const x = grid.x0 + (i + 0.5) * grid.step, k = j * grid.w + i;
      if (kind === "upper") {
        const r = arm(x, y, full, gaps?.r), l = arm(MIRROR - x, y, full, gaps?.l);
        const body = (1 - r.core) * (1 - l.core);
        out[0].alpha[k] = 255 * ss(WAIST_Y - 2 * BAND, WAIST_Y, y) * body;
        out[1].alpha[k] = 255 * ss(CHEST_Y - 2 * BAND, CHEST_Y, y) * (1 - ss(WAIST_Y, WAIST_Y + 2 * BAND, y)) * body;
        out[2].alpha[k] = 255 * (1 - ss(CHEST_Y, CHEST_Y + 2 * BAND, y)) * body;
        out[3].alpha[k] = 255 * r.upper;
        out[4].alpha[k] = 255 * l.upper;
        if (full) { out[5].alpha[k] = 255 * r.lower; out[6].alpha[k] = 255 * l.lower; }
      } else {
        const r = leg(x, y), l = leg(MIRROR - x, y);
        out[0].alpha[k] = 255 * (1 - r.core) * (1 - l.core);
        out[1].alpha[k] = 255 * r.thigh; out[2].alpha[k] = 255 * l.thigh;
        out[3].alpha[k] = 255 * r.shin; out[4].alpha[k] = 255 * l.shin;
        out[5].alpha[k] = 255 * r.foot; out[6].alpha[k] = 255 * l.foot;
      }
    }
  }
  return out;
}

/**
 * 在衣物輪廓中尋找袖子與衣身之間的空隙。opaque(x, y)＝衣物在靜止畫布該點是否不透明。
 * side＝"r"（畫面左方）或 "l"；openEnded＝空隙以下全部屬於袖子。找不到足夠長的連續空隙則回傳 null（改用按手臂位置的預設分區）。
 */
export function findSleeveGap(opaque: (x: number, y: number) => boolean, side: "r" | "l", openEnded = false): SleeveGap | null {
  const X = (x: number) => (side === "r" ? x : MIRROR - x);
  const STEP = 6, rows: { y: number; x: number }[] = [];
  for (let y = S[1] + 12; y <= W[1] + 160; y += STEP) {
    // 由身體中線向外掃：先經過衣身，再遇到空隙，空隙外面還有布料（袖子）
    let x = MIRROR / 2, seen = false, gapStart = -1, found = -1, first = -1;
    for (; x >= 40; x -= 4) {
      const o = opaque(X(x), y);
      if (!seen) { if (o) { seen = true; first = x; } continue; }
      if (gapStart < 0) { if (!o && x < S[0] + 70) gapStart = x; continue; }
      if (o) { if (gapStart - x >= 8) { found = (gapStart + x) / 2; break; } gapStart = -1; }
    }
    const last = rows[rows.length - 1];
    if (found > 0) {
      // 空隙外面的布料要有一定闊度才算袖子
      let wide = 0;
      for (let xx = found - 8; xx >= 20; xx -= 4) if (opaque(X(xx), y)) wide += 4;
      if (wide >= 16) rows.push({ y, x: found });
    } else if (last && y - last.y <= STEP && first > 0 && first < last.x - 2) {
      // 衣身已經到底、只剩袖子（袖口比衣襬長）：沿用上一行的分界
      rows.push({ y, x: last.x });
    }
  }
  // 取最長的一段連續空隙
  let best: typeof rows = [], cur: typeof rows = [];
  for (const r of rows) {
    if (cur.length && (r.y - cur[cur.length - 1].y > STEP * 3 || Math.abs(r.x - cur[cur.length - 1].x) > 40)) { if (cur.length > best.length) best = cur; cur = []; }
    cur.push(r);
  }
  if (cur.length > best.length) best = cur;
  if (best.length < 7) return null;
  // 上衣／外套：空隙以下全部當作袖子（袖口比衣襬長）；連身裙則到空隙結束為止，避免把裙身算進袖子
  const top = best[0].y, lastY = best[best.length - 1].y, bottom = openEnded ? Infinity : lastY;
  return {
    top, bottom,
    at: (y: number) => {
      if (y <= top) return best[0].x;
      if (y >= lastY) return best[best.length - 1].x;
      const i = Math.min(best.length - 2, Math.max(0, best.findIndex((r) => r.y > y) - 1));
      const a = best[i], b = best[i + 1];
      return a.x + ((y - a.y) / Math.max(1, b.y - a.y)) * (b.x - a.x);
    },
  };
}

/** 沿手臂取樣的位置（靜止姿勢）：用來判斷衣物有沒有袖子、袖子有多長 */
export function armSamples(): { upper: Pt[]; lower: Pt[]; outside: Pt[] } {
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const both = (pts: Pt[]) => [...pts, ...pts.map((p): Pt => [MIRROR - p[0], p[1]])];
  const lower = [0.3, 0.5, 0.7, 0.88].map((t) => lerp(E, W, t));
  return { upper: both([0.35, 0.55, 0.75].map((t) => lerp(S, E, t))), lower: both(lower), outside: both(lower.map((p): Pt => [p[0] - 95, p[1]])) };
}
export function legSamples(): Pt[] {
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const pts = [lerp(H, K, 0.5), lerp(K, A, 0.3), lerp(K, A, 0.7), lerp(A, TOE, 0.5)];
  return [...pts, ...pts.map((p): Pt => [MIRROR - p[0], p[1]])];
}
