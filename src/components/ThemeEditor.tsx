import { CSSProperties, ReactNode, useEffect, useMemo, useState } from "react";
import { AppSettings, api } from "../api";
import {
  ALL_TOKENS, DEFAULT_THEME_ID, MAX_CUSTOM_THEMES, THEME_GROUPS, THEME_PRESETS, TOKEN_INFO, ThemeDef, ThemeGroup, ThemeSettings, ThemeToken,
  activeTheme, autoFixText, cloneTheme, contrast, customLimitError, hexToHsl, hslToHex, isBasic, normalizeThemeSettings, readability, resetToken, resolveColors, setToken, themeData,
} from "../../shared/theme";
import { localTheme, restoreTheme, storeTheme, themeStyle, trialTheme } from "../theme";
import { Donut, Bars } from "./charts";
import { IconCheck, IconChevronDown, IconCopy, IconCrown, IconDress, IconExpand, IconGear, IconHeart, IconHome, IconPlus, IconRotate, IconSave, IconArm, IconSearch, IconUndo } from "./icons";
import { Button, Chips, Sheet, getSettingsCache, setSettingsCache, toast } from "./ui";

/**
 * 介面顏色（Phase 3.8A.2）
 * - 我的主題（＋新增）／預設主題；自訂主題可編輯（保留原 ID）、改名、複製（新 ID）、套用、刪除。
 * - 編輯器：色票按群組展開／收起，基本＋進階；色彩選擇器、彩虹色相滑桿、按目前顏色的飽和度／明度漸層、HEX、恢復單項、複製其他顏色、自動衍生。
 * - 跨頁面即時預覽：草稿只套用在預覽容器（不改全站）；可切換頁面、放大全頁、或「套用到整個 App 試用」。保存後才正式更新，取消完整恢復。
 * 只改變介面，不修改任何衣物圖片。
 */
