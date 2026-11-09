import { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, displayName, Garment, imageUrl } from "../api";
import { DragHandle, SortableList } from "../components/Sortable";
import { Button, Chips, ColumnSwitch, Field, GarmentTile, GRID_COLS, inputCls, Link, Spinner, toast, useColumns } from "../components/ui";
import { navigate } from "../router";
import { useTaxonomy } from "../taxonomy";

interface Box {
  x: number; // 左上角，佔畫布寬度 %
  y: number; // 左上角，佔畫布高度 %
  w: number;
  h: number;
}
interface Picked extends Box {
  garment_id: string;
  name: string;
  category: string | null;
  image_id: string | null;
}

// 新加入的單品按類別放在人台的大約位置；之後可自由拖拉及縮放
const SLOT: Record<string, Box> = {
  頭飾: { y: 0, h: 16, x: 30, w: 40 },
  外套: { y: 12, h: 46, x: 14, w: 72 },
  上衣: { y: 14, h: 34, x: 20, w: 60 },
  連身裙: { y: 16, h: 60, x: 12, w: 76 },
  套裝: { y: 14, h: 66, x: 12, w: 76 },
  完整穿搭: { y: 4, h: 92, x: 8, w: 84 },
  半身裙: { y: 38, h: 38, x: 12, w: 76 },
  內搭與裙撐: { y: 40, h: 36, x: 10, w: 80 },
  褲: { y: 40, h: 44, x: 22, w: 56 },
  襪: { y: 70, h: 22, x: 30, w: 40 },
  鞋: { y: 84, h: 15, x: 28, w: 44 },
  手袋: { y: 46, h: 22, x: 66, w: 32 },
  配件: { y: 30, h: 18, x: 2, w: 26 },
  其他裝飾: { y: 8, h: 30, x: 70, w: 28 },
};
const DEFAULT_SLOT: Box = { y: 20, h: 50, x: 20, w: 60 };
const slotFor = (category: string | null): Box => ({ ...((category && SLOT[category]) || DEFAULT_SLOT) });
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const MIN_SIZE = 6;
const MAX_SIZE = 220;

type Gesture =
  | { kind: "move"; id: string; sx: number; sy: number; box: Box }
  | { kind: "pinch"; id: string; d0: number; box: Box }
  | { kind: "resize"; id: string; sx: number; box: Box };

