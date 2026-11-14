// 衣服設定工作室（Phase 3.4）：管理及校正每件衣服的預設穿著效果（位置、變形、遮罩、骨架、拆件）。
// 不會建立穿搭造型；在這裡保存只更新相應的衣物預設（/api/doll/templates）。
import { useEffect, useMemo, useRef, useState } from "react";
import { useListPosition } from "../hooks/useListPosition";
import { SETUP_KEYS, SETUP_LABEL } from "../../shared/doll";
import { api, displayName, Garment, imageUrl } from "../api";
import { IconChevronLeft, IconChevronRight, IconSearch, IconSort } from "../components/icons";
import { TransparentImage } from "../components/TransparentImage";
import { Spinner, toast } from "../components/ui";
import { Templates, fetchStudioGarments, fetchTemplates } from "../doll/model";
import { ITEM_LABEL, ItemState, OVERALL_LABEL, Overall, SetupInfo, setupInfo } from "../doll/setup";
import { navigate } from "../router";
import { ModelSummary, V2_SUMMARY, listModels } from "../doll/models";
import { isBuiltinModel } from "../../shared/avatarModel";
import { useTaxonomy } from "../taxonomy";

type Filter = "all" | Overall;
const FILTERS: [Filter, string][] = [["all", "全部"], ["done", "已設定"], ["partial", "部分設定"], ["none", "未設定"], ["stale", "需要重新校正"]];
type Sort = "recent" | "name" | "todo";
const SORT_LABEL: Record<Sort, string> = { recent: "最近設定", name: "名稱", todo: "未完成優先" };
const VIEW_KEY = "aw:setup:view";
/** 編輯器的「上一件／下一件」用目前列表的次序 */
export const SETUP_LIST_KEY = "aw:setup:list";

/** 狀態符號：✓ 已完成、？ 待確認、！ 需要處理、自 自動、— 不需要／未設定 */
const STATE_MARK: Record<ItemState, string> = { done: "✓", review: "？", todo: "！", auto: "自", na: "不需", optional: "—" };
const STATE_TEXT: Record<ItemState, string> = { done: "text-ok-ink", review: "text-gold-soft", todo: "text-danger-ink", auto: "text-cream/80", na: "text-cream/50", optional: "text-cream/50" };
const OVERALL_TONE: Record<Overall, string> = { done: "bg-ok/30 text-ok-ink", partial: "bg-gold/25 text-gold-soft", none: "bg-white/10 text-cream/70", stale: "bg-danger/45 text-white" };

