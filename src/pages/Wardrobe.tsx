import { refreshImageCache } from "../imageCache";
import { GarmentDetailCard } from "../components/GarmentDetailCard";
import { AttributeChoices } from "../components/GarmentChoices";
import { usePullRefresh } from "../hooks/usePullRefresh";
import { BulkEditSheet } from "../components/BulkEditSheet";
import { BulkCutoutSheet } from "../components/BulkCutoutSheet";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, Garment, STATUS_LABEL } from "../api";
import { IconClose, IconFilter, IconGrid, IconMore, IconSearch, IconSort } from "../components/icons";
import { Button, Chips, Empty, GarmentTile, GRID_COLS, Link, Spinner, useColumns, toast } from "../components/ui";
import { navigate, usePath } from "../router";
import { optionNames, useTaxonomy } from "../taxonomy";
import { cachedList, capturePosition, loadFullList, readPosition, restorePosition, savePosition } from "../wardrobeList";
import { localGarments } from "../localWardrobe";

/** 每批顯示數量：接近底部時自動顯示下一批（不需要按「載入更多」） */
const BATCH = 48;
const SORT_LABEL: Record<string, string> = { "": "最新加入", updated: "最近修改", oldest: "最早加入", name: "名稱", price_desc: "價錢高至低", price_asc: "價錢低至高" };

