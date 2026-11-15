import { TransparentImage } from "../components/TransparentImage";
import { useEffect, useMemo, useRef, useState } from "react";
import { readListState, useListPosition, writeListState } from "../hooks/useListPosition";
import { api, imageUrl } from "../api";
import { IconCrown, IconHeart, IconImage, IconPerson, IconPlus, IconScissors, IconSearch, IconShirt, IconSort, IconSparkle } from "../components/icons";
import { navigate, usePath } from "../router";
import { Empty, Link, Spinner, toast } from "../components/ui";
import { StudioDraft, dropStudioDraft, listStudioDrafts, onDraftsChange } from "../studioDrafts";
import { clearDraft } from "../doll/drafts";

/** 全部造型（按 next_cursor 逐頁讀取；以前只讀取最多 200 套） */
export async function loadAllOutfits(): Promise<OutfitSummary[]> {
  const out: OutfitSummary[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 25; i++) {
    const r: { outfits: OutfitSummary[]; next_cursor?: string | null } = await api(`/api/outfits${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...r.outfits);
    if (!r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return out;
}

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
  /** Phase 3.9A.2：完整合成縮圖（保存造型時產生，與畫布一致） */
  thumb_url?: string | null;
  layer_count?: number;
}
export interface LookSummary { id: string; name: string; is_favorite: boolean; item_count: number; thumb_at: string | null; created_at: string; updated_at: string }
type Kind = "outfit" | "look";
type Entry = { kind: Kind; id: string; name: string; is_favorite: boolean; item_count: number; updated_at: string; created_at: string; outfit?: OutfitSummary; look?: LookSummary };
type Filter = "all" | Kind;
type Sort = "updated" | "created" | "name";
const SORT_LABEL: Record<Sort, string> = { updated: "最近更新", created: "最新建立", name: "名稱" };
const KEY = "aw:outfits:view";
/** 我的背景／我的素材庫（Phase 3.9A.2 啟用） */
const STUDIO_ASSETS_READY = true;

/** 穿搭頁三個分頁（我的穿搭／日誌日曆／素材管理）的共用切換列；日誌日曆即 /diary */
export type OutfitsTab = "mine" | "diary" | "assets";
export function OutfitsTabs({ tab }: { tab: OutfitsTab }) {
  const tabs: [OutfitsTab, string, string][] = [["mine", "我的穿搭", "/outfits"], ["diary", "日誌日曆", "/diary"], ["assets", "素材管理", "/outfits?tab=assets"]];
  return (
    <div className="seg mb-3" role="tablist" data-testid="outfits-tabs">
      {tabs.map(([k, label, to]) => (
        <button key={k} type="button" role="tab" data-outfits-tab={k} aria-selected={tab === k} onClick={() => { if (tab !== k) navigate(to, k !== "diary" && tab !== "diary", true); }}>{label}</button>
      ))}
    </div>
  );
}

/**
 * Phase 3.9A.1.1：穿搭頁重整為三個分頁。
 * - 我的穿搭：衣服配搭／角色換裝兩個大小一致的入口，以及全部已保存造型（類型、搜尋、收藏、排序）。
 * - 日誌日曆：/diary（照片月曆、緊湊月曆、週視圖、月份列表）。
 * - 素材管理：緊湊設定列表（衣服設定、角色素材、我的背景、我的素材庫）。
 */
export default function Outfits() {
  const path = usePath();
  const tab: OutfitsTab = new URLSearchParams(path.split("?")[1] || "").get("tab") === "assets" ? "assets" : "mine";
  return (
    <div data-testid="outfits-home" data-tab={tab}>
      <h1 className="pb-2 pt-4 font-serif text-[22px] font-bold tracking-[0.12em] text-gold-soft">穿搭</h1>
      <OutfitsTabs tab={tab} />
      {tab === "assets" ? <AssetsTab /> : <MineTab />}
    </div>
  );
}

function AssetsTab() {
  return (
    <div className="card-flat divide-y divide-[color-mix(in_srgb,var(--aw-line)_25%,transparent)] overflow-hidden" data-testid="studio-tools">
      <ToolRow to="/dressing/setup" testid="entry-setup" Icon={IconScissors} title="衣服設定" text="每件衣物的位置、網格、遮罩及骨架" />
      <ToolRow to="/dressing/assets" testid="entry-assets" Icon={IconCrown} title="角色素材" text="身體、頭部、髮型、姿勢" />
      <ToolRow to="/studio/assets?kind=background" testid="entry-backgrounds" Icon={IconImage} title="我的背景" text="衣服配搭及角色換裝共用" soon={!STUDIO_ASSETS_READY} />
      <ToolRow to="/studio/assets" testid="entry-library" Icon={IconSparkle} title="我的素材庫" text="裝飾、道具、配件及其他圖片" soon={!STUDIO_ASSETS_READY} />
    </div>
  );
}

function MineTab() {
  const [outfits, setOutfits] = useState<OutfitSummary[] | null>(null);
  const [looks, setLooks] = useState<LookSummary[] | null>(null);
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(KEY) || "{}") as { filter?: Filter; sort?: Sort }; } catch { return {}; } }, []);
  const [filter, setFilter] = useState<Filter>(saved.filter ?? "all");
  const [sort, setSort] = useState<Sort>(saved.sort ?? "updated");
  // 收藏篩選及搜尋：同一工作階段返回時保留（Phase 3.8A.1）
  const session = useMemo(() => readListState("outfits", { fav: false, q: "" }), []);
  const [fav, setFav] = useState(session.fav);
  const [q, setQ] = useState(session.q);
  const [search, setSearch] = useState(!!session.q);
  const [sortOpen, setSortOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => { writeListState("outfits", { fav, q }); }, [fav, q]);
  useEffect(() => {
    loadAllOutfits().then(setOutfits).catch((e) => { setOutfits([]); toast((e as Error).message, "err"); });
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
    return out.sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name, "zh-Hant") || a.id.localeCompare(b.id) : (sort === "created" ? b.created_at : b.updated_at).localeCompare(sort === "created" ? a.created_at : a.updated_at) || a.id.localeCompare(b.id)));
  }, [all, filter, fav, q, sort]);
  useListPosition("outfits", useMemo(() => (outfits && looks ? list.map((e) => e.kind + ":" + e.id) : null), [outfits, looks, list]), gridRef);
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
    <>
      {/* 主要功能：兩個大小一致、較緊湊的入口 */}
      <div className="grid grid-cols-2 gap-2.5" data-testid="studio-main">
        <EntryCard to="/outfits/new" testid="entry-outfit" Icon={IconShirt} title="衣服配搭" text="自由組合單品" />
        <EntryCard to="/dressing" testid="entry-look" Icon={IconPerson} title="角色換裝" text="建立人物造型" hot />
      </div>
      <DraftStrip />

      <div className="mt-4 flex items-center justify-between">
        <h2 className="font-serif text-[18px] font-bold tracking-[0.1em] text-gold-soft">已保存造型</h2>
        <div className="flex items-center gap-1.5">
          <button type="button" aria-label="搜尋造型" aria-pressed={search} onClick={() => { setSearch(!search); setQ(""); }} className={`icon-btn ${search ? "icon-btn-on" : ""}`}><IconSearch /></button>
          <button type="button" aria-label="只看收藏" aria-pressed={fav} data-testid="filter-fav" onClick={() => setFav(!fav)} className={`icon-btn ${fav ? "icon-btn-on" : ""}`}><IconHeart filled={fav} /></button>
          <div className="relative">
            <button type="button" aria-label={`排序：${SORT_LABEL[sort]}`} aria-expanded={sortOpen} data-testid="sort" onClick={() => setSortOpen(!sortOpen)} className={`icon-btn ${sortOpen ? "icon-btn-on" : ""}`}><IconSort /></button>
            {sortOpen && <>
              <div className="fixed inset-0 z-30" aria-hidden onClick={() => setSortOpen(false)} />
              <div role="menu" className="pop absolute right-0 top-10 z-40 w-36 overflow-hidden rounded-2xl text-[13px]">
                {(Object.keys(SORT_LABEL) as Sort[]).map((k) => <button key={k} type="button" role="menuitemradio" aria-checked={sort === k} data-outfit-sort={k} onClick={() => { setSort(k); setSortOpen(false); }} className={`block w-full px-4 py-2.5 text-left ${sort === k ? "text-gold-soft" : ""}`}>{SORT_LABEL[k]}{sort === k ? " ✓" : ""}</button>)}
              </div>
            </>}
          </div>
        </div>
      </div>
      {search && <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋造型名稱" aria-label="搜尋造型名稱" className="field mt-2 h-10 w-full rounded-full px-4 text-[16px]" />}
      <div className="seg mt-2.5" role="tablist" data-testid="kind-filter">
        {([["all", "全部"], ["outfit", "衣服配搭"], ["look", "角色換裝"]] as [Filter, string][]).map(([k, label]) => (
          <button key={k} type="button" role="tab" data-filter={k} aria-selected={filter === k} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[12px] text-mauve">
        <span data-testid="count">共 {list.length} 套造型{list.length !== count(filter) ? `（全部 ${count(filter)}）` : ""}</span>
        <span>{SORT_LABEL[sort]}</span>
      </div>

      {!outfits || !looks ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty title={all.length ? "沒有符合的造型" : "仍未有造型"}>{all.length ? "試試其他篩選條件。" : "從上面兩個入口開始：配搭衣櫃單品，或替角色換裝。"}</Empty>
      ) : (
        <div ref={gridRef} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {list.map((e) => (
            <div key={e.kind + e.id} className="paper relative overflow-hidden p-0" data-card={e.kind} data-id={e.id} data-pos-id={e.kind + ":" + e.id}>
              <Link to={e.kind === "outfit" ? `/outfits/${e.id}` : `/dressing/${e.id}`} className="block">
                {e.outfit ? <OutfitPreview o={e.outfit} /> : <LookPreview l={e.look!} />}
                <div className="px-2.5 pb-2 pt-1.5">
                  <div className="truncate pr-7 font-serif text-[15px] font-bold text-ink">{e.name}</div>
                  <div className="flex items-center gap-1 text-[11.5px] text-mauve">{e.kind === "outfit" ? <IconShirt className="text-[12px]" /> : <IconPerson className="text-[12px]" />}<span>{e.kind === "outfit" ? "衣服配搭" : "角色換裝"}</span><span aria-hidden>·</span><span>{e.item_count} 件</span></div>
                </div>
              </Link>
              <button type="button" aria-label={e.is_favorite ? "取消收藏" : "收藏"} aria-pressed={e.is_favorite} data-testid="card-fav" onClick={() => void toggleFav(e)} className={`absolute bottom-2.5 right-1.5 grid h-8 w-8 place-items-center rounded-full text-[17px] ${e.is_favorite ? "text-[var(--aw-chart)]" : "text-mauve"}`}><IconHeart filled={e.is_favorite} /></button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Phase 3.9A.3：未保存的創作草稿（這部手機，按帳戶分開）；可繼續編輯或捨棄 */
function DraftStrip() {
  const [drafts, setDrafts] = useState<StudioDraft[]>([]);
  useEffect(() => { const load = () => void listStudioDrafts().then(setDrafts).catch(() => setDrafts([])); load(); const off = onDraftsChange(load); return () => { off(); }; }, []);
  if (!drafts.length) return null;
  const open = (d: StudioDraft) => navigate(d.kind === "outfit" ? `${d.target ? `/outfits/${d.target}` : "/outfits/new"}?draft=${encodeURIComponent(d.id)}` : `${d.target ? `/dressing/${d.target}` : "/dressing"}?draft=${encodeURIComponent(d.id)}`);
  return (
    <section className="mt-3" data-testid="draft-strip">
      <h2 className="mb-1.5 font-serif text-[14px] font-bold text-gold-soft">未保存的草稿（{drafts.length}）</h2>
      <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {drafts.map((d) => (
          <div key={d.id} className="chip flex shrink-0 items-center gap-1 rounded-2xl py-1 pl-3 pr-1 text-[12px]" data-draft-id={d.id}>
            <button type="button" className="text-left" onClick={() => open(d)}>
              <span className="block max-w-[9rem] truncate font-bold">{d.title || "未命名"}</span>
              <span className="block text-[10.5px] opacity-75">{d.kind === "outfit" ? "衣服配搭" : "角色換裝"}・{d.target ? "修改中" : "新造型"}・{new Date(d.at).toLocaleString("zh-HK", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            </button>
            <button type="button" aria-label={`捨棄草稿 ${d.title}`} className="grid h-7 w-7 place-items-center" data-draft-drop onClick={() => { if (!confirm("捨棄這份草稿？已保存的造型不受影響。")) return; const rk = (d.data as { recoveryKey?: string } | null)?.recoveryKey; if (rk) void clearDraft(rk).catch(() => undefined); void dropStudioDraft(d.id); }}>✕</button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 主要功能入口：兩張大小一致的卡片 */
function EntryCard({ to, Icon, title, text, hot, testid }: { to: string; Icon: typeof IconShirt; title: string; text: string; hot?: boolean; testid: string }) {
  return (
    <Link to={to} className={`frame ${hot ? "frame-hot" : ""} relative block h-[5.25rem] px-3 py-2.5`}>
      <span data-testid={testid} className="flex h-full flex-col justify-between">
        <span className="flex items-start justify-between"><Icon className="text-[20px] text-gold-soft" /><IconPlus className="text-[13px] text-gold-soft" /></span>
        <span>
          <span className="block font-serif text-[16px] font-bold tracking-[0.06em]">{title}</span>
          <span className="block truncate text-[11px] leading-snug text-mauve">{text}</span>
        </span>
      </span>
    </Link>
  );
}
/** 管理工具：緊湊設定列表的一行 */
function ToolRow({ to, Icon, title, text, testid, soon }: { to: string; Icon: typeof IconShirt; title: string; text: string; testid: string; soon?: boolean }) {
  if (soon) return (
    <div className="flex min-h-[3.25rem] items-center gap-3 px-3.5 py-2 opacity-60" aria-disabled>
      <Icon className="shrink-0 text-[18px] text-gold-soft" />
      <span data-testid={testid} className="min-w-0 flex-1"><span className="block text-[14px]">{title}</span><span className="block truncate text-[11.5px] text-mauve">{text}</span></span>
      <span className="text-[11px] text-mauve">即將推出</span>
    </div>
  );
  return (
    <Link to={to} className="flex min-h-[3.25rem] items-center gap-3 px-3.5 py-2">
      <Icon className="shrink-0 text-[18px] text-gold-soft" />
      <span data-testid={testid} className="min-w-0 flex-1"><span className="block text-[14px]">{title}</span><span className="block truncate text-[11.5px] text-mauve">{text}</span></span>
      <span aria-hidden className="text-mauve">›</span>
    </Link>
  );
}

/** 角色換裝縮圖：保存造型時由畫布輸出的實際組裝畫面 */
export function LookPreview({ l }: { l: LookSummary }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-[3/4] overflow-hidden rounded-[14px] ring-1 ring-gold/50" style={{ background: "linear-gradient(color-mix(in srgb, var(--aw-canvas) 70%, #fff), var(--aw-canvas))" }}>
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
  if (o.thumb_url) return (
    <div className="checker relative aspect-[3/4] overflow-hidden rounded-[14px] ring-1 ring-gold/50" data-thumb="full">
      <img src={o.thumb_url} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain" />
    </div>
  );
  if (o.items.some((it) => it.x !== null))
    return (
      <div className="relative aspect-[3/4] overflow-hidden rounded-[14px] bg-field ring-1 ring-gold/50">
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
    <div className="grid aspect-[3/4] grid-cols-2 gap-1 overflow-hidden rounded-[14px] bg-field ring-1 ring-gold/50">
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
