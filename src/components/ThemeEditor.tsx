import { useEffect, useMemo, useState } from "react";
import { AppSettings, api } from "../api";
import { DEFAULT_DECOR, THEME_PRESETS, THEME_TOKENS, ThemeDef, ThemeSettings, ThemeToken, activeTheme, autoText, contrast, hexToHsl, hslToHex, normalizeThemeSettings, readabilityIssues } from "../../shared/theme";
import { applyTheme, localTheme, storeTheme } from "../theme";
import { Button, getSettingsCache, setSettingsCache, toast } from "./ui";

/**
 * 介面顏色編輯器（Phase 3.8A）：預設主題、自訂顏色（色彩選擇器、色相／飽和度／明度、HEX）、介面裝飾、即時預覽及可讀性檢查。
 * 只改變介面，不會修改衣物圖片。保存到伺服器（app_settings.theme），手機另存快取。
 */
export function ThemeEditor() {
  const [settings, setSettings] = useState<ThemeSettings>(() => localTheme());
  const [edit, setEdit] = useState<ThemeDef | null>(null);
  const [token, setToken] = useState<ThemeToken>("bg");
  const [busy, setBusy] = useState(false);
  const all = [...THEME_PRESETS, ...settings.custom];
  const current = activeTheme(settings);
  // 即時預覽：編輯中的主題；離開頁面時恢復已保存的主題
  useEffect(() => { applyTheme(edit ?? current); }, [edit, current]);
  useEffect(() => () => applyTheme(activeTheme(localTheme())), []);
  const issues = useMemo(() => (edit ? readabilityIssues(edit.colors) : readabilityIssues(current.colors)), [edit, current]);

  async function persist(next: ThemeSettings, msg: string) {
    setBusy(true);
    const prev = settings;
    setSettings(next); storeTheme(next);
    try {
      const base = getSettingsCache()?.theme?.updated_at;
      const st = await api<AppSettings>("/api/settings", { method: "PUT", json: { theme: next, ...(base ? { theme_base: base } : {}) } });
      const saved = normalizeThemeSettings(st.theme);
      storeTheme(saved); setSettings(saved); setSettingsCache(st);
      toast(msg);
      return true;
    } catch (e) {
      // 伺服器未能保存：本機仍然套用，並提示
      toast((e as Error).message + "（已在這部手機套用，稍後再保存）", "err");
      void prev;
      return false;
    } finally { setBusy(false); }
  }
  const choose = (id: string) => void persist({ ...settings, active: id }, "已切換主題");
  const startCustom = (from: ThemeDef) => setEdit({ id: "custom_" + Date.now().toString(36), name: from.builtin ? from.name + "（自訂）" : from.name, colors: { ...from.colors }, decor: { ...from.decor } });
  const setColor = (k: ThemeToken, hex: string) => edit && setEdit({ ...edit, colors: { ...edit.colors, [k]: hex.toLowerCase() } });
  const hsl = edit ? hexToHsl(edit.colors[token]) : [0, 0, 0];

  if (edit) {
    const [h, sat, l] = hsl;
    return (
      <div className="space-y-3" data-testid="theme-editor">
        <section className="frame p-3">
          <label className="flex items-center gap-2 text-[13px]">名稱<input value={edit.name} maxLength={20} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className="field h-9 flex-1 rounded-full px-3 text-[15px]" data-testid="theme-name" /></label>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {THEME_TOKENS.map(([k, label]) => (
              <button key={k} type="button" data-token={k} aria-pressed={token === k} onClick={() => setToken(k)} className={`flex items-center gap-2 rounded-2xl px-2 py-1.5 text-left text-[12px] ${token === k ? "chip-on" : "chip"}`}>
                <span className="h-6 w-6 shrink-0 rounded-full ring-1 ring-black/20" style={{ background: edit.colors[k] }} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="frame space-y-2 p-3 text-[12.5px]" data-testid="theme-color-panel">
          <div className="flex items-center gap-2">
            <input type="color" aria-label="色彩選擇器" value={edit.colors[token]} onChange={(e) => setColor(token, e.target.value)} className="h-10 w-12 rounded-lg bg-transparent" />
            <input aria-label="HEX 色碼" data-testid="theme-hex" defaultValue={edit.colors[token]} key={token + edit.colors[token]} onBlur={(e) => { const v = e.target.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) setColor(token, v.startsWith("#") ? v : "#" + v); else e.target.value = edit.colors[token]; }} className="field h-9 w-28 rounded-full px-3 font-mono text-[14px]" />
            <span className="text-mauve">{THEME_TOKENS.find((t) => t[0] === token)?.[1]}</span>
          </div>
          <label className="flex items-center gap-2">色相<input type="range" min={0} max={359} value={h} onChange={(e) => setColor(token, hslToHex(Number(e.target.value), sat, l))} className="flex-1" /></label>
          <label className="flex items-center gap-2">飽和度<input type="range" min={0} max={100} value={sat} onChange={(e) => setColor(token, hslToHex(h, Number(e.target.value), l))} className="flex-1" /></label>
          <label className="flex items-center gap-2">明度<input type="range" min={0} max={100} value={l} onChange={(e) => setColor(token, hslToHex(h, sat, Number(e.target.value)))} className="flex-1" /></label>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" data-testid="theme-auto-text" onClick={() => setEdit({ ...edit, colors: { ...edit.colors, ...autoText(edit.colors.bg) } })}>自動文字顏色</Button>
            <span className="text-[11px] text-mauve">主要文字對比：{contrast(edit.colors.text, edit.colors.bg).toFixed(1)}:1</span>
          </div>
          {issues.length > 0 && <p className="rounded-xl bg-[#a12c4b]/30 px-3 py-2 text-[12px] text-white" role="alert" data-testid="theme-issues">可讀性提示：{issues.join("；")}</p>}
        </section>
        <section className="frame space-y-2 p-3 text-[12.5px]" data-testid="theme-decor">
          <h3 className="font-serif text-[14px] text-gold-soft">介面裝飾</h3>
          <label className="flex items-center gap-2">卡片圓角<input type="range" min={0} max={32} value={edit.decor.radius} onChange={(e) => setEdit({ ...edit, decor: { ...edit.decor, radius: Number(e.target.value) } })} className="flex-1" />{edit.decor.radius}px</label>
          <label className="flex items-center gap-2">邊框粗幼<input type="range" min={0} max={4} value={edit.decor.border} onChange={(e) => setEdit({ ...edit, decor: { ...edit.decor, border: Number(e.target.value) } })} className="flex-1" />{edit.decor.border}px</label>
          <Seg label="衣物圖片框" value={edit.decor.frame} opts={[["arch", "拱形"], ["round", "圓角"]]} on={(v) => setEdit({ ...edit, decor: { ...edit.decor, frame: v as "arch" | "round" } })} />
          <Seg label="背景" value={edit.decor.pattern} opts={[["stripe", "條紋"], ["dots", "圓點"], ["plain", "純色"]]} on={(v) => setEdit({ ...edit, decor: { ...edit.decor, pattern: v as "stripe" } })} />
          <Seg label="版面" value={edit.decor.density} opts={[["compact", "緊湊"], ["standard", "標準"], ["loose", "寬鬆"]]} on={(v) => setEdit({ ...edit, decor: { ...edit.decor, density: v as "standard" } })} />
          <label className="flex items-center gap-2"><input type="checkbox" checked={edit.decor.lace} onChange={(e) => setEdit({ ...edit, decor: { ...edit.decor, lace: e.target.checked } })} />蕾絲裝飾</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={!!edit.decor.canvas} onChange={(e) => setEdit({ ...edit, decor: { ...edit.decor, canvas: e.target.checked ? "#f3e8f0" : null } })} />角色換裝畫布使用獨立背景{edit.decor.canvas && <input type="color" aria-label="角色畫布背景" value={edit.decor.canvas} onChange={(e) => setEdit({ ...edit, decor: { ...edit.decor, canvas: e.target.value } })} className="h-8 w-10 bg-transparent" />}</label>
          <p className="text-[11px] text-mauve">裝飾只影響介面，不會修改衣物圖片。錯誤、刪除及警告保留獨立的提示顏色。</p>
        </section>
        <div className="sticky bottom-[calc(var(--tabbar-height,4rem)+0.5rem)] flex gap-2">
          <Button variant="ghost" onClick={() => setEdit(null)} disabled={busy}>取消</Button>
          <Button className="flex-1" data-testid="theme-save" disabled={busy || !edit.name.trim()} onClick={async () => { const custom = [...settings.custom.filter((c) => c.id !== edit.id), { ...edit, name: edit.name.trim() }]; if (await persist({ ...settings, custom, active: edit.id }, "已保存自訂主題")) setEdit(null); }}>保存並套用</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="theme-list">
      {issues.length > 0 && <p className="rounded-xl bg-[#a12c4b]/30 px-3 py-2 text-[12px] text-white" role="alert">目前主題的可讀性提示：{issues.join("；")}</p>}
      <ul className="grid grid-cols-2 gap-2">
        {all.map((t) => (
          <li key={t.id}>
            <div className={`rounded-2xl border p-2 ${settings.active === t.id ? "border-gold" : "border-gold/25"}`} style={{ background: t.colors.bg }} data-theme-card={t.id} data-active={settings.active === t.id ? "1" : "0"}>
              <button type="button" disabled={busy} onClick={() => choose(t.id)} className="block w-full text-left" aria-pressed={settings.active === t.id}>
                <span className="block rounded-xl px-2 py-1.5 text-[12px]" style={{ background: t.colors.header, color: t.colors.title }}>{t.name}</span>
                <span className="mt-1.5 flex gap-1">{(["card", "primary", "selected", "title", "image"] as ThemeToken[]).map((k) => <span key={k} className="h-4 flex-1 rounded" style={{ background: t.colors[k] }} />)}</span>
                <span className="mt-1 block text-[10.5px]" style={{ color: t.colors.text2 }}>{t.builtin ? "預設主題" : "自訂主題"}{settings.active === t.id ? "｜使用中" : ""}</span>
              </button>
              <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                <button type="button" onClick={() => startCustom(t)} className="rounded-full bg-black/25 px-2 py-0.5 text-white" data-testid="theme-customize">{t.builtin ? "以此自訂" : "編輯"}</button>
                {!t.builtin && <button type="button" onClick={() => { const name = prompt("主題名稱", t.name)?.trim(); if (name) void persist({ ...settings, custom: settings.custom.map((c) => (c.id === t.id ? { ...c, name: name.slice(0, 20) } : c)) }, "已改名"); }} className="rounded-full bg-black/25 px-2 py-0.5 text-white">改名</button>}
                {!t.builtin && <button type="button" onClick={() => { if (confirm(`刪除主題「${t.name}」？`)) void persist({ ...settings, custom: settings.custom.filter((c) => c.id !== t.id), active: settings.active === t.id ? THEME_PRESETS[0].id : settings.active }, "已刪除主題"); }} className="rounded-full bg-black/25 px-2 py-0.5 text-[#ffd3df]">刪除</button>}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <Button variant="ghost" data-testid="theme-reset" onClick={() => void persist({ ...settings, active: THEME_PRESETS[0].id }, "已還原預設主題")}>還原預設（玫瑰桑紫）</Button>
      <p className="text-[11px] text-mauve">主題保存在伺服器，並在這部手機保存一份，開啟 App 時立即套用。預設裝飾：圓角 {DEFAULT_DECOR.radius}px。</p>
    </div>
  );
}
function Seg({ label, value, opts, on }: { label: string; value: string; opts: [string, string][]; on: (v: string) => void }) {
  return <div className="flex items-center gap-1.5">{label}{opts.map(([k, l]) => <button key={k} type="button" aria-pressed={value === k} onClick={() => on(k)} className={`h-7 rounded-full px-2.5 ${value === k ? "chip-on" : "chip"}`}>{l}</button>)}</div>;
}
