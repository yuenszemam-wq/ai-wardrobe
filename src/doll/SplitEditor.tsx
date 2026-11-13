// 套裝拆件編輯器：在套裝原圖上選出部件（袖套、頸飾、頭飾…），保存後可以獨立穿著。
// 原圖不會被修改：每個部件只保存一個低解像度的選取遮罩及範圍；亦可為部件另外上傳補完的透明圖。
// 單指＝目前工具（筆刷、擦除、方形、圈選、點選部件）；雙指＝縮放及移動畫面（正在畫的一筆會作廢）。
import { PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Piece, SLOT_LABEL, Slot } from "../../shared/doll";
import { IconClose, IconPlus, IconTrash } from "../components/icons";
import { toast } from "../components/ui";
import { MaskBuf, alphaOf, emptyMask, findComponents, guessPiece, maskBox, maskFromDataURL, maskToDataURL, newPieceId } from "./pieces";
import { pill } from "./panels";

type Tool = "pick" | "brush" | "erase" | "rect" | "lasso";
interface Edit { id: string; name: string; slot: Slot; mask: MaskBuf | null; file: string | null; rest: boolean; keep: Pick<Piece, "fit" | "opts"> }
const COLORS = ["#ff4f9a", "#2dbeff", "#ffc23d", "#7ee07a", "#c08bff", "#ff8a3d", "#3de0d0", "#ff5d5d", "#9aa7ff", "#e6e65c", "#ff9ad5", "#5dd39e", "#d9a066", "#7fb2ff", "#ffb3b3", "#b3ffb3"];
const SLOTS: Slot[] = ["dress", "top", "skirt", "outer", "accessory", "headwear", "socks", "shoes", "bag", "petticoat", "pants", "set"];
const hex = (c: string) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

