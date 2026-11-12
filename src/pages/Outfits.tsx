import { TransparentImage } from "../components/TransparentImage";
import { useEffect, useMemo, useState } from "react";
import { api, imageUrl } from "../api";
import { IconHeart, IconPerson, IconPlus, IconSearch, IconShirt, IconSort } from "../components/icons";
import { Empty, Link, Spinner, toast } from "../components/ui";

export interface OutfitSummary {
  id: string;
  name: string;
  notes: string | null;
  style: string | null;
  status: string;
  is_favorite: boolean;
  item_count: number;
  image_id: string | null;
  created_at?: string;
  updated_at?: string;
  items: { garment_id: string; name: string; image_id: string | null; layer_order: number; x: number | null; y: number | null; w: number | null; h: number | null }[];
}
interface LookSummary { id: string; name: string; is_favorite: boolean; item_count: number; thumb_at: string | null; created_at: string; updated_at: string }
type Kind = "outfit" | "look";
type Entry = { kind: Kind; id: string; name: string; is_favorite: boolean; item_count: number; updated_at: string; created_at: string; outfit?: OutfitSummary; look?: LookSummary };
type Filter = "all" | Kind;
type Sort = "updated" | "created" | "name";
const SORT_LABEL: Record<Sort, string> = { updated: "最近更新", created: "最新建立", name: "名稱" };
const KEY = "aw:outfits:view";

