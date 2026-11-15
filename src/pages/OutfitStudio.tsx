/**
 * Phase 3.9A.2：衣服配搭工作室 V2（手機優先）。
 *
 * 布局：頂部工具列（返回、名稱、未保存狀態、收藏、保存、更多）＋接近全寬的畫布＋可調高度的底部面板（衣物／圖層／背景／素材）。
 * 闊螢幕（≥ 1024px）面板改為右側欄。
 *
 * 畫布：單一 <canvas> 以共用渲染（src/studio/render.ts）繪畫背景及全部圖層，與縮圖及匯出使用同一套邏輯；
 * 選取框、縮放及旋轉控制點在獨立操作層，不改變圖層次序。
 *
 * 手勢：單指拖動已選圖層＝移動；控制點＝縮放／旋轉；雙指＝縮放及平移畫布（第二根手指落下即停止拖動圖層）；
 * 手掌工具＝移動畫布；點擊空白＝取消選取。命中判斷使用低解像度 Alpha（透明部分穿透到下一個可見圖層）。
 * 相機（畫布縮放、平移）與造型資料分開：不改動座標、不算未保存、不產生撤銷紀錄。
 */
import { PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, displayName, Garment } from "../api";
import { IconChevronLeft, IconCopy, IconEye, IconEyeOff, IconHand, IconHeart, IconLayers, IconLock, IconMore, IconPlus, IconRedo, IconScissors, IconSearch, IconShirt, IconTrash, IconUndo, IconImage, IconExpand, IconDownload, IconCamera } from "../components/icons";
import { DragHandle, SortableList } from "../components/Sortable";
import { Button, Sheet, Spinner, toast } from "../components/ui";
import { navigate } from "../router";
import { useTaxonomy } from "../taxonomy";
import { loadFullList } from "../wardrobeList";
import { BackgroundSpec, CANVAS_H, CANVAS_W, Layer, LayerMask, MAX_LAYERS, duplicateLayer, garmentIdsOf, moveLayer, reorderByTopFirstIds, sameScene, slotFor, toLayerLocal, toTopFirst } from "../../shared/studioScene";
import { AlphaGrid, Img, alphaAt, alphaGrid, composeScene, drawLayer, loadImage, maskedCanvas, paintBackground, sceneThumb, toBlob } from "../studio/render";
import { BackgroundPanel } from "../studio/BackgroundPanel";
import { ASSET_KIND_LABEL, AssetKind, StudioAsset, cutoutBlob, listStudioAssets, patchStudioAsset, prepareImage, saveCutout, uploadStudioAsset, versionToGarment } from "../studio/assets";

type Tab = "garments" | "layers" | "background" | "assets";
type Scene = { layers: Layer[]; background: BackgroundSpec | null };
type LayerView = Layer & { src: string | null; category?: string | null; has_cutout?: boolean; missing?: boolean };
interface Loaded { id: string; name: string; notes: string | null; is_favorite: boolean; status: string; updated_at: string; background: BackgroundSpec | null; layers: (Layer & { image_url: string | null; category?: string | null; has_cutout?: boolean; missing?: boolean })[] }
type Gesture =
  | { kind: "move"; id: string; sx: number; sy: number; box: Layer }
  | { kind: "scale"; id: string; cx: number; cy: number; d0: number; box: Layer }
  | { kind: "rotate"; id: string; cx: number; cy: number; a0: number; box: Layer }
  | { kind: "camera"; d0: number; c0: { x: number; y: number }; cam: Cam }
  | { kind: "pan"; sx: number; sy: number; cam: Cam }
  | { kind: "mask"; id: string; stroke: { mode: "hide" | "restore"; size: number; pts: number[] } };
interface Cam { z: number; x: number; y: number }
const HISTORY_MAX = 60;
const ACCESSORY = new Set(["鞋", "襪", "頭飾", "手袋", "配件", "其他裝飾"]);
const r2 = (n: number) => Math.round(n * 100) / 100;
const uid = () => "ly_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const DRAFT = (id?: string) => `aw:outfit-draft:${id ?? "new"}`;
const garmentSrc = (g: Garment) => (g.transparent_image_id ? `/api/images/${g.transparent_image_id}` : null);
const PANEL_H = { mini: 64, mid: 0.36, max: 0.62 };

