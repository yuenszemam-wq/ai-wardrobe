import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { api, AppSettings, HomeBg } from "../api";
import { Button, setSettingsCache, Sheet, toast } from "./ui";

export interface BgLayout {
  ratio: number; // 高度佔寬度的百分比
  zoom: number; // 1＝剛好填滿
  x: number; // 0–100：圖片水平位置
  y: number; // 0–100：圖片垂直位置
}

/** 以百分比計算圖片在框內的大小及位置（相當於 object-fit: cover 再放大 zoom 倍），顯示與編輯共用 */
function place(iw: number, ih: number, l: BgLayout) {
  const boxAR = 100 / l.ratio;
  const imgAR = iw / ih || 1;
  const w = (imgAR > boxAR ? (imgAR / boxAR) * 100 : 100) * l.zoom;
  const h = (imgAR > boxAR ? 100 : (boxAR / imgAR) * 100) * l.zoom;
  return { w, h, left: ((100 - w) * l.x) / 100, top: ((100 - h) * l.y) / 100 };
}

/** 背景圖層：長方形，下緣漸漸淡出並融入頁面底色 */
export function BgImage({ src, iw, ih, layout, fade = true }: { src: string; iw: number; ih: number; layout: BgLayout; fade?: boolean }) {
  const p = place(iw, ih, layout);
  const mask = "linear-gradient(to bottom, #000 0%, #000 48%, rgb(0 0 0 / 0.55) 72%, transparent 100%)";
  return (
    <div className="relative w-full overflow-hidden" style={{ aspectRatio: `100 / ${layout.ratio}`, ...(fade ? { maskImage: mask, WebkitMaskImage: mask } : {}) }}>
      <img src={src} alt="" draggable={false} className="pointer-events-none absolute max-w-none select-none" style={{ width: `${p.w}%`, height: `${p.h}%`, left: `${p.left}%`, top: `${p.top}%` }} />
    </div>
  );
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** 把相片縮到長邊最多 2000px 的 JPEG（背景圖不需要原檔，節省流量） */
async function shrink(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * s));
    const h = Math.max(1, Math.round(img.naturalHeight * s));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d")!;
    ctx.fillStyle = "#2a1526";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/jpeg", 0.88));
    if (!blob) throw new Error("未能處理這張圖片");
    return { blob, width: w, height: h };
  } catch (e) {
    throw new Error((e as Error).message || "未能讀取這張圖片（HEIC 請先轉為 JPG）");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 主頁背景編輯：選圖 → 拖動調位置、雙指或滑桿縮放、調整高度 → 儲存 */
export function HomeBgEditor({ current, onClose }: { current: HomeBg | null; onClose: () => void }) {
  const [picked, setPicked] = useState<{ blob: Blob; url: string; width: number; height: number } | null>(null);
  const [layout, setLayout] = useState<BgLayout>(current ? { ratio: current.ratio, zoom: current.zoom, x: current.x, y: current.y } : { ratio: 78, zoom: 1, x: 50, y: 40 });
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ l: BgLayout; sx: number; sy: number; d0: number } | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => () => void (picked && URL.revokeObjectURL(picked.url)), [picked]);

  const src = picked?.url ?? current?.url ?? null;
  const iw = picked?.width ?? current?.width ?? 1;
  const ih = picked?.height ?? current?.height ?? 1;

  async function choose(file: File | undefined) {
    if (!file) return;
    try {
      const r = await shrink(file);
      setPicked({ ...r, url: URL.createObjectURL(r.blob) });
      setLayout((l) => ({ ...l, zoom: 1, x: 50, y: 40 }));
    } catch (e) {
      toast((e as Error).message, "err");
    }
  }

  function begin() {
    const pts = [...pointers.current.values()];
    start.current = { l: layoutRef.current, sx: pts[0].x, sy: pts[0].y, d0: pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1 : 0 };
  }
  function down(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    begin();
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId) || !start.current || !box.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const s = start.current;
    if (pts.length >= 2 && s.d0) {
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      setLayout({ ...s.l, zoom: clamp(Math.round(s.l.zoom * (d / s.d0) * 100) / 100, 1, 4) });
      return;
    }
    const r = box.current.getBoundingClientRect();
    const p = place(iw, ih, s.l);
    const overX = (r.width * (p.w - 100)) / 100;
    const overY = (r.height * (p.h - 100)) / 100;
    setLayout({
      ...s.l,
      x: overX > 1 ? clamp(s.l.x - ((pts[0].x - s.sx) / overX) * 100, 0, 100) : s.l.x,
      y: overY > 1 ? clamp(s.l.y - ((pts[0].y - s.sy) / overY) * 100, 0, 100) : s.l.y,
    });
  }
  function up(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size) begin();
    else start.current = null;
  }

  async function save() {
    setBusy(true);
    try {
      const l = { ratio: Math.round(layout.ratio), zoom: Math.round(layout.zoom * 100) / 100, x: Math.round(layout.x * 10) / 10, y: Math.round(layout.y * 10) / 10 };
      let bg: HomeBg | null;
      if (picked) {
        const q = new URLSearchParams(Object.entries(l).map(([k, v]) => [k, String(v)]));
        bg = (await api<{ home_bg: HomeBg }>(`/api/settings/home-bg?${q}`, { method: "POST", body: picked.blob, headers: { "content-type": "image/jpeg" } })).home_bg;
        setSettingsCache({ ...(await api<AppSettings>("/api/settings")), home_bg: bg });
      } else {
        setSettingsCache(await api<AppSettings>("/api/settings", { method: "PUT", json: { home_bg: l } }));
      }
      toast("已更新主頁背景");
      onClose();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("移除主頁背景圖？")) return;
    setBusy(true);
    try {
      await api("/api/settings/home-bg", { method: "DELETE" });
      setSettingsCache(await api<AppSettings>("/api/settings"));
      toast("已移除背景圖");
      onClose();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="主頁背景" onClose={onClose}>
      {src ? (
        <>
          <div ref={box} className="overflow-hidden rounded-xl ring-1 ring-gold/60" style={{ touchAction: "none", cursor: "grab" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            <BgImage src={src} iw={iw} ih={ih} layout={layout} />
          </div>
          <p className="mt-1.5 text-center text-[12px] text-mauve">拖動調整位置，雙指或下面滑桿縮放；下緣會自動淡出融入底色</p>
          <label className="mt-3 block text-[13px]">
            <span className="flex justify-between text-mauve">
              <span>縮放</span>
              <span>{layout.zoom.toFixed(2)}×</span>
            </span>
            <input type="range" min={1} max={4} step={0.01} value={layout.zoom} onChange={(e) => setLayout((l) => ({ ...l, zoom: Number(e.target.value) }))} className="mt-1 w-full " aria-label="縮放" />
          </label>
          <label className="mt-2 block text-[13px]">
            <span className="flex justify-between text-mauve">
              <span>高度</span>
              <span>{layout.ratio < 62 ? "矮" : layout.ratio < 95 ? "中" : "高"}</span>
            </span>
            <input type="range" min={40} max={140} step={1} value={layout.ratio} onChange={(e) => setLayout((l) => ({ ...l, ratio: Number(e.target.value) }))} className="mt-1 w-full " aria-label="高度" />
          </label>
        </>
      ) : (
        <p className="py-6 text-center text-[14px] text-mauve">選一張你喜歡的圖片作主頁頂部的背景（橫向或直向都可以）。</p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="btn-dark inline-flex min-h-11 cursor-pointer items-center rounded-full px-5 text-[15px]">
          {src ? "換另一張" : "選擇圖片"}
          <input type="file" accept="image/jpeg,image/png,image/webp,image/*" className="sr-only" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        {src && (
          <Button onClick={save} disabled={busy}>
            {busy ? "儲存中…" : "儲存"}
          </Button>
        )}
        {current && (
          <button type="button" onClick={remove} disabled={busy} className="ml-auto text-[13px] text-wine underline underline-offset-4">
            移除背景
          </button>
        )}
      </div>
    </Sheet>
  );
}
