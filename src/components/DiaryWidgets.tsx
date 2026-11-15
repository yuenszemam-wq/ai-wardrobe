// Phase 3.9A.1／3.9A.1.1：首頁穿搭日誌元件。只在首頁有這些元件時才讀取資料；離線時使用本機副本；讀取失敗只影響該元件。
// 3.9A.1.1：照片月曆／照片週曆（共用封面解析）、最近紀錄不限本月、本週跨月／跨年讀取完整 7 日、
// 共用快取按帳戶分開，新增／修改／刪除日誌後立即重新讀取（不必等 60 秒逾時）。
import { ReactNode, useEffect, useState } from "react";
import { Widget } from "../../shared/homeLayout";
import { DIARY_CHANGED, DiaryEntry, KIND_ICON, KIND_LABEL, addDays, daysInMonth, fmtDate, localDate, monthOf, sharedApi, weekday } from "../diary";
import { Cover, CoverMode, coverSrc, resolveCover } from "../diaryCover";
import { Link } from "./ui";

interface Stat { id: string; name: string; worn_days: number; last: string | null; days_since: number | null; primary_image_id: string | null }
interface Stats { record_days: number; distinct_garments: number; active_garments: number; usage_rate: number | null; most_worn: Stat[]; least_recent: Stat[]; diary_since: string | null }
function useShared<T>(path: string, key: string) {
  const [v, setV] = useState<{ data?: T; err?: string }>({});
  useEffect(() => {
    let live = true;
    const load = () => sharedApi<T>(path, key).then((data) => live && setV({ data })).catch((e) => live && setV((cur) => (cur.data ? cur : { err: (e as Error).message })));
    load();
    window.addEventListener(DIARY_CHANGED, load);
    return () => { live = false; window.removeEventListener(DIARY_CHANGED, load); };
  }, [path, key]);
  return v;
}
const dayLink = (d: string) => `/diary?m=${monthOf(d)}&d=${d}&open=1`;
const weekOf = (today: string) => { const start = addDays(today, -weekday(today)); return Array.from({ length: 7 }, (_, i) => addDays(start, i)); };
/** 各元件需要的資料範圍（最近紀錄不限本月；週曆讀取完整 7 日，可跨月及跨年） */
function sourceOf(w: Widget, today: string): [string, string] {
  const month = monthOf(today);
  if (w.type === "diary_recent") { const n = w.display === "hero" ? 1 : w.opts.count ?? 6; return [`/api/diary?to=${today}&order=desc&limit=${Math.min(24, n)}`, "diary-recent:" + n]; }
  if (w.type === "diary_today") return [`/api/diary?from=${today}&to=${today}&order=asc&limit=50`, "diary-day:" + today];
  if (w.type === "diary_calendar" && (w.display === "week" || w.display === "photo_week")) { const wk = weekOf(today); return [`/api/diary?from=${wk[0]}&to=${wk[6]}&order=asc&limit=200`, `diary-range:${wk[0]}:${wk[6]}`]; }
  if (w.type === "diary_calendar") return [`/api/diary?month=${month}&order=asc&limit=500`, "diary:" + month];
  return [`/api/diary/stats?today=${today}`, "diary-stats"];
}

