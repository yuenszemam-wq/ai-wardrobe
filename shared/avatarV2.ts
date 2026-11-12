// Avatar V2：由完整人物圖拆出來的可動角色（素材及 rig.json 由 scripts/build-avatar-v2.py 產生）。
import rigJson from "../public/doll/avatar_v2/rig.json";
import posesJson from "./avatar-v2-poses.json";
import { Pose, Rig, clampPose } from "./avatarRig";

export const AVATAR_V2_ID = "avatar_v2";
export const AVATAR_V2_BASE = "/doll/avatar_v2/";
export const RIG_V2 = rigJson as unknown as Rig & {
  hair: { style: string; ref_luma: { main: number; accent: number }; original: { main: number[]; accent: number[] } };
};

export interface PosePreset { id: string; label: string; pose: Pose }
export const POSE_PRESETS: PosePreset[] = (posesJson as PosePreset[]).map((p) => ({ ...p, pose: clampPose(RIG_V2, p.pose) }));
export const DEFAULT_POSE_ID = "a_pose";

// ───── 髮型 ─────
// 每款髮型＝一個資料夾內的六個部件；新增髮型只需要加素材及在這裡登記，不用改渲染器。
export const HAIR_SLOTS = ["hair_tail_r", "hair_tail_l", "hair_back_base", "hair_side_r", "hair_side_l", "hair_bangs"] as const;
export type HairSlot = (typeof HAIR_SLOTS)[number];
export interface HairStyle {
  id: string;
  label: string;
  /** 部件位置；沒有的部件＝這款髮型不用（例如短髮沒有馬尾） */
  parts: Partial<Record<HairSlot, { src: string; accent_mask?: string; x: number; y: number; w: number; h: number }>>;
  /** 原圖主髮色及挑染色的參考亮度（重新著色時用來保留明暗） */
  ref_luma: { main: number; accent: number };
}
const builtIn: HairStyle = {
  id: RIG_V2.hair.style,
  label: "長雙馬尾",
  parts: Object.fromEntries(HAIR_SLOTS.filter((s) => RIG_V2.parts[s]).map((s) => [s, RIG_V2.parts[s]])) as HairStyle["parts"],
  ref_luma: RIG_V2.hair.ref_luma,
};
export const HAIR_STYLES: Record<string, HairStyle> = { [builtIn.id]: builtIn };
export const DEFAULT_HAIR_STYLE = builtIn.id;

// ───── 髮色 ─────
export type Rgb = [number, number, number]; // 0–255
export interface HairColor {
  id: string;
  label: string;
  /** null＝保留原圖顏色 */
  main: Rgb | null;
  accent: Rgb | null;
}
const PINK: Rgb = [232, 120, 158];
export const HAIR_COLORS: HairColor[] = [
  { id: "brown_pink", label: "啡粉挑染", main: null, accent: null },
  { id: "dark_brown", label: "深啡色", main: null, accent: [100, 73, 79] },
  { id: "black", label: "黑色", main: [44, 40, 50], accent: [44, 40, 50] },
  { id: "black_pink", label: "黑粉挑染", main: [44, 40, 50], accent: PINK },
  { id: "silver", label: "銀灰色", main: [176, 180, 196], accent: [176, 180, 196] },
  { id: "purple", label: "紫色", main: [126, 84, 170], accent: [126, 84, 170] },
  { id: "pink", label: "粉色", main: [236, 150, 182], accent: [236, 150, 182] },
];
export const DEFAULT_HAIR_COLOR = "brown_pink";

const HEX = /^#[0-9a-f]{6}$/i;
export const rgbToHex = (c: Rgb) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
export function hexToRgb(hex: string): Rgb | null {
  if (!HEX.test(hex)) return null;
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
/** 儲存用的顏色值：預設 id，或 #rrggbb；不合法回傳 null */
export function normalizeColorValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (HAIR_COLORS.some((c) => c.id === v)) return v;
  return HEX.test(v) ? v.toLowerCase() : null;
}
/** 由儲存值得出實際的主髮色及挑染色（accent 可獨立指定） */
export function resolveHairColors(hairColor: string | null | undefined, accentColor: string | null | undefined): { main: Rgb | null; accent: Rgb | null } {
  const preset = HAIR_COLORS.find((c) => c.id === hairColor);
  let main = preset ? preset.main : (hairColor && hexToRgb(hairColor)) || null;
  let accent = preset ? preset.accent : main;
  if (accentColor) {
    const a = HAIR_COLORS.find((c) => c.id === accentColor);
    if (accentColor === "original") accent = null;
    else if (a) accent = a.accent ?? a.main;
    else accent = hexToRgb(accentColor) ?? accent;
  }
  if (!preset && !hairColor) main = null;
  return { main, accent };
}

const LR = 0.2126, LG = 0.7152, LB = 0.0722;
/** 把一個像素按原本的亮度重新著色：暗部按比例變暗，高光向白色過渡，保留髮絲明暗 */
function tint(r: number, g: number, b: number, target: Rgb, refLuma: number): Rgb {
  const l = (LR * r + LG * g + LB * b) / 255;
  const ratio = l / Math.max(0.02, refLuma);
  if (ratio <= 1) return [target[0] * ratio, target[1] * ratio, target[2] * ratio];
  const t = Math.min(1, (ratio - 1) / Math.max(0.05, 1 / Math.max(0.02, refLuma) - 1));
  return [target[0] + (255 - target[0]) * t, target[1] + (255 - target[1]) * t, target[2] + (255 - target[2]) * t];
}