export default function OutfitStudio({ id }: { id?: string }) {
  const tax = useTaxonomy();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [scene, setScene] = useState<Scene>({ layers: [], background: null });
  const [srcs, setSrcs] = useState<Record<string, LayerView["src"]>>({});
  const [extra, setExtra] = useState<Record<string, { category?: string | null; has_cutout?: boolean; missing?: boolean }>>({});
  const [name, setName] = useState("新穿搭");
  const [notes, setNotes] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [savedKey, setSavedKey] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("garments");
  const [tool, setTool] = useState<"select" | "hand" | "mask">("select");
  const [maskMode, setMaskMode] = useState<"hide" | "restore">("hide");
  const [brush, setBrush] = useState(0.06);
  const [compare, setCompare] = useState(false);
  const [clean, setClean] = useState(false);
  const [cam, setCam] = useState<Cam>({ z: 1, x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [layerMenu, setLayerMenu] = useState<string | null>(null);
  const [panel, setPanel] = useState<"mini" | "mid" | "max">(() => { try { return (localStorage.getItem("aw:studio-panel") as "mid") || "mid"; } catch { return "mid"; } });
  const [wide, setWide] = useState(() => window.matchMedia?.("(min-width: 1024px)").matches ?? false);
  const [, bump] = useState(0);
  const history = useRef<{ past: Scene[]; future: Scene[] }>({ past: [], future: [] });
  const sceneRef = useRef(scene); sceneRef.current = scene;
  const camRef = useRef(cam); camRef.current = cam;
  const updatedAt = useRef<string | null>(null);

  useEffect(() => { const mq = window.matchMedia?.("(min-width: 1024px)"); if (!mq) return; const on = () => setWide(mq.matches); mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }, []);
  useEffect(() => { try { localStorage.setItem("aw:studio-panel", panel); } catch { /* ignore */ } }, [panel]);

  // ───── 載入 ─────
  useEffect(() => {
    history.current = { past: [], future: [] };
    setSelected(null); setCam({ z: 1, x: 0, y: 0 });
    const applyDraft = (base: { name: string; notes: string; favorite: boolean; scene: Scene; srcs: Record<string, string | null> }, serverUpdated: string | null) => {
      try {
        const d = JSON.parse(localStorage.getItem(DRAFT(id)) || "null") as null | { at: number; base: string | null; name: string; notes: string; favorite: boolean; scene: Scene; srcs: Record<string, string | null> };
        if (d && d.base === serverUpdated) { setName(d.name); setNotes(d.notes); setFavorite(d.favorite); setScene(d.scene); setSrcs({ ...base.srcs, ...d.srcs }); toast("已恢復未保存的草稿"); return true; }
      } catch { /* 草稿損壞：忽略 */ }
      return false;
    };
    if (!id) {
      const base = { name: "新穿搭", notes: "", favorite: false, scene: { layers: [], background: null }, srcs: {} };
      setLoaded({ id: "", name: base.name, notes: null, is_favorite: false, status: "active", updated_at: "", background: null, layers: [] });
      setName(base.name); setNotes(""); setFavorite(false); setScene(base.scene); setSrcs({});
      setSavedKey(keyOf(base.scene, base.name, "", false));
      applyDraft(base, null);
      return;
    }
    setLoaded(null);
    api<Loaded>(`/api/outfits/${id}`).then((o) => {
      const sc: Scene = { layers: o.layers.map(({ image_url: _u, category: _c, has_cutout: _h, missing: _m, ...l }) => l as Layer), background: o.background };
      const s: Record<string, string | null> = {}; const ex: typeof extra = {};
      for (const l of o.layers) { s[l.layer_id] = l.image_url; ex[l.layer_id] = { category: l.category, has_cutout: l.has_cutout, missing: l.missing }; }
      updatedAt.current = o.updated_at;
      setLoaded(o); setName(o.name); setNotes(o.notes ?? ""); setFavorite(o.is_favorite); setScene(sc); setSrcs(s); setExtra(ex);
      setSavedKey(keyOf(sc, o.name, o.notes ?? "", o.is_favorite));
      applyDraft({ name: o.name, notes: o.notes ?? "", favorite: o.is_favorite, scene: sc, srcs: s }, o.updated_at);
    }).catch((e) => toast((e as Error).message, "err"));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const keyOf = (sc: Scene, n: string, no: string, f: boolean) => JSON.stringify([sc, n, no, f]);
  const dirty = !!loaded && keyOf(scene, name, notes, favorite) !== savedKey;
  // 草稿：未保存的修改保存在這部手機（素材已上傳，只保存設定）
  useEffect(() => {
    if (!loaded) return;
    const t = window.setTimeout(() => { try { if (dirty) localStorage.setItem(DRAFT(id), JSON.stringify({ at: Date.now(), base: updatedAt.current, name, notes, favorite, scene, srcs })); else localStorage.removeItem(DRAFT(id)); } catch { /* 容量不足 */ } }, 300);
    return () => clearTimeout(t);
  }, [scene, name, notes, favorite, dirty, loaded, id, srcs]);
  useEffect(() => { const on = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", on); return () => window.removeEventListener("beforeunload", on); }, [dirty]);

  // ───── 歷史 ─────
  const commit = useCallback((next: Scene | ((s: Scene) => Scene), prev?: Scene) => {
    const before = prev ?? sceneRef.current;
    const after = typeof next === "function" ? next(sceneRef.current) : next;
    if (sameScene(before, after)) { setScene(after); return; }
    const h = history.current;
    h.past.push(before); if (h.past.length > HISTORY_MAX) h.past.shift(); h.future = [];
    setScene(after); bump((n) => n + 1);
  }, []);
  const undo = () => { const h = history.current; const p = h.past.pop(); if (!p) return; h.future.push(sceneRef.current); setScene(p); bump((n) => n + 1); };
  const redo = () => { const h = history.current; const n = h.future.pop(); if (!n) return; h.past.push(sceneRef.current); setScene(n); bump((x) => x + 1); };
  const patchLayer = (lid: string, p: Partial<Layer>, live = false) => { const f = (s: Scene) => ({ ...s, layers: s.layers.map((l) => (l.layer_id === lid ? { ...l, ...p } : l)) }); if (live) setScene(f); else commit(f); };

  // ───── 圖片、遮罩及 Alpha（只在圖片或遮罩改變時重新計算） ─────
  const [imgs, setImgs] = useState<Record<string, { src: string; img: HTMLImageElement } | { src: string; error: string }>>({});
  useEffect(() => {
    for (const [lid, src] of Object.entries(srcs)) {
      if (!src || imgs[lid]?.src === src) continue;
      loadImage(src).then((img) => setImgs((m) => ({ ...m, [lid]: { src, img } }))).catch((e) => setImgs((m) => ({ ...m, [lid]: { src, error: (e as Error).message } })));
    }
  }, [srcs]); // eslint-disable-line react-hooks/exhaustive-deps
  const maskCache = useRef(new Map<string, { key: string; canvas: HTMLCanvasElement; grid: AlphaGrid }>());
  const rendered = useCallback((l: Layer): { canvas: HTMLCanvasElement; grid: AlphaGrid } | null => {
    const e = imgs[l.layer_id];
    if (!e || !("img" in e)) return null;
    const key = e.src + "|" + (l.mask ? JSON.stringify(l.mask) : "");
    const hit = maskCache.current.get(l.layer_id);
    if (hit && hit.key === key) return hit;
    const canvas = maskedCanvas(e.img, l.mask, 1100);
    const v = { key, canvas, grid: alphaGrid(canvas) };
    maskCache.current.set(l.layer_id, v);
    return v;
  }, [imgs]);
  const [bgImg, setBgImg] = useState<HTMLImageElement | null>(null);
  const bgSrc = scene.background?.type === "image" && scene.background.image ? `/api/studio/versions/${scene.background.image.version_id}${scene.background.image.variant === "cutout" ? "?cutout=1" : ""}` : null;
  useEffect(() => { if (!bgSrc) { setBgImg(null); return; } let live = true; loadImage(bgSrc).then((i) => live && setBgImg(i)).catch(() => live && setBgImg(null)); return () => { live = false; }; }, [bgSrc]);

  // ───── 畫布尺寸 ─────
  const stageBox = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 300, h: 400 });
  useLayoutEffect(() => {
    const el = stageBox.current; if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); const w = Math.max(120, Math.min(r.width - 8, ((r.height - 8) * CANVAS_W) / CANVAS_H)); setSize({ w: Math.round(w), h: Math.round((w * CANVAS_H) / CANVAS_W) }); };
    measure(); const ob = new ResizeObserver(measure); ob.observe(el); return () => ob.disconnect();
  }, [loaded, wide, panel, clean]);

  // ───── 繪畫（共用渲染） ─────
  useEffect(() => {
    const c = canvas.current; if (!c) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const W = Math.round(size.w * dpr), H = Math.round(size.h * dpr);
    if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    paintBackground(ctx, scene.background, W, H, bgImg);
    for (const l of scene.layers) {
      const r = compare && l.layer_id === selected ? (imgs[l.layer_id] && "img" in imgs[l.layer_id] ? (imgs[l.layer_id] as { img: HTMLImageElement }).img : null) : rendered(l)?.canvas;
      if (r) drawLayer(ctx, l, r, W, H);
    }
    c.dataset.ready = scene.layers.every((l) => !srcs[l.layer_id] || imgs[l.layer_id]) ? "1" : "0";
  }, [scene, size, imgs, bgImg, rendered, compare, selected, srcs]);

  // ───── 命中判斷及手勢 ─────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const gestureStart = useRef<Scene | null>(null);
  const toPct = (cx: number, cy: number) => { const r = stage.current!.getBoundingClientRect(); const c = camRef.current; return { x: ((cx - r.left - c.x) / c.z / size.w) * 100, y: ((cy - r.top - c.y) / c.z / size.h) * 100 }; };
  const aspectOf = (l: Layer) => { const r = rendered(l); return r ? r.canvas.width / r.canvas.height : 0.75; };
  function hitTest(px: number, py: number): string | null {
    const ls = sceneRef.current.layers;
    for (let i = ls.length - 1; i >= 0; i--) {
      const l = ls[i];
      if (l.hidden || l.locked) continue;
      const r = rendered(l); if (!r) continue;
      const { u, v } = toLayerLocal(l, px, py, r.canvas.width / r.canvas.height);
      if (alphaAt(r.grid, u, v) > 24) return l.layer_id; // 透明部分穿透到下一個可見圖層
    }
    return null;
  }
  const layerById = (lid: string) => sceneRef.current.layers.find((l) => l.layer_id === lid)!;
  function startCamera() {
    const pts = [...pointers.current.values()];
    gesture.current = { kind: "camera", d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, c0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, cam: camRef.current };
  }
  function onStageDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2) { finishGesture(); startCamera(); return; } // 第二根手指：停止拖動圖層，改為畫布縮放
    gestureStart.current = sceneRef.current;
    if (tool === "hand") { gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, cam: camRef.current }; return; }
    const p = toPct(e.clientX, e.clientY);
    if (tool === "mask" && selected) {
      const l = layerById(selected);
      const { u, v } = toLayerLocal(l, p.x, p.y, aspectOf(l));
      gesture.current = { kind: "mask", id: selected, stroke: { mode: maskMode, size: brush, pts: [r4(u), r4(v)] } };
      applyMaskStroke(true);
      return;
    }
    const hit = hitTest(p.x, p.y);
    if (!hit) { setSelected(null); gesture.current = null; return; }
    setSelected(hit);
    gesture.current = { kind: "move", id: hit, sx: p.x, sy: p.y, box: layerById(hit) };
  }
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  function applyMaskStroke(live: boolean) {
    const g = gesture.current; if (!g || g.kind !== "mask") return;
    const l = layerById(g.id);
    const base = (gestureStart.current ?? sceneRef.current).layers.find((x) => x.layer_id === g.id)?.mask?.strokes ?? [];
    const mask: LayerMask = { v: 1, strokes: [...base, { ...g.stroke, pts: [...g.stroke.pts] }] };
    patchLayer(l.layer_id, { mask }, live);
  }
  function onStageMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current; if (!g) return;
    if (g.kind === "camera") {
      const pts = [...pointers.current.values()]; if (pts.length < 2) return;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), c = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const z = Math.min(6, Math.max(0.5, g.cam.z * (d / g.d0)));
      const r = stage.current!.getBoundingClientRect();
      // 以手指中心為縮放中心，並跟隨兩指平移
      const ox = g.c0.x - r.left, oy = g.c0.y - r.top;
      setCam({ z, x: ox - ((ox - g.cam.x) * z) / g.cam.z + (c.x - g.c0.x), y: oy - ((oy - g.cam.y) * z) / g.cam.z + (c.y - g.c0.y) });
      return;
    }
    if (g.kind === "pan") { setCam({ ...g.cam, x: g.cam.x + e.clientX - g.sx, y: g.cam.y + e.clientY - g.sy }); return; }
    const p = toPct(e.clientX, e.clientY);
    if (g.kind === "mask") {
      const l = layerById(g.id); const { u, v } = toLayerLocal(l, p.x, p.y, aspectOf(l));
      g.stroke.pts.push(r4(u), r4(v)); applyMaskStroke(true); return;
    }
    if (g.kind === "move") { patchLayer(g.id, { x: r2(g.box.x + p.x - g.sx), y: r2(g.box.y + p.y - g.sy) }, true); return; }
    if (g.kind === "scale") {
      const d = Math.hypot(p.x - g.cx, (p.y - g.cy) * (CANVAS_H / CANVAS_W));
      const f = Math.max(0.05, d / g.d0);
      const w = Math.min(400, Math.max(2, g.box.w * f)), h = Math.min(400, Math.max(2, g.box.h * (w / g.box.w)));
      patchLayer(g.id, { w: r2(w), h: r2(h), x: r2(g.cx - w / 2), y: r2(g.cy - h / 2) }, true); return;
    }
    if (g.kind === "rotate") {
      const a = (Math.atan2((p.y - g.cy) * (CANVAS_H / CANVAS_W), p.x - g.cx) * 180) / Math.PI;
      let rot = g.box.rotation + a - g.a0; rot = ((rot + 540) % 360) - 180;
      if (Math.abs(rot) < 3) rot = 0; // 接近 0° 時吸附
      patchLayer(g.id, { rotation: r2(rot) }, true);
    }
  }
  function finishGesture() {
    const g = gesture.current; gesture.current = null;
    const start = gestureStart.current; gestureStart.current = null;
    if (!g || g.kind === "camera" || g.kind === "pan" || !start) return;
    if (!sameScene(start, sceneRef.current)) commit(sceneRef.current, start); // 一次手勢＝一筆撤銷紀錄
  }
  function onStageUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (gesture.current?.kind === "camera") { if (pointers.current.size < 2) gesture.current = null; return; }
    if (!pointers.current.size) finishGesture();
  }
  function onHandleDown(e: ReactPointerEvent<HTMLElement>, kind: "scale" | "rotate") {
    e.stopPropagation();
    if (!selected) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gestureStart.current = sceneRef.current;
    const l = layerById(selected), cx = l.x + l.w / 2, cy = l.y + l.h / 2, p = toPct(e.clientX, e.clientY);
    gesture.current = kind === "scale" ? { kind, id: selected, cx, cy, d0: Math.hypot(p.x - cx, (p.y - cy) * (CANVAS_H / CANVAS_W)) || 1, box: l } : { kind, id: selected, cx, cy, a0: (Math.atan2((p.y - cy) * (CANVAS_H / CANVAS_W), p.x - cx) * 180) / Math.PI, box: l };
  }
  const zoomBy = (f: number) => setCam((c) => { const z = Math.min(6, Math.max(0.5, c.z * f)); const cx = size.w / 2, cy = size.h / 2; return { z, x: cx - ((cx - c.x) * z) / c.z, y: cy - ((cy - c.y) * z) / c.z }; });

  // ───── 加入圖層 ─────
  const addLayer = (l: Omit<Layer, "layer_id">, src: string | null, ex: { category?: string | null; has_cutout?: boolean } = {}) => {
    if (sceneRef.current.layers.length >= MAX_LAYERS) { toast(`每套造型最多 ${MAX_LAYERS} 個圖層`, "err"); return null; }
    const lid = uid();
    setSrcs((m) => ({ ...m, [lid]: src })); setExtra((m) => ({ ...m, [lid]: ex }));
    commit((s) => ({ ...s, layers: [...s.layers, { ...l, layer_id: lid }] }));
    setSelected(lid); setTool("select");
    return lid;
  };
  const blank = (p: Partial<Layer>): Omit<Layer, "layer_id"> => ({ layer_type: "garment", garment_id: null, garment_part_id: null, asset_id: null, asset_version_id: null, group_id: null, name: "", x: 20, y: 20, w: 60, h: 50, rotation: 0, flip_x: false, flip_y: false, opacity: 1, hidden: false, locked: false, mask: null, variant: "original", ...p });
  function addGarment(g: Garment, force = false) {
    const existing = toTopFirst(scene.layers).find((l) => l.garment_id === g.id && l.layer_type === "garment");
    if (existing && !force) { setSelected(existing.layer_id); toast("已選取畫布上的這件衣物；需要多一件可按「再加入一件」"); return; }
    addLayer(blank({ garment_id: g.id, name: displayName(g), ...slotFor(g.category) }), garmentSrc(g), { category: g.category });
    rememberRecent(g.id);
  }
  function duplicate(lid: string) {
    if (scene.layers.length >= MAX_LAYERS) return toast(`每套造型最多 ${MAX_LAYERS} 個圖層`, "err");
    const nid = uid();
    setSrcs((m) => ({ ...m, [nid]: m[lid] ?? null })); setExtra((m) => ({ ...m, [nid]: m[lid] ?? {} }));
    commit((s) => ({ ...s, layers: duplicateLayer(s.layers, lid, nid) }));
    setSelected(nid);
  }
  const removeLayer = (lid: string) => { commit((s) => ({ ...s, layers: s.layers.filter((l) => l.layer_id !== lid) })); if (selected === lid) setSelected(null); };

  // ───── 保存 ─────
  async function save(): Promise<string | null> {
    if (!scene.layers.length && !id) { toast("請先加入衣物或素材", "err"); return null; }
    if (!navigator.onLine) { toast("目前離線：修改已保存為這部手機的草稿，連線後再保存", "err"); return null; }
    setSaving(true);
    try {
      // 完整縮圖（與畫布一致）：所有圖片載入完成才產生；有圖片未能讀取時不產生縮圖（不會產生缺少圖層的縮圖）
      let thumb: string | undefined;
      const missing = scene.layers.filter((l) => !l.hidden && srcs[l.layer_id] && !rendered(l));
      if (!missing.length) { try { thumb = await sceneThumb(scene.layers, scene.background, { layer: (l) => rendered(l)?.canvas ?? null, background: bgImg }); } catch { /* 縮圖失敗不影響保存 */ } }
      const body = { name: name.trim() || "新穿搭", notes, is_favorite: favorite, layers: scene.layers, background: scene.background, ...(thumb ? { thumb } : {}), ...(id && updatedAt.current ? { base_updated_at: updatedAt.current } : {}), ...(id && loaded?.status === "review" && scene.layers.length ? { status: "active" } : {}) };
      const res = await api<Loaded>(id ? `/api/outfits/${id}` : "/api/outfits", { method: id ? "PATCH" : "POST", json: body });
      updatedAt.current = res.updated_at;
      setSavedKey(keyOf(scene, body.name, notes, favorite)); setName(body.name);
      try { localStorage.removeItem(DRAFT(id)); } catch { /* ignore */ }
      toast(thumb ? "已保存造型" : missing.length ? "已保存造型（部分圖片未能讀取，縮圖稍後再更新）" : "已保存造型");
      if (!id) navigate(`/outfits/${res.id}`, true);
      return res.id;
    } catch (e) {
      toast(`${(e as Error).message}（修改仍保留在畫面及草稿）`, "err");
      return null;
    } finally { setSaving(false); }
  }

  // ───── 最近使用 ─────
  const rememberRecent = (gid: string) => { try { const list = JSON.parse(localStorage.getItem("aw:studio-recent") || "[]") as string[]; localStorage.setItem("aw:studio-recent", JSON.stringify([gid, ...list.filter((x) => x !== gid)].slice(0, 24))); } catch { /* ignore */ } };

  if (!loaded) return <div className="fixed inset-0 z-40 grid place-items-center bg-plum"><Spinner /></div>;
  const sel = scene.layers.find((l) => l.layer_id === selected) ?? null;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const panelH = clean ? 0 : wide ? 0 : panel === "mini" ? PANEL_H.mini : Math.round(vh * PANEL_H[panel]);
  const { past, future } = history.current;
  const selBox = sel ? { left: (sel.x / 100) * size.w, top: (sel.y / 100) * size.h, width: (sel.w / 100) * size.w, height: (sel.h / 100) * size.h } : null;

  const panelBody = (
    <div className="flex h-full min-h-0 flex-col">
      {sel && <SelectedBar l={sel} tool={tool} setTool={setTool} maskMode={maskMode} setMaskMode={setMaskMode} brush={brush} setBrush={setBrush} compare={compare} setCompare={setCompare}
            onPatch={(p, live) => patchLayer(sel.layer_id, p, live)} onCommitLive={(start) => commit(sceneRef.current, start)} getScene={() => sceneRef.current}
            onMenu={() => setLayerMenu(sel.layer_id)} hasCutout={!!extra[sel.layer_id]?.has_cutout} onVariant={(v) => { const ver = sel.asset_version_id!; setSrcs((m) => ({ ...m, [sel.layer_id]: `/api/studio/versions/${ver}${v === "cutout" ? "?cutout=1" : ""}` })); patchLayer(sel.layer_id, { variant: v }); }} />}
      <div className="grid shrink-0 grid-cols-4 gap-1.5 px-2 pb-1.5" role="tablist" data-testid="studio-tabs">
        {([["garments", "衣物", IconShirt], ["layers", "圖層", IconLayers], ["background", "背景", IconImage], ["assets", "素材", IconPlus]] as [Tab, string, typeof IconShirt][]).map(([k, l, I]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} data-tab={k} onClick={() => { setTab(k); if (panel === "mini") setPanel("mid"); }} className={`flex h-11 flex-col items-center justify-center rounded-2xl text-[11.5px] ${tab === k ? "chip-on" : "chip"}`}><I className="text-[15px]" />{l}{k === "layers" && scene.layers.length ? ` ${scene.layers.length}` : ""}</button>
        ))}
      </div>
      <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {tab === "garments" && <GarmentsTab onAdd={addGarment} onPart={(g, part) => { addLayer(blank({ layer_type: "garment_part", garment_id: g.id, garment_part_id: part.id, group_id: g.id, name: `${displayName(g)}｜${part.name}`, ...slotFor(g.category) }), part.src, { category: g.category }); rememberRecent(g.id); }} usedIds={new Set(garmentIdsOf(scene.layers))} tax={tax} />}
        {tab === "layers" && (
          <LayersTab layers={scene.layers} srcs={srcs} extra={extra} selected={selected} onSelect={(lid) => { setSelected(lid); setTool("select"); }}
            onReorder={(ids) => commit((s) => ({ ...s, layers: reorderByTopFirstIds(s.layers, ids) }))}
            onPatch={patchLayer} onMenu={setLayerMenu} />
        )}
        {tab === "background" && <BackgroundPanel value={scene.background} onChange={(b) => commit((s) => ({ ...s, background: b }))} legacyLabel="預設（舊版）" onUpload={async (f) => { try { const img = await prepareImage(f); const a = await uploadStudioAsset(img, { kind: "background", name: f.name.replace(/\.[^.]+$/, "") || "背景", inLibrary: false }); return { asset_id: a.id, version_id: a.version!.id }; } catch (e) { toast((e as Error).message, "err"); return null; } }} />}
        {tab === "assets" && <AssetsTab onAdd={(a, variant) => addLayer(blank({ layer_type: "studio_asset", asset_id: a.id, asset_version_id: a.version!.id, name: a.name, variant, x: 35, y: 30, w: 30, h: 30 * ((a.version!.height / a.version!.width) * (CANVAS_W / CANVAS_H)) }), variant === "cutout" ? a.version!.cutout_url : a.version!.url, { has_cutout: a.version!.has_cutout })} />}
      </div>
    </div>
  );

  return (
    <div className="doll-room fixed inset-0 z-40 flex flex-col bg-plum" data-testid="outfit-studio" data-dirty={dirty ? "1" : "0"} data-layers={scene.layers.map((l) => l.layer_id).join(",")} data-selected={selected ?? ""} data-undo={past.length} data-cam={`${r2(cam.z)},${Math.round(cam.x)},${Math.round(cam.y)}`} data-tool={tool} data-bg={scene.background?.type ?? "legacy"}>
      {/* 頂部工具列 */}
      {!clean && <header className="safe-top flex shrink-0 items-center gap-1.5 px-2 pb-1.5" style={{ background: "var(--aw-header)" }}>
        <button type="button" aria-label="返回我的穿搭" onClick={() => { if (!dirty || confirm("有未保存的修改（已保存為草稿）。離開？")) navigate("/outfits"); }} className="icon-btn"><IconChevronLeft /></button>
        <div className="min-w-0 flex-1">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="造型名稱" maxLength={120} className="w-full truncate bg-transparent font-serif text-[17px] font-bold text-gold-soft outline-none" data-testid="studio-name" />
          <p className="text-[10.5px] text-mauve" data-testid="studio-status">衣服配搭・{saving ? "保存中…" : dirty ? "未保存" : id ? "已保存" : "新造型"}</p>
        </div>
        <button type="button" aria-label={favorite ? "取消收藏" : "收藏"} aria-pressed={favorite} onClick={() => setFavorite(!favorite)} className={`icon-btn ${favorite ? "text-[var(--aw-chart)]" : ""}`}><IconHeart filled={favorite} /></button>
        <button type="button" onClick={() => void save()} disabled={saving} className="btn-jewel h-9 rounded-full px-4 text-[14px] disabled:opacity-60" data-testid="studio-save">{saving ? "保存中" : "保存"}</button>
        <div className="relative">
          <button type="button" aria-label="更多" onClick={() => setMoreOpen(!moreOpen)} className="icon-btn" data-testid="studio-more"><IconMore /></button>
          {moreOpen && <><div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} /><div role="menu" className="pop absolute right-0 top-10 z-50 w-44 overflow-hidden rounded-2xl text-[13px]" onClick={() => setMoreOpen(false)}>
            <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left" onClick={() => setMetaOpen(true)}>名稱及備註</button>
            <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left" onClick={async () => { const oid = dirty || !id ? await save() : id; if (oid) navigate(`/diary/new?outfit=${oid}`); }}>加入穿搭日誌</button>
            <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left" data-testid="studio-export-open" onClick={() => setExportOpen(true)}>匯出圖片</button>
            {id && <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left" onClick={async () => { try { const r = await api<{ id: string }>("/api/outfits", { method: "POST", json: { name: `${name}（副本）`, notes, layers: scene.layers, background: scene.background } }); toast("已複製成新造型"); navigate(`/outfits/${r.id}`); } catch (e) { toast((e as Error).message, "err"); } }}>複製造型</button>}
            {id && <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left text-wine" onClick={async () => { if (!confirm("刪除這套造型？衣物不會被刪除。")) return; await api(`/api/outfits/${id}`, { method: "DELETE" }); try { localStorage.removeItem(DRAFT(id)); } catch { /* ignore */ } toast("已刪除"); navigate("/outfits", true); }}>刪除造型</button>}
          </div></>}
        </div>
      </header>}

      <div className={`flex min-h-0 flex-1 ${wide && !clean ? "flex-row" : "flex-col"}`}>
        {/* 畫布 */}
        <div ref={stageBox} className="relative min-h-0 flex-1 overflow-hidden" data-testid="studio-stage-box">
          <div ref={stage} className="absolute select-none" style={{ left: "50%", top: "50%", width: size.w, height: size.h, marginLeft: -size.w / 2, marginTop: -size.h / 2, touchAction: "none" }}
            onPointerDown={onStageDown} onPointerMove={onStageMove} onPointerUp={onStageUp} onPointerCancel={onStageUp}
            onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.08 : 0.92)} data-testid="studio-stage" data-w={size.w} data-h={size.h}>
            <div className="absolute left-0 top-0 origin-top-left" style={{ width: size.w, height: size.h, transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}>
              <div className={`absolute inset-0 overflow-hidden rounded-[14px] ${!scene.background || scene.background.type === "transparent" ? "checker" : ""}`} />
              <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full rounded-[14px]" data-testid="studio-canvas" />
              {!scene.layers.length && <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-[13px] text-mauve">在下方「衣物」或「素材」點選加入，這裡會即時預覽</div>}
              {/* 獨立操作層：選取框及控制點（不改變圖層次序） */}
              {sel && selBox && !clean && tool !== "hand" && (
                <div className="pointer-events-none absolute" data-testid="studio-selection" style={{ ...selBox, transform: `rotate(${sel.rotation}deg)` }}>
                  <div className="absolute inset-0 rounded-sm border border-dashed" style={{ borderColor: "var(--aw-handle)", borderWidth: 1.5 / cam.z }} />
                  {!sel.locked && tool === "select" && <>
                    <span role="slider" aria-label="拖動縮放" aria-valuenow={Math.round(sel.w)} data-handle="scale" className="sv-handle pointer-events-auto absolute grid place-items-center rounded-full border text-[11px] text-[var(--aw-on-primary)]" style={{ width: 28 / cam.z, height: 28 / cam.z, right: -14 / cam.z, bottom: -14 / cam.z, background: "var(--aw-primary)", borderColor: "var(--aw-handle)", touchAction: "none" }} onPointerDown={(e) => onHandleDown(e, "scale")} onPointerMove={(e) => { e.stopPropagation(); onStageMove(e as unknown as ReactPointerEvent<HTMLDivElement>); }} onPointerUp={(e) => { e.stopPropagation(); onStageUp(e as unknown as ReactPointerEvent<HTMLDivElement>); }}>⤡</span>
                    <span role="slider" aria-label="拖動旋轉" aria-valuenow={Math.round(sel.rotation)} data-handle="rotate" className="pointer-events-auto absolute grid place-items-center rounded-full border text-[11px] text-[var(--aw-on-primary)]" style={{ width: 28 / cam.z, height: 28 / cam.z, left: "50%", marginLeft: -14 / cam.z, top: -40 / cam.z, background: "var(--aw-primary)", borderColor: "var(--aw-handle)", touchAction: "none" }} onPointerDown={(e) => onHandleDown(e, "rotate")} onPointerMove={(e) => { e.stopPropagation(); onStageMove(e as unknown as ReactPointerEvent<HTMLDivElement>); }} onPointerUp={(e) => { e.stopPropagation(); onStageUp(e as unknown as ReactPointerEvent<HTMLDivElement>); }}>⟳</span>
                  </>}
                </div>
              )}
            </div>
          </div>
          {/* 畫布工具 */}
          <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
            <span className="doll-tool pointer-events-auto rounded-full px-3 py-1 text-[12px]" data-testid="studio-zoom" onClick={() => setCam({ z: 1, x: 0, y: 0 })}>全圖・{Math.round(cam.z * 100)}%</span>
            <div className="pointer-events-auto flex gap-1">
              <CanvasBtn label="放大" onClick={() => zoomBy(1.25)}>＋</CanvasBtn>
              <CanvasBtn label="縮小" onClick={() => zoomBy(0.8)}>－</CanvasBtn>
              <CanvasBtn label="手掌工具（移動畫布）" pressed={tool === "hand"} onClick={() => setTool(tool === "hand" ? "select" : "hand")} testid="studio-hand"><IconHand /></CanvasBtn>
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-2 bottom-2 flex items-end justify-between gap-2">
            <div className="pointer-events-auto flex gap-1">
              <CanvasBtn label="撤銷" disabled={!past.length} onClick={undo} testid="studio-undo"><IconUndo /></CanvasBtn>
              <CanvasBtn label="重做" disabled={!future.length} onClick={redo} testid="studio-redo"><IconRedo /></CanvasBtn>
            </div>
            <CanvasBtn label={clean ? "結束乾淨預覽" : "全螢幕乾淨預覽"} pressed={clean} onClick={() => setClean(!clean)} testid="studio-clean"><IconExpand /></CanvasBtn>
          </div>
        </div>

        {/* 底部面板（手機）／右側欄（闊螢幕） */}
        {!clean && (wide ? (
          <aside className="doll-panel flex w-[360px] shrink-0 flex-col pt-2" style={{ background: "var(--aw-sheet)" }} data-testid="studio-panel" data-size="side">{panelBody}</aside>
        ) : (
          <section className="doll-panel safe-bottom flex shrink-0 flex-col" style={{ height: panelH + 18, background: "var(--aw-sheet)" }} data-testid="studio-panel" data-size={panel}>
            <button type="button" aria-label="調整面板高度" className="mx-auto my-1 h-2.5 w-14 shrink-0 rounded-full bg-cream/25" data-testid="studio-panel-grip"
              onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); (e.currentTarget as HTMLElement).dataset.y = String(e.clientY); }}
              onPointerUp={(e) => { const y0 = Number((e.currentTarget as HTMLElement).dataset.y || e.clientY); const dy = y0 - e.clientY; setPanel(Math.abs(dy) < 8 ? (panel === "max" ? "mid" : panel === "mid" ? "max" : "mid") : dy > 0 ? (panel === "mini" ? "mid" : "max") : panel === "max" ? "mid" : "mini"); }} />
            {panelBody}
          </section>
        ))}
      </div>

      {layerMenu && (() => {
        const l = scene.layers.find((x) => x.layer_id === layerMenu); if (!l) return null;
        const act = (fn: () => void) => () => { fn(); setLayerMenu(null); };
        return (
          <Sheet title={l.name || "圖層"} onClose={() => setLayerMenu(null)}>
            <div className="grid grid-cols-2 gap-1.5 text-[13px]" data-testid="layer-menu">
              <Button variant="ghost" onClick={act(() => commit((s) => ({ ...s, layers: moveLayer(s.layers, l.layer_id, "forward") })))} data-op="forward">向前一層</Button>
              <Button variant="ghost" onClick={act(() => commit((s) => ({ ...s, layers: moveLayer(s.layers, l.layer_id, "backward") })))} data-op="backward">向後一層</Button>
              <Button variant="ghost" onClick={act(() => commit((s) => ({ ...s, layers: moveLayer(s.layers, l.layer_id, "front") })))} data-op="front">置頂</Button>
              <Button variant="ghost" onClick={act(() => commit((s) => ({ ...s, layers: moveLayer(s.layers, l.layer_id, "back") })))} data-op="back">置底</Button>
              <Button variant="ghost" onClick={act(() => duplicate(l.layer_id))} data-op="duplicate"><IconCopy />複製</Button>
              <Button variant="ghost" onClick={act(() => patchLayer(l.layer_id, { flip_x: !l.flip_x }))} data-op="flip-x">水平翻轉</Button>
              <Button variant="ghost" onClick={act(() => patchLayer(l.layer_id, { flip_y: !l.flip_y }))} data-op="flip-y">垂直翻轉</Button>
              <Button variant="ghost" onClick={act(() => patchLayer(l.layer_id, { locked: !l.locked }))} data-op="lock">{l.locked ? "解鎖" : "鎖定"}</Button>
              {l.layer_type === "garment" && <Button variant="ghost" onClick={act(() => patchLayer(l.layer_id, { ...slotFor(extra[l.layer_id]?.category), rotation: 0 }))}>重設位置</Button>}
              {l.layer_type === "studio_asset" && <Button variant="ghost" onClick={act(async () => { try { await patchStudioAsset(l.asset_id!, { in_library: true }); toast("已保存到我的素材庫"); } catch (e) { toast((e as Error).message, "err"); } })} data-op="to-library">保存到素材庫</Button>}
              {l.layer_type === "studio_asset" && <Button variant="ghost" onClick={act(async () => { const n = prompt("另存為衣櫃衣物：名稱", l.name || "自訂配件"); if (!n) return; try { const r = await versionToGarment(l.asset_version_id!, { name: n, category: "其他裝飾", variant: l.variant }); toast("已建立新的衣櫃衣物"); void r; } catch (e) { toast((e as Error).message, "err"); } })} data-op="to-garment">另存為衣櫃衣物</Button>}
              <Button variant="ghost" className="col-span-2 text-wine" onClick={act(() => removeLayer(l.layer_id))} data-op="remove"><IconTrash />移除圖層</Button>
            </div>
          </Sheet>
        );
      })()}
      {metaOpen && <Sheet title="名稱及備註" onClose={() => setMetaOpen(false)}><div className="space-y-2"><input value={name} onChange={(e) => setName(e.target.value)} className="field h-10 w-full rounded-full px-3 text-[16px]" placeholder="造型名稱" /><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="field w-full rounded-2xl px-3 py-2 text-[16px]" placeholder="備註" /><Button className="w-full" onClick={() => setMetaOpen(false)}>完成</Button></div></Sheet>}
      {exportOpen && <ExportSheet name={name} scene={scene} srcs={srcs} onClose={() => setExportOpen(false)} />}
    </div>
  );
}

