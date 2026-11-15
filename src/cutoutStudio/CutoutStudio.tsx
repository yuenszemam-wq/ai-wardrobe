/**
 * Cutout Studio：手動去背、自由選取及非破壞性圖片編輯（全螢幕，iPhone PWA 為主）。
 *
 * - 原圖像素只讀；所有工具只修改獨立遮罩（maskEngine）。輸出＝原圖 alpha × 遮罩。
 * - 顯示畫布與輸出解析度分離：遮罩及合成圖保持原圖解析度，畫面只按縮放比例繪製。
 * - 單指繪畫；雙指縮放／移動（第二隻手指放下時取消剛開始的筆畫，不會誤擦）；滑鼠滾輪縮放；Apple Pencil 使用時手指只會移動畫布。
 * - 不依賴任何 AI Binding 或外部服務。
 */
import { PointerEvent as RPointerEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Garment, GarmentImage } from "../api";
import { Button, toast } from "../components/ui";
import { IconRedo, IconUndo } from "../components/icons";
import {
  BrushStroke, MaskHistory, Rect, RgbaImage, SelectionAction, STUDIO_SAFE_PIXELS, applySelection, diffRect, fullRect,
  invertSelection, polygonSelection, rectEmpty, rectSelection, solidMask,
} from "./maskEngine";
import { HeavyClient } from "./heavyClient";
import type { EdgeOp } from "./maskOps";
import {
  Rendered, SaveSummary, StudioSource, downloadBlob, loadStudioSource, needsDownscale, renderCutout, saveAsNewGarment, saveAsStudioAsset, saveToGarment, verifyAlpha, decodeRgba,
} from "./studioIO";

type Tool = "auto" | "erase" | "restore" | "wand" | "lasso" | "polygon" | "rect" | "edge" | "move";
type Bg = "checker" | "white" | "black" | "pink" | "custom";

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: "auto", label: "自動" }, { id: "erase", label: "擦除" }, { id: "restore", label: "還原" }, { id: "wand", label: "魔術棒" },
  { id: "lasso", label: "套索" }, { id: "polygon", label: "多邊形" }, { id: "rect", label: "矩形" }, { id: "edge", label: "邊緣" }, { id: "move", label: "移動" },
];
const BGS: Array<{ id: Bg; label: string; color?: string }> = [
  { id: "checker", label: "透明格" }, { id: "white", label: "白", color: "#ffffff" }, { id: "black", label: "黑", color: "#000000" }, { id: "pink", label: "粉", color: "#f6c9d9" }, { id: "custom", label: "自訂" },
];

export type StudioTarget =
  | { kind: "garment"; garment: Garment; image: GarmentImage }
  | { kind: "blob"; blob: Blob; name: string };

interface View { s: number; tx: number; ty: number }

