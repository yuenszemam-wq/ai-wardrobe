// 2D 骨架引擎（純 TypeScript，前端及 Worker 共用，可直接單元測試）。
// 部件是在靜止姿勢下切出來的，所以每個骨骼只需要「繞自己的關節旋轉」（另可小幅平移）；
// 子骨骼先做自己的變換，再跟隨父骨骼（Forward Kinematics）。
// 座標＝邏輯畫布像素；角度＝度，正數在畫面上是順時針（y 軸向下）。

export interface Bone {
  id: string;
  parent: string | null;
  /** 靜止姿勢下關節在畫布上的位置 */
  rest_position: [number, number];
  rest_angle: number;
  /** 旋轉中心（畫布座標，靜止姿勢） */
  pivot: [number, number];
  min_angle: number;
  max_angle: number;
  /** 可平移的範圍（±x, ±y）；沒有＝不可平移 */
  max_offset?: [number, number];
  attached_assets: string[];
}
export interface RigPart {
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bone: string;
  group: "body" | "hair";
  accent_mask?: string;
  synthesized?: string;
  /** 自訂模型：以圖片中心旋轉（度）及隱藏 */
  rot?: number;
  hidden?: boolean;
}
export interface Rig {
  version: number;
  avatar_id: string;
  canvas: { w: number; h: number };
  bones: Bone[];
  parts: Record<string, RigPart>;
  draw_order: string[];
  body_parts: string[];
  hair_back: string[];
  hair_front: string[];
  anchors: Record<string, [number, number]>;
  anchor_bone: Record<string, string>;
}
/**
 * 姿勢：骨骼 id → 相對靜止姿勢的角度（度）；「骨骼 id.x／.y」→ 平移（邏輯像素）。沒有列出＝0。
 */
export type Pose = Record<string, number>;
/** 仿射矩陣，與 CSS matrix(a,b,c,d,e,f) 相同：x' = a·x + c·y + e，y' = b·x + d·y + f */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const multiply = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
/** 繞 (px,py) 旋轉 deg 度 */
export function rotateAbout(deg: number, px: number, py: number): Mat {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return [c, s, -s, c, px - c * px + s * py, py - s * px - c * py];
}
export const applyMat = (m: Mat, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-9;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
/** 矩陣的旋轉角度（度） */
export const matAngle = (m: Mat) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
export const isIdentity = (m: Mat) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);

const index = new WeakMap<Rig, Map<string, Bone>>();
export function boneMap(rig: Rig): Map<string, Bone> {
  let m = index.get(rig);
  if (!m) {
    m = new Map(rig.bones.map((b) => [b.id, b]));
    index.set(rig, m);
  }
  return m;
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r1 = (v: number) => Math.round(v * 10) / 10;
export const clampAngle = (bone: Bone, deg: number) => Math.min(bone.max_angle, Math.max(bone.min_angle, Number.isFinite(deg) ? deg : 0));
export function clampOffset(bone: Bone, axis: 0 | 1, v: number) {
  const m = bone.max_offset?.[axis] ?? 0;
  return Math.min(m, Math.max(-m, Number.isFinite(v) ? v : 0));
}
const offsetOf = (b: Bone, pose: Pose | null | undefined): [number, number] => (b.max_offset && pose ? [clampOffset(b, 0, pose[b.id + ".x"] ?? 0), clampOffset(b, 1, pose[b.id + ".y"] ?? 0)] : [0, 0]);

/** 只保留有效骨骼、限制在可動範圍內、去掉 0；輸出可直接儲存 */
export function clampPose(rig: Rig, pose: Pose | null | undefined): Pose {
  const out: Pose = {};
  if (!pose) return out;
  for (const b of rig.bones) {
    const v = pose[b.id];
    if (fin(v)) {
      const c = r1(clampAngle(b, v));
      if (c !== 0) out[b.id] = c;
    }
    if (b.max_offset) {
      for (const [axis, key] of [[0, b.id + ".x"], [1, b.id + ".y"]] as const) {
        const o = pose[key];
        if (!fin(o)) continue;
        const c = r1(clampOffset(b, axis, o));
        if (c !== 0) out[key] = c;
      }
    }
  }
  return out;
}

/**
 * 驗證外來資料（API）：不是物件或含非數字 → null。
 * 不認識的骨骼（例如另一款髮型的髮束）會被略過，不會令整個姿勢失效。
 */
export function normalizePose(rig: Rig, v: unknown): Pose | null {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 200) return null;
  for (const [, val] of entries) if (!fin(val)) return null;
  return clampPose(rig, v as Pose);
}

