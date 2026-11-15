/**
 * Phase 3.9A.3：圖片遮罩編輯（衣服配搭及角色換裝的素材圖層共用）。
 * 在平放的圖片上塗抹：隱藏筆刷／還原筆刷；筆畫以圖片相對座標（0–1）保存，與 shared/studioScene 的 LayerMask 相同，
 * 圖層之後移動、縮放、旋轉或跟隨骨骼仍然對齊。不修改素材原圖。
 */
import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { LayerMask, MaskStroke } from "../../shared/studioScene";
import { Button, Sheet, Spinner } from "../components/ui";
import { loadImage, maskedCanvas } from "./render";

export function MaskEditorSheet({ src, value, title = "編輯遮罩", onDone, onClose }: { src: string; value: LayerMask | null; title?: string; onDone: (m: LayerMask | null) => void; onClose: () => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [strokes, setStrokes] = useState<MaskStroke[]>(value?.strokes ?? []);
  const [mode, setMode] = useState<"hide" | "restore">("hide");
  const [size, setSize] = useState(0.06);
  const [compare, setCompare] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cur = useRef<MaskStroke | null>(null);
  useEffect(() => { let live = true; loadImage(src).then((i) => live && setImg(i)).catch((e) => live && setErr((e as Error).message)); return () => { live = false; }; }, [src]);
  const paint = (list: MaskStroke[]) => {
    const c = canvas.current; if (!c || !img) return;
    const m = maskedCanvas(img, compare || !list.length ? null : { v: 1, strokes: list }, 900);
    c.width = m.width; c.height = m.height;
    const x = c.getContext("2d")!;
    if (!compare && list.length) { x.globalAlpha = 0.22; x.drawImage(maskedCanvas(img, null, 900), 0, 0); x.globalAlpha = 1; }
    x.drawImage(m, 0, 0);
    m.width = 0;
    c.dataset.strokes = String(list.length);
  };
  useEffect(() => paint(strokes), [img, strokes, compare]); // eslint-disable-line react-hooks/exhaustive-deps
  const at = (e: ReactPointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return [Math.round(((e.clientX - r.left) / r.width) * 10000) / 10000, Math.round(((e.clientY - r.top) / r.height) * 10000) / 10000]; };
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="space-y-2 text-[12.5px]" data-testid="mask-editor">
        {err ? <p role="alert" className="text-wine">{err}</p> : !img ? <Spinner /> : (
          <canvas ref={canvas} className="checker mx-auto block max-h-[46vh] max-w-full rounded-xl" style={{ touchAction: "none" }} data-testid="mask-canvas"
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); cur.current = { mode, size, pts: at(e) }; paint([...strokes, cur.current]); }}
            onPointerMove={(e) => { if (!cur.current) return; cur.current.pts.push(...at(e)); paint([...strokes, cur.current]); }}
            onPointerUp={() => { if (cur.current) { const s = cur.current; cur.current = null; setStrokes((l) => [...l, { ...s, pts: [...s.pts] }]); } }}
            onPointerCancel={() => { cur.current = null; paint(strokes); }} />
        )}
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" aria-pressed={mode === "hide"} onClick={() => setMode("hide")} className={`h-8 rounded-full px-3 ${mode === "hide" ? "chip-on" : "chip"}`} data-mask-mode="hide">隱藏筆刷</button>
          <button type="button" aria-pressed={mode === "restore"} onClick={() => setMode("restore")} className={`h-8 rounded-full px-3 ${mode === "restore" ? "chip-on" : "chip"}`} data-mask-mode="restore">還原筆刷</button>
          <button type="button" onPointerDown={() => setCompare(true)} onPointerUp={() => setCompare(false)} onPointerLeave={() => setCompare(false)} className="chip h-8 rounded-full px-3">按住對比</button>
          <button type="button" disabled={!strokes.length} onClick={() => setStrokes((l) => l.slice(0, -1))} className="chip h-8 rounded-full px-3 disabled:opacity-40" data-testid="mask-undo">撤銷一筆</button>
          <button type="button" disabled={!strokes.length} onClick={() => setStrokes([])} className="chip h-8 rounded-full px-3 disabled:opacity-40">還原全部</button>
        </div>
        <label className="flex items-center gap-2">筆刷<input type="range" min={0.01} max={0.3} step={0.005} value={size} onChange={(e) => setSize(Number(e.target.value))} className="flex-1" /></label>
        <p className="text-[11px] text-mauve">遮罩只屬於這個圖層，不會修改素材原圖。</p>
        <Button className="w-full" onClick={() => onDone(strokes.length ? { v: 1, strokes } : null)} data-testid="mask-done">完成</Button>
      </div>
    </Sheet>
  );
}
