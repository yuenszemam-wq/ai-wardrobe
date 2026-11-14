import { WardrobeImage } from "../components/WardrobeImage";
import { ReactNode, useEffect, useState } from "react";
import { api, displayName, imageUrl } from "../api";
import { Bars, Donut, pct, SERIES, swatch, topWithOther } from "../components/charts";
import { IconChevronLeft } from "../components/icons";
import { Empty, Link, money, Spinner } from "../components/ui";
import { navigate } from "../router";

interface Bucket {
  name: string;
  n: number;
  value: number;
}
interface Brief {
  id: string;
  name: string;
  display_no: number | null;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  price: number | null;
  primary_image_id: string | null;
  thumb_image_id: string | null;
  outfits?: number;
}
export interface AnalysisData {
  total: number;
  total_value: number;
  priced_count: number;
  unpriced_count: number;
  avg_price: number | null;
  favorites: number;
  identified: number;
  in_outfits: number;
  never_in_outfit: number;
  by_category: Bucket[];
  by_subcategory: Bucket[];
  by_color: Bucket[];
  by_style: Bucket[];
  by_brand: Bucket[];
  by_season: Bucket[];
  by_month: Bucket[];
  attributes: { id: string; name: string; options: Bucket[] }[];
  price_bands: { label: string; n: number }[];
  top_priced: Brief[];
  most_worn: Brief[];
}

const go = (key: string) => (name: string) => navigate(`/wardrobe?${key}=${encodeURIComponent(name)}`);

