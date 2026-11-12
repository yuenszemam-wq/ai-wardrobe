import { useEffect, useMemo, useState } from "react";
import { Pose, Rig, jointPositions, matToCss, solve } from "../../shared/avatarRig";
import { AVATAR_V2_BASE, HAIR_STYLES, HairSlot, Rgb, recolorHair, resolveHairColors } from "../../shared/avatarV2";

const urlCache = new Map<string, Promise<string>>();
async function pixelsOf(src: string): Promise<{ data: ImageData; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return { data: ctx.getImageData(0, 0, canvas.width, canvas.height), canvas, ctx };
}
/** 重新著色後的頭髮部件（同一組顏色只計算一次；輪廓及位置不變） */
function recolored(src: string, maskSrc: string | undefined, main: Rgb | null, accent: Rgb | null, ref: { main: number; accent: number }): Promise<string> {
  const key = `${src}|${main?.join(",") ?? "-"}|${accent?.join(",") ?? "-"}`;
  let p = urlCache.get(key);
  if (!p) {
    p = (async () => {
      const [img, mask] = await Promise.all([pixelsOf(src), maskSrc ? pixelsOf(maskSrc) : Promise.resolve(null)]);
      recolorHair(img.data.data, mask && mask.data.width === img.data.width && mask.data.height === img.data.height ? mask.data.data : null, main, accent, ref);
      img.ctx.putImageData(img.data, 0, 0);
      const blob = await new Promise<Blob | null>((r) => img.canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error("頭髮著色失敗");
      return URL.createObjectURL(blob);
    })();
    urlCache.set(key, p);
    p.catch(() => urlCache.delete(key));
  }
  return p;
}

export interface AvatarRigProps {
  rig: Rig;
  pose: Pose;
  /** 螢幕像素 ÷ 邏輯像素 */
  scale: number;
  hairStyle?: string | null;
  hairColor?: string | null;
  accentColor?: string | null;
  showHair?: boolean;
  showSkeleton?: boolean;
  /** 各組圖層的 z-index 起點（衣物可以插在身體與前髮之間） */
  zBack?: number;
  zBody?: number;
  zFront?: number;
  base?: string;
}

/** 以 DOM＋CSS transform 繪畫可動角色。放在 position:relative、比例與畫布相同的容器內。 */
export function AvatarRigRenderer({ rig, pose, scale, hairStyle, hairColor, accentColor, showHair = true, showSkeleton, zBack = 1, zBody = 10, zFront = 800, base = AVATAR_V2_BASE }: AvatarRigProps) {
  const mats = useMemo(() => solve(rig, pose), [rig, pose]);
  const style = HAIR_STYLES[hairStyle || ""] ?? Object.values(HAIR_STYLES)[0];
  const colors = useMemo(() => resolveHairColors(hairColor, accentColor), [hairColor, accentColor]);
  const [hairUrls, setHairUrls] = useState<Record<string, string>>({});
  const colorKey = `${style.id}|${colors.main?.join(",") ?? "-"}|${colors.accent?.join(",") ?? "-"}`;

  useEffect(() => {
    let cancelled = false;
    if (!colors.main && !colors.accent) {
      setHairUrls({});
      return;
    }
    void Promise.all(
      (Object.entries(style.parts) as [HairSlot, NonNullable<(typeof style.parts)[HairSlot]>][]).map(async ([slot, p]) => [slot, await recolored(base + p.src, p.accent_mask ? base + p.accent_mask : undefined, colors.main, colors.accent, style.ref_luma)] as const),
    )
      .then((entries) => { if (!cancelled) setHairUrls(Object.fromEntries(entries)); })
      .catch(() => { if (!cancelled) setHairUrls({}); });
    return () => { cancelled = true; };
  }, [colorKey, base]);

  if (!(scale > 0)) return null;
  const W = rig.canvas.w * scale, H = rig.canvas.h * scale;
  const layer = (name: string, src: string, box: { x: number; y: number; w: number; h: number }, bone: string, z: number) => (
    <div key={name} data-part={name} data-bone={bone} className="pointer-events-none absolute left-0 top-0" style={{ width: W, height: H, transformOrigin: "0 0", transform: matToCss(mats[bone] ?? [1, 0, 0, 1, 0, 0], scale), zIndex: z }}>
      <img src={src} alt="" draggable={false} className="absolute max-w-none select-none" style={{ left: box.x * scale, top: box.y * scale, width: box.w * scale, height: box.h * scale }} />
    </div>
  );
  const hair = (slots: string[], z: number) =>
    showHair
      ? slots.map((s, i) => {
          const p = style.parts[s as HairSlot];
          const bone = rig.parts[s]?.bone ?? "head";
          return p ? layer(s, hairUrls[s] ?? base + p.src, p, bone, z + i) : null;
        })
      : null;
  const joints = showSkeleton ? jointPositions(rig, pose) : null;
  return (
    <>
      {hair(rig.hair_back, zBack)}
      {rig.body_parts.map((name, i) => {
        const p = rig.parts[name];
        // 頭（臉）與前髮一樣在衣物之上
        return layer(name, base + p.src, p, p.bone, name === "head" ? zFront - 1 : zBody + i);
      })}
      {hair(rig.hair_front, zFront)}
      {joints && (
        <svg data-testid="avatar-skeleton" className="pointer-events-none absolute left-0 top-0" width={W} height={H} viewBox={`0 0 ${rig.canvas.w} ${rig.canvas.h}`} style={{ zIndex: zFront + 50 }}>
          {rig.bones.filter((b) => b.parent).map((b) => (
            <line key={b.id} x1={joints[b.parent!][0]} y1={joints[b.parent!][1]} x2={joints[b.id][0]} y2={joints[b.id][1]} stroke="#3b82f6" strokeWidth={5} strokeLinecap="round" opacity={0.8} />
          ))}
          {rig.bones.map((b) => (
            <circle key={b.id} cx={joints[b.id][0]} cy={joints[b.id][1]} r={10} fill="#f43f5e" stroke="#fff" strokeWidth={3} />
          ))}
        </svg>
      )}
    </>
  );
}