export default function Wardrobe() {
  const path = usePath();
  const params = useMemo(() => new URLSearchParams(path.split("?")[1] || ""), [path]);
  const [view, setView] = useState<"grid" | "detail">(() => { try { return localStorage.getItem("aw:wardrobe-view") === "detail" ? "detail" : "grid"; } catch { return "grid"; } });
  function changeView(v: "grid" | "detail") { setView(v); try { localStorage.setItem("aw:wardrobe-view", v); } catch { /* ignore */ } }
  const [q, setQ] = useState(params.get("q") || "");
  const [searchOpen, setSearchOpen] = useState(!!params.get("q"));
  const [showFilters, setShowFilters] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const debounce = useRef<number | undefined>(undefined);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [cutoutOpen, setCutoutOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const tax = useTaxonomy();
  const [cols, setCols] = useColumns("aw:wardrobe-cols", 3);
  const listRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const category = params.get("category") || "";
  const subcategory = params.get("subcategory") || "";
  const season = params.get("season") || "";
  const style = params.get("style") || "";
  const color = params.get("color") || "";
  const status = params.get("status") || "";
  const favorite = params.get("favorite") === "1";
  const brand = params.get("brand") || "";
  const identified = params.get("identified") || "";
  const priced = params.get("priced") || "";
  const sort = params.get("sort") || "";
  /** 伺服器查詢（不含子分類）：子分類在本機篩選，選項由實際資料產生 */
  const serverQuery = useMemo(() => { const p = new URLSearchParams(params); p.delete("subcategory"); return p; }, [params]);
  const queryKey = serverQuery.toString();
  const posKey = "wardrobe?" + params.toString();
  const initial = cachedList(serverQuery);
  const [all, setAll] = useState<Garment[] | null>(initial?.items ?? null);
  const savedPos = useRef(readPosition(posKey));
  const [shown, setShown] = useState(() => Math.max(BATCH, savedPos.current?.shown ?? 0));
  const [brands, setBrands] = useState<string[]>([]);
  useEffect(() => {
    // 品牌選項：由本機衣櫃推導（不另外讀取伺服器；未有本機資料時才讀取）
    const local = localGarments();
    if (local) { setBrands([...new Set(local.map((g) => g.brand).filter((b): b is string => Boolean(b)))].sort()); return; }
    api<{ garments: Garment[] }>("/api/garments?limit=200&status=all")
      .then((r) => setBrands([...new Set(r.garments.map((g) => g.brand).filter((b): b is string => Boolean(b)))].sort()))
      .catch(() => undefined);
  }, []);

  function setParam(key: string, value: string) {
    const p = new URLSearchParams(params);
    if (value) p.set(key, value);
    else p.delete(key);
    if (key === "category") p.delete("subcategory");
    const qs = p.toString();
    savedPos.current = null;
    setShown(BATCH);
    navigate(`/wardrobe${qs ? `?${qs}` : ""}`, true, false);
    window.scrollTo({ top: 0 });
  }

  // 讀取完整清單：已有同一條件的清單時直接顯示（不清空、不顯示全頁載入），之後在背景更新
  const generation = useRef(0);
  const lastQuery = useRef<string | null>(null);
  useEffect(() => {
    const run = ++generation.current;
    const cached = cachedList(serverQuery);
    if (cached) setAll(cached.items); else setAll(null);
    // 只在篩選條件改變時清除選取（背景同步更新不會清除批量選取）
    if (lastQuery.current !== queryKey) { lastQuery.current = queryKey; setSelected(new Set()); }
    loadFullList(serverQuery, undefined, { fresh: revision > 0 && refreshingRef.current }).then((items) => {
      if (run !== generation.current) return; // 快速切換篩選：不混入舊結果
      setAll(items); setStale(false);
    }).catch(() => {
      if (run !== generation.current) return;
      // 網絡失敗：保留已有清單，不顯示成零件
      if (cached) setStale(true); else { setAll((cur) => cur ?? []); setStale(true); toast("讀取失敗，請按重新整理再試", "err"); }
    }).finally(() => { if (run === generation.current) setRefreshing(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, revision]);

  const refreshingRef = useRef(false);
  refreshingRef.current = refreshing;
  // 背景增量同步完成（有衣物新增／修改／刪除）：只按本機資料重新篩選，不重新初始化清單、不改變捲動位置
  useEffect(() => { const on = () => setRevision((v) => v + 1); window.addEventListener("aw:wardrobe-synced", on); return () => window.removeEventListener("aw:wardrobe-synced", on); }, []);
  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    await refreshImageCache();
    setRevision((v) => v + 1);
  }, [refreshing]);
  const pull = usePullRefresh(refresh, refreshing || bulkOpen || all === null);

  const subOptions = useMemo(() => {
    if (!all || !category) return [];
    const counts = new Map<string, number>();
    for (const g of all) if (g.subcategory) counts.set(g.subcategory, (counts.get(g.subcategory) ?? 0) + 1);
    const order = tax.categories.find((c) => c.name === category)?.subs.map((x) => x.name) ?? [];
    return [...counts.keys()].sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999) || a.localeCompare(b)).map((name) => ({ name, n: counts.get(name)! }));
  }, [all, category, tax]);
  const items = useMemo(() => (all ? (subcategory ? all.filter((g) => g.subcategory === subcategory) : all) : null), [all, subcategory]);
  const visible = items ? items.slice(0, shown) : null;

  // 自動分批顯示：接近底部時增加
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !items || shown >= items.length) return;
    const ob = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) setShown((n) => Math.min(items.length, n + BATCH)); }, { rootMargin: "900px 0px" });
    ob.observe(el);
    return () => ob.disconnect();
  }, [items, shown]);

  // 返回位置：清單出現後恢復一次（以衣物 id＋偏移），之後隨捲動保存
  const topInset = () => (barRef.current?.getBoundingClientRect().bottom ?? 0);
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !items || !savedPos.current) return;
    restored.current = true;
    const pos = savedPos.current;
    requestAnimationFrame(() => restorePosition(listRef.current, items, pos, topInset()));
  }, [items]);
  const save = useCallback(() => { if (items) savePosition(posKey, capturePosition(listRef.current, items, shown, topInset())); }, [items, shown, posKey]);
  useEffect(() => {
    let t = 0;
    const on = () => { clearTimeout(t); t = window.setTimeout(save, 150); };
    window.addEventListener("scroll", on, { passive: true });
    return () => { window.removeEventListener("scroll", on); clearTimeout(t); };
  }, [save]);

  const activeFilters = [style, color, season, status, brand, identified, priced, params.get("attr") || "", favorite ? "收藏" : ""].filter(Boolean).length;
  const total = items?.length ?? 0;
  const pick = (ids: string[]) => { if (ids.length > 300) { toast("每次最多選取 300 件", "err"); ids = ids.slice(0, 300); } setSelected(new Set(ids)); };
  const toggle = (id: string) => setSelected((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return (
    <div ref={pull.ref}>
      <div role="status" className="overflow-hidden text-center text-[12px] text-gold-soft" style={{ height: pull.distance }}>
        {pull.distance > 0 && <span className="inline-block pt-3">{pull.distance >= 60 ? "放開即可刷新" : "向下拉以刷新"}</span>}
      </div>
      {/* 標題列（不固定）：我的衣櫃＋搜尋＋篩選＋更多 */}
      <div className="flex min-h-11 items-center gap-1.5 pb-1 pt-3">
        {searchOpen ? (
          <div className="relative min-w-0 flex-1">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-[15px] text-[var(--aw-placeholder)]" />
            <input type="search" autoFocus className="field h-9 w-full rounded-full pl-9 pr-3" placeholder="搜尋名稱、品牌、圖案…" aria-label="搜尋衣物" value={q}
              onChange={(e) => { const v = e.target.value; setQ(v); clearTimeout(debounce.current); debounce.current = window.setTimeout(() => setParam("q", v.trim()), 350); }} />
          </div>
        ) : <h1 className="min-w-0 flex-1 truncate font-serif text-[21px] font-bold tracking-[0.08em] text-gold-soft">我的衣櫃</h1>}
        <button type="button" aria-label={searchOpen ? "關閉搜尋" : "搜尋"} aria-pressed={searchOpen} data-testid="wardrobe-search" onClick={() => { if (searchOpen && q) { setQ(""); setParam("q", ""); } setSearchOpen(!searchOpen); }} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[15px]">{searchOpen ? <IconClose /> : <IconSearch />}</button>
        <button type="button" aria-label="篩選" aria-expanded={showFilters} data-testid="wardrobe-filter" onClick={() => setShowFilters((v) => !v)} className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-full text-[15px] ${activeFilters || showFilters ? "chip-on" : "chip"}`}>
          <IconFilter />{activeFilters > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-wine px-1 text-[9.5px] text-white">{activeFilters}</span>}
        </button>
        <div className="relative">
          <button type="button" aria-label="更多" aria-expanded={moreOpen} data-testid="wardrobe-more" onClick={() => setMoreOpen(!moreOpen)} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconMore /></button>
          {moreOpen && (
            <div role="menu" className="pop absolute right-0 top-11 z-40 w-44 overflow-hidden rounded-2xl text-[13px]" onClick={() => setMoreOpen(false)}>
              <button type="button" role="menuitem" data-testid="wardrobe-select" className="block w-full px-4 py-2.5 text-left" onClick={() => { setSelecting((v) => !v); setSelected(new Set()); }}>{selecting ? "結束多選" : "批量修改"}</button>
              <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left disabled:opacity-50" disabled={refreshing} onClick={refresh}>{refreshing ? "刷新中…" : "重新整理"}</button>
              <Link to="/taxonomy" className="block px-4 py-2.5">管理分類</Link>
            </div>
          )}
        </div>
      </div>

      {/* 緊湊固定工具列：主分類＋（子分類、顯示方式、排序、數量），約 86px */}
      <div ref={barRef} data-testid="wardrobe-toolbar" className="lace-b sticky z-20 -mx-4 bg-head/95 px-4 pb-1.5 pt-1.5 backdrop-blur" style={{ top: "calc(env(safe-area-inset-top) + 2.5rem)" }}>
        <div className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4" data-testid="wardrobe-cats">
          {["", ...tax.categories.map((c) => c.name)].map((c) => (
            <button key={c || "__all"} type="button" data-cat={c || "all"} aria-pressed={category === c} onClick={() => setParam("category", c)} className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] ${category === c ? "chip-on" : "chip"}`}>{c || "全部"}</button>
          ))}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          {category ? (
            <select aria-label="子分類" data-testid="wardrobe-sub" value={subcategory} onChange={(e) => setParam("subcategory", e.target.value)} className="chip h-8 min-w-0 max-w-[45%] flex-1 truncate rounded-full bg-transparent px-2.5 text-[12px] text-cream">
              <option value="">全部{category}</option>
              {subOptions.map((s) => <option key={s.name} value={s.name}>{s.name}（{s.n}）</option>)}
            </select>
          ) : <span className="min-w-0 flex-1" />}
          <span className="ml-auto shrink-0 text-[12px] tabular-nums text-mauve" data-testid="wardrobe-count">{items ? `${category ? subcategory || category : "全部"} ${total} 件` : ""}{stale ? "（本機）" : ""}</span>
          <button type="button" aria-label={view === "grid" ? "改為詳細模式" : "改為圖片模式"} data-testid="wardrobe-view" onClick={() => changeView(view === "grid" ? "detail" : "grid")} className="chip grid h-8 w-8 shrink-0 place-items-center rounded-full text-[14px]">{view === "grid" ? <IconGrid /> : <IconSort />}</button>
          <div className="relative">
            <button type="button" aria-label="顯示設定：每排數量及排序" aria-expanded={displayOpen} data-testid="wardrobe-display" onClick={() => setDisplayOpen(!displayOpen)} className={`flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] ${displayOpen ? "chip-on" : "chip"}`}><IconSort className="text-[13px]" />{SORT_LABEL[sort] ?? "排序"}</button>
            {displayOpen && (
              <div data-testid="wardrobe-display-pop" className="pop absolute right-0 top-10 z-40 w-60 rounded-2xl p-3 text-[12.5px]">
                <p className="mb-1 text-[11px] text-mauve">顯示方式</p>
                <div className="grid grid-cols-2 gap-1">
                  {(["grid", "detail"] as const).map((v) => <button key={v} type="button" data-display-view={v} aria-pressed={view === v} onClick={() => changeView(v)} className={`h-8 rounded-full ${view === v ? "chip-on" : "chip"}`}>{v === "grid" ? "圖片" : "詳細"}</button>)}
                </div>
                {view === "grid" && <>
                  <p className="mb-1 mt-2.5 text-[11px] text-mauve">每排</p>
                  <div className="grid grid-cols-4 gap-1">
                    {[2, 3, 4, 5].map((n) => <button key={n} type="button" data-cols={n} aria-pressed={cols === n} onClick={() => setCols(n)} className={`h-8 rounded-full ${cols === n ? "chip-on" : "chip"}`}>{n}</button>)}
                  </div>
                </>}
                <p className="mb-1 mt-2.5 text-[11px] text-mauve">排序</p>
                <div className="grid grid-cols-2 gap-1">
                  {Object.entries(SORT_LABEL).map(([k, label]) => <button key={k || "new"} type="button" data-sort={k || "new"} aria-pressed={sort === k} onClick={() => { setParam("sort", k); setDisplayOpen(false); }} className={`h-8 rounded-full text-[12px] ${sort === k ? "chip-on" : "chip"}`}>{label}</button>)}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {showFilters && (
        <div className="paper mt-3 space-y-3 p-4" data-testid="wardrobe-filters">
          <div><p className="mb-1 text-[13px] text-mauve">風格</p><Chips options={optionNames(tax, "style")} value={style} onChange={(v) => setParam("style", v)} /></div>
          <div><p className="mb-1 text-[13px] text-mauve">顏色</p><AttributeChoices id="primary_color" options={optionNames(tax, "primary_color")} value={color ? [color] : []} onChange={(v) => setParam("color", v[0] || "")} /></div>
          <div><p className="mb-1 text-[13px] text-mauve">季節</p><Chips options={optionNames(tax, "season")} value={season} onChange={(v) => setParam("season", v)} /></div>
          <div><p className="mb-1 text-[13px] text-mauve">狀態</p><Chips options={["active", "review", "archived"] as const} value={status as never} onChange={(v) => setParam("status", v)} allLabel="未封存" labels={STATUS_LABEL} /></div>
          <div><p className="mb-1 text-[13px] text-mauve">品牌</p><Chips options={["__none__", ...brands] as string[]} value={brand} onChange={(v) => setParam("brand", v)} labels={{ __none__: "未有品牌" }} /></div>
          <div><p className="mb-1 text-[13px] text-mauve">價錢</p><Chips options={["1", "0"] as const} value={priced as never} onChange={(v) => setParam("priced", v)} labels={{ "1": "已填價錢", "0": "未填價錢" }} /></div>
          <div><p className="mb-1 text-[13px] text-mauve">是否已辨認</p><Chips options={["1", "0"] as const} value={identified as never} onChange={(v) => setParam("identified", v)} labels={{ "1": "已辨認", "0": "未辨認" }} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={favorite} onChange={(e) => setParam("favorite", e.target.checked ? "1" : "")} className="h-5 w-5 accent-[var(--aw-check)]" />只看收藏</label>
          <div className="flex gap-2"><Button variant="ghost" onClick={() => setShowFilters(false)}>完成</Button><Link to="/taxonomy" className="self-center text-[13px] text-amethyst-deep underline underline-offset-4">管理分類</Link></div>
        </div>
      )}

      {selecting && items && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="wardrobe-select-bar">
          <Button variant="ghost" onClick={() => pick((visible ?? []).map((g) => g.id))}>選取已顯示（{visible?.length ?? 0}）</Button>
          <Button variant="ghost" onClick={() => pick(items.map((g) => g.id))}>選取全部符合（{total}）</Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>取消全選</Button>
          <Button disabled={!selected.size} onClick={() => setBulkOpen(true)}>修改 {selected.size} 件</Button>
          <Button variant="ghost" disabled={!selected.size} data-testid="bulk-cutout-open" onClick={() => setCutoutOpen(true)}>去背 {selected.size} 件</Button>
        </div>
      )}

      <div className="mt-3" ref={listRef}>
        {!items ? <Spinner /> : items.length === 0 ? (
          <Empty title="沒有符合的衣物">試試清除篩選，或到「匯入」新增衣物。</Empty>
        ) : (
          <>
            <div className={view === "detail" ? "space-y-2" : `grid ${GRID_COLS[cols]}`} data-testid="wardrobe-list" data-shown={visible!.length} data-total={total}>
              {visible!.map((g) => (
                <div key={g.id} data-gid={g.id} onClickCapture={save}>
                  {view === "detail"
                    ? <GarmentDetailCard g={g} tax={tax} selected={selecting ? selected.has(g.id) : undefined} onSelect={selecting ? () => toggle(g.id) : undefined} />
                    : <GarmentTile g={g} selected={selecting ? selected.has(g.id) : undefined} onSelect={selecting ? () => toggle(g.id) : undefined} size={cols >= 4 ? "sm" : "md"} showPrice={sort.startsWith("price")} />}
                </div>
              ))}
            </div>
            {visible!.length < total && <div ref={sentinel} data-testid="wardrobe-more-sentinel" className="py-6 text-center text-[12px] text-mauve">繼續向下滑動顯示更多…</div>}
          </>
        )}
      </div>
      {cutoutOpen && <BulkCutoutSheet garments={(items || []).filter((g) => selected.has(g.id))} onClose={(changed) => { setCutoutOpen(false); if (changed) setRevision((v) => v + 1); }} />}
      {bulkOpen && <BulkEditSheet garments={(items || []).filter((g) => selected.has(g.id))} onClose={() => { setBulkOpen(false); setRevision((v) => v + 1); }} onUpdated={(ids) => {
        setSelected((cur) => new Set([...cur].filter((id) => !ids.includes(id))));
        if (ids.length) toast(`已更新 ${ids.length} 件衣物`);
      }} />}
    </div>
  );
}
