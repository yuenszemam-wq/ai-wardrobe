import { useEffect, useState } from "react";
import { api, imageUrl, STATUS_LABEL } from "../api";
import { Empty, Link, PageTitle, Spinner } from "../components/ui";

export interface OutfitSummary {
  id: string;
  name: string;
  notes: string | null;
  style: string | null;
  status: string;
  is_favorite: boolean;
  item_count: number;
  image_id: string | null;
  items: { garment_id: string; name: string; image_id: string | null; layer_order: number; x: number | null; y: number | null; w: number | null; h: number | null }[];
}

export default function Outfits() {
  const [list, setList] = useState<OutfitSummary[] | null>(null);
  const [fav, setFav] = useState(false);
  useEffect(() => {
    setList(null);
    api<{ outfits: OutfitSummary[] }>(`/api/outfits${fav ? "?favorite=1" : ""}`).then((r) => setList(r.outfits));
  }, [fav]);

  return (
    <div>
      <PageTitle
        action={
          <Link to="/outfits/new" className="rounded-full bg-amethyst px-4 py-2 text-[14px] text-white">
            配搭新一套
          </Link>
        }
      >
        穿搭工作室
      </PageTitle>
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={fav} onChange={(e) => setFav(e.target.checked)} className="h-5 w-5 accent-amethyst" />
        只看收藏
      </label>
      {!list ? (
        <Spinner />
      ) : list.length === 0 ? (
        <Empty title="仍未有穿搭">從衣櫃揀幾件單品，組合成一套並儲存。</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {list.map((o) => (
            <Link key={o.id} to={`/outfits/${o.id}`} className="block rounded-3xl bg-rose-soft p-2">
              {!o.image_id && o.items.some((it) => it.x !== null) ? (
                // 已排版的穿搭：按儲存的位置縮小顯示
                <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-white">
                  {o.items.map((it, i) =>
                    it.image_id && it.x !== null ? (
                      <img
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
              ) : (
              <div className="grid aspect-square grid-cols-2 gap-1 overflow-hidden rounded-2xl bg-white">
                {o.image_id ? (
                  <img src={imageUrl(o.image_id)} alt="" loading="lazy" className="col-span-2 row-span-2 h-full w-full object-cover" />
                ) : (
                  o.items.slice(0, 4).map((it) => (
                    <div key={it.garment_id} className="relative">
                      {it.image_id && <img src={imageUrl(it.image_id)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-1" />}
                    </div>
                  ))
                )}
              </div>
              )}
              <div className="mt-2 flex items-center justify-between px-1">
                <span className="truncate text-[14px] font-medium">{o.name}</span>
                {o.is_favorite && <span className="text-amethyst">♥</span>}
              </div>
              <div className="px-1 text-[12px] text-mauve">
                {o.item_count} 件{o.status === "review" ? `｜${STATUS_LABEL.review}` : ""}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
