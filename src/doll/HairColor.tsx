// 髮色工作室（Phase 3.4）：滑動調色（色相／飽和度／明暗）、HEX、自訂色票、最近使用、完整髮色組合。
// 色票及組合存在伺服器（/api/doll/palette），換手機或重新開啟都會保留。原有七款內置配色保持不變。
import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { EMPTY_PALETTE, HAIR_COLORS, HairCombo, HairPalette, PaletteColor, resolveHairColors, rgbToHex } from "../../shared/avatarV2";
import { api } from "../api";
import { IconPlus, IconTrash } from "../components/icons";
import { toast } from "../components/ui";
import { Appearance } from "./model";

type Target = "main" | "accent" | "tip";
const TARGET_LABEL: Record<Target, string> = { main: "主髮色", accent: "挑染", tip: "髮尾漸層" };

// ───── 顏色換算（HSV） ─────
export function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60) + 360) % 360, max ? d / max : 0, max];
}
export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (u: number) => Math.round((u + m) * 255).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}
const newId = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/** 色票資料（全頁共用一份；修改後立即保存） */
let cache: HairPalette | null = null;
function usePalette(): [HairPalette, (p: HairPalette) => void] {
  const [pal, setPal] = useState<HairPalette>(cache ?? EMPTY_PALETTE);
  useEffect(() => { if (!cache) api<HairPalette>("/api/doll/palette").then((p) => { cache = p; setPal(p); }).catch(() => undefined); }, []);
  const save = (p: HairPalette) => {
    const prev = pal;
    cache = p; setPal(p);
    api<HairPalette>("/api/doll/palette", { method: "PUT", json: p }).then((s) => { cache = s; setPal(s); }).catch((e) => { cache = prev; setPal(prev); toast((e as Error).message, "err"); });
  };
  return [pal, save];
}

