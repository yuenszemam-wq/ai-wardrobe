import { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, AppSettings, api } from "../api";
import {
  ALL_TOKENS, DEFAULT_THEME_ID, MAX_CUSTOM_THEMES, THEME_GROUPS, THEME_PRESETS, TOKEN_INFO, ThemeDef, ThemeGroup, ThemeSettings, ThemeToken,
  activeTheme, autoFixText, cloneTheme, contrast, customLimitError, hexToHsl, hexToRgb, hslToHex, isBasic, normalizeThemeSettings, readability, resetToken, resolveColors, rgbToHex, setToken, themeData,
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
  /** base＝開始編輯時伺服器主題的版本（保存時用來檢查是否已在另一部裝置修改） */
  const [edit, setEdit] = useState<{ theme: ThemeDef; isNew: boolean; base: string | undefined } | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [saveError, setSaveError] = useState<{ msg: string; conflict: boolean } | null>(null);
  const [pending, setPending] = useState(() => { try { return localStorage.getItem("aw:theme-pending") === "1"; } catch { return false; } });
  const markPending = (v: boolean) => { setPending(v); try { if (v) localStorage.setItem("aw:theme-pending", "1"); else localStorage.removeItem("aw:theme-pending"); } catch { /* ignore */ } };
  const current = activeTheme(settings);
  // 離開頁面：恢復已保存的主題（試用中也一併結束）
  useEffect(() => () => restoreTheme(), []);
  const issues = useMemo(() => readability(resolveColors(current)), [current]);
  /** 空字串＝開始時伺服器未有主題（伺服器若已有主題會回報衝突） */
  const serverBase = (): string => getSettingsCache()?.theme?.updated_at ?? settings.updated_at ?? "";

  async function send(next: ThemeSettings, base: string | undefined) {
    const st = await api<AppSettings>("/api/settings", { method: "PUT", json: { theme: next, ...(base !== undefined ? { theme_base: base } : {}) } });
    const saved = normalizeThemeSettings(st.theme);
    storeTheme(saved); setSettings(saved); setSettingsCache(st); restoreTheme(); markPending(false);
    return saved;
  }
  /** 列表操作（切換、改名、刪除、複製）：伺服器失敗時只在這部手機套用，並清楚顯示「尚未同步」 */
  async function persist(next: ThemeSettings, msg: string) {
    setBusy(true);
    try { await send(next, serverBase()); toast(msg); return true; }
    catch (e) {
      setSettings(next); storeTheme(next); restoreTheme(); markPending(true);
      toast((e as Error).message + "（只在這部手機套用，尚未保存到伺服器）", "err");
      return false;
    } finally { setBusy(false); }
  }
  const retrySync = async () => { setBusy(true); try { await send(settings, undefined); toast("已同步到伺服器"); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); } };
  const choose = (id: string) => void persist({ ...settings, active: id }, "已切換主題");
  const startEdit = (theme: ThemeDef, isNew: boolean) => { setSaveError(null); setAdding(false); setEdit({ theme, isNew, base: serverBase() }); };
  const startNew = (from: ThemeDef, name?: string) => {
    const err = customLimitError(settings);
    if (err) { toast(err, "err"); return; }
    startEdit(cloneTheme(from, name), true);
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
  /** 編輯器保存：使用開始編輯時的版本；失敗時保留草稿（不在本機假裝已保存），可重試或在衝突時明確覆寫 */
  async function saveEdit(t: ThemeDef, overwrite = false) {
    if (!edit) return;
    const exists = settings.custom.some((c) => c.id === t.id);
    if (!exists) { const err = customLimitError(settings); if (err) { toast(err, "err"); return; } }
    // 編輯已有主題＝原位更新（保留 ID 及次序）；新增／複製才使用新 ID
    const custom = exists ? settings.custom.map((c) => (c.id === t.id ? t : c)) : [...settings.custom, t];
    setBusy(true); setSaveError(null);
    try {
      await send({ ...settings, custom, active: t.id }, overwrite ? undefined : edit.base);
      toast(exists ? "已保存主題" : "已新增並套用主題");
      setEdit(null);
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 409;
      setSaveError({ msg: conflict ? "主題已在另一部裝置更新" : (e as Error).message, conflict });
    } finally { setBusy(false); }
  }

  if (edit) {
    return <Editor key={edit.theme.id} initial={edit.theme} isNew={edit.isNew} busy={busy} saveError={saveError?.msg ?? null} conflict={!!saveError?.conflict} onCancel={() => { restoreTheme(); setSaveError(null); setEdit(null); }} onSave={(t, overwrite) => void saveEdit(t, overwrite)} />;
  }
  return (
    <div className="space-y-4" data-testid="theme-list">
      {pending && <p className="flex items-center gap-2 rounded-xl bg-cream/5 px-3 py-2 text-[12px]" role="status" data-testid="theme-pending"><span className="flex-1">主題變更只在這部手機套用，尚未保存到伺服器。</span><Button variant="ghost" disabled={busy} onClick={() => void retrySync()}>重試同步</Button></p>}
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
              <button type="button" onClick={() => startEdit(t, false)} className="rounded-full bg-black/30 px-2 py-0.5 text-white" data-testid="theme-edit">編輯</button>
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
/** 鍵盤彈出時的底部遮擋高度（visualViewport；不支援時為 0） */
function useKeyboardInset() {
  const [b, setB] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => setB(Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)));
    on(); vv.addEventListener("resize", on); vv.addEventListener("scroll", on);
    return () => { vv.removeEventListener("resize", on); vv.removeEventListener("scroll", on); };
  }, []);
  return b;
}

