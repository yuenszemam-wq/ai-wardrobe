// 套裝拆件編輯器：在套裝原圖上選出部件（袖套、頸飾、頭飾…），保存後可以獨立穿著。
// 原圖不會被修改：每個部件只保存一個低解像度的選取遮罩及範圍；亦可為部件另外上傳補完的透明圖。
// 單指＝目前工具（筆刷、擦除、方形、圈選、點選部件）；雙指＝縮放及移動畫面（正在畫的一筆會作廢）。
import { PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { ATTACHABLE_BONES, Piece, SLOT_LABEL, Slot, defaultOpts } from "../../shared/doll";
import { BONE_LABEL, refUrl } from "../../shared/avatarV2";
import { pieceBone } from "./model";
import { IconClose, IconPlus, IconTrash } from "../components/icons";
import { toast } from "../components/ui";
import { loadImage } from "./content";
import { MaskBuf, alphaOf, emptyMask, findComponents, guessPiece, maskBox, maskFromDataURL, maskToDataURL, newPieceId } from "./pieces";
import { pill } from "./panels";

import { readDraft, writeDraft, clearDraft } from "./drafts";

type Tool = "pick" | "brush" | "erase" | "rect" | "lasso";
/** keep＝部件的穿著設定（位置、網格、穿著遮罩、骨架、基準姿勢、狀態）：拆件編輯不會改動，保存時原樣保留 */
interface Edit { id: string; name: string; slot: Slot; mask: MaskBuf | null; file: string | null; rest: boolean; keep: Omit<Piece, "id" | "name" | "slot" | "box" | "mask" | "file" | "rest"> }
/** 預覽：mark＝原圖加顏色標記；piece＝只看目前部件；all＝所有已標記部件；free＝尚未分配的衣物區域 */
type Preview = "mark" | "piece" | "all" | "free";
const PREVIEWS: [Preview, string][] = [["mark", "原圖＋標記"], ["piece", "目前部件"], ["all", "所有部件"], ["free", "未分配"]];
const keepOf = (p: Piece): Edit["keep"] => { const { id: _i, name: _n, slot: _s, box: _b, mask: _m, file: _f, rest: _r, ...keep } = p; return keep; };
const COLORS = ["#ff4f9a", "#2dbeff", "#ffc23d", "#7ee07a", "#c08bff", "#ff8a3d", "#3de0d0", "#ff5d5d", "#9aa7ff", "#e6e65c", "#ff9ad5", "#5dd39e", "#d9a066", "#7fb2ff", "#ffb3b3", "#b3ffb3"];
const SLOTS: Slot[] = ["dress", "top", "skirt", "outer", "accessory", "headwear", "socks", "shoes", "bag", "petticoat", "pants", "set"];
const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

export function SplitEditor({ name, imageRef, pieces, busy, onSave, onClose, onUpload }: {
  name: string; imageRef: string; pieces: Piece[]; busy: boolean;
  onSave: (pieces: Piece[]) => Promise<boolean>; onClose: () => void;
  /** 為部件上傳補完的透明圖，回傳圖片參照 */
  onUpload: (file: File, label: string) => Promise<string | null>;
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [alpha, setAlpha] = useState<MaskBuf | null>(null);
  const [list, setList] = useState<Edit[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [size, setSize] = useState(18);
  const [rev, setRev] = useState(0);
  const [cam, setCam] = useState({ z: 1, x: 0, y: 0 });
  const [preview, setPreview] = useState<Preview>("mark");
  /** 部件縮圖（遮罩解像度，停筆後才更新） */
  const [thumbs, setThumbs] = useState<Map<string, string>>(new Map());
  const [fileImgs, setFileImgs] = useState<Map<string, HTMLImageElement>>(new Map());
  const [drawing, setDrawing] = useState<{ kind: "rect" | "lasso"; pts: [number, number][] } | null>(null);
  const wrap = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const undo = useRef<{ id: string; data: Uint8Array | null }[]>([]);

  const recoveryKey = "split:" + imageRef;
  const [recoveryReady, setRecoveryReady] = useState(false);
  const initial = useRef<Edit[] | null>(null);
  const pendingWrite = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (!recoveryReady || list === initial.current && rev === 0) return;
    const timer = window.setTimeout(() => {
      pendingWrite.current = pendingWrite.current.catch(() => undefined).then(() => writeDraft(recoveryKey, { list, cur })).catch(() => toast("拆件草稿未能保存，請手動保存", "err"));
    }, 500);
    return () => clearTimeout(timer);
  }, [list, cur, rev, recoveryReady, recoveryKey]);

  // 讀取原圖及已保存的部件
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const a = await alphaOf(imageRef);
        if (off) return;
        const edits: Edit[] = [];
        for (const p of pieces) edits.push({ id: p.id, name: p.name, slot: p.slot, mask: p.mask ? await maskFromDataURL(p.mask, a.alpha.w, a.alpha.h) : null, file: p.file ?? null, rest: !!p.rest, keep: keepOf(p) });
        if (off) return;
        const saved = await readDraft<{ list: Edit[]; cur: string | null }>(recoveryKey).catch(() => null);
        if (off) return;
        const restore = saved && confirm("發現未保存的套裝拆件，是否繼續？");
        if (saved && !restore) await clearDraft(recoveryKey);
        const loaded = restore ? saved.list : edits;
        initial.current = restore ? null : loaded;
        setImg(a.img); setAlpha(a.alpha); setList(loaded); setCur(restore ? saved.cur : edits.find((e) => !e.rest)?.id ?? null); setRecoveryReady(true);
      } catch (e) { toast((e as Error).message, "err"); }
    })();
    return () => { off = true; };
  }, [imageRef]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setBox({ w: r.width, h: r.height }); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 圖片座標（遮罩格）→ 螢幕
  const view = useMemo(() => {
    if (!alpha || !box.w) return null;
    const base = Math.min((box.w - 16) / alpha.w, (box.h - 16) / alpha.h);
    const k = base * cam.z;
    return { k, ox: box.w / 2 - (alpha.w / 2) * k + cam.x, oy: box.h / 2 - (alpha.h / 2) * k + cam.y };
  }, [alpha, box, cam]);
  const colorOf = (id: string) => COLORS[Math.max(0, list.findIndex((e) => e.id === id)) % COLORS.length];

  // 繪畫：原圖＋各部件的半透明顏色（目前部件較深），完整原圖一直可見
  useEffect(() => {
    const c = canvas.current;
    if (!c || !img || !alpha || !view) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(box.w * dpr); c.height = Math.round(box.h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    const W = alpha.w * view.k, H = alpha.h * view.k;
    ctx.fillStyle = "#f4eef2"; ctx.fillRect(view.ox, view.oy, W, H);
    ctx.imageSmoothingQuality = "high";
    if (preview !== "mark") {
      // 預覽最終拆件效果：只畫選中的像素（遮罩解像度柔化放大）
      const cur0 = list.find((e) => e.id === cur);
      if (preview === "piece" && cur0?.file) {
        const fi = fileImgs.get(cur0.file);
        if (fi) { const k = Math.min(W / fi.naturalWidth, H / fi.naturalHeight); ctx.drawImage(fi, view.ox + (W - fi.naturalWidth * k) / 2, view.oy + (H - fi.naturalHeight * k) / 2, fi.naturalWidth * k, fi.naturalHeight * k); }
      } else {
        const sel = new Uint8Array(alpha.w * alpha.h);
        const others = list.filter((e) => e.mask && !e.rest && !e.file);
        const any = (i: number) => others.some((e) => e.mask!.data[i] > 24);
        for (let i = 0; i < sel.length; i++) {
          if (!alpha.data[i]) continue;
          if (preview === "all") sel[i] = any(i) ? 255 : 0;
          else if (preview === "free") sel[i] = any(i) ? 0 : 255;
          else if (cur0?.rest) sel[i] = others.some((e) => e.id !== cur0.id && e.mask!.data[i] > 24) ? 0 : 255;
          else sel[i] = cur0?.mask ? cur0.mask.data[i] : 0;
        }
        const t = document.createElement("canvas");
        t.width = alpha.w; t.height = alpha.h;
        const d = new ImageData(alpha.w, alpha.h);
        for (let i = 0; i < sel.length; i++) { d.data[i * 4 + 3] = sel[i]; }
        t.getContext("2d")!.putImageData(d, 0, 0);
        const full = document.createElement("canvas");
        // 預覽畫布不超過遮罩解像度的兩倍（放大畫面時不會建立巨大的畫布）
        full.width = Math.max(1, Math.round(Math.min(W, alpha.w * 2))); full.height = Math.max(1, Math.round(Math.min(H, alpha.h * 2)));
        const fx = full.getContext("2d")!;
        fx.imageSmoothingQuality = "high";
        fx.drawImage(img, 0, 0, full.width, full.height);
        fx.globalCompositeOperation = "destination-in";
        fx.imageSmoothingEnabled = true;
        fx.drawImage(t, 0, 0, full.width, full.height);
        ctx.globalAlpha = 0.12; ctx.drawImage(img, view.ox, view.oy, W, H); ctx.globalAlpha = 1;
        ctx.drawImage(full, view.ox, view.oy, W, H);
        full.width = full.height = 0;
      }
      return;
    }
    ctx.drawImage(img, view.ox, view.oy, W, H);
    const ov = new ImageData(alpha.w, alpha.h);
    for (const e of list) {
      if (!e.mask) continue;
      const [r, g, b] = hex(colorOf(e.id)), strong = e.id === cur;
      for (let i = 0; i < alpha.data.length; i++) {
        const m = e.mask.data[i];
        if (!m || !alpha.data[i]) continue;
        const a = (strong ? 150 : 80) * (m / 255);
        if (a > ov.data[i * 4 + 3]) { ov.data[i * 4] = r; ov.data[i * 4 + 1] = g; ov.data[i * 4 + 2] = b; ov.data[i * 4 + 3] = a; }
      }
    }
    const t = document.createElement("canvas");
    t.width = alpha.w; t.height = alpha.h;
    t.getContext("2d")!.putImageData(ov, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(t, view.ox, view.oy, W, H);
    if (drawing && drawing.pts.length) {
      ctx.strokeStyle = colorOf(cur ?? ""); ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      ctx.beginPath();
      if (drawing.kind === "rect") { const [a, b] = [drawing.pts[0], drawing.pts[drawing.pts.length - 1]]; ctx.rect(view.ox + a[0] * view.k, view.oy + a[1] * view.k, (b[0] - a[0]) * view.k, (b[1] - a[1]) * view.k); }
      else drawing.pts.forEach(([x, y], i) => (i ? ctx.lineTo(view.ox + x * view.k, view.oy + y * view.k) : ctx.moveTo(view.ox + x * view.k, view.oy + y * view.k)));
      ctx.stroke();
    }
  }, [img, alpha, view, list, cur, rev, drawing, box, preview, fileImgs]);

  // 上傳的補完圖（預覽用）
  useEffect(() => {
    for (const e of list) if (e.file && !fileImgs.has(e.file)) { const f = e.file; void loadImage(f).then((i) => setFileImgs((m) => new Map(m).set(f, i))).catch(() => undefined); }
  }, [list, fileImgs]);
  // 部件縮圖：停筆 300ms 後才重新製作
  useEffect(() => {
    if (!img || !alpha) return;
    const t = window.setTimeout(() => {
      const out = new Map<string, string>();
      const src = document.createElement("canvas");
      src.width = alpha.w; src.height = alpha.h;
      const sx = src.getContext("2d", { willReadFrequently: true })!;
      sx.drawImage(img, 0, 0, alpha.w, alpha.h);
      const px = sx.getImageData(0, 0, alpha.w, alpha.h);
      const others = list.filter((e) => e.mask && !e.rest && !e.file);
      for (const e of list) {
        if (e.file) { out.set(e.id, refUrl(e.file)); continue; }
        const keep = (i: number) => (e.rest ? (others.some((o) => o.mask!.data[i] > 24) ? 0 : 255) : e.mask ? e.mask.data[i] : 0);
        let x0 = alpha.w, y0 = alpha.h, x1 = -1, y1 = -1;
        for (let i = 0; i < alpha.data.length; i++) if (alpha.data[i] > 24 && keep(i) > 24) { const x = i % alpha.w, y = (i - x) / alpha.w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0) continue;
        const w = x1 - x0 + 1, h = y1 - y0 + 1, d = new ImageData(w, h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y + y0) * alpha.w + x + x0, o = (y * w + x) * 4; d.data[o] = px.data[i * 4]; d.data[o + 1] = px.data[i * 4 + 1]; d.data[o + 2] = px.data[i * 4 + 2]; d.data[o + 3] = Math.round((px.data[i * 4 + 3] * keep(i)) / 255); }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d")!.putImageData(d, 0, 0);
        out.set(e.id, c.toDataURL("image/png"));
        c.width = c.height = 0;
      }
      src.width = src.height = 0;
      setThumbs(out);
    }, 300);
    return () => clearTimeout(t);
  }, [img, alpha, list, rev]);
  /** 目前部件與其他部件重疊的像素數目 */
  const overlap = useMemo(() => {
    const c = list.find((e) => e.id === cur);
    if (!c?.mask || c.rest || c.file || !alpha) return [];
    return list.filter((o) => o.id !== c.id && o.mask && !o.rest && !o.file).map((o) => { let n = 0; for (let i = 0; i < alpha.data.length; i++) if (alpha.data[i] && c.mask!.data[i] > 24 && o.mask!.data[i] > 24) n++; return { e: o, n }; }).filter((x) => x.n > 4);
  }, [list, cur, rev, alpha]);

  const current = list.find((e) => e.id === cur) ?? null;
  const ensureMask = (e: Edit) => { if (!e.mask && alpha) e.mask = emptyMask(alpha.w, alpha.h); return e.mask!; };
  const remember = (e: Edit) => { undo.current.push({ id: e.id, data: e.mask ? e.mask.data.slice() : null }); if (undo.current.length > 40) undo.current.shift(); };
  const touched = () => setRev((r) => r + 1);

  function addPiece(init?: Partial<Edit>) {
    const e: Edit = { id: newPieceId(), name: "新部件", slot: "accessory", mask: alpha ? emptyMask(alpha.w, alpha.h) : null, file: null, rest: false, keep: {}, ...init };
    setList((l) => [...l, e]);
    setCur(e.id);
    if (!init?.mask) setTool("brush");
    return e;
  }
  function autoSplit() {
    if (!alpha) return;
    const comps = findComponents(alpha);
    if (comps.length < 2) { toast("圖片內的部件互相連在一起，未能自動拆開；請用筆刷、方形或圈選標記", "err"); return; }
    // 已經有的部件保留；新找到的部件加在後面（主體不加入：穿著時用「剩餘衣身」）
    const made: Edit[] = comps.slice(1).map((c) => { const g = guessPiece(c, comps); return { id: newPieceId(), name: g.name, slot: g.slot, mask: c.mask, file: null, rest: false, keep: {} }; });
    const main = guessPiece(comps[0], comps);
    const rest: Edit = { id: newPieceId(), name: main.name, slot: main.slot, mask: null, file: null, rest: true, keep: {} };
    setList((l) => [...l.filter((e) => !e.rest), ...made, ...(l.some((e) => e.rest) ? l.filter((e) => e.rest) : [rest])]);
    setCur(made[0]?.id ?? null);
    setTool("pick");
    toast(`找到 ${made.length} 個分開的部件，請檢查名稱及分類`);
  }

  // ───── 手勢 ─────
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const g = useRef<{ kind: "paint" | "shape" | "pinch" | "none"; last?: [number, number]; d0?: number; m0?: [number, number]; cam0?: typeof cam; backup?: Uint8Array | null } | null>(null);
  const toGrid = (e: { clientX: number; clientY: number }): [number, number] => { const r = wrap.current!.getBoundingClientRect(); return [(e.clientX - r.left - view!.ox) / view!.k, (e.clientY - r.top - view!.oy) / view!.k]; };
  function dab(x: number, y: number, add: boolean) {
    if (!current || !alpha || current.rest || current.file) return;
    const m = ensureMask(current), r = Math.max(0.7, size / view!.k);
    for (let j = Math.max(0, Math.floor(y - r)); j <= Math.min(alpha.h - 1, Math.ceil(y + r)); j++) for (let i = Math.max(0, Math.floor(x - r)); i <= Math.min(alpha.w - 1, Math.ceil(x + r)); i++) {
      if ((i + 0.5 - x) ** 2 + (j + 0.5 - y) ** 2 > r * r) continue;
      const k = j * alpha.w + i;
      m.data[k] = add ? (alpha.data[k] > 0 ? 255 : 0) : 0;
    }
  }
  function fillShape(kind: "rect" | "lasso", p: [number, number][]) {
    if (!current || !alpha || current.rest || current.file || p.length < 2) return;
    const m = ensureMask(current);
    remember(current);
    const inside = (x: number, y: number) => {
      if (kind === "rect") { const [a, b] = [p[0], p[p.length - 1]]; return x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0]) && y >= Math.min(a[1], b[1]) && y <= Math.max(a[1], b[1]); }
      let c = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
      return c;
    };
    for (let j = 0; j < alpha.h; j++) for (let i = 0; i < alpha.w; i++) { const k = j * alpha.w + i; if (alpha.data[k] > 0 && inside(i + 0.5, j + 0.5)) m.data[k] = 255; }
    touched();
  }
  function onDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!view || !alpha) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.current.size === 2) {
      // 第二根手指：縮放／移動畫面；正在畫的一筆作廢
      const cur0 = g.current;
      if (cur0?.kind === "paint" && current?.mask && cur0.backup) { current.mask.data.set(cur0.backup); undo.current.pop(); touched(); }
      setDrawing(null);
      const [a, b] = [...pts.current.values()];
      g.current = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, m0: [(a.x + b.x) / 2, (a.y + b.y) / 2], cam0: cam };
      return;
    }
    if (pts.current.size > 2) return;
    const [x, y] = toGrid(e);
    if (tool === "pick") {
      const i = Math.floor(y) * alpha.w + Math.floor(x);
      const hit = [...list].reverse().find((p) => p.mask && p.mask.data[i] > 24) ?? list.find((p) => p.rest);
      if (hit) setCur(hit.id);
      g.current = { kind: "none" };
      return;
    }
    if (preview !== "mark") setPreview("mark");
    if (tool === "rect" || tool === "lasso") { g.current = { kind: "shape" }; setDrawing({ kind: tool, pts: [[x, y]] }); return; }
    if (!current || current.rest || current.file) { toast(current ? "這個部件不用塗抹（剩餘衣身／上傳圖片）" : "請先新增或揀選一個部件", "err"); g.current = { kind: "none" }; return; }
    remember(current);
    g.current = { kind: "paint", last: [x, y], backup: current.mask ? current.mask.data.slice() : null };
    dab(x, y, tool === "brush");
    touched();
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    const p = pts.current.get(e.pointerId);
    if (!p || !view) return;
    p.x = e.clientX; p.y = e.clientY;
    const s = g.current;
    if (!s) return;
    if (s.kind === "pinch") {
      const [a, b] = [...pts.current.values()];
      if (!a || !b) return;
      const z = Math.min(12, Math.max(0.6, s.cam0!.z * (Math.hypot(a.x - b.x, a.y - b.y) / s.d0!)));
      const m: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      // 兩指中點對著的位置保持不動
      const r = wrap.current!.getBoundingClientRect(), f = z / s.cam0!.z;
      const cx0 = s.m0![0] - r.left - box.w / 2 - s.cam0!.x, cy0 = s.m0![1] - r.top - box.h / 2 - s.cam0!.y;
      setCam({ z, x: m[0] - r.left - box.w / 2 - cx0 * f, y: m[1] - r.top - box.h / 2 - cy0 * f });
      return;
    }
    const [x, y] = toGrid(e);
    if (s.kind === "shape") { setDrawing((d) => (d ? { ...d, pts: d.kind === "rect" ? [d.pts[0], [x, y]] : [...d.pts, [x, y]] } : d)); return; }
    if (s.kind === "paint" && s.last) {
      const [lx, ly] = s.last, n = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / Math.max(0.5, (size / view.k) * 0.5)));
      for (let i = 1; i <= n; i++) dab(lx + ((x - lx) * i) / n, ly + ((y - ly) * i) / n, tool === "brush");
      s.last = [x, y];
      touched();
    }
  }
  function onUp(e: ReactPointerEvent<HTMLDivElement>) {
    pts.current.delete(e.pointerId);
    const s = g.current;
    if (!s) return;
    if (s.kind === "pinch") { if (!pts.current.size) g.current = null; else g.current = { kind: "none" }; return; }
    if (pts.current.size) return;
    if (s.kind === "shape" && drawing && e.type !== "pointercancel") fillShape(drawing.kind, drawing.pts);
    setDrawing(null);
    g.current = null;
  }

  async function save() {
    const out: Piece[] = [];
    for (const e of list) {
      if (e.file) { out.push({ id: e.id, name: e.name, slot: e.slot, box: [0, 0, 1, 1], file: e.file, ...e.keep }); continue; }
      if (e.rest) { out.push({ id: e.id, name: e.name, slot: e.slot, box: (alpha && maskBox(alpha)) ?? [0, 0, 1, 1], rest: true, ...e.keep }); continue; }
      const b = e.mask ? maskBox(e.mask) : null;
      if (!b) continue; // 沒有選取任何位置的部件不保存
      out.push({ id: e.id, name: e.name, slot: e.slot, box: b, mask: maskToDataURL(e.mask!), ...e.keep });
    }
    if (out.length > 16) return toast("最多 16 個部件", "err");
    if (await onSave(out)) { await pendingWrite.current; await clearDraft(recoveryKey).catch(() => undefined); }
  }
  const patch = (v: Partial<Edit>) => current && setList((l) => l.map((e) => (e.id === current.id ? { ...e, ...v } : e)));

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-plum" data-testid="split-editor">
      <div className="safe-top shrink-0 bg-ink">
        <div className="flex h-12 items-center gap-2 px-2.5">
          <button type="button" aria-label="關閉拆件編輯" onClick={onClose} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full"><IconClose /></button>
          <div className="min-w-0 flex-1"><div className="text-[10.5px] text-mauve">套裝拆件（原圖不會被修改）</div><div className="truncate text-[13.5px] text-gold-soft">{name}</div></div>
          <button type="button" data-testid="split-save" disabled={busy || !alpha} onClick={save} className="btn-jewel h-9 shrink-0 rounded-full px-4 text-[13px] disabled:opacity-50">{busy ? "…" : "保存部件"}</button>
        </div>
      </div>
      <div ref={wrap} className="relative min-h-0 flex-1 select-none overflow-hidden" style={{ touchAction: "none" }} data-testid="split-stage"
        data-k={view?.k.toFixed(4) ?? ""} data-ox={view?.ox.toFixed(1) ?? ""} data-oy={view?.oy.toFixed(1) ?? ""}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" />
        {!alpha && <span className="absolute inset-0 grid place-items-center text-[12px] text-mauve">讀取原圖中…</span>}
        <button type="button" aria-label="撤銷" disabled={!undo.current.length} onClick={() => { const u = undo.current.pop(); const e = list.find((x) => x.id === u?.id); if (u && e) { e.mask = u.data && alpha ? { w: alpha.w, h: alpha.h, data: u.data } : null; touched(); } }} className="absolute bottom-2 left-2 grid h-8 w-8 place-items-center rounded-full bg-ink/50 text-cream disabled:opacity-35">↶</button>
        <button type="button" onClick={() => setCam({ z: 1, x: 0, y: 0 })} className="absolute bottom-2 right-2 rounded-full bg-ink/50 px-3 py-1 text-[11px] text-cream">{Math.round(cam.z * 100)}%</button>
      </div>
      <div className="shrink-0 border-t border-gold/40 bg-velvet px-3 pb-[max(env(safe-area-inset-bottom),8px)] pt-2 text-[12.5px]">
        <div className="scrollbar-none -mx-3 flex gap-1.5 overflow-x-auto px-3 pb-2">
          <button type="button" data-testid="split-auto" disabled={!alpha} onClick={autoSplit} className="btn-jewel shrink-0 rounded-full px-3 py-1.5">自動拆出分開的部件</button>
          <button type="button" data-testid="split-add" onClick={() => addPiece()} className="chip flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5"><IconPlus className="text-[11px]" />新部件</button>
          {PREVIEWS.map(([v, label]) => <button key={v} type="button" data-split-preview={v} aria-pressed={preview === v} onClick={() => setPreview(v)} className={`shrink-0 rounded-full px-2.5 py-1.5 text-[11.5px] ${preview === v ? "chip-on" : "bg-white/5 text-cream/80"}`}>{label}</button>)}
        </div>
        {/* 部件列表：縮圖＋名稱＋分類＋附接位置＋是否已設定穿著位置 */}
        <div className="scrollbar-none -mx-3 flex gap-1.5 overflow-x-auto px-3 pb-2" data-testid="split-pieces">
          {list.map((e) => {
            const on = cur === e.id, bone = e.keep.opts?.bone ?? pieceBone(e);
            return (
              <button key={e.id} type="button" data-piece={e.id} aria-pressed={on} onClick={() => setCur(e.id)} className={`flex w-[8.6rem] shrink-0 items-center gap-1.5 rounded-2xl p-1 text-left ${on ? "chip-on ring-2 ring-gold-soft" : "chip"}`}>
                <span className="relative grid h-11 w-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-white/85" style={{ boxShadow: `inset 0 0 0 2px ${e.rest ? "#f0d9c0" : colorOf(e.id)}` }}>
                  {thumbs.get(e.id) ? <img src={thumbs.get(e.id)} alt="" className="h-full w-full object-contain p-0.5" /> : <span className="text-[9px] text-mauve">未選取</span>}
                </span>
                <span className="min-w-0 leading-tight">
                  <span className="block truncate text-[12px]">{e.name}</span>
                  <span className="block truncate text-[9.5px] opacity-75">{SLOT_LABEL[e.slot]}{bone !== "world" ? "・" + (BONE_LABEL[bone] ?? bone) : ""}</span>
                  <span className="block truncate text-[9.5px] opacity-75">{e.keep.fit ? "已設定位置" : "未設定位置"}{e.rest ? "・剩餘衣身" : e.file ? "・補完圖" : ""}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {([["pick", "點選部件"], ["brush", "筆刷"], ["erase", "擦除"], ["rect", "方形"], ["lasso", "圈選"]] as [Tool, string][]).map(([t, label]) => <button key={t} type="button" data-split-tool={t} aria-pressed={tool === t} onClick={() => { setTool(t); if (preview !== "mark" && t !== "pick") setPreview("mark"); }} className={pill(tool === t)}>{label}</button>)}
          {(tool === "brush" || tool === "erase") && <input type="range" aria-label="筆刷大小" min={3} max={60} value={size} onChange={(e) => setSize(Number(e.target.value))} className="min-w-0 flex-1" />}
        </div>
        {overlap.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-xl bg-[#a12c4b]/30 px-2 py-1 text-[11px] text-[#ffd3df]" data-testid="split-overlap">
            <span>與 {overlap.map((o) => `「${o.e.name}」`).join("、")} 重疊</span>
            <button type="button" onClick={() => { if (!current?.mask) return; for (const o of overlap) { remember(o.e); for (let i = 0; i < o.e.mask!.data.length; i++) if (current.mask.data[i] > 24) o.e.mask!.data[i] = 0; } touched(); }} className="chip rounded-full px-2 py-0.5">重疊部分只屬於目前部件</button>
          </div>
        )}
        {current && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="split-current">
            <input value={current.name} onChange={(e) => patch({ name: e.target.value.slice(0, 30) })} aria-label="部件名稱" data-testid="split-name" className="h-8 w-32 rounded-full bg-white px-3 text-[12.5px] text-ink ring-1 ring-gold focus:outline-none" />
            <select aria-label="部件分類" data-testid="split-slot" value={current.slot} onChange={(e) => patch({ slot: e.target.value as Slot })} className="h-8 rounded-full bg-velvet px-2 text-[12px]">{SLOTS.map((s) => <option key={s} value={s}>{SLOT_LABEL[s] ?? s}</option>)}</select>
            <select aria-label="附接位置" data-testid="split-bone" value={current.keep.opts?.bone ?? ""} onChange={(e) => { const b = e.target.value; patch({ keep: { ...current.keep, opts: b ? { ...(current.keep.opts ?? { ...defaultOpts(current.slot), follow: "none" as const }), bone: b } : null } }); }} className="h-8 max-w-[9rem] rounded-full bg-velvet px-2 text-[12px]">
              <option value="">附接：自動（{BONE_LABEL[pieceBone(current)] ?? (pieceBone(current) === "world" ? "固定" : pieceBone(current))}）</option>
              {ATTACHABLE_BONES.map((b) => <option key={b} value={b}>附接：{b === "world" ? "固定不動" : BONE_LABEL[b] ?? b}</option>)}
            </select>
            <button type="button" aria-pressed={current.rest} data-testid="split-rest" onClick={() => patch({ rest: !current.rest, file: null })} className={pill(current.rest)}>剩餘衣身（扣除其他部件）</button>
            <button type="button" onClick={() => fileInput.current?.click()} className="chip rounded-full px-3 py-1.5">{current.file ? "已上傳補完圖（更換）" : "上傳補完的透明圖"}</button>
            {current.file && <button type="button" onClick={() => patch({ file: null })} className="chip rounded-full px-3 py-1.5">改回原圖選取</button>}
            <button type="button" aria-label="刪除部件" onClick={() => { setList((l) => l.filter((e) => e.id !== current.id)); setCur(null); }} className="chip grid h-8 w-8 place-items-center rounded-full"><IconTrash /></button>
          </div>
        )}
        <p className="mt-1.5 text-[11px] leading-snug text-mauve">{current?.rest ? "「剩餘衣身」＝原圖減去其他所有部件（例如扣除頭飾、頸飾、袖套後的連身裙），不用逐點塗抹。" : current?.file ? "這個部件使用上傳的透明圖（例如被遮住部分已補完的袖套）。" : "選取只會包括衣物本身（透明位置不會被選到）。雙指放大畫面可以更精細地塗抹。左右以角色自己為準：右袖套在畫面左邊。"}</p>
        <input ref={fileInput} type="file" accept="image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f && current) void onUpload(f, current.name).then((ref) => ref && patch({ file: ref, rest: false })); }} />
      </div>
    </div>
  );
}
