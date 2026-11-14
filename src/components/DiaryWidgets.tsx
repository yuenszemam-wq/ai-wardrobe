// Phase 3.9A.1：首頁穿搭日誌元件。只在首頁有這些元件時才讀取資料；離線時使用本機副本；讀取失敗只影響該元件。
import { ReactNode, useEffect, useState } from "react";
import { Widget } from "../../shared/homeLayout";
import { cachedApi } from "../localWardrobe";
import { DiaryEntry, KIND_LABEL, daysInMonth, fmtDate, localDate, monthOf, weekday } from "../diary";
import { coverOf } from "../pages/Diary";
import { Link } from "./ui";

interface Stat { id: string; name: string; worn_days: number; last: string | null; days_since: number | null; primary_image_id: string | null }
interface Stats { record_days: number; distinct_garments: number; active_garments: number; usage_rate: number | null; most_worn: Stat[]; least_recent: Stat[]; diary_since: string | null }
// 同一次開啟首頁的多個元件共用同一個請求（60 秒內不重複讀取）
const cache = new Map<string, { at: number; p: Promise<unknown> }>();
function shared<T>(path: string, key: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < 60_000) return hit.p as Promise<T>;
  const p = cachedApi<T>(path, key).then((r) => r.data);
  cache.set(path, { at: Date.now(), p });
  p.catch(() => cache.delete(path));
  return p;
}
function useShared<T>(path: string, key: string) {
  const [v, setV] = useState<{ data?: T; err?: string }>({});
  useEffect(() => { let live = true; shared<T>(path, key).then((data) => live && setV({ data })).catch((e) => live && setV({ err: (e as Error).message })); return () => { live = false; }; }, [path, key]);
  return v;
}

