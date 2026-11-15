/**
 * Phase 3.9A.3：角色換裝的素材圖層（道具、裝飾、配件等工作室素材）及骨骼附接。
 *
 * - 素材只引用工作室素材版本（studio_asset_versions），不會成為衣物，亦不影響衣櫃統計。
 * - 附接：world＝固定在畫面（不跟角色移動）；其他＝跟隨該骨骼（頭、手、前臂、胸口……）。
 *   位置以「骨骼靜止座標」保存（cx、cy＝方框中心，w、h＝大小，邏輯畫布 1200×1800），換姿勢時跟著骨骼移動及旋轉。
 * - 前後：back＝角色身後；middle＝衣服之上、頭髮前層及頭部之下；front＝最前。同一層內按陣列次序（後→前）。
 * - 遮罩與衣服配搭相同（相對圖片座標的筆畫），不修改素材原圖。
 */
import { LayerMask, normalizeMask } from "./studioScene";

export const PROP_BONES: [string, string][] = [
  ["world", "固定畫面"], ["root", "跟隨全身"], ["head", "頭部"], ["neck", "頸"], ["chest", "胸口"], ["torso", "腰"], ["pelvis", "盆骨"],
  ["wrist_r", "右手"], ["wrist_l", "左手"], ["elbow_r", "右前臂"], ["elbow_l", "左前臂"], ["ankle_r", "右腳"], ["ankle_l", "左腳"],
];
export type PropZ = "back" | "middle" | "front";
export const PROP_Z: [PropZ, string][] = [["back", "角色後面"], ["middle", "衣服之上"], ["front", "最前"]];
export const MAX_PROPS = 30;

export interface PropLayer {
  layer_id: string;
  asset_id: string;
  version_id: string;
  variant: "original" | "cutout";
  name: string;
  bone: string;
  z: PropZ;
  /** 骨骼靜止座標的方框中心及大小（邏輯畫布像素） */
  cx: number; cy: number; w: number; h: number;
  rotation: number;
  flip_x: boolean; flip_y: boolean;
  opacity: number;
  hidden: boolean;
  mask: LayerMask | null;
}

const ID = /^[\w:.-]{1,80}$/;
const num = (v: unknown, d: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const r1 = (n: number) => Math.round(n * 10) / 10;

export function normalizeProp(v: unknown): PropLayer | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = (k: string) => (typeof o[k] === "string" && ID.test(o[k] as string) ? (o[k] as string) : null);
  const layer_id = id("layer_id"), asset_id = id("asset_id"), version_id = id("version_id");
  if (!layer_id || !asset_id || !version_id) return null;
  return {
    layer_id, asset_id, version_id, variant: o.variant === "cutout" ? "cutout" : "original",
    name: typeof o.name === "string" ? o.name.slice(0, 60) : "",
    bone: PROP_BONES.some(([b]) => b === o.bone) ? (o.bone as string) : "world",
    z: o.z === "back" || o.z === "middle" ? o.z : "front",
    cx: r1(num(o.cx, 600, -2400, 3600)), cy: r1(num(o.cy, 900, -2400, 3600)), w: r1(num(o.w, 200, 4, 3600)), h: r1(num(o.h, 200, 4, 3600)),
    rotation: r1(((num(o.rotation, 0, -3600, 3600) % 360) + 540) % 360 - 180),
    flip_x: !!o.flip_x, flip_y: !!o.flip_y, opacity: Math.round(num(o.opacity, 1, 0, 1) * 100) / 100, hidden: !!o.hidden, mask: normalizeMask(o.mask),
  };
}
export function normalizeProps(v: unknown): PropLayer[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>(), out: PropLayer[] = [];
  for (const raw of v.slice(0, MAX_PROPS)) { const p = normalizeProp(raw); if (p && !seen.has(p.layer_id)) { seen.add(p.layer_id); out.push(p); } }
  return out;
}
/** 圖片網址（工作室素材版本） */
export const propSrc = (p: Pick<PropLayer, "version_id" | "variant">) => `/api/studio/versions/${p.version_id}${p.variant === "cutout" ? "?cutout=1" : ""}`;
