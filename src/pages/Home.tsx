import { ReactNode, useCallback, useEffect, useState } from "react";
import { api, Garment } from "../api";
import { Bars, Donut, pct, SERIES, swatch, topWithOther } from "../components/charts";
import { BgImage, HomeBgEditor } from "../components/HomeBackground";
import { IconCamera, IconChart, IconChevronRight, IconCloudUp, IconDress } from "../components/icons";
import { Empty, GarmentTile, Link, money, Spinner, useSettings } from "../components/ui";
import { navigate } from "../router";
import ReviewPanel from "./AiReview";
import { AnalysisData } from "./Analysis";

interface Stats {
  total: number;
  review: number;
  favorites: number;
  missing_image: number;
  open_batches: number;
  ai_todo: number;
  ai_review: number;
  ai_done: number;
  total_value: number;
  priced_count: number;
  by_category: { category: string; n: number }[];
  recent: Garment[];
  favorite_items: Garment[];
}

export default function Home() {
  const [s, setS] = useState<Stats | null>(null);
  const [an, setAn] = useState<AnalysisData | null>(null);
  const [err, setErr] = useState("");
  const [editBg, setEditBg] = useState(false);
  const settings = useSettings();
  const loadStats = useCallback(() => {
    api<Stats>("/api/stats").then(setS).catch((e) => setErr(e.message));
    api<AnalysisData>("/api/analysis").then(setAn).catch(() => undefined);
  }, []);
  useEffect(() => {
    loadStats();
    // 從其他頁面連到「待整理」時捲到該區
    if (location.hash === "#todo" || new URLSearchParams(location.search).get("tab")) setTimeout(() => document.getElementById("todo")?.scrollIntoView({ behavior: "smooth" }), 300);
  }, [loadStats]);
  if (err) return <p className="py-10 text-center text-wine">{err}</p>;
  if (!s) return <Spinner />;

  const bg = settings?.home_bg ?? null;

  return (
    <div>
      {/* 開場：自訂背景圖（下緣淡出融入底色），衣物總數放在拱窗銘牌中 */}
      <section className="relative -mx-4 -mt-2" style={{ containerType: "inline-size" }}>
        {bg && (
          <div className="absolute inset-x-0 top-0">
            <BgImage src={bg.url} iw={bg.width} ih={bg.height} layout={bg} />
          </div>
        )}
        <button
          type="button"
          onClick={() => setEditBg(true)}
          className="btn-dark absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] opacity-90"
          aria-label={bg ? "更換主頁背景" : "加入主頁背景"}
        >
          <IconCamera className="text-[14px]" />
          {bg ? "背景" : "加入背景"}
        </button>
        <div className="relative px-4 pb-1" style={{ paddingTop: bg ? `max(1.75rem, calc(${bg.ratio}cqw - 11.5rem))` : "1.75rem" }}>
          <div className="flex items-end gap-4">
            <div className="arch-dark bow grid h-36 w-28 shrink-0 place-items-center">
              <div className="text-center">
                <div className="font-serif text-[46px] font-bold leading-none text-gold-soft">{s.total}</div>
                <div className="mt-1.5 text-[12px] text-mauve">件</div>
              </div>
            </div>
            <div className="min-w-0 pb-2" style={bg ? { textShadow: "0 1px 6px rgb(28 14 26 / 0.9), 0 0 2px rgb(28 14 26 / 0.9)" } : undefined}>
              <h1 className="font-serif text-[24px] font-bold tracking-[0.08em] text-gold-soft">我的衣櫃</h1>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[14px] text-cream">
                <Link to="/wardrobe?favorite=1">收藏 {s.favorites}</Link>
                <Link to="/wardrobe?status=review" className={s.review ? "underline decoration-gold underline-offset-4" : ""}>
                  待確認 {s.review}
                </Link>
                {s.missing_image > 0 && <Link to="/wardrobe?needs_image=1">缺圖片 {s.missing_image}</Link>}
              </div>
            </div>
          </div>
        </div>
      </section>
      {editBg && <HomeBgEditor current={bg} onClose={() => setEditBg(false)} />}

      {/* 衣櫃總價 */}
      <Link to="/analysis" className="frame pat-argyle mt-5 flex items-center justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-[12px] tracking-[0.12em] text-mauve">衣櫃總價</div>
          <div className="mt-0.5 font-serif text-[30px] font-bold leading-none text-gold-soft">
            <span className="mr-1 text-[15px] font-normal text-mauve">HK</span>
            {money(s.total_value)}
          </div>
          <div className="mt-1.5 text-[12px] text-mauve">
            {s.priced_count ? `已填價錢 ${s.priced_count} 件${s.total - s.priced_count > 0 ? `｜${s.total - s.priced_count} 件未填` : ""}` : "在衣物資料填上價錢，這裡就會自動統計"}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-0.5 text-[13px] text-amethyst-deep">
          分析
          <IconChevronRight className="text-[14px]" />
        </span>
      </Link>

      <div className="mt-3 grid grid-cols-4 gap-2 text-center">
        <Stat to="/wardrobe" n={s.total} label="衣物總數" />
        <Stat tab="pending_ai" n={s.ai_todo} label="待整理" hot={s.ai_todo > 0} />
        <Stat tab="pending_review" n={s.ai_review} label="待確認" hot={s.ai_review > 0} />
        <Stat tab="done" n={s.ai_done} label="已完成" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Link to="/import" className="btn-jewel flex items-center justify-center gap-2 rounded-2xl px-4 py-3 font-serif text-[16px] tracking-[0.1em]">
          <IconCloudUp className="text-[20px]" />
          上傳衣物
        </Link>
        <Link to="/outfits/new" className="btn-dark flex items-center justify-center gap-2 rounded-2xl px-4 py-3 font-serif text-[16px] tracking-[0.1em]">
          <IconDress className="text-[20px]" />
          配搭一套
        </Link>
      </div>

      {an && an.total > 0 && <AnalysisSummary an={an} />}

      {s.ai_review > 0 && (
        <button type="button" onClick={() => goTab("pending_review")} className="frame mt-4 block w-full px-4 py-3 text-left text-sm">
          AI 已整理好 {s.ai_review} 件，等你確認
        </button>
      )}

      <ReviewPanel onChanged={loadStats} />

      <Section title="最近加入" more="/wardrobe">
        {s.recent.length ? (
          <Row items={s.recent} />
        ) : (
          <Empty title="衣櫃仍然空空的">按「上傳衣物」選相，填寫資料或交給 AI 填寫。</Empty>
        )}
      </Section>

      {s.favorite_items.length > 0 && (
        <Section title="收藏" more="/wardrobe?favorite=1">
          <Row items={s.favorite_items} />
        </Section>
      )}
    </div>
  );
}

