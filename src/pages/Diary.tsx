// Phase 3.9A.1／3.9A.1.1：穿搭日誌及穿搭日曆。月份、選中日期、篩選及顯示方式記在網址，返回時保留；離線時顯示已同步的紀錄（唯讀）。
import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Button, Empty, Link, Sheet, Spinner, toast } from "../components/ui";
import { IconChart, IconClose, IconFilter, IconPlus, IconSearch } from "../components/icons";
import { DIARY_CHANGED, DiaryEntry, DiaryKind, KIND_ICON, KIND_LABEL, addDays, daysInMonth, diaryApi, fmtDate, loadMonth, loadRange, localDate, monthOf, shiftMonth, weekday } from "../diary";
import { CoverMode, coverSrc, resolveCover } from "../diaryCover";
import { OutfitsTabs } from "./Outfits";
import { navigate, usePath } from "../router";

type View = "compact" | "photo" | "list" | "week";
const VIEWS: [View, string, string][] = [["photo", "照片", "照片月曆"], ["compact", "緊湊", "緊湊月曆"], ["week", "週", "週視圖"], ["list", "列表", "月份列表"]];
const KIND_CLASS: Record<DiaryKind, string> = { worn: "bg-[var(--aw-chart-1)]", planned: "border border-[var(--aw-chart-2)]", inspiration: "bg-[var(--aw-chart-3)]" };
/** 日誌封面（共用解析：真人照片 → 完整造型縮圖 → 衣物快照） */
export const coverOf = (e: DiaryEntry, mode: CoverMode = "auto") => coverSrc(e, mode);

/**
 * Phase 3.9A.1.1：日誌日曆（穿搭頁「日誌日曆」分頁）。
 * - 緊湊工具列：第一行月份切換＋今天；第二行顯示方式、篩選、搜尋、穿著分析、記錄今日。篩選放在獨立面板，日曆優先佔據畫面。
 * - 點擊日期直接打開當日穿搭面板（同日多套、狀態、衣物數量、編輯、查看詳情、新增）。
 * - 週視圖讀取完整 7 日（跨月、跨年都正確）。
 * - 新增／修改／刪除紀錄後自動重新讀取（aw:diary-changed）。
 */
