import { loadHighResolution } from "../imageCache";
import { TransparentImage, hasTransparentPixels } from "../components/TransparentImage";
import { PointerEvent as ReactPointerEvent, ReactNode, WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, displayName, Garment, imageUrl } from "../api";
import { IconChevronLeft, IconChevronRight, IconCopy, IconDress, IconGrid, IconImage, IconLayers, IconPlus, IconRedo, IconSave, IconSearch, IconTrash, IconUndo } from "../components/icons";
import { DragHandle, SortableList } from "../components/Sortable";
import { Chips, Field, GarmentTile, inputCls, Link, Spinner, toast } from "../components/ui";
import { navigate } from "../router";
import { useTaxonomy } from "../taxonomy";
import { OutfitPreview, OutfitSummary } from "./Outfits";

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
const HISTORY_MAX = 50;
// 「飾物」分頁包含的主分類；其餘主分類歸入「衣物」
const ACCESSORY = new Set(["鞋", "襪", "頭飾", "手袋", "配件", "其他裝飾"]);
const sameLayout = (a: Picked[], b: Picked[]) => a.length === b.length && a.every((p, i) => p.garment_id === b[i].garment_id && p.x === b[i].x && p.y === b[i].y && p.w === b[i].w && p.h === b[i].h);

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
  // 兩側面板（圖層／揀選單品）可收起，記住上次的狀態
  const [openLeft, setOpenLeft] = usePanel("aw:studio-left", true);
  const [openRight, setOpenRight] = usePanel("aw:studio-right", true);
  const [group, setGroup] = useState<"clothes" | "acc">("clothes");
  const [q, setQ] = useState("");
  const [showGrid, setShowGrid] = useState(false);
  const [others, setOthers] = useState<OutfitSummary[]>([]);
  const [busy, setBusy] = useState(false);
  // 復原／重做：只記錄版面（單品、位置、大小、圖層次序）
  const history = useRef<{ past: Picked[][]; future: Picked[][] }>({ past: [], future: [] });
  const gestureStart = useRef<Picked[] | null>(null);
  const [, bump] = useState(0);

  const canvas = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;

  useEffect(() => {
    api<{ outfits: OutfitSummary[] }>("/api/outfits").then((r) => setOthers(r.outfits)).catch(() => undefined);
  }, [id]);

  useEffect(() => {
    history.current = { past: [], future: [] };
    setSelected(null);
    setDirty(false);
    if (!id) {
      setPicked([]);
      setName("");
      setNotes("");
      setFavorite(false);
      setStatus("active");
      setOutfitImage(null);
      setLoaded(true);
    } else setLoaded(false);
    api<{ garments: Garment[] }>("/api/garments?limit=200&status=active&transparent=1").then((r) => setGarments(r.garments));
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

  const groupCats = useMemo(() => tax.categories.map((c) => c.name).filter((n) => (group === "acc") === ACCESSORY.has(n)), [tax, group]);
  const visible = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (garments || []).filter((g) => {
      if ((group === "acc") !== ACCESSORY.has(g.category || "")) return false;
      if (cat && g.category !== cat) return false;
      if (kw && !`${displayName(g)} ${g.brand || ""} ${g.subcategory || ""}`.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [garments, cat, group, q]);

  function record(prev: Picked[]) {
    const h = history.current;
    h.past.push(prev);
    if (h.past.length > HISTORY_MAX) h.past.shift();
    h.future = [];
    bump((n) => n + 1);
  }
  /** 改動版面。keep=false 用於手勢進行中（放手時才記入復原紀錄） */
  function update(fn: (cur: Picked[]) => Picked[], keep = true) {
    if (keep) record(pickedRef.current);
    setPicked(fn);
    setDirty(true);
  }
  const patchBox = (gid: string, box: Partial<Box>, keep = true) => update((cur) => cur.map((p) => (p.garment_id === gid ? { ...p, ...box } : p)), keep);
  function undo() {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev) return;
    h.future.push(pickedRef.current);
    setPicked(prev);
    setDirty(true);
    if (selected && !prev.some((p) => p.garment_id === selected)) setSelected(null);
  }
  function redo() {
    const h = history.current;
    const nxt = h.future.pop();
    if (!nxt) return;
    h.past.push(pickedRef.current);
    setPicked(nxt);
    setDirty(true);
  }

  function toggle(g: Garment) {
    if (picked.some((p) => p.garment_id === g.id)) {
      update((cur) => cur.filter((p) => p.garment_id !== g.id));
      if (selected === g.id) setSelected(null);
    } else {
      update((cur) => [...cur, { garment_id: g.id, name: displayName(g), category: g.category, image_id: g.transparent_image_id || null, ...slotFor(g.category) }]);
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
    if (!pointers.current.size) gestureStart.current = pickedRef.current;
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
    if (!pointers.current.size) gestureStart.current = pickedRef.current;
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
      patchBox(g.id, { x: clamp(g.box.x + dx, -g.box.w + 8, 92), y: clamp(g.box.y + dy, -g.box.h + 8, 92) }, false);
    } else if (g.kind === "pinch") {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      patchBox(g.id, scaleBox(g.box, d / g.d0), false);
    } else {
      const startW = (g.box.w / 100) * r.width;
      const newW = startW + (e.clientX - g.sx);
      patchBox(g.id, scaleBox(g.box, newW / startW, "topleft"), false);
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
    else if (!rest.length) {
      gesture.current = null;
      // 手勢結束：版面真的有改動才記入復原紀錄
      const start = gestureStart.current;
      gestureStart.current = null;
      if (start && !sameLayout(start, pickedRef.current)) record(start);
    }
  }
  function onWheel(e: ReactWheelEvent<HTMLDivElement>, gid: string) {
    if (selected !== gid) return;
    patchBox(gid, scaleBox(boxOf(gid), e.deltaY < 0 ? 1.05 : 0.95), false);
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

  /** 把畫布上的排版輸出成 PNG（1200×1600，奶油色底） */
  async function exportImage() {
    if (!picked.length) return toast("畫布上未有單品", "err");
    setBusy(true);
    try {
      const W = 1200, H = 1600;
      const cv = document.createElement("canvas");
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#fffaf6";
      ctx.fillRect(0, 0, W, H);
      for (const p of picked) {
        if (!p.image_id) throw new Error("有單品缺少高清透明圖，未能匯出");
        const img = await loadHighResolution(imageUrl(p.image_id)!);
        if (!hasTransparentPixels(img)) throw new Error("有單品未有真正透明的高清圖，未能匯出");
        // 與畫面一致：在方框內按比例完整顯示（object-contain）
        const bw = (p.w / 100) * W, bh = (p.h / 100) * H;
        const s = Math.min(bw / img.naturalWidth, bh / img.naturalHeight);
        const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
        ctx.drawImage(img, (p.x / 100) * W + (bw - dw) / 2, (p.y / 100) * H + (bh - dh) / 2, dw, dh);
      }
      const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/png"));
      if (!blob) throw new Error("未能產生圖片");
      const filename = `${name.trim() || "穿搭"}.png`;
      const file = new File([blob], filename, { type: "image/png" });
      // iPhone 加到主畫面後不能直接下載，改用分享面板（可「儲存影像」）
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] }).catch(() => undefined);
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast("已導出圖片");
      }
    } catch (e) {
      toast((e as Error).message || "導出失敗", "err");
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    if (!picked.length) return toast("畫布上未有單品", "err");
    setBusy(true);
    const r2 = (n: number) => Math.round(n * 100) / 100;
    try {
      const res = await api<{ id: string }>("/api/outfits", {
        method: "POST",
        json: {
          name: `${name.trim() || "新穿搭"}（副本）`,
          notes,
          is_favorite: false,
          items: picked.map((p, i) => ({ garment_id: p.garment_id, position: i, layer_order: i, x: r2(p.x), y: r2(p.y), w: r2(p.w), h: r2(p.h) })),
        },
      });
      toast("已複製成新一套");
      navigate(`/outfits/${res.id}`);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!id || !confirm("確定刪除這套穿搭？單品不會被刪除。")) return;
    await api(`/api/outfits/${id}`, { method: "DELETE" });
    toast("已刪除");
    navigate("/outfits", true);
  }

  if (!loaded) return <Spinner />;
  const sel = picked.find((p) => p.garment_id === selected) ?? null;
  const { past, future } = history.current;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 pt-5">
        <Link to="/outfits" className="btn-dark flex items-center gap-1 rounded-full py-1.5 pl-2 pr-3.5 text-[13px]">
          <IconChevronLeft className="text-[15px]" />
          我的穿搭
        </Link>
        {dirty && <span className="text-[12px] text-wine">未儲存</span>}
        <Link to="/outfits/new" className="btn-dark flex items-center gap-1 rounded-full py-1.5 pl-3.5 pr-3 text-[13px]">
          配搭新一套
          <IconPlus className="text-[13px]" />
        </Link>
      </div>
      <h1 className="mt-3 flex items-center justify-center gap-2 text-center font-serif text-[22px] font-bold tracking-[0.14em] text-gold-soft">
        穿搭工作室
      </h1>

      {/* ───── 揀選單品的篩選（衣物／飾物、搜尋、分類） ───── */}
      <div className="mt-3 flex items-center gap-2">
        <div className="chip inline-flex shrink-0 rounded-full p-0.5" role="group" aria-label="類型">
          {(["clothes", "acc"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={group === k} onClick={() => { setGroup(k); setCat(""); setOpenRight(true); }} className={`h-8 rounded-full px-3.5 font-serif text-[14px] tracking-[0.1em] ${group === k ? "chip-on" : "border border-transparent text-mauve"}`}>
              {k === "clothes" ? "衣物" : "飾物"}
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-[15px] text-[#8a6d80]" />
          <input type="search" className="h-9 w-full rounded-full bg-white pl-9 pr-3 text-ink ring-1 ring-gold placeholder:text-[14px] placeholder:text-mauve/80 focus:outline-none focus:ring-2 focus:ring-amethyst" placeholder="搜尋單品…" value={q} onChange={(e) => { setQ(e.target.value); setOpenRight(true); }} aria-label="搜尋單品" />
        </div>
      </div>
      <div className="mt-1.5">
        <Chips options={groupCats} value={cat} onChange={(v) => { setCat(v); setOpenRight(true); }} />
      </div>

      {/* ───── 左：圖層管理｜中：畫布｜右：揀選單品。兩側可收起，畫布會自動變大 ───── */}
      <div className="-mx-2 mt-2 flex items-stretch gap-1.5 lg:mx-0 lg:gap-4">
        <SidePanel side="left" open={openLeft} onToggle={() => setOpenLeft(!openLeft)} label="圖層" count={picked.length} icon={<IconLayers />} widthCls="w-[84px] lg:w-[210px]">
          {picked.length === 0 ? (
            <p className="px-1 py-3 text-center text-[11px] leading-relaxed text-mauve">加入單品後在這裡調整上下次序</p>
          ) : (
            <SortableList
              items={topFirst}
              onReorder={reorderTopFirst}
              render={(p, handle) => (
                <div className={`flex items-center gap-0.5 rounded-xl p-0.5 lg:gap-1 lg:py-1 lg:pl-1.5 ${p.garment_id === selected ? "chip-on" : "chip"}`}>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelected(p.garment_id)} aria-label={`選取 ${p.name}`}>
                    <span className="relative block h-12 w-9 shrink-0 overflow-hidden rounded-lg bg-rose-soft lg:h-10 lg:w-8">
                      {p.image_id && <TransparentImage src={imageUrl(p.image_id)} alt="" className="h-full w-full object-contain" loading="lazy" />}
                    </span>
                    <span className="hidden min-w-0 flex-1 text-[13px] lg:block">
                      <span className="block truncate">{p.category || "單品"}</span>
                      <span className="block truncate text-[11px] opacity-70">{p.name}</span>
                    </span>
                  </button>
                  <div className="flex shrink-0 flex-col items-center lg:flex-row">
                    <button type="button" aria-label={`移除 ${p.name}`} onClick={() => { update((c) => c.filter((x) => x.garment_id !== p.garment_id)); if (selected === p.garment_id) setSelected(null); }} className="grid h-6 w-6 place-items-center text-[15px] opacity-80">
                      ×
                    </button>
                    <DragHandle {...handle} />
                  </div>
                </div>
              )}
            />
          )}
        </SidePanel>

        {/* ───── 畫布 ───── */}
        <div className="min-w-0 flex-1">
          <div className="frame p-1.5">
            <div
              ref={canvas}
              className={`checker relative aspect-[3/4] overflow-hidden rounded-[12px] select-none ${showGrid ? "guides" : ""}`}
              style={{ touchAction: selected ? "none" : "pan-y" }}
              onPointerDown={onCanvasDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              {picked.length === 0 && outfitImage ? (
                <TransparentImage quality="high" src={imageUrl(outfitImage)} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : picked.length === 0 ? (
                <div className="absolute inset-0 grid place-items-center px-4 pt-8 text-center text-[13px] leading-relaxed text-mauve">在右邊點選衣物，這裡會即時組合預覽</div>
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
                        <TransparentImage quality="high" src={imageUrl(p.image_id)} alt={p.name} draggable={false} className="pointer-events-none h-full w-full object-contain" />
                      ) : (
                        <div className="grid h-full w-full place-items-center rounded-xl bg-white/70 text-[11px] text-mauve">{p.name}｜待補透明圖</div>
                      )}
                      {isSel && (
                        <div
                          role="slider"
                          aria-label="拖拉縮放"
                          aria-valuenow={Math.round(p.w)}
                          className="btn-jewel absolute -bottom-3 -right-3 grid h-7 w-7 place-items-center rounded-full text-[12px]"
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
              <div className="absolute right-1.5 top-1.5 flex gap-1" style={{ zIndex: 1000 }} onPointerDown={(e) => e.stopPropagation()}>
                <CanvasBtn label="復原" disabled={!past.length} onClick={undo}><IconUndo /></CanvasBtn>
                <CanvasBtn label="重做" disabled={!future.length} onClick={redo}><IconRedo /></CanvasBtn>
                <CanvasBtn label="對位格線" pressed={showGrid} onClick={() => setShowGrid((v) => !v)}><IconGrid /></CanvasBtn>
              </div>
            </div>
          </div>
        </div>

        <SidePanel side="right" open={openRight} onToggle={() => setOpenRight(!openRight)} label={group === "clothes" ? "衣物" : "飾物"} count={visible.length} icon={<IconDress />} widthCls="w-[92px] lg:w-[290px]">
          {!garments ? (
            <Spinner />
          ) : visible.length === 0 ? (
            <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-mauve">{garments.length ? "沒有符合的單品" : "衣櫃未有已入庫的衣物"}</p>
          ) : (
            <div className="grid grid-cols-1 gap-y-1 px-0.5 lg:grid-cols-2 lg:gap-x-2.5">
              {visible.map((g) => (
                <GarmentTile transparentOnly key={g.id} g={g} size="sm" selected={picked.some((p) => p.garment_id === g.id)} onSelect={() => toggle(g)} />
              ))}
            </div>
          )}
        </SidePanel>
      </div>

      <div className="mt-2.5 min-h-8">
        {sel ? (
          <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
            <span className="mr-1 max-w-[9rem] truncate text-mauve">{sel.name}</span>
            <ToolBtn onClick={() => patchBox(sel.garment_id, scaleBox(sel, 0.9))} label="縮小">－</ToolBtn>
            <ToolBtn onClick={() => patchBox(sel.garment_id, scaleBox(sel, 1.1))} label="放大">＋</ToolBtn>
            <ToolBtn onClick={() => bringToFront(sel.garment_id)} label="移到最上層">置頂</ToolBtn>
            <ToolBtn onClick={() => patchBox(sel.garment_id, slotFor(sel.category))} label="重設位置">重設</ToolBtn>
          </div>
        ) : picked.length > 0 ? (
          <p className="text-center text-[12px] text-mauve">點選單品後可拖動；雙指或拉動角位 ⤡ 縮放。收起兩側可放大畫布。</p>
        ) : null}
      </div>

      {status === "review" && (
        <p className="frame mt-3 p-3 text-[13px]">這是由 AI 匯入的真人穿搭照，請揀選對應的單品後儲存，即會轉為正式穿搭。</p>
      )}

      {/* ───── 穿搭組合 ───── */}
      <section className="frame mt-8 px-3 pb-3 pt-5" aria-label="穿搭組合">
        <h2 className="orn mb-2.5 text-center font-serif text-[15px] tracking-[0.14em] text-gold-soft">穿搭組合</h2>
        <div className="scrollbar-none flex gap-2.5 overflow-x-auto pb-1">
          <Link to="/outfits/new" className={`chip grid aspect-[3/4] w-20 shrink-0 place-items-center rounded-[14px] text-center text-[12px] ${!id ? "outline-2 outline-gold-soft" : ""}`}>
            <span>
              <IconPlus className="mx-auto mb-1 text-[20px]" />
              新增組合
            </span>
          </Link>
          {others.map((o) => (
            <Link key={o.id} to={`/outfits/${o.id}`} aria-current={o.id === id ? "page" : undefined} className={`block w-20 shrink-0 rounded-[14px] ${o.id === id ? "outline-2 outline-offset-1 outline-gold-soft" : ""}`}>
              <OutfitPreview o={o} />
              <span className="mt-1 block truncate text-center text-[11px] text-mauve">{o.name}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* ───── 穿搭資料及動作 ───── */}
      <section className="mt-5 grid gap-3 sm:grid-cols-2">
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
      </section>

      <div className={`mt-4 grid gap-2 ${id ? "grid-cols-4" : "grid-cols-2"}`}>
        <ActionBtn primary onClick={save} disabled={saving} label={saving ? "儲存中…" : "保存穿搭"}><IconSave /></ActionBtn>
        <ActionBtn onClick={exportImage} disabled={busy} label="導出圖片"><IconImage /></ActionBtn>
        {id && <ActionBtn onClick={duplicate} disabled={busy} label="複製組合"><IconCopy /></ActionBtn>}
        {id && <ActionBtn onClick={remove} disabled={busy} label="刪除組合"><IconTrash /></ActionBtn>}
      </div>
    </div>
  );
}

function usePanel(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  return [
    open,
    (v: boolean) => {
      setOpen(v);
      try {
        localStorage.setItem(key, v ? "1" : "0");
      } catch {
        /* 私密瀏覽等情況忽略 */
      }
    },
  ];
}

/**
 * 畫布兩側的面板：高度跟隨畫布，內容自己捲動。
 * 收起時只剩一條窄邊（圖示、直排名稱、數量），按一下展開。
 */
function SidePanel({
  side,
  open,
  onToggle,
  label,
  count,
  icon,
  widthCls,
  children,
}: {
  side: "left" | "right";
  open: boolean;
  onToggle: () => void;
  label: string;
  count: number;
  icon: ReactNode;
  widthCls: string;
  children: ReactNode;
}) {
  // 箭嘴指向面板會移動的方向
  const Arrow = (side === "left") === open ? IconChevronLeft : IconChevronRight;
  if (!open)
    return (
      <button type="button" onClick={onToggle} aria-expanded={false} aria-label={`展開${label}`} className="frame pat-stripe flex w-8 shrink-0 flex-col items-center gap-2 py-2.5 text-gold-soft" style={{ borderRadius: 12 }}>
        <Arrow className="text-[14px]" />
        <span className="text-[16px]">{icon}</span>
        <span className="font-serif text-[13px] tracking-[0.2em]" style={{ writingMode: "vertical-rl" }}>
          {label}
        </span>
        {count > 0 && <span className="chip-on grid h-5 min-w-5 place-items-center rounded-full px-1 text-[10px]">{count}</span>}
      </button>
    );
  return (
    <section className={`frame relative shrink-0 ${widthCls}`} style={{ borderRadius: 12 }} aria-label={label}>
      <div className="absolute inset-0 flex flex-col">
        <button type="button" onClick={onToggle} aria-expanded aria-label={`收起${label}`} className="flex shrink-0 items-center justify-center gap-1 border-b border-gold/30 py-1.5 font-serif text-[13px] tracking-[0.1em] text-gold-soft">
          {side === "right" && <Arrow className="text-[12px]" />}
          {label}
          {side === "left" && <Arrow className="text-[12px]" />}
        </button>
        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 lg:p-2.5">{children}</div>
      </div>
    </section>
  );
}

function ToolBtn({ onClick, label, children }: { onClick: () => void; label: string; children: string }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="chip min-h-8 rounded-full px-3">
      {children}
    </button>
  );
}

function CanvasBtn({ onClick, label, disabled, pressed, children }: { onClick: () => void; label: string; disabled?: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick} className={`grid h-7 w-7 place-items-center rounded-lg text-[15px] disabled:opacity-35 ${pressed ? "btn-jewel" : "btn-dark"}`}>
      {children}
    </button>
  );
}

function ActionBtn({ onClick, label, disabled, primary, children }: { onClick: () => void; label: string; disabled?: boolean; primary?: boolean; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-2xl px-1 text-[13px] disabled:opacity-40 ${primary ? "btn-jewel" : "btn-dark"}`}>
      <span className="text-[22px]">{children}</span>
      {label}
    </button>
  );
}
