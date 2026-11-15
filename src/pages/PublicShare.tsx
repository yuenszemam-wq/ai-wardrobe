/**
 * Phase 3.9B.1：公開分享頁（/s/<連結>）。不需要登入，只顯示擁有者選擇公開的衣物及欄位。
 * 不使用 App 的私人快取（圖片、本機衣櫃），亦不會載入任何私人 API。連結撤銷或到期後顯示「已停止分享」。
 */
import { Fragment, useEffect, useMemo, useState } from "react";

interface PublicGarment { id: string; name?: string; category?: string | null; subcategory?: string | null; brand?: string | null; colors?: string[]; style?: string | null; season?: string | null; pattern?: string | null; price?: number | null; notes?: string | null; attributes?: Record<string, unknown>; wear_count?: number; has_thumb: boolean; has_image: boolean }
interface Stat { label: string; n: number }
interface PublicData { title: string; message: string | null; fields: string[]; expires_at: string | null; garments: PublicGarment[]; analytics: null | { total: number; by_category?: Stat[]; by_color?: Stat[]; by_brand?: Stat[]; by_style?: Stat[]; price?: { priced: number; total: number; average: number | null }; most_worn?: { id: string; n: number }[] } }

function Bars({ title, data }: { title: string; data?: Stat[] }) {
  if (!data?.length) return null;
  const max = Math.max(...data.map((d) => d.n));
  return (
    <div className="space-y-1" data-share-stat={title}>
      <p className="text-[12px] text-mauve">{title}</p>
      {data.slice(0, 6).map((d) => <div key={d.label} className="flex items-center gap-2 text-[12px]"><span className="w-16 shrink-0 truncate">{d.label}</span><span className="h-2 rounded-full" style={{ width: `${Math.max(6, (d.n / max) * 100)}%`, background: "var(--aw-chart)" }} /><span className="w-6 text-right tabular-nums">{d.n}</span></div>)}
    </div>
  );
}

export default function PublicShare({ token }: { token: string }) {
  const [data, setData] = useState<PublicData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cat, setCat] = useState("");
  const [open, setOpen] = useState<PublicGarment | null>(null);
  useEffect(() => {
    fetch(`/api/share/${encodeURIComponent(token)}`, { credentials: "omit" }).then(async (r) => { const j = await r.json().catch(() => null); if (!r.ok) throw new Error(j?.error?.message || "連結無效或已停止分享"); setData(j); document.title = `${j.title}｜衣櫃分享`; }).catch((e) => setErr((e as Error).message));
  }, [token]);
  const cats = useMemo(() => [...new Set((data?.garments ?? []).map((g) => g.category).filter((x): x is string => !!x))], [data]);
  const list = (data?.garments ?? []).filter((g) => !cat || g.category === cat);
  const img = (g: PublicGarment, kind: "thumb" | "image") => `/api/share/${encodeURIComponent(token)}/${kind}/${g.id}`;
  if (err) return <div className="grid min-h-screen place-items-center px-6 text-center" data-testid="share-error"><div><p className="font-serif text-[20px] text-gold-soft">已停止分享</p><p className="mt-2 text-[13px] text-mauve">{err}</p></div></div>;
  if (!data) return <div className="grid min-h-screen place-items-center text-mauve">載入中…</div>;
  const a = data.analytics;
  return (
    <div className="mx-auto min-h-screen max-w-3xl px-4 pb-16 pt-[calc(env(safe-area-inset-top)+1rem)]" data-testid="public-share" data-count={data.garments.length}>
      <h1 className="font-serif text-[24px] font-bold tracking-[0.1em] text-gold-soft">{data.title}</h1>
      {data.message && <p className="mt-1 whitespace-pre-wrap text-[13px] text-cream/85">{data.message}</p>}
      <p className="mt-1 text-[11px] text-mauve">共 {data.garments.length} 件・唯讀分享{data.expires_at ? `・${new Date(data.expires_at).toLocaleDateString("zh-HK")} 到期` : ""}</p>
      {a && (
        <section className="paper mt-3 grid gap-3 p-3 sm:grid-cols-2" data-testid="share-analytics">
          <Bars title="分類" data={a.by_category} /><Bars title="顏色" data={a.by_color} /><Bars title="品牌" data={a.by_brand} /><Bars title="風格" data={a.by_style} />
          {a.price && <p className="text-[12px]" data-testid="share-price">已標價 {a.price.priced} 件・總值 HK${a.price.total.toLocaleString()}{a.price.average !== null ? `・平均 HK$${a.price.average.toLocaleString()}` : ""}</p>}
        </section>
      )}
      {cats.length > 1 && <div className="scrollbar-none -mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4">{["", ...cats].map((c) => <button key={c || "all"} type="button" aria-pressed={cat === c} onClick={() => setCat(c)} className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] ${cat === c ? "chip-on" : "chip"}`}>{c || "全部"}</button>)}</div>}
      <div className="mt-3 grid grid-cols-3 gap-2.5 sm:grid-cols-4" data-testid="share-grid">
        {list.map((g) => (
          <button key={g.id} type="button" onClick={() => setOpen(g)} className="text-left" data-share-garment={g.id}>
            <span className="arch-base checker block aspect-[3/4] overflow-hidden rounded-xl">{g.has_thumb && <img src={img(g, "thumb")} alt={g.name ?? ""} loading="lazy" className="h-full w-full object-contain p-1" />}</span>
            {g.name && <span className="mt-0.5 block truncate text-[11.5px]">{g.name}</span>}
          </button>
        ))}
      </div>
      {!list.length && <p className="py-10 text-center text-[13px] text-mauve">沒有公開的衣物</p>}
      {open && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50" onClick={() => setOpen(null)} role="dialog" aria-label={open.name ?? "衣物"} data-testid="share-detail">
          <div className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl p-4" style={{ background: "var(--aw-sheet)" }} onClick={(e) => e.stopPropagation()}>
            <div className="checker mx-auto aspect-[3/4] w-full max-w-xs overflow-hidden rounded-2xl"><img src={img(open, open.has_image ? "image" : "thumb")} alt="" className="h-full w-full object-contain" data-testid="share-detail-img" /></div>
            {open.name && <h2 className="mt-2 font-serif text-[18px] font-bold text-gold-soft">{open.name}</h2>}
            <dl className="mt-1 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-[12.5px]" data-testid="share-fields">
              {([["分類", [open.category, open.subcategory].filter(Boolean).join("・")], ["品牌", open.brand], ["顏色", open.colors?.join("、")], ["風格", open.style], ["季節", open.season], ["圖案", open.pattern], ["價格", open.price != null ? `HK$${open.price}` : null], ["穿著", open.wear_count !== undefined ? `${open.wear_count} 次` : null], ["備註", open.notes]] as [string, string | null | undefined][]).filter(([, v]) => v).map(([k, v]) => <Fragment key={k}><dt className="text-mauve">{k}</dt><dd>{v}</dd></Fragment>)}
            </dl>
            <button type="button" className="chip mt-3 h-10 w-full rounded-full" onClick={() => setOpen(null)}>關閉</button>
          </div>
        </div>
      )}
    </div>
  );
}