function loadView(): { filter: Filter; sort: Sort; cat: string; sub: string; q: string; model: string | null } {
  const d = { filter: "all" as Filter, sort: "todo" as Sort, cat: "", sub: "", q: "", model: null as string | null };
  try { return { ...d, ...JSON.parse(sessionStorage.getItem(VIEW_KEY) || "{}") }; } catch { return d; }
}
const ago = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso), days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days <= 0 ? "今日" : days === 1 ? "昨日" : days < 30 ? `${days} 日前` : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function GarmentSetup() {
  const [garments, setGarments] = useState<Garment[] | null>(null);
  const [tpls, setTpls] = useState<Templates | null>(null);
  // 目前校正的身體模型（每個身體有自己的衣物設定；網址 ?model= 保留選擇）
  const init = loadView();
  // 網址沒有指定時，返回上次使用的身體模型（Phase 3.8A.1 返回位置）
  const [model, setModel] = useState<string>(() => new URLSearchParams(location.search).get("model") || init.model || V2_SUMMARY.id);
  const [models, setModels] = useState<ModelSummary[]>([V2_SUMMARY]);
  const [filter, setFilter] = useState<Filter>(init.filter);
  const [sort, setSort] = useState<Sort>(init.sort);
  const [cat, setCat] = useState(init.cat);
  const [sub, setSub] = useState(init.sub);
  const [q, setQ] = useState(init.q);
  const [search, setSearch] = useState(!!init.q);
  const tax = useTaxonomy();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    fetchStudioGarments().then(setGarments).catch((e) => toast((e as Error).message, "err"));
    listModels().then((r) => setModels(r.models)).catch(() => undefined);
  }, []);
  useEffect(() => {
    setTpls(null);
    fetchTemplates(model).then(setTpls).catch((e) => { toast((e as Error).message, "err"); if (!isBuiltinModel(model)) setModel(V2_SUMMARY.id); });
    try { history.replaceState(null, "", "/dressing/setup" + (isBuiltinModel(model) ? "" : `?model=${model}`)); } catch { /* 忽略 */ }
  }, [model]);
  const modelQs = isBuiltinModel(model) ? "" : `?model=${model}`;
  useEffect(() => { try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ filter, sort, cat, sub, q, model })); } catch { /* 私密瀏覽 */ } }, [filter, sort, cat, sub, q, model]);

  const infos = useMemo(() => {
    const m = new Map<string, SetupInfo>();
    if (garments && tpls) for (const g of garments) m.set(g.id, setupInfo(g, tpls));
    return m;
  }, [garments, tpls]);
  const counts = useMemo(() => { const c: Record<Filter, number> = { all: 0, done: 0, partial: 0, none: 0, stale: 0 }; for (const i of infos.values()) { c.all++; c[i.overall]++; } return c; }, [infos]);
  const cats = useMemo(() => {
    const have = new Set((garments || []).map((g) => g.category || "").filter(Boolean)), order = tax.categories.map((c) => c.name);
    return [...have].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
  }, [garments, tax]);
  const subs = useMemo(() => {
    if (!cat) return [];
    const have = new Set((garments || []).filter((g) => g.category === cat).map((g) => g.subcategory || "").filter(Boolean));
    const order = tax.categories.find((c) => c.name === cat)?.subs.map((s) => s.name) ?? [];
    return [...have].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
  }, [garments, cat, tax]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rank: Record<Overall, number> = { stale: 0, partial: 1, none: 2, done: 3 };
    const out = (garments || []).filter((g) => {
      const i = infos.get(g.id);
      return !!i && (filter === "all" || i.overall === filter) && (!cat || g.category === cat) && (!sub || g.subcategory === sub) && (!needle || [g.name, g.brand, g.subcategory].some((v) => (v || "").toLowerCase().includes(needle)));
    });
    return out.sort((a, b) => {
      const ia = infos.get(a.id)!, ib = infos.get(b.id)!;
      if (sort === "name") return displayName(a).localeCompare(displayName(b), "zh-Hant");
      if (sort === "todo") return rank[ia.overall] - rank[ib.overall] || (ib.updated_at ?? "").localeCompare(ia.updated_at ?? "");
      return (ib.updated_at ?? "").localeCompare(ia.updated_at ?? "");
    });
  }, [garments, infos, filter, cat, sub, q, sort]);

  // 返回位置：校正第 35 件衣服後返回，仍然停在第 35 件附近（按身體模型分開）
  const listIds = useMemo(() => (garments && tpls ? list.map((g) => g.id) : null), [garments, tpls, list]);
  useListPosition("setup:" + model, listIds, listRef);
  const open = (id: string) => {
    try { sessionStorage.setItem(SETUP_LIST_KEY, JSON.stringify(list.map((g) => g.id))); } catch { /* 私密瀏覽 */ }
    navigate(`/dressing/setup/${id}${modelQs}`);
  };

  return (
    <div data-testid="garment-setup" className="pb-6">
      <div className="flex items-center gap-2 pb-2 pt-5">
        <button type="button" aria-label="返回穿搭工作室" onClick={() => navigate("/outfits")} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconChevronLeft /></button>
        <h1 className="flex-1 font-serif text-[21px] font-bold tracking-[0.12em] text-gold-soft">衣服設定</h1>
        <button type="button" aria-label="搜尋衣物" aria-pressed={search} onClick={() => { setSearch(!search); setQ(""); }} className={`grid h-9 w-9 place-items-center rounded-full text-[16px] ${search ? "chip-on" : "chip"}`}><IconSearch /></button>
        <button type="button" aria-label={`排序：${SORT_LABEL[sort]}`} data-testid="setup-sort" onClick={() => setSort(sort === "todo" ? "recent" : sort === "recent" ? "name" : "todo")} className="chip flex h-9 items-center gap-1 rounded-full px-3 text-[12px]"><IconSort className="text-[15px]" />{SORT_LABEL[sort]}</button>
      </div>
      <p className="pb-2 text-[11.5px] leading-snug text-mauve">每件衣服在每個身體校正一次（位置、網格、遮罩、骨架及基準姿勢），之後任何新造型穿上時都會自動使用。這裡不會建立穿搭造型。</p>
      {models.length > 1 && (
        <div className="scrollbar-none -mx-4 mb-2 flex items-center gap-1.5 overflow-x-auto px-4" data-testid="setup-models">
          <span className="shrink-0 text-[11.5px] text-gold-soft">目前校正模型</span>
          {models.map((m) => <button key={m.id} type="button" data-setup-model={m.id} aria-pressed={model === m.id} onClick={() => setModel(m.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] ${model === m.id ? "chip-on" : "chip"}`}>{m.name}</button>)}
        </div>
      )}
      {search && <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋衣服名稱" aria-label="搜尋衣服名稱" className="mb-2 h-10 w-full rounded-full bg-white px-4 text-[14px] text-ink ring-1 ring-gold focus:outline-none" />}
      <div className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-2" data-testid="setup-filters">
        {FILTERS.map(([f, label]) => <button key={f} type="button" data-filter={f} aria-pressed={filter === f} onClick={() => setFilter(f)} className={`shrink-0 rounded-full px-3 py-1.5 text-[12.5px] ${filter === f ? "chip-on" : "chip"}`}>{label} <span className="opacity-70">{counts[f]}</span></button>)}
      </div>
      <div className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1.5" data-testid="setup-cats">
        {["", ...cats].map((c) => <button key={c || "all"} type="button" onClick={() => { setCat(c); setSub(""); }} className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] ${cat === c ? "chip-on" : "bg-white/5 text-cream/85"}`}>{c || "全部分類"}</button>)}
      </div>
      {subs.length > 1 && (
        <div className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 pb-1.5" data-testid="setup-subcats">
          {["", ...subs].map((c) => <button key={c || "all"} type="button" onClick={() => setSub(c)} className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] ${sub === c ? "chip-on" : "bg-white/5 text-cream/75"}`}>{c || "全部"}</button>)}
        </div>
      )}
      {!garments || !tpls ? <div className="py-16"><Spinner /></div> : list.length === 0 ? (
        <p className="py-12 text-center text-[12.5px] text-mauve">沒有符合的衣物</p>
      ) : (
        <ul ref={listRef} className="mt-1 space-y-1.5" data-testid="setup-list">
          {list.map((g) => {
            const i = infos.get(g.id)!;
            return (
              <li key={g.id} data-pos-id={g.id}>
                <button type="button" data-setup-garment={g.id} data-overall={i.overall} onClick={() => open(g.id)} className="frame flex w-full items-center gap-2.5 px-2 py-1.5 text-left">
                  <span className="relative h-12 w-9 shrink-0 overflow-hidden rounded-lg bg-white/85"><TransparentImage src={imageUrl(g.transparent_image_id)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-0.5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5"><span className="truncate text-[13px] font-medium">{displayName(g)}</span><span className={`shrink-0 rounded-full px-1.5 text-[10px] leading-[16px] ${OVERALL_TONE[i.overall]}`}>{OVERALL_LABEL[i.overall]}</span></span>
                    <span className="block truncate text-[10.5px] leading-4 text-mauve">{[g.category, g.subcategory].filter(Boolean).join("・")}{i.updated_at ? `｜${ago(i.updated_at)}` : ""}{i.convertible ? "｜由 V2 換算" : ""}</span>
                    {/* 一行小型狀態指標：圖示＋文字（不只依靠顏色） */}
                    <span className="flex items-center gap-0.5 overflow-hidden whitespace-nowrap text-[10.5px] leading-4" data-testid="setup-status-line">
                      {SETUP_KEYS.map((k, n) => <span key={k} data-item={k} data-state={i.items[k]} title={`${SETUP_LABEL[k]}：${i.items[k] === "optional" ? "未設定" : ITEM_LABEL[i.items[k]]}`} className={STATE_TEXT[i.items[k]]}>{n ? <span aria-hidden className="mx-0.5 text-mauve/50">｜</span> : null}{SETUP_LABEL[k]} {STATE_MARK[i.items[k]]}</span>)}
                      {i.pieces && <span data-pieces className={i.pieces.set < i.pieces.total ? STATE_TEXT.todo : STATE_TEXT.done}><span aria-hidden className="mx-0.5 text-mauve/50">｜</span>拆件 {i.pieces.set}/{i.pieces.total}</span>}
                      {i.convertible && <span data-convertible="1" className="sr-only">自動初始位置（由 V2 換算）</span>}
                    </span>
                  </span>
                  <IconChevronRight className="shrink-0 text-[15px] text-mauve" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