function CanvasBtn({ label, onClick, disabled, pressed, children, testid }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: ReactNode; testid?: string }) {
  return <button type="button" aria-label={label} title={label} disabled={disabled} aria-pressed={pressed} onClick={onClick} data-testid={testid} className={`doll-tool grid h-9 w-9 place-items-center rounded-full text-[15px] disabled:opacity-40 ${pressed ? "doll-tool-on" : ""}`}>{children}</button>;
}

/** 已選圖層的快速調整：位置／遮罩／其他（透明度、旋轉、原圖／去背） */
function SelectedBar({ l, tool, setTool, maskMode, setMaskMode, brush, setBrush, compare, setCompare, onPatch, onCommitLive, getScene, onMenu, hasCutout, onVariant }: {
  l: Layer; tool: "select" | "hand" | "mask"; setTool: (t: "select" | "hand" | "mask") => void; maskMode: "hide" | "restore"; setMaskMode: (m: "hide" | "restore") => void; brush: number; setBrush: (n: number) => void; compare: boolean; setCompare: (b: boolean) => void;
  onPatch: (p: Partial<Layer>, live?: boolean) => void; onCommitLive: (start: Scene) => void; getScene: () => Scene; onMenu: () => void; hasCutout: boolean; onVariant: (v: "original" | "cutout") => void;
}) {
  const [sec, setSec] = useState<"pos" | "mask" | "more">(tool === "mask" ? "mask" : "pos");
  const start = useRef<Scene | null>(null);
  const live = (p: Partial<Layer>) => { if (!start.current) start.current = getScene(); onPatch(p, true); };
  const end = () => { if (start.current) { onCommitLive(start.current); start.current = null; } };
  return (
    <div className="mx-2 mb-1.5 shrink-0 rounded-2xl p-1.5 text-[12px] doll-tool" data-testid="studio-selected-bar">
      <div className="mb-1.5 flex items-center gap-1">
        {([["pos", "位置"], ["mask", "遮罩"], ["more", "其他"]] as const).map(([k, lbl]) => <button key={k} type="button" aria-pressed={sec === k} data-sec={k} onClick={() => { setSec(k); setTool(k === "mask" ? "mask" : "select"); }} className={`h-7 rounded-full px-3 ${sec === k ? "doll-tool-on" : ""}`}>{lbl}</button>)}
        <span className="min-w-0 flex-1 truncate px-1 text-right opacity-80">{l.name}</span>
        <button type="button" aria-label="圖層操作" onClick={onMenu} className="grid h-7 w-7 place-items-center rounded-full" data-testid="selected-more"><IconMore /></button>
      </div>
      {sec === "pos" && <div className="flex flex-wrap items-center gap-1">
        <button type="button" className="h-7 rounded-full px-2.5 doll-tool-on" onClick={() => onPatch({ w: l.w * 0.9, h: l.h * 0.9, x: l.x + l.w * 0.05, y: l.y + l.h * 0.05 })}>縮小</button>
        <button type="button" className="h-7 rounded-full px-2.5 doll-tool-on" onClick={() => onPatch({ w: l.w * 1.1, h: l.h * 1.1, x: l.x - l.w * 0.05, y: l.y - l.h * 0.05 })}>放大</button>
        <button type="button" className="h-7 rounded-full px-2.5 doll-tool-on" onClick={() => onPatch({ flip_x: !l.flip_x })}>⇋ 翻轉</button>
        <button type="button" className="h-7 rounded-full px-2.5 doll-tool-on" onClick={() => onPatch({ rotation: 0 })}>轉正</button>
        <button type="button" className="h-7 rounded-full px-2.5 doll-tool-on" aria-pressed={l.locked} onClick={() => onPatch({ locked: !l.locked })}><IconLock className="inline" /> {l.locked ? "已鎖定" : "鎖定"}</button>
      </div>}
      {sec === "mask" && <div className="space-y-1.5" data-testid="mask-tools">
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" aria-pressed={maskMode === "hide"} data-mask="hide" onClick={() => { setMaskMode("hide"); setTool("mask"); }} className={`h-7 rounded-full px-2.5 ${maskMode === "hide" ? "doll-tool-on" : ""}`}>隱藏筆刷</button>
          <button type="button" aria-pressed={maskMode === "restore"} data-mask="restore" onClick={() => { setMaskMode("restore"); setTool("mask"); }} className={`h-7 rounded-full px-2.5 ${maskMode === "restore" ? "doll-tool-on" : ""}`}>還原筆刷</button>
          <button type="button" className="h-7 rounded-full px-2.5" onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerLeave={() => setCompare(false)} aria-pressed={compare} data-testid="mask-compare">按住對比原圖</button>
          <button type="button" className="h-7 rounded-full px-2.5" disabled={!l.mask} onClick={() => onPatch({ mask: null })} data-testid="mask-reset">還原全部</button>
        </div>
        <label className="flex items-center gap-2">筆刷<input type="range" min={0.01} max={0.3} step={0.005} value={brush} onChange={(e) => setBrush(Number(e.target.value))} className="flex-1" /></label>
        <p className="opacity-80">{l.mask ? `已編輯 ${l.mask.strokes.length} 筆` : "在畫布上塗抹要隱藏的部分"}；遮罩只屬於這個圖層，不會修改衣櫃原圖。</p>
      </div>}
      {sec === "more" && <div className="space-y-1">
        <label className="flex items-center gap-2">透明度<input type="range" min={0.05} max={1} step={0.05} value={l.opacity} onChange={(e) => live({ opacity: Number(e.target.value) })} onPointerUp={end} onKeyUp={end} className="flex-1" data-testid="layer-opacity" /><span className="w-9 text-right">{Math.round(l.opacity * 100)}%</span></label>
        <label className="flex items-center gap-2">旋轉<input type="range" min={-180} max={180} step={1} value={l.rotation} onChange={(e) => live({ rotation: Number(e.target.value) })} onPointerUp={end} onKeyUp={end} className="flex-1" /><span className="w-9 text-right">{Math.round(l.rotation)}°</span></label>
        {l.layer_type === "studio_asset" && <div className="flex gap-1">{(["original", "cutout"] as const).map((v) => <button key={v} type="button" disabled={v === "cutout" && !hasCutout} aria-pressed={l.variant === v} data-variant={v} onClick={() => onVariant(v)} className={`h-7 rounded-full px-2.5 disabled:opacity-40 ${l.variant === v ? "doll-tool-on" : ""}`}>{v === "original" ? "原圖" : "去背圖"}</button>)}</div>}
      </div>}
    </div>
  );
}