export default function Diary() {
  const path = usePath();
  const qs = useMemo(() => new URLSearchParams(path.split("?")[1] ?? ""), [path]);
  const today = localDate();
  const month = /^\d{4}-\d{2}$/.test(qs.get("m") ?? "") ? qs.get("m")! : monthOf(today);
  const selected = qs.get("d") ?? (month === monthOf(today) ? today : null);
  const view = (VIEWS.find((v) => v[0] === qs.get("view"))?.[0] ?? (() => { try { return (localStorage.getItem("aw:diary-view") as View) || "photo"; } catch { return "photo"; } })()) as View;
  const kind = (qs.get("kind") ?? "") as DiaryKind | "";
  const fav = qs.get("fav") === "1";
  const tag = qs.get("tag") ?? "", occ = qs.get("occ") ?? "";
  const q = qs.get("q") ?? "";
  const [searchOpen, setSearchOpen] = useState(!!q);
  const [qDraft, setQDraft] = useState(q);
  const [filterOpen, setFilterOpen] = useState(false);
  const [data, setData] = useState<{ entries: DiaryEntry[]; offline: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const set = (patch: Record<string, string | null>) => { const p = new URLSearchParams(qs); for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); } navigate("/diary?" + p.toString(), true, false); };
  useEffect(() => { const on = () => setRev((v) => v + 1); window.addEventListener(DIARY_CHANGED, on); return () => window.removeEventListener(DIARY_CHANGED, on); }, []);
  useEffect(() => {
    let live = true;
    setErr(null);
    loadMonth(month).then((r) => { if (live) setData({ entries: r.data.entries, offline: r.offline }); }).catch((e) => { if (live) { setErr((e as Error).message); setData((d) => d ?? null); } });
    return () => { live = false; };
  }, [month, rev]);
  // 週視圖：讀取完整 7 日（可能跨月或跨年）
  const weekStart = addDays(selected ?? today, -weekday(selected ?? today));
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const [weekData, setWeekData] = useState<DiaryEntry[] | null>(null);
  useEffect(() => {
    if (view !== "week") return;
    let live = true;
    loadRange(week[0], week[6]).then((r) => live && setWeekData(r.entries)).catch(() => live && setWeekData(null));
    return () => { live = false; };
  }, [view, week, rev]);
  // 返回時恢復捲動位置
  const restored = useRef(false);
  useLayoutEffect(() => { if (data && !restored.current) { restored.current = true; const y = Number(sessionStorage.getItem("aw:diary-y:" + path) || 0); if (y) window.scrollTo({ top: y }); } }, [data, path]);
  useEffect(() => { const on = () => sessionStorage.setItem("aw:diary-y:" + path, String(window.scrollY)); window.addEventListener("scroll", on, { passive: true }); return () => window.removeEventListener("scroll", on); }, [path]);
  // 從首頁元件點擊某日（?d=…&open=1）：直接打開該日面板；關閉後移除 open，返回時不會再次自動打開
  const autoOpened = useRef(false);
  useEffect(() => { if (!autoOpened.current && data && qs.get("d") && qs.get("open") === "1") { autoOpened.current = true; setDayOpen(qs.get("d")); set({ open: null }); } }, [data, qs]); // eslint-disable-line react-hooks/exhaustive-deps

  const match = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (e: DiaryEntry) => (!kind || e.kind === kind) && (!fav || e.is_favorite) && (!tag || e.tags.includes(tag)) && (!occ || e.occasion === occ)
      && (!s || [e.title, e.occasion, e.location, e.notes, ...e.tags, ...e.items.map((i) => i.name)].some((x) => x?.toLowerCase().includes(s)));
  }, [kind, fav, tag, occ, q]);
  const entries = useMemo(() => (data?.entries ?? []).filter(match), [data, match]);
  const group = (list: DiaryEntry[]) => { const m = new Map<string, DiaryEntry[]>(); for (const e of list) m.set(e.worn_date, [...(m.get(e.worn_date) ?? []), e]); return m; };
  const byDay = useMemo(() => group(entries), [entries]);
  const weekByDay = useMemo(() => group((weekData ?? []).filter(match)), [weekData, match]);
  const tags = useMemo(() => [...new Set((data?.entries ?? []).flatMap((e) => e.tags))].slice(0, 30), [data]);
  const occasions = useMemo(() => [...new Set((data?.entries ?? []).map((e) => e.occasion).filter((x): x is string => !!x))].slice(0, 20), [data]);
  const [y, mo] = month.split("-").map(Number);
  const first = weekday(month + "-01"), dim = daysInMonth(month);
  const cells = [...Array(first).fill(null), ...Array.from({ length: dim }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  const openDay = (d: string) => { set({ d, m: monthOf(d) }); setDayOpen(d); };
  const activeFilters = [kind, fav ? "1" : "", tag, occ].filter(Boolean).length;
  const dayList = (d: string) => (view === "week" ? weekByDay : byDay).get(d) ?? (byDay.get(d) ?? []);

  return (
    <div className="space-y-2.5 pb-6" data-testid="diary" data-month={month} data-view={view}>
      <h1 className="pt-4 font-serif text-[22px] font-bold tracking-[0.12em] text-gold-soft">穿搭</h1>
      <OutfitsTabs tab="diary" />
      {data?.offline && <p className="rounded-xl bg-cream/5 px-3 py-1.5 text-[12px]" data-testid="diary-offline">離線：顯示已同步的紀錄（唯讀）。新增及修改需要網絡。</p>}
      {err && !data && <div className="frame p-4 text-[13px]" role="alert">未能讀取日誌：{err}<Button variant="ghost" className="ml-2" onClick={() => setRev((v) => v + 1)}>重試</Button></div>}

      {/* 緊湊工具列 */}
      <div className="space-y-1.5" data-testid="diary-toolbar">
        <div className="flex items-center gap-1.5">
          <button type="button" aria-label="上一個月" data-testid="diary-prev" onClick={() => set({ m: shiftMonth(month, -1), d: null })} className="icon-btn">‹</button>
          <p className="min-w-0 flex-1 text-center font-serif text-[17px] text-gold-soft" data-testid="diary-month-label">{y} 年 {mo} 月</p>
          <button type="button" aria-label="下一個月" data-testid="diary-next" onClick={() => set({ m: shiftMonth(month, 1), d: null })} className="icon-btn">›</button>
          <button type="button" data-testid="diary-today" onClick={() => set({ m: monthOf(today), d: today })} className="chip h-8 rounded-full px-3 text-[12px]">今天</button>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="seg min-w-0 flex-1 overflow-x-auto scrollbar-none" role="tablist" aria-label="顯示方式">
            {VIEWS.map(([k, l, full]) => <button key={k} type="button" role="tab" aria-label={full} aria-selected={view === k} data-view-tab={k} className="!px-2 !text-[12px]" onClick={() => { try { localStorage.setItem("aw:diary-view", k); } catch { /* ignore */ } set({ view: k }); }}>{l}</button>)}
          </div>
          <button type="button" aria-label="篩選" aria-expanded={filterOpen} data-testid="diary-filter" onClick={() => setFilterOpen(true)} className={`icon-btn relative ${activeFilters ? "icon-btn-on" : ""}`}><IconFilter />{activeFilters > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-wine px-1 text-[9.5px] text-white" data-status-color>{activeFilters}</span>}</button>
          <button type="button" aria-label="搜尋" aria-pressed={searchOpen} data-testid="diary-search-toggle" onClick={() => { if (searchOpen && q) { setQDraft(""); set({ q: null }); } setSearchOpen(!searchOpen); }} className={`icon-btn ${searchOpen ? "icon-btn-on" : ""}`}>{searchOpen ? <IconClose /> : <IconSearch />}</button>
          <Link to="/diary/stats" aria-label="穿著分析" className="icon-btn" data-testid="diary-stats-link"><IconChart /></Link>
          <Link to={`/diary/new?date=${selected ?? today}`} aria-label="記錄今日" className="btn-jewel grid h-8 w-8 shrink-0 place-items-center rounded-full text-[15px]" data-testid="entry-record-today"><IconPlus /></Link>
        </div>
        {searchOpen && <div className="relative"><IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--aw-placeholder)]" /><input type="search" autoFocus value={qDraft} onChange={(e) => setQDraft(e.target.value)} onBlur={() => set({ q: qDraft.trim() || null })} onKeyDown={(e) => { if (e.key === "Enter") set({ q: qDraft.trim() || null }); }} placeholder="搜尋衣物、標籤、場合…" className="field h-9 w-full rounded-full pl-9 pr-3 text-[16px]" data-testid="diary-search" /></div>}
        {activeFilters > 0 && <p className="text-[11.5px] text-mauve" data-testid="diary-active-filters">篩選中：{[kind && KIND_LABEL[kind as DiaryKind], fav && "收藏", tag && "#" + tag, occ].filter(Boolean).join("、")}　<button type="button" className="underline" onClick={() => set({ kind: null, fav: null, tag: null, occ: null })}>清除</button></p>}
      </div>

      {!data ? (!err && <Spinner />) : view === "list" ? (
        <MonthList entries={entries} onOpen={openDay} />
      ) : view === "week" ? (
        <section className="card-flat space-y-1.5 p-2.5" data-testid="diary-week">
          <div className="flex items-center justify-between text-[12px]"><button type="button" className="chip h-8 rounded-full px-3" onClick={() => { const d = addDays(weekStart, -7); set({ d, m: monthOf(d) }); }}>‹ 上一週</button><span className="text-mauve">{fmtDate(week[0])} – {fmtDate(week[6])}</span><button type="button" className="chip h-8 rounded-full px-3" onClick={() => { const d = addDays(weekStart, 7); set({ d, m: monthOf(d) }); }}>下一週 ›</button></div>
          {week.map((d) => <DayRow key={d} date={d} today={today} list={weekData ? weekByDay.get(d) ?? [] : byDay.get(d) ?? []} onOpen={() => openDay(d)} />)}
        </section>
      ) : (
        <section className="card-flat p-1.5" data-testid="diary-calendar">
          <div className="grid grid-cols-7 text-center text-[11px] text-mauve">{"日一二三四五六".split("").map((w) => <span key={w} className="py-1">{w}</span>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d, i) => d == null ? <span key={"x" + i} /> : (() => {
              const list = byDay.get(d) ?? [];
              const cv = view === "photo" && list.length ? resolveCover(list[0]) : null;
              const c = cv?.src ?? null;
              return (
                <button key={d} type="button" data-day={d} data-count={list.length} aria-label={`${fmtDate(d)}，${list.length} 筆穿搭`} aria-current={d === today ? "date" : undefined} aria-pressed={d === selected} onClick={() => openDay(d)}
                  className={`relative flex flex-col items-center overflow-hidden rounded-xl text-[12px] ${view === "photo" ? "aspect-[3/4]" : "h-11"} ${d === selected ? "ring-2 ring-[var(--aw-focus)]" : ""} ${d === today && !c ? "chip-on" : "bg-cream/5"}`}>
                  {c ? <img src={c} alt="" loading="lazy" className={`absolute inset-0 h-full w-full ${cv!.kind === "garment" ? "bg-[var(--aw-image)] object-contain p-0.5" : "object-cover"}`} data-cover={cv!.kind} /> : null}
                  <span className={`relative z-10 mt-0.5 rounded-full px-1 ${c ? "cal-photo-date" : ""} ${c && d === today ? "ring-1 ring-white" : ""}`}>{Number(d.slice(8))}</span>
                  {list.length > 0 && (
                    <span className="relative z-10 mb-1 mt-auto flex items-center gap-0.5">
                      {[...new Set(list.map((e) => e.kind))].map((k) => <span key={k} title={KIND_LABEL[k]} className={`h-1.5 w-1.5 rounded-full ${KIND_CLASS[k]}`} data-kind-dot={k} />)}
                      {list.length > 1 && <span className={`text-[9.5px] ${c ? "rounded bg-black/55 px-0.5 text-white" : "text-mauve"}`} data-status-color={c ? true : undefined}>{list.length}</span>}
                    </span>
                  )}
                </button>
              );
            })())}
          </div>
          <p className="mt-1.5 flex flex-wrap gap-3 px-1 text-[11px] text-mauve">{(["worn", "planned", "inspiration"] as const).map((k) => <span key={k} className="flex items-center gap-1"><span className={`h-2 w-2 rounded-full ${KIND_CLASS[k]}`} />{KIND_LABEL[k]}</span>)}</p>
        </section>
      )}
      {data && !entries.length && view !== "week" && <Empty title={data.entries.length ? "沒有符合篩選的紀錄" : "這個月份未有穿搭紀錄"}>點擊日期或「＋」新增穿搭。</Empty>}
      {filterOpen && (
        <Sheet title="篩選紀錄" onClose={() => setFilterOpen(false)}>
          <div className="space-y-3 text-[12.5px]" data-testid="diary-filters">
            <div><p className="mb-1 text-mauve">狀態</p><div className="flex flex-wrap gap-1.5">{(["", "worn", "planned", "inspiration"] as const).map((k) => <button key={k || "all"} type="button" data-kind={k || "all"} aria-pressed={kind === k} onClick={() => set({ kind: k || null })} className={`h-8 rounded-full px-3 ${kind === k ? "chip-on" : "chip"}`}>{k ? `${KIND_ICON[k]} ${KIND_LABEL[k]}` : "全部"}</button>)}</div></div>
            <div><button type="button" aria-pressed={fav} data-testid="diary-fav" onClick={() => set({ fav: fav ? null : "1" })} className={`h-8 rounded-full px-3 ${fav ? "chip-on" : "chip"}`}>♥ 只看收藏</button></div>
            {tags.length > 0 && <div><p className="mb-1 text-mauve">標籤</p><div className="flex flex-wrap gap-1.5">{tags.map((t) => <button key={t} type="button" data-tag={t} aria-pressed={tag === t} onClick={() => set({ tag: tag === t ? null : t })} className={`h-7 rounded-full px-2.5 ${tag === t ? "chip-on" : "chip"}`}>#{t}</button>)}</div></div>}
            {occasions.length > 0 && <div><p className="mb-1 text-mauve">場合</p><div className="flex flex-wrap gap-1.5">{occasions.map((t) => <button key={t} type="button" data-occ={t} aria-pressed={occ === t} onClick={() => set({ occ: occ === t ? null : t })} className={`h-7 rounded-full px-2.5 ${occ === t ? "chip-on" : "chip"}`}>{t}</button>)}</div></div>}
            <div><p className="mb-1 text-mauve">衣物搜尋</p><input type="search" defaultValue={q} onBlur={(e) => { setQDraft(e.target.value); set({ q: e.target.value.trim() || null }); }} placeholder="衣物名稱、標籤、備註…" className="field h-9 w-full rounded-full px-3 text-[16px]" data-testid="diary-filter-q" /></div>
            <div className="flex gap-2"><Button onClick={() => setFilterOpen(false)} data-testid="diary-filters-done">完成</Button><Button variant="ghost" onClick={() => set({ kind: null, fav: null, tag: null, occ: null, q: null })}>清除全部</Button></div>
          </div>
        </Sheet>
      )}
      {dayOpen && <DaySheet date={dayOpen} list={dayList(dayOpen)} offline={!!data?.offline} onClose={() => setDayOpen(null)} onChanged={() => setRev((v) => v + 1)} />}
    </div>
  );
}

function DayRow({ date, today, list, onOpen }: { date: string; today: string; list: DiaryEntry[]; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} data-week-day={date} className={`flex w-full items-center gap-2 rounded-2xl p-2 text-left ${date === today ? "chip-on" : "chip"}`}>
      <span className="w-20 shrink-0 text-[12px]">{fmtDate(date)}</span>
      <span className="flex min-w-0 flex-1 gap-1 overflow-hidden">{list.length ? list.map((e) => { const c = coverOf(e); return c ? <img key={e.id} src={c} alt="" className="h-10 w-8 rounded-lg object-cover" /> : <span key={e.id} className="truncate text-[12px]">{e.title || KIND_LABEL[e.kind]}</span>; }) : <span className="text-[12px] text-mauve">—</span>}</span>
      {list.length > 0 && <span className="text-[11px] text-mauve">{list.length} 套</span>}
    </button>
  );
}

export function EntryCard({ e, actions }: { e: DiaryEntry; actions?: ReactNode }) {
  const c = coverOf(e);
  return (
    <div className="card-flat flex gap-3 p-2.5" data-entry={e.id} data-kind={e.kind}>
      <Link to={`/diary/${e.id}`} className="block h-24 w-[4.5rem] shrink-0 overflow-hidden rounded-xl bg-cream/5">{c ? <img src={c} alt="" loading="lazy" className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center text-[11px] text-mauve">{KIND_ICON[e.kind]}</span>}</Link>
      <div className="min-w-0 flex-1 text-[12.5px]">
        <Link to={`/diary/${e.id}`} className="block truncate font-medium text-[14px]">{e.is_favorite ? "♥ " : ""}{e.title || e.source_name || KIND_LABEL[e.kind]}</Link>
        <p className="text-[11.5px] text-mauve">{fmtDate(e.worn_date)}{e.worn_time ? " " + e.worn_time : ""}｜{KIND_ICON[e.kind]} {KIND_LABEL[e.kind]}</p>
        <p className="truncate text-[11.5px] text-mauve">{e.garment_count} 件衣物{e.occasion ? "｜" + e.occasion : e.tags[0] ? "｜#" + e.tags[0] : ""}{e.photos.length ? `｜${e.photos.length} 張照片` : ""}</p>
        {actions && <div className="mt-1.5 flex flex-wrap gap-1">{actions}</div>}
      </div>
    </div>
  );
}

function MonthList({ entries, onOpen }: { entries: DiaryEntry[]; onOpen: (d: string) => void }) {
  return (
    <div className="space-y-2" data-testid="diary-list">
      {entries.map((e, i) => (
        <div key={e.id}>
          {(i === 0 || entries[i - 1].worn_date !== e.worn_date) && <button type="button" onClick={() => onOpen(e.worn_date)} className="mb-1 mt-2 text-[12px] text-gold-soft">{fmtDate(e.worn_date)}</button>}
          <EntryCard e={e} />
        </div>
      ))}
    </div>
  );
}

/** 某日的完整穿搭清單：新增、修改、複製到另一日期、計劃轉為已穿著、刪除 */
function DaySheet({ date, list, offline, onClose, onChanged }: { date: string; list: DiaryEntry[]; offline: boolean; onClose: () => void; onChanged: () => void }) {
  const [copy, setCopy] = useState<DiaryEntry | null>(null);
  const [target, setTarget] = useState(addDays(date, 1));
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, msg: string) => { setBusy(true); try { await fn(); toast(msg); onChanged(); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); } };
  return (
    <Sheet title={fmtDate(date)} onClose={onClose}>
      <div className="space-y-2" data-testid="diary-day" data-date={date}>
        <p className="text-[12px] text-mauve" data-testid="diary-day-count">{list.length ? `共 ${list.length} 筆穿搭` : "這一天未有紀錄"}</p>
        {list.map((e) => (
          <EntryCard key={e.id} e={e} actions={<>
            <Link to={`/diary/${e.id}`} className="chip rounded-full px-2.5 py-0.5 text-[11.5px]" data-testid="diary-view">查看詳情</Link>
            {!offline && <>
            <Link to={`/diary/${e.id}/edit`} className="chip rounded-full px-2.5 py-0.5 text-[11.5px]" data-testid="diary-edit">編輯</Link>
            {e.kind === "planned" && <button type="button" disabled={busy} data-testid="diary-mark-worn" className="chip rounded-full px-2.5 py-0.5 text-[11.5px]" onClick={() => void run(() => diaryApi.update(e.id, { kind: "worn", base_updated_at: e.updated_at }), "已標記為已穿著")}>標記已穿著</button>}
            <button type="button" disabled={busy} className="chip rounded-full px-2.5 py-0.5 text-[11.5px]" data-testid="diary-copy" onClick={() => setCopy(e)}>複製到…</button>
            <button type="button" disabled={busy} className="chip rounded-full px-2.5 py-0.5 text-[11.5px]" onClick={() => { if (confirm("刪除這筆紀錄？照片亦會刪除。")) void run(() => diaryApi.remove(e.id), "已刪除"); }}>刪除</button>
            </>}
          </>} />
        ))}
        {copy && (
          <div className="frame flex flex-wrap items-center gap-2 p-3 text-[12.5px]" data-testid="diary-copy-panel">
            複製「{copy.title || KIND_LABEL[copy.kind]}」到
            <input type="date" value={target} onChange={(e) => setTarget(e.target.value)} className="field h-9 rounded-full px-3 text-[16px]" data-testid="diary-copy-date" />
            <Button disabled={busy || !target} data-testid="diary-copy-go" onClick={() => void run(() => diaryApi.duplicate(copy.id, { worn_date: target, kind: target > localDate() ? "planned" : copy.kind }), "已複製（照片不會重複複製）").then(() => setCopy(null))}>複製</Button>
          </div>
        )}
        {!offline && <Link to={`/diary/new?date=${date}`} className="btn-jewel flex h-11 items-center justify-center gap-1 rounded-full text-[14px]" data-testid="diary-day-new"><IconPlus />在這一天新增穿搭</Link>}
      </div>
    </Sheet>
  );
}

/** 首頁及其他頁面使用：讀取本月紀錄（失敗不影響其他元件） */
export function useMonthEntries(month: string) {
  const [v, setV] = useState<DiaryEntry[] | null>(null);
  useEffect(() => { let live = true; api<{ entries: DiaryEntry[] }>(`/api/diary?month=${month}&order=asc`).then((r) => live && setV(r.entries)).catch(() => live && setV([])); return () => { live = false; }; }, [month]);
  return v;
}