export default function Analysis() {
  const [d, setD] = useState<AnalysisData | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<AnalysisData>("/api/analysis").then(setD).catch((e) => setErr(e.message));
  }, []);
  if (err) return <p className="py-10 text-center text-wine">{err}</p>;
  if (!d) return <Spinner />;

  const cats = topWithOther(d.by_category, 7);
  const catValue = d.by_category.filter((c) => c.value > 0).sort((a, b) => b.value - a.value);
  const brands = d.by_brand.filter((b) => b.name !== "未有品牌");
  const noBrand = d.by_brand.find((b) => b.name === "未有品牌")?.n ?? 0;

  return (
    <div>
      <div className="flex items-center justify-between pt-5">
        <button type="button" onClick={() => history.back()} className="btn-dark flex items-center gap-1 rounded-full py-1.5 pl-2 pr-3.5 text-[13px]">
          <IconChevronLeft className="text-[15px]" />
          返回
        </button>
        <h1 className="flex items-center gap-2 font-serif text-[22px] font-bold tracking-[0.14em] text-gold-soft">
          衣櫥分析
        </h1>
        <span className="w-16" />
      </div>

      {d.total === 0 ? (
        <div className="mt-6">
          <Empty title="衣櫃仍然空空的">上傳衣物後，這裡會顯示分類、顏色、風格及價錢分析。</Empty>
        </div>
      ) : (
        <>
          {/* ── 總覽 ── */}
          <section className="frame mt-7 px-4 pb-4 pt-7">
            <div className="flex items-center gap-4">
              <Donut segs={cats} size={148} thickness={16}>
                <div>
                  <div className="font-serif text-[40px] font-bold leading-none text-gold-soft">{d.total}</div>
                  <div className="mt-1 text-[12px] text-mauve">總衣物</div>
                </div>
              </Donut>
              <ul className="min-w-0 flex-1 space-y-2 text-[13px]">
                {cats.map((c, i) => (
                  <li key={c.name}>
                    <Link to={c.name === "其他" || c.name === "未分類" ? "/wardrobe" : `/wardrobe?category=${encodeURIComponent(c.name)}`} className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SERIES[i % SERIES.length] }} />
                        <span className="truncate">{c.name}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-mauve">
                        {c.n}（{pct(c.n, d.total)}）
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <Mini label="收藏" value={String(d.favorites)} />
              <Mini label="已整理" value={pct(d.identified, d.total)} />
              <Mini label="配搭過" value={pct(d.in_outfits, d.total)} />
            </div>
          </section>

          {/* ── 價錢 ── */}
          <Card title="價錢">
            <div className="grid grid-cols-2 gap-2">
              <Big label="衣櫃總價" value={money(d.total_value)} />
              <Big label="平均每件" value={d.avg_price === null ? "—" : money(Math.round(d.avg_price))} />
            </div>
            <p className="mt-2 text-[12px] text-mauve">
              只計算已填價錢的 {d.priced_count} 件
              {d.unpriced_count > 0 && (
                <>
                  ；
                  <Link to="/wardrobe?priced=0" className="text-amethyst-deep underline underline-offset-4">
                    {d.unpriced_count} 件未填價錢
                  </Link>
                </>
              )}
              。
            </p>
            {catValue.length > 0 && (
              <>
                <Sub>各分類總值</Sub>
                <Bars rows={catValue.map((c) => ({ name: c.name, n: c.value, sub: `${c.n} 件` }))} format={money} color="linear-gradient(90deg, var(--aw-chart-3), var(--color-gold-soft))" onPick={go("category")} />
              </>
            )}
            {d.priced_count > 0 && (
              <>
                <Sub>價錢分佈</Sub>
                <div className="flex items-end gap-1.5" style={{ height: 96 }}>
                  {d.price_bands.map((b) => {
                    const top = Math.max(1, ...d.price_bands.map((x) => x.n));
                    return (
                      <div key={b.label} className="flex h-full flex-1 flex-col items-center justify-end">
                        <span className="text-[11px] tabular-nums text-mauve">{b.n || ""}</span>
                        <div className="mt-0.5 w-full rounded-t-md" style={{ height: `${(b.n / top) * 72}px`, minHeight: 2, background: "linear-gradient(180deg, var(--aw-chart), var(--aw-primary))" }} />
                      </div>
                    );
                  })}
                </div>
                <div className="mt-1 flex gap-1.5 text-center text-[10px] leading-tight text-mauve">
                  {d.price_bands.map((b) => (
                    <span key={b.label} className="flex-1">
                      {b.label.replace("或以上", "+")}
                    </span>
                  ))}
                </div>
              </>
            )}
            {d.top_priced.length > 0 && (
              <>
                <Sub>最貴的單品</Sub>
                <Ranked items={d.top_priced} right={(g) => money(g.price)} />
              </>
            )}
          </Card>

          {/* ── 顏色 ── */}
          {d.by_color.length > 0 && (
            <Card title="顏色">
              <div className="mb-3 flex flex-wrap gap-2.5">
                {d.by_color.map((c) => (
                  <Link key={c.name} to={`/wardrobe?color=${encodeURIComponent(c.name)}`} className="flex flex-col items-center gap-1 text-[11px] text-mauve">
                    <span className="h-9 w-9 rounded-full ring-1 ring-gold/70" style={{ background: swatch(c.name) }} />
                    {c.name}
                  </Link>
                ))}
              </div>
              <Bars rows={d.by_color.slice(0, 8).map((c) => ({ name: c.name, n: c.n, sub: pct(c.n, d.total), dot: swatch(c.name) }))} format={(n) => `${n} 件`} onPick={go("color")} />
            </Card>
          )}

          {/* ── 風格 ── */}
          {d.by_style.length > 0 && (
            <Card title="風格">
              <Bars rows={d.by_style.map((x) => ({ name: x.name, n: x.n, sub: pct(x.n, d.total) }))} format={(n) => `${n} 件`} onPick={(name) => (name === "未填風格" ? navigate("/wardrobe") : go("style")(name))} />
              <p className="mt-2 text-[11px] text-mauve">一件衣物可以有多個風格，所以百分比加起來可能超過 100%。</p>
            </Card>
          )}

          {/* ── 品牌 ── */}
          {(brands.length > 0 || noBrand > 0) && (
            <Card title="品牌">
              {brands.length > 0 ? (
                <Bars rows={brands.map((x) => ({ name: x.name, n: x.n, sub: x.value ? money(x.value) : undefined }))} format={(n) => `${n} 件`} onPick={go("brand")} color="linear-gradient(90deg, var(--aw-chart-2), color-mix(in srgb, var(--aw-chart-2) 60%, #fff))" />
              ) : (
                <p className="text-[13px] text-mauve">仍未有已填品牌的衣物。</p>
              )}
              {noBrand > 0 && (
                <p className="mt-2 text-[12px] text-mauve">
                  另有{" "}
                  <Link to="/wardrobe?brand=__none__" className="text-amethyst-deep underline underline-offset-4">
                    {noBrand} 件未有品牌
                  </Link>
                </p>
              )}
            </Card>
          )}

          {/* ── 款式細分、季節、其他屬性 ── */}
          {(d.by_subcategory.length > 0 || d.by_season.length > 0 || d.attributes.length > 0) && (
            <Card title="款式與細節">
              {d.by_subcategory.length > 0 && <Tags label="子分類" list={d.by_subcategory} to={(n) => `/wardrobe?subcategory=${encodeURIComponent(n)}`} />}
              {d.by_season.length > 0 && <Tags label="季節" list={d.by_season} to={(n) => `/wardrobe?season=${encodeURIComponent(n)}`} />}
              {d.attributes.map((a) => (
                <Tags key={a.id} label={a.name} list={a.options} to={(n) => `/wardrobe?attr=${encodeURIComponent(`${a.id}:${n}`)}`} />
              ))}
            </Card>
          )}

          {/* ── 使用情況 ── */}
          <Card title="穿搭使用">
            <div className="grid grid-cols-2 gap-2">
              <Big label="配搭過" value={`${d.in_outfits} 件`} />
              <Big label="從未配搭" value={`${d.never_in_outfit} 件`} />
            </div>
            {d.most_worn.length > 0 && (
              <>
                <Sub>最常出現在穿搭</Sub>
                <Ranked items={d.most_worn} right={(g) => `${g.outfits} 套`} />
              </>
            )}
            {d.by_month.length > 1 && (
              <>
                <Sub>每月新增</Sub>
                <Bars rows={d.by_month.map((m) => ({ name: m.name.replace("-", " 年 ") + " 月", n: m.n, sub: m.value ? money(m.value) : undefined }))} format={(n) => `${n} 件`} />
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="frame mt-5 p-4">
      <h2 className="ribbon mb-3.5 font-serif text-[15px] font-bold tracking-[0.12em]">{title}</h2>
      {children}
    </section>
  );
}
const Sub = ({ children }: { children: ReactNode }) => <h3 className="mb-2 mt-5 text-[12px] tracking-[0.1em] text-mauve">{children}</h3>;

function Big({ label, value }: { label: string; value: string }) {
  return (
    <div className="chip rounded-2xl px-3 py-2.5">
      <div className="text-[11px] text-mauve">{label}</div>
      <div className="mt-0.5 font-serif text-[22px] font-bold leading-tight text-gold-soft">{value}</div>
    </div>
  );
}
function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="chip rounded-xl py-2">
      <div className="font-serif text-[18px] font-bold leading-none text-gold-soft">{value}</div>
      <div className="mt-1 text-[11px] text-mauve">{label}</div>
    </div>
  );
}

function Tags({ label, list, to }: { label: string; list: Bucket[]; to: (name: string) => string }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1.5 text-[12px] tracking-[0.1em] text-mauve">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {list.map((x) => (
          <Link key={x.name} to={to(x.name)} className="chip rounded-full px-3 py-1 text-[13px]">
            {x.name} <span className="text-mauve">{x.n}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Ranked({ items, right }: { items: Brief[]; right: (g: Brief) => string }) {
  return (
    <ol className="space-y-2">
      {items.map((g, i) => (
        <li key={g.id}>
          <Link to={`/g/${g.id}`} className="flex items-center gap-3">
            <span className="w-4 shrink-0 text-center font-serif text-[15px] text-gold">{i + 1}</span>
            <span className="arch relative h-12 w-9 shrink-0 overflow-hidden" style={{ boxShadow: "none" }}>
              {(g.primary_image_id || g.thumb_image_id) && <WardrobeImage src={imageUrl(g.primary_image_id || g.thumb_image_id)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-1 pt-2" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px]">{displayName(g)}</span>
              <span className="block truncate text-[11px] text-mauve">{[g.brand, g.subcategory || g.category].filter(Boolean).join("｜") || "未分類"}</span>
            </span>
            <span className="shrink-0 tabular-nums text-[14px] text-gold-soft">{right(g)}</span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