export default function OutfitStudio({ id }: { id?: string }) {
  const tax = useTaxonomy();
  const [garments, setGarments] = useState<Garment[] | null>(null);
  const [picked, setPicked] = useState<Picked[]>([]); // 次序＝圖層（0 在最底）
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [status, setStatus] = useState("active");
  const [outfitImage, setOutfitImage] = useState<string | null>(null);
  const [cat, setCat] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(!id);
  const [cols, setCols] = useColumns("aw:outfit-pick-cols", 3);

  const canvas = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;

  useEffect(() => {
    api<{ garments: Garment[] }>("/api/garments?limit=200&status=active").then((r) => setGarments(r.garments));
    if (id) {
      api<{
        name: string; notes: string | null; is_favorite: boolean; status: string;
        items: { garment_id: string; name: string; category: string | null; image_id: string | null; thumb_image_id: string | null; x: number | null; y: number | null; w: number | null; h: number | null }[];
        images: { id: string }[];
      }>(`/api/outfits/${id}`).then((o) => {
        setName(o.name);
        setNotes(o.notes || "");
        setFavorite(o.is_favorite);
        setStatus(o.status);
        setOutfitImage(o.images[0]?.id ?? null);
        setPicked(
          o.items.map((i) => {
            const d = slotFor(i.category);
            return {
              garment_id: i.garment_id, name: i.name, category: i.category, image_id: i.image_id || i.thumb_image_id,
              x: i.x ?? d.x, y: i.y ?? d.y, w: i.w ?? d.w, h: i.h ?? d.h,
            };
          }),
        );
        setLoaded(true);
      });
    }
  }, [id]);

  const visible = useMemo(() => (garments || []).filter((g) => !cat || g.category === cat), [garments, cat]);

  function update(fn: (cur: Picked[]) => Picked[]) {
    setPicked(fn);
    setDirty(true);
  }
  const patchBox = (gid: string, box: Partial<Box>) => update((cur) => cur.map((p) => (p.garment_id === gid ? { ...p, ...box } : p)));

  function toggle(g: Garment) {
    if (picked.some((p) => p.garment_id === g.id)) {
      update((cur) => cur.filter((p) => p.garment_id !== g.id));
      if (selected === g.id) setSelected(null);
    } else {
      update((cur) => [...cur, { garment_id: g.id, name: displayName(g), category: g.category, image_id: g.primary_image_id || g.thumb_image_id, ...slotFor(g.category) }]);
      setSelected(g.id);
    }
  }

  // ───── 畫布手勢：單指拖動、雙指縮放、角位把手縮放、滑鼠滾輪縮放 ─────
  function rect() {
    return canvas.current!.getBoundingClientRect();
  }
  function scaleBox(b: Box, factor: number, anchor: "center" | "topleft" = "center"): Box {
    const w = clamp(b.w * factor, MIN_SIZE, MAX_SIZE);
    const f = w / b.w;
    const h = clamp(b.h * f, MIN_SIZE, MAX_SIZE);
    if (anchor === "topleft") return { x: b.x, y: b.y, w, h };
    return { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
  }
  function boxOf(gid: string): Box {
    const p = pickedRef.current.find((x) => x.garment_id === gid)!;
    return { x: p.x, y: p.y, w: p.w, h: p.h };
  }

  function onItemDown(e: ReactPointerEvent<HTMLDivElement>, gid: string) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelected(gid);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      gesture.current = { kind: "pinch", id: gid, d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, box: boxOf(gid) };
    } else {
      gesture.current = { kind: "move", id: gid, sx: e.clientX, sy: e.clientY, box: boxOf(gid) };
    }
  }
  function onResizeDown(e: ReactPointerEvent<HTMLDivElement>, gid: string) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current = { kind: "resize", id: gid, sx: e.clientX, box: boxOf(gid) };
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const r = rect();
    if (g.kind === "move") {
      const dx = ((e.clientX - g.sx) / r.width) * 100;
      const dy = ((e.clientY - g.sy) / r.height) * 100;
      // 至少保留一小部分在畫布內，避免拖到看不見
      patchBox(g.id, { x: clamp(g.box.x + dx, -g.box.w + 8, 92), y: clamp(g.box.y + dy, -g.box.h + 8, 92) });
    } else if (g.kind === "pinch") {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      patchBox(g.id, scaleBox(g.box, d / g.d0));
    } else {
      const startW = (g.box.w / 100) * r.width;
      const newW = startW + (e.clientX - g.sx);
      patchBox(g.id, scaleBox(g.box, newW / startW, "topleft"));
    }
  }
  /** 第二隻手指落在單品旁邊（畫布上）時，同樣當作雙指縮放 */
  function onCanvasDown(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (g && pointers.current.size >= 1) {
      e.currentTarget.setPointerCapture(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointers.current.values()];
      gesture.current = { kind: "pinch", id: g.id, d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, box: boxOf(g.id) };
    } else setSelected(null);
  }
  const stop = (fn: (e: ReactPointerEvent<HTMLDivElement>) => void) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    fn(e);
  };

  function onUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    // 雙指縮放中放開一指 → 改為拖動餘下那隻手指
    const rest = [...pointers.current.values()];
    if (g.kind === "pinch" && rest.length === 1) gesture.current = { kind: "move", id: g.id, sx: rest[0].x, sy: rest[0].y, box: boxOf(g.id) };
    else if (!rest.length) gesture.current = null;
  }
  function onWheel(e: ReactWheelEvent<HTMLDivElement>, gid: string) {
    if (selected !== gid) return;
    patchBox(gid, scaleBox(boxOf(gid), e.deltaY < 0 ? 1.05 : 0.95));
  }

  // ───── 圖層 ─────
  const topFirst = [...picked].reverse().map((p) => ({ ...p, id: p.garment_id }));
  function reorderTopFirst(ids: string[]) {
    update((cur) => [...ids].reverse().map((gid) => cur.find((p) => p.garment_id === gid)!).filter(Boolean));
  }
  function bringToFront(gid: string) {
    update((cur) => [...cur.filter((p) => p.garment_id !== gid), cur.find((p) => p.garment_id === gid)!]);
  }

  async function save() {
    if (!picked.length && !id) return toast("請先揀選單品", "err");
    setSaving(true);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const body = {
      name: name.trim() || "新穿搭",
      notes,
      is_favorite: favorite,
      items: picked.map((p, i) => ({ garment_id: p.garment_id, position: i, layer_order: i, x: r2(p.x), y: r2(p.y), w: r2(p.w), h: r2(p.h) })),
      ...(id ? { status: picked.length ? "active" : status } : {}),
    };
    try {
      const res = await api<{ id: string }>(id ? `/api/outfits/${id}` : "/api/outfits", { method: id ? "PATCH" : "POST", json: body });
      toast("已儲存穿搭");
      setDirty(false);
      if (!id) navigate(`/outfits/${res.id}`, true);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return <Spinner />;
  const sel = picked.find((p) => p.garment_id === selected) ?? null;

  return (
    <div>
      <div className="flex items-center justify-between pt-4">
        <Link to="/outfits" className="text-[14px] text-amethyst-deep">‹ 穿搭</Link>
        {dirty && <span className="text-[12px] text-wine">未儲存</span>}
      </div>
      <div className="mt-3 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-8">
        <div>
          <div
            ref={canvas}
            className="arch relative mx-auto aspect-[3/4] max-w-sm overflow-hidden select-none"
            style={{ touchAction: selected ? "none" : "pan-y" }}
            onPointerDown={onCanvasDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            {picked.length === 0 && outfitImage ? (
              <img src={imageUrl(outfitImage)} alt="" className="absolute inset-0 h-full w-full object-cover" />
            ) : picked.length === 0 ? (
              <div className="absolute inset-0 grid place-items-center px-8 text-center text-sm text-mauve">在下面揀選單品，這裡會即時組合預覽</div>
            ) : (
              picked.map((p, i) => {
                const isSel = p.garment_id === selected;
                return (
                  <div
                    key={p.garment_id}
                    className={`absolute ${isSel ? "outline-2 outline-dashed outline-amethyst" : ""}`}
                    style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.w}%`, height: `${p.h}%`, zIndex: i + 1, touchAction: "none", cursor: "move" }}
                    onPointerDown={(e) => onItemDown(e, p.garment_id)}
                    onPointerMove={stop(onMove)}
                    onPointerUp={stop(onUp)}
                    onPointerCancel={stop(onUp)}
                    onWheel={(e) => onWheel(e, p.garment_id)}
                  >
                    {p.image_id ? (
                      <img src={imageUrl(p.image_id)} alt={p.name} draggable={false} className="pointer-events-none h-full w-full object-contain" />
                    ) : (
                      <div className="grid h-full w-full place-items-center rounded-xl bg-white/70 text-[11px] text-mauve">{p.name}</div>
                    )}
                    {isSel && (
                      <div
                        role="slider"
                        aria-label="拖拉縮放"
                        aria-valuenow={Math.round(p.w)}
                        className="absolute -bottom-3 -right-3 grid h-7 w-7 place-items-center rounded-full bg-amethyst text-[12px] text-white shadow"
                        style={{ touchAction: "none", cursor: "nwse-resize" }}
                        onPointerDown={(e) => onResizeDown(e, p.garment_id)}
                        onPointerMove={stop(onMove)}
                        onPointerUp={stop(onUp)}
                        onPointerCancel={stop(onUp)}
                      >
                        ⤡
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {picked.length > 0 && (
            <div className="mx-auto mt-2 max-w-sm">
              {sel ? (
                <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
                  <span className="mr-1 max-w-[9rem] truncate text-mauve">{sel.name}</span>
                  <ToolBtn onClick={() => patchBox(sel.garment_id, scaleBox(sel, 0.9))} label="縮小">－</ToolBtn>
                  <ToolBtn onClick={() => patchBox(sel.garment_id, scaleBox(sel, 1.1))} label="放大">＋</ToolBtn>
                  <ToolBtn onClick={() => bringToFront(sel.garment_id)} label="移到最上層">置頂</ToolBtn>
                  <ToolBtn onClick={() => patchBox(sel.garment_id, slotFor(sel.category))} label="重設位置">重設</ToolBtn>
                </div>
              ) : (
                <p className="text-center text-[12px] text-mauve">點選單品後可拖動；雙指或拉動角位 ⤡ 縮放</p>
              )}
            </div>
          )}

          {status === "review" && (
            <p className="mt-3 rounded-2xl bg-rose-soft p-3 text-[13px]">這是由 AI 匯入的真人穿搭照，請揀選對應的單品後儲存，即會轉為正式穿搭。</p>
          )}

          {picked.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-[13px] text-mauve">圖層（上面＝最上層，按住 ☰ 拖拉調整次序）</p>
              <SortableList
                items={topFirst}
                onReorder={reorderTopFirst}
                render={(p, handle) => (
                  <div
                    className={`flex items-center gap-1 rounded-2xl bg-white py-1 pl-1 pr-2 text-[14px] ring-1 ${p.garment_id === selected ? "ring-amethyst" : "ring-ink/5"}`}
                  >
                    <DragHandle {...handle} />
                    <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelected(p.garment_id)}>
                      <span className="h-10 w-8 shrink-0 overflow-hidden rounded-lg bg-rose-soft">
                        {p.image_id && <img src={imageUrl(p.image_id)} alt="" className="h-full w-full object-contain" loading="lazy" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    </button>
                    <button type="button" aria-label={`移除 ${p.name}`} onClick={() => update((c) => c.filter((x) => x.garment_id !== p.garment_id))} className="px-2 text-[16px] text-wine">
                      ×
                    </button>
                  </div>
                )}
              />
            </div>
          )}

          <div className="mt-4 space-y-3">
            <Field label="穿搭名稱">
              <input className={inputCls} value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder="例如：週末茶會" />
            </Field>
            <Field label="備註">
              <input className={inputCls} value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={favorite} onChange={(e) => { setFavorite(e.target.checked); setDirty(true); }} className="h-5 w-5 accent-amethyst" />
              收藏這套穿搭
            </label>
          </div>

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
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-serif text-lg font-bold">揀選單品</h2>
            <ColumnSwitch value={cols} onChange={setCols} />
          </div>
          <Chips options={tax.categories.map((c) => c.name)} value={cat} onChange={(v) => setCat(v)} />
          {!garments ? (
            <Spinner />
          ) : (
            <div className={`mt-3 grid ${GRID_COLS[cols]}`}>
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

function ToolBtn({ onClick, label, children }: { onClick: () => void; label: string; children: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="min-h-8 rounded-full bg-white px-3 ring-1 ring-ink/10 active:bg-rose-soft">
      {children}
    </button>
  );
}
