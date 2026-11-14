// Phase 3.9A.1：穿搭日誌及穿搭日曆。月份、選中日期及顯示方式記在網址，返回時保留；離線時顯示已同步的紀錄（唯讀）。
import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Button, Empty, Link, Sheet, Spinner, toast } from "../components/ui";
import { IconPlus, IconSearch } from "../components/icons";
import { DiaryEntry, DiaryKind, KIND_ICON, KIND_LABEL, addDays, daysInMonth, diaryApi, fmtDate, loadMonth, localDate, monthOf, photoThumb, shiftMonth, snapUrl, weekday } from "../diary";
import { navigate, usePath } from "../router";

type View = "compact" | "photo" | "list" | "week";
const VIEWS: [View, string][] = [["compact", "緊湊月曆"], ["photo", "照片月曆"], ["list", "月份列表"], ["week", "週視圖"]];
const KIND_CLASS: Record<DiaryKind, string> = { worn: "bg-[var(--aw-chart-1)]", planned: "border border-[var(--aw-chart-2)]", inspiration: "bg-[var(--aw-chart-3)]" };
export const coverOf = (e: DiaryEntry) => (e.cover_photo_id ? photoThumb(e.cover_photo_id) : e.items.find((i) => i.snap_id)?.snap_id ? snapUrl(e.items.find((i) => i.snap_id)!.snap_id!) : null);