export function ThemeEditor() {
  const [settings, setSettings] = useState<ThemeSettings>(() => localTheme());
  const [edit, setEdit] = useState<{ theme: ThemeDef; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const current = activeTheme(settings);
  // 離開頁面：恢復已保存的主題（試用中也一併結束）
  useEffect(() => () => restoreTheme(), []);
  const issues = useMemo(() => readability(resolveColors(current)), [current]);

  async function persist(next: ThemeSettings, msg: string) {
    setBusy(true);
    setSettings(next); storeTheme(next); restoreTheme();
    try {
      const base = getSettingsCache()?.theme?.updated_at;
      const st = await api<AppSettings>("/api/settings", { method: "PUT", json: { theme: next, ...(base ? { theme_base: base } : {}) } });
      const saved = normalizeThemeSettings(st.theme);
      storeTheme(saved); setSettings(saved); setSettingsCache(st); restoreTheme();
      toast(msg);
      return true;
    } catch (e) {
      toast((e as Error).message + "（已在這部手機套用，稍後再保存）", "err");
      return false;
    } finally { setBusy(false); }
  }
  const choose = (id: string) => void persist({ ...settings, active: id }, "已切換主題");
  const startNew = (from: ThemeDef, name?: string) => {
    const err = customLimitError(settings);
    if (err) { toast(err, "err"); return; }
    setAdding(false);
    setEdit({ theme: cloneTheme(from, name), isNew: true });
  };
  const duplicate = (t: ThemeDef) => {
    const err = customLimitError(settings);
    if (err) { toast(err, "err"); return; }
    void persist({ ...settings, custom: [...settings.custom, cloneTheme(t)] }, "已複製主題");
  };
  const remove = (t: ThemeDef) => {
    if (!confirm(`刪除主題「${t.name}」？`)) return;
    const custom = settings.custom.filter((c) => c.id !== t.id);
    // 刪除使用中的主題：改用它的來源預設主題（沒有則用玫瑰桑紫）
    const active = settings.active === t.id ? (t.base && THEME_PRESETS.some((p) => p.id === t.base) ? t.base : DEFAULT_THEME_ID) : settings.active;
    void persist({ ...settings, custom, active }, settings.active === t.id ? `已刪除，改用「${activeTheme({ ...settings, custom, active }).name}」` : "已刪除主題");
  };

  if (edit) {
    return <Editor key={edit.theme.id} initial={edit.theme} isNew={edit.isNew} busy={busy} onCancel={() => { restoreTheme(); setEdit(null); }} onSave={async (t) => {
      const exists = settings.custom.some((c) => c.id === t.id);
      if (!exists) { const err = customLimitError(settings); if (err) { toast(err, "err"); return; } }
      // 編輯已有主題＝原位更新（保留 ID 及次序）；新主題才加入
      const custom = exists ? settings.custom.map((c) => (c.id === t.id ? t : c)) : [...settings.custom, t];
      if (await persist({ ...settings, custom, active: t.id }, exists ? "已保存主題" : "已新增並套用主題")) setEdit(null);
    }} />;
  }
  return (
    <div className="space-y-4" data-testid="theme-list">
      {issues.length > 0 && <p className="rounded-xl bg-danger/30 px-3 py-2 text-[12px] text-danger-ink" role="alert" data-status-color>目前主題的可讀性提示：{issues.map((i) => `${i.pair} ${i.ratio}:1`).join("；")}</p>}
      <section>
        <h3 className="mb-2 flex items-center justify-between font-serif text-[15px] text-gold-soft">我的主題<span className="text-[11px] font-sans text-mauve">{settings.custom.length}／{MAX_CUSTOM_THEMES}</span></h3>
        <ul className="grid grid-cols-2 gap-2">
          <li>
            <button type="button" data-testid="theme-add" disabled={busy} onClick={() => setAdding(true)} className="flex h-full min-h-[118px] w-full flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-gold/60 text-[13px] text-gold-soft">
              <IconPlus className="text-[22px]" />新增主題
            </button>
          </li>
          {settings.custom.map((t) => (
            <ThemeCard key={t.id} t={t} active={settings.active === t.id} busy={busy} onChoose={() => choose(t.id)}>
              <button type="button" onClick={() => setEdit({ theme: t, isNew: false })} className="rounded-full bg-black/30 px-2 py-0.5 text-white" data-testid="theme-edit">編輯</button>
              <button type="button" onClick={() => { const name = prompt("主題名稱", t.name)?.trim(); if (name) void persist({ ...settings, custom: settings.custom.map((c) => (c.id === t.id ? { ...c, name: name.slice(0, 20) } : c)) }, "已改名"); }} className="rounded-full bg-black/30 px-2 py-0.5 text-white" data-testid="theme-rename">改名</button>
              <button type="button" onClick={() => duplicate(t)} className="rounded-full bg-black/30 px-2 py-0.5 text-white" data-testid="theme-duplicate">複製</button>
              <button type="button" onClick={() => remove(t)} className="rounded-full bg-black/30 px-2 py-0.5 text-[#ffd3df]" data-status-color data-testid="theme-delete">刪除</button>
            </ThemeCard>
          ))}
        </ul>
        {settings.custom.length === 0 && <p className="mt-1.5 text-[11.5px] text-mauve">按「＋ 新增主題」，可以由目前主題、任何預設主題或全新主題開始。</p>}
      </section>
      <section>
        <h3 className="mb-2 font-serif text-[15px] text-gold-soft">預設主題</h3>
        <ul className="grid grid-cols-2 gap-2">
          {THEME_PRESETS.map((t) => (
            <ThemeCard key={t.id} t={t} active={settings.active === t.id} busy={busy} onChoose={() => choose(t.id)} preset>
              <button type="button" onClick={() => startNew(t)} className="rounded-full bg-black/30 px-2 py-0.5 text-white" data-testid="theme-customize">以此自訂</button>
            </ThemeCard>
          ))}
        </ul>
      </section>
      <Button variant="ghost" data-testid="theme-reset" onClick={() => void persist({ ...settings, active: DEFAULT_THEME_ID }, "已還原預設主題")}>還原預設（玫瑰桑紫）</Button>
      <p className="text-[11px] text-mauve">主題保存在伺服器，並在這部手機保存一份，開啟 App 時立即套用。主題只改變介面，不會修改衣物圖片、人物素材或已保存的造型。</p>
      {adding && (
        <Sheet title="新增主題" onClose={() => setAdding(false)}>
          <div className="space-y-2" data-testid="theme-add-sheet">
            <button type="button" data-testid="theme-add-current" onClick={() => startNew(current, current.name + "（新）")} className="chip flex w-full items-center gap-3 rounded-2xl p-3 text-left">
              <Swatches t={current} /><span><b className="block text-[14px]">從目前主題開始</b><span className="text-[11.5px] text-mauve">{current.name}</span></span>
            </button>
            <p className="pt-1 text-[12px] text-mauve">從預設主題開始</p>
            <div className="grid grid-cols-2 gap-2">
              {THEME_PRESETS.map((p) => <button key={p.id} type="button" data-add-from={p.id} onClick={() => startNew(p)} className="chip flex items-center gap-2 rounded-2xl p-2 text-left text-[12.5px]"><Swatches t={p} small />{p.name}</button>)}
            </div>
            <button type="button" data-testid="theme-add-blank" onClick={() => startNew(THEME_PRESETS[0], "新主題")} className="chip flex w-full items-center gap-3 rounded-2xl p-3 text-left">
              <IconPlus className="text-[18px]" /><span><b className="block text-[14px]">建立新的自訂主題</b><span className="text-[11.5px] text-mauve">以基本配色開始，再逐項設定</span></span>
            </button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function Swatches({ t, small }: { t: ThemeDef; small?: boolean }) {
  const c = resolveColors(t);
  return <span data-color-swatch className={`flex shrink-0 overflow-hidden rounded-full ring-1 ring-black/20 ${small ? "h-5 w-10" : "h-8 w-14"}`}>{(["bg", "card", "primary", "title", "image"] as ThemeToken[]).map((k) => <span key={k} className="flex-1" style={{ background: c[k] }} />)}</span>;
}

/** 主題卡：以該主題自身的顏色繪畫（只用 inline 色值，不受目前主題影響） */
function ThemeCard({ t, active, busy, onChoose, preset, children }: { t: ThemeDef; active: boolean; busy: boolean; onChoose: () => void; preset?: boolean; children: ReactNode }) {
  const c = resolveColors(t);
  return (
    <li>
      <div className="rounded-2xl p-2" data-color-swatch style={{ background: c.bg, border: `1px solid ${active ? c.border : c.border + "40"}` }} data-theme-card={preset ? t.id : undefined} data-custom-card={preset ? undefined : t.id} data-active={active ? "1" : "0"}>
        <button type="button" disabled={busy} onClick={onChoose} className="block w-full text-left" aria-pressed={active} data-testid="theme-apply">
          <span className="block rounded-xl px-2 py-1.5 text-[12px]" style={{ background: c.header, color: c.title }}>{t.name}</span>
          <span className="mt-1.5 flex gap-1">{(["card", "primary", "selected", "ribbon", "image"] as ThemeToken[]).map((k) => <span key={k} className="h-4 flex-1 rounded" style={{ background: c[k] }} />)}</span>
          <span className="mt-1 block text-[10.5px]" style={{ color: c.text2 }}>{preset ? "預設主題" : "自訂主題"}{active ? "｜使用中" : ""}</span>
        </button>
        <div className="mt-1 flex flex-wrap gap-1 text-[11px]">{children}</div>
      </div>
    </li>
  );
}

// ───────────── 編輯器 ─────────────
function Editor({ initial, isNew, busy, onCancel, onSave }: { initial: ThemeDef; isNew: boolean; busy: boolean; onCancel: () => void; onSave: (t: ThemeDef) => void }) {
  const [t, setT] = useState<ThemeDef>(initial);
  const [token, setTok] = useState<ThemeToken>("bg");
  const [advanced, setAdvanced] = useState(false);
  const [open, setOpen] = useState<Set<ThemeGroup>>(() => new Set<ThemeGroup>(["base", "text"]));
  const [trial, setTrial] = useState(false);
  const [history, setHistory] = useState<ThemeDef[]>([]);
  const colors = useMemo(() => resolveColors(t), [t]);
  const issues = useMemo(() => readability(colors), [colors]);
  // 「套用到整個 App 試用」：草稿暫時套用到全站；關閉、取消或離開時恢復正式主題
  useEffect(() => { if (trial) trialTheme(t); else restoreTheme(); }, [trial, t]);
  const update = (next: ThemeDef) => { setHistory((h) => [...h.slice(-30), t]); setT(next); };
  const setColor = (k: ThemeToken, hex: string) => update(setToken(t, k, hex));
  const tokensIn = (g: ThemeGroup) => ALL_TOKENS.filter((k) => TOKEN_INFO[k].group === g && (advanced || isBasic(k)));
  const overridden = (k: ThemeToken) => !isBasic(k) && !!t.adv?.[k];

  return (
    <div className="space-y-3" data-testid="theme-editor" data-editing={t.id} data-new={isNew ? "1" : "0"}>
      <section className="frame p-3">
        <label className="flex items-center gap-2 text-[13px]">名稱<input value={t.name} maxLength={20} onChange={(e) => setT({ ...t, name: e.target.value })} className="field h-9 flex-1 rounded-full px-3 text-[15px]" data-testid="theme-name" /></label>
        <p className="mt-1.5 text-[11px] text-mauve">{isNew ? "新主題：保存後加入「我的主題」。" : "編輯已有主題：保存會更新這個主題，不會另外建立新主題。"}</p>
      </section>

      <ThemePreview theme={t} trial={trial} onTrial={setTrial} />

      <section className="frame p-3" data-testid="theme-tokens">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="flex-1 font-serif text-[14px] text-gold-soft">顏色</h3>
          <div className="flex rounded-full p-0.5 text-[12px] chip" role="group" aria-label="顯示">
            <button type="button" aria-pressed={!advanced} onClick={() => setAdvanced(false)} className={`rounded-full px-2.5 py-1 ${!advanced ? "chip-on" : ""}`} data-testid="theme-basic">基本設定</button>
            <button type="button" aria-pressed={advanced} onClick={() => { setAdvanced(true); setOpen(new Set(THEME_GROUPS.map((g) => g[0]))); }} className={`rounded-full px-2.5 py-1 ${advanced ? "chip-on" : ""}`} data-testid="theme-advanced">進階設定</button>
          </div>
          <button type="button" aria-label="復原上一步" disabled={!history.length} onClick={() => { setT(history[history.length - 1]); setHistory((h) => h.slice(0, -1)); }} className="chip grid h-8 w-8 place-items-center rounded-full disabled:opacity-40"><IconUndo /></button>
        </div>
        {THEME_GROUPS.map(([g, label]) => {
          const list = tokensIn(g);
          if (!list.length) return null;
          const isOpen = open.has(g);
          return (
            <div key={g} className="border-t border-gold/20 py-1.5 first-of-type:border-t-0" data-group={g}>
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; })} className="flex w-full items-center gap-2 py-1 text-left text-[13px]">
                <span className="flex -space-x-1.5">{list.slice(0, 5).map((k) => <span key={k} className="h-4 w-4 rounded-full ring-1 ring-black/25" style={{ background: colors[k] }} />)}</span>
                <span className="flex-1">{label}</span><span className="text-[11px] text-mauve">{list.length} 項</span>
                <IconChevronDown className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>
              {isOpen && (
                <div className="mt-1 grid grid-cols-2 gap-1.5">
                  {list.map((k) => (
                    <button key={k} type="button" data-token={k} aria-pressed={token === k} onClick={() => setTok(k)} className={`flex items-center gap-2 rounded-2xl px-2 py-1.5 text-left text-[12px] ${token === k ? "chip-on" : "chip"}`}>
                      <span className="h-6 w-6 shrink-0 rounded-full ring-1 ring-black/20" style={{ background: colors[k] }} />
                      <span className="min-w-0 flex-1 truncate">{TOKEN_INFO[k].label}</span>
                      {!isBasic(k) && <span className="text-[9.5px] opacity-70">{overridden(k) ? "自訂" : "自動"}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </section>

      <ColorPanel k={token} t={t} colors={colors} onColor={setColor} onReset={() => update(resetToken(t, token))} onCopy={(from) => setColor(token, colors[from])} />

      <section className="frame space-y-2 p-3 text-[12.5px]" data-testid="theme-readability">
        <h3 className="font-serif text-[14px] text-gold-soft">可讀性檢查</h3>
        {issues.length === 0 ? <p className="text-ok-ink" data-testid="theme-ok">所有主要文字、按鈕、底部選單及輸入框的對比足夠。</p> : (
          <ul data-status-color className="space-y-1 rounded-xl bg-danger/25 px-3 py-2 text-[12px] text-danger-ink" role="alert" data-testid="theme-issues">
            {issues.map((i) => (
              <li key={i.pair} data-issue={i.fg + "/" + i.bg}>
                {i.pair}：{i.ratio}:1（建議 ≥ {i.min}:1）{i.sameColor && <b>｜你把文字及背景設定成相同顏色</b>}
                <button type="button" className="ml-1 underline" onClick={() => setTok(i.fg)}>調整</button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" data-testid="theme-auto-text" disabled={!issues.length} onClick={() => {
            const r = autoFixText(t);
            if (!r.changed.length) { toast("沒有可以自動修正的文字顏色", "err"); return; }
            update(r.theme);
            toast(`已調整：${r.changed.map((k) => TOKEN_INFO[k].label).join("、")}（可按復原）`);
          }}>自動調整文字顏色</Button>
          <span className="text-[11px] text-mauve">只修改對比不足的文字色票；不會自動改動其他顏色。</span>
        </div>
      </section>

      <section className="frame space-y-2.5 p-3 text-[12.5px]" data-testid="theme-decor">
        <h3 className="font-serif text-[14px] text-gold-soft">介面裝飾</h3>
        <label className="flex items-center gap-2">卡片圓角<input type="range" min={0} max={32} value={t.decor.radius} onChange={(e) => setT({ ...t, decor: { ...t.decor, radius: Number(e.target.value) } })} className="flex-1" />{t.decor.radius}px</label>
        <label className="flex items-center gap-2">邊框粗幼<input type="range" min={0} max={4} value={t.decor.border} onChange={(e) => setT({ ...t, decor: { ...t.decor, border: Number(e.target.value) } })} className="flex-1" />{t.decor.border}px</label>
        <Seg label="衣物圖片框" value={t.decor.frame} opts={[["arch", "拱形"], ["round", "圓角"]]} on={(v) => setT({ ...t, decor: { ...t.decor, frame: v as "arch" | "round" } })} />
        <Seg label="背景" value={t.decor.pattern} opts={[["stripe", "條紋"], ["dots", "圓點"], ["plain", "純色"]]} on={(v) => setT({ ...t, decor: { ...t.decor, pattern: v as "stripe" } })} />
        <Seg label="版面" value={t.decor.density} opts={[["compact", "緊湊"], ["standard", "標準"], ["loose", "寬鬆"]]} on={(v) => setT({ ...t, decor: { ...t.decor, density: v as "standard" } })} />
        <label className="flex items-center justify-between gap-2">蕾絲裝飾<button type="button" role="switch" aria-checked={t.decor.lace} data-testid="theme-lace" onClick={() => setT({ ...t, decor: { ...t.decor, lace: !t.decor.lace } })} className="switch" /></label>
        <p className="text-[11px] text-mauve">錯誤、成功、警告及遮罩的「隱藏／身後」標示保留固定顏色，確保可以辨識。</p>
      </section>

      <div className="sticky-spacer" aria-hidden />
      <div className="sticky-actions frame flex gap-2 p-2" data-testid="theme-actions">
        <Button variant="ghost" onClick={onCancel} disabled={busy} data-testid="theme-cancel">取消</Button>
        <Button className="flex-1" data-testid="theme-save" disabled={busy || !t.name.trim()} onClick={() => onSave({ ...t, name: t.name.trim() })}><IconCheck />{isNew ? "保存並套用" : "保存主題"}</Button>
      </div>
    </div>
  );
}

/** 色彩面板：圓形預覽、選擇器、彩虹色相、按目前顏色的飽和度／明度漸層、HEX、恢復預設、複製其他顏色 */
function ColorPanel({ k, t, colors, onColor, onReset, onCopy }: { k: ThemeToken; t: ThemeDef; colors: Record<ThemeToken, string>; onColor: (k: ThemeToken, hex: string) => void; onReset: () => void; onCopy: (from: ThemeToken) => void }) {
  const hex = colors[k];
  const [h, s, l] = hexToHsl(hex);
  const [text, setText] = useState(hex);
  useEffect(() => setText(hex), [hex]);
  const auto = !isBasic(k) && !t.adv?.[k];
  const satGrad = `linear-gradient(90deg, ${hslToHex(h, 0, l)}, ${hslToHex(h, 100, l)})`;
  const lightGrad = `linear-gradient(90deg, #000, ${hslToHex(h, s, 50)}, #fff)`;
  return (
    <section className="frame space-y-2.5 p-3 text-[12.5px]" data-testid="theme-color-panel" data-token-edit={k}>
      <div className="flex items-center gap-3">
        <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full ring-2 ring-gold/60" style={{ background: hex }} data-testid="theme-circle">
          <input type="color" aria-label="色彩選擇器" value={hex} onChange={(e) => onColor(k, e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{TOKEN_INFO[k].label}</p>
          <p className="text-[11px] text-mauve">{THEME_GROUPS.find((g) => g[0] === TOKEN_INFO[k].group)?.[1]}｜{isBasic(k) ? "基本色" : auto ? "自動衍生（由基本色計算）" : "已自訂"}</p>
        </div>
        <input aria-label="HEX 色碼" data-testid="theme-hex" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => { const v = text.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) onColor(k, v.startsWith("#") ? v : "#" + v); else setText(hex); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="field h-9 w-[6.6rem] rounded-full px-3 font-mono text-[14px]" />
      </div>
      <label className="flex items-center gap-2"><span className="w-12 shrink-0">色相</span><input type="range" min={0} max={359} value={h} onChange={(e) => onColor(k, hslToHex(Number(e.target.value), s, l))} className="hue-track flex-1" style={{ "--thumb": hslToHex(h, 100, 50) } as CSSProperties} data-testid="theme-hue" /><span className="w-8 text-right tabular-nums">{h}°</span></label>
      <label className="flex items-center gap-2"><span className="w-12 shrink-0">飽和度</span><input type="range" min={0} max={100} value={s} onChange={(e) => onColor(k, hslToHex(h, Number(e.target.value), l))} className="grad-track flex-1" style={{ "--grad": satGrad, "--thumb": hex } as CSSProperties} data-testid="theme-sat" /><span className="w-8 text-right tabular-nums">{s}%</span></label>
      <label className="flex items-center gap-2"><span className="w-12 shrink-0">明度</span><input type="range" min={0} max={100} value={l} onChange={(e) => onColor(k, hslToHex(h, s, Number(e.target.value)))} className="grad-track flex-1" style={{ "--grad": lightGrad, "--thumb": hex } as CSSProperties} data-testid="theme-light" /><span className="w-8 text-right tabular-nums">{l}%</span></label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onReset} className="chip flex h-8 items-center gap-1 rounded-full px-3" data-testid="theme-token-reset"><IconRotate />{isBasic(k) ? "恢復預設顏色" : "改回自動衍生"}</button>
        <label className="chip flex h-8 items-center gap-1 rounded-full pl-3 pr-1"><IconCopy />複製
          <select aria-label="複製其他顏色" data-testid="theme-copy-from" value="" onChange={(e) => { if (e.target.value) onCopy(e.target.value as ThemeToken); }} className="h-7 max-w-[8.5rem] rounded-full bg-transparent text-[12px]">
            <option value="">其他顏色…</option>
            {ALL_TOKENS.filter((x) => x !== k).map((x) => <option key={x} value={x}>{TOKEN_INFO[x].label}</option>)}
          </select>
        </label>
        <span className="text-[11px] text-mauve">與主背景對比 {contrast(hex, colors.bg).toFixed(1)}:1</span>
      </div>
    </section>
  );
}

function Seg({ label, value, opts, on }: { label: string; value: string; opts: [string, string][]; on: (v: string) => void }) {
  return <div className="flex items-center gap-1.5">{label}{opts.map(([k, l]) => <button key={k} type="button" aria-pressed={value === k} onClick={() => on(k)} className={`h-7 rounded-full px-2.5 ${value === k ? "chip-on" : "chip"}`}>{l}</button>)}</div>;
}

// ───────────── 跨頁面即時預覽 ─────────────
const PAGES = [["home", "首頁"], ["wardrobe", "衣櫃"], ["upload", "上傳"], ["studio", "穿搭工作室"], ["dress", "角色換裝"], ["settings", "設定"]] as const;
type PreviewPage = (typeof PAGES)[number][0];

/**
 * 預覽容器：以草稿主題的 CSS 變數套用在這個容器（不影響全站），內容使用正式 App 的 CSS class 及共用元件（Button、Chips、圖表），
 * 只用靜態示範資料，不發送任何 API 或圖片請求。
 */
export function ThemePreview({ theme, trial, onTrial }: { theme: ThemeDef; trial: boolean; onTrial: (v: boolean) => void }) {
  const [page, setPage] = useState<PreviewPage>("home");
  const [full, setFull] = useState(false);
  const data = themeData(theme);
  const scope = (
    <div className="theme-scope relative overflow-hidden rounded-2xl ring-1 ring-gold/40" style={themeStyle(theme) as CSSProperties} data-testid="theme-preview" data-preview-page={page} {...Object.fromEntries(Object.entries(data).map(([k, v]) => ["data-" + k, v]))}>
      <PreviewShell page={page} />
    </div>
  );
  return (
    <section className="frame space-y-2 p-3" data-testid="theme-preview-panel">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-serif text-[14px] text-gold-soft">即時預覽</h3>
        <button type="button" onClick={() => setFull(true)} className="chip flex h-8 items-center gap-1 rounded-full px-3 text-[12px]" data-testid="theme-preview-full"><IconExpand />全頁</button>
      </div>
      <div className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1" role="tablist">
        {PAGES.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={page === k} data-preview-tab={k} onClick={() => setPage(k)} className={`h-8 shrink-0 rounded-full px-3 text-[12px] ${page === k ? "chip-on" : "chip"}`}>{l}</button>)}
      </div>
      {!full && scope}
      <label className="flex items-center justify-between gap-2 text-[12.5px]">
        <span>同時套用到整個 App 試用<span className="block text-[11px] text-mauve">未保存前可隨時關閉；取消編輯會恢復原本主題</span></span>
        <button type="button" role="switch" aria-checked={trial} onClick={() => onTrial(!trial)} className="switch" data-testid="theme-trial" />
      </label>
      {full && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]" role="dialog" aria-label="全頁預覽" data-testid="theme-preview-fullscreen">
          <div className="mb-2 flex items-center gap-1 overflow-x-auto">
            {PAGES.map(([k, l]) => <button key={k} type="button" aria-selected={page === k} onClick={() => setPage(k)} className={`h-8 shrink-0 rounded-full px-3 text-[12px] ${page === k ? "chip-on" : "chip"}`}>{l}</button>)}
            <button type="button" onClick={() => setFull(false)} className="btn-jewel ml-auto h-8 shrink-0 rounded-full px-3 text-[12px]">關閉</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{scope}</div>
        </div>
      )}
    </section>
  );
}

const DEMO = [
  { name: "黑蕾絲泡袖上衣", cat: "上衣｜古典" }, { name: "紫色菱格 JSK", cat: "JSK｜哥德" }, { name: "女僕套裝", cat: "套裝｜甜美" },
];
function DemoTile({ name, cat, fav }: { name: string; cat: string; fav?: boolean }) {
  return (
    <div className="relative pt-2.5" data-demo-tile>
      <div className="arch arch-base relative aspect-[3/4]">
        <svg viewBox="0 0 60 80" className="absolute inset-0 h-full w-full px-[18%] pb-[12%] pt-[24%]" aria-hidden><path d="M18 8 L42 8 L52 26 L44 30 L44 72 L16 72 L16 30 L8 26 Z" fill="currentColor" opacity={0.28} /></svg>
        <span className="chip-on absolute bottom-2.5 left-1/2 -translate-x-1/2 rounded-full px-2 py-0.5 text-[9px]">已完成</span>
      </div>
      {fav && <span className="absolute right-0 top-0 text-[13px] text-[var(--aw-chart)]"><IconHeart filled /></span>}
      <div className="truncate pt-1 text-center text-[11.5px] font-medium">{name}</div>
      <div className="truncate text-center text-[10px] text-mauve">{cat}</div>
    </div>
  );
}
function PreviewShell({ page }: { page: PreviewPage }) {
  const tabs = [["home", "首頁", IconHome], ["wardrobe", "衣櫃", IconCrown], ["upload", "上傳", IconPlus], ["studio", "穿搭", IconDress], ["settings", "設定", IconGear]] as const;
  const activeTab = page === "dress" ? "studio" : page;
  return (
    <div className="pointer-events-none select-none text-[13px]" inert>
      <div className="lace-b relative z-10 flex h-9 items-center justify-between px-3" style={{ background: "var(--aw-header)" }}>
        <span className="font-serif text-[14px] tracking-[0.14em] text-gold-soft">電子衣櫃</span>
        <span className="btn-dark rounded-full px-3 py-0.5 text-[11px]">編輯</span>
      </div>
      <div className="min-h-[300px] space-y-2.5 p-3 pb-4" style={{ paddingLeft: "var(--aw-pad)", paddingRight: "var(--aw-pad)" }}>
        {page === "home" && <>
          <div className="grid grid-cols-2 gap-2">
            <div className="frame p-2.5 text-center"><div className="font-serif text-[22px] text-gold-soft">128</div><div className="text-[11px] text-mauve">衣物總數</div></div>
            <div className="frame p-2.5"><div className="text-[11px] text-mauve">衣櫃總價</div><div className="font-serif text-[18px] text-gold-soft">$42,800</div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream/10"><div className="h-full w-2/3" style={{ background: "var(--aw-chart)" }} /></div></div>
          </div>
          <div className="flex justify-center"><span className="ribbon orn font-serif text-[12px]">最近加入</span></div>
          <div className="grid grid-cols-3 gap-2">{DEMO.map((d, i) => <DemoTile key={d.name} {...d} fav={i === 0} />)}</div>
          <div className="frame flex items-center gap-3 p-2.5"><Donut size={70} thickness={9} segs={[{ name: "JSK", n: 5, color: "var(--aw-chart-1)" }, { name: "OP", n: 3, color: "var(--aw-chart-2)" }, { name: "上衣", n: 2, color: "var(--aw-chart-3)" }, { name: "其他", n: 2, color: "var(--aw-chart-4)" }]}><span className="text-[10px] text-mauve">分類</span></Donut><div className="min-w-0 flex-1"><Bars rows={[{ name: "JSK", n: 5 }, { name: "OP", n: 3 }]} /></div></div>
        </>}
        {page === "wardrobe" && <>
          <div className="relative"><IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--aw-placeholder)]" /><input readOnly placeholder="搜尋衣物…" className="field h-9 w-full rounded-full pl-9 pr-3 text-[13px]" /></div>
          <Chips options={["JSK", "OP", "上衣"] as const} value="JSK" onChange={() => undefined} />
          <div className="grid grid-cols-3 gap-2">{[...DEMO, ...DEMO].map((d, i) => <DemoTile key={i} {...d} fav={i === 2} />)}</div>
        </>}
        {page === "upload" && <>
          <div className="paper p-4 text-center"><p className="font-serif text-[15px]">上傳衣物照片</p><p className="text-[11.5px] text-mauve">可以一次選擇多張</p><span className="btn-jewel mt-2 inline-flex rounded-full px-4 py-1.5 text-[13px]">選擇照片</span></div>
          <div className="frame space-y-2 p-3"><label className="block text-[12px] text-mauve">衣物名稱</label><input readOnly value="白色娃娃領襯衫" className="field h-9 w-full rounded-xl px-3 text-[13px]" /><input readOnly placeholder="品牌（選填）" className="field h-9 w-full rounded-xl px-3 text-[13px]" />
            <div className="flex gap-2"><Button>保存</Button><Button variant="ghost">取消</Button><Button variant="danger">刪除</Button></div></div>
        </>}
        {page === "studio" && <>
          <div className="grid grid-cols-2 gap-2">
            <div className="frame-hot frame p-3"><IconDress className="text-[20px]" /><p className="mt-1 font-serif text-[14px]">衣服配搭</p><p className="text-[11px] text-mauve">平面配搭</p></div>
            <div className="frame p-3"><IconArm className="text-[20px] text-gold-soft" /><p className="mt-1 font-serif text-[14px] text-gold-soft">角色換裝</p><p className="text-[11px] text-mauve">人偶穿衣</p></div>
          </div>
          <div className="flex flex-wrap gap-1.5"><span className="chip rounded-full px-3 py-1 text-[12px]">衣服設定</span><span className="chip rounded-full px-3 py-1 text-[12px]">角色素材</span><span className="chip-on rounded-full px-3 py-1 text-[12px]">我的穿搭</span></div>
          <div className="pop rounded-2xl p-3 text-[12px]">彈出視窗：保存造型？<div className="mt-2 flex gap-2"><span className="btn-jewel rounded-full px-3 py-1">保存</span><span className="btn-dark rounded-full px-3 py-1">取消</span></div></div>
        </>}
        {page === "dress" && <>
          <div className="doll-stage relative h-[230px] overflow-hidden rounded-2xl">
            <svg viewBox="0 0 120 230" className="absolute inset-0 m-auto h-full" aria-hidden>
              <circle cx="60" cy="32" r="16" fill="#f2d6c9" /><path d="M44 52 L76 52 L84 130 L36 130 Z" fill="#3a2b3f" /><path d="M48 130 L56 210 M72 130 L64 210" stroke="#f2d6c9" strokeWidth="7" strokeLinecap="round" />
              <path d="M44 56 L30 110 M76 56 L90 110" className="sv-bone" strokeWidth="2" strokeLinecap="round" /><circle cx="30" cy="110" r="5" style={{ fill: "var(--aw-handle)" }} /><circle cx="90" cy="110" r="4" className="sv-mesh-pt" strokeWidth="1.5" />
            </svg>
            <div className="absolute bottom-2 right-2 flex gap-1.5">{[IconRotate, IconSave, IconArm].map((I, i) => <span key={i} className={`doll-tool grid h-9 w-9 place-items-center rounded-full text-[16px] ${i === 2 ? "doll-tool-on" : ""}`}><I /></span>)}</div>
            <div className="absolute left-2 top-2 flex gap-1.5">{[IconUndo, IconExpand].map((I, i) => <span key={i} className="doll-tool grid h-8 w-8 place-items-center rounded-full text-[14px]"><I /></span>)}</div>
          </div>
          <div className="flex gap-1.5"><span className="chip-on rounded-full px-3 py-1 text-[12px]">衣服</span><span className="chip rounded-full px-3 py-1 text-[12px]">圖層</span><span className="chip rounded-full px-3 py-1 text-[12px]">姿勢</span></div>
          <label className="flex items-center gap-2 text-[12px]">大小<input type="range" readOnly value={60} className="flex-1" /></label>
        </>}
        {page === "settings" && <>
          <div className="frame divide-y divide-gold/20 overflow-hidden">
            {["介面顏色", "主頁布局", "離線衣櫃", "R2 用量及費用"].map((x) => <div key={x} className="flex items-center justify-between px-3 py-2.5"><span>{x}</span><span className="text-[11px] text-mauve">›</span></div>)}
          </div>
          <div className="frame space-y-2 p-3 text-[12px]">
            <label className="flex items-center gap-2"><input type="checkbox" readOnly checked />勾選框</label>
            <label className="flex items-center justify-between">開關<span role="switch" aria-checked="true" className="switch" /></label>
            <label className="flex items-center gap-2">滑桿<input type="range" readOnly value={40} className="flex-1" /></label>
            <a className="text-amethyst-deep underline">連結文字</a>
            <p className="text-[var(--aw-disabled)]">停用狀態文字</p>
            <p className="rounded-lg bg-danger/30 px-2 py-1 text-danger-ink">錯誤提示保持功能色</p>
          </div>
        </>}
      </div>
      <div className="app-tabbar lace-t relative grid grid-cols-5" style={{ background: "var(--aw-nav)" }}>
        {tabs.map(([k, l, I]) => (
          <div key={k} className={`flex flex-col items-center gap-0.5 py-1.5 text-[10px] ${activeTab === k ? "tab-on" : "tab-off"}`}>
            <span className={`grid h-7 w-7 place-items-center rounded-full text-[15px] ${activeTab === k ? "btn-jewel" : ""}`}><I /></span>{l}
          </div>
        ))}
      </div>
    </div>
  );
}