export function CutoutStudio({ target, onClose, onSaved, onExport, autoStart = false }: {
  target: StudioTarget;
  /** 載入後立即執行自動去背（結果轉換成可編輯遮罩） */
  autoStart?: boolean;
  onClose: () => void;
  /** 衣物模式：保存後通知（例如重新載入衣物） */
  onSaved?: (info: { garmentId: string; imageId: string; newGarment: boolean }) => void;
  /** 圖片模式：使用者確認去背圖 */
  onExport?: (blob: Blob) => void;
}) {
  const [phase, setPhase] = useState<"ask-size" | "loading" | "ready" | "error">(() => (target.kind === "garment" && needsDownscale(target.image) ? "ask-size" : "loading"));
  const [downscale, setDownscale] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [tool, setTool] = useState<Tool>(autoStart ? "auto" : "erase");
  const [brush, setBrush] = useState({ size: 40, hardness: 0.7, opacity: 1 });
  const [wand, setWand] = useState({ tolerance: 32, contiguous: true });
  const [edge, setEdge] = useState({ radius: 2 });
  const [bg, setBg] = useState<Bg>("checker");
  const [custom, setCustom] = useState("#c8e6c9");
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState("");
  const [hasSel, setHasSel] = useState(false);
  const [polyCount, setPolyCount] = useState(0);
  const [hist, setHist] = useState({ undo: false, redo: false, n: 0 });
  const [finish, setFinish] = useState<Rendered | null>(null);
  const [zoomPct, setZoomPct] = useState(100);

  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const S = useRef<{
    src: StudioSource | null; img: RgbaImage | null; mask: Uint8Array | null; initial: Uint8Array | null;
    comp: HTMLCanvasElement | null; srcCanvas: HTMLCanvasElement | null; history: MaskHistory | null; heavy: HeavyClient | null;
    buffers: { base: Uint8Array; cov: Uint8Array } | null;
    view: View; userZoomed: boolean; sel: Uint8Array | null; selOverlay: HTMLCanvasElement | null;
    lasso: number[] | null; poly: number[]; rectA: [number, number] | null; rectB: [number, number] | null; dragNode: number;
    stroke: BrushStroke | null; pointers: Map<number, { x: number; y: number; type: string }>; pinch: { d: number; cx: number; cy: number; view: View } | null;
    panFrom: { x: number; y: number; view: View } | null; cursor: { x: number; y: number } | null; penSeen: number; raf: number;
    tools: Set<string>; steps: number;
  }>({
    src: null, img: null, mask: null, initial: null, comp: null, srcCanvas: null, history: null, heavy: null, buffers: null,
    view: { s: 1, tx: 0, ty: 0 }, userZoomed: false, sel: null, selOverlay: null, lasso: null, poly: [], rectA: null, rectB: null, dragNode: -1,
    stroke: null, pointers: new Map(), pinch: null, panFrom: null, cursor: null, penSeen: 0, raf: 0, tools: new Set(), steps: 0,
  });
  const live = useRef({ tool, brush, bg, custom, compare });
  live.current = { tool, brush, bg, custom, compare };

  // ───────── 繪畫 ─────────
  const draw = useCallback(() => {
    const st = S.current, c = canvas.current;
    st.raf = 0;
    if (!c || !st.img || !st.comp) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const { s, tx, ty } = st.view;
    const { width: w, height: h } = st.img;
    const L = live.current;
    // 背景預覽（只畫在編輯器，不寫入輸出）
    const x0 = tx * dpr, y0 = ty * dpr, ww = w * s * dpr, hh = h * s * dpr;
    if (L.bg === "checker") {
      const cell = 10 * dpr;
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, ww, hh); ctx.clip();
      ctx.fillStyle = "#ffffff"; ctx.fillRect(x0, y0, ww, hh);
      ctx.fillStyle = "#d9d3dc";
      const sx = Math.max(0, Math.floor(-x0 / cell)), sy = Math.max(0, Math.floor(-y0 / cell));
      const ex = Math.ceil(Math.min(ww, c.width - x0) / cell), ey = Math.ceil(Math.min(hh, c.height - y0) / cell);
      for (let yy = sy; yy < ey; yy++) for (let xx = sx + ((yy + sx) % 2 ? 1 : 0); xx < ex; xx += 2) ctx.fillRect(x0 + xx * cell, y0 + yy * cell, cell, cell);
      ctx.restore();
    } else {
      ctx.fillStyle = L.bg === "custom" ? L.custom : BGS.find((b) => b.id === L.bg)!.color!;
      ctx.fillRect(x0, y0, ww, hh);
    }
    ctx.setTransform(dpr * s, 0, 0, dpr * s, x0, y0);
    ctx.imageSmoothingEnabled = s < 2;
    ctx.drawImage(L.compare && st.srcCanvas ? st.srcCanvas : st.comp, 0, 0);
    if (st.selOverlay && st.sel && !L.compare) ctx.drawImage(st.selOverlay, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toS = (x: number, y: number): [number, number] => [(x * s + tx) * dpr, (y * s + ty) * dpr];
    ctx.lineWidth = 1.5 * dpr;
    // 套索路徑
    const path = (pts: number[], close: boolean) => {
      if (pts.length < 4) return;
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 2) { const [a, b] = toS(pts[i], pts[i + 1]); if (i) ctx.lineTo(a, b); else ctx.moveTo(a, b); }
      if (close) ctx.closePath();
      ctx.strokeStyle = "#ffffff"; ctx.setLineDash([]); ctx.stroke();
      ctx.strokeStyle = "#b0306f"; ctx.setLineDash([5 * dpr, 4 * dpr]); ctx.stroke(); ctx.setLineDash([]);
    };
    if (st.lasso) path(st.lasso, false);
    if (st.poly.length) {
      path(st.poly, false);
      for (let i = 0; i < st.poly.length; i += 2) {
        const [a, b] = toS(st.poly[i], st.poly[i + 1]);
        ctx.beginPath(); ctx.arc(a, b, (i === 0 ? 7 : 5) * dpr, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? "#b0306f" : "#ffffff"; ctx.fill(); ctx.strokeStyle = "#b0306f"; ctx.stroke();
      }
    }
    if (st.rectA && st.rectB) {
      const [a, b] = toS(st.rectA[0], st.rectA[1]), [c2, d] = toS(st.rectB[0], st.rectB[1]);
      ctx.strokeStyle = "#b0306f"; ctx.setLineDash([5 * dpr, 4 * dpr]); ctx.strokeRect(Math.min(a, c2), Math.min(b, d), Math.abs(c2 - a), Math.abs(d - b)); ctx.setLineDash([]);
    }
    // 筆刷游標
    if (st.cursor && (L.tool === "erase" || L.tool === "restore")) {
      const [a, b] = toS(st.cursor.x, st.cursor.y);
      ctx.beginPath(); ctx.arc(a, b, Math.max(2, (L.brush.size / 2) * s * dpr), 0, Math.PI * 2);
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2.5 * dpr; ctx.stroke();
      ctx.strokeStyle = L.tool === "erase" ? "#b0306f" : "#2e7d32"; ctx.lineWidth = 1.2 * dpr; ctx.stroke();
    }
    c.dataset.zoom = s.toFixed(4);
  }, []);
  const redraw = useCallback(() => { if (!S.current.raf) S.current.raf = requestAnimationFrame(draw); }, [draw]);

  /** 把遮罩改動範圍重新合成到原解析度的合成圖 */
  const recompose = useCallback((r: Rect) => {
    const st = S.current;
    if (!st.img || !st.mask || !st.comp || rectEmpty(r)) return;
    const x0 = Math.max(0, Math.floor(r.x0)), y0 = Math.max(0, Math.floor(r.y0)), x1 = Math.min(st.img.width, Math.ceil(r.x1)), y1 = Math.min(st.img.height, Math.ceil(r.y1));
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, h = y1 - y0, W = st.img.width;
    const out = new ImageData(w, h);
    const sd = st.img.data, m = st.mask, od = out.data;
    for (let y = 0; y < h; y++) {
      let p = (y0 + y) * W + x0, o = y * w * 4;
      for (let x = 0; x < w; x++, p++, o += 4) {
        const i = p * 4;
        od[o] = sd[i]; od[o + 1] = sd[i + 1]; od[o + 2] = sd[i + 2]; od[o + 3] = (sd[i + 3] * m[p] + 127) / 255;
      }
    }
    st.comp.getContext("2d")!.putImageData(out, x0, y0);
    canvas.current && (canvas.current.dataset.maskVersion = String((Number(canvas.current.dataset.maskVersion) || 0) + 1));
    redraw();
  }, [redraw]);

  const syncHist = useCallback(() => { const h = S.current.history; if (h) setHist({ undo: h.canUndo, redo: h.canRedo, n: h.size }); }, []);

  const fit = useCallback(() => {
    const st = S.current, el = wrap.current;
    if (!st.img || !el) return;
    const cw = el.clientWidth, ch = el.clientHeight, pad = 12;
    const s = Math.min((cw - pad * 2) / st.img.width, (ch - pad * 2) / st.img.height);
    st.view = { s, tx: (cw - st.img.width * s) / 2, ty: (ch - st.img.height * s) / 2 };
    st.userZoomed = false;
    setZoomPct(Math.round(s * 100));
    redraw();
  }, [redraw]);

  const resizeCanvas = useCallback(() => {
    const el = wrap.current, c = canvas.current;
    if (!el || !c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(el.clientWidth * dpr)); c.height = Math.max(1, Math.round(el.clientHeight * dpr));
    c.style.width = el.clientWidth + "px"; c.style.height = el.clientHeight + "px";
    if (!S.current.userZoomed) fit(); else redraw();
  }, [fit, redraw]);

  // ───────── 載入 ─────────
  useEffect(() => {
    if (phase !== "loading") return;
    const ac = new AbortController();
    (async () => {
      try {
        let src: StudioSource;
        if (target.kind === "garment") src = await loadStudioSource(target.garment, target.image, { downscale, signal: ac.signal });
        else {
          const d = await decodeRgba(target.blob, STUDIO_SAFE_PIXELS);
          src = { imageId: "", garmentId: null, image: d.image, naturalWidth: d.naturalWidth, naturalHeight: d.naturalHeight, mask: solidMask(d.image.width, d.image.height), note: d.image.width < d.naturalWidth ? "圖片太大，已縮小處理" : "從原圖開始", sourceHasAlpha: false };
        }
        if (ac.signal.aborted) return;
        const st = S.current;
        const { width: w, height: h } = src.image;
        st.src = src; st.img = src.image; st.mask = src.mask; st.initial = src.mask.slice();
        st.history = new MaskHistory(w);
        st.buffers = { base: new Uint8Array(w * h), cov: new Uint8Array(w * h) };
        st.comp = document.createElement("canvas"); st.comp.width = w; st.comp.height = h;
        st.srcCanvas = document.createElement("canvas"); st.srcCanvas.width = w; st.srcCanvas.height = h;
        st.srcCanvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(src.image.data), w, h), 0, 0);
        st.heavy = new HeavyClient(src.image);
        setNote(src.note + (downscale ? `｜已降解析度處理（${w}×${h}，原圖 ${src.naturalWidth}×${src.naturalHeight}）` : ""));
        setPhase("ready");
        requestAnimationFrame(() => { resizeCanvas(); recompose(fullRect(w, h)); });
      } catch (e) {
        if (!ac.signal.aborted) { setErr((e as Error).message || "未能載入圖片"); setPhase("error"); }
      }
    })();
    return () => ac.abort();
  }, [phase, downscale, target, resizeCanvas, recompose]);

  // 釋放記憶體
  useEffect(() => () => {
    const st = S.current;
    st.heavy?.dispose();
    for (const c of [st.comp, st.srcCanvas, st.selOverlay]) if (c) c.width = c.height = 0;
    if (st.raf) cancelAnimationFrame(st.raf);
    st.img = null; st.mask = null; st.buffers = null; st.history = null; st.sel = null;
  }, []);

  useEffect(() => {
    const el = wrap.current; if (!el || phase !== "ready") return;
    const ro = new ResizeObserver(() => resizeCanvas());
    ro.observe(el);
    const onOrient = () => setTimeout(resizeCanvas, 200);
    window.addEventListener("orientationchange", onOrient);
    return () => { ro.disconnect(); window.removeEventListener("orientationchange", onOrient); };
  }, [phase, resizeCanvas]);

  useEffect(() => { redraw(); }, [bg, custom, compare, tool, brush.size, redraw]);

  // 防止 iOS 捲動／滑動返回：畫布上的 touch 一律不交給瀏覽器
  useEffect(() => {
    const c = canvas.current; if (!c) return;
    const stop = (e: TouchEvent) => e.preventDefault();
    c.addEventListener("touchstart", stop, { passive: false });
    c.addEventListener("touchmove", stop, { passive: false });
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = S.current; if (!st.img) return;
      const r = c.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => { c.removeEventListener("touchstart", stop); c.removeEventListener("touchmove", stop); c.removeEventListener("wheel", wheel); };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // 鍵盤：Ctrl/Cmd+Z、Shift+Z
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // ───────── 座標及縮放 ─────────
  const toImg = (clientX: number, clientY: number) => {
    const r = canvas.current!.getBoundingClientRect();
    const { s, tx, ty } = S.current.view;
    return { x: (clientX - r.left - tx) / s, y: (clientY - r.top - ty) / s, sx: clientX - r.left, sy: clientY - r.top };
  };
  function zoomAt(sx: number, sy: number, k: number, base?: View) {
    const st = S.current, v = base ?? st.view;
    const fitS = wrap.current && st.img ? Math.min(wrap.current.clientWidth / st.img.width, wrap.current.clientHeight / st.img.height) : 1;
    const s = Math.min(Math.max(v.s * k, fitS * 0.25), 32);
    const ix = (sx - v.tx) / v.s, iy = (sy - v.ty) / v.s;
    st.view = { s, tx: sx - ix * s, ty: sy - iy * s };
    st.userZoomed = true;
    setZoomPct(Math.round(s * 100));
    redraw();
  }

  // ───────── 歷史 ─────────
  const commit = (label: string, before: Uint8Array, rect?: Rect) => {
    const st = S.current; if (!st.mask || !st.img || !st.history) return;
    const r = rect ?? diffRect(before, st.mask, st.img.width, st.img.height);
    st.history.record(label, r, before, st.mask);
    st.steps++;
    syncHist();
  };
  function undo() { const st = S.current; if (!st.history || !st.mask) return; const r = st.history.undo(st.mask); if (r) { recompose(r); syncHist(); } }
  function redo() { const st = S.current; if (!st.history || !st.mask) return; const r = st.history.redo(st.mask); if (r) { recompose(r); syncHist(); } }

  // ───────── 選取 ─────────
  const setSelection = (sel: Uint8Array | null) => {
    const st = S.current;
    st.sel = sel;
    if (st.selOverlay) { st.selOverlay.width = st.selOverlay.height = 0; st.selOverlay = null; }
    if (sel && st.img) {
      const { width: w, height: h } = st.img;
      const k = Math.max(1, Math.ceil(Math.max(w, h) / 1200));
      const ow = Math.ceil(w / k), oh = Math.ceil(h / k);
      const ov = document.createElement("canvas"); ov.width = ow; ov.height = oh;
      const id = new ImageData(ow, oh);
      for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const v = sel[Math.min(h - 1, y * k) * w + Math.min(w - 1, x * k)];
        if (v) { const o = (y * ow + x) * 4; id.data[o] = 176; id.data[o + 1] = 48; id.data[o + 2] = 111; id.data[o + 3] = Math.round(v * 0.45); }
      }
      ov.getContext("2d")!.putImageData(id, 0, 0);
      st.selOverlay = ov;
    }
    setHasSel(!!sel);
    if (canvas.current) canvas.current.dataset.selection = sel ? "1" : "0";
    redraw();
  };
  const applySel = (action: SelectionAction) => {
    const st = S.current; if (!st.sel || !st.mask) return;
    const before = st.mask.slice();
    applySelection(st.mask, st.sel, action);
    st.tools.add(live.current.tool);
    commit(action === "keep" ? "保留選取" : action === "remove" ? "移除選取" : "還原選取", before);
    recompose(fullRect(st.img!.width, st.img!.height));
    setSelection(null);
  };
  const cancelSelection = () => { const st = S.current; st.lasso = null; st.poly = []; st.rectA = st.rectB = null; setPolyCount(0); setSelection(null); };
  const finishPolygon = () => {
    const st = S.current; if (!st.img || st.poly.length < 6) return;
    const sel = polygonSelection(st.img.width, st.img.height, st.poly);
    st.poly = []; setPolyCount(0);
    setSelection(sel);
  };

  // ───────── 昂貴運算 ─────────
  const heavy = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast((e as Error).message || "處理失敗", "err"); } finally { setBusy(""); }
  };
  const runAuto = () => heavy("自動去背中…", async () => {
    const st = S.current; if (!st.heavy || !st.mask) return;
    const r = await st.heavy.run({ op: "auto" });
    if (!r.applied || !r.mask.length) { toast(r.note || "未能自動去背", "err"); setNote(r.note || ""); return; }
    const before = st.mask.slice();
    st.mask.set(r.mask);
    st.tools.add("auto");
    commit("自動去背", before);
    recompose(fullRect(st.img!.width, st.img!.height));
    toast(`${r.note}；可再用擦除／還原修正`);
  });
  const runEdge = (kind: EdgeOp) => heavy("處理邊緣中…", async () => {
    const st = S.current; if (!st.heavy || !st.mask) return;
    const r = await st.heavy.run({ op: "edge", kind, radius: kind === "smooth" ? Math.max(1, edge.radius) : edge.radius, mask: st.mask });
    const before = st.mask.slice();
    st.mask.set(r.mask);
    st.tools.add("edge:" + kind);
    commit("邊緣", before);
    recompose(fullRect(st.img!.width, st.img!.height));
  });
  const autoDone = useRef(false);
  useEffect(() => { if (phase === "ready" && autoStart && !autoDone.current) { autoDone.current = true; void runAuto(); } }); // eslint-disable-line react-hooks/exhaustive-deps
  const resetMask = () => {
    const st = S.current; if (!st.mask || !st.initial) return;
    const before = st.mask.slice();
    st.mask.set(solidMask(st.img!.width, st.img!.height));
    commit("重設遮罩", before);
    recompose(fullRect(st.img!.width, st.img!.height));
  };
  const backToStart = () => {
    const st = S.current; if (!st.mask || !st.initial) return;
    const before = st.mask.slice();
    st.mask.set(st.initial);
    commit("回到開始時", before);
    recompose(fullRect(st.img!.width, st.img!.height));
  };

  // ───────── 指標事件 ─────────
  const endStroke = (keep: boolean) => {
    const st = S.current, s = st.stroke; if (!s) return;
    st.stroke = null;
    if (!keep) { recompose(s.revert()); return; }
    if (!rectEmpty(s.dirty)) {
      st.history!.record(s.opts.mode === "erase" ? "擦除" : "還原", s.dirty, s.base, st.mask!);
      st.steps++; st.tools.add(s.opts.mode);
      syncHist();
    }
  };
  const startPinch = () => {
    const st = S.current;
    const [a, b] = [...st.pointers.values()];
    st.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...st.view } };
  };
  const onDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    const st = S.current; if (!st.img || busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toImg(e.clientX, e.clientY);
    if (e.pointerType === "pen") st.penSeen = performance.now();
    st.pointers.set(e.pointerId, { x: p.sx, y: p.sy, type: e.pointerType });
    if (st.pointers.size >= 2) {
      // 第二隻手指：取消剛開始的筆畫／套索，改為縮放及移動
      endStroke(false); st.lasso = null; st.rectA = st.rectB = null; st.panFrom = null; st.dragNode = -1;
      startPinch(); redraw();
      return;
    }
    const t = live.current.tool;
    const palmTouch = e.pointerType === "touch" && performance.now() - st.penSeen < 3000; // 用 Apple Pencil 時，手指只移動畫布
    if (t === "move" || palmTouch || e.button === 1) { st.panFrom = { x: p.sx, y: p.sy, view: { ...st.view } }; return; }
    if (t === "erase" || t === "restore") {
      const b = live.current.brush;
      st.stroke = new BrushStroke(st.mask!, st.img.width, st.img.height, { radius: b.size / 2, hardness: b.hardness, opacity: b.opacity, mode: t }, st.buffers ?? undefined);
      st.cursor = { x: p.x, y: p.y };
      recompose(st.stroke.to(p.x, p.y));
      return;
    }
    if (t === "lasso") { setSelection(null); st.lasso = [p.x, p.y]; redraw(); return; }
    if (t === "rect") { setSelection(null); st.rectA = [p.x, p.y]; st.rectB = [p.x, p.y]; redraw(); return; }
    if (t === "polygon") {
      const hit = (r: number) => { for (let i = 0; i < st.poly.length; i += 2) if (Math.hypot((st.poly[i] - p.x) * st.view.s, (st.poly[i + 1] - p.y) * st.view.s) < r) return i / 2; return -1; };
      const n = hit(16);
      if (n === 0 && st.poly.length >= 6) { finishPolygon(); return; } // 點第一個節點：自動閉合
      if (n > 0) { st.dragNode = n; return; }
      setSelection(null);
      st.poly.push(p.x, p.y); setPolyCount(st.poly.length / 2); redraw();
      return;
    }
    if (t === "wand") {
      const x = p.x, y = p.y;
      if (x < 0 || y < 0 || x >= st.img.width || y >= st.img.height) return;
      void heavy("選取中…", async () => {
        const r = await st.heavy!.run({ op: "wand", x, y, tolerance: Math.round(wand.tolerance * 2.55), contiguous: wand.contiguous });
        setSelection(r.mask);
      });
    }
  };
  const onMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const st = S.current; if (!st.img) return;
    const p = toImg(e.clientX, e.clientY);
    if (st.pointers.has(e.pointerId)) st.pointers.set(e.pointerId, { x: p.sx, y: p.sy, type: e.pointerType });
    if (st.pinch && st.pointers.size >= 2) {
      const [a, b] = [...st.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const v = st.pinch.view;
      const base = { s: v.s, tx: v.tx + (cx - st.pinch.cx), ty: v.ty + (cy - st.pinch.cy) };
      zoomAt(cx, cy, d / st.pinch.d, base);
      return;
    }
    if (st.panFrom) {
      st.view = { ...st.panFrom.view, tx: st.panFrom.view.tx + p.sx - st.panFrom.x, ty: st.panFrom.view.ty + p.sy - st.panFrom.y };
      st.userZoomed = true; redraw(); return;
    }
    if (live.current.tool === "erase" || live.current.tool === "restore") { st.cursor = { x: p.x, y: p.y }; if (!st.stroke) redraw(); }
    if (st.stroke) {
      // 使用合併事件（coalesced）令快速筆畫更平滑
      const ev = e.nativeEvent as PointerEvent;
      const list = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
      if (list.length > 1) for (const ce of list) { const q = toImg(ce.clientX, ce.clientY); recompose(st.stroke.to(q.x, q.y)); }
      else recompose(st.stroke.to(p.x, p.y));
      return;
    }
    if (st.lasso) { const L = st.lasso; if (Math.hypot(L[L.length - 2] - p.x, L[L.length - 1] - p.y) * st.view.s > 2) { L.push(p.x, p.y); redraw(); } return; }
    if (st.rectA) { st.rectB = [p.x, p.y]; redraw(); return; }
    if (st.dragNode > 0) { st.poly[st.dragNode * 2] = p.x; st.poly[st.dragNode * 2 + 1] = p.y; redraw(); }
  };
  const onUp = (e: RPointerEvent<HTMLCanvasElement>, cancelled = false) => {
    const st = S.current;
    st.pointers.delete(e.pointerId);
    if (st.pinch) { if (st.pointers.size < 2) st.pinch = null; return; }
    if (st.panFrom) { st.panFrom = null; return; }
    if (st.stroke) { endStroke(!cancelled); return; }
    if (!st.img) return;
    if (st.lasso) {
      const pts = st.lasso; st.lasso = null;
      if (!cancelled && pts.length >= 6) setSelection(polygonSelection(st.img.width, st.img.height, pts)); else redraw();
      return;
    }
    if (st.rectA && st.rectB) {
      const [a, b] = [st.rectA, st.rectB]; st.rectA = st.rectB = null;
      if (!cancelled && Math.abs(a[0] - b[0]) > 2 && Math.abs(a[1] - b[1]) > 2) setSelection(rectSelection(st.img.width, st.img.height, a[0], a[1], b[0], b[1])); else redraw();
      return;
    }
    st.dragNode = -1;
  };

  // ───────── 完成及儲存 ─────────
  const summary = (): SaveSummary => ({ tools: [...S.current.tools].slice(0, 20), steps: S.current.steps, downscaled: downscale });
  const doFinish = () => heavy("輸出原解析度透明圖…", async () => {
    const st = S.current; if (!st.img || !st.mask) return;
    const r = await renderCutout(st.img, st.mask);
    setFinish(r);
  });

  const toolPanel = useMemo<ReactNode>(() => {
    const slider = (label: string, v: number, min: number, max: number, step: number, on: (n: number) => void, fmt?: (n: number) => string, testid?: string) => (
      <label className="flex items-center gap-2 text-[12px]"><span className="w-14 shrink-0">{label}</span>
        <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => on(Number(e.target.value))} className="flex-1" data-testid={testid} />
        <span className="w-12 text-right tabular-nums">{fmt ? fmt(v) : v}</span></label>
    );
    const chip = (label: string, on: () => void, testid?: string, primary = false, disabled = false) => (
      <button type="button" onClick={on} disabled={disabled} data-testid={testid} className={`h-9 shrink-0 rounded-full px-3 text-[12.5px] disabled:opacity-40 ${primary ? "chip-on" : "chip"}`}>{label}</button>
    );
    if (hasSel) return (
      <div className="flex flex-wrap gap-1.5" data-testid="selection-actions">
        {chip("只保留選取", () => applySel("keep"), "sel-keep", true)}
        {chip("移除選取", () => applySel("remove"), "sel-remove", true)}
        {chip("還原選取", () => applySel("restore"), "sel-restore")}
        {chip("反轉選取", () => setSelection(invertSelection(S.current.sel!)), "sel-invert")}
        {chip("取消選取", cancelSelection, "sel-cancel")}
      </div>
    );
    switch (tool) {
      case "erase": case "restore": return (
        <div className="space-y-1">
          {slider("大小", brush.size, 2, 400, 1, (n) => setBrush((b) => ({ ...b, size: n })), (n) => `${n}px`, "brush-size")}
          {slider("硬度", brush.hardness, 0, 1, 0.05, (n) => setBrush((b) => ({ ...b, hardness: n })), (n) => `${Math.round(n * 100)}%`, "brush-hardness")}
          {slider("透明度", brush.opacity, 0.05, 1, 0.05, (n) => setBrush((b) => ({ ...b, opacity: n })), (n) => `${Math.round(n * 100)}%`, "brush-opacity")}
          <p className="text-[11px] text-mauve">{tool === "restore" ? "還原筆刷從真正原圖恢復已移除的部分。" : "大小以原圖像素計算；硬度越低邊緣越柔和。"}雙指縮放／移動不會誤擦。</p>
        </div>
      );
      case "wand": return (
        <div className="space-y-1">
          {slider("容差", wand.tolerance, 0, 100, 1, (n) => setWand((w) => ({ ...w, tolerance: n })), undefined, "wand-tolerance")}
          <div className="flex gap-1.5">
            {chip("僅相連區域", () => setWand((w) => ({ ...w, contiguous: true })), "wand-contiguous", wand.contiguous)}
            {chip("全圖相近顏色", () => setWand((w) => ({ ...w, contiguous: false })), "wand-global", !wand.contiguous)}
          </div>
          <p className="text-[11px] text-mauve">點擊圖片選取相近顏色；先顯示選取範圍，確認後才套用。</p>
        </div>
      );
      case "lasso": return <p className="text-[12px] text-mauve">用手指沿衣物邊緣圈出範圍，放開後選擇保留或移除。</p>;
      case "rect": return <p className="text-[12px] text-mauve">拖動框選範圍，放開後選擇保留、移除或反轉。</p>;
      case "polygon": return (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-1.5">
            {chip("刪除最後節點", () => { S.current.poly.splice(-2, 2); setPolyCount(S.current.poly.length / 2); redraw(); }, "poly-undo", false, polyCount === 0)}
            {chip("完成（閉合）", finishPolygon, "poly-close", true, polyCount < 3)}
            {chip("清除", cancelSelection, undefined, false, polyCount === 0)}
          </div>
          <p className="text-[11px] text-mauve">逐點點擊衣物邊界（{polyCount} 個節點）；拖動節點可移動；點第一個節點自動閉合。</p>
        </div>
      );
      case "edge": return (
        <div className="space-y-1">
          {slider("範圍", edge.radius, 1, 20, 1, (n) => setEdge({ radius: n }), (n) => `${n}px`, "edge-radius")}
          <div className="scrollbar-none flex gap-1.5 overflow-x-auto">
            {chip("柔化", () => void runEdge("feather"), "edge-feather")}
            {chip("擴張", () => void runEdge("expand"), "edge-expand")}
            {chip("收縮", () => void runEdge("contract"), "edge-contract")}
            {chip("平滑", () => void runEdge("smooth"), "edge-smooth")}
            {chip("白邊清理", () => void runEdge("defringe-white"), "edge-white")}
            {chip("色邊清理", () => void runEdge("defringe-color"), "edge-color")}
          </div>
          <p className="text-[11px] text-mauve">只調整遮罩，不改動衣物顏色或細節；內部半透明薄紗會保留。每次套用可復原。</p>
        </div>
      );
      case "auto": return (
        <div className="space-y-1">
          <div className="flex flex-wrap gap-1.5">
            {chip("執行自動去背", () => void runAuto(), "auto-run", true)}
            {chip("回到開始時", backToStart, "auto-start")}
            {chip("完全重設遮罩", resetMask, "mask-reset")}
          </div>
          <p className="text-[11px] text-mauve">移除純色背景及假透明棋盤格；結果會變成可編輯遮罩，可繼續擦除或還原。複雜背景請用套索或魔術棒。</p>
        </div>
      );
      default: return <p className="text-[12px] text-mauve">單指拖動畫布；雙指縮放（電腦可用滾輪）。</p>;
    }
  }, [tool, brush, wand, edge, hasSel, polyCount]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-[#1d1720] text-[#f6eef4]" style={{ overscrollBehavior: "contain", paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }} data-testid="cutout-studio">
      {/* 頂部 */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button type="button" onClick={onClose} className="h-10 rounded-full px-3 text-[14px]" data-testid="studio-cancel">取消</button>
        <div className="flex-1" />
        <button type="button" aria-label="復原" disabled={!hist.undo} onClick={undo} className="grid h-10 w-10 place-items-center rounded-full disabled:opacity-30" data-testid="studio-undo"><IconUndo /></button>
        <button type="button" aria-label="重做" disabled={!hist.redo} onClick={redo} className="grid h-10 w-10 place-items-center rounded-full disabled:opacity-30" data-testid="studio-redo"><IconRedo /></button>
        <button type="button" aria-pressed={compare} onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerLeave={() => setCompare(false)} onClick={(e) => e.preventDefault()} className={`h-10 rounded-full px-3 text-[13px] ${compare ? "bg-white/20" : ""}`} data-testid="studio-compare">按住對比</button>
        <div className="flex-1" />
        <button type="button" disabled={phase !== "ready" || !!busy} onClick={() => void doFinish()} className="h-10 rounded-full bg-[#b0306f] px-4 text-[14px] font-semibold text-white disabled:opacity-40" data-testid="studio-done">完成</button>
      </div>

      {/* 畫布 */}
      <div ref={wrap} className="relative min-h-0 flex-1 overflow-hidden">
        {phase === "ask-size" && target.kind === "garment" && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-[14px]" data-testid="studio-size-ask">
            <div className="max-w-sm space-y-3">
              <p>這張圖片有 {target.image.width}×{target.image.height}（{(target.image.width * target.image.height / 1e6).toFixed(1)} MP），超過手機安全編輯尺寸（{STUDIO_SAFE_PIXELS / 1e6} MP），可能令 iPhone 記憶體不足。</p>
              <p className="text-[12px] opacity-80">降解析度處理只用於這次編輯；輸出圖片亦會較小，原圖不受影響。</p>
              <div className="flex justify-center gap-2">
                <Button onClick={() => { setDownscale(true); setPhase("loading"); }} data-testid="studio-downscale">降解析度編輯</Button>
                <Button variant="ghost" onClick={() => { setDownscale(false); setPhase("loading"); }}>仍用原解析度</Button>
              </div>
            </div>
          </div>
        )}
        {phase === "loading" && <div className="absolute inset-0 grid place-items-center text-[14px]" role="status">載入原圖中…</div>}
        {phase === "error" && <div className="absolute inset-0 grid place-items-center p-6 text-center text-[14px]" role="alert">{err}</div>}
        <canvas ref={canvas} className="absolute inset-0 block" style={{ touchAction: "none", visibility: phase === "ready" ? "visible" : "hidden", cursor: tool === "move" ? "grab" : "crosshair" }} data-testid="studio-canvas"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={(e) => onUp(e)} onPointerCancel={(e) => onUp(e, true)}
          onPointerLeave={() => { S.current.cursor = null; redraw(); }} />
        {busy && <div className="pointer-events-none absolute inset-x-0 top-2 text-center"><span className="rounded-full bg-black/60 px-3 py-1 text-[12px]" role="status">{busy}</span></div>}
        {phase === "ready" && (
          <div className="absolute bottom-2 left-2 flex items-center gap-1 text-[11px]">
            <button type="button" onClick={fit} className="rounded-full bg-black/50 px-2.5 py-1" data-testid="studio-fit">{zoomPct}%｜符合畫面</button>
            <span className="rounded-full bg-black/50 px-2.5 py-1" data-testid="studio-history">{hist.n} 步</span>
          </div>
        )}
        {phase === "ready" && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-full bg-black/50 px-1.5 py-1" data-testid="studio-bg">
            {BGS.map((b) => (
              <button key={b.id} type="button" aria-label={`背景：${b.label}`} aria-pressed={bg === b.id} onClick={() => setBg(b.id)} data-bg={b.id}
                className={`h-6 w-6 rounded-full border ${bg === b.id ? "border-white border-2" : "border-white/40"} ${b.id === "checker" ? "checker" : ""}`}
                style={b.color ? { background: b.color } : b.id === "custom" ? { background: custom } : undefined} />
            ))}
            {bg === "custom" && <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="自訂背景顏色" className="h-6 w-6" />}
          </div>
        )}
      </div>
      {note && phase === "ready" && <p className="px-3 pt-1 text-[11px] opacity-75" data-testid="studio-note">{note}</p>}

      {/* 工具設定 */}
      <div className="px-3 pb-1 pt-2 text-[#f6eef4] [&_.text-mauve]:text-[#d8c4d2]" data-testid="studio-panel">{phase === "ready" && toolPanel}</div>
      {/* 底部工具列 */}
      <div className="scrollbar-none flex gap-1 overflow-x-auto px-2 pb-2 pt-1" role="toolbar" aria-label="去背工具">
        {TOOLS.map((t) => (
          <button key={t.id} type="button" aria-pressed={tool === t.id} disabled={phase !== "ready"} data-tool={t.id}
            onClick={() => { if (t.id !== tool) { cancelSelection(); setTool(t.id); } }}
            className={`h-11 min-w-[3.4rem] shrink-0 rounded-2xl px-2 text-[12.5px] ${tool === t.id ? "bg-[#b0306f] text-white" : "bg-white/10"}`}>{t.label}</button>
        ))}
      </div>

      {finish && (
        <FinishSheet r={finish} target={target} source={S.current.src!} summary={summary()}
          onBack={() => setFinish(null)}
          onExport={onExport}
          onSaved={(info) => {
            if (info.newGarment) {
              // 另存為新衣物後返回同一張原圖，遮罩回到開始狀態，繼續選取下一件
              setFinish(null);
              const st = S.current;
              if (st.mask && st.initial && st.img) { const before = st.mask.slice(); st.mask.set(st.initial); commit("另存後重設", before); recompose(fullRect(st.img.width, st.img.height)); }
              onSaved?.(info);
              return;
            }
            onSaved?.(info);
            onClose();
          }} />
      )}
    </div>
  );
}

