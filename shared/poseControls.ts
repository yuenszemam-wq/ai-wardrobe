// 姿勢控制點（Phase 3.2）：把「選哪一節骨骼」與「怎樣拖動」分開，名稱與實際控制的骨骼一致。
// 三種拖動方式：
//   ik     拖手腳：拖動手掌／腳掌，自動調整上、中兩節（肩＋肘、髖＋膝）
//   rotate 轉動關節：每一節骨骼各有一個控制點，放在該節骨骼的末端；拖動＝這一節繞自己的關節轉動
//   move   移動位置：可以平移的節點（重心、骨盆、肩膊…），拖動＝移動該關節的位置
// 純函數，前端及測試共用。
import { Rig, boneMap } from "./avatarRig";
import { HairConfig, hairBoneId } from "./avatarV2";

export type Region = "head" | "body" | "arm_r" | "arm_l" | "leg_r" | "leg_l" | "hair";
export type DragMode = "ik" | "rotate" | "move";
export type ControlKind = "ik" | "aim" | "move";
export interface PoseControl {
  id: string;
  kind: ControlKind;
  /** 實際被改動的骨骼（ik＝末端關節，另外改動 upper、mid） */
  bone: string;
  /** 靜止姿勢下控制點的位置，以及它跟隨的骨骼 */
  at: [number, number];
  follow: string;
  upper?: string;
  mid?: string;
  region: Region;
  /** 這個控制點的名稱及作用（顯示給使用者） */
  label: string;
  hint: string;
  /** 面板上顯示哪幾節骨骼的滑桿 */
  sliders: string[];
}
export const REGIONS: { id: Region; label: string; bones: string[] }[] = [
  { id: "head", label: "頭部", bones: ["neck", "head"] },
  { id: "body", label: "身體", bones: ["root", "pelvis", "torso", "chest"] },
  { id: "arm_r", label: "右手", bones: ["shoulder_r", "elbow_r", "wrist_r"] },
  { id: "arm_l", label: "左手", bones: ["shoulder_l", "elbow_l", "wrist_l"] },
  { id: "leg_r", label: "右腿", bones: ["hip_r", "knee_r", "ankle_r"] },
  { id: "leg_l", label: "左腿", bones: ["hip_l", "knee_l", "ankle_l"] },
  { id: "hair", label: "頭髮", bones: [] },
];
export const DRAG_MODES: { id: DragMode; label: string; hint: string }[] = [
  { id: "ik", label: "拖手腳", hint: "拖動手掌或腳掌，肩膊及手肘（或大腿及膝）會自動配合。" },
  { id: "rotate", label: "轉動關節", hint: "每一節各自轉動：拖動圓點＝這一節繞自己的關節轉。" },
  { id: "move", label: "移動位置", hint: "移動關節本身的位置（重心、骨盆、肩膊等）。" },
];
const isHair = (id: string) => id.startsWith("hair_") || id.startsWith("hp_");
const SIDE = (s: string) => (s === "r" ? "右" : "左");
/** 每一節骨骼「轉動時實際改變甚麼」：肩膊＝上臂方向、手肘＝前臂、手腕＝手掌 … */
export const JOINT_LABEL: Record<string, string> = {
  root: "整體重心", pelvis: "骨盆", torso: "腰", chest: "上胸", neck: "頸", head: "頭",
  shoulder_r: "右肩膊", elbow_r: "右手肘", wrist_r: "右手腕", shoulder_l: "左肩膊", elbow_l: "左手肘", wrist_l: "左手腕",
  hip_r: "右髖", knee_r: "右膝", ankle_r: "右腳踝", hip_l: "左髖", knee_l: "左膝", ankle_l: "左腳踝",
  hair_tail_r: "右馬尾", hair_tail_l: "左馬尾", hair_side_r: "右側髮", hair_side_l: "左側髮",
};
export const JOINT_EFFECT: Record<string, string> = {
  root: "整個角色傾側", pelvis: "骨盆傾側", torso: "腰部彎向一邊", chest: "上身傾側", neck: "頸部傾側", head: "頭部傾側",
  shoulder_r: "上臂方向", shoulder_l: "上臂方向", elbow_r: "前臂彎曲", elbow_l: "前臂彎曲", wrist_r: "手掌角度", wrist_l: "手掌角度",
  hip_r: "大腿方向", hip_l: "大腿方向", knee_r: "小腿彎曲", knee_l: "小腿彎曲", ankle_r: "腳掌角度", ankle_l: "腳掌角度",
};
export const jointLabel = (id: string) => JOINT_LABEL[id] ?? (id.startsWith("hp_") ? "髮束 " + id.slice(3) : id);
/** 滑桿旁的完整說明，例如「左肩膊（上臂方向）」 */
export const jointTitle = (id: string) => (JOINT_EFFECT[id] ? `${jointLabel(id)}（${JOINT_EFFECT[id]}）` : jointLabel(id));
export function regionOf(bone: string): Region {
  if (isHair(bone)) return "hair";
  return REGIONS.find((r) => r.bones.includes(bone))?.id ?? "body";
}
/** 某個身體區域包含的骨骼（頭髮按目前髮型的骨架決定） */
export function regionBones(rig: Rig, region: Region): string[] {
  if (region === "hair") return rig.bones.filter((b) => isHair(b.id)).map((b) => b.id);
  return REGIONS.find((r) => r.id === region)!.bones.filter((b) => boneMap(rig).has(b));
}
/** 可以用滑桿調整的關節（有可動範圍） */
export const adjustable = (rig: Rig, id: string) => { const b = boneMap(rig).get(id); return !!b && (b.min_angle !== b.max_angle || !!b.max_offset); };