/**
 * 編輯器（Phase 3.8B.1）
 * - 點擊色票或預覽元素：立即打開底部調色面板（不需要向下捲動），上方保留即時預覽。
 * - 一次完整拖動（滑桿／色盤／原生選擇器）只建立一筆撤銷紀錄；支援撤銷及重做。
 * - 基本／進階：選中顏色一定在可見列表內；從預覽點擊進階元素會自動切換進階並展開該群組。
 * - 保存失敗保留草稿，可重試；不會把本機草稿顯示為已保存。
 */
function Editor({ initial, isNew, busy, saveError, conflict, onCancel, onSave }: { initial: ThemeDef; isNew: boolean; busy: boolean; saveError: string | null; conflict: boolean; onCancel: () => void; onSave: (t: ThemeDef, overwrite?: boolean) => void }) {
  const [t, setT] = useState<ThemeDef>(initial);
  const [token, setTok] = useState<ThemeToken | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [open, setOpen] = useState<Set<ThemeGroup>>(() => new Set<ThemeGroup>(["base", "text"]));
  const [trial, setTrial] = useState(false);
  const [past, setPast] = useState<ThemeDef[]>([]);
  const [future, setFuture] = useState<ThemeDef[]>([]);
  const gesture = useRef<{ pushed: boolean } | null>(null);
  const origin = useRef<{ y: number; fromList: boolean } | null>(null);
  const colors = useMemo(() => resolveColors(t), [t]);
  const issues = useMemo(() => readability(colors), [colors]);
  const dirty = JSON.stringify(t) !== JSON.stringify(initial);
  // 「套用到整個 App 試用」：草稿暫時套用到全站；關閉、取消或離開時恢復正式主題
  useEffect(() => { if (trial) trialTheme(t); else restoreTheme(); }, [trial, t]);
  /** 修改主題：拖動期間只在第一次變更時記錄撤銷點 */
  const apply = (next: ThemeDef) => {
    const g = gesture.current;
    if (!g || !g.pushed) { setPast((h) => [...h.slice(-49), t]); if (g) g.pushed = true; }
    setFuture([]);
    setT(next);
  };
  const begin = () => { gesture.current = { pushed: false }; };
  const end = () => { gesture.current = null; };
  const undo = () => { if (!past.length) return; setFuture((f) => [t, ...f]); setT(past[past.length - 1]); setPast((h) => h.slice(0, -1)); };
  const redo = () => { if (!future.length) return; setPast((h) => [...h, t]); setT(future[0]); setFuture((f) => f.slice(1)); };
  const setColor = (k: ThemeToken, hex: string) => apply(setToken(t, k, hex));
  const visible = useMemo(() => THEME_GROUPS.flatMap(([g]) => ALL_TOKENS.filter((k) => TOKEN_INFO[k].group === g && (advanced || isBasic(k)))), [advanced]);
  const tokensIn = (g: ThemeGroup) => visible.filter((k) => TOKEN_INFO[k].group === g);
  const overridden = (k: ThemeToken) => !isBasic(k) && !!t.adv?.[k];
  /** 打開調色面板；需要時自動切換進階及展開群組 */
  const openToken = (k: ThemeToken, fromList: boolean) => {
    if (!isBasic(k) && !advanced) setAdvanced(true);
    setOpen((s) => (s.has(TOKEN_INFO[k].group) ? s : new Set([...s, TOKEN_INFO[k].group])));
    if (!token) origin.current = { y: window.scrollY, fromList };
    setTok(k);
  };
  const closeSheet = () => {
    const k = token, o = origin.current;
    setTok(null); origin.current = null;
    // 完成後返回原本色票位置
    requestAnimationFrame(() => {
      if (o?.fromList) window.scrollTo({ top: o.y });
      else if (k) document.querySelector(`[data-token="${k}"]`)?.scrollIntoView({ block: "center" });
    });
  };
  const switchBasic = () => { setAdvanced(false); if (token && !isBasic(token)) setTok(null); };
  const step = (d: 1 | -1) => { if (!token) return; const i = visible.indexOf(token); const k = visible[(i + d + visible.length) % visible.length]; openToken(k, false); };

  return (
    <div className="space-y-3" data-testid="theme-editor" data-editing={t.id} data-new={isNew ? "1" : "0"} data-sheet={token ? "1" : "0"} data-dirty={dirty ? "1" : "0"}>
      <section className="frame p-3">
        <label className="flex items-center gap-2 text-[13px]">名稱<input value={t.name} maxLength={20} onChange={(e) => setT({ ...t, name: e.target.value })} className="field h-9 flex-1 rounded-full px-3 text-[15px]" data-testid="theme-name" /></label>
        <p className="mt-1.5 text-[11px] text-mauve">{isNew ? "新主題：保存後加入「我的主題」。" : "編輯已有主題：保存會更新這個主題（保留原本 ID），不會另外建立新主題。"}</p>
      </section>

      <ThemePreview theme={t} trial={trial} onTrial={setTrial} compact={!!token} picked={token} onPick={(k) => openToken(k, false)} />

      <section className="frame p-3" data-testid="theme-tokens">
        <div className="mb-2 flex items-center gap-1.5">
          <h3 className="flex-1 font-serif text-[14px] text-gold-soft">顏色</h3>
          <div className="flex rounded-full p-0.5 text-[12px] chip" role="group" aria-label="顯示">
            <button type="button" aria-pressed={!advanced} onClick={switchBasic} className={`rounded-full px-2.5 py-1 ${!advanced ? "chip-on" : ""}`} data-testid="theme-basic">基本</button>
            <button type="button" aria-pressed={advanced} onClick={() => { setAdvanced(true); setOpen(new Set(THEME_GROUPS.map((g) => g[0]))); }} className={`rounded-full px-2.5 py-1 ${advanced ? "chip-on" : ""}`} data-testid="theme-advanced">進階</button>
          </div>
          <button type="button" aria-label="撤銷" data-testid="theme-undo" disabled={!past.length} onClick={undo} className="chip grid h-8 w-8 place-items-center rounded-full disabled:opacity-40"><IconUndo /></button>
          <button type="button" aria-label="重做" data-testid="theme-redo" disabled={!future.length} onClick={redo} className="chip grid h-8 w-8 place-items-center rounded-full disabled:opacity-40"><IconUndo className="-scale-x-100" /></button>
        </div>
        <p className="mb-1 text-[11px] text-mauve">點擊色票或上方預覽中的元素，即可直接調色。</p>
        {THEME_GROUPS.map(([g, label]) => {
          const list = tokensIn(g);
          if (!list.length) return null;
          const isOpen = open.has(g);
          return (
            <div key={g} className="border-t border-gold/20 py-1.5 first-of-type:border-t-0" data-group={g} data-open={isOpen ? "1" : "0"}>
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; })} className="flex w-full items-center gap-2 py-1 text-left text-[13px]">
                <span className="flex -space-x-1.5">{list.slice(0, 5).map((k) => <span key={k} className="h-4 w-4 rounded-full ring-1 ring-black/25" data-color-swatch style={{ background: colors[k] }} />)}</span>
                <span className="flex-1">{label}</span><span className="text-[11px] text-mauve">{list.length} 項</span>
                <IconChevronDown className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
              </button>
              {isOpen && (
                <div className="mt-1 grid grid-cols-2 gap-1.5">
                  {list.map((k) => (
                    <button key={k} type="button" data-token={k} aria-pressed={token === k} onClick={() => openToken(k, true)} className={`flex items-center gap-2 rounded-2xl px-2 py-1.5 text-left text-[12px] ${token === k ? "chip-on" : "chip"}`}>
                      <span className="h-6 w-6 shrink-0 rounded-full ring-1 ring-black/20" data-color-swatch style={{ background: colors[k] }} />
                      <span className="min-w-0 flex-1 truncate">{TOKEN_INFO[k].label}</span>
                      {!isBasic(k) && <span className="text-[9.5px] opacity-70" data-auto={overridden(k) ? "0" : "1"}>{overridden(k) ? "已自訂" : "自動"}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {advanced && Object.keys(t.adv ?? {}).length > 0 && <button type="button" data-testid="theme-reset-auto" onClick={() => apply({ ...t, adv: {}, decor: { ...t.decor, canvas: null } })} className="chip mt-1 h-8 rounded-full px-3 text-[12px]">全部進階色票改回自動衍生</button>}
      </section>

      <section className="frame space-y-2 p-3 text-[12.5px]" data-testid="theme-readability">
        <h3 className="font-serif text-[14px] text-gold-soft">可讀性檢查</h3>
        {issues.length === 0 ? <p className="text-ok-ink" data-testid="theme-ok">所有主要文字、按鈕、底部選單及輸入框的對比足夠。</p> : (
          <ul data-status-color className="space-y-1 rounded-xl bg-danger/25 px-3 py-2 text-[12px] text-danger-ink" role="alert" data-testid="theme-issues">
            {issues.map((i) => (
              <li key={i.pair} data-issue={i.fg + "/" + i.bg}>
                {i.pair}：{i.ratio}:1（建議 ≥ {i.min}:1）{i.sameColor && <b>｜你把文字及背景設定成相同顏色</b>}
                <button type="button" className="ml-1 underline" onClick={() => openToken(i.fg, true)}>調整</button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" data-testid="theme-auto-text" disabled={!issues.length} onClick={() => {
            const r = autoFixText(t);
            if (!r.changed.length) { toast("沒有可以自動修正的文字顏色", "err"); return; }
            apply(r.theme);
            toast(`已調整：${r.changed.map((k) => TOKEN_INFO[k].label).join("、")}（可按撤銷）`);
          }}>自動調整文字顏色</Button>
          <span className="text-[11px] text-mauve">只修改對比不足的文字色票；不會自動改動其他顏色。</span>
        </div>
      </section>

      <section className="frame space-y-2.5 p-3 text-[12.5px]" data-testid="theme-decor">
        <h3 className="font-serif text-[14px] text-gold-soft">介面裝飾</h3>
        <label className="flex items-center gap-2">卡片圓角<input type="range" min={0} max={32} value={t.decor.radius} onPointerDown={begin} onPointerUp={end} onPointerCancel={end} onChange={(e) => apply({ ...t, decor: { ...t.decor, radius: Number(e.target.value) } })} className="flex-1 touch-none" />{t.decor.radius}px</label>
        <label className="flex items-center gap-2">邊框粗幼<input type="range" min={0} max={4} value={t.decor.border} onPointerDown={begin} onPointerUp={end} onPointerCancel={end} onChange={(e) => apply({ ...t, decor: { ...t.decor, border: Number(e.target.value) } })} className="flex-1 touch-none" />{t.decor.border}px</label>
        <Seg label="衣物圖片框" value={t.decor.frame} opts={[["arch", "拱形"], ["round", "圓角"]]} on={(v) => apply({ ...t, decor: { ...t.decor, frame: v as "arch" | "round" } })} />
        <Seg label="背景" value={t.decor.pattern} opts={[["stripe", "條紋"], ["dots", "圓點"], ["plain", "純色"]]} on={(v) => apply({ ...t, decor: { ...t.decor, pattern: v as "stripe" } })} />
        <Seg label="版面" value={t.decor.density} opts={[["compact", "緊湊"], ["standard", "標準"], ["loose", "寬鬆"]]} on={(v) => apply({ ...t, decor: { ...t.decor, density: v as "standard" } })} />
        <label className="flex items-center justify-between gap-2">蕾絲裝飾<button type="button" role="switch" aria-checked={t.decor.lace} data-testid="theme-lace" onClick={() => apply({ ...t, decor: { ...t.decor, lace: !t.decor.lace } })} className="switch" /></label>
        <p className="text-[11px] text-mauve">錯誤、成功、警告及遮罩的「隱藏／身後」標示保留固定顏色，確保可以辨識。</p>
      </section>

      {saveError && <p role="alert" data-status-color className="rounded-xl bg-danger/30 px-3 py-2 text-[12px] text-danger-ink" data-testid="theme-save-error">未能保存到伺服器：{saveError}。草稿仍然保留，可以按「重試保存」；這個主題尚未保存。{conflict && <> 另一部裝置已修改主題：可以按「覆寫」以目前草稿取代，或取消編輯以載入最新主題。<button type="button" className="ml-1 underline" data-testid="theme-overwrite" disabled={busy} onClick={() => onSave({ ...t, name: t.name.trim() }, true)}>覆寫</button></>}</p>}
      {/* 調色面板打開時，預留空間讓下方色票可以捲到面板上方 */}
      <div aria-hidden style={{ height: token ? "62dvh" : undefined }} className={token ? "" : "sticky-spacer"} />
      {!token && (
        <div className="sticky-actions frame flex gap-2 p-2" data-testid="theme-actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy} data-testid="theme-cancel">取消</Button>
          <Button className="flex-1" data-testid="theme-save" disabled={busy || !t.name.trim()} onClick={() => onSave({ ...t, name: t.name.trim() })}><IconCheck />{busy ? "保存中…" : saveError ? "重試保存" : isNew ? "保存並套用" : "保存主題"}</Button>
        </div>
      )}
      {token && <ColorSheet k={token} t={t} colors={colors} index={visible.indexOf(token)} count={visible.length} begin={begin} end={end} onColor={setColor} onReset={() => apply(resetToken(t, token))} onCopy={(from) => setColor(token, colors[from])} onPrev={() => step(-1)} onNext={() => step(1)} onDone={closeSheet} />}
    </div>
  );
}

const hsvToHex = (h: number, s: number, v: number) => { const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return rgbToHex(f(5) * 255, f(3) * 255, f(1) * 255); };
function hexToHsv(hex: string): [number, number, number] { const [r, g, b] = hexToRgb(hex).map((x) => x / 255); const max = Math.max(r, g, b), d = max - Math.min(r, g, b); const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; return [Math.round((h * 60 + 360) % 360), max === 0 ? 0 : d / max, max]; }

/**
 * 底部調色面板：大型色盤（飽和度×明度）、彩虹色相、飽和度及明度漸層滑桿、HEX、原生選擇器、恢復此項、複製其他顏色、上一項／下一項、完成。
 * 獨立捲動區域；考慮 safe area 及鍵盤；滑桿使用 touch-action: none，拖動時頁面不會跳動或誤觸返回。
 */
function ColorSheet({ k, t, colors, index, count, begin, end, onColor, onReset, onCopy, onPrev, onNext, onDone }: { k: ThemeToken; t: ThemeDef; colors: Record<ThemeToken, string>; index: number; count: number; begin: () => void; end: () => void; onColor: (k: ThemeToken, hex: string) => void; onReset: () => void; onCopy: (from: ThemeToken) => void; onPrev: () => void; onNext: () => void; onDone: () => void }) {
  const hex = colors[k];
  const [h, s, l] = hexToHsl(hex);
  const [text, setText] = useState(hex);
  // 色盤保留自己的色相（灰色時 HSL 色相會變 0）
  const [hue, setHue] = useState(() => hexToHsv(hex)[0]);
  useEffect(() => { setText(hex); const [hh, ss] = hexToHsv(hex); if (ss > 0.02) setHue(hh); }, [hex]);
  useEffect(() => { setHue(hexToHsv(colors[k])[0]); }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  const kb = useKeyboardInset();
  const auto = !isBasic(k) && !t.adv?.[k];
  const [, sv, vv] = hexToHsv(hex);
  const satGrad = `linear-gradient(90deg, ${hslToHex(h, 0, l)}, ${hslToHex(h, 100, l)})`;
  const lightGrad = `linear-gradient(90deg, #000, ${hslToHex(h, s, 50)}, #fff)`;
  const pad = useRef<HTMLDivElement>(null);
  const fromPad = (e: { clientX: number; clientY: number }) => { const r = pad.current!.getBoundingClientRect(); const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)); onColor(k, hsvToHex(hue, x, 1 - y)); };
  const rangeProps = { onPointerDown: begin, onPointerUp: end, onPointerCancel: end, onBlur: end };
  return (
    <div className="fixed inset-x-0 z-[60] mx-auto flex max-w-lg flex-col rounded-t-[22px] shadow-[0_-10px_30px_var(--aw-shadow-strong)] sheet-surface frame" style={{ bottom: kb, maxHeight: `calc(${kb ? "100dvh - " + kb + "px" : "60dvh"})` }} role="dialog" aria-label={"調整顏色：" + TOKEN_INFO[k].label} data-testid="theme-color-panel" data-token-edit={k}>
      <div className="flex items-center gap-3 border-b border-gold/20 px-3 pb-2 pt-3">
        <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-full ring-2 ring-gold/60" style={{ background: hex }} data-testid="theme-circle" data-color-swatch>
          <input type="color" aria-label="原生色彩選擇器" value={hex} onFocus={begin} onBlur={end} onChange={(e) => onColor(k, e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" data-testid="theme-native" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" data-testid="theme-sheet-title">{TOKEN_INFO[k].label}</p>
          <p className="text-[11px] text-mauve">{THEME_GROUPS.find((g) => g[0] === TOKEN_INFO[k].group)?.[1]}｜{isBasic(k) ? "基本色" : auto ? "自動衍生" : "已自訂"}｜{index + 1}/{count}</p>
        </div>
        <input aria-label="HEX 色碼" data-testid="theme-hex" value={text} inputMode="text" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setText(e.target.value)} onBlur={() => { const v = text.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) onColor(k, v.startsWith("#") ? v : "#" + v); else setText(hex); }} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} className="field h-9 w-[6.4rem] rounded-full px-3 font-mono text-[16px]" />
        <button type="button" aria-label="關閉" onClick={onDone} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full" data-testid="theme-sheet-close">×</button>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-3 py-2.5 text-[12.5px]">
        <div ref={pad} data-testid="theme-pad" className="relative h-32 w-full touch-none rounded-xl" data-color-swatch style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(hue, 1, 1)})` }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); begin(); fromPad(e); }} onPointerMove={(e) => { if (e.buttons) fromPad(e); }} onPointerUp={end} onPointerCancel={end}>
          <span className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.5)]" style={{ left: `${sv * 100}%`, top: `${(1 - vv) * 100}%`, background: hex }} />
        </div>
        <label className="flex items-center gap-2"><span className="w-12 shrink-0">色相</span><input type="range" min={0} max={359} value={hue} {...rangeProps} onChange={(e) => { const v = Number(e.target.value); setHue(v); onColor(k, sv > 0.02 ? hsvToHex(v, sv, vv) : hslToHex(v, Math.max(s, 60), l)); }} className="hue-track flex-1 touch-none" style={{ "--thumb": hsvToHex(hue, 1, 1) } as CSSProperties} data-testid="theme-hue" /><span className="w-9 text-right tabular-nums">{hue}°</span></label>
        <label className="flex items-center gap-2"><span className="w-12 shrink-0">飽和度</span><input type="range" min={0} max={100} value={s} {...rangeProps} onChange={(e) => onColor(k, hslToHex(h, Number(e.target.value), l))} className="grad-track flex-1 touch-none" style={{ "--grad": satGrad, "--thumb": hex } as CSSProperties} data-testid="theme-sat" /><span className="w-9 text-right tabular-nums">{s}%</span></label>
        <label className="flex items-center gap-2"><span className="w-12 shrink-0">明度</span><input type="range" min={0} max={100} value={l} {...rangeProps} onChange={(e) => onColor(k, hslToHex(h, s, Number(e.target.value)))} className="grad-track flex-1 touch-none" style={{ "--grad": lightGrad, "--thumb": hex } as CSSProperties} data-testid="theme-light" /><span className="w-9 text-right tabular-nums">{l}%</span></label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onReset} className="chip flex h-8 items-center gap-1 rounded-full px-3" data-testid="theme-token-reset"><IconRotate />{isBasic(k) ? "恢復此項預設" : "改回自動衍生"}</button>
          <label className="chip flex h-8 items-center gap-1 rounded-full pl-3 pr-1"><IconCopy />複製
            <select aria-label="複製其他顏色" data-testid="theme-copy-from" value="" onChange={(e) => { if (e.target.value) onCopy(e.target.value as ThemeToken); }} className="h-7 max-w-[8.5rem] rounded-full bg-transparent text-[12px]">
              <option value="">其他顏色…</option>
              {ALL_TOKENS.filter((x) => x !== k).map((x) => <option key={x} value={x}>{TOKEN_INFO[x].label}</option>)}
            </select>
          </label>
          <span className="text-[11px] text-mauve">與主背景對比 {contrast(hex, colors.bg).toFixed(1)}:1</span>
        </div>
      </div>
      <div className="flex gap-2 border-t border-gold/20 px-3 pt-2" style={{ paddingBottom: kb ? 8 : "calc(env(safe-area-inset-bottom) + 0.5rem)" }}>
        <button type="button" onClick={onPrev} className="chip h-10 rounded-full px-3 text-[13px]" data-testid="theme-prev">‹ 上一項</button>
        <button type="button" onClick={onNext} className="chip h-10 rounded-full px-3 text-[13px]" data-testid="theme-next">下一項 ›</button>
        <Button className="ml-auto flex-1" onClick={onDone} data-testid="theme-sheet-done"><IconCheck />完成</Button>
      </div>
    </div>
  );
}

function Seg({ label, value, opts, on }: { label: string; value: string; opts: [string, string][]; on: (v: string) => void }) {
  return <div className="flex items-center gap-1.5">{label}{opts.map(([k, l]) => <button key={k} type="button" aria-pressed={value === k} onClick={() => on(k)} className={`h-7 rounded-full px-2.5 ${value === k ? "chip-on" : "chip"}`}>{l}</button>)}</div>;
}

// ───────────── 跨頁面即時預覽 ─────────────
const PAGES = [["home", "首頁"], ["wardrobe", "衣櫃"], ["upload", "上傳"], ["studio", "穿搭工作室"], ["dress", "角色換裝"], ["settings", "設定"]] as const;
type PreviewPage = (typeof PAGES)[number][0];

/**
 * 預覽容器：以草稿主題的 CSS 變數套用在這個容器（不影響全站），內容使用正式 App 的 CSS class 及共用元件，
 * 只用靜態示範資料，不發送任何 API 或圖片請求。
 * Phase 3.8B.1：點擊預覽元素（data-pick）直接打開對應色票；同一元素有多個顏色時顯示小型選擇面板。
 * 所有點擊在捕捉階段攔截，不會觸發真實導航、上傳或資料修改。
 */
export function ThemePreview({ theme, trial, onTrial, compact, picked, onPick }: { theme: ThemeDef; trial: boolean; onTrial: (v: boolean) => void; compact?: boolean; picked?: ThemeToken | null; onPick?: (k: ThemeToken) => void }) {
  const [page, setPage] = useState<PreviewPage>("home");
  const [full, setFull] = useState(false);
  const [choice, setChoice] = useState<{ tokens: ThemeToken[]; x: number; y: number } | null>(null);
  const data = themeData(theme);
  const colors = resolveColors(theme);
  const flash = (el: HTMLElement) => { el.setAttribute("data-picked", "1"); setTimeout(() => el.removeAttribute("data-picked"), 900); };
  const capture = (e: ReactMouseEvent<HTMLDivElement>) => {
    // 選擇面板本身的按鈕照常運作；其他預覽元素一律攔截（不觸發真實操作）
    if ((e.target as HTMLElement).closest("[data-pick-choice]")) return;
    e.preventDefault(); e.stopPropagation();
    if (!onPick) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-pick]");
    if (!el) return;
    const tokens = el.dataset.pick!.split(",").filter((k): k is ThemeToken => (ALL_TOKENS as string[]).includes(k));
    if (!tokens.length) return;
    flash(el);
    if (tokens.length === 1) { setChoice(null); onPick(tokens[0]); return; }
    const box = e.currentTarget.getBoundingClientRect();
    setChoice({ tokens, x: Math.min(e.clientX - box.left, box.width - 190), y: e.clientY - box.top + 8 });
  };
  const scope = (
    <div className="theme-scope relative overflow-hidden rounded-2xl ring-1 ring-gold/40" style={themeStyle(theme) as CSSProperties} data-testid="theme-preview" data-preview-page={page} {...Object.fromEntries(Object.entries(data).map(([k, v]) => ["data-" + k, v]))}
      onClickCapture={capture} onSubmitCapture={(e) => e.preventDefault()}>
      <PreviewShell page={page} picking={!!onPick} />
      {choice && (
        <div className="pop absolute z-20 w-[180px] rounded-2xl p-1.5 text-[12px]" style={{ left: Math.max(4, choice.x), top: choice.y }} data-testid="theme-pick-choice" data-pick-choice>
          <p className="px-1.5 pb-1 text-[10.5px] text-mauve">這個元素有多個顏色</p>
          {choice.tokens.map((k) => <button key={k} type="button" data-pick-token={k} onClick={() => { setChoice(null); onPick?.(k); }} className="flex w-full items-center gap-2 rounded-xl px-1.5 py-1 text-left"><span className="h-4 w-4 shrink-0 rounded-full ring-1 ring-black/25" data-color-swatch style={{ background: colors[k] }} />{TOKEN_INFO[k].label}</button>)}
        </div>
      )}
    </div>
  );
  return (
    <section className={`frame space-y-2 p-3 ${compact ? "sticky z-20 max-h-[36dvh] overflow-y-auto overscroll-contain" : ""}`} style={compact ? { top: "calc(var(--app-header-h, 3rem) + 0.25rem)" } : undefined} data-testid="theme-preview-panel" data-picked-token={picked ?? ""}>
      <div className="flex items-center gap-2">
        <h3 className="flex-1 font-serif text-[14px] text-gold-soft">即時預覽<span className="ml-1 font-sans text-[10.5px] text-mauve">點擊元素可直接調色</span></h3>
        <button type="button" onClick={() => setFull(true)} className="chip flex h-8 items-center gap-1 rounded-full px-3 text-[12px]" data-testid="theme-preview-full"><IconExpand />全頁</button>
      </div>
      <div className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto overscroll-x-contain px-1" role="tablist">
        {PAGES.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={page === k} data-preview-tab={k} onClick={() => { setPage(k); setChoice(null); }} className={`h-8 shrink-0 rounded-full px-3 text-[12px] ${page === k ? "chip-on" : "chip"}`}>{l}</button>)}
      </div>
      {!full && scope}
      {!compact && (
        <label className="flex items-center justify-between gap-2 text-[12.5px]">
          <span>同時套用到整個 App 試用<span className="block text-[11px] text-mauve">未保存前可隨時關閉；取消編輯會恢復原本主題</span></span>
          <button type="button" role="switch" aria-checked={trial} onClick={() => onTrial(!trial)} className="switch" data-testid="theme-trial" />
        </label>
      )}
      {full && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-3 pt-[calc(env(safe-area-inset-top)+0.75rem)]" role="dialog" aria-label="全頁預覽" data-testid="theme-preview-fullscreen">
          <div className="mb-2 flex items-center gap-1 overflow-x-auto">
            {PAGES.map(([k, l]) => <button key={k} type="button" aria-selected={page === k} onClick={() => setPage(k)} className={`h-8 shrink-0 rounded-full px-3 text-[12px] ${page === k ? "chip-on" : "chip"}`}>{l}</button>)}
            <button type="button" onClick={() => setFull(false)} className="btn-jewel ml-auto h-8 shrink-0 rounded-full px-3 text-[12px]">關閉</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" onClickCapture={() => { if (onPick) setFull(false); }}>{scope}</div>
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
      <div className="arch arch-base relative aspect-[3/4]" data-pick="image,image2,imageHi,imageBorder,dots,imageDeco">
        <svg viewBox="0 0 60 80" className="pointer-events-none absolute inset-0 h-full w-full px-[18%] pb-[12%] pt-[24%]" aria-hidden><path d="M18 8 L42 8 L52 26 L44 30 L44 72 L16 72 L16 30 L8 26 Z" fill="currentColor" opacity={0.28} /></svg>
        <span className="chip-on absolute bottom-2.5 left-1/2 -translate-x-1/2 rounded-full px-2 py-0.5 text-[9px]" data-pick="selected,onSelected">已完成</span>
      </div>
      {fav && <span className="absolute right-0 top-0 text-[13px] text-[var(--aw-chart)]" data-pick="chart"><IconHeart filled /></span>}
      <div className="truncate pt-1 text-center text-[11.5px] font-medium" data-pick="text">{name}</div>
      <div className="truncate text-center text-[10px] text-mauve" data-pick="text2">{cat}</div>
    </div>
  );
}
function PreviewShell({ page, picking }: { page: PreviewPage; picking?: boolean }) {
  const tabs = [["home", "首頁", IconHome], ["wardrobe", "衣櫃", IconCrown], ["upload", "上傳", IconPlus], ["studio", "穿搭", IconDress], ["settings", "設定", IconGear]] as const;
  const activeTab = page === "dress" ? "studio" : page;
  // 可點選元素時不使用 inert（點擊已在外層攔截，不會觸發任何操作）；輸入框保持唯讀並不接收焦點
  return (
    <div className={`select-none text-[13px] ${picking ? "cursor-pointer [&_input]:pointer-events-none [&_select]:pointer-events-none" : "pointer-events-none"}`} {...(picking ? {} : { inert: true })} data-pick="bg,stripe">
      <div className="lace-b relative z-10 flex h-9 items-center justify-between px-3" style={{ background: "var(--aw-header)" }} data-pick="header,title,lace">
        <span className="font-serif text-[14px] tracking-[0.14em] text-gold-soft" data-pick="title">電子衣櫃</span>
        <span className="btn-dark rounded-full px-3 py-0.5 text-[11px]" data-pick="secondary,onSecondary">編輯</span>
      </div>
      <div className="min-h-[300px] space-y-2.5 p-3 pb-4" style={{ paddingLeft: "var(--aw-pad)", paddingRight: "var(--aw-pad)" }}>
        {page === "home" && <>
          <div className="grid grid-cols-2 gap-2">
            <div className="frame p-2.5 text-center" data-pick="card,title,text2,border,line"><div className="font-serif text-[22px] text-gold-soft">128</div><div className="text-[11px] text-mauve">衣物總數</div></div>
            <div className="frame p-2.5" data-pick="card,title,text2,chart"><div className="text-[11px] text-mauve">衣櫃總價</div><div className="font-serif text-[18px] text-gold-soft">$42,800</div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-cream/10"><div className="h-full w-2/3" style={{ background: "var(--aw-chart)" }} /></div></div>
          </div>
          <div className="flex justify-center"><span className="ribbon orn font-serif text-[12px]" data-pick="ribbon,onRibbon,star">最近加入</span></div>
          <div className="grid grid-cols-3 gap-2">{DEMO.map((d, i) => <DemoTile key={d.name} {...d} fav={i === 0} />)}</div>
          <div className="frame flex items-center gap-3 p-2.5" data-pick="chart,chart2,chart3,chart4,card"><Donut size={70} thickness={9} segs={[{ name: "JSK", n: 5, color: "var(--aw-chart-1)" }, { name: "OP", n: 3, color: "var(--aw-chart-2)" }, { name: "上衣", n: 2, color: "var(--aw-chart-3)" }, { name: "其他", n: 2, color: "var(--aw-chart-4)" }]}><span className="text-[10px] text-mauve">分類</span></Donut><div className="min-w-0 flex-1"><Bars rows={[{ name: "JSK", n: 5 }, { name: "OP", n: 3 }]} /></div></div>
        </>}
        {page === "wardrobe" && <>
          <div className="relative" data-pick="input,inputText,placeholder,border"><IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--aw-placeholder)]" /><input readOnly tabIndex={-1} placeholder="搜尋衣物…" className="field h-9 w-full rounded-full pl-9 pr-3 text-[13px]" /></div>
          <div data-pick="selected,onSelected,secondary"><Chips options={["JSK", "OP", "上衣"] as const} value="JSK" onChange={() => undefined} /></div>
          <div className="grid grid-cols-3 gap-2">{[...DEMO, ...DEMO].map((d, i) => <DemoTile key={i} {...d} fav={i === 2} />)}</div>
        </>}
        {page === "upload" && <>
          <div className="paper p-4 text-center" data-pick="image,image2,imageHi,onImage"><p className="font-serif text-[15px]">上傳衣物照片</p><p className="text-[11.5px] text-mauve">可以一次選擇多張</p><span className="btn-jewel mt-2 inline-flex rounded-full px-4 py-1.5 text-[13px]" data-pick="primary,onPrimary">選擇照片</span></div>
          <div className="frame space-y-2 p-3" data-pick="card,text2"><label className="block text-[12px] text-mauve">衣物名稱</label><span className="block" data-pick="input,inputText"><input readOnly tabIndex={-1} value="白色娃娃領襯衫" className="field h-9 w-full rounded-xl px-3 text-[13px]" /></span><span className="block" data-pick="input,placeholder"><input readOnly tabIndex={-1} placeholder="品牌（選填）" className="field h-9 w-full rounded-xl px-3 text-[13px]" /></span>
            <div className="flex gap-2"><span data-pick="primary,onPrimary"><Button>保存</Button></span><span data-pick="secondary,onSecondary"><Button variant="ghost">取消</Button></span><Button variant="danger">刪除</Button></div></div>
        </>}
        {page === "studio" && <>
          <div className="grid grid-cols-2 gap-2">
            <div className="frame-hot frame p-3" data-pick="selected,onSelected"><IconDress className="text-[20px]" /><p className="mt-1 font-serif text-[14px]">衣服配搭</p><p className="text-[11px] text-mauve">平面配搭</p></div>
            <div className="frame p-3" data-pick="card,title,text2,icon"><IconArm className="text-[20px] text-gold-soft" /><p className="mt-1 font-serif text-[14px] text-gold-soft">角色換裝</p><p className="text-[11px] text-mauve">人偶穿衣</p></div>
          </div>
          <div className="flex flex-wrap gap-1.5"><span className="chip rounded-full px-3 py-1 text-[12px]" data-pick="secondary,line">衣服設定</span><span className="chip rounded-full px-3 py-1 text-[12px]" data-pick="secondary,line">角色素材</span><span className="chip-on rounded-full px-3 py-1 text-[12px]" data-pick="selected,onSelected">我的穿搭</span></div>
          <div className="pop rounded-2xl p-3 text-[12px]" data-pick="pop,text">彈出視窗：保存造型？<div className="mt-2 flex gap-2"><span className="btn-jewel rounded-full px-3 py-1" data-pick="primary,onPrimary">保存</span><span className="btn-dark rounded-full px-3 py-1" data-pick="secondary,onSecondary">取消</span></div></div>
        </>}
        {page === "dress" && <>
          <div className="doll-stage relative h-[230px] overflow-hidden rounded-2xl" data-pick="canvas,canvasPattern">
            <svg viewBox="0 0 120 230" className="absolute inset-0 m-auto h-full" aria-hidden>
              <circle cx="60" cy="32" r="16" fill="#f2d6c9" /><path d="M44 52 L76 52 L84 130 L36 130 Z" fill="#3a2b3f" /><path d="M48 130 L56 210 M72 130 L64 210" stroke="#f2d6c9" strokeWidth="7" strokeLinecap="round" />
              <path d="M44 56 L30 110 M76 56 L90 110" className="sv-bone" strokeWidth="2" strokeLinecap="round" data-pick="bone" /><circle cx="30" cy="110" r="5" style={{ fill: "var(--aw-handle)" }} data-pick="handle" /><circle cx="90" cy="110" r="4" className="sv-mesh-pt" strokeWidth="1.5" data-pick="meshHandle" />
            </svg>
            <div className="absolute bottom-2 right-2 flex gap-1.5">{[IconRotate, IconSave, IconArm].map((I, i) => <span key={i} className={`doll-tool grid h-9 w-9 place-items-center rounded-full text-[16px] ${i === 2 ? "doll-tool-on" : ""}`} data-pick={i === 2 ? "selected,onSelected" : "tool,toolIcon"}><I /></span>)}</div>
            <div className="absolute left-2 top-2 flex gap-1.5">{[IconUndo, IconExpand].map((I, i) => <span key={i} className="doll-tool grid h-8 w-8 place-items-center rounded-full text-[14px]" data-pick="tool,toolIcon"><I /></span>)}</div>
          </div>
          <div className="flex gap-1.5"><span className="chip-on rounded-full px-3 py-1 text-[12px]" data-pick="selected,onSelected">衣服</span><span className="chip rounded-full px-3 py-1 text-[12px]" data-pick="secondary,line">圖層</span><span className="chip rounded-full px-3 py-1 text-[12px]" data-pick="secondary,line">姿勢</span></div>
          <label className="flex items-center gap-2 text-[12px]" data-pick="slider">大小<input type="range" readOnly tabIndex={-1} value={60} className="flex-1" /></label>
        </>}
        {page === "settings" && <>
          <div className="frame divide-y divide-gold/20 overflow-hidden" data-pick="card,text,border">
            {["介面顏色", "主頁布局", "離線衣櫃", "R2 用量及費用"].map((x) => <div key={x} className="flex items-center justify-between px-3 py-2.5"><span>{x}</span><span className="text-[11px] text-mauve">›</span></div>)}
          </div>
          <div className="frame space-y-2 p-3 text-[12px]" data-pick="card,text">
            <label className="flex items-center gap-2" data-pick="check"><input type="checkbox" readOnly tabIndex={-1} checked />勾選框</label>
            <label className="flex items-center justify-between" data-pick="check,onSelected">開關<span role="switch" aria-checked="true" className="switch" /></label>
            <label className="flex items-center gap-2" data-pick="slider">滑桿<input type="range" readOnly tabIndex={-1} value={40} className="flex-1" /></label>
            <a className="text-amethyst-deep underline" data-pick="link">連結文字</a>
            <p className="text-[var(--aw-disabled)]" data-pick="disabled">停用狀態文字</p>
            <p className="rounded-lg bg-danger/30 px-2 py-1 text-danger-ink">錯誤提示保持功能色</p>
          </div>
        </>}
      </div>
      <div className="app-tabbar lace-t relative grid grid-cols-5" style={{ background: "var(--aw-nav)" }} data-pick="nav,icon,text,lace">
        {tabs.map(([k, l, I]) => (
          <div key={k} className={`flex flex-col items-center gap-0.5 py-1.5 text-[10px] ${activeTab === k ? "tab-on" : "tab-off"}`} {...(activeTab === k ? { "data-pick": "primary,onPrimary,iconOn" } : {})}>
            <span className={`grid h-7 w-7 place-items-center rounded-full text-[15px] ${activeTab === k ? "btn-jewel" : ""}`}><I /></span>{l}
          </div>
        ))}
      </div>
    </div>
  );
}
