import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, COLORS, STYLES } from "../../shared/taxonomy";
import { api, Garment, STATUS_LABEL } from "../api";
import { Button, Chips, Empty, GarmentTile, PageTitle, Spinner, inputCls } from "../components/ui";
import { navigate, usePath } from "../router";

export default function Wardrobe() {
  const path = usePath();
  const params = useMemo(() => new URLSearchParams(path.split("?")[1] || ""), [path]);
  const [q, setQ] = useState(params.get("q") || "");
  const [items, setItems] = useState<Garment[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const debounce = useRef<number>();

  const category = params.get("category") || "";
  const style = params.get("style") || "";
  const color = params.get("color") || "";
  const status = params.get("status") || "";
  const favorite = params.get("favorite") === "1";
  const brand = params.get("brand") || "";
  const identified = params.get("identified") || "";
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

  const activeFilters = [style, color, status, brand, identified, favorite ? "收藏" : ""].filter(Boolean).length;

  return (
    <div>
      <PageTitle
        action={
          <button type="button" onClick={() => setShowFilters((v) => !v)} className="rounded-full bg-white px-3 py-1.5 text-[13px] ring-1 ring-ink/10">
            篩選{activeFilters ? `（${activeFilters}）` : ""}
          </button>
        }
      >
        我的衣櫃
      </PageTitle>

      <input
        type="search"
        className={inputCls}
        placeholder="搜尋名稱、品牌、圖案…"
        value={q}
        onChange={(e) => {
          const v = e.target.value;
          setQ(v);
          clearTimeout(debounce.current);
          debounce.current = window.setTimeout(() => setParam("q", v.trim()), 350);
        }}
      />

      <div className="mt-3">
        <Chips options={CATEGORIES} value={category as never} onChange={(v) => setParam("category", v)} />
      </div>

      {showFilters && (
        <div className="mt-3 space-y-3 rounded-3xl bg-rose-soft p-4">
          <div>
            <p className="mb-1 text-[13px] text-mauve">風格</p>
            <Chips options={STYLES} value={style as never} onChange={(v) => setParam("style", v)} />
          </div>
          <div>
            <p className="mb-1 text-[13px] text-mauve">顏色</p>
            <Chips options={COLORS} value={color as never} onChange={(v) => setParam("color", v)} />
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
            <p className="mb-1 text-[13px] text-mauve">是否已辨認</p>
            <Chips options={["1", "0"] as const} value={identified as never} onChange={(v) => setParam("identified", v)} labels={{ "1": "已辨認", "0": "未辨認" }} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={favorite} onChange={(e) => setParam("favorite", e.target.checked ? "1" : "")} className="h-5 w-5 accent-amethyst" />
            只看收藏
          </label>
        </div>
      )}

      <div className="mt-5">
        {!items ? (
          <Spinner />
        ) : items.length === 0 ? (
          <Empty title="沒有符合的衣物">試試清除篩選，或到「匯入」新增衣物。</Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
              {items.map((g) => (
                <GarmentTile key={g.id} g={g} />
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