/** 圖層列表：上方＝最前，背景永遠在最底（不在列表內） */
function LayersTab({ layers, srcs, extra, selected, onSelect, onReorder, onPatch, onMenu }: { layers: Layer[]; srcs: Record<string, string | null>; extra: Record<string, { missing?: boolean }>; selected: string | null; onSelect: (id: string) => void; onReorder: (ids: string[]) => void; onPatch: (id: string, p: Partial<Layer>) => void; onMenu: (id: string) => void }) {
  if (!layers.length) return <p className="py-6 text-center text-[12px] text-mauve">未有圖層。加入衣物或素材後，可以在這裡調整前後次序、隱藏、鎖定及複製。</p>;
  const items = toTopFirst(layers).map((l) => ({ ...l, id: l.layer_id }));
  const groups = new Map<string, number>(); for (const l of layers) if (l.group_id) groups.set(l.group_id, (groups.get(l.group_id) ?? 0) + 1);
  return (
    <div data-testid="layer-list">
      <p className="mb-1 text-[11px] text-mauve">上方＝最前。拖動 ☰ 調整次序；點選圖層可在畫布選取（不會改變次序）。</p>
      <SortableList items={items} onReorder={onReorder} render={(l, handle) => (
        <div className={`flex items-center gap-1.5 rounded-xl p-1 ${l.layer_id === selected ? "chip-on" : "chip"}`} data-layer={l.layer_id}>
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSelect(l.layer_id)}>
            <span className="checker relative block h-11 w-8 shrink-0 overflow-hidden rounded-lg">{srcs[l.layer_id] && <img src={srcs[l.layer_id]!} alt="" className="h-full w-full object-contain" loading="lazy" />}</span>
            <span className="min-w-0 flex-1 text-[12.5px]"><span className="block truncate">{l.name || "圖層"}</span><span className="block truncate text-[10.5px] opacity-70">{l.layer_type === "studio_asset" ? "素材" : l.layer_type === "garment_part" ? "套裝部件" : "衣物"}{l.group_id && (groups.get(l.group_id) ?? 0) > 1 ? "・同套裝" : ""}{l.mask ? "・遮罩" : ""}{extra[l.layer_id]?.missing ? "・缺少圖片" : ""}</span></span>
          </button>
          <button type="button" aria-label={l.hidden ? "顯示" : "隱藏"} aria-pressed={l.hidden} data-action="hide" onClick={() => onPatch(l.layer_id, { hidden: !l.hidden })} className="grid h-8 w-8 place-items-center">{l.hidden ? <IconEyeOff /> : <IconEye />}</button>
          <button type="button" aria-label={l.locked ? "解鎖" : "鎖定"} aria-pressed={l.locked} data-action="lock" onClick={() => onPatch(l.layer_id, { locked: !l.locked })} className={`grid h-8 w-8 place-items-center ${l.locked ? "" : "opacity-40"}`}><IconLock /></button>
          <button type="button" aria-label="更多" data-action="more" onClick={() => onMenu(l.layer_id)} className="grid h-8 w-7 place-items-center"><IconMore /></button>
          <DragHandle {...handle} />
        </div>
      )} />
    </div>
  );
}

