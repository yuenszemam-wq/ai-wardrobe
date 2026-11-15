/**
 * Phase 3.9A.3：角色換裝的素材圖層面板及畫布移動。
 *
 * - 加入：共用素材面板（相簿／檔案／拍攝、手動去背、我的素材庫、最近使用）。
 * - 附接：固定畫面或跟隨骨骼（頭、手、前臂、胸口……）；改變附接時保持畫面位置不跳動。
 * - 前後：角色後面／衣服之上／最前，同一層可調次序；隱藏、翻轉、透明度、旋轉、大小、遮罩。
 * - 移動：在畫布上單指拖動、雙指縮放及旋轉（只改動已選素材，不影響姿勢及衣物）。
 */
import { PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import { Mat, applyMat, invert, multiply } from "../../shared/avatarRig";
import { MAX_PROPS, PROP_BONES, PROP_Z, PropLayer, PropZ, propSrc } from "../../shared/lookProps";
import { Button } from "../components/ui";
import { AssetPicker } from "../studio/AssetPicker";
import { StudioAsset } from "../studio/assets";
import { MaskEditorSheet } from "../studio/MaskEditor";
import { propMatrix } from "./engine";

const uid = () => "pr_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const boneMat = (bone: string, mats: Record<string, Mat>): Mat => (bone === "world" ? [1, 0, 0, 1, 0, 0] : mats[bone] ?? mats.root);
const angleOf = (m: Mat) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
const wrap = (a: number) => Math.round((((a % 360) + 540) % 360 - 180) * 10) / 10;

/** 改變附接骨骼：保持目前畫面上的位置及角度 */
export function reattach(p: PropLayer, bone: string, mats: Record<string, Mat>): PropLayer {
  const [wx, wy] = applyMat(multiply([1, 0, 0, 1, 0, 0], propMatrix(p, mats)), 0, 0);
  const nb = boneMat(bone, mats), [cx, cy] = applyMat(invert(nb), wx, wy);
  return { ...p, bone, cx: Math.round(cx * 10) / 10, cy: Math.round(cy * 10) / 10, rotation: wrap(angleOf(boneMat(p.bone, mats)) + p.rotation - angleOf(nb)) };
}
/** 新素材：放在畫面中間偏上（固定畫面） */
export function newProp(a: StudioAsset, variant: "original" | "cutout"): PropLayer {
  const v = a.version!, w = 360, h = Math.round((360 * v.height) / Math.max(1, v.width));
  return { layer_id: uid(), asset_id: a.id, version_id: v.id, variant, name: a.name, bone: "world", z: "front", cx: 600, cy: 760, w, h, rotation: 0, flip_x: false, flip_y: false, opacity: 1, hidden: false, mask: null };
}

export function PropsPanel({ props, mats, onChange, selected, onSelect, onMove, cutouts }: {
  props: PropLayer[]; mats: Record<string, Mat>; onChange: (next: PropLayer[], live?: boolean) => void; selected: string | null; onSelect: (id: string | null) => void; onMove: (id: string) => void;
  /** 素材版本是否有去背圖（加入時記錄） */ cutouts: Record<string, boolean>;
}) {
  const [masking, setMasking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const sel = props.find((p) => p.layer_id === selected) ?? null;
  const patch = (id: string, q: Partial<PropLayer>, live = false) => onChange(props.map((p) => (p.layer_id === id ? { ...p, ...q } : p)), live);
  const move = (id: string, dir: -1 | 1) => {
    const i = props.findIndex((p) => p.layer_id === id); const z = props[i].z;
    // 同一層（z）內交換次序
    let j = i + dir; while (j >= 0 && j < props.length && props[j].z !== z) j += dir;
    if (j < 0 || j >= props.length) return;
    const next = [...props]; [next[i], next[j]] = [next[j], next[i]]; onChange(next);
  };
  const ordered = PROP_Z.slice().reverse().flatMap(([z]) => props.filter((p) => p.z === z).reverse());
  return (
    <div className="space-y-2 text-[12.5px]" data-testid="props-panel" data-props={props.map((p) => p.layer_id).join(",")}>
      {!props.length && <p className="text-[12px] text-mauve">未有素材圖層。加入道具、裝飾或配件圖片，可固定在畫面或附接在頭、手、前臂等位置，換姿勢時會跟著移動。</p>}
      {ordered.length > 0 && <div className="space-y-1" data-testid="prop-list">
        {ordered.map((p) => (
          <div key={p.layer_id} className={`flex items-center gap-1.5 rounded-xl p-1 ${p.layer_id === selected ? "chip-on" : "chip"}`} data-prop={p.layer_id}>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSelect(p.layer_id === selected ? null : p.layer_id)}>
              <span className="checker block h-10 w-8 shrink-0 overflow-hidden rounded-lg"><img src={`/api/studio/versions/${p.version_id}/thumb`} alt="" className="h-full w-full object-contain" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate">{p.name || "素材"}</span><span className="block truncate text-[10.5px] opacity-75">{PROP_Z.find(([z]) => z === p.z)?.[1]}・{PROP_BONES.find(([b]) => b === p.bone)?.[1]}{p.mask ? "・遮罩" : ""}</span></span>
            </button>
            <button type="button" aria-label={p.hidden ? "顯示" : "隱藏"} aria-pressed={p.hidden} data-prop-action="hide" onClick={() => patch(p.layer_id, { hidden: !p.hidden })} className="grid h-8 w-8 place-items-center">{p.hidden ? "◌" : "◉"}</button>
            <button type="button" aria-label="向前" data-prop-action="up" onClick={() => move(p.layer_id, 1)} className="grid h-8 w-7 place-items-center">↑</button>
            <button type="button" aria-label="向後" data-prop-action="down" onClick={() => move(p.layer_id, -1)} className="grid h-8 w-7 place-items-center">↓</button>
          </div>
        ))}
      </div>}
      {sel && (
        <div className="space-y-1.5 rounded-2xl p-2 doll-tool" data-testid="prop-controls" data-sel={sel.layer_id}>
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" onClick={() => onMove(sel.layer_id)} data-testid="prop-move">在畫布移動</Button>
            <Button variant="ghost" onClick={() => setMasking(sel.layer_id)} data-testid="prop-mask">遮罩</Button>
            <Button variant="ghost" onClick={() => patch(sel.layer_id, { flip_x: !sel.flip_x })}>⇋ 翻轉</Button>
            {cutouts[sel.version_id] && <Button variant="ghost" onClick={() => patch(sel.layer_id, { variant: sel.variant === "cutout" ? "original" : "cutout" })} data-testid="prop-variant">{sel.variant === "cutout" ? "改用原圖" : "改用去背圖"}</Button>}
            <Button variant="ghost" className="text-wine" onClick={() => { onChange(props.filter((p) => p.layer_id !== sel.layer_id)); onSelect(null); }} data-testid="prop-remove">移除</Button>
          </div>
          <label className="flex items-center gap-2"><span className="w-10 shrink-0 text-mauve">附接</span>
            <select value={sel.bone} onChange={(e) => onChange(props.map((p) => (p.layer_id === sel.layer_id ? reattach(p, e.target.value, mats) : p)))} className="field h-8 flex-1 rounded-full px-2 text-[14px]" data-testid="prop-bone">
              {PROP_BONES.map(([b, l]) => <option key={b} value={b}>{l}</option>)}
            </select></label>
          <div className="seg" role="radiogroup" aria-label="前後">{PROP_Z.map(([z, l]) => <button key={z} type="button" aria-selected={sel.z === z} data-prop-z={z} onClick={() => patch(sel.layer_id, { z: z as PropZ })}>{l}</button>)}</div>
          <Range label="大小" value={sel.w} min={20} max={1600} step={2} onChange={(w, live) => patch(sel.layer_id, { w, h: Math.round(sel.h * (w / sel.w) * 10) / 10 }, live)} />
          <Range label="旋轉" value={sel.rotation} min={-180} max={180} step={1} onChange={(rotation, live) => patch(sel.layer_id, { rotation }, live)} />
          <Range label="透明" value={sel.opacity} min={0.05} max={1} step={0.05} onChange={(opacity, live) => patch(sel.layer_id, { opacity }, live)} />
        </div>
      )}
      {props.length < MAX_PROPS ? (adding ? <div className="rounded-2xl border border-[color-mix(in_srgb,var(--aw-line)_30%,transparent)] p-2"><AssetPicker defaultKind="prop" onAdd={(a, v) => { const p = newProp(a, v); cutouts[a.version!.id] = !!a.version!.has_cutout; onChange([...props, p]); onSelect(p.layer_id); setAdding(false); }} /><Button variant="ghost" className="mt-1 w-full" onClick={() => setAdding(false)}>收起</Button></div>
        : <Button variant="ghost" className="w-full" onClick={() => setAdding(true)} data-testid="prop-add">＋ 加入素材</Button>)
        : <p className="text-[11.5px] text-mauve">每個造型最多 {MAX_PROPS} 個素材圖層。</p>}
      {masking && (() => { const p = props.find((x) => x.layer_id === masking); return p ? <MaskEditorSheet src={propSrc(p)} value={p.mask} title={`「${p.name || "素材"}」的遮罩`} onClose={() => setMasking(null)} onDone={(m) => { patch(p.layer_id, { mask: m }); setMasking(null); }} /> : null; })()}
    </div>
  );
}

function Range({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number, live: boolean) => void }) {
  return <label className="flex items-center gap-2"><span className="w-10 shrink-0 text-mauve">{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value), true)} onPointerUp={(e) => onChange(Number((e.target as HTMLInputElement).value), false)} onKeyUp={(e) => onChange(Number((e.target as HTMLInputElement).value), false)} className="min-w-0 flex-1" data-range={label} /><span className="w-10 text-right tabular-nums">{Math.round(value * 100) / 100}</span></label>;
}

