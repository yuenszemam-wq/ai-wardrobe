// Phase 3.9A.1：穿搭紀錄詳情、穿著分析頁。
import { useEffect, useState } from "react";
import { api } from "../api";
import { Bars } from "../components/charts";
import { Button, Link, Spinner, toast } from "../components/ui";
import { DiaryEntry, KIND_ICON, KIND_LABEL, diaryApi, fmtDate, loadEntry, localDate, monthOf, photoFull, photoThumb, snapUrl } from "../diary";
import { navigate } from "../router";

export function DiaryDetail({ id }: { id: string }) {
  const [e, setE] = useState<DiaryEntry | null>(null);
  const [offline, setOffline] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [big, setBig] = useState<string | null>(null);
  useEffect(() => { loadEntry(id).then((r) => { setE(r.data); setOffline(r.offline); }).catch((x) => setErr((x as Error).message)); }, [id]);
  if (err) return <div className="frame mt-3 p-4 text-[13px]" role="alert">未能讀取：{err}<Link to="/diary" className="ml-2 underline">返回日誌</Link></div>;
  if (!e) return <Spinner />;
  const photos = [...e.photos].sort((a, b) => (a.id === e.cover_photo_id ? -1 : b.id === e.cover_photo_id ? 1 : a.position - b.position));
  return (
    <div className="space-y-3 pb-10" data-testid="diary-detail" data-entry={e.id}>
      <div className="flex items-center gap-2 pt-2">
        <Link to={`/diary?m=${monthOf(e.worn_date)}&d=${e.worn_date}`} className="chip grid h-9 w-9 place-items-center rounded-full" aria-label="返回">‹</Link>
        <h1 className="min-w-0 flex-1 truncate font-serif text-[19px] font-bold text-gold-soft">{e.is_favorite ? "♥ " : ""}{e.title || e.source_name || KIND_LABEL[e.kind]}</h1>
        {!offline && <Link to={`/diary/${e.id}/edit`} className="chip rounded-full px-3 py-1.5 text-[12px]">修改</Link>}
      </div>
      <p className="text-[12.5px] text-mauve">{fmtDate(e.worn_date)}{e.worn_time ? " " + e.worn_time : ""}｜{KIND_ICON[e.kind]} {KIND_LABEL[e.kind]}{e.occasion ? "｜" + e.occasion : ""}{e.weather ? "｜" + e.weather : ""}{e.location ? "｜" + e.location : ""}</p>
      {photos.length > 0 && <div className="scrollbar-none -mx-4 flex snap-x gap-2 overflow-x-auto px-4">{photos.map((p) => <button key={p.id} type="button" onClick={() => setBig(p.id)} className="shrink-0 snap-start"><img src={photoThumb(p.id)} alt="" className="h-56 rounded-2xl object-cover" style={{ aspectRatio: `${p.width}/${p.height}` }} /></button>)}</div>}
      {e.tags.length > 0 && <p className="flex flex-wrap gap-1 text-[12px]">{e.tags.map((t) => <span key={t} className="chip rounded-full px-2 py-0.5">#{t}</span>)}</p>}
      <section className="frame space-y-2 p-3">
        <h3 className="font-serif text-[14px] text-gold-soft">穿著衣物（{e.garment_count} 件）</h3>
        <ul className="grid grid-cols-4 gap-2">
          {e.items.map((i) => (
            <li key={i.garment_id + i.part} className="text-center text-[10.5px]">
              <Link to={`/g/${i.garment_id}`} className="block"><div className="arch-base aspect-[3/4] overflow-hidden rounded-xl">{i.snap_id ? <img src={snapUrl(i.snap_id)} alt="" className="h-full w-full object-contain" /> : null}</div><p className="truncate">{i.name}</p></Link>
            </li>
          ))}
        </ul>
        {e.outfit_id && <Link to={`/outfits/${e.outfit_id}`} className="text-[12px] underline">打開原本的衣服配搭</Link>}
        {e.look_id && <Link to={`/dressing/${e.look_id}`} className="text-[12px] underline">打開原本的角色造型</Link>}
        <p className="text-[11px] text-mauve">名稱及縮圖是記錄當時的快照；之後修改或刪除衣物，這筆紀錄仍會保留。</p>
      </section>
      {e.notes && <p className="frame whitespace-pre-wrap p-3 text-[13px]">{e.notes}</p>}
      {!offline && <div className="flex flex-wrap gap-2">
        {e.kind === "planned" && <Button onClick={async () => { try { setE(await diaryApi.update(e.id, { kind: "worn", base_updated_at: e.updated_at })); toast("已標記為已穿著"); } catch (x) { toast((x as Error).message, "err"); } }}>標記為已穿著</Button>}
        <Button variant="ghost" onClick={async () => { const d = prompt("複製到哪一天？（YYYY-MM-DD）", localDate()); if (!d) return; try { const n = await diaryApi.duplicate(e.id, { worn_date: d, kind: d > localDate() ? "planned" : e.kind }); navigate(`/diary/${n.id}`); } catch (x) { toast((x as Error).message, "err"); } }}>複製到另一日期</Button>
        <Button variant="danger" onClick={async () => { if (!confirm("刪除這筆紀錄？照片亦會刪除。")) return; try { await diaryApi.remove(e.id); navigate(`/diary?m=${monthOf(e.worn_date)}`, true); } catch (x) { toast((x as Error).message, "err"); } }}>刪除</Button>
      </div>}
      {big && <div className="fixed inset-0 z-50 grid place-items-center bg-black/90 p-3" role="dialog" aria-label="照片" onClick={() => setBig(null)}><img src={photoFull(big)} alt="" className="max-h-full max-w-full object-contain" /></div>}
    </div>
  );
}

interface Stat { id: string; name: string; category: string | null; primary_image_id: string | null; price: number | null; worn_days: number; month: number; last: string | null; days_since: number | null; cost_per_wear: number | null }
interface Stats { month: string; today: string; diary_since: string | null; record_days: number; distinct_garments: number; active_garments: number; usage_rate: number | null; most_worn: Stat[]; least_recent: Stat[]; never_recorded: Stat[]; never_recorded_count: number; by_category: { name: string; n: number }[]; by_style: { name: string; n: number }[]; cost_per_wear: Stat[]; cost_unknown: number }

export function DiaryStats() {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<Stats>(`/api/diary/stats?today=${localDate()}`).then(setS).catch((x) => setErr((x as Error).message)); }, []);
  if (err) return <div className="frame mt-3 p-4 text-[13px]" role="alert">未能讀取：{err}</div>;
  if (!s) return <Spinner />;
  const row = (g: Stat, sub: string) => <li key={g.id}><Link to={`/g/${g.id}`} className="flex items-center justify-between gap-2 py-1 text-[12.5px]"><span className="truncate">{g.name}</span><span className="shrink-0 text-mauve">{sub}</span></Link></li>;
  return (
    <div className="space-y-3 pb-10" data-testid="diary-stats">
      <div className="flex items-center gap-2 pt-2"><Link to="/diary" className="chip grid h-9 w-9 place-items-center rounded-full" aria-label="返回">‹</Link><h1 className="flex-1 font-serif text-[19px] font-bold text-gold-soft">穿著分析｜{s.month}</h1></div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="frame p-2"><b className="block font-serif text-[20px] text-gold-soft" data-testid="stat-days">{s.record_days}</b><span className="text-[11px] text-mauve">本月記錄天數</span></div>
        <div className="frame p-2"><b className="block font-serif text-[20px] text-gold-soft">{s.distinct_garments}</b><span className="text-[11px] text-mauve">穿過的衣物</span></div>
        <div className="frame p-2"><b className="block font-serif text-[20px] text-gold-soft" data-testid="stat-usage">{s.usage_rate == null ? "—" : Math.round(s.usage_rate * 1000) / 10 + "%"}</b><span className="text-[11px] text-mauve">衣櫃使用率</span></div>
      </div>
      <p className="text-[11px] text-mauve">只計「已穿著」紀錄；同一件衣物同一天只計一次；套裝部件不另計。日誌由 {s.diary_since ?? "—"} 開始，之前的穿著未有紀錄，所以「尚未記錄穿著」不代表從未穿過。</p>
      <section className="frame p-3"><h3 className="mb-1 font-serif text-[14px] text-gold-soft">最常穿</h3><ul>{s.most_worn.map((g) => row(g, `${g.worn_days} 次`))}</ul>{!s.most_worn.length && <p className="text-[12px] text-mauve">未有已穿著紀錄。</p>}</section>
      <section className="frame p-3"><h3 className="mb-1 font-serif text-[14px] text-gold-soft">最久未穿（已有紀錄）</h3><ul>{s.least_recent.map((g) => row(g, `${g.days_since} 日前`))}</ul></section>
      <section className="frame p-3" data-testid="stat-never"><h3 className="mb-1 font-serif text-[14px] text-gold-soft">尚未記錄穿著（{s.never_recorded_count} 件）</h3><ul>{s.never_recorded.slice(0, 15).map((g) => row(g, g.category ?? ""))}</ul></section>
      <section className="frame p-3"><h3 className="mb-2 font-serif text-[14px] text-gold-soft">本月各分類穿著次數</h3><Bars rows={s.by_category} /></section>
      <section className="frame p-3"><h3 className="mb-2 font-serif text-[14px] text-gold-soft">本月風格比例</h3><Bars rows={s.by_style} /></section>
      <section className="frame p-3"><h3 className="mb-1 font-serif text-[14px] text-gold-soft">每次穿著成本（最低）</h3><ul>{s.cost_per_wear.map((g) => row(g, `HK$${g.cost_per_wear}（${g.worn_days} 次）`))}</ul><p className="text-[11px] text-mauve">購買價格 ÷ 穿著日數。{s.cost_unknown} 件已穿衣物未填價格，未計算（不當作零元）。</p></section>
    </div>
  );
}