type Part = { id: string; name: string; src: string | null };
function GarmentsTab({ onAdd, onPart, usedIds, tax }: { onAdd: (g: Garment, force?: boolean) => void; onPart: (g: Garment, p: Part) => void; usedIds: Set<string>; tax: ReturnType<typeof useTaxonomy> }) {
  const [all, setAll] = useState<Garment[] | null>(null);
  const [q, setQ] = useState(""), [cat, setCat] = useState(""), [sub, setSub] = useState(""), [fav, setFav] = useState(false), [recent, setRecent] = useState(false);
  const [cols, setCols] = useState(() => { try { return Number(localStorage.getItem("aw:studio-cols")) || 4; } catch { return 4; } });
  const [parts, setParts] = useState<{ g: Garment; list: Part[] } | null>(null);
  const [focus, setFocus] = useState<Garment | null>(null);
  useEffect(() => { loadFullList(new URLSearchParams("transparent=1")).then(setAll).catch((e) => { toast((e as Error).message, "err"); setAll([]); }); }, []);
  const recentIds = useMemo(() => { try { return JSON.parse(localStorage.getItem("aw:studio-recent") || "[]") as string[]; } catch { return []; } }, [recent]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    let out = (all ?? []).filter((g) => (!cat || g.category === cat) && (!sub || g.subcategory === sub) && (!fav || g.is_favorite) && (!kw || `${displayName(g)} ${g.brand ?? ""} ${g.subcategory ?? ""}`.toLowerCase().includes(kw)));
    if (recent) out = recentIds.map((id) => out.find((g) => g.id === id)).filter((g): g is Garment => !!g);
    return out;
  }, [all, q, cat, sub, fav, recent, recentIds]);
  const subs = useMemo(() => [...new Set((all ?? []).filter((g) => g.category === cat).map((g) => g.subcategory).filter(Boolean))] as string[], [all, cat]);
  async function openParts(g: Garment) {
    try { const r = await api<{ assets: { id: string; name: string; files: { id: string }[] }[] }>(`/api/doll/assets?kind=garment_part&garment_id=${g.id}`); setParts({ g, list: r.assets.map((a) => ({ id: a.id, name: a.name, src: a.files[0] ? `/api/doll/files/${a.files[0].id}` : null })) }); } catch (e) { toast((e as Error).message, "err"); }
  }
  const grid = { 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5" }[cols as 3 | 4 | 5] ?? "grid-cols-4";
  return (
    <div className="space-y-1.5" data-testid="garments-tab">
      <div className="flex gap-1.5">
        <div className="relative min-w-0 flex-1"><IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--aw-placeholder)]" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋名稱、品牌" className="field h-9 w-full rounded-full pl-9 pr-3 text-[16px]" data-testid="studio-search" /></div>
        <button type="button" aria-pressed={fav} onClick={() => setFav(!fav)} className={`icon-btn h-9 w-9 ${fav ? "icon-btn-on" : ""}`} aria-label="只看收藏"><IconHeart filled={fav} /></button>
        <button type="button" aria-pressed={recent} onClick={() => setRecent(!recent)} className={`h-9 shrink-0 rounded-full px-2.5 text-[12px] ${recent ? "chip-on" : "chip"}`}>最近</button>
        <button type="button" aria-label="每排數量" onClick={() => { const n = cols >= 5 ? 3 : cols + 1; setCols(n); try { localStorage.setItem("aw:studio-cols", String(n)); } catch { /* ignore */ } }} className="chip h-9 shrink-0 rounded-full px-2.5 text-[12px]">{cols} 欄</button>
      </div>
      <div className="scrollbar-none -mx-2 flex gap-1 overflow-x-auto px-2">{["", ...tax.categories.map((c) => c.name)].map((c) => <button key={c || "all"} type="button" aria-pressed={cat === c} onClick={() => { setCat(c); setSub(""); }} className={`h-7 shrink-0 rounded-full px-2.5 text-[12px] ${cat === c ? "chip-on" : "chip"}`}>{c || "全部"}</button>)}</div>
      {cat && subs.length > 0 && <div className="scrollbar-none -mx-2 flex gap-1 overflow-x-auto px-2">{["", ...subs].map((s) => <button key={s || "all"} type="button" aria-pressed={sub === s} onClick={() => setSub(s)} className={`h-6 shrink-0 rounded-full px-2 text-[11.5px] ${sub === s ? "chip-on" : "chip"}`}>{s || "全部"}</button>)}</div>}
      {!all ? <Spinner /> : !list.length ? <p className="py-5 text-center text-[12px] text-mauve">{all.length ? "沒有符合的衣物" : "衣櫃未有已去背的衣物（衣服配搭需要透明圖）"}</p> : (
        <div className={`grid ${grid} gap-1.5`}>
          {list.map((g) => (
            <div key={g.id} className="relative" data-studio-garment={g.id}>
              <button type="button" onClick={() => { if (usedIds.has(g.id)) setFocus(g); onAdd(g); }} className={`arch-base block aspect-[3/4] w-full overflow-hidden rounded-xl ${usedIds.has(g.id) ? "ring-2 ring-[var(--aw-focus)]" : ""}`} aria-label={`加入 ${displayName(g)}`}>
                {g.transparent_image_id && <img src={`/api/thumbnails/${g.transparent_image_id}`} alt="" loading="lazy" className="h-full w-full object-contain p-0.5" onError={(e) => { (e.currentTarget as HTMLImageElement).src = `/api/images/${g.transparent_image_id}`; }} />}
              </button>
              <p className="truncate text-center text-[10px] leading-tight">{displayName(g)}</p>
              {(g.category === "套裝" || g.category === "套裝部件") && <button type="button" onClick={() => void openParts(g)} className="chip absolute right-0.5 top-0.5 rounded-full px-1.5 text-[9.5px]" data-testid="studio-parts">部件</button>}
            </div>
          ))}
        </div>
      )}
      {focus && usedIds.has(focus.id) && <div className="flex items-center gap-2 rounded-xl bg-cream/5 p-2 text-[12px]" data-testid="studio-add-again"><span className="min-w-0 flex-1 truncate">「{displayName(focus)}」已在畫布上</span><button type="button" className="chip h-7 rounded-full px-2.5" onClick={() => { onAdd(focus, true); setFocus(null); }}>再加入一件</button><button type="button" className="h-7 px-1" onClick={() => setFocus(null)} aria-label="關閉">✕</button></div>}
      {parts && <Sheet title={`「${displayName(parts.g)}」的部件`} onClose={() => setParts(null)}>
        <div className="space-y-2" data-testid="studio-part-list">
          <Button variant="ghost" className="w-full" onClick={() => { onAdd(parts.g, true); setParts(null); }}>加入整套</Button>
          <div className="grid grid-cols-3 gap-2">{parts.list.map((p) => <button key={p.id} type="button" onClick={() => { onPart(parts.g, p); setParts(null); }} className="text-center text-[11px]" data-part={p.id}><span className="checker block aspect-[3/4] overflow-hidden rounded-xl">{p.src && <img src={p.src} alt="" className="h-full w-full object-contain" />}</span>{p.name}</button>)}</div>
          {!parts.list.length && <p className="text-[12px] text-mauve">這件套裝未有拆分的部件（可在角色換裝的衣服設定拆件）。</p>}
        </div>
      </Sheet>}
    </div>
  );
}

