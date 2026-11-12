// 2D 骨架引擎（純 TypeScript，前端及 Worker 共用，可直接單元測試）。
// 部件是在靜止姿勢下切出來的，所以每個骨骼只需要「繞自己的關節旋轉」；
// 子骨骼先繞自己的關節轉，再跟隨父骨骼（Forward Kinematics）。
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
/** 姿勢：骨骼 id → 相對靜止姿勢的角度（度）。沒有列出的骨骼＝0 */
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
/** 矩陣的旋轉角度（度） */
export const matAngle = (m: Mat) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
export const isIdentity = (m: Mat) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);
/** CSS transform；scale＝螢幕像素 ÷ 邏輯像素（只影響位移） */
export const matToCss = (m: Mat, scale = 1) => `matrix(${m[0].toFixed(6)},${m[1].toFixed(6)},${m[2].toFixed(6)},${m[3].toFixed(6)},${(m[4] * scale).toFixed(3)},${(m[5] * scale).toFixed(3)})`;

const index = new WeakMap<Rig, Map<string, Bone>>();
export function boneMap(rig: Rig): Map<string, Bone> {
  let m = index.get(rig);
  if (!m) {
    m = new Map(rig.bones.map((b) => [b.id, b]));
    index.set(rig, m);
  }
  return m;
}

export const clampAngle = (bone: Bone, deg: number) => Math.min(bone.max_angle, Math.max(bone.min_angle, Number.isFinite(deg) ? deg : 0));

/** 只保留有效骨骼、限制在可動範圍內、去掉 0；輸出可直接儲存 */
export function clampPose(rig: Rig, pose: Pose | null | undefined): Pose {
  const out: Pose = {};
  if (!pose) return out;
  for (const b of rig.bones) {
    const v = pose[b.id];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const c = Math.round(clampAngle(b, v) * 10) / 10;
    if (c !== 0) out[b.id] = c;
  }
  return out;
}

/** 驗證外來資料（API）：不是物件、含未知骨骼或非數字 → null */
export function normalizePose(rig: Rig, v: unknown): Pose | null {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const bones = boneMap(rig);
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!bones.has(k) || typeof val !== "number" || !Number.isFinite(val)) return null;
  }
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
    const m = b.parent ? multiply(visit(b.parent, guard + 1), local) : local;
    out[id] = m;
    return m;
  };
  for (const b of rig.bones) visit(b.id);
  return out;
}

/** 關節在目前姿勢下的位置 */
export function jointPositions(rig: Rig, pose: Pose | null | undefined): Record<string, [number, number]> {
  const mats = solve(rig, pose);
  const bones = boneMap(rig);
  const out: Record<string, [number, number]> = {};
  for (const b of rig.bones) {
    // 關節本身只跟隨父骨骼（自己繞自己轉不會移動）
    const m = b.parent && bones.has(b.parent) ? mats[b.parent] : IDENTITY;
    out[b.id] = applyMat(m, b.pivot[0], b.pivot[1]);
  }
  return out;
}

/** 錨點（衣物對位用）在目前姿勢下的位置 */
export function posedAnchors(rig: Rig, pose: Pose | null | undefined): Record<string, { x: number; y: number }> {
  const mats = solve(rig, pose);
  const out: Record<string, { x: number; y: number }> = {};
  for (const [name, [x, y]] of Object.entries(rig.anchors)) {
    const [px, py] = applyMat(mats[rig.anchor_bone[name]] ?? IDENTITY, x, y);
    out[name] = { x: Math.round(px * 10) / 10, y: Math.round(py * 10) / 10 };
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
  return rig.bones.every((bn) => Math.abs((x[bn.id] ?? 0) - (y[bn.id] ?? 0)) < 0.05);
};

/**
 * 拖動末端（手掌／腳掌）時的兩節 IK：調整 upper（肩／髖）及 mid（肘／膝），令 end 關節盡量貼近目標。
 * 用限制範圍內的座標下降法，不會超出關節可動範圍；回傳新的姿勢。
 */
export function reachIK(rig: Rig, pose: Pose, upper: string, mid: string, end: string, target: [number, number], iterations = 24): Pose {
  const bones = boneMap(rig);
  const next: Pose = { ...pose };
  const dist = () => {
    const p = jointPositions(rig, next)[end];
    return Math.hypot(p[0] - target[0], p[1] - target[1]);
  };
  let step = 6;
  for (let i = 0; i < iterations; i++) {
    let improved = false;
    for (const id of [upper, mid]) {
      const b = bones.get(id);
      if (!b) continue;
      const cur = next[id] ?? 0;
      const base = dist();
      let best = cur, bestD = base;
      for (const cand of [cur - step, cur + step]) {
        next[id] = clampAngle(b, cand);
        const d = dist();
        if (d < bestD - 1e-6) { best = next[id]; bestD = d; }
      }
      next[id] = best;
      if (bestD < base - 1e-6) improved = true;
    }
    if (!improved) step /= 2;
    if (step < 0.05) break;
  }
  return clampPose(rig, next);
}
