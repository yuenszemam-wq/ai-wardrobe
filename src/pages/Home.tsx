import { ReactNode, useCallback, useEffect, useState } from "react";
import { api, Garment } from "../api";
import { Empty, GarmentTile, Link, Spinner } from "../components/ui";
import { navigate } from "../router";
import ReviewPanel from "./AiReview";

interface Stats {
  total: number;
  review: number;
  favorites: number;
  missing_image: number;
  open_batches: number;
  ai_todo: number;
  ai_review: number;
  ai_done: number;
  by_category: { category: string; n: number }[];
  recent: Garment[];
  favorite_items: Garment[];
}

export default function Home() {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState("");
  const loadStats = useCallback(() => {
    api<Stats>("/api/stats").then(setS).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    loadStats();
    // 從其他頁面連到「待整理」時捲到該區
    if (location.hash === "#todo" || new URLSearchParams(location.search).get("tab")) setTimeout(() => document.getElementById("todo")?.scrollIntoView({ behavior: "smooth" }), 300);
  }, [loadStats]);
  if (err) return <p className="py-10 text-center text-wine">{err}</p>;
  if (!s) return <Spinner />;

  return (
    <div>
      {/* 開場：衣物總數放在拱窗中，像衣櫃門上的銘牌 */}
      <section className="-mx-4 bg-ink px-4 pb-8 pt-6 text-rose">
        <div className="flex items-center gap-5">
          <div className="arch-dark grid h-32 w-24 shrink-0 place-items-center ring-1 ring-rose/20">
            <div className="text-center">
              <div className="font-serif text-[40px] font-bold leading-none">{s.total}</div>
              <div className="mt-1 text-[11px] text-mauve">件</div>
            </div>
          </div>
          <div className="min-w-0">
            <p className="font-serif text-xl">我的衣櫃</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-rose/80">
              <Link to="/wardrobe?favorite=1">收藏 {s.favorites}</Link>
              <Link to="/wardrobe?status=review" className={s.review ? "text-rose underline decoration-amethyst underline-offset-4" : ""}>
                待確認 {s.review}
              </Link>
              {s.missing_image > 0 && <Link to="/wardrobe?needs_image=1">缺圖片 {s.missing_image}</Link>}
            </div>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-4 gap-2 text-center">
          <Stat to="/wardrobe" n={s.total} label="衣物總數" />
          <Stat tab="pending_ai" n={s.ai_todo} label="待整理" hot={s.ai_todo > 0} />
          <Stat tab="pending_review" n={s.ai_review} label="待確認" hot={s.ai_review > 0} />
          <Stat tab="done" n={s.ai_done} label="已完成" />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Link to="/import" className="rounded-2xl bg-amethyst px-4 py-3 text-center text-[15px] font-medium text-white">
            批量上傳
          </Link>
          <Link to="/outfits/new" className="rounded-2xl bg-velvet px-4 py-3 text-center text-[15px] text-rose">
            配搭一套
          </Link>
        </div>
      </section>

      {s.ai_review > 0 && (
        <button type="button" onClick={() => goTab("pending_review")} className="mt-4 block w-full rounded-2xl bg-rose-soft px-4 py-3 text-left text-sm">
          AI 已整理好 {s.ai_review} 件，等你確認 →
        </button>
      )}

      {s.open_batches > 0 && (
        <Link to="/import" className="mt-4 block rounded-2xl bg-rose-soft px-4 py-3 text-sm">
          有 {s.open_batches} 個匯入批次仍在進行中，按此查看
        </Link>
      )}

      <ReviewPanel onChanged={loadStats} />

      <Section title="最近加入" more="/wardrobe">
        {s.recent.length ? (
          <Row items={s.recent} />
        ) : (
          <Empty title="衣櫃仍然空空的">
            在「匯入」選相上傳，或在 ChatGPT／Claude 連接電子衣櫃後直接匯入。
          </Empty>
        )}
      </Section>

      {s.favorite_items.length > 0 && (
        <Section title="收藏" more="/wardrobe?favorite=1">
          <Row items={s.favorite_items} />
        </Section>
      )}

      {s.by_category.length > 0 && (
        <Section title="分類">
          <div className="flex flex-wrap gap-2">
            {s.by_category.map((c) => (
              <Link
                key={c.category}
                to={c.category === "未分類" ? "/wardrobe" : `/wardrobe?category=${encodeURIComponent(c.category)}`}
                className="rounded-full bg-white px-3.5 py-1.5 text-[13px] ring-1 ring-ink/10"
              >
                {c.category} <span className="text-mauve">{c.n}</span>
              </Link>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/** 切換主頁「待整理」區的分頁並捲到該區 */
function goTab(tab: string) {
  navigate(`/?tab=${tab}`, true, false);
  setTimeout(() => document.getElementById("todo")?.scrollIntoView({ behavior: "smooth" }), 50);
}

function Stat({ to, tab, n, label, hot }: { to?: string; tab?: string; n: number; label: string; hot?: boolean }) {
  const cls = `rounded-2xl px-1 py-2.5 ${hot ? "bg-amethyst text-white" : "bg-velvet text-rose"}`;
  const inner = (
    <>
      <div className="font-serif text-[22px] font-bold leading-none">{n}</div>
      <div className={`mt-1 text-[11px] ${hot ? "text-white/85" : "text-mauve"}`}>{label}</div>
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
    <section className="mt-7">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-serif text-lg font-bold">{title}</h2>
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