/** 穿搭工作室主頁：兩個創作入口（衣服配搭／角色換裝），以及所有已保存造型的統一列表。 */
export default function Outfits() {
  const [outfits, setOutfits] = useState<OutfitSummary[] | null>(null);
  const [looks, setLooks] = useState<LookSummary[] | null>(null);
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") as { filter?: Filter; sort?: Sort }; } catch { return {}; } }, []);
  const [filter, setFilter] = useState<Filter>(saved.filter ?? "all");
  const [sort, setSort] = useState<Sort>(saved.sort ?? "updated");
  const [fav, setFav] = useState(false);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState(false);
  useEffect(() => {
    api<{ outfits: OutfitSummary[] }>("/api/outfits").then((r) => setOutfits(r.outfits)).catch((e) => { setOutfits([]); toast((e as Error).message, "err"); });
    api<{ looks: LookSummary[] }>("/api/doll/looks").then((r) => setLooks(r.looks)).catch(() => setLooks([]));
  }, []);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ filter, sort })); } catch { /* 私密瀏覽 */ } }, [filter, sort]);

  const all = useMemo<Entry[]>(() => [
    ...(outfits ?? []).map((o): Entry => ({ kind: "outfit", id: o.id, name: o.name, is_favorite: o.is_favorite, item_count: o.item_count, updated_at: o.updated_at ?? o.created_at ?? "", created_at: o.created_at ?? "", outfit: o })),
    ...(looks ?? []).map((l): Entry => ({ kind: "look", id: l.id, name: l.name, is_favorite: l.is_favorite, item_count: l.item_count, updated_at: l.updated_at, created_at: l.created_at, look: l })),
  ], [outfits, looks]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = all.filter((e) => (filter === "all" || e.kind === filter) && (!fav || e.is_favorite) && (!needle || e.name.toLowerCase().includes(needle)));
    return out.sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name, "zh-Hant") : (sort === "created" ? b.created_at : b.updated_at).localeCompare(sort === "created" ? a.created_at : a.updated_at)));
  }, [all, filter, fav, q, sort]);
  const count = (k: Filter) => (k === "all" ? all.length : all.filter((e) => e.kind === k).length);

  async function toggleFav(e: Entry) {
    const next = !e.is_favorite;
    const apply = (v: boolean) => (e.kind === "outfit" ? setOutfits((cur) => cur?.map((o) => (o.id === e.id ? { ...o, is_favorite: v } : o)) ?? cur) : setLooks((cur) => cur?.map((l) => (l.id === e.id ? { ...l, is_favorite: v } : l)) ?? cur));
    apply(next);
    try {
      await api(e.kind === "outfit" ? `/api/outfits/${e.id}` : `/api/doll/looks/${e.id}`, { method: "PATCH", json: { is_favorite: next } });
    } catch (err) {
      apply(!next);
      toast((err as Error).message, "err");
    }
  }

  return (
    <div data-testid="outfits-home">
      <h1 className="pb-3 pt-5 font-serif text-[22px] font-bold tracking-[0.12em] text-gold-soft">穿搭工作室</h1>
      <div className="grid grid-cols-2 gap-3">
        <EntryCard to="/outfits/new" testid="entry-outfit" Icon={IconShirt} title="衣服配搭" text="自由組合衣櫃單品" />
        <EntryCard to="/dressing" testid="entry-look" Icon={IconPerson} title="角色換裝" text="為角色打造新造型" hot />
      </div>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="font-serif text-[18px] font-bold tracking-[0.1em] text-gold-soft">我的穿搭</h2>
        <div className="flex items-center gap-1.5">
          <button type="button" aria-label="搜尋造型" aria-pressed={search} onClick={() => { setSearch(!search); setQ(""); }} className={`grid h-9 w-9 place-items-center rounded-full text-[16px] ${search ? "chip-on" : "chip"}`}><IconSearch /></button>
          <button type="button" aria-label="只看收藏" aria-pressed={fav} data-testid="filter-fav" onClick={() => setFav(!fav)} className={`grid h-9 w-9 place-items-center rounded-full text-[17px] ${fav ? "chip-on" : "chip"}`}><IconHeart filled={fav} /></button>
          <button type="button" aria-label={`排序：${SORT_LABEL[sort]}`} data-testid="sort" onClick={() => setSort(sort === "updated" ? "created" : sort === "created" ? "name" : "updated")} className="chip grid h-9 w-9 place-items-center rounded-full text-[17px]"><IconSort /></button>
        </div>
      </div>
      {search && <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋造型名稱" aria-label="搜尋造型名稱" className="mt-2 h-10 w-full rounded-full bg-white px-4 text-[14px] text-ink ring-1 ring-gold focus:outline-none" />}
      <div className="mt-3 grid grid-cols-3 rounded-full bg-white/5 p-1 ring-1 ring-gold/30" role="tablist" data-testid="kind-filter">
        {([["all", "全部"], ["outfit", "衣服配搭"], ["look", "角色換裝"]] as [Filter, string][]).map(([k, label]) => (
          <button key={k} type="button" role="tab" data-filter={k} aria-selected={filter === k} onClick={() => setFilter(k)} className={`h-9 rounded-full text-[13.5px] ${filter === k ? "chip-on" : "text-cream/80"}`}>{label}</button>
        ))}
      </div>
      <div className="mt-2.5 flex items-center justify-between text-[12px] text-mauve">
        <span data-testid="count">共 {list.length} 套造型{list.length !== count(filter) ? `（全部 ${count(filter)}）` : ""}</span>
        <span>{SORT_LABEL[sort]}</span>
      </div>

      {!outfits || !looks ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty title={all.length ? "沒有符合的造型" : "仍未有造型"}>{all.length ? "試試其他篩選條件。" : "從上面兩個入口開始：配搭衣櫃單品，或替角色換裝。"}</Empty>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {list.map((e) => (
            <div key={e.kind + e.id} className="paper relative p-2" data-card={e.kind} data-id={e.id}>
              <Link to={e.kind === "outfit" ? `/outfits/${e.id}` : `/dressing/${e.id}`} className="block">
                {e.outfit ? <OutfitPreview o={e.outfit} /> : <LookPreview l={e.look!} />}
                <div className="mt-2 flex items-center px-0.5">
                  <span className="flex items-center gap-1 rounded-full bg-amethyst/15 px-2 py-0.5 text-[11px] text-ink/80">{e.kind === "outfit" ? <IconShirt className="text-[12px]" /> : <IconPerson className="text-[12px]" />}{e.kind === "outfit" ? "衣服配搭" : "角色換裝"}</span>
                </div>
                <div className="mt-1 truncate px-0.5 font-serif text-[15px] font-bold text-ink">{e.name}</div>
                <div className="px-0.5 text-[12px] text-mauve">{e.item_count} 件衣物</div>
              </Link>
              <button type="button" aria-label={e.is_favorite ? "取消收藏" : "收藏"} aria-pressed={e.is_favorite} data-testid="card-fav" onClick={() => void toggleFav(e)} className={`absolute bottom-[3.1rem] right-2 grid h-8 w-8 place-items-center rounded-full text-[18px] ${e.is_favorite ? "text-[#c9578a]" : "text-mauve"}`}><IconHeart filled={e.is_favorite} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EntryCard({ to, Icon, title, text, hot, testid }: { to: string; Icon: typeof IconShirt; title: string; text: string; hot?: boolean; testid: string }) {
  return (
    <Link to={to} className={`frame ${hot ? "frame-hot" : ""} relative block px-3.5 pb-3 pt-3.5`}>
      <span data-testid={testid} className="block">
        <span className="block text-[24px] text-gold-soft"><Icon /></span>
        <span className="mt-1.5 block font-serif text-[17px] font-bold tracking-[0.08em] text-white">{title}</span>
        <span className="mt-0.5 block text-[12px] text-cream/75">{text}</span>
        <span className="mt-2 flex justify-end text-gold-soft"><span className="grid h-6 w-6 place-items-center rounded-full border border-gold/70 text-[11px]"><IconPlus /></span></span>
      </span>
    </Link>
  );
}

/** 角色換裝縮圖：保存造型時由畫布輸出的實際組裝畫面 */
function LookPreview({ l }: { l: LookSummary }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-[3/4] overflow-hidden rounded-[14px] ring-1 ring-gold/50" style={{ background: "linear-gradient(#f7f0f6, #e6d6ea)" }}>
      {l.thumb_at && !failed ? (
        <img src={`/api/doll/looks/${l.id}/thumb?v=${encodeURIComponent(l.thumb_at)}`} alt="" loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-cover object-top" />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-center text-[11px] leading-relaxed text-mauve"><span><IconPerson className="mx-auto mb-1 text-[30px] opacity-60" />開啟並保存後<br />會產生縮圖</span></div>
      )}
    </div>
  );
}

/** 穿搭縮圖：已排版的按儲存位置縮小顯示；否則顯示成品照或頭四件單品 */
export function OutfitPreview({ o }: { o: OutfitSummary }) {
  if (o.items.some((it) => it.x !== null))
    return (
      <div className="relative aspect-[3/4] overflow-hidden rounded-[14px] bg-white ring-1 ring-gold/50">
        {o.items.map((it, i) =>
          it.image_id && it.x !== null ? (
            <TransparentImage
              key={it.garment_id}
              src={imageUrl(it.image_id)}
              alt=""
              loading="lazy"
              className="absolute object-contain"
              style={{ left: `${it.x}%`, top: `${it.y}%`, width: `${it.w}%`, height: `${it.h}%`, zIndex: i + 1 }}
            />
          ) : null,
        )}
      </div>
    );
  return (
    <div className="grid aspect-[3/4] grid-cols-2 gap-1 overflow-hidden rounded-[14px] bg-white ring-1 ring-gold/50">
      {!o.items.length && o.image_id ? (
        <TransparentImage src={imageUrl(o.image_id)} alt="" loading="lazy" className="col-span-2 row-span-2 h-full w-full object-cover" />
      ) : (
        o.items.slice(0, 4).map((it) => (
          <div key={it.garment_id} className="relative">
            {it.image_id && <TransparentImage src={imageUrl(it.image_id)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-1" />}
          </div>
        ))
      )}
    </div>
  );
}
