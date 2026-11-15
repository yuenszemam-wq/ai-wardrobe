/**
 * Phase 3.9A.2：背景設定（衣服配搭及角色換裝共用）。即時預覽：每次修改立即套用到畫布，不需要先保存。
 * 背景屬於造型內容，與 App 主題分開；修改背景不會改變介面顏色。
 */
import { useEffect, useState } from "react";
import { BACKGROUND_PRESETS, BACKGROUND_TYPES, BackgroundSpec, DEFAULT_BACKGROUND, normalizeBackground, withPreset } from "../../shared/studioScene";
import { StudioAsset, listStudioAssets } from "./assets";

const hsl = (hex: string) => {
  const n = parseInt(hex.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(((h * 60) + 360) % 360), s: Math.round(s * 100), l: Math.round(l * 100) };
};
const fromHsl = (h: number, s: number, l: number) => {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return "#" + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("");
};

function ColorField({ label, value, onChange, testid }: { label: string; value: string; onChange: (v: string) => void; testid?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const c = hsl(value);
  return (
    <div className="space-y-1" data-testid={testid}>
      <div className="flex items-center gap-2 text-[12px]">
        <span className="w-12 shrink-0 text-mauve">{label}</span>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label}調色器`} className="h-8 w-10 shrink-0 cursor-pointer rounded-lg border-0 bg-transparent p-0" />
        <input value={text} onChange={(e) => { setText(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value.toLowerCase()); }} aria-label={`${label} HEX`} maxLength={7} className="field h-8 w-24 rounded-full px-2 font-mono text-[14px]" data-hex />
      </div>
      <div className="grid grid-cols-3 gap-1.5 pl-14 text-[10.5px] text-mauve">
        <label>色相<input type="range" min={0} max={359} value={c.h} onChange={(e) => onChange(fromHsl(Number(e.target.value), c.s, c.l))} className="hue-track w-full" style={{ ["--thumb" as string]: value }} /></label>
        <label>飽和度<input type="range" min={0} max={100} value={c.s} onChange={(e) => onChange(fromHsl(c.h, Number(e.target.value), c.l))} className="w-full" /></label>
        <label>明度<input type="range" min={0} max={100} value={c.l} onChange={(e) => onChange(fromHsl(c.h, c.s, Number(e.target.value)))} className="w-full" /></label>
      </div>
    </div>
  );
}
function Slider({ label, value, min, max, step = 1, onChange, unit = "", testid }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; unit?: string; testid?: string }) {
  return <label className="flex items-center gap-2 text-[12px]"><span className="w-12 shrink-0 text-mauve">{label}</span><input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-w-0 flex-1" data-testid={testid} /><span className="w-12 shrink-0 text-right tabular-nums">{Math.round(value * 100) / 100}{unit}</span></label>;
}

/** onChange(spec, commit)：commit=false 用於拖動滑桿期間（放手時才記入撤銷紀錄） */
export function BackgroundPanel({ value, onChange, onUpload, legacyLabel = "預設背景" }: { value: BackgroundSpec | null; onChange: (v: BackgroundSpec | null) => void; onUpload: (file: File) => Promise<{ asset_id: string; version_id: string } | null>; legacyLabel?: string }) {
  const spec = value ?? null;
  const cur = spec ?? DEFAULT_BACKGROUND;
  const set = (p: Partial<BackgroundSpec>) => onChange(normalizeBackground({ ...cur, ...p }) ?? cur);
  const [library, setLibrary] = useState<StudioAsset[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (cur.type === "image" && !library) listStudioAssets({ kind: "background" }).then(setLibrary).catch(() => setLibrary([])); }, [cur.type, library]);
  const img = cur.image;
  const setImg = (p: Partial<NonNullable<BackgroundSpec["image"]>>) => img && set({ image: { ...img, ...p } });
  return (
    <div className="space-y-2.5 text-[12.5px]" data-testid="bg-panel" data-bg-type={spec?.type ?? "legacy"}>
      <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1">
        <button type="button" aria-pressed={!spec} onClick={() => onChange(null)} className={`h-8 shrink-0 rounded-full px-3 ${!spec ? "chip-on" : "chip"}`} data-bg="legacy">{legacyLabel}</button>
        {BACKGROUND_TYPES.map(([k, l]) => <button key={k} type="button" aria-pressed={spec?.type === k} data-bg={k} onClick={() => set({ type: k, image: k === "image" ? cur.image : null })} className={`h-8 shrink-0 rounded-full px-3 ${spec?.type === k ? "chip-on" : "chip"}`}>{l}</button>)}
      </div>
      <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1" aria-label="內建風格">
        {BACKGROUND_PRESETS.map(([name, p]) => <button key={name} type="button" data-preset={name} onClick={() => onChange(withPreset(spec, p))} className="chip flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5"><span className="h-4 w-4 rounded-full border border-[color-mix(in_srgb,var(--aw-line)_50%,transparent)]" style={{ background: p.type === "gradient" ? `linear-gradient(${(p.stops ?? []).map((s) => s.color).join(",")})` : p.color }} />{name}</button>)}
      </div>
      {!spec && <p className="text-[11.5px] text-mauve">舊造型保持原本的顯示及匯出；選擇其他背景後才會保存背景設定。</p>}
      {spec?.type === "transparent" && <p className="text-[11.5px] text-mauve">棋盤格只在編輯時顯示，匯出時是真正透明。</p>}
      {spec?.type === "solid" && <ColorField label="顏色" value={cur.color} onChange={(color) => set({ color })} testid="bg-color" />}
      {spec?.type === "gradient" && <>
        {cur.stops.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="min-w-0 flex-1"><ColorField label={`色點 ${i + 1}`} value={s.color} onChange={(color) => set({ stops: cur.stops.map((x, j) => (j === i ? { ...x, color } : x)) })} /></div>
            {cur.stops.length > 2 && <button type="button" className="chip h-7 w-7 rounded-full" aria-label="移除色點" onClick={() => set({ stops: cur.stops.filter((_, j) => j !== i) })}>✕</button>}
          </div>
        ))}
        {cur.stops.length < 4 && <button type="button" className="chip h-7 rounded-full px-3 text-[11.5px]" onClick={() => set({ stops: [...cur.stops.map((s, i) => ({ ...s, at: i / cur.stops.length })), { color: cur.stops[cur.stops.length - 1].color, at: 1 }] })}>＋ 色點</button>}
        <div className="flex flex-wrap gap-1">{[[0, "↑"], [90, "→"], [180, "↓"], [135, "↘"], [45, "↗"]].map(([a, l]) => <button key={a} type="button" onClick={() => set({ angle: Number(a) })} className={`h-7 w-9 rounded-full ${cur.angle === a ? "chip-on" : "chip"}`} aria-label={`方向 ${a}°`}>{l}</button>)}</div>
        <Slider label="角度" value={cur.angle} min={0} max={360} onChange={(angle) => set({ angle })} unit="°" />
      </>}
      {(spec?.type === "stripes" || spec?.type === "dots" || spec?.type === "check") && <>
        <ColorField label="主色" value={cur.color} onChange={(color) => set({ color })} />
        <ColorField label="副色" value={cur.color2} onChange={(color2) => set({ color2 })} />
        <Slider label="大小" value={cur.size} min={2} max={200} onChange={(size) => set({ size })} testid="bg-size" />
        <Slider label="間距" value={cur.gap} min={2} max={200} onChange={(gap) => set({ gap })} />
        <Slider label="方向" value={cur.angle} min={0} max={360} onChange={(angle) => set({ angle })} unit="°" />
      </>}
      {spec?.type === "image" && <>
        <div className="flex gap-1.5">
          <label className="chip flex h-8 cursor-pointer items-center rounded-full px-3">{busy ? "上傳中…" : "上傳背景圖"}<input type="file" accept="image/*" className="hidden" data-testid="bg-file" disabled={busy} onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; setBusy(true); try { const r = await onUpload(f); if (r) { set({ type: "image", image: { asset_id: r.asset_id, version_id: r.version_id, variant: "original", fit: "cover", x: 0, y: 0, scale: 1, rotate: 0, flip_x: false, flip_y: false, opacity: 1, blur: 0 } }); setLibrary(null); } } finally { setBusy(false); } }} /></label>
        </div>
        {library && library.length > 0 && <div className="scrollbar-none -mx-1 flex gap-1.5 overflow-x-auto px-1" data-testid="bg-library">{library.filter((a) => a.version).map((a) => <button key={a.id} type="button" onClick={() => set({ type: "image", image: { ...(img ?? { fit: "cover", x: 0, y: 0, scale: 1, rotate: 0, flip_x: false, flip_y: false, opacity: 1, blur: 0, variant: "original" }), asset_id: a.id, version_id: a.version!.id } })} className={`h-14 w-11 shrink-0 overflow-hidden rounded-lg ${img?.asset_id === a.id ? "ring-2 ring-[var(--aw-focus)]" : ""}`}><img src={a.version!.thumb_url} alt={a.name} className="h-full w-full object-cover" /></button>)}</div>}
        {!img && <p className="text-[11.5px] text-mauve">上傳或從「我的背景」選擇一張圖片。</p>}
        {img && <>
          <div className="flex gap-1">{(["cover", "contain"] as const).map((f) => <button key={f} type="button" aria-pressed={img.fit === f} onClick={() => setImg({ fit: f })} className={`h-7 rounded-full px-3 ${img.fit === f ? "chip-on" : "chip"}`}>{f === "cover" ? "填滿" : "完整顯示"}</button>)}
            <button type="button" aria-pressed={img.flip_x} onClick={() => setImg({ flip_x: !img.flip_x })} className={`h-7 rounded-full px-3 ${img.flip_x ? "chip-on" : "chip"}`}>⇋</button>
            <button type="button" aria-pressed={img.flip_y} onClick={() => setImg({ flip_y: !img.flip_y })} className={`h-7 rounded-full px-3 ${img.flip_y ? "chip-on" : "chip"}`}>⇵</button></div>
          <Slider label="水平" value={img.x} min={-100} max={100} onChange={(x) => setImg({ x })} unit="%" />
          <Slider label="垂直" value={img.y} min={-100} max={100} onChange={(y) => setImg({ y })} unit="%" />
          <Slider label="縮放" value={img.scale} min={0.2} max={5} step={0.05} onChange={(scale) => setImg({ scale })} />
          <Slider label="旋轉" value={img.rotate} min={-180} max={180} onChange={(rotate) => setImg({ rotate })} unit="°" />
          <Slider label="模糊" value={img.blur} min={0} max={30} step={0.5} onChange={(blur) => setImg({ blur })} />
          <Slider label="透明度" value={img.opacity} min={0} max={1} step={0.05} onChange={(opacity) => setImg({ opacity })} />
        </>}
      </>}
      {spec && spec.type !== "transparent" && spec.type !== "image" && <Slider label="透明度" value={cur.opacity} min={0} max={1} step={0.05} onChange={(opacity) => set({ opacity })} />}
    </div>
  );
}