/** 素材分頁：從相簿／檔案／拍攝加入圖片，或從我的素材庫選擇。上傳到工作室不會成為衣櫃衣物 */
function AssetsTab({ onAdd }: { onAdd: (a: StudioAsset, variant: "original" | "cutout") => void }) {
  const [lib, setLib] = useState<StudioAsset[] | null>(null);
  const [kind, setKind] = useState<AssetKind | "">("");
  const [pending, setPending] = useState<File | null>(null);
  const load = useCallback(() => listStudioAssets(kind ? { kind } : {}).then(setLib).catch(() => setLib([])), [kind]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-2" data-testid="assets-tab">
      <div className="grid grid-cols-3 gap-1.5 text-[12px]">
        <label className="chip flex h-10 cursor-pointer items-center justify-center gap-1 rounded-2xl"><IconImage />相簿<input type="file" accept="image/*" className="hidden" data-testid="asset-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setPending(f); }} /></label>
        <label className="chip flex h-10 cursor-pointer items-center justify-center gap-1 rounded-2xl"><IconPlus />檔案<input type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setPending(f); }} /></label>
        <label className="chip flex h-10 cursor-pointer items-center justify-center gap-1 rounded-2xl"><IconCamera />拍攝<input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setPending(f); }} /></label>
      </div>
      <div className="flex items-center gap-1"><p className="flex-1 font-serif text-[13px] text-gold-soft">我的素材庫</p>
        <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)} className="field h-8 rounded-full px-2 text-[13px]"><option value="">全部</option>{Object.entries(ASSET_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      {!lib ? <Spinner /> : !lib.length ? <p className="py-3 text-center text-[12px] text-mauve">素材庫未有素材。上傳時選擇「保存到我的素材庫」即可重用。</p> : (
        <div className="grid grid-cols-4 gap-1.5" data-testid="asset-library">{lib.filter((a) => a.version).map((a) => <button key={a.id} type="button" onClick={() => onAdd(a, a.version!.has_cutout ? "cutout" : "original")} className="text-center text-[10px]" data-lib-asset={a.id}><span className="checker block aspect-square overflow-hidden rounded-xl"><img src={a.version!.thumb_url} alt="" className="h-full w-full object-contain" loading="lazy" /></span><span className="block truncate">{a.name}</span></button>)}</div>
      )}
      {pending && <AssetUploadSheet file={pending} onClose={() => setPending(null)} onDone={(a, v) => { setPending(null); onAdd(a, v); if (a.in_library) void load(); }} />}
    </div>
  );
}