/** Forward Kinematics：每個骨骼在目前姿勢下的矩陣（把靜止姿勢的畫布座標變到目前位置） */
export function solve(rig: Rig, pose: Pose | null | undefined): Record<string, Mat> {
  const bones = boneMap(rig);
  const out: Record<string, Mat> = {};
  const visit = (id: string, guard = 0): Mat => {
    if (out[id]) return out[id];
    const b = bones.get(id);
    if (!b || guard > 64) return IDENTITY;
    const local = rotateAbout(clampAngle(b, pose?.[id] ?? 0) + b.rest_angle, b.pivot[0], b.pivot[1]);
    const [ox, oy] = offsetOf(b, pose);
    local[4] += ox;
    local[5] += oy;
    const m = b.parent ? multiply(visit(b.parent, guard + 1), local) : local;
    out[id] = m;
    return m;
  };
  for (const b of rig.bones) visit(b.id);
  return out;
}

/** 關節在目前姿勢下的位置 */
export function jointPositions(rig: Rig, pose: Pose | null | undefined, mats = solve(rig, pose)): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  // 關節本身跟隨自己的矩陣（繞自己轉不會移動；平移則會帶動）
  for (const b of rig.bones) out[b.id] = applyMat(mats[b.id], b.pivot[0], b.pivot[1]);
  return out;
}

/** 錨點（衣物對位用）在目前姿勢下的位置 */
export function posedAnchors(rig: Rig, pose: Pose | null | undefined): Record<string, { x: number; y: number }> {
  const mats = solve(rig, pose);
  const out: Record<string, { x: number; y: number }> = {};
  for (const [name, [x, y]] of Object.entries(rig.anchors)) {
    const [px, py] = applyMat(mats[rig.anchor_bone[name]] ?? IDENTITY, x, y);
    out[name] = { x: r1(px), y: r1(py) };
  }
  return out;
}

export function descendants(rig: Rig, id: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => rig.bones.filter((b) => b.parent === p).forEach((b) => { out.push(b.id); walk(b.id); });
  walk(id);
  return out;
}

