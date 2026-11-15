/**
 * Phase 3.9A.2：工作室共用渲染（畫布預覽、保存縮圖、高清預覽及 PNG 匯出共用同一套邏輯）。
 *
 * - 背景：純色／漸層／條紋／波點／格紋由程式生成（不使用 R2 圖片）；圖片背景使用素材版本。
 * - 圖層：圖片按比例放入方框（contain），以方框中心旋轉、翻轉；套用圖層遮罩（相對圖片座標的筆畫）及透明度。
 * - 透明棋盤格只在編輯器以 CSS 顯示，從不畫入輸出圖片。
 * - 匯出前等待所有圖片載入完成；任何一張失敗即中止整個匯出（不會輸出缺少圖層的圖片）。
 */
import { BackgroundSpec, CANVAS_H, CANVAS_W, Layer, LayerMask } from "../../shared/studioScene";
import { highResolutionBlob } from "../imageCache";

export type Img = HTMLImageElement | HTMLCanvasElement | ImageBitmap;
const dimsOf = (i: Img) => ("naturalWidth" in i ? { w: i.naturalWidth, h: i.naturalHeight } : { w: i.width, h: i.height });

/*
 * Phase 3.9A.2.1：圖片快取有上限（LRU），離開工作室時全部釋放。
 * 以前的全域 Promise map 沒有上限，object URL 亦從不釋放：在 iPhone 長時間使用工作室或角色換裝會不斷佔用記憶體。
 * 被淘汰的項目只移出快取（畫面上仍在使用的圖片元素不受影響）；releaseImageCache() 在工作室卸載時釋放全部 object URL。
 */
const MAX_IMAGES = 80;
const imgCache = new Map<string, Promise<HTMLImageElement>>();
const objectUrls = new Set<string>();
/** 讀取圖片（經共用高清快取：已下載的圖片離線亦可使用） */
export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imgCache.get(src);
  if (p) { imgCache.delete(src); imgCache.set(src, p); return p; } // 最近使用移到最後
  p = highResolutionBlob(src).then(async (blob) => {
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { URL.revokeObjectURL(url); objectUrls.delete(url); throw new Error("圖片未能解碼"); }
    return img;
  });
  imgCache.set(src, p);
  p.catch(() => imgCache.delete(src));
  while (imgCache.size > MAX_IMAGES) imgCache.delete(imgCache.keys().next().value as string);
  return p;
}
export const imageCacheSize = () => imgCache.size;
/** 離開工作室：釋放所有 object URL 及快取 */
export function releaseImageCache() {
  imgCache.clear();
  // 延遲釋放：讓正在卸載的畫面完成最後一次繪畫
  const urls = [...objectUrls]; objectUrls.clear();
  setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 1500);
}

// ───── 遮罩 ─────
/** 把遮罩套用到圖片，回傳新畫布（最長邊 maxSide）。原圖不變 */
export function maskedCanvas(img: Img, mask: LayerMask | null, maxSide = 1400): HTMLCanvasElement {
  const { w, h } = dimsOf(img);
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img as CanvasImageSource, 0, 0, c.width, c.height);
  if (mask?.strokes.length) {
    // 遮罩圖層：白＝保留。依次執行隱藏／還原筆畫，最後以 destination-in 套用
    const m = document.createElement("canvas");
    m.width = c.width; m.height = c.height;
    const mc = m.getContext("2d")!;
    mc.fillStyle = "#fff"; mc.fillRect(0, 0, m.width, m.height);
    mc.lineCap = "round"; mc.lineJoin = "round";
    for (const st of mask.strokes) {
      mc.globalCompositeOperation = st.mode === "hide" ? "destination-out" : "source-over";
      mc.strokeStyle = "#fff"; mc.fillStyle = "#fff";
      mc.lineWidth = Math.max(1, st.size * m.width);
      mc.beginPath();
      for (let i = 0; i < st.pts.length; i += 2) { const x = st.pts[i] * m.width, y = st.pts[i + 1] * m.height; if (i === 0) mc.moveTo(x, y); else mc.lineTo(x, y); }
      if (st.pts.length === 2) { mc.arc(st.pts[0] * m.width, st.pts[1] * m.height, mc.lineWidth / 2, 0, Math.PI * 2); mc.fill(); } else mc.stroke();
    }
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(m, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
  return c;
}

/** 低解像度 Alpha 網格（命中判斷用，不會在每次移動時重新讀取高清圖） */
export interface AlphaGrid { w: number; h: number; a: Uint8Array }
export function alphaGrid(src: HTMLCanvasElement, side = 96): AlphaGrid {
  const s = Math.min(1, side / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * s)), h = Math.max(1, Math.round(src.height * s));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return { w, h, a };
}
export function alphaAt(g: AlphaGrid, u: number, v: number): number {
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return 0;
  // 鄰近 3×3 取最大值：細小的蕾絲邊緣亦容易點中
  const x = Math.floor(u * g.w), y = Math.floor(v * g.h);
  let m = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < g.w && yy < g.h) m = Math.max(m, g.a[yy * g.w + xx]); }
  return m;
}