/** 主頁的衣櫥分析摘要：分類環形圖、主要顏色、風格；按下進入完整分析 */
function AnalysisSummary({ an }: { an: AnalysisData }) {
  const cats = topWithOther(an.by_category, 5);
  const colors = an.by_color.slice(0, 7);
  const styles = an.by_style.filter((x) => x.name !== "未填風格").slice(0, 3);
  return (
    <section className="frame bow mt-9 px-4 pb-4 pt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="flex items-center gap-1.5 font-serif text-lg font-bold tracking-[0.08em] text-gold-soft">
          <IconChart className="text-[17px]" />
          衣櫥分析
        </h2>
        <Link to="/analysis" className="text-[13px] text-amethyst-deep">
          查看完整分析
        </Link>
      </div>
      <div className="flex items-center gap-4">
        <Donut segs={cats} size={116} thickness={13}>
          <div>
            <div className="font-serif text-[26px] font-bold leading-none text-gold-soft">{an.total}</div>
            <div className="mt-1 text-[11px] text-mauve">件</div>
          </div>
        </Donut>
        <ul className="min-w-0 flex-1 space-y-1.5 text-[13px]">
          {cats.map((c, i) => (
            <li key={c.name} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SERIES[i % SERIES.length] }} />
                <span className="truncate">{c.name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-mauve">
                {c.n}（{pct(c.n, an.total)}）
              </span>
            </li>
          ))}
        </ul>
      </div>
      {colors.length > 0 && (
        <div className="mt-4 flex items-center gap-3">
          <span className="shrink-0 text-[12px] text-mauve">顏色</span>
          <div className="flex flex-wrap gap-2">
            {colors.map((c) => (
              <Link key={c.name} to={`/wardrobe?color=${encodeURIComponent(c.name)}`} className="h-7 w-7 rounded-full ring-1 ring-gold/70" style={{ background: swatch(c.name) }} aria-label={`${c.name} ${c.n} 件`} />
            ))}
          </div>
        </div>
      )}
      {styles.length > 0 && (
        <div className="mt-4">
          <Bars rows={styles.map((x) => ({ name: x.name, n: x.n, sub: pct(x.n, an.total) }))} format={(n) => `${n} 件`} onPick={(name) => navigate(`/wardrobe?style=${encodeURIComponent(name)}`)} />
        </div>
      )}
    </section>
  );
}

/** 切換主頁「待整理」區的分頁並捲到該區 */
function goTab(tab: string) {
  navigate(`/?tab=${tab}`, true, false);
  setTimeout(() => document.getElementById("todo")?.scrollIntoView({ behavior: "smooth" }), 50);
}

function Stat({ to, tab, n, label, hot }: { to?: string; tab?: string; n: number; label: string; hot?: boolean }) {
  const cls = `frame px-1 py-3 ${hot ? "frame-hot" : ""}`;
  const inner = (
    <>
      <div className={`font-serif text-[24px] font-bold leading-none ${hot ? "text-white" : "text-gold-soft"}`}>{n}</div>
      <div className={`mt-1.5 text-[11px] ${hot ? "text-white/90" : "text-mauve"}`}>{label}</div>
    </>
  );
  if (tab)
    return (
      <button type="button" onClick={() => goTab(tab)} className={cls}>
        {inner}
      </button>
    );
  return (
    <Link to={to!} className={cls}>
      {inner}
    </Link>
  );
}

function Section({ title, more, children }: { title: string; more?: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="ribbon font-serif text-[15px] font-bold tracking-[0.12em]">{title}</h2>
        {more && (
          <Link to={more} className="text-[13px] text-amethyst-deep">
            查看全部
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

function Row({ items }: { items: Garment[] }) {
  return (
    <div className="scrollbar-none -mx-4 flex gap-3 overflow-x-auto px-4">
      {items.map((g) => (
        <div key={g.id} className="w-[30%] shrink-0 sm:w-36">
          <GarmentTile g={g} size="sm" />
        </div>
      ))}
    </div>
  );
}