function FinishSheet({ r, target, source, summary, onBack, onSaved, onExport }: {
  r: Rendered; target: StudioTarget; source: StudioSource; summary: SaveSummary;
  onBack: () => void; onSaved: (info: { garmentId: string; imageId: string; newGarment: boolean }) => void; onExport?: (blob: Blob) => void;
}) {
  const url = useMemo(() => URL.createObjectURL(r.blob), [r.blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [srcUrl, setSrcUrl] = useState("");
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const g = target.kind === "garment" ? target.garment : null;
  const hasProcessed = !!g && (g.images || []).some((i) => i.image_type === "processed");
  const [primary, setPrimary] = useState(!hasProcessed);
  const [newName, setNewName] = useState(g ? `${g.name || "衣物"}（拆出）` : "");
  const [assetName, setAssetName] = useState(g ? `${g.name || "素材"} 去背` : target.kind === "blob" ? target.name : "去背素材");
  const problem = verifyAlpha(r);
  useEffect(() => {
    if (!compare || srcUrl) return;
    const c = document.createElement("canvas");
    c.width = source.image.width; c.height = source.image.height;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(source.image.data), c.width, c.height), 0, 0);
    c.toBlob((b) => { if (b) setSrcUrl(URL.createObjectURL(b)); c.width = c.height = 0; }, "image/jpeg", 0.85);
  }, [compare, srcUrl, source]);
  useEffect(() => () => { if (srcUrl) URL.revokeObjectURL(srcUrl); }, [srcUrl]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(""); try { await fn(); } catch (e) { setErr((e as Error).message || "保存失敗"); } finally { setBusy(false); } };
  const fileName = `${(g?.name || (target.kind === "blob" ? target.name : "cutout")).replace(/[\\/:*?"<>|]/g, "_")}-cutout.png`;
  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-[#1d1720]/95 p-3 text-[#f6eef4]" data-testid="studio-finish" style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))", paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
      <div className="flex items-center"><button type="button" onClick={onBack} disabled={busy} className="h-10 px-2 text-[14px]" data-testid="finish-back">‹ 繼續編輯</button><div className="flex-1" /><span className="text-[12px] opacity-75">{r.width}×{r.height}｜PNG {(r.blob.size / 1024 / 1024).toFixed(2)} MB</span></div>
      <div className="checker relative mx-auto my-2 min-h-0 w-full max-w-md flex-1 overflow-hidden rounded-2xl">
        <img src={compare && srcUrl ? srcUrl : url} alt={compare ? "原圖" : "透明去背結果"} className="absolute inset-0 h-full w-full object-contain" data-testid="finish-preview" data-transparent={r.transparent} data-semi={r.semi} />
      </div>
      <div className="mx-auto w-full max-w-md space-y-2 text-[13px]">
        <div className="flex items-center justify-between text-[12px]">
          <span data-testid="finish-alpha">{problem ? <span className="text-[#ffb4c8]">{problem}</span> : `透明像素 ${r.transparent.toLocaleString()}｜半透明 ${r.semi.toLocaleString()}`}</span>
          <button type="button" onClick={() => setCompare((v) => !v)} className="rounded-full bg-white/10 px-3 py-1" data-testid="finish-compare">{compare ? "看去背圖" : "與原圖比較"}</button>
        </div>
        {target.kind === "garment" && g && (
          <>
            <div className="rounded-2xl bg-white/5 p-2">
              <label className="flex items-center gap-2 text-[12.5px]"><input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} data-testid="finish-primary" />設為主要衣物圖片</label>
              <p className="text-[11px] opacity-70">原圖永遠保留。已保存的穿搭若固定了圖片版本，會繼續使用原本的圖片。</p>
              <Button className="mt-1 w-full" disabled={busy || !!problem} data-testid="finish-save" onClick={() => void run(async () => {
                const res = await saveToGarment(g, source, r, primary, summary);
                toast(res.deduplicated ? "已有相同的去背圖" : `已保存去背圖${res.note ? `（${res.note}）` : ""}`);
                onSaved({ garmentId: g.id, imageId: res.id, newGarment: false });
              })}>{busy ? "保存中…" : "儲存為此衣物的去背圖"}</Button>
            </div>
            <div className="rounded-2xl bg-white/5 p-2">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} className="w-full rounded-xl bg-white/10 px-3 py-2 text-[13px]" aria-label="新衣物名稱" data-testid="finish-new-name" />
              <Button variant="ghost" className="mt-1 w-full" disabled={busy || !!problem || !newName.trim()} data-testid="finish-new" onClick={() => void run(async () => {
                const res = await saveAsNewGarment(newName.trim(), source, r, summary);
                toast(`已另存為新衣物（待整理）${res.note ? `｜${res.note}` : ""}；可繼續選取下一件`);
                onSaved({ garmentId: res.garmentId, imageId: res.id, newGarment: true });
              })}>另存為新衣物（原圖不重複儲存）</Button>
            </div>
          </>
        )}
        {target.kind === "blob" && onExport && <Button className="w-full" disabled={!!problem} data-testid="finish-use" onClick={() => onExport(r.blob)}>使用此去背圖</Button>}
        <div className="flex gap-2">
          {target.kind === "garment" && (
            <div className="flex flex-1 gap-1">
              <input value={assetName} onChange={(e) => setAssetName(e.target.value)} maxLength={60} className="min-w-0 flex-1 rounded-xl bg-white/10 px-2 text-[12px]" aria-label="素材名稱" />
              <button type="button" disabled={busy || !!problem || !assetName.trim()} className="chip h-9 shrink-0 rounded-full px-3 text-[12px] disabled:opacity-40" data-testid="finish-asset" onClick={() => void run(async () => { await saveAsStudioAsset(assetName.trim(), r); toast("已另存為換裝素材（素材庫）"); })}>另存換裝素材</button>
            </div>
          )}
          <button type="button" className="chip h-9 shrink-0 rounded-full px-3 text-[12px]" data-testid="finish-download" onClick={() => downloadBlob(r.blob, fileName)}>下載 PNG</button>
        </div>
        {err && <p role="alert" className="text-[12px] text-[#ffb4c8]">{err}</p>}
      </div>
    </div>
  );
}