// ───── 背景 ─────
function gradient(ctx: CanvasRenderingContext2D, W: number, H: number, angle: number, stops: { color: string; at: number }[]) {
  const a = ((angle - 90) * Math.PI) / 180;
  const r = (Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a))) / 2;
  const g = ctx.createLinearGradient(W / 2 - Math.cos(a) * r, H / 2 - Math.sin(a) * r, W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r);
  for (const s of stops) g.addColorStop(s.at, s.color);
  return g;
}
/** 畫背景（scale＝畫布實際寬度 ÷ 1200，令圖案大小在縮圖及匯出一致） */
export function paintBackground(ctx: CanvasRenderingContext2D, spec: BackgroundSpec | null, W: number, H: number, bgImage?: Img | null) {
  if (!spec || spec.type === "transparent") return;
  const k = W / CANVAS_W;
  ctx.save();
  ctx.globalAlpha = spec.opacity;
  if (spec.type === "solid") { ctx.fillStyle = spec.color; ctx.fillRect(0, 0, W, H); }
  else if (spec.type === "gradient") { ctx.fillStyle = gradient(ctx, W, H, spec.angle, spec.stops); ctx.fillRect(0, 0, W, H); }
  else if (spec.type === "stripes" || spec.type === "check" || spec.type === "dots") {
    ctx.fillStyle = spec.color; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = spec.color2;
    const size = spec.size * k, gap = spec.gap * k, period = size + gap;
    ctx.translate(W / 2, H / 2); ctx.rotate(((spec.angle - 90) * Math.PI) / 180);
    const R = Math.hypot(W, H);
    if (spec.type === "stripes") for (let x = -R; x < R; x += period) ctx.fillRect(x, -R, size, 2 * R);
    else if (spec.type === "check") { ctx.globalAlpha = spec.opacity * 0.55; for (let x = -R; x < R; x += period) ctx.fillRect(x, -R, size, 2 * R); for (let y = -R; y < R; y += period) ctx.fillRect(-R, y, 2 * R, size); }
    else { const step = Math.max(2, size + gap); for (let y = -R, row = 0; y < R; y += step, row++) for (let x = -R + (row % 2 ? step / 2 : 0); x < R; x += step) { ctx.beginPath(); ctx.arc(x, y, size / 2, 0, Math.PI * 2); ctx.fill(); } }
  } else if (spec.type === "image" && spec.image && bgImage) {
    const im = spec.image, { w, h } = dimsOf(bgImage);
    const base = im.fit === "cover" ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
    const s = base * im.scale;
    ctx.globalAlpha = spec.opacity * im.opacity;
    if (im.blur > 0) ctx.filter = `blur(${im.blur * k}px)`;
    ctx.translate(W / 2 + (im.x / 100) * W, H / 2 + (im.y / 100) * H);
    ctx.rotate((im.rotate * Math.PI) / 180);
    ctx.scale(im.flip_x ? -1 : 1, im.flip_y ? -1 : 1);
    ctx.drawImage(bgImage as CanvasImageSource, (-w * s) / 2, (-h * s) / 2, w * s, h * s);
  }
  ctx.restore();
}
// ───── 圖層 ─────
/** 把一個圖層畫到畫布（W×H），與編輯器 DOM 預覽同一套座標 */
export function drawLayer(ctx: CanvasRenderingContext2D, l: Layer, src: Img, W: number, H: number) {
  if (l.hidden) return;
  const { w: iw, h: ih } = dimsOf(src);
  const bw = (l.w / 100) * W, bh = (l.h / 100) * H;
  const s = Math.min(bw / iw, bh / ih);
  const dw = iw * s, dh = ih * s;
  ctx.save();
  ctx.globalAlpha = l.opacity;
  ctx.translate((l.x / 100) * W + bw / 2, (l.y / 100) * H + bh / 2);
  ctx.rotate((l.rotation * Math.PI) / 180);
  ctx.scale(l.flip_x ? -1 : 1, l.flip_y ? -1 : 1);
  ctx.drawImage(src as CanvasImageSource, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

export interface SceneImages { layer: (l: Layer) => Img | null | undefined; background?: Img | null }
/** 合成整個場景（縮圖及匯出共用）；withBackground=false＝真正透明 PNG */
export function composeScene(layers: Layer[], background: BackgroundSpec | null, images: SceneImages, W: number, H: number, withBackground = true): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d")!;
  if (withBackground) paintBackground(ctx, background, W, H, images.background);
  for (const l of layers) { const im = images.layer(l); if (im) drawLayer(ctx, l, im, W, H); }
  return c;
}
/**
 * 高清匯出（Phase 3.9A.2.1）：逐個圖層載入 → 套用遮罩 → 畫上 → 立即釋放，不會同時保留所有圖層的高清畫布。
 * 每個圖層的處理解像度＝它在輸出圖片中的實際像素大小（最多 4096），細小配件不會建立 3200px 的畫布。
 * iPhone Safari 畫布總記憶體有限：任何畫布建立或編碼失敗都會清楚回報，不會輸出缺少圖層的圖片。
 */
export async function exportScene(layers: Layer[], background: BackgroundSpec | null, srcOf: (l: Layer) => string | null, bgSrc: string | null, W: number, H: number, withBackground: boolean, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("這部裝置未能建立高清畫布，請改用標準解像度");
  try {
    if (withBackground) paintBackground(ctx, background, W, H, bgSrc ? await loadImage(bgSrc) : null);
    const vis = layers.filter((l) => !l.hidden);
    let n = 0;
    for (const l of vis) {
      const src = srcOf(l);
      if (!src) throw new Error(`「${l.name || "圖層"}」缺少圖片，未能匯出`);
      const img = await loadImage(src);
      const side = Math.min(4096, Math.ceil(Math.max((l.w / 100) * W, (l.h / 100) * H) * 1.05));
      const m = maskedCanvas(img, l.mask, Math.max(64, side));
      drawLayer(ctx, l, m, W, H);
      m.width = 0; m.height = 0; // 立即釋放
      onProgress?.(++n, vis.length);
    }
    const blob = await toBlob(c, "image/png").catch(() => { throw new Error("圖片太大，這部裝置未能輸出，請改用標準解像度"); });
    return blob;
  } finally { c.width = 0; c.height = 0; }
}
export const toBlob = (c: HTMLCanvasElement, type = "image/png", q?: number) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("未能產生圖片"))), type, q));
export const blobToBase64 = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).replace(/^data:[^,]+,/, "")); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
/** 造型縮圖（與畫布一致；最大約 110 KB） */
export async function sceneThumb(layers: Layer[], background: BackgroundSpec | null, images: SceneImages): Promise<string> {
  for (const [w, q] of [[360, 0.8], [300, 0.7], [240, 0.6]] as const) {
    const c = composeScene(layers, background, images, w, Math.round((w * CANVAS_H) / CANVAS_W), true);
    let b = await toBlob(c, "image/webp", q);
    if (b.type !== "image/webp") {
      // 舊版 Safari 不支援 WebP 編碼：先試 PNG（保留透明），太大時改用 JPEG（透明部分填上淺色）
      b = await toBlob(c, "image/png");
      if (b.size >= 110 * 1024) { const f = document.createElement("canvas"); f.width = c.width; f.height = c.height; const fx = f.getContext("2d")!; fx.fillStyle = "#fffaf6"; fx.fillRect(0, 0, f.width, f.height); fx.drawImage(c, 0, 0); b = await toBlob(f, "image/jpeg", q); }
    }
    if (b.size < 110 * 1024) return blobToBase64(b);
  }
  throw new Error("縮圖太大");
}
