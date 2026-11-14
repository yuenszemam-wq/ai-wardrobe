import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, Garment } from "../api";
import { Bars, Donut, pct, SERIES, swatch, topWithOther } from "../components/charts";
import { BgImage, HomeBgEditor } from "../components/HomeBackground";
import { IconCamera, IconChart, IconChevronRight, IconCloudUp, IconDress, IconLayers, IconPerson, IconScissors, IconShirt } from "../components/icons";
import { Empty, GarmentTile, Link, money, useSettings } from "../components/ui";
import { navigate } from "../router";
import ReviewPanel from "./AiReview";
import { AnalysisData } from "./Analysis";
import { LookPreview, LookSummary, OutfitPreview, OutfitSummary } from "./Outfits";
import { HomeLayout, OVERVIEW_DEFAULT, QUICK_DEFAULT, Widget } from "../../shared/homeLayout";
import { useHomeLayoutState } from "../homeLayoutStore";
import { HomeEditSurface } from "../components/HomeEditSurface";
import { loadFullList } from "../wardrobeList";

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
type LookEntry = { kind: "outfit" | "look"; id: string; name: string; is_favorite: boolean; updated_at: string; created_at: string; outfit?: OutfitSummary; look?: LookSummary };
export interface HomeData { s: Stats | null; an: AnalysisData | null; garments: Garment[] | null; looks: LookEntry[] | null; seed: number; errors: Partial<Record<Source, string>>; retry: (src: Source) => void; editing: boolean }
type Source = "stats" | "analysis" | "garments" | "looks";
/** 每個元件需要的資料：沒有顯示的元件不讀取相應資料（Phase 3.8A.1） */
const NEEDS: Record<string, Source[]> = {
  cover: ["stats"], overview: ["stats"], value: ["stats"], todo: ["stats"], quick: [],
  recent: ["garments"], updated: ["garments"], favorites: ["garments"], random_garment: ["garments"],
  recent_looks: ["looks"], fav_looks: ["looks"], random_look: ["looks"], analysis: ["analysis"],
};
// 上一次成功讀取的資料：返回主頁時立即顯示，背景更新；讀取失敗保留舊資料
const memo: { stats?: Stats; analysis?: AnalysisData; garments?: Garment[]; looks?: LookEntry[] } = {};

/**
 * 主頁（Phase 3.8A／3.8A.1）：可自由組合的資訊元件。按「編輯」直接在主頁移動真實元件。
 * 只讀取已顯示元件需要的資料；某項資料讀取失敗只影響相應元件，並提供局部重試。
 */