export function HairColorStudio({ value, onChange }: { value: Appearance; onChange: (v: Appearance) => void }) {
  const [pal, savePal] = usePalette();
  const [target, setTarget] = useState<Target>("main");
  const [editing, setEditing] = useState(false);
  const resolved = resolveHairColors(value.hair_color, value.accent_color);
  const preset = HAIR_COLORS.find((c) => c.id === value.hair_color);
  const current: string | null = target === "main" ? (resolved.main ? rgbToHex(resolved.main) : null) : target === "accent" ? (resolved.accent ? rgbToHex(resolved.accent) : null) : value.tip_color;
  const fallback = target === "main" ? "#644950" : target === "accent" ? "#e0899f" : "#f2a7c3";
  const [hsv, setHsv] = useState<[number, number, number]>(hexToHsv(current ?? fallback));
  const [hexText, setHexText] = useState(current ?? "");
  // 切換目標或外部改變（例如撤銷）時同步滑桿
  const shown = hsvToHex(...hsv);
  useEffect(() => { if (current && current !== shown) setHsv(hexToHsv(current)); setHexText(current ?? ""); }, [current, target]);

  /** 套用一個顏色到目前目標（即時預覽）。拖動期間每 60ms 最多更新一次，避免每一點都重新染色 */
  const latest = useRef<string | null>(null), timer = useRef(0);
  const applyNow = (hex: string | null, t: Target = target) => {
    if (t === "main") onChange({ ...value, hair_color: hex ?? "brown_pink", accent_color: value.accent_color ?? (resolved.accent ? rgbToHex(resolved.accent) : "original") });
    else if (t === "accent") onChange({ ...value, accent_color: hex ?? "original" });
    else onChange({ ...value, tip_color: hex });
  };
  const apply = (hex: string) => {
    latest.current = hex;
    if (timer.current) return;
    timer.current = window.setTimeout(() => { timer.current = 0; if (latest.current) applyNow(latest.current); }, 60);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const remember = (hex: string) => { if (pal.recent[0] === hex) return; savePal({ ...pal, recent: [hex, ...pal.recent.filter((x) => x !== hex)].slice(0, 12) }); };

  // ───── 飽和度／明暗方格 ─────
  const sq = useRef<HTMLDivElement>(null);
  const dragSq = (e: ReactPointerEvent<HTMLDivElement>, phase: "down" | "move" | "up") => {
    if (phase === "down") e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = sq.current!.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    const next: [number, number, number] = [hsv[0], s, v];
    setHsv(next);
    const hex = hsvToHex(...next);
    setHexText(hex);
    apply(hex);
    if (phase === "up") remember(hex);
  };
  const setHue = (h: number, done = false) => { const next: [number, number, number] = [h, hsv[1], hsv[2]]; setHsv(next); const hex = hsvToHex(...next); setHexText(hex); apply(hex); if (done) remember(hex); };

  const saveColor = () => {
    const hex = current ?? shown;
    const name = prompt("色票名稱（例如：奶茶啡、霧面紫、黑櫻粉）", "")?.trim();
    if (!name) return;
    savePal({ ...pal, colors: [...pal.colors, { id: newId(), name: name.slice(0, 20), hex }] });
  };
  const editColor = (c: PaletteColor) => {
    const name = prompt(`修改「${c.name}」的名稱（清空＝刪除）；按「取消」保持不變`, c.name);
    if (name === null) return;
    if (!name.trim()) { if (confirm(`刪除色票「${c.name}」？`)) savePal({ ...pal, colors: pal.colors.filter((x) => x.id !== c.id) }); return; }
    const useCurrent = current && current !== c.hex && confirm(`同時把「${name.trim()}」的顏色改為目前的 ${current}？`);
    savePal({ ...pal, colors: pal.colors.map((x) => (x.id === c.id ? { ...x, name: name.trim().slice(0, 20), hex: useCurrent ? current! : x.hex } : x)) });
  };
  const saveCombo = () => {
    const name = prompt("髮色組合名稱（例如：黑粉挑染、紫粉漸層）", "")?.trim();
    if (!name) return;
    const combo: HairCombo = { id: newId(), name: name.slice(0, 20), main: value.hair_color, accent: value.accent_color, tip: value.tip_color };
    savePal({ ...pal, combos: [...pal.combos, combo] });
    toast(`已保存髮色組合「${combo.name}」`);
  };
  const applyCombo = (c: HairCombo) => onChange({ ...value, hair_color: c.main ?? "brown_pink", accent_color: c.accent, tip_color: c.tip });
  const comboSwatch = (c: HairCombo) => {
    const r = resolveHairColors(c.main, c.accent), m = r.main ? rgbToHex(r.main) : "#644950", a = r.accent ? rgbToHex(r.accent) : m;
    return `linear-gradient(135deg, ${m} 50%, ${a} 50%${c.tip ? `, ${a} 72%, ${c.tip} 72%` : ""})`;
  };

  return (
    <div data-testid="hair-color-studio">
      {/* 內置配色＋自己保存的完整組合 */}
      <div className="flex items-center justify-between pb-1 text-[11.5px]"><span className="text-mauve">髮色組合（所有髮型共用）</span><span className="text-gold-soft">{preset?.label ?? pal.combos.find((c) => c.main === value.hair_color && c.accent === value.accent_color && c.tip === value.tip_color)?.name ?? "自訂"}</span></div>
      <div className="scrollbar-none -mx-3 flex gap-1.5 overflow-x-auto px-3 pb-1" data-testid="hair-colors">
        {HAIR_COLORS.map((c) => {
          const on = preset?.id === c.id && !value.tip_color;
          return <button key={c.id} type="button" data-color={c.id} aria-label={c.label} aria-pressed={on} onClick={() => onChange({ ...value, hair_color: c.id, accent_color: null, tip_color: null })} className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-full border ${on ? "border-gold-soft outline-2 outline-offset-1 outline-gold-soft" : "border-white/40"}`} style={{ background: `linear-gradient(135deg, ${c.swatch[0]} 58%, ${c.swatch[1]} 58%)` }}>{on && <span className="text-[12px] text-white drop-shadow">✓</span>}</button>;
        })}
        {pal.combos.map((c) => (
          <button key={c.id} type="button" data-combo={c.id} onClick={() => applyCombo(c)} onContextMenu={(e) => { e.preventDefault(); if (confirm(`刪除髮色組合「${c.name}」？`)) savePal({ ...pal, combos: pal.combos.filter((x) => x.id !== c.id) }); }} className="flex shrink-0 flex-col items-center">
            <span className="h-9 w-9 rounded-full border border-white/40" style={{ background: comboSwatch(c) }} />
            <span className="max-w-12 truncate text-[9.5px] text-cream/80">{c.name}</span>
          </button>
        ))}
        <button type="button" data-testid="combo-save" onClick={saveCombo} className="grid h-9 shrink-0 place-items-center rounded-full border border-dashed border-gold/70 px-2.5 text-[11px] text-gold-soft">＋保存組合</button>
      </div>

      {/* 調色目標 */}
      <div className="mt-1.5 grid grid-cols-3 gap-1.5" data-testid="color-targets">
        {(["main", "accent", "tip"] as Target[]).map((t) => {
          const hex = t === "main" ? (resolved.main ? rgbToHex(resolved.main) : null) : t === "accent" ? (resolved.accent ? rgbToHex(resolved.accent) : null) : value.tip_color;
          return (
            <button key={t} type="button" data-target={t} aria-pressed={target === t} onClick={() => setTarget(t)} className={`flex items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left ${target === t ? "chip-on" : "chip"}`}>
              <span className="h-6 w-6 shrink-0 rounded-lg border border-white/50" style={{ background: hex ?? `repeating-linear-gradient(45deg, ${t === "tip" ? "#f2a7c3" : "#7a5a62"} 0 4px, transparent 4px 8px)` }} />
              <span className="min-w-0 leading-tight"><span className="block text-[11px] opacity-80">{TARGET_LABEL[t]}</span><span className="block truncate text-[11.5px]">{hex ?? "原色"}</span></span>
            </button>
          );
        })}
      </div>

      {/* 滑動調色：飽和度／明暗方格＋色相 */}
      <div className="mt-2 flex gap-2.5">
        <div ref={sq} data-testid="color-square" className="relative h-[92px] flex-1 touch-none overflow-hidden rounded-xl" style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv[0]} 100% 50%))` }}
          onPointerDown={(e) => dragSq(e, "down")} onPointerMove={(e) => dragSq(e, "move")} onPointerUp={(e) => dragSq(e, "up")}>
          <span className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: shown }} />
        </div>
        <div className="flex w-[7.2rem] shrink-0 flex-col justify-between gap-1.5">
          <input value={hexText} onChange={(e) => { const t = e.target.value.trim(); setHexText(t); if (/^#[0-9a-f]{6}$/i.test(t)) { setHsv(hexToHsv(t.toLowerCase())); applyNow(t.toLowerCase()); } }} onBlur={() => { if (/^#[0-9a-f]{6}$/i.test(hexText)) remember(hexText.toLowerCase()); }} aria-label="HEX 色碼" data-testid="color-hex" placeholder="#rrggbb" className="h-8 w-full rounded-full bg-white px-3 text-[12.5px] text-ink ring-1 ring-gold focus:outline-none" />
          <button type="button" onClick={() => applyNow(null)} className="chip h-8 rounded-full text-[11.5px]">{target === "tip" ? "不用髮尾漸層" : "回復原色"}</button>
          <button type="button" data-testid="swatch-save" onClick={saveColor} className="chip flex h-8 items-center justify-center gap-1 rounded-full text-[11.5px]"><IconPlus className="text-[10px]" />存為色票</button>
        </div>
      </div>
      <input type="range" aria-label="色相" data-testid="color-hue" min={0} max={359} value={Math.round(hsv[0])} onChange={(e) => setHue(Number(e.target.value))} onPointerUp={() => remember(shown)} className="hue-slider mt-2 w-full" style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)", borderRadius: 999, height: 14 }} />

      {/* 自訂色票及最近使用 */}
      <div className="mt-2 flex items-center justify-between text-[11.5px]"><span className="text-mauve">我的色票（輕按＝套用到「{TARGET_LABEL[target]}」）</span><button type="button" aria-pressed={editing} onClick={() => setEditing(!editing)} className={`rounded-full px-2 py-0.5 text-[11px] ${editing ? "chip-on" : "chip"}`}>{editing ? "完成" : "編輯"}</button></div>
      <div className="scrollbar-none -mx-3 mt-1 flex gap-2 overflow-x-auto px-3 pb-1" data-testid="my-swatches">
        {pal.colors.length === 0 && <span className="text-[11px] text-mauve">未有色票：調好顏色後按「存為色票」</span>}
        {pal.colors.map((c) => (
          <button key={c.id} type="button" data-swatch={c.id} onClick={() => (editing ? editColor(c) : (applyNow(c.hex), remember(c.hex)))} className="relative flex w-12 shrink-0 flex-col items-center">
            <span className="h-8 w-8 rounded-full border border-white/50" style={{ background: c.hex }} />
            <span className="w-full truncate text-center text-[9.5px] text-cream/85">{c.name}</span>
            {editing && <span className="absolute -right-0.5 -top-0.5 grid h-4 w-4 place-items-center rounded-full bg-ink text-[8px] text-gold-soft"><IconTrash /></span>}
          </button>
        ))}
      </div>
      {pal.recent.length > 0 && (
        <div className="mt-1 flex items-center gap-1.5" data-testid="recent-colors">
          <span className="shrink-0 text-[10.5px] text-mauve">最近</span>
          <div className="scrollbar-none flex gap-1.5 overflow-x-auto">{pal.recent.map((h) => <button key={h} type="button" aria-label={h} onClick={() => applyNow(h)} className="h-6 w-6 shrink-0 rounded-full border border-white/50" style={{ background: h }} />)}</div>
        </div>
      )}
      {editing && pal.combos.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">{pal.combos.map((c) => <button key={c.id} type="button" onClick={() => { if (confirm(`刪除髮色組合「${c.name}」？`)) savePal({ ...pal, combos: pal.combos.filter((x) => x.id !== c.id) }); }} className="chip rounded-full px-2.5 py-1 text-[11px]">刪除組合「{c.name}」</button>)}</div>
      )}
    </div>
  );
}