export function SplitEditor({ name, imageRef, pieces, busy, onSave, onClose, onUpload }: {
  name: string; imageRef: string; pieces: Piece[]; busy: boolean;
  onSave: (pieces: Piece[]) => void; onClose: () => void;
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
  const [drawing, setDrawing] = useState<{ kind: "rect" | "lasso"; pts: [number, number][] } | null>(null);
  const wrap = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const undo = useRef<{ id: string; data: Uint8Array | null }[]>([]);

  // 讀取原圖及已保存的部件
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const a = await alphaOf(imageRef);
        if (off) return;
        const edits: Edit[] = [];
        for (const p of pieces) edits.push({ id: p.id, name: p.name, slot: p.slot, mask: p.mask ? await maskFromDataURL(p.mask, a.alpha.w, a.alpha.h) : null, file: p.file ?? null, rest: !!p.rest, keep: { fit: p.fit, opts: p.opts } });
        if (off) return;
        setImg(a.img); setAlpha(a.alpha); setList(edits); setCur(edits.find((e) => !e.rest)?.id ?? null);
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
  }, [img, alpha, view, list, cur, rev, drawing, box]);

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
    // 已經有的部件保留；新找到的部件加在後面（主體不加入：穿著時用「其餘部分」）
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
    if (tool === "rect" || tool === "lasso") { g.current = { kind: "shape" }; setDrawing({ kind: tool, pts: [[x, y]] }); return; }
    if (!current || current.rest || current.file) { toast(current ? "這個部件不用塗抹（其餘部分／上傳圖片）" : "請先新增或揀選一個部件", "err"); g.current = { kind: "none" }; return; }
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

  function save() {
    const out: Piece[] = [];
    for (const e of list) {
      if (e.file) { out.push({ id: e.id, name: e.name, slot: e.slot, box: [0, 0, 1, 1], file: e.file, ...e.keep }); continue; }
      if (e.rest) { out.push({ id: e.id, name: e.name, slot: e.slot, box: (alpha && maskBox(alpha)) ?? [0, 0, 1, 1], rest: true, ...e.keep }); continue; }
      const b = e.mask ? maskBox(e.mask) : null;
      if (!b) continue; // 沒有選取任何位置的部件不保存
      out.push({ id: e.id, name: e.name, slot: e.slot, box: b, mask: maskToDataURL(e.mask!), ...e.keep });
    }
    if (out.length > 16) return toast("最多 16 個部件", "err");
    onSave(out);
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
        <div className="scrollbar-none -mx-3 flex gap-1.5 overflow-x-auto px-3 pb-2" data-testid="split-pieces">
          <button type="button" data-testid="split-auto" disabled={!alpha} onClick={autoSplit} className="btn-jewel shrink-0 rounded-full px-3 py-1.5">自動拆出分開的部件</button>
          <button type="button" data-testid="split-add" onClick={() => addPiece()} className="chip flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5"><IconPlus className="text-[11px]" />新部件</button>
          {list.map((e) => <button key={e.id} type="button" data-piece={e.id} aria-pressed={cur === e.id} onClick={() => setCur(e.id)} className={pill(cur === e.id)}><span className="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle" style={{ background: e.rest ? "transparent" : colorOf(e.id), border: e.rest ? "1px dashed #f0d9c0" : undefined }} />{e.name}</button>)}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {([["pick", "點選部件"], ["brush", "筆刷"], ["erase", "擦除"], ["rect", "方形"], ["lasso", "圈選"]] as [Tool, string][]).map(([t, label]) => <button key={t} type="button" data-split-tool={t} aria-pressed={tool === t} onClick={() => setTool(t)} className={pill(tool === t)}>{label}</button>)}
          {(tool === "brush" || tool === "erase") && <input type="range" aria-label="筆刷大小" min={3} max={60} value={size} onChange={(e) => setSize(Number(e.target.value))} className="min-w-0 flex-1" />}
        </div>
        {current && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="split-current">
            <input value={current.name} onChange={(e) => patch({ name: e.target.value.slice(0, 30) })} aria-label="部件名稱" data-testid="split-name" className="h-8 w-32 rounded-full bg-white px-3 text-[12.5px] text-ink ring-1 ring-gold focus:outline-none" />
            <select aria-label="部件分類" data-testid="split-slot" value={current.slot} onChange={(e) => patch({ slot: e.target.value as Slot })} className="h-8 rounded-full bg-velvet px-2 text-[12px]">{SLOTS.map((s) => <option key={s} value={s}>{SLOT_LABEL[s] ?? s}</option>)}</select>
            <button type="button" aria-pressed={current.rest} data-testid="split-rest" onClick={() => patch({ rest: !current.rest, file: null })} className={pill(current.rest)}>其餘部分</button>
            <button type="button" onClick={() => fileInput.current?.click()} className="chip rounded-full px-3 py-1.5">{current.file ? "已上傳補完圖（更換）" : "上傳補完的透明圖"}</button>
            {current.file && <button type="button" onClick={() => patch({ file: null })} className="chip rounded-full px-3 py-1.5">改回原圖選取</button>}
            <button type="button" aria-label="刪除部件" onClick={() => { setList((l) => l.filter((e) => e.id !== current.id)); setCur(null); }} className="chip grid h-8 w-8 place-items-center rounded-full"><IconTrash /></button>
          </div>
        )}
        <p className="mt-1.5 text-[11px] leading-snug text-mauve">{current?.rest ? "「其餘部分」＝原圖減去其他所有部件（例如連身裙主體），不用塗抹。" : current?.file ? "這個部件使用上傳的透明圖（例如被遮住部分已補完的袖套）。" : "選取只會包括衣物本身（透明位置不會被選到）。雙指放大畫面可以更精細地塗抹。"}</p>
        <input ref={fileInput} type="file" accept="image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f && current) void onUpload(f, current.name).then((ref) => ref && patch({ file: ref, rest: false })); }} />
      </div>
    </div>
  );
}