export default function Home() {
  const [s, setS] = useState<Stats | null>(memo.stats ?? null);
  const [an, setAn] = useState<AnalysisData | null>(memo.analysis ?? null);
  const [garments, setGarments] = useState<Garment[] | null>(memo.garments ?? null);
  const [looks, setLooks] = useState<LookEntry[] | null>(memo.looks ?? null);
  const [errors, setErrors] = useState<Partial<Record<Source, string>>>({});
  const { layout: saved, ready } = useHomeLayoutState();
  const [draft, setDraft] = useState<HomeLayout | null>(null);
  const [editing, setEditing] = useState(() => new URLSearchParams(location.search).get("edit") === "home");
  const [seed] = useState(() => Math.random());
  const layout = draft ?? saved;
  const shown = layout.widgets.filter((w) => w.visible);
  const forceTodo = !!new URLSearchParams(location.search).get("tab") || location.hash === "#todo";
  const needs = new Set<Source>(shown.flatMap((w) => NEEDS[w.type] ?? []));
  if (forceTodo) needs.add("stats");
  const needKey = [...needs].sort().join(",");
  const loaded = useRef(new Set<Source>());
  const load = useCallback((src: Source) => {
    loaded.current.add(src);
    setErrors((e) => { if (!e[src]) return e; const n = { ...e }; delete n[src]; return n; });
    const fail = (e: unknown) => setErrors((x) => ({ ...x, [src]: (e as Error).message || "讀取失敗" }));
    if (src === "stats") api<Stats>("/api/stats").then((v) => { memo.stats = v; setS(v); }).catch(fail);
    else if (src === "analysis") api<AnalysisData>("/api/analysis").then((v) => { memo.analysis = v; setAn(v); }).catch(fail);
    else if (src === "garments") loadFullList(new URLSearchParams()).then((v) => { memo.garments = v; setGarments(v); }).catch(fail);
    else Promise.all([api<{ outfits: OutfitSummary[] }>("/api/outfits"), api<{ looks: LookSummary[] }>("/api/doll/looks")]).then(([o, l]) => {
      const v = [
        ...o.outfits.map((x): LookEntry => ({ kind: "outfit", id: x.id, name: x.name, is_favorite: x.is_favorite, updated_at: x.updated_at ?? x.created_at ?? "", created_at: x.created_at ?? "", outfit: x })),
        ...l.looks.map((x): LookEntry => ({ kind: "look", id: x.id, name: x.name, is_favorite: x.is_favorite, updated_at: x.updated_at, created_at: x.created_at, look: x })),
      ];
      memo.looks = v; setLooks(v);
    }).catch(fail);
  }, []);
  // 只讀取目前需要而未讀取的資料（加入新元件時才讀取）
  useEffect(() => { if (!ready) return; for (const src of needs) if (!loaded.current.has(src)) load(src); }, [needKey, load, ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const reloadAll = useCallback(() => { for (const src of loaded.current) load(src); }, [load]);
  useEffect(() => {
    if (location.hash === "#todo" || new URLSearchParams(location.search).get("tab")) setTimeout(() => document.getElementById("todo")?.scrollIntoView({ behavior: "smooth" }), 300);
  }, []);
  useEffect(() => { const on = () => setEditing(true); window.addEventListener("aw:edit-home", on); return () => window.removeEventListener("aw:edit-home", on); }, []);
  const data: HomeData = { s, an, garments, looks, seed, errors, retry: load, editing };
  const closeEdit = useCallback(() => { setEditing(false); setDraft(null); if (new URLSearchParams(location.search).get("edit")) navigate("/", true, false); }, []);
  return (
    <div data-testid="home" data-layout={shown.map((w) => w.type).join(",")} data-editing={editing ? "1" : "0"} data-sources={[...loaded.current].sort().join(",")}>
      {editing
        ? <HomeEditSurface layout={saved} onDraft={setDraft} onClose={closeEdit} render={(w) => <WidgetView w={w} d={data} onChanged={reloadAll} />} />
        : shown.map((w) => <WidgetView key={w.id} w={w} d={data} onChanged={reloadAll} />)}
      {!editing && forceTodo && !shown.some((w) => w.type === "todo") && <ReviewPanel onChanged={reloadAll} />}
    </div>
  );
}

/** 讀取失敗：只影響這個元件，保留其他內容，可以局部重試 */
function SourceError({ d, src, label }: { d: HomeData; src: Source; label: string }) {
  return (
    <section className="mt-4 flex items-center gap-2 rounded-2xl bg-white/5 px-3 py-2.5 text-[12px]" data-testid={"w-error-" + src}>
      <span className="min-w-0 flex-1 text-mauve">{label}暫時未能讀取（{d.errors[src]}）</span>
      <button type="button" data-retry={src} onClick={() => d.retry(src)} className="chip h-9 shrink-0 rounded-full px-3">重試</button>
    </section>
  );
}
/** 編輯模式：沒有內容的元件仍顯示可辨認的占位 */
function Placeholder({ label, testid }: { label: string; testid: string }) {
  return <section className="mt-2 rounded-2xl border border-dashed border-gold/40 px-3 py-5 text-center text-[12px] text-mauve" data-testid={testid} data-placeholder="1">{label}（暫時沒有內容；有內容時才會顯示）</section>;
}

function WidgetView({ w, d, onChanged }: { w: Widget; d: HomeData; onChanged: () => void }) {
  const o = w.opts, compact = w.size === "compact";
  const title = (t: string) => (o.title === false ? undefined : t);
  const empty = (label: string) => (d.editing ? <Placeholder label={label} testid={"w-" + w.type} /> : null);
  const need = NEEDS[w.type] ?? [];
  const failed = need.find((src) => d.errors[src] && !(src === "stats" ? d.s : src === "analysis" ? d.an : src === "garments" ? d.garments : d.looks));
  if (failed) return <SourceError d={d} src={failed} label={LABEL[w.type] ?? "這個元件"} />;
  const s = d.s;
  if (need.includes("stats") && !s) return <section className="mt-4 h-16 animate-pulse rounded-2xl bg-white/5" data-testid={"w-" + w.type} />;
  const pickGarments = (list: Garment[], sort: string | undefined, filter: (g: Garment) => boolean) => {
    const out = list.filter((g) => filter(g) && (!o.category || g.category === o.category) && (!o.subcategory || g.subcategory === o.subcategory) && (!o.favorite || g.is_favorite));
    const by: Record<string, (a: Garment, b: Garment) => number> = {
      created: (a, b) => b.created_at.localeCompare(a.created_at), created_asc: (a, b) => a.created_at.localeCompare(b.created_at),
      updated: (a, b) => b.updated_at.localeCompare(a.updated_at), name: (a, b) => a.name.localeCompare(b.name, "zh-Hant"),
      price_desc: (a, b) => (b.price ?? -1) - (a.price ?? -1),
    };
    return out.sort(by[sort ?? "created"] ?? by.created).slice(0, o.count ?? 8);
  };
  switch (w.type) {
    case "cover": return <Cover w={w} s={s!} />;
    case "overview": {
      const st = s!;
      const all: Record<string, [string, number, string, boolean?]> = {
        total: ["衣物總數", st.total, "/wardrobe"], favorites: ["收藏", st.favorites, "/wardrobe?favorite=1"], ai_todo: ["待整理", st.ai_todo, "/?tab=pending_ai#todo", st.ai_todo > 0],
        ai_review: ["待確認", st.ai_review, "/?tab=pending_review#todo", st.ai_review > 0], ai_done: ["已完成", st.ai_done, "/?tab=done#todo"],
        missing_image: ["缺少圖片", st.missing_image, "/wardrobe?needs_image=1"], unpriced: ["未填價格", Math.max(0, st.total - st.priced_count), "/wardrobe?priced=0"],
      };
      // 自訂統計項目及次序；舊設定（未選擇）沿用原本：前五項＋有數字的其他項目
      const keys = o.items ?? [...OVERVIEW_DEFAULT, ...["missing_image", "unpriced"].filter((k) => all[k][1] > 0)];
      const cells = keys.map((k) => all[k]).filter(Boolean);
      return (
        <WSection title={title("衣櫃概覽")} testid="w-overview">
          <div className={`grid ${compact ? "grid-cols-4 gap-1.5" : "grid-cols-3 gap-2"}`} data-items={keys.join(",")}>
            {cells.map(([label, n, to, hot]) => (
              <Link key={label} to={to} className={`frame px-1 text-center ${compact ? "py-2" : "py-3"} ${hot ? "frame-hot" : ""}`}>
                <span className={`block font-serif font-bold leading-none ${compact ? "text-[19px]" : "text-[23px]"} ${hot ? "text-white" : "text-gold-soft"}`}>{n}</span>
                <span className="mt-1 block text-[10.5px] text-mauve">{label}</span>
              </Link>
            ))}
          </div>
        </WSection>
      );
    }
    case "value": return (
      <WSection title={title("衣櫃總價")} testid="w-value">
        <Link to="/analysis" className={`frame flex items-center justify-between gap-3 px-4 ${compact ? "py-2.5" : "py-3.5"}`}>
          <div className="min-w-0">
            {o.title === false && <div className="text-[11px] tracking-[0.12em] text-mauve">衣櫃總價</div>}
            <div className={`font-serif font-bold leading-none text-gold-soft ${compact ? "text-[24px]" : "text-[30px]"}`}><span className="mr-1 text-[14px] font-normal text-mauve">HK</span>{money(s!.total_value)}</div>
            <div className="mt-1 text-[11.5px] text-mauve">{s!.priced_count ? `已填價格 ${s!.priced_count} 件｜未填 ${Math.max(0, s!.total - s!.priced_count)} 件` : "在衣物資料填上價錢，這裡就會自動統計"}</div>
          </div>
          <span className="flex shrink-0 items-center gap-0.5 text-[13px] text-amethyst-deep">分析<IconChevronRight className="text-[14px]" /></span>
        </Link>
      </WSection>
    );
    case "quick": {
      const all: Record<string, [string, string, typeof IconShirt]> = { upload: ["/import", "上傳", IconCloudUp], outfit: ["/outfits/new", "配搭", IconShirt], dressing: ["/dressing", "換裝", IconPerson], setup: ["/dressing/setup", "衣服設定", IconScissors], analysis: ["/analysis", "分析", IconChart], wardrobe: ["/wardrobe", "衣櫃", IconDress], looks: ["/outfits", "我的穿搭", IconLayers] };
      const keys = (o.items ?? QUICK_DEFAULT).filter((k) => all[k]);
      const cols = keys.length <= 2 ? "grid-cols-2" : keys.length === 3 ? "grid-cols-3" : keys.length === 4 ? "grid-cols-4" : "grid-cols-5";
      return (
        <WSection title={title("快捷操作")} testid="w-quick">
          <div className={`grid ${cols} gap-1.5`} data-items={keys.join(",")}>
            {keys.map((k) => { const [to, label, Icon] = all[k]; return <Link key={k} to={to} className={`chip flex flex-col items-center gap-1 rounded-2xl ${compact ? "py-2" : "py-3"} text-[11px]`}><Icon className="text-[18px] text-gold-soft" />{label}</Link>; })}
          </div>
        </WSection>
      );
    }
    case "recent": case "updated": case "favorites": case "random_garment": {
      if (!d.garments) return <WSection title={title(LABEL[w.type])} testid={"w-" + w.type}><div className="h-28" /></WSection>;
      let items: Garment[];
      if (w.type === "random_garment") {
        const pool = d.garments.filter((g) => g.primary_image_id && (!o.category || g.category === o.category) && (!o.subcategory || g.subcategory === o.subcategory) && (!o.favorite || g.is_favorite));
        items = [...pool].sort((a, b) => hash(a.id, d.seed) - hash(b.id, d.seed)).slice(0, o.count ?? 3);
      } else items = pickGarments(d.garments, w.type === "updated" ? "updated" : o.sort, w.type === "favorites" ? (g) => g.is_favorite : () => true);
      if (!items.length && o.only_when_content) return empty(LABEL[w.type]);
      const more = w.type === "favorites" ? "/wardrobe?favorite=1" : w.type === "updated" ? "/wardrobe?sort=updated" : "/wardrobe";
      return (
        <WSection title={title(LABEL[w.type] + (o.subcategory ? `｜${o.subcategory}` : o.category ? `｜${o.category}` : ""))} more={w.type === "random_garment" ? undefined : more} testid={"w-" + w.type}>
          {items.length ? <Row items={items} compact={compact} detail={!!o.detail} /> : <Empty title="未有衣物">上傳衣物後就會在這裡顯示。</Empty>}
        </WSection>
      );
    }
    case "recent_looks": case "fav_looks": case "random_look": {
      if (!d.looks) return d.editing ? <Placeholder label={LABEL[w.type]} testid={"w-" + w.type} /> : null;
      let list = w.type === "fav_looks" ? d.looks.filter((l) => l.is_favorite) : [...d.looks];
      if (w.type === "random_look") list = list.sort((a, b) => hash(a.id, d.seed) - hash(b.id, d.seed));
      else list.sort((a, b) => (o.sort === "name" ? a.name.localeCompare(b.name, "zh-Hant") : o.sort === "created" ? b.created_at.localeCompare(a.created_at) : b.updated_at.localeCompare(a.updated_at)));
      list = list.slice(0, o.count ?? 6);
      if (!list.length && (o.only_when_content || w.type === "random_look")) return empty(LABEL[w.type]);
      return (
        <WSection title={title(LABEL[w.type])} more="/outfits" testid={"w-" + w.type}>
          {list.length ? (
            <div className="scrollbar-none -mx-4 flex gap-2.5 overflow-x-auto px-4">
              {list.map((e) => (
                <Link key={e.kind + e.id} to={e.kind === "outfit" ? `/outfits/${e.id}` : `/dressing/${e.id}`} className={`paper block shrink-0 p-1.5 ${compact ? "w-[26%]" : "w-[34%]"} sm:w-36`}>
                  {e.outfit ? <OutfitPreview o={e.outfit} /> : <LookPreview l={e.look!} />}
                  <span className="mt-1 block truncate px-0.5 text-[12px] font-medium text-ink">{e.name}</span>
                </Link>
              ))}
            </div>
          ) : <Empty title="仍未有造型">到穿搭工作室開始配搭。</Empty>}
        </WSection>
      );
    }
    case "analysis": return d.an && d.an.total > 0 ? <AnalysisSummary an={d.an} mode={o.mode ?? "category"} title={o.title !== false} count={o.count ?? 5} chart={o.chart} showPct={o.show_pct !== false} /> : d.an || d.editing ? empty("衣櫃分析摘要") : <section className="mt-4 h-24 animate-pulse rounded-2xl bg-white/5" data-testid="w-analysis" />;
    case "todo": {
      const st = s!;
      const items: [string, number, string][] = [["AI 待整理", st.ai_todo, "/?tab=pending_ai#todo"], ["AI 待確認", st.ai_review, "/?tab=pending_review#todo"], ["缺少圖片", st.missing_image, "/wardrobe?needs_image=1"], ["未填價格", Math.max(0, st.total - st.priced_count), "/wardrobe?priced=0"]];
      const any = items.some((x) => x[1] > 0);
      if (!any && o.only_when_content && !new URLSearchParams(location.search).get("tab")) return empty("待處理事項");
      return (
        <WSection title={title("待處理事項")} testid="w-todo">
          <div className="flex flex-wrap gap-1.5">
            {items.filter((x) => x[1] > 0 || !o.only_when_content).map(([label, n, to]) => <Link key={label} to={to} className={`rounded-full px-3 py-1.5 text-[12px] ${n ? "chip-on" : "chip"}`}>{label} {n}</Link>)}
            {!any && <span className="text-[12px] text-mauve">沒有待處理事項</span>}
          </div>
          {!d.editing && (st.ai_todo > 0 || st.ai_review > 0 || new URLSearchParams(location.search).get("tab")) && <ReviewPanel onChanged={onChanged} />}
        </WSection>
      );
    }
  }
  return null;
}
const LABEL: Record<string, string> = { cover: "背景封面", overview: "衣櫃概覽", value: "衣櫃總價", todo: "待處理事項", analysis: "衣櫃分析", recent: "最近加入", updated: "最近修改", favorites: "收藏衣物", random_garment: "隨機推薦", recent_looks: "最近穿搭", fav_looks: "收藏穿搭", random_look: "隨機穿搭" };
const hash = (id: string, seed: number) => { let h = Math.floor(seed * 1e9); for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761); return h >>> 0; };

/** 背景封面：自訂背景圖、衣櫃名稱及統計（可在編輯器設定顯示、隱藏及文字可讀性漸層） */
function Cover({ w, s }: { w: Widget; s: Stats }) {
  const settings = useSettings();
  const [editBg, setEditBg] = useState(false);
  const bg = settings?.home_bg ?? null;
  const o = w.opts;
  const shade = o.shade ?? 0.55;
  // 封面獨立高度（未設定＝背景圖設定）及文字位置
  const ratio = o.height ?? bg?.ratio ?? 78, top = o.text_pos === "top";
  return (
    <section className="relative -mx-4 -mt-2" style={{ containerType: "inline-size", ...(bg && top ? { minHeight: `${ratio}cqw` } : {}) }} data-testid="w-cover" data-ratio={ratio}>
      {bg && <div className="absolute inset-x-0 top-0"><BgImage src={bg.url} iw={bg.width} ih={bg.height} layout={{ ...bg, ratio }} /></div>}
      <button type="button" onClick={() => setEditBg(true)} className="btn-dark absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] opacity-90" aria-label={bg ? "更換主頁背景" : "加入主頁背景"}>
        <IconCamera className="text-[14px]" />{bg ? "背景" : "加入背景"}
      </button>
      {(o.show_name !== false || o.show_stats !== false) ? (
        <div className="relative px-4 pb-1" style={{ paddingTop: !bg ? "1.25rem" : top ? "3.25rem" : `max(1.75rem, calc(${ratio}cqw - 7.5rem))` }}>
          <div className="min-w-0" style={bg && shade > 0 ? { textShadow: `0 1px 6px rgb(28 14 26 / ${shade + 0.1}), 0 0 2px rgb(28 14 26 / ${shade + 0.1})` } : undefined}>
            {o.show_name !== false && <h1 className="font-serif text-[24px] font-bold tracking-[0.08em] text-gold-soft">{o.name || "我的衣櫃"}</h1>}
            {o.show_stats !== false && (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13.5px] text-cream">
                <Link to="/wardrobe">{s.total} 件衣物</Link>
                <Link to="/wardrobe?favorite=1">收藏 {s.favorites}</Link>
                {s.review > 0 && <Link to="/wardrobe?status=review" className="underline decoration-gold underline-offset-4">待確認 {s.review}</Link>}
              </div>
            )}
          </div>
        </div>
      ) : <div style={{ height: bg ? `${ratio * 0.6}cqw` : "2.5rem" }} />}
      {editBg && <HomeBgEditor current={bg} onClose={() => setEditBg(false)} />}
    </section>
  );
}