export default function Diary() {
  const path = usePath();
  const qs = useMemo(() => new URLSearchParams(path.split("?")[1] ?? ""), [path]);
  const today = localDate();
  const month = /^\d{4}-\d{2}$/.test(qs.get("m") ?? "") ? qs.get("m")! : monthOf(today);
  const selected = qs.get("d") ?? (month === monthOf(today) ? today : null);
  const view = (VIEWS.find((v) => v[0] === qs.get("view"))?.[0] ?? (() => { try { return (localStorage.getItem("aw:diary-view") as View) || "photo"; } catch { return "photo"; } })()) as View;
  const kind = (qs.get("kind") ?? "") as DiaryKind | "";
  const fav = qs.get("fav") === "1";
  const [q, setQ] = useState(qs.get("q") ?? "");
  const [data, setData] = useState<{ entries: DiaryEntry[]; offline: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const set = (patch: Record<string, string | null>) => { const p = new URLSearchParams(qs); for (const [k, v] of Object.entries(patch)) { if (v) p.set(k, v); else p.delete(k); } navigate("/diary?" + p.toString(), true, false); };
  useEffect(() => {
    let live = true;
    setErr(null);
    loadMonth(month).then((r) => { if (live) setData({ entries: r.data.entries, offline: r.offline }); }).catch((e) => { if (live) { setErr((e as Error).message); setData((d) => d ?? null); } });
    return () => { live = false; };
  }, [month, rev]);
  // 返回時恢復捲動位置
  const restored = useRef(false);
  useLayoutEffect(() => { if (data && !restored.current) { restored.current = true; const y = Number(sessionStorage.getItem("aw:diary-y:" + path) || 0); if (y) window.scrollTo({ top: y }); } }, [data, path]);
  useEffect(() => { const on = () => sessionStorage.setItem("aw:diary-y:" + path, String(window.scrollY)); window.addEventListener("scroll", on, { passive: true }); return () => window.removeEventListener("scroll", on); }, [path]);

  const entries = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.entries ?? []).filter((e) => (!kind || e.kind === kind) && (!fav || e.is_favorite) && (!s || [e.title, e.occasion, e.location, e.notes, ...e.tags, ...e.items.map((i) => i.name)].some((x) => x?.toLowerCase().includes(s))));
  }, [data, kind, fav, q]);
  const byDay = useMemo(() => { const m = new Map<string, DiaryEntry[]>(); for (const e of entries) m.set(e.worn_date, [...(m.get(e.worn_date) ?? []), e]); return m; }, [entries]);
  const [y, mo] = month.split("-").map(Number);
  const first = weekday(month + "-01"), dim = daysInMonth(month);
  const cells = [...Array(first).fill(null), ...Array.from({ length: dim }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  const openDay = (d: string) => { set({ d }); setDayOpen(d); };
  const weekStart = addDays(selected ?? today, -weekday(selected ?? today));
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  return (
    <div className="space-y-3 pb-6" data-testid="diary" data-month={month} data-view={view}>
      <div className="flex items-center gap-2 pt-2">
        <h1 className="min-w-0 flex-1 font-serif text-[20px] font-bold tracking-[0.08em] text-gold-soft">穿搭日誌</h1>
        <Link to="/diary/stats" className="chip rounded-full px-3 py-1.5 text-[12px]" data-testid="diary-stats-link">穿著分析</Link>
        <Link to={`/diary/new?date=${selected ?? today}`} className="btn-jewel flex items-center gap-1 rounded-full px-3 py-1.5 text-[13px]" data-testid="diary-new"><IconPlus />記錄</Link>
      </div>
      {data?.offline && <p className="rounded-xl bg-cream/5 px-3 py-1.5 text-[12px]" data-testid="diary-offline">離線：顯示已同步的紀錄（唯讀）。新增及修改需要網絡。</p>}
      {err && !data && <div className="frame p-4 text-[13px]" role="alert">未能讀取日誌：{err}<Button variant="ghost" className="ml-2" onClick={() => setRev((v) => v + 1)}>重試</Button></div>}

      <div className="frame space-y-2 p-3">
        <div className="flex items-center gap-2">
          <button type="button" aria-label="上一個月" data-testid="diary-prev" onClick={() => set({ m: shiftMonth(month, -1), d: null })} className="chip grid h-9 w-9 place-items-center rounded-full">‹</button>
          <p className="flex-1 text-center font-serif text-[17px] text-gold-soft" data-testid="diary-month-label">{y} 年 {mo} 月</p>
          <button type="button" aria-label="下一個月" data-testid="diary-next" onClick={() => set({ m: shiftMonth(month, 1), d: null })} className="chip grid h-9 w-9 place-items-center rounded-full">›</button>
          <button type="button" data-testid="diary-today" onClick={() => set({ m: monthOf(today), d: today })} className="chip h-9 rounded-full px-3 text-[12px]">今天</button>
        </div>
        <div className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1" role="tablist" aria-label="顯示方式">
          {VIEWS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={view === k} data-view-tab={k} onClick={() => { try { localStorage.setItem("aw:diary-view", k); } catch { /* ignore */ } set({ view: k }); }} className={`h-8 shrink-0 rounded-full px-3 text-[12px] ${view === k ? "chip-on" : "chip"}`}>{l}</button>)}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          {(["", "worn", "planned", "inspiration"] as const).map((k) => <button key={k || "all"} type="button" data-kind={k || "all"} aria-pressed={kind === k} onClick={() => set({ kind: k || null })} className={`h-7 rounded-full px-2.5 ${kind === k ? "chip-on" : "chip"}`}>{k ? `${KIND_ICON[k]} ${KIND_LABEL[k]}` : "全部"}</button>)}
          <button type="button" aria-pressed={fav} data-testid="diary-fav" onClick={() => set({ fav: fav ? null : "1" })} className={`h-7 rounded-full px-2.5 ${fav ? "chip-on" : "chip"}`}>♥ 收藏</button>
        </div>
        <div className="relative"><IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--aw-placeholder)]" /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => set({ q: q.trim() || null })} placeholder="搜尋衣物、標籤、場合…" className="field h-9 w-full rounded-full pl-9 pr-3 text-[16px]" data-testid="diary-search" /></div>
      </div>

      {!data ? (!err && <Spinner />) : view === "list" ? (
        <MonthList entries={entries} onOpen={openDay} />
      ) : view === "week" ? (
        <section className="frame space-y-2 p-3" data-testid="diary-week">
          <div className="flex items-center justify-between text-[12px]"><button type="button" className="chip h-8 rounded-full px-3" onClick={() => { const d = addDays(weekStart, -7); set({ d, m: monthOf(d) }); }}>‹ 上一週</button><span className="text-mauve">{fmtDate(week[0])} – {fmtDate(week[6])}</span><button type="button" className="chip h-8 rounded-full px-3" onClick={() => { const d = addDays(weekStart, 7); set({ d, m: monthOf(d) }); }}>下一週 ›</button></div>
          {week.map((d) => <DayRow key={d} date={d} today={today} list={byDay.get(d) ?? []} onOpen={() => openDay(d)} />)}
          {week.some((d) => monthOf(d) !== month) && <p className="text-[11px] text-mauve">跨月份的日子只顯示目前月份已載入的紀錄。</p>}
        </section>
      ) : (
        <section className="frame p-2" data-testid="diary-calendar">
          <div className="grid grid-cols-7 text-center text-[11px] text-mauve">{"日一二三四五六".split("").map((w) => <span key={w} className="py-1">{w}</span>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {cells.map((d, i) => d == null ? <span key={"x" + i} /> : (
              <button key={d} type="button" data-day={d} data-count={byDay.get(d)?.length ?? 0} aria-current={d === today ? "date" : undefined} aria-pressed={d === selected} onClick={() => openDay(d)}
                className={`relative flex flex-col items-center overflow-hidden rounded-xl text-[12px] ${view === "photo" ? "aspect-[3/4]" : "h-12"} ${d === selected ? "ring-2 ring-[var(--aw-focus)]" : ""} ${d === today ? "chip-on" : "bg-cream/5"}`}>
                {view === "photo" && byDay.get(d)?.length ? (() => { const e = byDay.get(d)![0]; const c = coverOf(e); return c ? <img src={c} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : null; })() : null}
                <span className={`relative z-10 mt-0.5 rounded-full px-1 ${view === "photo" && byDay.get(d)?.length ? "bg-black/45 text-white" : ""}`} data-status-color={view === "photo" && byDay.get(d)?.length ? true : undefined}>{Number(d.slice(8))}</span>
                {(byDay.get(d)?.length ?? 0) > 0 && (
                  <span className="relative z-10 mt-auto mb-1 flex items-center gap-0.5">
                    {[...new Set(byDay.get(d)!.map((e) => e.kind))].map((k) => <span key={k} title={KIND_LABEL[k]} className={`h-1.5 w-1.5 rounded-full ${KIND_CLASS[k]}`} data-kind-dot={k} />)}
                    {byDay.get(d)!.length > 1 && <span className={`text-[9.5px] ${view === "photo" ? "rounded bg-black/45 px-0.5 text-white" : "text-mauve"}`} data-status-color={view === "photo" ? true : undefined}>{byDay.get(d)!.length}</span>}
                  </span>
                )}
              </button>
            ))}
          </div>
          <p className="mt-2 flex flex-wrap gap-3 px-1 text-[11px] text-mauve">{(["worn", "planned", "inspiration"] as const).map((k) => <span key={k} className="flex items-center gap-1"><span className={`h-2 w-2 rounded-full ${KIND_CLASS[k]}`} />{KIND_LABEL[k]}</span>)}</p>
        </section>
      )}
      {data && !entries.length && <Empty title={data.entries.length ? "沒有符合篩選的紀錄" : "這個月份未有穿搭紀錄"}>點擊日期或「記錄」新增今天的穿搭。</Empty>}
      {dayOpen && <DaySheet date={dayOpen} list={byDay.get(dayOpen) ?? []} offline={!!data?.offline} onClose={() => setDayOpen(null)} onChanged={() => setRev((v) => v + 1)} />}
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
    <div className="frame flex gap-3 p-2.5" data-entry={e.id} data-kind={e.kind}>
      <Link to={`/diary/${e.id}`} className="block h-24 w-[4.5rem] shrink-0 overflow-hidden rounded-xl bg-cream/5">{c ? <img src={c} alt="" loading="lazy" className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center text-[11px] text-mauve">沒有圖片</span>}</Link>
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
        {list.map((e) => (
          <EntryCard key={e.id} e={e} actions={offline ? null : <>
            <Link to={`/diary/${e.id}/edit`} className="chip rounded-full px-2.5 py-0.5 text-[11.5px]">編輯</Link>
            {e.kind === "planned" && <button type="button" disabled={busy} data-testid="diary-mark-worn" className="chip rounded-full px-2.5 py-0.5 text-[11.5px]" onClick={() => void run(() => diaryApi.update(e.id, { kind: "worn", base_updated_at: e.updated_at }), "已標記為已穿著")}>標記已穿著</button>}
            <button type="button" disabled={busy} className="chip rounded-full px-2.5 py-0.5 text-[11.5px]" data-testid="diary-copy" onClick={() => setCopy(e)}>複製到…</button>
            <button type="button" disabled={busy} className="chip rounded-full px-2.5 py-0.5 text-[11.5px]" onClick={() => { if (confirm("刪除這筆紀錄？照片亦會刪除。")) void run(() => diaryApi.remove(e.id), "已刪除"); }}>刪除</button>
          </>} />
        ))}
        {!list.length && <p className="py-3 text-center text-[13px] text-mauve">這一天未有紀錄。</p>}
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
