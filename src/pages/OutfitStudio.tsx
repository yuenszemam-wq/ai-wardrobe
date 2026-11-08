import { useEffect, useMemo, useState } from "react";
import { CATEGORIES } from "../../shared/taxonomy";
import { api, Garment, imageUrl } from "../api";
import { Button, Chips, Field, GarmentTile, inputCls, Link, Spinner, toast } from "../components/ui";
import { navigate } from "../router";

interface Picked {
  garment_id: string;
  name: string;
  category: string | null;
  image_id: string | null;
}

// 依類別把單品放在人台的大約位置（只作預覽）
const SLOT: Record<string, { top: number; height: number; left: number; width: number }> = {
  頭飾: { top: 0, height: 16, left: 30, width: 40 },
  外套: { top: 12, height: 46, left: 14, width: 72 },
  上衣: { top: 14, height: 34, left: 20, width: 60 },
  連身裙: { top: 16, height: 60, left: 12, width: 76 },
  完整穿搭: { top: 4, height: 92, left: 8, width: 84 },
  半身裙: { top: 38, height: 38, left: 12, width: 76 },
  褲: { top: 40, height: 44, left: 22, width: 56 },
  襪: { top: 70, height: 22, left: 30, width: 40 },
  鞋: { top: 86, height: 14, left: 28, width: 44 },
  手袋: { top: 46, height: 22, left: 66, width: 32 },
  配件: { top: 30, height: 18, left: 2, width: 26 },
};
const DEFAULT_SLOT = { top: 20, height: 50, left: 20, width: 60 };

export default function OutfitStudio({ id }: { id?: string }) {
  const [garments, setGarments] = useState<Garment[] | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [status, setStatus] = useState("active");
  const [outfitImage, setOutfitImage] = useState<string | null>(null);
  const [cat, setCat] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!id);

  useEffect(() => {
    api<{ garments: Garment[] }>("/api/garments?limit=200&status=active").then((r) => setGarments(r.garments));
    if (id) {
      api<{
        name: string; notes: string | null; is_favorite: boolean; status: string;
        items: { garment_id: string; name: string; category: string | null; image_id: string | null; thumb_image_id: string | null }[];
        images: { id: string }[];
      }>(`/api/outfits/${id}`).then((o) => {
        setName(o.name);
        setNotes(o.notes || "");
        setFavorite(o.is_favorite);
        setStatus(o.status);
        setOutfitImage(o.images[0]?.id ?? null);
        setPicked(o.items.map((i) => ({ garment_id: i.garment_id, name: i.name, category: i.category, image_id: i.image_id || i.thumb_image_id })));
        setLoaded(true);
      });
    }
  }, [id]);

  const visible = useMemo(() => (garments || []).filter((g) => !cat || g.category === cat), [garments, cat]);

  function toggle(g: Garment) {
    setPicked((cur) =>
      cur.some((p) => p.garment_id === g.id)
        ? cur.filter((p) => p.garment_id !== g.id)
        : [...cur, { garment_id: g.id, name: g.name, category: g.category, image_id: g.primary_image_id || g.thumb_image_id }],
    );
  }
  function move(idx: number, dir: -1 | 1) {
    setPicked((cur) => {
      const next = [...cur];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return cur;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  async function save() {
    if (!picked.length && !id) return toast("請先揀選單品", "err");
    setSaving(true);
    const body = {
      name: name.trim() || "新穿搭",
      notes,
      is_favorite: favorite,
      items: picked.map((p, i) => ({ garment_id: p.garment_id, position: i, layer_order: i })),
      ...(id ? { status: picked.length ? "active" : status } : {}),
    };
    try {
      const res = await api<{ id: string }>(id ? `/api/outfits/${id}` : "/api/outfits", { method: id ? "PATCH" : "POST", json: body });
      toast("已儲存穿搭");
      if (!id) navigate(`/outfits/${res.id}`, true);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <Spinner />;

  return (
    <div>
      <div className="pt-4">
        <Link to="/outfits" className="text-[14px] text-amethyst-deep">‹ 穿搭</Link>
      </div>
      <div className="mt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-8">
        <div>
          <div className="arch relative mx-auto aspect-[3/4] max-w-sm overflow-hidden">
            {picked.length === 0 && outfitImage ? (
              <img src={imageUrl(outfitImage)} alt="" className="absolute inset-0 h-full w-full object-cover" />
            ) : picked.length === 0 ? (
              <div className="absolute inset-0 grid place-items-center px-8 text-center text-sm text-mauve">在下面揀選單品，這裡會即時組合預覽</div>
            ) : (
              picked.map((p, i) => {
                const s = (p.category && SLOT[p.category]) || DEFAULT_SLOT;
                return p.image_id ? (
                  <img
                    key={p.garment_id}
                    src={imageUrl(p.image_id)}
                    alt={p.name}
                    className="absolute object-contain"
                    style={{ top: `${s.top + 4}%`, height: `${s.height}%`, left: `${s.left}%`, width: `${s.width}%`, zIndex: i + 1 }}
                  />
                ) : null;
              })
            )}
          </div>
          {status === "review" && (
            <p className="mt-3 rounded-2xl bg-rose-soft p-3 text-[13px]">這是由 AI 匯入的真人穿搭照，請揀選對應的單品後儲存，即會轉為正式穿搭。</p>
          )}

          <div className="mt-4 space-y-3">
            <Field label="穿搭名稱">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：週末茶會" />
            </Field>
            <Field label="備註">
              <input className={inputCls} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} className="h-5 w-5 accent-amethyst" />
              收藏這套穿搭
            </label>
          </div>

          {picked.length > 0 && (
            <ol className="mt-4 space-y-1.5">
              {picked.map((p, i) => (
                <li key={p.garment_id} className="flex items-center gap-2 rounded-2xl bg-white px-3 py-2 text-[14px] ring-1 ring-ink/5">
                  <span className="w-5 text-[12px] text-mauve">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <button type="button" aria-label="移到下層" onClick={() => move(i, -1)} className="px-2 text-mauve">↓</button>
                  <button type="button" aria-label="移到上層" onClick={() => move(i, 1)} className="px-2 text-mauve">↑</button>
                  <button type="button" aria-label="移除" onClick={() => setPicked((c) => c.filter((x) => x.garment_id !== p.garment_id))} className="px-2 text-wine">×</button>
                </li>
              ))}
              <li className="px-1 text-[12px] text-mauve">數字越大越在上層</li>
            </ol>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={save} disabled={saving}>{saving ? "儲存中…" : "儲存穿搭"}</Button>
            {id && (
              <Button
                variant="danger"
                onClick={async () => {
                  if (!confirm("確定刪除這套穿搭？單品不會被刪除。")) return;
                  await api(`/api/outfits/${id}`, { method: "DELETE" });
                  toast("已刪除");
                  navigate("/outfits", true);
                }}
              >
                刪除
              </Button>
            )}
          </div>
        </div>

        <div className="mt-8 lg:mt-0">
          <h2 className="mb-2 font-serif text-lg font-bold">揀選單品</h2>
          <Chips options={CATEGORIES} value={cat as never} onChange={(v) => setCat(v)} />
          {!garments ? (
            <Spinner />
          ) : (
            <div className="mt-3 grid grid-cols-3 gap-x-2.5 gap-y-4 sm:grid-cols-4">
              {visible.map((g) => (
                <GarmentTile key={g.id} g={g} size="sm" selected={picked.some((p) => p.garment_id === g.id)} onSelect={() => toggle(g)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
