import { useEffect, useState } from "react";
import { api, imageUrl, STATUS_LABEL } from "../api";
import { IconDress, IconHeart } from "../components/icons";
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
          <Link to="/outfits/new" className="btn-jewel flex items-center gap-1.5 rounded-full px-4 py-2 text-[14px]">
            <IconDress className="text-[16px]" />
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
        <div className="grid grid-cols-2 gap-x-3 gap-y-6 pt-3 sm:grid-cols-3">
          {list.map((o) => (
            <Link key={o.id} to={`/outfits/${o.id}`} className="paper bow block p-2">
              <OutfitPreview o={o} />
              <div className="mt-2 flex items-center justify-between px-1">
                <span className="truncate font-serif text-[15px] font-bold">{o.name}</span>
                {o.is_favorite && <IconHeart filled className="shrink-0 text-[17px] text-amethyst" aria-label="已收藏" />}
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

/** 穿搭縮圖：已排版的按儲存位置縮小顯示；否則顯示成品照或頭四件單品 */
export function OutfitPreview({ o }: { o: OutfitSummary }) {
  if (!o.image_id && o.items.some((it) => it.x !== null))
    return (
      <div className="relative aspect-[3/4] overflow-hidden rounded-[14px] bg-white ring-1 ring-gold/50">
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
    );
  return (
    <div className="grid aspect-[3/4] grid-cols-2 gap-1 overflow-hidden rounded-[14px] bg-white ring-1 ring-gold/50">
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
  );
}