export function DiaryWidget({ w, editing }: { w: Widget; editing: boolean }) {
  const today = localDate(), month = monthOf(today);
  const needMonth = ["diary_today", "diary_recent", "diary_calendar"].includes(w.type);
  const m = useShared<{ entries: DiaryEntry[] }>(needMonth ? `/api/diary?month=${month}&order=asc&limit=500` : `/api/diary/stats?today=${today}`, needMonth ? "diary:" + month : "diary-stats");
  const title = w.opts.title === false ? null : <h3 className="mb-1.5 font-serif text-[14px] text-gold-soft">{LABELS[w.type]}</h3>;
  const box = (body: ReactNode) => <section className="frame p-3" data-testid={"w-" + w.type}>{title}{body}</section>;
  if (m.err) return box(<p className="text-[12px] text-mauve">未能讀取：{m.err}</p>);
  if (!m.data) return <section className="h-20 animate-pulse rounded-2xl bg-cream/5" data-testid={"w-" + w.type} />;
  if (needMonth) {
    const entries = (m.data as { entries: DiaryEntry[] }).entries;
    if (w.type === "diary_today") {
      const list = entries.filter((e) => e.worn_date === today);
      const e = list[0];
      if (e && w.display === "list") return box(<ul className="space-y-1 text-[12.5px]">{list.map((x) => <li key={x.id}><Link to={`/diary/${x.id}`} className="flex justify-between gap-2"><span className="truncate">{x.title || KIND_LABEL[x.kind]}</span><span className="text-mauve">{x.worn_time ?? ""}</span></Link></li>)}</ul>);
      if (e && w.display === "photo" && coverOf(e)) return box(<Link to={`/diary/${e.id}`} className="block"><img src={coverOf(e)!} alt="" className="aspect-[3/4] w-full rounded-2xl object-cover" /><span className="mt-1 block truncate text-[12.5px]">{e.title || KIND_LABEL[e.kind]}</span></Link>);
      return box(e ? (
        <Link to={`/diary/${e.id}`} className="flex items-center gap-3">
          {coverOf(e) ? <img src={coverOf(e)!} alt="" className={`${w.display === "mini" ? "h-16 w-12" : "h-24 w-[4.5rem]"} rounded-xl object-cover`} /> : null}
          <span className="min-w-0 text-[12.5px]"><b className="block truncate text-[14px]">{e.title || KIND_LABEL[e.kind]}</b>{e.garment_count} 件衣物{list.length > 1 ? `｜今天共 ${list.length} 套` : ""}</span>
        </Link>
      ) : <Link to="/diary/new" className="btn-jewel flex h-10 items-center justify-center rounded-full text-[13px]" data-testid="w-diary-record">記錄今日穿搭</Link>);
    }
    if (w.type === "diary_recent") {
      const list = [...entries].sort((a, b) => b.worn_date.localeCompare(a.worn_date)).slice(0, w.display === "hero" ? 1 : w.opts.count ?? 6);
      if (!list.length) return editing ? box(<p className="text-[12px] text-mauve">本月未有紀錄</p>) : null;
      if (w.display === "grid2") return box(<div className="grid grid-cols-2 gap-2">{list.map((e) => <Link key={e.id} to={`/diary/${e.id}`} className="text-center text-[11px]"><span className="block aspect-[3/4] overflow-hidden rounded-xl bg-cream/5">{coverOf(e) ? <img src={coverOf(e)!} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}</span>{e.worn_date.slice(5)}</Link>)}</div>);
      return box(w.display === "list" ? <ul className="space-y-1 text-[12.5px]">{list.map((e) => <li key={e.id}><Link to={`/diary/${e.id}`} className="flex justify-between gap-2"><span className="truncate">{e.title || KIND_LABEL[e.kind]}</span><span className="text-mauve">{e.worn_date.slice(5)}</span></Link></li>)}</ul>
        : <div className="scrollbar-none -mx-1 flex gap-2 overflow-x-auto px-1">{list.map((e) => <Link key={e.id} to={`/diary/${e.id}`} className="w-24 shrink-0 text-center text-[11px]"><span className="block aspect-[3/4] overflow-hidden rounded-xl bg-cream/5">{coverOf(e) ? <img src={coverOf(e)!} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}</span>{e.worn_date.slice(5)}</Link>)}</div>);
    }
    // 本月月曆
    const by = new Map<string, number>(); for (const e of entries) by.set(e.worn_date, (by.get(e.worn_date) ?? 0) + 1);
    const first = weekday(month + "-01"), dim = daysInMonth(month);
    if (w.display === "count") return box(<Link to="/diary" className="block text-center"><b className="font-serif text-[24px] text-gold-soft">{by.size}</b><span className="block text-[11px] text-mauve">本月記錄日數</span></Link>);
    if (w.display === "week") {
      const [yy, mm, dd] = today.split("-").map(Number);
      const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(yy, mm - 1, dd - weekday(today) + i); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
      return box(<Link to="/diary?view=week" className="grid grid-cols-7 gap-1 text-center text-[11px]">{days.map((d) => <span key={d} className={`rounded-lg py-1 ${d === today ? "chip-on" : "bg-cream/5"}`}>{"日一二三四五六"[weekday(d)]}<b className="block">{Number(d.slice(8))}</b><span className={`mx-auto block h-1.5 w-1.5 rounded-full ${by.get(d) ? "bg-[var(--aw-chart-1)]" : ""}`} /></span>)}</Link>);
    }
    return box(
      <Link to="/diary" className="block">
        <div className="grid grid-cols-7 gap-0.5 text-center text-[10.5px]">
          {"日一二三四五六".split("").map((x) => <span key={x} className="text-mauve">{x}</span>)}
          {Array.from({ length: first }, (_, i) => <span key={"x" + i} />)}
          {Array.from({ length: dim }, (_, i) => { const d = `${month}-${String(i + 1).padStart(2, "0")}`; const n = by.get(d) ?? 0; return <span key={d} className={`rounded-md py-0.5 ${d === today ? "chip-on" : ""}`}>{i + 1}<span className={`mx-auto block h-1 w-1 rounded-full ${n ? "bg-[var(--aw-chart-1)]" : ""}`} /></span>; })}
        </div>
        <p className="mt-1 text-[11px] text-mauve">本月 {by.size} 日有紀錄</p>
      </Link>);
  }
  const s = m.data as Stats;
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
export const LABELS: Record<string, string> = { diary_today: "今日穿搭", diary_recent: "最近穿搭日誌", diary_calendar: "本月穿搭日曆", diary_usage: "本月衣櫃使用率", most_worn: "最常穿衣物", least_worn: "最近未穿衣物" };
export const isDiaryWidget = (t: string) => t in LABELS;