export function DiaryWidget({ w, editing }: { w: Widget; editing: boolean }) {
  const today = localDate(), month = monthOf(today);
  const isList = ["diary_today", "diary_recent", "diary_calendar"].includes(w.type);
  const [path, key] = sourceOf(w, today);
  const m = useShared<{ entries: DiaryEntry[] }>(path, key);
  const mode = (w.opts.cover ?? "auto") as CoverMode;
  const cover = (e: DiaryEntry) => coverSrc(e, mode);
  const coverFull = (e: DiaryEntry) => resolveCover(e, mode);
  const title = w.opts.title === false ? null : <h3 className="mb-1.5 font-serif text-[14px] text-gold-soft">{LABELS[w.type]}</h3>;
  const box = (body: ReactNode) => <section className="frame p-3" data-testid={"w-" + w.type} data-display={w.display}>{title}{body}</section>;
  if (m.err) return box(<p className="text-[12px] text-mauve">未能讀取：{m.err}</p>);
  if (!m.data) return <section className="h-20 animate-pulse rounded-2xl bg-cream/5" data-testid={"w-" + w.type} />;
  if (isList) {
    const entries = (m.data as { entries: DiaryEntry[] }).entries;
    if (w.type === "diary_today") {
      const list = entries.filter((e) => e.worn_date === today);
      const e = list[0];
      if (e && w.display === "list") return box(<ul className="space-y-1 text-[12.5px]">{list.map((x) => <li key={x.id}><Link to={`/diary/${x.id}`} className="flex justify-between gap-2"><span className="truncate">{x.title || KIND_LABEL[x.kind]}</span><span className="text-mauve">{x.worn_time ?? ""}</span></Link></li>)}</ul>);
      if (e && w.display === "photo" && cover(e)) return box(<Link to={`/diary/${e.id}`} className="block"><img src={cover(e)!} alt="" className="aspect-[3/4] w-full rounded-2xl object-cover" /><span className="mt-1 block truncate text-[12.5px]">{e.title || KIND_LABEL[e.kind]}</span></Link>);
      return box(e ? (
        <Link to={`/diary/${e.id}`} className="flex items-center gap-3">
          {cover(e) ? <img src={cover(e)!} alt="" className={`${w.display === "mini" ? "h-16 w-12" : "h-24 w-[4.5rem]"} rounded-xl object-cover`} /> : null}
          <span className="min-w-0 text-[12.5px]"><b className="block truncate text-[14px]">{e.title || KIND_LABEL[e.kind]}</b>{e.garment_count} 件衣物{list.length > 1 ? `｜今天共 ${list.length} 套` : ""}</span>
        </Link>
      ) : <Link to="/diary/new" className="btn-jewel flex h-10 items-center justify-center rounded-full text-[13px]" data-testid="w-diary-record">記錄今日穿搭</Link>);
    }
    if (w.type === "diary_recent") {
      const list = [...entries].sort((a, b) => b.worn_date.localeCompare(a.worn_date) || (b.worn_time ?? "").localeCompare(a.worn_time ?? "")).slice(0, w.display === "hero" ? 1 : w.opts.count ?? 6);
      if (!list.length) return editing ? box(<p className="text-[12px] text-mauve">未有紀錄</p>) : null;
      const thumb = (e: DiaryEntry) => <span className="block aspect-[3/4] overflow-hidden rounded-xl bg-cream/5">{cover(e) ? <img src={cover(e)!} alt="" className="h-full w-full object-cover" loading="lazy" /> : <span className="grid h-full place-items-center text-mauve">{KIND_ICON[e.kind]}</span>}</span>;
      if (w.display === "grid2" || w.display === "hero") return box(<div className={`grid ${w.display === "hero" ? "grid-cols-1" : "grid-cols-2"} gap-2`}>{list.map((e) => <Link key={e.id} to={`/diary/${e.id}`} className="text-center text-[11px]" data-recent={e.worn_date}>{thumb(e)}{e.worn_date.slice(5)}</Link>)}</div>);
      return box(w.display === "list" ? <ul className="space-y-1 text-[12.5px]">{list.map((e) => <li key={e.id} data-recent={e.worn_date}><Link to={`/diary/${e.id}`} className="flex justify-between gap-2"><span className="truncate">{e.title || KIND_LABEL[e.kind]}</span><span className="text-mauve">{e.worn_date.slice(5)}</span></Link></li>)}</ul>
        : <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1">{list.map((e) => <Link key={e.id} to={`/diary/${e.id}`} className="w-24 shrink-0 text-center text-[11px]" data-recent={e.worn_date}>{thumb(e)}{e.worn_date.slice(5)}</Link>)}</div>);
    }
    // 穿搭日曆
    const by = new Map<string, DiaryEntry[]>(); for (const e of entries) by.set(e.worn_date, [...(by.get(e.worn_date) ?? []), e]);
    const first = weekday(month + "-01"), dim = daysInMonth(month);
    const monthDays = Array.from({ length: dim }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
    if (w.display === "count") return box(<Link to="/diary" className="block text-center"><b className="font-serif text-[24px] text-gold-soft">{[...by.keys()].filter((d) => d.startsWith(month)).length}</b><span className="block text-[11px] text-mauve">本月記錄日數</span></Link>);
    if (w.display === "photo_month") return box(<PhotoMonth month={month} today={today} first={first} days={monthDays} by={by} cover={coverFull} />);
    if (w.display === "photo_week") return box(<PhotoWeek days={weekOf(today)} today={today} by={by} cover={coverFull} medium={w.size !== "large"} />);
    if (w.display === "week") {
      const days = weekOf(today);
      return box(<div className="grid grid-cols-7 gap-1 text-center text-[11px]" data-testid="w-week-days">{days.map((d) => <Link key={d} to={dayLink(d)} data-w-day={d} className={`rounded-lg py-1 ${d === today ? "chip-on" : "bg-cream/5"}`}>{"日一二三四五六"[weekday(d)]}<b className="block">{Number(d.slice(8))}</b><span className={`mx-auto block h-1.5 w-1.5 rounded-full ${by.get(d)?.length ? "bg-[var(--aw-chart-1)]" : ""}`} /></Link>)}</div>);
    }
    return box(
      <div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-[10.5px]">
          {"日一二三四五六".split("").map((x) => <span key={x} className="text-mauve">{x}</span>)}
          {Array.from({ length: first }, (_, i) => <span key={"x" + i} />)}
          {monthDays.map((d, i) => { const n = by.get(d)?.length ?? 0; return <Link key={d} to={dayLink(d)} data-w-day={d} className={`rounded-md py-0.5 ${d === today ? "chip-on" : ""}`}>{i + 1}<span className={`mx-auto block h-1 w-1 rounded-full ${n ? "bg-[var(--aw-chart-1)]" : ""}`} /></Link>; })}
        </div>
        <Link to="/diary" className="mt-1 block text-[11px] text-mauve">本月 {by.size} 日有紀錄</Link>
      </div>);
  }
  const s = m.data as unknown as Stats;
  if (w.type === "diary_usage" && w.display === "count") return box(<Link to="/diary/stats" className="block text-center"><b className="font-serif text-[24px] text-gold-soft">{s.distinct_garments}</b><span className="block text-[11px] text-mauve">本月穿過的衣物</span></Link>);
  if (w.type === "diary_usage" && w.display === "bar") return box(<Link to="/diary/stats" className="block text-[12px]"><span className="flex justify-between"><span>本月使用率</span><b>{s.usage_rate == null ? "—" : Math.round(s.usage_rate * 100) + "%"}</b></span><span className="mt-1 block h-2 overflow-hidden rounded-full bg-cream/10"><span className="block h-full rounded-full bg-[var(--aw-chart-1)]" style={{ width: `${Math.min(100, (s.usage_rate ?? 0) * 100)}%` }} /></span><span className="mt-0.5 block text-[11px] text-mauve">{s.distinct_garments}／{s.active_garments} 件</span></Link>);
  if (w.type === "diary_usage") return box(
    <Link to="/diary/stats" className="block text-center">
      <b className="font-serif text-[24px] text-gold-soft">{s.usage_rate == null ? "—" : Math.round(s.usage_rate * 100) + "%"}</b>
      <span className="block text-[11px] text-mauve">本月穿過 {s.distinct_garments}／{s.active_garments} 件{w.display === "numbers" ? `｜記錄 ${s.record_days} 日` : ""}</span>
    </Link>);
  const list = (w.type === "most_worn" ? s.most_worn : s.least_recent).slice(0, w.display === "hero" ? 1 : w.opts.count ?? 5);
  if (!list.length) return editing ? box(<p className="text-[12px] text-mauve">未有已穿著紀錄</p>) : null;
  const sub = (g: Stat) => (w.type === "most_worn" ? `${g.worn_days} 次` : g.last ? g.last.slice(5) : "");
  if (w.display === "grid" || w.display === "carousel") return box(<div className={w.display === "grid" ? "grid grid-cols-3 gap-2" : "scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1"}>{list.map((g) => <Link key={g.id} to={`/g/${g.id}`} className={`text-center text-[10.5px] ${w.display === "carousel" ? "w-20 shrink-0" : ""}`}><span className="arch-base block aspect-[3/4] overflow-hidden rounded-xl">{g.primary_image_id ? <img src={`/api/thumbnails/${g.primary_image_id}`} alt="" className="h-full w-full object-contain" loading="lazy" /> : null}</span><span className="block truncate">{g.name}</span><span className="text-mauve">{sub(g)}</span></Link>)}</div>);
  return box(<ul className="space-y-1 text-[12.5px]">{list.map((g) => <li key={g.id}><Link to={`/g/${g.id}`} className="flex justify-between gap-2"><span className="truncate">{g.name}</span><span className="shrink-0 text-mauve">{w.type === "most_worn" ? `${g.worn_days} 次` : g.last ? fmtDate(g.last) : ""}</span></Link></li>)}</ul>);
}
/** 照片月曆：完整月份，每格固定 3:4 比例（沒有紀錄的日子不會塌縮），同日多套顯示數量 */
function PhotoMonth({ month, today, first, days, by, cover }: { month: string; today: string; first: number; days: string[]; by: Map<string, DiaryEntry[]>; cover: (e: DiaryEntry) => Cover | null }) {
  return (
    <div data-testid="w-photo-month" data-month={month}>
      <div className="grid grid-cols-7 gap-1 text-center text-[10.5px] text-mauve">{"日一二三四五六".split("").map((x) => <span key={x}>{x}</span>)}</div>
      <div className="mt-0.5 grid grid-cols-7 gap-1">
        {Array.from({ length: first }, (_, i) => <span key={"x" + i} />)}
        {days.map((d) => <PhotoCell key={d} d={d} today={today} list={by.get(d) ?? []} cover={cover} />)}
      </div>
      <p className="mt-1 text-[11px] text-mauve">本月 {days.filter((d) => by.get(d)?.length).length} 日有紀錄</p>
    </div>
  );
}
/** 照片週曆：本週 7 日（跨月、跨年） */
function PhotoWeek({ days, today, by, cover, medium }: { days: string[]; today: string; by: Map<string, DiaryEntry[]>; cover: (e: DiaryEntry) => Cover | null; medium: boolean }) {
  return (
    <div data-testid="w-photo-week" data-from={days[0]} data-to={days[6]}>
      <div className="grid grid-cols-7 gap-1 text-center text-[10.5px] text-mauve">{days.map((d) => <span key={d}>{"日一二三四五六"[weekday(d)]}</span>)}</div>
      <div className="mt-0.5 grid grid-cols-7 gap-1">{days.map((d) => <PhotoCell key={d} d={d} today={today} list={by.get(d) ?? []} cover={cover} tall={!medium} showMonth={Number(d.slice(8)) === 1} />)}</div>
    </div>
  );
}
function PhotoCell({ d, today, list, cover, tall = true, showMonth }: { d: string; today: string; list: DiaryEntry[]; cover: (e: DiaryEntry) => Cover | null; tall?: boolean; showMonth?: boolean }) {
  const c = list.length ? cover(list[0]) : null;
  const kinds = [...new Set(list.map((e) => e.kind))];
  return (
    <Link to={dayLink(d)} data-w-day={d} data-count={list.length} aria-label={`${fmtDate(d)}，${list.length} 筆穿搭`}
      className={`relative block overflow-hidden rounded-lg ${tall ? "aspect-[3/4]" : "aspect-square"} ${c ? "" : "bg-cream/5"} ${d === today ? "ring-2 ring-[var(--aw-focus)]" : ""}`}>
      {c && <img src={c.src} alt="" loading="lazy" className={`absolute inset-0 h-full w-full ${c.kind === "garment" ? "arch-base bg-[var(--aw-image)] object-contain p-0.5" : "object-cover"}`} data-cover={c.kind} />}
      <span className={`absolute left-0.5 top-0.5 text-[10.5px] leading-none ${c ? "cal-photo-date" : d === today ? "font-bold text-gold-soft" : ""}`}>{showMonth ? `${Number(d.slice(5, 7))}/` : ""}{Number(d.slice(8))}</span>
      {list.length > 0 && !c && <span className="absolute inset-x-0 bottom-1 flex justify-center gap-0.5">{kinds.map((k) => <span key={k} className={`h-1.5 w-1.5 rounded-full ${k === "worn" ? "bg-[var(--aw-chart-1)]" : k === "planned" ? "border border-[var(--aw-chart-2)]" : "bg-[var(--aw-chart-3)]"}`} />)}</span>}
      {list.length > 1 && <span className="absolute bottom-0.5 right-0.5 rounded bg-black/55 px-0.5 text-[9px] leading-tight text-white" data-status-color>{list.length}</span>}
      {c && list[0].kind !== "worn" && <span className="absolute right-0.5 top-0.5 rounded bg-black/55 px-0.5 text-[9px] leading-tight text-white" data-status-color title={KIND_LABEL[list[0].kind]}>{KIND_ICON[list[0].kind]}</span>}
    </Link>
  );
}

export const LABELS: Record<string, string> = { diary_today: "今日穿搭", diary_recent: "最近穿搭日誌", diary_calendar: "穿搭日曆", diary_usage: "本月衣櫃使用率", most_worn: "最常穿衣物", least_worn: "最近未穿衣物" };
export const isDiaryWidget = (t: string) => t in LABELS;