/** 一節骨骼的末端（靜止姿勢）：轉動控制點放在這裡 */
function tipOf(rig: Rig, bone: string): [number, number] {
  const P = (id: string) => boneMap(rig).get(id)!.pivot;
  const A = rig.anchors;
  switch (bone) {
    case "root": return P("torso");
    case "pelvis": return [P("pelvis")[0], P("pelvis")[1] + 70];
    case "torso": return P("chest");
    case "chest": return P("neck");
    case "neck": return P("head");
    case "head": return A.head_top;
  }
  const s = bone.slice(-1), sign = s === "r" ? -1 : 1;
  if (bone.startsWith("shoulder_")) return P("elbow_" + s);
  if (bone.startsWith("elbow_")) return P("wrist_" + s);
  if (bone.startsWith("wrist_")) return [A["hand_" + s][0] + sign * 18, A["hand_" + s][1] + 30];
  if (bone.startsWith("hip_")) return P("knee_" + s);
  if (bone.startsWith("knee_")) return P("ankle_" + s);
  if (bone.startsWith("ankle_")) return [P("ankle_" + s)[0], P("ankle_" + s)[1] + 118];
  return P(bone);
}

/** 全部控制點（三種拖動方式都在內）；用 controlsFor 按拖動方式及顯示範圍篩選 */
export function poseControls(rig: Rig, hair: HairConfig | null): PoseControl[] {
  const out: PoseControl[] = [];
  const bones = boneMap(rig);
  const P = (id: string) => bones.get(id)!.pivot;
  // 轉動：每一節可以轉動的身體骨骼
  for (const b of rig.bones) {
    if (isHair(b.id) || b.min_angle === b.max_angle) continue;
    out.push({ id: "rot_" + b.id, kind: "aim", bone: b.id, at: tipOf(rig, b.id), follow: b.id, region: regionOf(b.id), label: jointTitle(b.id), hint: `拖動＝${jointLabel(b.id)}轉動，改變${JOINT_EFFECT[b.id] ?? "這一節的方向"}。`, sliders: [b.id] });
  }
  // 移動：可以平移的節點
  for (const b of rig.bones) {
    if (isHair(b.id) || !b.max_offset) continue;
    out.push({ id: "mov_" + b.id, kind: "move", bone: b.id, at: b.id === "root" ? P("pelvis") : (b.pivot as [number, number]), follow: b.id, region: regionOf(b.id), label: jointLabel(b.id) + "位置", hint: `拖動＝移動${jointLabel(b.id)}的位置（不改變角度）。`, sliders: [b.id] });
  }
  // 拖手腳（IK）
  for (const s of ["r", "l"] as const) {
    if (bones.has("wrist_" + s)) out.push({ id: "wrist_" + s, kind: "ik", bone: "wrist_" + s, at: P("wrist_" + s), follow: "elbow_" + s, upper: "shoulder_" + s, mid: "elbow_" + s, region: ("arm_" + s) as Region, label: `拖動${SIDE(s)}手`, hint: `拖動${SIDE(s)}手：自動同時調整${SIDE(s)}肩膊（上臂方向）及${SIDE(s)}手肘（前臂彎曲）。`, sliders: ["shoulder_" + s, "elbow_" + s] });
    if (bones.has("ankle_" + s)) out.push({ id: "ankle_" + s, kind: "ik", bone: "ankle_" + s, at: P("ankle_" + s), follow: "knee_" + s, upper: "hip_" + s, mid: "knee_" + s, region: ("leg_" + s) as Region, label: `拖動${SIDE(s)}腳`, hint: `拖動${SIDE(s)}腳：自動同時調整${SIDE(s)}髖（大腿方向）及${SIDE(s)}膝（小腿彎曲）。`, sliders: ["hip_" + s, "knee_" + s] });
  }
  // 髮束（只有轉動）
  const seen = new Set<string>();
  for (const p of hair?.parts ?? []) {
    const bone = hairBoneId(p);
    if (bone === "head" || seen.has(bone) || !bones.has(bone)) continue;
    seen.add(bone);
    out.push({ id: bone, kind: "aim", bone, at: [p.x + p.w / 2, p.y + p.h - 12], follow: bone, region: "hair", label: jointLabel(bone), hint: `拖動＝擺動${jointLabel(bone)}。`, sliders: [bone] });
  }
  return out;
}
/** 「拖手腳」方式下，身軀及頭部沒有 IK，仍然用轉動控制點（腰、上胸、頭）加上重心移動 */
const IK_EXTRA = new Set(["rot_torso", "rot_chest", "rot_head", "mov_root"]);
export function controlsFor(all: PoseControl[], drag: DragMode, region: Region | "all"): PoseControl[] {
  return all.filter((c) => {
    if (region !== "all" && c.region !== region) return false;
    if (c.region === "hair") return true;
    if (drag === "ik") return c.kind === "ik" || IK_EXTRA.has(c.id);
    return drag === "rotate" ? c.kind === "aim" : c.kind === "move";
  });
}
