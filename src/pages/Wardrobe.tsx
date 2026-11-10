import { useEffect, useMemo, useRef, useState } from "react";
import { api, Garment, STATUS_LABEL } from "../api";
import { IconFilter, IconSearch } from "../components/icons";
import { Button, Chips, ColumnSwitch, Empty, GarmentTile, GRID_COLS, Link, Spinner, useColumns } from "../components/ui";
import { navigate, usePath } from "../router";
import { optionNames, useTaxonomy } from "../taxonomy";

export default function Wardrobe() {
  const path = usePath();
  const params = useMemo(() => new URLSearchParams(path.split("?")[1] || ""), [path]);
  const [q, setQ] = useState(params.get("q") || "");
  const [items, setItems] = useState<Garment[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const debounce = useRef<number>();
  const tax = useTaxonomy();
  const [cols, setCols] = useColumns("aw:wardrobe-cols", 3);

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
  const [brands, setBrands] = useState<string[]>([]);
  useEffect(() => {
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
    navigate(`/wardrobe${qs ? `?${qs}` : ""}`, true);
  }

  useEffect(() => {
    let alive = true;
    setItems(null);
    const p = new URLSearchParams(params);
    p.set("limit", "60");
    api<{ garments: Garment[]; next_offset: number | null }>(`/api/garments?${p}`).then((r) => {
      if (!alive) return;
      setItems(r.garments);
      setNext(r.next_offset);
    });
    return () => {
      alive = false;
    };
  }, [params]);

  async function more() {
    if (next === null) return;
    setLoadingMore(true);
    const p = new URLSearchParams(params);
    p.set("limit", "60");
    p.set("offset", String(next));
    const r = await api<{ garments: Garment[]; next_offset: number | null }>(`/api/garments?${p}`);
    setItems((cur) => [...(cur || []), ...r.garments]);
    setNext(r.next_offset);
    setLoadingMore(false);
  }

  const activeFilters = [style, color, season, status, brand, identified, priced, params.get("attr") || "", favorite ? "收藏" : ""].filter(Boolean).length;
  const subs = tax.categories.find((c) => c.name === category)?.subs.map((x) => x.name) ?? [];

  return (
    <div>
      <h1 className="flex items-center gap-2 pb-2 pt-5 font-serif text-[22px] font-bold tracking-[0.08em] text-gold-soft">
        我的衣櫃
      </h1>

      {/* 搜尋及篩選：捲動時固定在頁首下方，只佔兩行 */}
      <div className="lace-b sticky z-20 -mx-4 bg-ink/95 px-4 pb-1.5 pt-2 backdrop-blur" style={{ top: "calc(env(safe-area-inset-top) + 3rem)" }}>
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-[15px] text-[#8a6d80]" />
            <input
              type="search"
              className="h-9 w-full rounded-full bg-white pl-9 pr-3 text-ink ring-1 ring-gold placeholder:text-[14px] placeholder:text-mauve/80 focus:outline-none focus:ring-2 focus:ring-amethyst"
              placeholder="搜尋名稱、品牌、圖案…"
              aria-label="搜尋衣物"
              value={q}
              onChange={(e) => {
                const v = e.target.value;
                setQ(v);
                clearTimeout(debounce.current);
                debounce.current = window.setTimeout(() => setParam("q", v.trim()), 350);
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setShowFilters((v) => !v);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            aria-expanded={showFilters}
            className={`flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] ${activeFilters || showFilters ? "chip-on" : "btn-dark"}`}
          >
            <IconFilter className="text-[14px]" />
            篩選{activeFilters ? ` ${activeFilters}` : ""}
          </button>
        </div>
        <div className="scrollbar-none -mx-4 mt-1.5 flex gap-1.5 overflow-x-auto px-4">
          {["", ...tax.categories.map((c) => c.name)].map((c) => (
            <button key={c || "__all"} type="button" onClick={() => setParam("category", c)} className={`shrink-0 rounded-full px-3 py-1 text-[12px] ${category === c ? "chip-on" : "chip"}`}>
              {c || "全部"}
            </button>
          ))}
        </div>
      </div>

      {subs.length > 0 && (
        <div className="mt-3">
          <Chips options={subs} value={subcategory} onChange={(v) => setParam("subcategory", v)} allLabel={`全部${category}`} />
        </div>
      )}

      {showFilters && (
        <div className="paper mt-3 space-y-3 p-4">
          <div>
            <p className="mb-1 text-[13px] text-mauve">風格</p>
            <Chips options={optionNames(tax, "style")} value={style} onChange={(v) => setParam("style", v)} />
          </div>
          <div>
            <p className="mb-1 text-[13px] text-mauve">顏色</p>
            <Chips options={optionNames(tax, "primary_color")} value={color} onChange={(v) => setParam("color", v)} />
          </div>
          <div>
            <p className="mb-1 text-[13px] text-mauve">季節</p>
            <Chips options={optionNames(tax, "season")} value={season} onChange={(v) => setParam("season", v)} />
          </div>
          <div>
            <p className="mb-1 text-[13px] text-mauve">狀態</p>
            <Chips
              options={["active", "review", "archived"] as const}
              value={status as never}
              onChange={(v) => setParam("status", v)}
              allLabel="未封存"
              labels={STATUS_LABEL}
            />
          </div>
          <div>
            <p className="mb-1 text-[13px] text-mauve">品牌</p>
            <Chips options={["__none__", ...brands] as string[]} value={brand} onChange={(v) => setParam("brand", v)} labels={{ __none__: "未有品牌" }} />
          </div>
          <div>
            <p className="mb-1 text-[13px] text-mauve">價錢</p>
            <Chips options={["1", "0"] as const} value={priced as never} onChange={(v) => setParam("priced", v)} labels={{ "1": "已填價錢", "0": "未填價錢" }} />
          </div>
          <div>
            <p className="mb-1 text-[13px] text-mauve">是否已辨認</p>
            <Chips options={["1", "0"] as const} value={identified as never} onChange={(v) => setParam("identified", v)} labels={{ "1": "已辨認", "0": "未辨認" }} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={favorite} onChange={(e) => setParam("favorite", e.target.checked ? "1" : "")} className="h-5 w-5 accent-amethyst" />
            只看收藏
          </label>
          <Link to="/taxonomy" className="inline-block text-[13px] text-amethyst-deep underline underline-offset-4">
            管理分類
          </Link>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-[13px] text-mauve">
          {items ? `${items.length}${next !== null ? "+" : ""} 件` : ""}
          <select className="chip h-7 rounded-full bg-transparent px-2 text-[12px] text-cream" value={sort} onChange={(e) => setParam("sort", e.target.value)} aria-label="排序">
            <option value="">最新加入</option>
            <option value="oldest">最早加入</option>
            <option value="name">名稱</option>
            <option value="price_desc">價錢高至低</option>
            <option value="price_asc">價錢低至高</option>
          </select>
        </span>
        <div className="flex items-center gap-2 text-[13px] text-mauve">
          <span aria-hidden>每排</span>
          <ColumnSwitch value={cols} onChange={setCols} />
        </div>
      </div>

      <div className="mt-3">
        {!items ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty title="沒有符合的衣物">試試清除篩選，或到「匯入」新增衣物。</Empty>
        ) : (
          <>
            <div className={`grid ${GRID_COLS[cols]}`}>
              {items.map((g) => (
                <GarmentTile key={g.id} g={g} size={cols >= 4 ? "sm" : "md"} showPrice={sort.startsWith("price")} />
              ))}
            </div>
            {next !== null && (
              <div className="mt-6 text-center">
                <Button variant="ghost" onClick={more} disabled={loadingMore}>
                  {loadingMore ? "載入中…" : "載入更多"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