/** 主頁的衣櫥分析摘要：按設定顯示主分類、子分類、顏色、品牌或風格；按下進入完整分析 */
function AnalysisSummary({ an, mode, title, count = 5, chart, showPct = true }: { an: AnalysisData; mode: string; title: boolean; count?: number; chart?: "donut" | "bars"; showPct?: boolean }) {
  const source = mode === "subcategory" ? an.by_subcategory : mode === "color" ? an.by_color : mode === "brand" ? an.by_brand : mode === "style" ? an.by_style.filter((x) => x.name !== "未填風格") : an.by_category;
  const key = mode === "subcategory" ? "subcategory" : mode === "color" ? "color" : mode === "brand" ? "brand" : mode === "style" ? "style" : "category";
  const label = { category: "主分類", subcategory: "子分類", color: "顏色", brand: "品牌", style: "風格" }[key] ?? "主分類";
  const segs = topWithOther(source, count);
  // 圖表形式：未設定＝按分析類型（品牌／風格用長條，其他用圓環）
  const useBars = chart ? chart === "bars" : key === "style" || key === "brand";
  return (
    <section className="frame mt-4 px-4 pb-4 pt-4" data-testid="w-analysis" data-chart={key === "color" ? "swatch" : useBars ? "bars" : "donut"}>
      {title && (
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="flex items-center gap-1.5 font-serif text-[16px] font-bold tracking-[0.08em] text-gold-soft"><IconChart className="text-[16px]" />衣櫥分析｜{label}</h2>
          <Link to="/analysis" className="text-[12.5px] text-amethyst-deep">完整分析</Link>
        </div>
      )}
      {key === "color" ? (
        <div className="flex flex-wrap gap-2">
          {an.by_color.slice(0, Math.max(count, 5)).map((c) => <Link key={c.name} to={`/wardrobe?color=${encodeURIComponent(c.name)}`} className="flex items-center gap-1.5 rounded-full bg-cream/5 py-0.5 pl-0.5 pr-2 text-[12px]"><span className="h-6 w-6 rounded-full ring-1 ring-gold/70" style={{ background: swatch(c.name) }} />{c.name} {c.n}</Link>)}
        </div>
      ) : useBars ? (
        <Bars rows={source.slice(0, count).map((x) => ({ name: x.name, n: x.n, sub: showPct ? pct(x.n, an.total) : undefined }))} format={(n) => `${n} 件`} onPick={(name) => navigate(`/wardrobe?${key}=${encodeURIComponent(name)}`)} />
      ) : (
        <div className="flex items-center gap-4">
          <Donut segs={segs} size={104} thickness={12}>
            <div><div className="font-serif text-[22px] font-bold leading-none text-gold-soft">{an.total}</div><div className="mt-1 text-[10.5px] text-mauve">件</div></div>
          </Donut>
          <ul className="min-w-0 flex-1 space-y-1.5 text-[12.5px]">
            {segs.map((c, i) => (
              <li key={c.name} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SERIES[i % SERIES.length] }} /><span className="truncate">{c.name}</span></span>
                <span className="shrink-0 tabular-nums text-mauve">{c.n}{showPct ? `（${pct(c.n, an.total)}）` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function WSection({ title, more, children, testid }: { title?: string; more?: string; children: ReactNode; testid: string }) {
  return (
    <section className="mt-4" data-testid={testid}>
      {title && (
        <div className="mb-2 flex items-center justify-between">
          <h2 className="ribbon font-serif text-[15px] font-bold tracking-[0.12em]">{title}</h2>
          {more && <Link to={more} className="text-[12.5px] text-amethyst-deep">查看全部</Link>}
        </div>
      )}
      {children}
    </section>
  );
}

function Row({ items, compact, detail }: { items: Garment[]; compact?: boolean; detail?: boolean }) {
  return (
    <div className="scrollbar-none -mx-4 flex gap-2.5 overflow-x-auto px-4">
      {items.map((g) => <div key={g.id} className={`${compact ? "w-[24%]" : "w-[30%]"} shrink-0 sm:w-36`}><GarmentTile g={g} size="sm" showPrice={detail} />{detail && <p className="truncate px-0.5 text-[10.5px] text-mauve">{[g.subcategory, g.brand].filter(Boolean).join("・") || g.category}</p>}</div>)}
    </div>
  );
}
