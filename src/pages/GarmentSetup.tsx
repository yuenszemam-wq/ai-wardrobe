// 衣服設定工作室（Phase 3.4）：管理及校正每件衣服的預設穿著效果（位置、變形、遮罩、骨架、拆件）。
// 不會建立穿搭造型；在這裡保存只更新相應的衣物預設（/api/doll/templates）。
import { useEffect, useMemo, useState } from "react";
import { SETUP_KEYS, SETUP_LABEL } from "../../shared/doll";
import { api, displayName, Garment, imageUrl } from "../api";
import { IconChevronLeft, IconChevronRight, IconSearch, IconSort } from "../components/icons";
import { TransparentImage } from "../components/TransparentImage";
import { Spinner, toast } from "../components/ui";
import { Templates, fetchStudioGarments, fetchTemplates } from "../doll/model";
import { ITEM_LABEL, ItemState, OVERALL_LABEL, Overall, SetupInfo, setupInfo } from "../doll/setup";
import { navigate } from "../router";
import { useTaxonomy } from "../taxonomy";

type Filter = "all" | Overall;
const FILTERS: [Filter, string][] = [["all", "全部"], ["done", "已設定"], ["partial", "部分設定"], ["none", "未設定"], ["stale", "需要重新校正"]];
type Sort = "recent" | "name" | "todo";
const SORT_LABEL: Record<Sort, string> = { recent: "最近設定", name: "名稱", todo: "未完成優先" };
const VIEW_KEY = "aw:setup:view";
/** 編輯器的「上一件／下一件」用目前列表的次序 */
export const SETUP_LIST_KEY = "aw:setup:list";

const STATE_TONE: Record<ItemState, string> = { auto: "bg-white/5 text-mauve", review: "bg-gold/20 text-gold-soft", done: "bg-[#6fbf8f]/25 text-[#bfeccf]", na: "bg-white/10 text-cream/60", todo: "bg-[#a12c4b]/35 text-[#ffc6d6]", optional: "bg-white/5 text-mauve" };
const OVERALL_TONE: Record<Overall, string> = { done: "bg-[#6fbf8f]/30 text-[#d6f5e1]", partial: "bg-gold/25 text-gold-soft", none: "bg-white/10 text-cream/70", stale: "bg-[#a12c4b]/45 text-white" };

function loadView(): { filter: Filter; sort: Sort; cat: string; sub: string } {
  try { return { filter: "all", sort: "todo", cat: "", sub: "", ...JSON.parse(sessionStorage.getItem(VIEW_KEY) || "{}") }; } catch { return { filter: "all", sort: "todo", cat: "", sub: "" }; }
}
const ago = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso), days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days <= 0 ? "今日" : days === 1 ? "昨日" : days < 30 ? `${days} 日前` : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function GarmentSetup() {
  const [garments, setGarments] = useState<Garment[] | null>(null);
  const [tpls, setTpls] = useState<Templates | null>(null);
  const init = loadView();
  const [filter, setFilter] = useState<Filter>(init.filter);
  const [sort, setSort] = useState<Sort>(init.sort);
  const [cat, setCat] = useState(init.cat);
  const [sub, setSub] = useState(init.sub);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState(false);
  const tax = useTaxonomy();

  useEffect(() => {
    Promise.all([fetchStudioGarments(), fetchTemplates()])
      .then(([g, t]) => { setGarments(g); setTpls(t); })
      .catch((e) => toast((e as Error).message, "err"));
  }, []);
  useEffect(() => { try { sessionStorage.setItem(VIEW_KEY, JSON.stringify({ filter, sort, cat, sub })); } catch { /* 私密瀏覽 */ } }, [filter, sort, cat, sub]);

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

  const open = (id: string) => {
    try { sessionStorage.setItem(SETUP_LIST_KEY, JSON.stringify(list.map((g) => g.id))); } catch { /* 私密瀏覽 */ }
    navigate(`/dressing/setup/${id}`);
  };

  return (
    <div data-testid="garment-setup" className="pb-6">
      <div className="flex items-center gap-2 pb-2 pt-5">
        <button type="button" aria-label="返回穿搭工作室" onClick={() => navigate("/outfits")} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconChevronLeft /></button>
        <h1 className="flex-1 font-serif text-[21px] font-bold tracking-[0.12em] text-gold-soft">衣服設定</h1>
        <button type="button" aria-label="搜尋衣物" aria-pressed={search} onClick={() => { setSearch(!search); setQ(""); }} className={`grid h-9 w-9 place-items-center rounded-full text-[16px] ${search ? "chip-on" : "chip"}`}><IconSearch /></button>
        <button type="button" aria-label={`排序：${SORT_LABEL[sort]}`} data-testid="setup-sort" onClick={() => setSort(sort === "todo" ? "recent" : sort === "recent" ? "name" : "todo")} className="chip flex h-9 items-center gap-1 rounded-full px-3 text-[12px]"><IconSort className="text-[15px]" />{SORT_LABEL[sort]}</button>
      </div>
      <p className="pb-2 text-[11.5px] leading-snug text-mauve">每件衣服校正一次（位置、網格、遮罩、骨架及基準姿勢），之後任何新造型穿上時都會自動使用。這裡不會建立穿搭造型。</p>
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
        <ul className="mt-1 space-y-2" data-testid="setup-list">
          {list.map((g) => {
            const i = infos.get(g.id)!;
            return (
              <li key={g.id}>
                <button type="button" data-setup-garment={g.id} data-overall={i.overall} onClick={() => open(g.id)} className="frame flex w-full items-center gap-3 px-2.5 py-2 text-left">
                  <span className="relative h-16 w-12 shrink-0 overflow-hidden rounded-xl bg-white/85"><TransparentImage src={imageUrl(g.transparent_image_id)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-0.5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5"><span className="truncate text-[13.5px] font-medium">{displayName(g)}</span><span className={`shrink-0 rounded-full px-1.5 text-[10px] leading-[17px] ${OVERALL_TONE[i.overall]}`}>{OVERALL_LABEL[i.overall]}</span></span>
                    <span className="block truncate text-[10.5px] text-mauve">{[g.category, g.subcategory].filter(Boolean).join("・")}{i.updated_at ? `｜${ago(i.updated_at)}設定` : ""}</span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {SETUP_KEYS.map((k) => <span key={k} data-item={k} data-state={i.items[k]} className={`rounded-full px-1.5 text-[10px] leading-[17px] ${STATE_TONE[i.items[k]]}`}>{SETUP_LABEL[k]}：{i.items[k] === "optional" ? "未設定" : ITEM_LABEL[i.items[k]]}</span>)}
                      {i.pieces && <span className={`rounded-full px-1.5 text-[10px] leading-[17px] ${i.pieces.set < i.pieces.total ? STATE_TONE.todo : STATE_TONE.done}`}>拆件：{i.pieces.total} 個部件{i.pieces.set < i.pieces.total ? `（${i.pieces.total - i.pieces.set} 個未校正）` : ""}</span>}
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