/** 上傳素材：先顯示原圖 → 使用者按「去背」→ 處理進度 → 預覽 → 確認套用。失敗時保留原圖並可重試 */
export function AssetUploadSheet({ file, onClose, onDone, defaultKind = "decoration" }: { file: File; onClose: () => void; onDone: (a: StudioAsset, variant: "original" | "cutout") => void; defaultKind?: AssetKind }) {
  const [img, setImg] = useState<Awaited<ReturnType<typeof prepareImage>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<AssetKind>(defaultKind);
  const [name, setName] = useState(file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "素材");
  const [keep, setKeep] = useState<"outfit" | "library">("outfit");
  const [cut, setCut] = useState<{ state: "idle" | "running" | "done" | "failed"; url?: string; blob?: Blob; note?: string }>({ state: "idle" });
  const [show, setShow] = useState<"original" | "cutout">("original");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; prepareImage(file).then((r) => live && setImg(r)).catch((e) => live && setErr((e as Error).message)); return () => { live = false; }; }, [file]);
  async function runCut() {
    if (!img) return;
    setCut({ state: "running" });
    try { const r = await cutoutBlob(img.blob); setCut(r.ok ? { state: "done", url: r.url, blob: r.blob } : { state: "failed", note: r.note }); if (r.ok) setShow("cutout"); }
    catch (e) { setCut({ state: "failed", note: (e as Error).message }); }
  }
  async function confirm() {
    if (!img) return;
    setBusy(true);
    try {
      let a = await uploadStudioAsset(img, { kind, name, inLibrary: keep === "library" });
      let variant: "original" | "cutout" = "original";
      if (show === "cutout" && cut.blob) { const r = await saveCutout(a.version!.id, cut.blob); a = r; variant = "cutout"; }
      onDone(a, variant);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  }
  return (
    <Sheet title="加入圖片素材" onClose={onClose}>
      <div className="space-y-2.5 text-[12.5px]" data-testid="asset-upload" data-cut={cut.state}>
        {err ? <p role="alert" className="text-wine">{err}</p> : !img ? <Spinner /> : <>
          <div className="checker relative mx-auto aspect-square w-full max-w-[16rem] overflow-hidden rounded-2xl"><img src={show === "cutout" && cut.url ? cut.url : img.preview} alt="" className="h-full w-full object-contain" data-testid="asset-preview" data-show={show} /></div>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {img.hasAlpha ? <span className="text-mauve">已是透明圖片，不需要去背</span> : cut.state === "idle" ? <Button variant="ghost" onClick={() => void runCut()} data-testid="asset-cutout"><IconScissors />去背</Button>
              : cut.state === "running" ? <span className="text-mauve" role="status">去背處理中…</span>
              : cut.state === "failed" ? <><span className="text-wine" role="alert">去背失敗：{cut.note}（已保留原圖）</span><Button variant="ghost" onClick={() => void runCut()}>重試</Button></>
              : <>{(["original", "cutout"] as const).map((v) => <button key={v} type="button" aria-pressed={show === v} data-show-variant={v} onClick={() => setShow(v)} className={`h-8 rounded-full px-3 ${show === v ? "chip-on" : "chip"}`}>{v === "original" ? "原圖" : "去背圖"}</button>)}</>}
          </div>
          <label className="flex items-center gap-2"><span className="w-10 text-mauve">名稱</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="field h-9 flex-1 rounded-full px-3 text-[16px]" /></label>
          <div className="flex flex-wrap gap-1"><span className="w-10 self-center text-mauve">用途</span>{Object.entries(ASSET_KIND_LABEL).map(([k, l]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k as AssetKind)} className={`h-7 rounded-full px-2.5 ${kind === k ? "chip-on" : "chip"}`}>{l}</button>)}</div>
          <div className="seg" role="radiogroup" aria-label="保存方式">
            <button type="button" aria-selected={keep === "outfit"} onClick={() => setKeep("outfit")} data-keep="outfit">只用於目前造型</button>
            <button type="button" aria-selected={keep === "library"} onClick={() => setKeep("library")} data-keep="library">保存到我的素材庫</button>
          </div>
          <p className="text-[11px] text-mauve">素材不會加入衣櫃，不計入衣物數目、總價或穿著統計。需要成為正式衣物時，可在圖層「⋯」選擇「另存為衣櫃衣物」。</p>
          <Button className="w-full" disabled={busy || cut.state === "running"} onClick={() => void confirm()} data-testid="asset-confirm">{busy ? "上傳中…" : show === "cutout" ? "套用去背圖並加入" : "加入畫布"}</Button>
        </>}
      </div>
    </Sheet>
  );
}