/**
 * 重新著色頭髮（就地修改 RGBA 像素；alpha 不變，所以輪廓及位置不變）。
 * mask：同尺寸 RGBA，R＝挑染比重（0＝主髮色，255＝挑染），G＝是否頭髮（瀏海投在皮膚上的陰影為 0，不著色）。
 * main／accent 為 null 時該部分保留原色。
 */
export function recolorHair(pixels: Uint8ClampedArray | Uint8Array, mask: Uint8ClampedArray | Uint8Array | null, main: Rgb | null, accent: Rgb | null, ref: { main: number; accent: number }): void {
  if (!main && !accent) return;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const wa = mask ? mask[i] / 255 : 0;
    const wh = mask ? mask[i + 1] / 255 : 1;
    if (wh <= 0) continue;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const m = main ? tint(r, g, b, main, ref.main) : [r, g, b];
    const a = wa > 0 ? (accent ? tint(r, g, b, accent, ref.accent) : [r, g, b]) : m;
    const nr = m[0] * (1 - wa) + a[0] * wa, ng = m[1] * (1 - wa) + a[1] * wa, nb = m[2] * (1 - wa) + a[2] * wa;
    pixels[i] = r + (nr - r) * wh;
    pixels[i + 1] = g + (ng - g) * wh;
    pixels[i + 2] = b + (nb - b) * wh;
  }
}

// ───── 衣物附接骨骼 ─────
/** 衣物部件類型（Phase 3 的 part_type）或圖層位置 → 應該跟隨的骨骼。_l／_r 為角色本人的左右。 */
export const ATTACH_BONE: Record<string, string> = {
  main: "torso", torso: "torso", back_panel: "torso", collar_back: "torso", collar_front: "torso", front_left: "torso", front_right: "torso", bow: "torso",
  waist_belt: "pelvis", skirt_front: "pelvis", skirt_back: "pelvis",
  sleeve_left: "shoulder_l", sleeve_right: "shoulder_r", sleeve_lower_left: "elbow_l", sleeve_lower_right: "elbow_r",
  cuff_left: "elbow_l", cuff_right: "elbow_r", glove_left: "wrist_l", glove_right: "wrist_r",
  sock_left: "knee_l", sock_right: "knee_r", shoe_left: "ankle_l", shoe_right: "ankle_r", head_accessory: "head",
  // 單圖衣物按圖層位置
  top: "torso", outer: "torso", dress: "torso", set: "torso", skirt: "pelvis", petticoat: "pelvis", pants: "pelvis", socks: "pelvis", shoes: "root", headwear: "head", bag: "root", accessory: "torso",
};

/** 單張 PNG 的衣物不會跟隨四肢彎曲：這些圖層位置受哪些關節影響、最多容許偏離多少度 */
const SINGLE_IMAGE_SENSITIVE: Record<string, { bones: string[]; tolerance: number }> = {
  top: { bones: ["shoulder_r", "shoulder_l", "elbow_r", "elbow_l", "torso"], tolerance: 6 },
  outer: { bones: ["shoulder_r", "shoulder_l", "elbow_r", "elbow_l", "torso"], tolerance: 6 },
  dress: { bones: ["shoulder_r", "shoulder_l", "elbow_r", "elbow_l", "torso", "hip_r", "hip_l"], tolerance: 6 },
  set: { bones: ["shoulder_r", "shoulder_l", "elbow_r", "elbow_l", "torso", "hip_r", "hip_l", "knee_r", "knee_l", "head"], tolerance: 5 },
  pants: { bones: ["hip_r", "hip_l", "knee_r", "knee_l"], tolerance: 4 },
  socks: { bones: ["hip_r", "hip_l", "knee_r", "knee_l", "ankle_r", "ankle_l"], tolerance: 4 },
  shoes: { bones: ["hip_r", "hip_l", "knee_r", "knee_l", "ankle_r", "ankle_l"], tolerance: 4 },
};
/**
 * 單圖衣物在目前姿勢下是否可靠。回傳不支援的原因（關節名稱）；空陣列＝可以。
 * 不會假裝整張衣服會自動彎曲：超出容許範圍就要提示使用者。
 */
export function singleImagePoseIssues(slot: string, pose: Pose | null | undefined): string[] {
  const rule = SINGLE_IMAGE_SENSITIVE[slot];
  if (!rule || !pose) return [];
  return rule.bones.filter((b) => Math.abs(pose[b] ?? 0) > rule.tolerance);
}

export const BONE_LABEL: Record<string, string> = {
  root: "整體", pelvis: "骨盆", torso: "上身", neck: "頸", head: "頭",
  shoulder_r: "右肩", elbow_r: "右手肘", wrist_r: "右手腕", shoulder_l: "左肩", elbow_l: "左手肘", wrist_l: "左手腕",
  hip_r: "右大腿", knee_r: "右膝", ankle_r: "右腳踝", hip_l: "左大腿", knee_l: "左膝", ankle_l: "左腳踝",
  hair_tail_r: "右馬尾", hair_tail_l: "左馬尾",
};
