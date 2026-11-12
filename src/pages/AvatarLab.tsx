import { PointerEvent as ReactPointerEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pose, clampPose, jointPositions, normalizePose, reachIK } from "../../shared/avatarRig";
import { AVATAR_V2_ID, DEFAULT_HAIR_COLOR, DEFAULT_HAIR_STYLE, HAIR_STYLES, RIG_V2, normalizeColorValue } from "../../shared/avatarV2";
import { IconChevronLeft } from "../components/icons";
import { Link, Sheet, toast } from "../components/ui";
import { AvatarLook, AvatarPoseEditor } from "../doll/AvatarPoseEditor";
import { AvatarRigRenderer } from "../doll/AvatarRigRenderer";

const KEY = "aw:avatar-lab:v2";
const rig = RIG_V2;
const DEFAULT: AvatarLook = { hair_style: DEFAULT_HAIR_STYLE, hair_color: DEFAULT_HAIR_COLOR, accent_color: null, pose: {} };
/** 可拖動的末端：手掌及腳掌（兩節 IK） */
const HANDLES: { end: string; mid: string; upper: string; label: string }[] = [
  { end: "wrist_r", mid: "elbow_r", upper: "shoulder_r", label: "右手" },
  { end: "wrist_l", mid: "elbow_l", upper: "shoulder_l", label: "左手" },
  { end: "ankle_r", mid: "knee_r", upper: "hip_r", label: "右腳" },
  { end: "ankle_l", mid: "knee_l", upper: "hip_l", label: "左腳" },
];

function readSaved(): AvatarLook | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null") as Partial<AvatarLook> | null;
    if (!raw) return null;
    const pose = normalizePose(rig, raw.pose);
    return {
      hair_style: raw.hair_style && HAIR_STYLES[raw.hair_style] ? raw.hair_style : DEFAULT_HAIR_STYLE,
      hair_color: normalizeColorValue(raw.hair_color) ?? DEFAULT_HAIR_COLOR,
      accent_color: raw.accent_color === "original" ? "original" : normalizeColorValue(raw.accent_color),
      pose: pose ?? {},
    };
  } catch {
    return null;
  }
}

/** Avatar V2 獨立測試頁：驗證拆件、骨架、髮色及姿勢；不讀寫 D1／R2（設定只存在本機）。 */
export default function AvatarLab() {
  const [look, setLook] = useState<AvatarLook>(() => readSaved() ?? DEFAULT);
  const [skeleton, setSkeleton] = useState(false);
  const [hair, setHair] = useState(true);
  const [compare, setCompare] = useState(false);
  const [panel, setPanel] = useState(false);
  const [k, setK] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<(typeof HANDLES)[number] | null>(null);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setK(el.getBoundingClientRect().width / rig.canvas.w);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const joints = useMemo(() => jointPositions(rig, look.pose), [look.pose]);
  const setPose = (pose: Pose) => setLook((cur) => ({ ...cur, pose: clampPose(rig, pose) }));

  function onHandleDown(e: ReactPointerEvent<HTMLButtonElement>, h: (typeof HANDLES)[number]) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = h;
  }
  function onHandleMove(e: ReactPointerEvent<HTMLButtonElement>) {
    const h = drag.current;
    if (!h || !k || !stage.current) return;
    const r = stage.current.getBoundingClientRect();
    setPose(reachIK(rig, look.pose, h.upper, h.mid, h.end, [(e.clientX - r.left) / k, (e.clientY - r.top) / k]));
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 pt-5">
        <Link to="/dressing" className="btn-dark flex items-center gap-1 rounded-full py-1.5 pl-2 pr-3.5 text-[13px]">
          <IconChevronLeft className="text-[15px]" />
          角色換裝
        </Link>
        <h1 className="min-w-0 truncate text-center font-serif text-[17px] font-bold tracking-[0.12em] text-gold-soft">Avatar V2 測試</h1>
        <button type="button" data-testid="open-editor" onClick={() => setPanel(true)} className="btn-jewel rounded-full px-3.5 py-1.5 text-[13px]">角色設定</button>
      </div>

      <div className="frame mx-auto mt-3 p-1.5" style={{ width: "min(100%, calc((100dvh - 250px) * 2 / 3 + 12px))", minWidth: 220 }}>
        <div ref={stage} data-testid="avatar-stage" data-avatar={AVATAR_V2_ID} className="relative overflow-hidden rounded-[12px] select-none" style={{ aspectRatio: `${rig.canvas.w} / ${rig.canvas.h}`, background: "linear-gradient(#f7f0f6, #eadff0)", touchAction: "none", isolation: "isolate" }}>
          {compare ? (
            <img src="/doll/avatar_v2/avatar_base_v2.png" alt="原圖" data-testid="avatar-original" className="absolute inset-0 h-full w-full" />
          ) : (
            <AvatarRigRenderer rig={rig} pose={look.pose} scale={k} hairStyle={look.hair_style} hairColor={look.hair_color} accentColor={look.accent_color} showHair={hair} showSkeleton={skeleton} />
          )}
          {!compare && k > 0 && HANDLES.map((h) => (
            <button key={h.end} type="button" aria-label={`拖動${h.label}`} data-handle={h.end} className="absolute grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white/80 bg-amethyst/50 text-[10px] text-white" style={{ left: joints[h.end][0] * k, top: joints[h.end][1] * k, zIndex: 900, touchAction: "none", cursor: "grab" }}
              onPointerDown={(e) => onHandleDown(e, h)} onPointerMove={onHandleMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>✥</button>
          ))}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-[13px]">
        <button type="button" aria-pressed={compare} onClick={() => setCompare(!compare)} className={`min-h-10 rounded-full ${compare ? "chip-on" : "chip"}`}>{compare ? "返回拆件角色" : "對比原圖"}</button>
        <button type="button" aria-pressed={!hair} data-testid="toggle-hair" onClick={() => setHair(!hair)} className={`min-h-10 rounded-full ${hair ? "chip" : "chip-on"}`}>{hair ? "隱藏頭髮" : "顯示頭髮"}</button>
        <button type="button" data-testid="lab-save" onClick={() => { localStorage.setItem(KEY, JSON.stringify(look)); toast("已保存在這部裝置（測試用）"); }} className="btn-jewel min-h-10 rounded-full">保存外觀及姿勢</button>
        <button type="button" data-testid="lab-reset" onClick={() => { localStorage.removeItem(KEY); setLook(DEFAULT); }} className="btn-dark min-h-10 rounded-full">全部還原</button>
      </div>
      <p className="mt-2 text-center text-[11px] leading-relaxed text-mauve">拖動手掌或腳掌的圓點可調整姿勢；「角色設定」內可換髮色、姿勢預設及逐個關節微調。這一頁只作測試，不會改動衣櫃或已保存的造型。</p>

      {panel && (
        <Sheet title="角色設定" onClose={() => setPanel(false)}>
          <AvatarPoseEditor rig={rig} value={look} onChange={setLook} showSkeleton={skeleton} onShowSkeleton={setSkeleton} />
        </Sheet>
      )}
    </div>
  );
}