export const samePose = (rig: Rig, a: Pose | null | undefined, b: Pose | null | undefined) => {
  const x = clampPose(rig, a), y = clampPose(rig, b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if (Math.abs((x[k] ?? 0) - (y[k] ?? 0)) >= 0.05) return false;
  return true;
};

/**
 * 兩節（肩→肘→腕、髖→膝→踝）彎曲的方向：+1／−1（上臂→前臂的轉向）；彎曲少於約 17° 時回傳 0（當作伸直）。
 */
export function ikSide(rig: Rig, pose: Pose, upper: string, mid: string, end: string): number {
  const j = jointPositions(rig, pose);
  const s = j[upper], m = j[mid], e = j[end];
  if (!s || !m || !e) return 0;
  const ux = m[0] - s[0], uy = m[1] - s[1], fx = e[0] - m[0], fy = e[1] - m[1];
  const sin = (ux * fy - uy * fx) / ((Math.hypot(ux, uy) * Math.hypot(fx, fy)) || 1);
  return Math.abs(sin) < 0.3 ? 0 : Math.sign(sin);
}
const bendOf = (s: [number, number], m: [number, number], e: [number, number]) => Math.sign((m[0] - s[0]) * (e[1] - m[1]) - (m[1] - s[1]) * (e[0] - m[0])) || 1;
/** 自然的彎曲方向：手肘／膝蓋向身體外側（畫面左邊的手腳向左、右邊的向右；手肘另外略向下） */
function naturalSide(rig: Rig, s: [number, number], target: [number, number], l1: number, l2: number, upper: string): number {
  const d = Math.min(l1 + l2 - 0.5, Math.max(Math.abs(l1 - l2) + 0.5, Math.hypot(target[0] - s[0], target[1] - s[1])));
  const base = Math.atan2(target[1] - s[1], target[0] - s[0]);
  const alpha = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
  const out: [number, number] = [s[0] < rig.canvas.w / 2 ? -1 : 1, upper.startsWith("shoulder") ? 0.45 : 0];
  let best = 1, bestDot = -Infinity;
  for (const sign of [1, -1]) {
    const a1 = base + sign * alpha;
    const m: [number, number] = [s[0] + Math.cos(a1) * l1, s[1] + Math.sin(a1) * l1];
    const dot = (m[0] - (s[0] + target[0]) / 2) * out[0] + (m[1] - (s[1] + target[1]) / 2) * out[1];
    if (dot > bestDot) { bestDot = dot; best = bendOf(s, m, target); }
  }
  return best;
}
/**
 * 拖動末端（手掌／腳掌）時的兩節 IK：調整 upper（肩／髖）及 mid（肘／膝），令 end 關節盡量貼近目標。
 * side＝彎曲方向（+1／−1，見 ikSide）。拖動期間固定同一個方向，手臂就不會在兩個解之間突然翻轉；
 * 沒有指定時沿用目前的方向，手臂伸直時選擇自然方向（手肘、膝蓋向外）。
 * 先用解析解，再在可動範圍內微調；不會超出關節可動範圍。回傳新的姿勢。
 */
export function reachIK(rig: Rig, pose: Pose, upper: string, mid: string, end: string, target: [number, number], iterations = 28, side?: number): Pose {
  const bones = boneMap(rig);
  const U = bones.get(upper), M = bones.get(mid), N = bones.get(end);
  const dist = (p: Pose) => {
    const j = jointPositions(rig, p)[end];
    return Math.hypot(j[0] - target[0], j[1] - target[1]);
  };
  const angDist = (p: Pose) => Math.abs((p[upper] ?? 0) - (pose[upper] ?? 0)) + Math.abs((p[mid] ?? 0) - (pose[mid] ?? 0));
  let next: Pose = { ...pose };
  let exact = false;
  let want = side || ikSide(rig, pose, upper, mid, end) || 1;
  if (U && M && N) {
    const mats = solve(rig, pose);
    const parent = U.parent ? mats[U.parent] ?? IDENTITY : IDENTITY;
    const [sx, sy] = applyMat(mats[upper], U.pivot[0], U.pivot[1]);
    const l1 = Math.hypot(M.pivot[0] - U.pivot[0], M.pivot[1] - U.pivot[1]), l2 = Math.hypot(N.pivot[0] - M.pivot[0], N.pivot[1] - M.pivot[1]);
    const d = Math.min(l1 + l2 - 0.5, Math.max(Math.abs(l1 - l2) + 0.5, Math.hypot(target[0] - sx, target[1] - sy)));
    const base = Math.atan2(target[1] - sy, target[0] - sx);
    const alpha = Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d))));
    const rest1 = Math.atan2(M.pivot[1] - U.pivot[1], M.pivot[0] - U.pivot[0]), rest2 = Math.atan2(N.pivot[1] - M.pivot[1], N.pivot[0] - M.pivot[0]);
    const pa = (matAngle(parent) * Math.PI) / 180;
    const norm = (deg: number) => { while (deg > 180) deg -= 360; while (deg < -180) deg += 360; return deg; };
    // 解析解：兩個彎曲方向各一個，只考慮在可動範圍之內的解。
    // 手臂差不多伸直時選擇自然方向（手肘、膝蓋向外）；已經彎曲時保持同一方向，
    // 只有另一方向的解非常接近目前姿勢時才轉換——所以彎曲方向只會在手臂伸直附近改變，不會突然翻轉。
    const nat = naturalSide(rig, [sx, sy], target, l1, l2, upper);
    const cur = side || ikSide(rig, pose, upper, mid, end);
    const cands: { p: Pose; bend: number; ang: number }[] = [];
    for (const sign of [1, -1]) {
      const a1 = base + sign * alpha;
      const ex = sx + Math.cos(a1) * l1, ey = sy + Math.sin(a1) * l1;
      const a2 = Math.atan2(target[1] - ey, target[0] - ex);
      const up = norm(((a1 - pa - rest1) * 180) / Math.PI - U.rest_angle);
      const md = norm(((a2 - pa - rest2) * 180) / Math.PI - up - U.rest_angle - M.rest_angle);
      if (up < U.min_angle || up > U.max_angle || md < M.min_angle || md > M.max_angle) continue;
      const cand: Pose = { ...pose, [upper]: up, [mid]: md };
      cands.push({ p: cand, bend: bendOf([sx, sy], [ex, ey], target), ang: angDist(cand) });
    }
    const pickBend = (b: number) => cands.filter((c) => c.bend === b).sort((x, y) => x.ang - y.ang)[0];
    let chosen = cur === 0 ? pickBend(nat) ?? cands.sort((x, y) => x.ang - y.ang)[0] : pickBend(cur);
    if (cur !== 0 && !side) { const o = pickBend(-cur); if (o && o.ang <= 35 && (!chosen || o.bend === nat)) chosen = o; }
    if (chosen && (chosen.ang <= 150 || dist(pose) > 200)) { next = chosen.p; exact = true; want = chosen.bend; }
    else want = cur || nat;
  }
  if (!exact) {
    // 到不了（超出關節範圍）：由目前姿勢出發，在可動範圍內逐步靠近手指位置；不會跳到另一個解
    let step = 8;
    for (let i = 0; i < iterations * 2; i++) {
      let improved = false;
      for (const id of [upper, mid]) {
        const b = bones.get(id);
        if (!b) continue;
        const cur = next[id] ?? 0;
        const base = dist(next);
        let best = cur, bestD = base;
        for (const cand of [cur - step, cur + step]) {
          next[id] = clampAngle(b, cand);
          const s2 = ikSide(rig, next, upper, mid, end);
          const d = s2 !== 0 && s2 !== want ? Infinity : dist(next);
          if (d < bestD - 1e-6) { best = next[id]; bestD = d; }
        }
        next[id] = best;
        if (bestD < base - 1e-6) improved = true;
      }
      if (!improved) step /= 2;
      if (step < 0.05) break;
    }
  }
  return clampPose(rig, next);
}

