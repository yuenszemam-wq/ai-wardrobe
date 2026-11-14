import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api, Garment } from "../api";
import { Bars, Donut, pct, SERIES, swatch, topWithOther } from "../components/charts";
import { BgImage, HomeBgEditor } from "../components/HomeBackground";
import { IconCamera, IconChart, IconCloudUp, IconDress, IconLayers, IconPalette, IconPerson, IconScissors, IconShirt } from "../components/icons";
import { Empty, GarmentTile, Link, money, useSettings } from "../components/ui";
import { navigate } from "../router";
import ReviewPanel from "./AiReview";
import { AnalysisData } from "./Analysis";
import { LookPreview, LookSummary, OutfitPreview, OutfitSummary } from "./Outfits";
import { HomeLayout, OVERVIEW_DEFAULT, QUICK_DEFAULT, Widget, WidgetType } from "../../shared/homeLayout";
import { useHomeLayoutState } from "../homeLayoutStore";
import { HomeEditSurface } from "../components/HomeEditSurface";
import { loadFullList } from "../wardrobeList";
import { cachedApi, deriveStats, localGarments } from "../localWardrobe";

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
 * 主頁（Phase 3.8A.2）：類似手機桌面的 Widget 主頁。兩欄響應式 Grid：小型＝半寬、大型＝全寬、中型按選擇；
 * 高度按內容，不強制相同。按「編輯」直接在主頁拖動真實元件；新增小工具時以同一個渲染器顯示真實預覽。
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
  /** 預覽（新增小工具）時暫時需要的資料來源：只讀取一次，與正式元件共用 */
  const [extra, setExtra] = useState<Source[]>([]);
  const layout = draft ?? saved;
  const shown = layout.widgets.filter((w) => w.visible);
  const forceTodo = !!new URLSearchParams(location.search).get("tab") || location.hash === "#todo";
  const needs = new Set<Source>([...shown.flatMap((w) => NEEDS[w.type] ?? []), ...extra]);
  if (forceTodo) needs.add("stats");
  const needKey = [...needs].sort().join(",");
  const loaded = useRef(new Set<Source>());
  const load = useCallback((src: Source) => {
    loaded.current.add(src);
    setErrors((e) => { if (!e[src]) return e; const n = { ...e }; delete n[src]; return n; });
    const fail = (e: unknown) => setErrors((x) => ({ ...x, [src]: (e as Error).message || "讀取失敗" }));
    // Phase 3.8B：讀取失敗（離線）時使用本機副本；統計可由本機衣櫃推導，不會整頁失敗
    if (src === "stats") cachedApi<Stats>("/api/stats").then((r) => { memo.stats = r.data; setS(r.data); }).catch((e) => { const local = localGarments(); if (local) { const v = deriveStats(local) as unknown as Stats; memo.stats = v; setS(v); } else fail(e); });
    else if (src === "analysis") cachedApi<AnalysisData>("/api/analysis").then((r) => { memo.analysis = r.data; setAn(r.data); }).catch(fail);
    else if (src === "garments") loadFullList(new URLSearchParams()).then((v) => { memo.garments = v; setGarments(v); }).catch(fail);
    else Promise.all([cachedApi<{ outfits: OutfitSummary[] }>("/api/outfits").then((r) => r.data), cachedApi<{ looks: LookSummary[] }>("/api/doll/looks").then((r) => r.data)]).then(([o, l]) => {
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
  // 背景同步有改動：只重新讀取衣物及統計（本機資料，不重新下載完整衣櫃）
  useEffect(() => { const on = () => { for (const src of ["garments", "stats"] as Source[]) if (loaded.current.has(src)) load(src); }; window.addEventListener("aw:wardrobe-synced", on); return () => window.removeEventListener("aw:wardrobe-synced", on); }, [load]);
  const need = useCallback((t: WidgetType) => setExtra((x) => { const add = (NEEDS[t] ?? []).filter((src) => !x.includes(src)); return add.length ? [...x, ...add] : x; }), []);
  useEffect(() => {
    if (location.hash === "#todo" || new URLSearchParams(location.search).get("tab")) setTimeout(() => document.getElementById("todo")?.scrollIntoView({ behavior: "smooth" }), 300);
  }, []);
  useEffect(() => { const on = () => setEditing(true); window.addEventListener("aw:edit-home", on); return () => window.removeEventListener("aw:edit-home", on); }, []);
  const data: HomeData = { s, an, garments, looks, seed, errors, retry: load, editing };
  const closeEdit = useCallback(() => { setEditing(false); setDraft(null); setExtra([]); if (new URLSearchParams(location.search).get("edit")) navigate("/", true, false); }, []);
  const renderW = useCallback((w: Widget, preview = false) => <WidgetView w={w} d={preview ? { ...data, editing: true } : data} onChanged={reloadAll} />, [data, reloadAll]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div data-testid="home" data-layout={shown.map((w) => w.type).join(",")} data-editing={editing ? "1" : "0"} data-sources={[...loaded.current].sort().join(",")}>
      {editing
        ? <HomeEditSurface layout={saved} onDraft={setDraft} onClose={closeEdit} render={renderW} onNeed={need} />
        : <div className="grid grid-cols-2 items-start gap-x-3 gap-y-4 pt-2" data-testid="home-grid">{shown.map((w) => <div key={w.id} className={w.span === 2 ? "col-span-2" : "col-span-1 min-w-0"} data-w={w.id} data-span={w.span} data-size={w.size} data-display={w.display}><WidgetView w={w} d={data} onChanged={reloadAll} /></div>)}</div>}
      {!editing && forceTodo && !shown.some((w) => w.type === "todo") && <ReviewPanel onChanged={reloadAll} />}
    </div>
  );
}

/** 讀取失敗：只影響這個元件，保留其他內容，可以局部重試 */
function SourceError({ d, src, label }: { d: HomeData; src: Source; label: string }) {
  return (
    <section className="flex items-center gap-2 rounded-2xl bg-cream/5 px-3 py-2.5 text-[12px]" data-testid={"w-error-" + src}>
      <span className="min-w-0 flex-1 text-mauve">{label}暫時未能讀取（{d.errors[src]}）</span>
      <button type="button" data-retry={src} onClick={() => d.retry(src)} className="chip h-9 shrink-0 rounded-full px-3">重試</button>
    </section>
  );
}
/** 編輯模式／預覽：沒有內容的元件仍顯示可辨認的空狀態示意 */
function Placeholder({ label, testid }: { label: string; testid: string }) {
  return <section className="rounded-2xl border border-dashed border-gold/40 px-3 py-5 text-center text-[12px] text-mauve" data-testid={testid} data-placeholder="1">{label}（暫時沒有內容；有內容時才會顯示）</section>;
}

type Cell = [string, number, string, boolean?];
function StatCell({ c, big, small }: { c: Cell; big?: boolean; small?: boolean }) {
  const [label, n, to, hot] = c;
  return (
    <Link to={to} className={`frame block px-1 text-center ${big ? "py-4" : small ? "py-2" : "py-3"} ${hot ? "frame-hot" : ""}`} data-stat={label}>
      <span className={`block font-serif font-bold leading-none ${big ? "text-[34px]" : small ? "text-[19px]" : "text-[23px]"} ${hot ? "" : "text-gold-soft"}`}>{n}</span>
      <span className="mt-1 block text-[10.5px] text-mauve">{label}</span>
    </Link>
  );
}

function WidgetView({ w, d, onChanged }: { w: Widget; d: HomeData; onChanged: () => void }) {
  // 隨機推薦：重新渲染不會改變內容；按「重新推薦」才更換
  const [seed, setSeed] = useState(() => (w.type.startsWith("random") ? d.seed + w.id.length / 97 : d.seed));
  const o = w.opts, disp = w.display, half = w.span === 1, compact = w.size !== "large";
  const title = (t: string) => (o.title === false ? undefined : t);
  const empty = (label: string) => (d.editing ? <Placeholder label={label} testid={"w-" + w.type} /> : null);
  const need = NEEDS[w.type] ?? [];
  const failed = need.find((src) => d.errors[src] && !(src === "stats" ? d.s : src === "analysis" ? d.an : src === "garments" ? d.garments : d.looks));
  if (failed) return <SourceError d={d} src={failed} label={LABEL[w.type] ?? "這個元件"} />;
  const s = d.s;
  if (need.includes("stats") && !s) return <section className="h-16 animate-pulse rounded-2xl bg-cream/5" data-testid={"w-" + w.type} />;
  const pickGarments = (list: Garment[], sort: string | undefined, filter: (g: Garment) => boolean) => {
    const out = list.filter((g) => filter(g) && (!o.category || g.category === o.category) && (!o.subcategory || g.subcategory === o.subcategory) && (!o.favorite || g.is_favorite));
    const by: Record<string, (a: Garment, b: Garment) => number> = {
      created: (a, b) => b.created_at.localeCompare(a.created_at), created_asc: (a, b) => a.created_at.localeCompare(b.created_at),
      updated: (a, b) => b.updated_at.localeCompare(a.updated_at), name: (a, b) => a.name.localeCompare(b.name, "zh-Hant"),
      price_desc: (a, b) => (b.price ?? -1) - (a.price ?? -1),
    };
    return out.sort(by[sort ?? "created"] ?? by.created).slice(0, disp === "hero" ? 1 : o.count ?? 8);
  };
  const reroll = <button type="button" data-reroll={w.id} onClick={() => setSeed(Math.random())} className="chip h-8 shrink-0 rounded-full px-3 text-[12px]">重新推薦</button>;
  switch (w.type) {
    case "cover": return <Cover w={w} s={s!} />;
    case "overview": {
      const st = s!;
      const all: Record<string, Cell> = {
        total: ["衣物總數", st.total, "/wardrobe"], favorites: ["收藏", st.favorites, "/wardrobe?favorite=1"], ai_todo: ["待整理", st.ai_todo, "/?tab=pending_ai#todo", st.ai_todo > 0],
        ai_review: ["待確認", st.ai_review, "/?tab=pending_review#todo", st.ai_review > 0], ai_done: ["已完成", st.ai_done, "/?tab=done#todo"],
        missing_image: ["缺少圖片", st.missing_image, "/wardrobe?needs_image=1"], unpriced: ["未填價格", Math.max(0, st.total - st.priced_count), "/wardrobe?priced=0"],
      };
      // 自訂統計項目及次序；舊設定（未選擇）沿用原本：前五項＋有數字的其他項目
      const keys = o.items ?? [...OVERVIEW_DEFAULT, ...["missing_image", "unpriced"].filter((k) => all[k][1] > 0)];
      const cells = keys.map((k) => all[k]).filter(Boolean);
      const body = disp === "single" ? <StatCell c={cells[0] ?? all.total} big />
        : disp === "pair" ? <div className="grid grid-cols-2 gap-1.5">{cells.slice(0, 2).map((c) => <StatCell key={c[0]} c={c} small={half} />)}</div>
        : disp === "list" ? <div className="frame divide-y divide-gold/15 px-3 py-1">{cells.map(([label, n, to, hot]) => <Link key={label} to={to} className="flex items-center justify-between py-1.5 text-[12.5px]" data-stat={label}><span className="text-mauve">{label}</span><span className={`font-serif text-[16px] ${hot ? "text-wine" : "text-gold-soft"}`}>{n}</span></Link>)}</div>
        : disp === "row" ? <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${half ? 2 : Math.min(5, Math.max(cells.length, 1))}, minmax(0, 1fr))` }}>{cells.map((c) => <StatCell key={c[0]} c={c} small />)}</div>
        : <div className={`grid ${half ? "grid-cols-2 gap-1.5" : "grid-cols-3 gap-2"}`}>{cells.map((c) => <StatCell key={c[0]} c={c} small={half} />)}</div>;
      return <WSection title={title("衣櫃概覽")} testid="w-overview" items={keys.join(",")}>{body}</WSection>;
    }
    case "value": {
      const st = s!, unpriced = Math.max(0, st.total - st.priced_count);
      // 未填價格的衣物不當作零元：平均只計已填價格的衣物
      const avg = st.priced_count ? st.total_value / st.priced_count : null;
      const ratio = st.total ? st.priced_count / st.total : 0;
      const amount = <div className={`font-serif font-bold leading-none text-gold-soft ${half ? "text-[22px]" : compact ? "text-[24px]" : "text-[30px]"}`}><span className="mr-1 text-[13px] font-normal text-mauve">HK</span>{money(st.total_value)}</div>;
      return (
        <WSection title={title("衣櫃總價")} testid="w-value">
          <Link to="/analysis" className={`frame block px-4 ${compact ? "py-2.5" : "py-3.5"}`} data-value-display={disp}>
            {o.title === false && <div className="text-[11px] tracking-[0.12em] text-mauve">衣櫃總價</div>}
            {amount}
            {disp === "amount_count" && <div className="mt-1 text-[11.5px] text-mauve">{st.priced_count ? `已填價格 ${st.priced_count} 件｜未填 ${unpriced} 件` : "在衣物資料填上價錢，這裡就會自動統計"}</div>}
            {disp === "full" && <dl className="mt-2 grid grid-cols-3 gap-1 text-center text-[11px]"><div><dt className="text-mauve">已填價格</dt><dd className="font-serif text-[15px] text-gold-soft">{st.priced_count}</dd></div><div><dt className="text-mauve">未填價格</dt><dd className="font-serif text-[15px] text-gold-soft">{unpriced}</dd></div><div><dt className="text-mauve">平均（已填）</dt><dd className="font-serif text-[15px] text-gold-soft">{avg == null ? "—" : money(Math.round(avg))}</dd></div></dl>}
            {disp === "progress" && <div className="mt-2"><div className="h-2 overflow-hidden rounded-full bg-cream/10"><div className="h-full rounded-full" style={{ width: `${Math.round(ratio * 100)}%`, background: "var(--aw-chart)" }} /></div><div className="mt-1 text-[11px] text-mauve">價格資料完成度 {Math.round(ratio * 100)}%（{st.priced_count}／{st.total}）</div></div>}
          </Link>
        </WSection>
      );
    }
    case "quick": {
      const all: Record<string, [string, string, typeof IconShirt]> = { upload: ["/import", "上傳", IconCloudUp], outfit: ["/outfits/new", "配搭", IconShirt], dressing: ["/dressing", "換裝", IconPerson], setup: ["/dressing/setup", "衣服設定", IconScissors], assets: ["/dressing/assets", "角色素材", IconPalette], analysis: ["/analysis", "分析", IconChart], wardrobe: ["/wardrobe", "衣櫃", IconDress], looks: ["/outfits", "我的穿搭", IconLayers] };
      const keys = (o.items ?? QUICK_DEFAULT).filter((k) => all[k]);
      const shownKeys = disp === "single" ? keys.slice(0, 1) : keys;
      const cols = disp === "cards2" ? "grid-cols-2" : disp === "grid" ? (half ? "grid-cols-2" : "grid-cols-4") : disp === "single" ? "grid-cols-1" : half ? "grid-cols-3" : keys.length <= 2 ? "grid-cols-2" : keys.length === 3 ? "grid-cols-3" : keys.length === 4 ? "grid-cols-4" : "grid-cols-5";
      return (
        <WSection title={title("快捷操作")} testid="w-quick" items={keys.join(",")}>
          <div className={`grid ${cols} gap-1.5`}>
            {shownKeys.map((k) => {
              const [to, label, Icon] = all[k];
              if (disp === "cards2") return <Link key={k} to={to} className="frame flex items-center gap-2 px-3 py-2.5 text-[12.5px]"><Icon className="text-[18px] text-gold-soft" />{label}</Link>;
              if (disp === "single") return <Link key={k} to={to} className="frame flex flex-col items-center gap-1 py-4 text-[13px]"><Icon className="text-[26px] text-gold-soft" />{label}</Link>;
              return <Link key={k} to={to} className={`chip flex flex-col items-center gap-1 rounded-2xl ${compact ? "py-2" : "py-3"} text-[11px]`}><Icon className="text-[18px] text-gold-soft" />{label}</Link>;
            })}
          </div>
        </WSection>
      );
    }
    case "recent": case "updated": case "favorites": case "random_garment": {
      if (!d.garments) return <WSection title={title(LABEL[w.type])} testid={"w-" + w.type}><div className="h-28 animate-pulse rounded-2xl bg-cream/5" /></WSection>;
      let items: Garment[];
      if (w.type === "random_garment") {
        const pool = d.garments.filter((g) => g.primary_image_id && (!o.category || g.category === o.category) && (!o.subcategory || g.subcategory === o.subcategory) && (!o.favorite || g.is_favorite));
        items = [...pool].sort((a, b) => hash(a.id, seed) - hash(b.id, seed)).slice(0, disp === "hero" ? 1 : o.count ?? 3);
      } else items = pickGarments(d.garments, w.type === "updated" ? "updated" : o.sort, w.type === "favorites" ? (g) => g.is_favorite : () => true);
      if (!items.length && o.only_when_content) return empty(LABEL[w.type]);
      const more = w.type === "favorites" ? "/wardrobe?favorite=1" : w.type === "updated" ? "/wardrobe?sort=updated" : "/wardrobe";
      return (
        <WSection title={title(LABEL[w.type] + (o.subcategory ? `｜${o.subcategory}` : o.category ? `｜${o.category}` : ""))} more={w.type === "random_garment" || half ? undefined : more} action={w.type === "random_garment" ? reroll : undefined} testid={"w-" + w.type}>
          {items.length ? <GarmentDisplay items={items} disp={disp} half={half} compact={compact} o={o} /> : <Empty title="未有衣物">上傳衣物後就會在這裡顯示。</Empty>}
        </WSection>
      );
    }
    case "recent_looks": case "fav_looks": case "random_look": {
      if (!d.looks) return d.editing ? <Placeholder label={LABEL[w.type]} testid={"w-" + w.type} /> : null;
      let list = (w.type === "fav_looks" ? d.looks.filter((l) => l.is_favorite) : [...d.looks]).filter((l) => !o.look_kind || o.look_kind === "all" || l.kind === o.look_kind);
      if (w.type === "random_look") list = list.sort((a, b) => hash(a.id, seed) - hash(b.id, seed));
      else list.sort((a, b) => (o.sort === "name" ? a.name.localeCompare(b.name, "zh-Hant") : o.sort === "created" ? b.created_at.localeCompare(a.created_at) : b.updated_at.localeCompare(a.updated_at)));
      list = list.slice(0, disp === "hero" ? 1 : o.count ?? 6);
      if (!list.length && (o.only_when_content || w.type === "random_look")) return empty(LABEL[w.type]);
      const card = (e: LookEntry, cls: string) => (
        <Link key={e.kind + e.id} to={e.kind === "outfit" ? `/outfits/${e.id}` : `/dressing/${e.id}`} className={`paper block p-1.5 ${cls}`} data-look={e.id}>
          {e.outfit ? <OutfitPreview o={e.outfit} /> : <LookPreview l={e.look!} />}
          <span className="mt-1 block truncate px-0.5 text-[12px] font-medium text-ink">{e.name}</span>
        </Link>
      );
      return (
        <WSection title={title(LABEL[w.type])} more={half ? undefined : "/outfits"} action={w.type === "random_look" ? reroll : undefined} testid={"w-" + w.type}>
          {!list.length ? <Empty title="仍未有造型">到穿搭工作室開始配搭。</Empty>
            : disp === "hero" ? card(list[0], "w-full")
            : disp === "grid2" || disp === "grid3" ? <div className={`grid ${disp === "grid2" || half ? "grid-cols-2" : "grid-cols-3"} gap-2`}>{list.map((e) => card(e, ""))}</div>
            : disp === "list" ? <div className="frame divide-y divide-gold/15 px-2 py-1">{list.map((e) => <Link key={e.kind + e.id} to={e.kind === "outfit" ? `/outfits/${e.id}` : `/dressing/${e.id}`} className="flex items-center gap-2 py-1.5 text-[12.5px]"><span className="w-10 shrink-0">{e.outfit ? <OutfitPreview o={e.outfit} /> : <LookPreview l={e.look!} />}</span><span className="min-w-0 flex-1 truncate">{e.name}</span><span className="text-[10.5px] text-mauve">{e.kind === "outfit" ? "衣服配搭" : "角色換裝"}</span></Link>)}</div>
            : <div className="scrollbar-none -mx-4 flex gap-2.5 overflow-x-auto px-4">{list.map((e) => card(e, `shrink-0 ${compact ? "w-[26%]" : "w-[34%]"} sm:w-36`))}</div>}
        </WSection>
      );
    }
    case "analysis": return d.an && d.an.total > 0 ? <AnalysisSummary an={d.an} mode={o.mode ?? "category"} title={o.title !== false} count={o.count ?? 5} display={disp} half={half} showPct={o.show_pct !== false} legend={o.legend !== false} /> : d.an || d.editing ? empty("衣櫃分析摘要") : <section className="h-24 animate-pulse rounded-2xl bg-cream/5" data-testid="w-analysis" />;
    case "todo": {
      const st = s!;
      const items: [string, number, string][] = [["AI 待整理", st.ai_todo, "/?tab=pending_ai#todo"], ["AI 待確認", st.ai_review, "/?tab=pending_review#todo"], ["缺少圖片", st.missing_image, "/wardrobe?needs_image=1"], ["未填價格", Math.max(0, st.total - st.priced_count), "/wardrobe?priced=0"]];
      const any = items.some((x) => x[1] > 0);
      if (!any && o.only_when_content && !new URLSearchParams(location.search).get("tab")) return empty("待處理事項");
      const total = items.reduce((a, x) => a + x[1], 0);
      return (
        <WSection title={title("待處理事項")} testid="w-todo">
          {disp === "count" ? <Link to="/?tab=pending_ai#todo" className="frame block py-4 text-center"><span className="block font-serif text-[30px] leading-none text-gold-soft">{total}</span><span className="text-[11px] text-mauve">待處理</span></Link>
            : disp === "list" ? <div className="frame divide-y divide-gold/15 px-3 py-1">{items.map(([label, n, to]) => <Link key={label} to={to} className="flex justify-between py-1.5 text-[12.5px]"><span>{label}</span><span className={n ? "text-wine" : "text-mauve"}>{n}</span></Link>)}</div>
            : <div className="flex flex-wrap gap-1.5">
              {items.filter((x) => x[1] > 0 || !o.only_when_content).map(([label, n, to]) => <Link key={label} to={to} className={`rounded-full px-3 py-1.5 text-[12px] ${n ? "chip-on" : "chip"}`}>{label} {n}</Link>)}
              {!any && <span className="text-[12px] text-mauve">沒有待處理事項</span>}
            </div>}
          {!d.editing && !half && (st.ai_todo > 0 || st.ai_review > 0 || new URLSearchParams(location.search).get("tab")) && <ReviewPanel onChanged={onChanged} />}
        </WSection>
      );
    }
  }
  return null;
}

/** 衣物元件的展示方式：橫向滑動、單件大圖、雙欄／三欄、緊湊詳細列表 */
function GarmentDisplay({ items, disp, half, compact, o }: { items: Garment[]; disp: string; half: boolean; compact: boolean; o: Widget["opts"] }) {
  const meta = (g: Garment) => [o.show_brand !== false && g.brand, o.show_category !== false && (g.subcategory || g.category)].filter(Boolean).join("・");
  if (disp === "hero") return <div className={half ? "" : "mx-auto w-2/3"}><GarmentTile g={items[0]} size="md" showPrice={!!o.detail} /></div>;
  if (disp === "grid2" || disp === "grid3") return <div className={`grid ${disp === "grid2" || half ? "grid-cols-2" : "grid-cols-3"} gap-2`}>{items.map((g) => <div key={g.id} className="min-w-0"><GarmentTile g={g} size="sm" showPrice={!!o.detail} />{o.detail && <p className="truncate px-0.5 text-[10.5px] text-mauve">{meta(g)}</p>}</div>)}</div>;
  if (disp === "list") return (
    <div className="frame divide-y divide-gold/15 px-2 py-1">
      {items.map((g) => (
        <Link key={g.id} to={`/g/${g.id}`} className="flex items-center gap-2 py-1.5" data-garment-row={g.id}>
          <span className="w-10 shrink-0"><GarmentTile g={g} size="xs" /></span>
          <span className="min-w-0 flex-1">{o.show_name !== false && <span className="block truncate text-[12.5px]">{g.name}</span>}<span className="block truncate text-[10.5px] text-mauve">{meta(g)}{o.detail && g.price != null ? `｜${money(g.price)}` : ""}</span></span>
        </Link>
      ))}
    </div>
  );
  return <Row items={items} compact={compact || half} detail={!!o.detail} />;
}

const LABEL: Record<string, string> = { cover: "背景封面", overview: "衣櫃概覽", value: "衣櫃總價", todo: "待處理事項", analysis: "衣櫃分析", recent: "最近加入", updated: "最近修改", favorites: "收藏衣物", random_garment: "隨機推薦", recent_looks: "最近穿搭", fav_looks: "收藏穿搭", random_look: "隨機穿搭" };
const hash = (id: string, seed: number) => { let h = Math.floor(seed * 1e9); for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761); return h >>> 0; };

/**
 * 背景封面：保留已設定的主頁背景圖片。展示方式：全幅大圖、橫向封面、迷你封面（半寬）、純圖片、圖片＋名稱、圖片＋統計。
 * 可設定高度、裁切位置、縮放、文字位置及背景遮罩（文字可讀性漸層）。
 */
function Cover({ w, s }: { w: Widget; s: Stats }) {
  const settings = useSettings();
  const [editBg, setEditBg] = useState(false);
  const bg = settings?.home_bg ?? null;
  const o = w.opts, disp = w.display;
  const shade = o.shade ?? 0.55;
  const mini = disp === "mini";
  const ratio = o.height ?? (disp === "banner" ? 45 : mini ? 100 : bg?.ratio ?? 78), top = o.text_pos === "top";
  const showName = disp === "image" || disp === "stats" ? false : o.show_name !== false;
  const showStats = disp === "image" || disp === "name" ? false : o.show_stats !== false;
  const layout = bg ? { ...bg, ratio, ...(o.pos_y != null ? { y: o.pos_y } : {}), ...(o.zoom != null ? { zoom: o.zoom } : {}) } : null;
  const shadow = bg && shade > 0 ? { textShadow: `0 1px 6px color-mix(in srgb, var(--aw-shadow) ${Math.round((shade + 0.1) * 100)}%, transparent), 0 0 2px color-mix(in srgb, var(--aw-shadow) ${Math.round((shade + 0.1) * 100)}%, transparent)` } : undefined;
  if (mini) return (
    <section className="frame relative overflow-hidden" style={{ containerType: "inline-size" }} data-testid="w-cover" data-ratio={ratio}>
      {bg && layout ? <BgImage src={bg.url} iw={bg.width} ih={bg.height} layout={layout} fade={false} /> : <div className="aspect-square" />}
      <div className={`absolute inset-x-0 ${top ? "top-0" : "bottom-0"} p-2`} style={shadow}>
        {showName && <p className="truncate font-serif text-[15px] font-bold text-gold-soft">{o.name || "我的衣櫃"}</p>}
        {showStats && <p className="text-[11px] text-cream">{s.total} 件｜收藏 {s.favorites}</p>}
      </div>
    </section>
  );
  return (
    <section className="relative -mx-4 -mt-2" style={{ containerType: "inline-size", ...(bg && top ? { minHeight: `${ratio}cqw` } : {}) }} data-testid="w-cover" data-ratio={ratio}>
      {bg && layout && <div className="absolute inset-x-0 top-0"><BgImage src={bg.url} iw={bg.width} ih={bg.height} layout={layout} /></div>}
      <button type="button" onClick={() => setEditBg(true)} className="btn-dark absolute right-3 top-3 z-10 flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] opacity-90" aria-label={bg ? "更換主頁背景" : "加入主頁背景"}>
        <IconCamera className="text-[14px]" />{bg ? "背景" : "加入背景"}
      </button>
      {(showName || showStats) ? (
        <div className={`relative px-4 pb-1 ${o.align === "center" ? "text-center" : ""}`} style={{ paddingTop: !bg ? "1.25rem" : top ? "3.25rem" : `max(1.75rem, calc(${ratio}cqw - 7.5rem))` }}>
          <div className="min-w-0" style={shadow}>
            {showName && <h1 className="font-serif text-[24px] font-bold tracking-[0.08em] text-gold-soft">{o.name || "我的衣櫃"}</h1>}
            {showStats && (
              <div className={`mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[13.5px] text-cream ${o.align === "center" ? "justify-center" : ""}`}>
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

/** 主頁的衣櫥分析摘要：主分類、子分類、顏色、品牌或風格；圓環、長條、排行、單一比例或純數字 */
function AnalysisSummary({ an, mode, title, count = 5, display, half, showPct = true, legend = true }: { an: AnalysisData; mode: string; title: boolean; count?: number; display: string; half: boolean; showPct?: boolean; legend?: boolean }) {
  const source = mode === "subcategory" ? an.by_subcategory : mode === "color" ? an.by_color : mode === "brand" ? an.by_brand : mode === "style" ? an.by_style.filter((x) => x.name !== "未填風格") : an.by_category;
  const key = mode === "subcategory" ? "subcategory" : mode === "color" ? "color" : mode === "brand" ? "brand" : mode === "style" ? "style" : "category";
  const label = { category: "主分類", subcategory: "子分類", color: "顏色", brand: "品牌", style: "風格" }[key] ?? "主分類";
  const segs = topWithOther(source, count);
  const chart = key === "color" && (display === "donut" || display === "bars") ? "swatch" : display;
  const top1 = source[0];
  return (
    <section className={`frame ${half ? "px-3 pb-3 pt-3" : "px-4 pb-4 pt-4"}`} data-testid="w-analysis" data-chart={chart}>
      {title && (
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-1.5 truncate font-serif text-[15px] font-bold tracking-[0.08em] text-gold-soft"><IconChart className="shrink-0 text-[16px]" />{half ? label : `衣櫥分析｜${label}`}</h2>
          {!half && <Link to="/analysis" className="shrink-0 text-[12.5px] text-amethyst-deep">完整分析</Link>}
        </div>
      )}
      {chart === "swatch" ? (
        <div className="flex flex-wrap gap-2">
          {an.by_color.slice(0, Math.max(count, 5)).map((c) => <Link key={c.name} to={`/wardrobe?color=${encodeURIComponent(c.name)}`} className="flex items-center gap-1.5 rounded-full bg-cream/5 py-0.5 pl-0.5 pr-2 text-[12px]"><span data-color-swatch className="h-6 w-6 rounded-full ring-1 ring-gold/70" style={{ background: swatch(c.name) }} />{c.name} {c.n}</Link>)}
        </div>
      ) : chart === "bars" ? (
        <Bars rows={source.slice(0, count).map((x) => ({ name: x.name, n: x.n, sub: showPct ? pct(x.n, an.total) : undefined }))} format={(n) => `${n} 件`} onPick={(name) => navigate(`/wardrobe?${key}=${encodeURIComponent(name)}`)} />
      ) : chart === "rank" ? (
        <ol className="space-y-1 text-[12.5px]">{source.slice(0, count).map((x, i) => <li key={x.name} className="flex items-center gap-2"><span className="w-5 font-serif text-gold-soft">{i + 1}</span><span className="min-w-0 flex-1 truncate">{x.name}</span><span className="tabular-nums text-mauve">{x.n}{showPct ? `｜${pct(x.n, an.total)}` : ""}</span></li>)}</ol>
      ) : chart === "ratio" ? (
        <div className="flex items-center gap-3">
          <Donut segs={[{ name: top1?.name ?? "", n: top1?.n ?? 0 }, { name: "其他", n: an.total - (top1?.n ?? 0), color: "color-mix(in srgb, var(--color-cream) 12%, transparent)" }]} size={half ? 60 : 80} thickness={9}><span className="text-[11px] font-bold text-gold-soft">{pct(top1?.n ?? 0, an.total)}</span></Donut>
          <div className="min-w-0"><p className="truncate text-[13px]">{top1?.name ?? "—"}</p><p className="text-[11px] text-mauve">佔全部 {an.total} 件</p></div>
        </div>
      ) : chart === "numbers" ? (
        <div className="grid grid-cols-2 gap-2 text-center"><div><p className="font-serif text-[24px] leading-none text-gold-soft">{an.total}</p><p className="text-[11px] text-mauve">衣物</p></div><div><p className="font-serif text-[24px] leading-none text-gold-soft">{source.length}</p><p className="text-[11px] text-mauve">{label}數目</p></div></div>
      ) : (
        <div className={`flex items-center ${half ? "flex-col gap-2" : "gap-4"}`}>
          <Donut segs={segs} size={half ? 86 : 104} thickness={12}>
            <div><div className="font-serif text-[22px] font-bold leading-none text-gold-soft">{an.total}</div><div className="mt-1 text-[10.5px] text-mauve">件</div></div>
          </Donut>
          {legend && <ul className="min-w-0 flex-1 space-y-1.5 text-[12.5px]">
            {segs.map((c, i) => (
              <li key={c.name} className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: SERIES[i % SERIES.length] }} /><span className="truncate">{c.name}</span></span>
                <span className="shrink-0 tabular-nums text-mauve">{c.n}{showPct ? `（${pct(c.n, an.total)}）` : ""}</span>
              </li>
            ))}
          </ul>}
        </div>
      )}
    </section>
  );
}

function WSection({ title, more, action, children, testid, items }: { title?: string; more?: string; action?: ReactNode; children: ReactNode; testid: string; items?: string }) {
  return (
    <section data-testid={testid}>
      {(title || action) && (
        <div className="mb-2 flex items-center justify-between gap-2">
          {title ? <h2 className="ribbon min-w-0 truncate font-serif text-[15px] font-bold tracking-[0.12em]">{title}</h2> : <span />}
          {action ?? (more && <Link to={more} className="shrink-0 text-[12.5px] text-amethyst-deep">查看全部</Link>)}
        </div>
      )}
      {items !== undefined ? <div data-items={items}>{children}</div> : children}
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