/** 畫布移動層：單指拖動；雙指縮放及旋轉。stage＝doll-stage 元素（讀取 data-k 換算邏輯座標） */
export function PropMoveLayer({ prop, mats, onChange, onDone }: { prop: PropLayer; mats: Record<string, Mat>; onChange: (q: Partial<PropLayer>, live: boolean) => void; onDone: () => void }) {
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ p: PropLayer; pts: [number, number][] } | null>(null);
  const k = () => Number(document.querySelector<HTMLElement>('[data-testid="doll-stage"]')?.dataset.k) || 1;
  const inv = invert(boneMat(prop.bone, mats));
  const down = (e: ReactPointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); start.current = { p: prop, pts: [...pts.current.values()].map((v) => [v.x, v.y]) }; };
  const moveH = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pts.current.has(e.pointerId) || !start.current) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const s = start.current, now = [...pts.current.values()].map((v) => [v.x, v.y] as [number, number]), kk = k();
    if (now.length >= 2 && s.pts.length >= 2) {
      const d0 = Math.hypot(s.pts[0][0] - s.pts[1][0], s.pts[0][1] - s.pts[1][1]) || 1, d1 = Math.hypot(now[0][0] - now[1][0], now[0][1] - now[1][1]);
      const a0 = Math.atan2(s.pts[1][1] - s.pts[0][1], s.pts[1][0] - s.pts[0][0]), a1 = Math.atan2(now[1][1] - now[0][1], now[1][0] - now[0][0]);
      const f = Math.max(0.1, Math.min(10, d1 / d0));
      onChange({ w: Math.round(s.p.w * f * 10) / 10, h: Math.round(s.p.h * f * 10) / 10, rotation: wrap(s.p.rotation + ((a1 - a0) * 180) / Math.PI) }, true);
      return;
    }
    // 螢幕位移 → 邏輯畫布位移 → 骨骼靜止座標位移（只用矩陣的線性部分）
    const dx = (now[0][0] - s.pts[0][0]) / kk, dy = (now[0][1] - s.pts[0][1]) / kk;
    const lx = inv[0] * dx + inv[2] * dy, ly = inv[1] * dx + inv[3] * dy;
    onChange({ cx: Math.round((s.p.cx + lx) * 10) / 10, cy: Math.round((s.p.cy + ly) * 10) / 10 }, true);
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    pts.current.delete(e.pointerId);
    onChange({}, false); // 一次手勢＝一筆撤銷紀錄
    start.current = pts.current.size ? { p: prop, pts: [...pts.current.values()].map((v) => [v.x, v.y]) } : null;
  };
  return (
    <>
      <div className="absolute inset-0 z-20" style={{ touchAction: "none", cursor: "move" }} data-testid="prop-move-layer" onPointerDown={down} onPointerMove={moveH} onPointerUp={up} onPointerCancel={up} />
      <div className="pointer-events-none absolute inset-x-2 top-2 z-30 flex justify-center">
        <div className="doll-tool pointer-events-auto flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px]">
          <span>移動「{prop.name || "素材"}」：拖動移動，雙指縮放及旋轉</span>
          <button type="button" className="doll-tool-on h-7 rounded-full px-3" onClick={onDone} data-testid="prop-move-done">完成</button>
        </div>
      </div>
    </>
  );
}