/** 匯出：PNG、可選背景或真正透明、標準／高清解析度。所有圖片載入完成後才輸出 */
function ExportSheet({ name, scene, srcs, onClose }: { name: string; scene: Scene; srcs: Record<string, string | null>; onClose: () => void }) {
  const [withBg, setWithBg] = useState(scene.background?.type !== "transparent");
  const [scale, setScale] = useState<1 | 2>(1);
  const [state, setState] = useState<{ busy: boolean; msg?: string; err?: string }>({ busy: false });
  async function run() {
    setState({ busy: true, msg: "載入高清圖片…" });
    try {
      const W = CANVAS_W * scale, H = CANVAS_H * scale;
      const map = new Map<string, Img>();
      for (const l of scene.layers) {
        if (l.hidden) continue;
        const src = srcs[l.layer_id];
        if (!src) throw new Error(`「${l.name || "圖層"}」缺少圖片，未能匯出`);
        const img = await loadImage(src);
        map.set(l.layer_id, maskedCanvas(img, l.mask, Math.max(W, H)));
      }
      const bi = scene.background?.type === "image" && scene.background.image ? await loadImage(`/api/studio/versions/${scene.background.image.version_id}${scene.background.image.variant === "cutout" ? "?cutout=1" : ""}`) : null;
      setState({ busy: true, msg: "合成圖片…" });
      // 舊造型（沒有背景設定）沿用原本的奶油色底；選擇不包含背景＝真正透明
      const bg = withBg ? scene.background ?? { v: 1 as const, type: "solid" as const, color: "#fffaf6", color2: "#fffaf6", stops: [{ color: "#fffaf6", at: 0 }, { color: "#fffaf6", at: 1 }], angle: 0, size: 10, gap: 10, opacity: 1, image: null } : null;
      const c = composeScene(scene.layers, bg, { layer: (l) => map.get(l.layer_id), background: bi }, W, H, withBg);
      const blob = await toBlob(c, "image/png");
      const file = new File([blob], `${name.trim() || "穿搭"}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file] }); setState({ busy: false, msg: "已開啟分享面板" }); }
        catch (e) { setState({ busy: false, msg: (e as Error).name === "AbortError" ? "已取消分享（沒有儲存）" : undefined, err: (e as Error).name === "AbortError" ? undefined : (e as Error).message }); }
      } else {
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        setState({ busy: false, msg: "已下載 PNG" });
      }
    } catch (e) { setState({ busy: false, err: (e as Error).message }); }
  }
  return (
    <Sheet title="匯出圖片" onClose={onClose}>
      <div className="space-y-2.5 text-[13px]" data-testid="export-sheet">
        <div className="seg"><button type="button" aria-selected={withBg} onClick={() => setWithBg(true)} data-export-bg="1">包含背景</button><button type="button" aria-selected={!withBg} onClick={() => setWithBg(false)} data-export-bg="0">透明 PNG</button></div>
        <div className="seg"><button type="button" aria-selected={scale === 1} onClick={() => setScale(1)}>標準 1200×1600</button><button type="button" aria-selected={scale === 2} onClick={() => setScale(2)}>高清 2400×3200</button></div>
        <p className="text-[11px] text-mauve">編輯器的棋盤格只是透明提示，不會畫進圖片。</p>
        {state.msg && <p role="status" data-testid="export-msg">{state.msg}</p>}
        {state.err && <p role="alert" className="text-wine">{state.err}</p>}
        <Button className="w-full" disabled={state.busy} onClick={() => void run()} data-testid="export-run"><IconDownload />{state.busy ? "處理中…" : "匯出 PNG"}</Button>
      </div>
    </Sheet>
  );
}
