import { useState } from "react";
import { Pose, Rig, boneMap, clampPose, samePose } from "../../shared/avatarRig";
import { BONE_LABEL, HAIR_COLORS, HAIR_STYLES, POSE_PRESETS, hexToRgb, rgbToHex, resolveHairColors } from "../../shared/avatarV2";

export interface AvatarLook {
  hair_style: string;
  hair_color: string;
  accent_color: string | null;
  pose: Pose;
}

const GROUPS: { label: string; bones: string[] }[] = [
  { label: "手臂", bones: ["shoulder_r", "shoulder_l", "elbow_r", "elbow_l", "wrist_r", "wrist_l"] },
  { label: "腿", bones: ["hip_r", "hip_l", "knee_r", "knee_l", "ankle_r", "ankle_l"] },
  { label: "頭及身", bones: ["head", "neck", "torso", "pelvis"] },
  { label: "馬尾", bones: ["hair_tail_r", "hair_tail_l"] },
];

/** 角色設定面板的內容（放進底部抽屜使用）：髮型、髮色、姿勢預設、逐個關節微調。 */
export function AvatarPoseEditor({ rig, value, onChange, showSkeleton, onShowSkeleton }: { rig: Rig; value: AvatarLook; onChange: (v: AvatarLook) => void; showSkeleton: boolean; onShowSkeleton: (v: boolean) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const bones = boneMap(rig);
  const setPose = (pose: Pose) => onChange({ ...value, pose: clampPose(rig, pose) });
  const preset = POSE_PRESETS.find((p) => samePose(rig, p.pose, value.pose));
  const resolved = resolveHairColors(value.hair_color, value.accent_color);
  const orig = (rig as unknown as { hair?: { original?: { main: number[]; accent: number[] } } }).hair?.original;
  const swatch = (c: [number, number, number] | null, fallback?: number[]) => (c ? rgbToHex(c) : fallback ? rgbToHex(fallback.map((v) => v * 255) as [number, number, number]) : "#644950");
  const styles = Object.values(HAIR_STYLES);

  return (
    <div className="flex flex-col gap-4 text-[13px]" data-testid="avatar-editor">
      <section>
        <h3 className="mb-1.5 text-[12px] tracking-[0.1em] text-gold-soft">髮型</h3>
        <div className="flex flex-wrap gap-1.5">
          {styles.map((s) => (
            <button key={s.id} type="button" onClick={() => onChange({ ...value, hair_style: s.id })} className={`rounded-full px-3 py-1.5 ${value.hair_style === s.id ? "chip-on" : "chip"}`}>{s.label}</button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 text-[12px] tracking-[0.1em] text-gold-soft">髮色</h3>
        <div className="flex flex-wrap gap-1.5" data-testid="hair-colors">
          {HAIR_COLORS.map((c) => (
            <button key={c.id} type="button" data-color={c.id} onClick={() => onChange({ ...value, hair_color: c.id, accent_color: null })} className={`flex items-center gap-1.5 rounded-full py-1.5 pl-2 pr-3 ${value.hair_color === c.id && !value.accent_color ? "chip-on" : "chip"}`}>
              <span className="h-4 w-4 rounded-full border border-white/40" style={{ background: `linear-gradient(135deg, ${swatch(c.main, orig?.main)} 60%, ${swatch(c.accent, orig?.accent)} 60%)` }} />
              {c.label}
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="chip flex items-center justify-between gap-2 rounded-2xl px-3 py-2">
            主髮色
            <input type="color" aria-label="主髮色" value={swatch(resolved.main, orig?.main)} onChange={(e) => onChange({ ...value, hair_color: e.target.value, accent_color: value.accent_color ?? (resolved.accent ? rgbToHex(resolved.accent) : "original") })} className="h-7 w-10 rounded border-0 bg-transparent p-0" />
          </label>
          <label className="chip flex items-center justify-between gap-2 rounded-2xl px-3 py-2">
            挑染色
            <input type="color" aria-label="挑染色" value={swatch(resolved.accent, orig?.accent)} onChange={(e) => hexToRgb(e.target.value) && onChange({ ...value, accent_color: e.target.value })} className="h-7 w-10 rounded border-0 bg-transparent p-0" />
          </label>
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 text-[12px] tracking-[0.1em] text-gold-soft">姿勢</h3>
        <div className="flex flex-wrap gap-1.5" data-testid="pose-presets">
          {POSE_PRESETS.map((p) => (
            <button key={p.id} type="button" data-pose={p.id} onClick={() => setPose(p.pose)} className={`rounded-full px-3 py-1.5 ${preset?.id === p.id ? "chip-on" : "chip"}`}>{p.label}</button>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <button type="button" data-testid="pose-reset" onClick={() => setPose({})} className="btn-dark min-h-9 flex-1 rounded-full">重設全部關節</button>
          <button type="button" aria-pressed={showSkeleton} onClick={() => onShowSkeleton(!showSkeleton)} className={`min-h-9 flex-1 rounded-full ${showSkeleton ? "chip-on" : "chip"}`}>{showSkeleton ? "隱藏骨架" : "顯示骨架"}</button>
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 text-[12px] tracking-[0.1em] text-gold-soft">關節微調（左右為角色本人的左右）</h3>
        <div className="flex flex-col gap-1.5">
          {GROUPS.map((g) => (
            <div key={g.label} className="chip rounded-2xl px-3 py-2">
              <button type="button" aria-expanded={open === g.label} onClick={() => setOpen(open === g.label ? null : g.label)} className="flex w-full items-center justify-between">
                <span>{g.label}</span>
                <span className="text-[11px] opacity-70">{g.bones.filter((b) => (value.pose[b] ?? 0) !== 0).length ? "已調整" : ""} {open === g.label ? "▲" : "▼"}</span>
              </button>
              {open === g.label && (
                <div className="mt-2 flex flex-col gap-2">
                  {g.bones.map((id) => {
                    const b = bones.get(id);
                    if (!b || b.min_angle === b.max_angle) return null;
                    const v = value.pose[id] ?? 0;
                    return (
                      <label key={id} className="grid grid-cols-[4.5rem_1fr_2.6rem] items-center gap-2">
                        <span>{BONE_LABEL[id] ?? id}</span>
                        <input type="range" data-bone={id} min={b.min_angle} max={b.max_angle} step={0.5} value={v} onChange={(e) => setPose({ ...value.pose, [id]: Number(e.target.value) })} className="w-full" style={{ touchAction: "pan-y" }} />
                        <span className="text-right tabular-nums">{v > 0 ? "+" : ""}{v}°</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