/**
 * 直接拖動一節骨骼的末端：把骨骼轉到「靜止時的 tip 指向 target」的角度（FK 瞄準）。
 * tip＝靜止姿勢下這節骨骼末端的畫布座標（通常是子關節的位置）。
 */
export function aimBone(rig: Rig, pose: Pose, id: string, tip: [number, number], target: [number, number]): Pose {
  const b = boneMap(rig).get(id);
  if (!b) return pose;
  const mats = solve(rig, pose);
  const parent = b.parent ? mats[b.parent] ?? IDENTITY : IDENTITY;
  const [ox, oy] = offsetOf(b, pose);
  const [tx, ty] = applyMat(invert(parent), target[0], target[1]);
  const want = Math.atan2(ty - (b.pivot[1] + oy), tx - (b.pivot[0] + ox));
  const rest = Math.atan2(tip[1] - b.pivot[1], tip[0] - b.pivot[0]);
  let deg = ((want - rest) * 180) / Math.PI - b.rest_angle;
  while (deg > 180) deg -= 360;
  while (deg < -180) deg += 360;
  return clampPose(rig, { ...pose, [id]: deg });
}

/** 拖動可平移的節點（整體重心、肩膊等）：把關節移到 target */
export function moveBone(rig: Rig, pose: Pose, id: string, target: [number, number]): Pose {
  const b = boneMap(rig).get(id);
  if (!b?.max_offset) return pose;
  const mats = solve(rig, pose);
  const parent = b.parent ? mats[b.parent] ?? IDENTITY : IDENTITY;
  const [tx, ty] = applyMat(invert(parent), target[0], target[1]);
  return clampPose(rig, { ...pose, [b.id + ".x"]: tx - b.pivot[0], [b.id + ".y"]: ty - b.pivot[1] });
}
