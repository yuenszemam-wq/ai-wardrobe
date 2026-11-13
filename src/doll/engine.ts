// 角色換裝的畫布渲染器：身體部件、頭部、髮型、衣物全部畫在同一張 Canvas 上。
// 衣物用連續網格跟隨骨架（shared/garmentMesh.ts）；畫面、造型縮圖及匯出圖片用同一套繪畫程式。
import { Mat, Pose, Rig, applyMat, invert, multiply, solve } from "../../shared/avatarRig";
import { AVATAR_V2_BASE, FrontPart, HairConfig, HairPart, HairStats, HeadConfig, RIG_V2, Rgb, analyzeHair, hairBoneId, recolorHair, rigFor } from "../../shared/avatarV2";
import { Content, DOLL_H, DOLL_W, Fit, FULL_CONTENT, defaultOpts, SLOT_BONE, SLOT_SKIN, Slot, WearOpts, fitHeight, toImage } from "../../shared/doll";
import { GarmentRig, Mesh, PartMap, RigInfo, boneMatrices, buildRig, cellVerts, locate, posedBounds, rigCoverage, skinMesh } from "../../shared/garmentMesh";
import { AlphaGrid, Bitmap, alphaAt, loadImage, pixelsOf } from "./content";

export interface SceneItem {
  key: string;
  image: string;
  slot: Slot;
  fit: Fit;
  content: Content;
  grid: AlphaGrid;
  opts: WearOpts;
  mask: string | null;
  /** 部件圖：null＝自動分辨；"whole"＝不拆件；data URL＝人工標記 */
  parts: string | null;
  hidden: boolean;
}
/** 部件圖 PNG 的像素 → 部件編號（R 通道＝編號 × 50） */
export function decodeParts(px: Uint8ClampedArray, w: number, h: number): PartMap {
  const data = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) data[i] = Math.min(4, Math.round(px[i * 4] / 50));
  return { w, h, data };
}
export interface Scene {
  hair: HairConfig | null;
  head: HeadConfig;
  main: Rgb | null;
  accent: Rgb | null;
  tip: Rgb | null;
  pose: Pose;
  front: FrontPart[];
  items: SceneItem[];
  /** 編輯提示層：顯示這件衣物的遮罩或部件 */
  overlay?: { key: string; mode: "mask" | "parts" } | null;
  /** 衣物原圖視圖：只顯示這件衣物的原圖（平放、不變形、沒有角色），供放大標記部件／遮罩 */
  flat?: string | null;
  /** 顯示這件衣物的變形網格線 */
  wire?: string | null;
}
/** 衣物原圖視圖中，圖片佔邏輯畫布的範圍（置中） */
export function flatRect(ar: number): { x: number; y: number; w: number; h: number } {
  const a = ar > 0 ? ar : 4 / 3;
  const w = Math.min(1040, 1560 / a), h = w * a;
  return { x: (DOLL_W - w) / 2, y: (DOLL_H - h) / 2, w, h };
}
/** 衣物原圖視圖：畫面上的一點（邏輯座標）→ 圖片內的位置（0–1，原圖座標）；圖片範圍以外回傳 null */
export function flatLocate(ar: number, x: number, y: number): [number, number] | null {
  const r = flatRect(ar), u = (x - r.x) / r.w, v = (y - r.y) / r.h;
  return u >= 0 && v >= 0 && u < 1 && v < 1 ? [u, v] : null;
}
export interface View { x: number; y: number; w: number; h: number }
export const VIEWS: Record<string, View & { label: string }> = {
  full: { label: "全身", x: 0, y: 0, w: DOLL_W, h: DOLL_H },
  upper: { label: "上半身", x: 220, y: 0, w: 760, h: 980 },
  head: { label: "頭部", x: 370, y: -20, w: 460, h: 520 },
  lower: { label: "下半身", x: 220, y: 900, w: 760, h: 900 },
};

const HAIR_GRID: AlphaGrid = {w:12,h:12,data:new Uint8Array(144).fill(255)};
const MASK_STEP = 5;
const BAKE_SCALE = 0.8;

/** 衣物整件附接的骨骼 */
export const mainBone = (item: Pick<SceneItem, "slot" | "opts">) => item.opts.bone ?? SLOT_BONE[item.slot];
export { toImage };

/** 字串雜湊（FNV-1a，兩組不同的種子）：遮罩／部件圖的快取以完整內容識別，不會把不同的遮罩誤認為同一個 */
export function hashOf(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b) + i; }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36) + s.length.toString(36);
}
const dims = (b: Bitmap): [number, number] => [(b as HTMLImageElement).naturalWidth || b.width, (b as HTMLImageElement).naturalHeight || b.height];
export interface LiveMask { w: number; h: number; data: Uint8ClampedArray }
interface Worked { front: Bitmap; behind: Bitmap | null; /** 低解像度的「已隱藏／移到身後」格（點選用） */ gone: { w: number; h: number; data: Uint8Array } | null }
interface Geometry { key: string; rig: GarmentRig }
/** 一個部件的貼圖：canvas 是原圖裁出該部件範圍後的一塊，x／y＝它在原圖的位置（原圖像素） */
interface LayerTex { img: Bitmap; x: number; y: number; w: number; h: number; tw: number; th: number; /** 這張貼圖是為這個部件另外製作的（可以釋放） */ own?: boolean }
const gridIds = new WeakMap<object, number>();
let gridSeq = 0;
const gridId = (g: object) => { let id = gridIds.get(g); if (!id) { id = ++gridSeq; gridIds.set(g, id); } return id; };
const OVERLAY_COLOR: Record<number, [number, number, number]> = { 1: [255, 79, 154], 2: [45, 190, 255], 3: [255, 79, 154], 4: [45, 190, 255] };

export class DollRenderer {
  private images = new Map<string, Bitmap | "loading" | "error">();
  private work = new Map<string, Worked>();
  private geo = new Map<string, Geometry>();
  private partMaps = new Map<string, PartMap>();
  private liveMask = new Map<string, { buf: LiveMask; rev: number }>();
  private liveParts = new Map<string, { map: PartMap; rev: number }>();
  private overlayTex: { key: string; canvas: HTMLCanvasElement } | null = null;
  private layerTex = new Map<string, { key: string; tex: LayerTex[] }>();
  private rev = 0;
  private hairPx = new Map<string, HTMLCanvasElement>();
  private hairStats = new WeakMap<HairConfig, HairStats | "pending">();
  private neckMask: HTMLCanvasElement | null = null;
  private temp = document.createElement("canvas");
  onReady: () => void = () => undefined;
  /** 實際貼圖檢查失敗（拆件後布料不完整）的衣物：改用整件衣物 */
  private forceWhole = new Set<string>();
  /** 讀取失敗的圖片（顯示提示用） */
  errors = new Set<string>();

  private img(ref: string): Bitmap | null {
    const hit = this.images.get(ref);
    if (hit && typeof hit !== "string") return hit;
    if (!hit) {
      this.images.set(ref, "loading");
      loadImage(ref).then((i) => { this.images.set(ref, i); this.onReady(); }).catch(() => { this.images.set(ref, "error"); this.errors.add(ref); this.onReady(); });
      if (ref.startsWith("data:") && this.images.size > 400) for (const k of this.images.keys()) { if (k.startsWith("data:") && k !== ref) { this.images.delete(k); if (this.images.size <= 300) break; } }
    }
    return null;
  }
  /** 讓讀取失敗的圖片可以重試 */
  retry() { for (const [k, v] of this.images) if (v === "error") this.images.delete(k); this.errors.clear(); }

  // ───── 編輯中的遮罩／部件（未寫入造型前的即時預覽） ─────
  /** 正在塗抹的遮罩：直接使用像素緩衝，不經 PNG 編碼；null＝結束編輯 */
  setLiveMask(key: string, buf: LiveMask | null) { if (buf) this.liveMask.set(key, { buf, rev: ++this.rev }); else this.liveMask.delete(key); this.onReady(); }
  setLiveParts(key: string, map: PartMap | null) { if (map) this.liveParts.set(key, { map, rev: ++this.rev }); else this.liveParts.delete(key); this.onReady(); }

  /** 套用使用者塗抹的遮罩（R＝隱藏、G＝移到身後）；原圖不變 */
  private worked(it: SceneItem): Worked | null {
    const src = this.img(it.image);
    if (!src) return null;
    const live = this.liveMask.get(it.key);
    if (!live && !it.mask) return { front: src, behind: null, gone: null };
    const key = live ? "live|" + it.key : it.image + "|" + hashOf(it.mask!);
    const hit = this.work.get(key);
    if (hit && (!live || (hit as Worked & { rev?: number }).rev === live.rev)) return hit;
    let maskSrc: CanvasImageSource;
    if (live) {
      const c = document.createElement("canvas");
      c.width = live.buf.w; c.height = live.buf.h;
      c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(live.buf.data), live.buf.w, live.buf.h), 0, 0);
      maskSrc = c;
    } else {
      const mask = this.img(it.mask!);
      if (!mask) return { front: src, behind: null, gone: null };
      maskSrc = mask;
    }
    const [sw, sh] = dims(src);
    const s = Math.min(1, 1200 / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    const m = pixelsOf(maskSrc, w, h).data;
    const front = pixelsOf(src, w, h), back = new ImageData(w, h);
    let any = false;
    for (let i = 0; i < m.length; i += 4) {
      const hide = m[i] / 255, behind = m[i + 1] / 255;
      if (hide <= 0 && behind <= 0) continue;
      const a = front.data[i + 3];
      if (behind > 0) {
        back.data[i] = front.data[i]; back.data[i + 1] = front.data[i + 1]; back.data[i + 2] = front.data[i + 2];
        back.data[i + 3] = Math.round(a * behind * (1 - hide));
        any = any || back.data[i + 3] > 0;
      }
      front.data[i + 3] = Math.round(a * (1 - Math.max(hide, behind)));
    }
    const gw = 96, gh = Math.max(1, Math.round((96 * h) / w)), gone = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { const i = (Math.min(h - 1, Math.floor(((y + 0.5) * h) / gh)) * w + Math.min(w - 1, Math.floor(((x + 0.5) * w) / gw))) * 4; gone[y * gw + x] = Math.max(m[i], m[i + 1]); }
    const put = (d: ImageData) => { const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d")!.putImageData(d, 0, 0); return c; };
    const out: Worked & { rev?: number } = { front: put(front), behind: any ? put(back) : null, gone: { w: gw, h: gh, data: gone }, rev: live?.rev };
    const old = this.work.get(key);
    if (old) for (const c of [old.front, old.behind]) if (c instanceof HTMLCanvasElement) c.width = c.height = 0;
    this.work.set(key, out);
    if (this.work.size > 20) { const k = this.work.keys().next().value!; const o = this.work.get(k)!; for (const c of [o.front, o.behind]) if (c instanceof HTMLCanvasElement) c.width = c.height = 0; this.work.delete(k); }
    return out;
  }

  /** 部件圖（人工標記）：解碼成部件編號格。未讀到時回傳 undefined（暫用自動分辨） */
  private partsOf(it: SceneItem): { map: PartMap | "whole" | null; key: string } | undefined {
    const live = this.liveParts.get(it.key);
    if (live) return { map: live.map, key: "live" + live.rev };
    if (!it.parts) return { map: null, key: "" };
    if (it.parts === "whole") return { map: "whole", key: "whole" };
    const key = hashOf(it.parts);
    let map = this.partMaps.get(key);
    if (!map) {
      const img = this.img(it.parts);
      if (!img) return undefined;
      const [w, h] = dims(img);
      map = decodeParts(pixelsOf(img, w, h).data, w, h);
      this.partMaps.set(key, map);
      if (this.partMaps.size > 60) this.partMaps.delete(this.partMaps.keys().next().value!);
    }
    return { map, key };
  }

  /** 衣物的部件、網格及骨骼權重（位置、部件或穿法改變時才重做） */
  geometry(it: SceneItem): GarmentRig {
    const parts = this.partsOf(it) ?? { map: null, key: "pending" };
    const key = [gridId(it.grid), it.fit.cx, it.fit.cy, it.fit.w, it.fit.rotation, it.fit.sy ?? 1, JSON.stringify(it.fit.mesh ?? []), it.content.ar, it.slot, it.opts.follow, it.opts.bone ?? "", it.opts.sleeve_r ?? 0, it.opts.sleeve_l ?? 0, parts.key].join("|");
    const hit = this.geo.get(it.key);
    if (hit?.key === key) return hit.rig;
    const inp = { grid: it.grid, fit: it.fit, ar: it.content.ar, kind: SLOT_SKIN[it.slot], follow: it.opts.follow, bone: mainBone(it), pinned: !!it.opts.bone, parts: parts.map, sleeveRot: [it.opts.sleeve_r ?? 0, it.opts.sleeve_l ?? 0] as [number, number], loose: it.slot === "top" || it.slot === "outer" };
    let rig = buildRig(inp);
    // 安全網：拆件後各部件合起來必須覆蓋差不多整件布料；否則（例如衣身被誤判而消失）改回整件衣物
    if (this.forceWhole.has(it.key + "|" + key) || (rig.layers.length > 1 && rigCoverage(rig, it.grid) < 0.97)) {
      rig = buildRig({ ...inp, parts: "whole" });
      rig.info.fallback = true;
      rig.info.source = "auto";
    }
    this.geo.set(it.key, { key, rig });
    return rig;
  }
  /** 這件衣物目前怎樣跟隨骨架（顯示說明用） */
  info(it: SceneItem): RigInfo { return this.geometry(it).info; }
  /** 清走已脫下衣物的暫存 */
  prune(keys: Set<string>) {
    for (const k of this.geo.keys()) if (!keys.has(k)) this.geo.delete(k);
    for (const k of this.liveMask.keys()) if (!keys.has(k)) this.liveMask.delete(k);
    for (const k of this.liveParts.keys()) if (!keys.has(k)) this.liveParts.delete(k);
    for (const [k, v] of this.layerTex) if (!keys.has(k.split("|")[0])) { this.freeTex(v.tex); this.layerTex.delete(k); }
  }
  private freeTex(tex: LayerTex[]) { for (const t of tex) if (t.own && t.img instanceof HTMLCanvasElement) t.img.width = t.img.height = 0; }
  /**
   * 各部件的貼圖：原圖 × 該部件的範圍（柔邊）。衣身一層伸入袖根底下，所以袖子移開時不會露出空洞。
   * 逐像素計算（讀出像素 → 乘上部件範圍 → 寫入一張新畫布），不依賴「把一張重複使用的畫布當作遮罩再合成」：
   * 後者在部分瀏覽器（iPhone Safari）會讀到上一次的內容，令衣身一層變成空白。
   * 任何一步失敗都退回整張原圖，衣物保持完整。
   */
  private textures(it: SceneItem, slot: string, src: Bitmap, srcKey: string, rig: GarmentRig): LayerTex[] {
    const [tw, th] = dims(src);
    const plain = (): LayerTex[] => rig.layers.map(() => ({ img: src, x: 0, y: 0, w: tw, h: th, tw, th }));
    if (rig.layers.every((l) => !l.matte)) return plain();
    const id = it.key + "|" + slot, key = srcKey + "|" + rig.matteKey + "|" + rig.layers.length;
    const hit = this.layerTex.get(id);
    if (hit?.key === key) return hit.tex;
    if (hit) { this.freeTex(hit.tex); this.layerTex.delete(id); }
    const g = rig.labels;
    let tex: LayerTex[];
    let broken = false;
    if (it.grid.w !== g.w || it.grid.h !== g.h) return plain();
    try {
      tex = rig.layers.map((l): LayerTex => {
        const m = l.matte;
        if (!m) return { img: src, x: 0, y: 0, w: tw, h: th, tw, th };
        let i0 = g.w, j0 = g.h, i1 = -1, j1 = -1;
        for (let k = 0; k < m.length; k++) if (m[k] > 0) { const i = k % g.w, j = (k - i) / g.w; if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
        if (i1 < 0) { i0 = j0 = 0; i1 = j1 = 0; }
        const x = Math.max(0, Math.floor(((i0 - 1) / g.w) * tw)), y = Math.max(0, Math.floor(((j0 - 1) / g.h) * th));
        const w = Math.max(1, Math.min(tw, Math.ceil(((i1 + 2) / g.w) * tw)) - x), h = Math.max(1, Math.min(th, Math.ceil(((j1 + 2) / g.h) * th)) - y);
        const scratch = document.createElement("canvas");
        scratch.width = w; scratch.height = h;
        const sctx = scratch.getContext("2d", { willReadFrequently: true })!;
        sctx.drawImage(src, x, y, w, h, 0, 0, w, h);
        const d = sctx.getImageData(0, 0, w, h), p = d.data;
        scratch.width = scratch.height = 0;
        // 部件範圍（低解像度）以雙線性內插放大到貼圖解像度
        const fx = g.w / tw, fy = g.h / th;
        const ca = new Int32Array(w), cb = new Int32Array(w), ct = new Float32Array(w);
        for (let px = 0; px < w; px++) { const gx = (x + px + 0.5) * fx - 0.5, a = Math.floor(gx); ca[px] = Math.min(g.w - 1, Math.max(0, a)); cb[px] = Math.min(g.w - 1, Math.max(0, a + 1)); ct[px] = gx - a; }
        for (let py = 0; py < h; py++) {
          const gy = (y + py + 0.5) * fy - 0.5, a = Math.floor(gy), ty = gy - a;
          const ra = Math.min(g.h - 1, Math.max(0, a)) * g.w, rb = Math.min(g.h - 1, Math.max(0, a + 1)) * g.w;
          let i = py * w * 4 + 3;
          for (let px = 0; px < w; px++, i += 4) {
            if (!p[i]) continue;
            const t = ct[px], top = m[ra + ca[px]] * (1 - t) + m[ra + cb[px]] * t, bot = m[rb + ca[px]] * (1 - t) + m[rb + cb[px]] * t, v = top * (1 - ty) + bot * ty;
            if (v < 254.5) p[i] = Math.round((p[i] * v) / 255);
          }
        }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d")!.putImageData(d, 0, 0);
        return { img: c, x, y, w, h, tw, th, own: true };
      });
    } catch {
      broken = true;
      tex = [];
    }
    if (broken) {
      // 改用整件衣物重新建立（下一次繪畫生效）
      this.freeTex(tex);
      const gk = this.geo.get(it.key)?.key;
      if (gk) { this.forceWhole.add(it.key + "|" + gk); this.geo.delete(it.key); queueMicrotask(() => this.onReady()); }
      return plain();
    }
    this.layerTex.set(id, { key, tex });
    return tex;
  }
  private posed(rig: GarmentRig, mats: Record<string, Mat>) { return rig.layers.map((l) => skinMesh(l, mats)); }
  /** 畫面上的一點（邏輯座標）落在這件衣物圖片的哪個位置；已計及目前姿勢下的變形 */
  locate(it: SceneItem, mats: Record<string, Mat>, x: number, y: number): [number, number] | null {
    const rig = this.geometry(it);
    return locate(rig, this.posed(rig, mats), x, y);
  }
  bounds(it: SceneItem, mats: Record<string, Mat>): [number, number, number, number] {
    const rig = this.geometry(it);
    return posedBounds(rig, this.posed(rig, mats));
  }
  /** 點選：由最外層開始，找出該點實際有布料（不是透明、也沒有被遮罩隱藏）的衣物 */
  pick(scene: Scene, mats: Record<string, Mat>, x: number, y: number): string | null {
    for (let i = scene.items.length - 1; i >= 0; i--) {
      const it = scene.items[i];
      if (it.hidden) continue;
      // 手指有一定闊度：附近幾點任何一點碰到布料都算
      for (const [dx, dy] of [[0, 0], [-9, 0], [9, 0], [0, -9], [0, 9]]) {
        const uv = this.locate(it, mats, x + dx, y + dy);
        if (!uv || alphaAt(it.grid, uv[0], uv[1]) < 40) continue;
        const gone = this.worked(it)?.gone;
        if (gone && gone.data[Math.min(gone.h - 1, Math.floor(uv[1] * gone.h)) * gone.w + Math.min(gone.w - 1, Math.floor(uv[0] * gone.w))] > 150) continue;
        return it.key;
      }
    }
    return null;
  }

  /**
   * 用連續網格把一張圖畫到目前姿勢：整格跟隨同一節骨骼的合併成一次繪畫，
   * 骨骼之間過渡的格逐個三角形做仿射貼圖。相鄰三角形共用頂點，所以布料不會斷開。
   */
  private drawMesh(c: CanvasRenderingContext2D, tx: LayerTex, it: SceneItem, mesh: Mesh, posed: Float32Array, bm: Mat[], pre: Mat) {
    const { tw, th } = tx, tex = tx.img;
    const f = it.fit, H = fitHeight(f, it.content.ar), t = (f.rotation * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    // 圖片像素 → 靜止畫布座標
    const F: Mat = [(f.w / tw) * cos, (f.w / tw) * sin, (-H / th) * sin, (H / th) * cos, f.cx - 0.5 * f.w * cos + 0.5 * H * sin, f.cy - 0.5 * f.w * sin - 0.5 * H * cos];
    if (mesh.bones.length === 1 && !f.mesh) {
      const m = multiply(pre, multiply(bm[0], F));
      c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      c.drawImage(tex, tx.x, tx.y, tx.w, tx.h);
      return;
    }
    const order = mesh.order, cols = mesh.cols;
    for (let n = 0; n < order.length; ) {
      const b = mesh.cell[order[n]];
      if (b >= 0) {
        // 一批跟隨同一節骨骼的格：一個裁剪範圍、一次繪畫
        const m = multiply(pre, multiply(bm[b], F));
        const e = 0.7 / Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]) || 1);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        c.save();
        c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        c.beginPath();
        for (; n < order.length && mesh.cell[order[n]] === b; n++) {
          const k = order[n], col = k % cols, row = (k - col) / cols, a = row * (cols + 1) + col, d = a + cols + 2;
          const ax = mesh.uv[a * 2] * tw, ay = mesh.uv[a * 2 + 1] * th, dx = mesh.uv[d * 2] * tw, dy = mesh.uv[d * 2 + 1] * th;
          c.rect(ax - e, ay - e, dx - ax + 2 * e, dy - ay + 2 * e);
          if (ax < x0) x0 = ax; if (ay < y0) y0 = ay; if (dx > x1) x1 = dx; if (dy > y1) y1 = dy;
        }
        c.clip();
        x0 = Math.max(tx.x, Math.floor(x0 - 2)); y0 = Math.max(tx.y, Math.floor(y0 - 2)); x1 = Math.min(tx.x + tx.w, Math.ceil(x1 + 2)); y1 = Math.min(tx.y + tx.h, Math.ceil(y1 + 2));
        if (x1 > x0 && y1 > y0) c.drawImage(tex, x0 - tx.x, y0 - tx.y, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
        c.restore();
        continue;
      }
      const k = order[n++], col = k % cols, row = (k - col) / cols, a = row * (cols + 1) + col;
      this.tri(c, tx, mesh, posed, pre, a, a + 1, a + cols + 1);
      this.tri(c, tx, mesh, posed, pre, a + 1, a + cols + 2, a + cols + 1);
    }
  }
  private tri(c: CanvasRenderingContext2D, tx: LayerTex, mesh: Mesh, posed: Float32Array, pre: Mat, i0: number, i1: number, i2: number) {
    const { tw, th } = tx;
    const sx0 = mesh.uv[i0 * 2] * tw, sy0 = mesh.uv[i0 * 2 + 1] * th, sx1 = mesh.uv[i1 * 2] * tw, sy1 = mesh.uv[i1 * 2 + 1] * th, sx2 = mesh.uv[i2 * 2] * tw, sy2 = mesh.uv[i2 * 2 + 1] * th;
    const [dx0, dy0] = applyMat(pre, posed[i0 * 2], posed[i0 * 2 + 1]), [dx1, dy1] = applyMat(pre, posed[i1 * 2], posed[i1 * 2 + 1]), [dx2, dy2] = applyMat(pre, posed[i2 * 2], posed[i2 * 2 + 1]);
    const det = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
    if (Math.abs(det) < 1e-6) return;
    const a = ((dx1 - dx0) * (sy2 - sy0) - (dx2 - dx0) * (sy1 - sy0)) / det, cc = ((dx2 - dx0) * (sx1 - sx0) - (dx1 - dx0) * (sx2 - sx0)) / det;
    const b = ((dy1 - dy0) * (sy2 - sy0) - (dy2 - dy0) * (sy1 - sy0)) / det, d = ((dy2 - dy0) * (sx1 - sx0) - (dy1 - dy0) * (sx2 - sx0)) / det;
    const e = dx0 - a * sx0 - cc * sy0, f = dy0 - b * sx0 - d * sy0;
    // 裁剪範圍向外擴少許，蓋住三角形之間的抗鋸齒接縫
    const gx = (dx0 + dx1 + dx2) / 3, gy = (dy0 + dy1 + dy2) / 3;
    const out = (x: number, y: number): [number, number] => { const l = Math.hypot(x - gx, y - gy) || 1; return [x + ((x - gx) / l) * 1.1, y + ((y - gy) / l) * 1.1]; };
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.beginPath();
    c.moveTo(...out(dx0, dy0)); c.lineTo(...out(dx1, dy1)); c.lineTo(...out(dx2, dy2));
    c.closePath();
    c.clip();
    c.setTransform(a, b, cc, d, e, f);
    const x0 = Math.max(tx.x, Math.floor(Math.min(sx0, sx1, sx2) - 3)), y0 = Math.max(tx.y, Math.floor(Math.min(sy0, sy1, sy2) - 3)), x1 = Math.min(tx.x + tx.w, Math.ceil(Math.max(sx0, sx1, sx2) + 3)), y1 = Math.min(tx.y + tx.h, Math.ceil(Math.max(sy0, sy1, sy2) + 3));
    if (x1 > x0 && y1 > y0) c.drawImage(tx.img, x0 - tx.x, y0 - tx.y, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    c.restore();
  }

  /** 編輯時的提示層：遮罩（紅＝已隱藏、藍＝移到身後）或部件（粉紅＝右袖、藍＝左袖） */
  private overlay(it: SceneItem, mode: "mask" | "parts", rig: GarmentRig): { canvas: HTMLCanvasElement; key: string } | null {
    const src = this.img(it.image);
    if (!src) return null;
    const live = this.liveMask.get(it.key), lp = this.liveParts.get(it.key);
    const key = [it.key, it.image, mode, mode === "mask" ? (live ? "live" + live.rev : it.mask ? hashOf(it.mask) : "") : (lp ? "live" + lp.rev : this.geo.get(it.key)?.key)].join("|");
    if (this.overlayTex?.key === key) return this.overlayTex;
    const [sw, sh] = dims(src);
    const w = Math.min(420, sw), h = Math.max(1, Math.round((w * sh) / sw));
    const px = pixelsOf(src, w, h);
    if (mode === "mask") {
      let m: Uint8ClampedArray | null = null;
      if (live) { const c = document.createElement("canvas"); c.width = live.buf.w; c.height = live.buf.h; c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(live.buf.data), live.buf.w, live.buf.h), 0, 0); m = pixelsOf(c, w, h).data; }
      else if (it.mask) { const mi = this.img(it.mask); if (!mi) return null; m = pixelsOf(mi, w, h).data; }
      for (let i = 0; i < px.data.length; i += 4) {
        const hide = m ? m[i] : 0, behind = m ? m[i + 1] : 0, a = px.data[i + 3];
        if (hide > 20) { px.data[i] = 255; px.data[i + 1] = 40; px.data[i + 2] = 80; px.data[i + 3] = Math.round((a * hide) / 255); }
        else if (behind > 20) { px.data[i] = 40; px.data[i + 1] = 120; px.data[i + 2] = 255; px.data[i + 3] = Math.round((a * behind) / 255); }
        else px.data[i + 3] = 0;
      }
    } else {
      const g = rig.labels;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, col = OVERLAY_COLOR[g.data[Math.min(g.h - 1, Math.floor(((y + 0.5) / h) * g.h)) * g.w + Math.min(g.w - 1, Math.floor(((x + 0.5) / w) * g.w))]];
        if (col) { px.data[i] = col[0]; px.data[i + 1] = col[1]; px.data[i + 2] = col[2]; } else px.data[i + 3] = 0;
      }
    }
    // 每次用一張新的畫布（不重複使用舊畫布：部分瀏覽器把重用的畫布當作貼圖時會讀到舊內容）
    if (this.overlayTex) this.overlayTex.canvas.width = this.overlayTex.canvas.height = 0;
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d")!.putImageData(px, 0, 0);
    this.overlayTex = { key, canvas };
    return this.overlayTex;
  }

  private hairImage(hair: HairConfig, part: HairPart, scene: Scene): Bitmap | null {
    const src = this.img(part.file);
    if (!src) return null;
    if (!scene.main && !scene.accent && !scene.tip) return src;
    const key = [part.file, part.mask??"", scene.main, scene.accent, scene.tip, part.y, part.h, hair.parts.map(p=>[p.file,p.y,p.h]).join(";")].join("|");
    const hit = this.hairPx.get(key);
    if (hit) return hit;
    const mask = part.mask ? this.img(part.mask) : null;
    if (part.mask && !mask) return src;
    let stats: HairStats | null = null;
    if (!part.mask) {
      const st = this.hairStats.get(hair);
      if (!st) {
        // 整款髮型一起分析一次，各部件的主髮色才一致
        const srcs = hair.parts.filter((p) => !p.mask).map((p) => this.img(p.file));
        if (srcs.some((s) => !s)) return src;
        this.hairStats.set(hair, analyzeHair(srcs.map((s) => { const b = s as HTMLImageElement; const f = Math.min(1, 200 / Math.max(b.naturalWidth || b.width, b.naturalHeight || b.height)); return pixelsOf(b, Math.max(1, Math.round((b.naturalWidth || b.width) * f)), Math.max(1, Math.round((b.naturalHeight || b.height) * f))).data; })));
      }
      stats = this.hairStats.get(hair) as HairStats;
    }
    const b = src as HTMLImageElement;
    const sw = b.naturalWidth || b.width, sh = b.naturalHeight || b.height;
    const f = Math.min(1, 1100 / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * f)), h = Math.max(1, Math.round(sh * f));
    const data = pixelsOf(src, w, h);
    const ref = hair.ref_luma ?? (stats ? { main: stats.main, accent: stats.accent } : { main: 0.33, accent: 0.6 });
    // 髮尾漸層按整款髮型的高度計算（由 55% 開始，到 92% 完全變色）
    let tip = null;
    if (scene.tip) {
      const top = Math.min(...hair.parts.map((p) => p.y)), bottom = Math.max(...hair.parts.map((p) => p.y + p.h));
      const row = (cy: number) => ((cy - part.y) / part.h) * h;
      tip = { color: scene.tip, row0: row(top + (bottom - top) * 0.55), row1: row(top + (bottom - top) * 0.92) };
    }
    recolorHair(data.data, mask ? pixelsOf(mask, w, h).data : null, { main: scene.main, accent: scene.accent, ref, stats, tip, width: w });
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    canvas.getContext("2d")!.putImageData(data, 0, 0);
    this.hairPx.set(key, canvas);
    if (this.hairPx.size > 40) { const k = this.hairPx.keys().next().value!; this.hairPx.get(k)!.width = 0; this.hairPx.delete(k); }
    return canvas;
  }

  /** 頸部（上半）的遮罩：用來把頸部顯示在衣服後領前面 */
  private neck(): { mask: HTMLCanvasElement; img: Bitmap } | null {
    const p = RIG_V2.parts.neck;
    const img = this.img(AVATAR_V2_BASE + p.src);
    if (!img) return null;
    if (!this.neckMask) {
      const c = document.createElement("canvas");
      c.width = p.w; c.height = p.h;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, p.w, p.h);
      ctx.globalCompositeOperation = "destination-in";
      const fade = RIG_V2.anchors.neck[1] - p.y; // 頸根以下屬於領口位置，不遮
      const g = ctx.createLinearGradient(0, fade - 22, 0, fade - 2);
      g.addColorStop(0, "#000"); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, p.w, p.h);
      this.neckMask = c;
    }
    return { mask: this.neckMask, img };
  }

  /**
   * 繪畫整個角色。base＝邏輯座標 → 畫布像素的矩陣。回傳是否全部圖片已就緒（未就緒的會在讀取後觸發 onReady）。
   */
  paint(ctx: CanvasRenderingContext2D, scene: Scene, base: Mat): boolean {
    if (scene.flat) { const it = scene.items.find((i) => i.key === scene.flat); if (it) return this.paintFlat(ctx, it, scene, base); }
    let complete = true;
    const rig: Rig = rigFor(scene.hair);
    const mats = solve(rig, scene.pose);
    const T = (bone: string) => multiply(base, mats[bone] ?? mats.root);
    const set = (m: Mat) => ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const part = (src: string, x: number, y: number, w: number, h: number, bone: string) => {
      const img = this.img(src);
      if (!img) { complete = false; return; }
      set(T(bone));
      ctx.drawImage(img, x, y, w, h);
    };
    const hair = (layer: string) => {
      if (!scene.hair) return;
      for (const p of scene.hair.parts) {
        if (p.layer !== layer || p.hidden) continue;
        const img = this.hairImage(scene.hair, p, scene);
        if (!img) { complete = false; continue; }
        const bone=hairBoneId(p);
        if(p.mesh || p.rotation) {
          const fit:Fit={cx:p.x+p.w/2,cy:p.y+p.h/2,w:p.w,rotation:p.rotation??0,mesh:p.mesh};
          const it:SceneItem={key:"hair:"+p.id,image:p.file,slot:"headwear",fit,content:FULL_CONTENT(p.h/p.w),grid:HAIR_GRID,opts:{...defaultOpts("headwear"),follow:"none",bone},mask:null,parts:null,hidden:false};
          const geo=this.geometry(it),[tw,th]=dims(img); const tex={img,x:0,y:0,w:tw,h:th,tw,th};
          for(const m of geo.layers){const bm=boneMatrices(m,mats);this.drawMesh(ctx,tex,it,m,skinMesh(m,mats,bm),bm,base);}
        } else {set(T(bone));ctx.drawImage(img,p.x,p.y,p.w,p.h);}
      }
    };
    interface Ready { w: Worked; wkey: string; rig: GarmentRig; posed: Float32Array[]; bm: Mat[][] }
    const layers = (c: CanvasRenderingContext2D, it: SceneItem, r: Ready, tex: LayerTex[], pre: Mat) => r.rig.layers.forEach((l, i) => this.drawMesh(c, tex[i], it, l, r.posed[i], r.bm[i], pre));
    const drawItem = (c: CanvasRenderingContext2D, it: SceneItem, r: Ready, pre: Mat) => layers(c, it, r, this.textures(it, "front", r.w.front, r.wkey, r.rig), pre);

    ctx.save();
    ctx.imageSmoothingQuality = "high";
    hair("back");
    const visible = scene.items.filter((it) => !it.hidden);
    const ready = new Map<string, Ready>();
    for (const it of visible) {
      const w = this.worked(it);
      if (!w) { complete = false; continue; }
      if (it.parts && it.parts !== "whole" && !this.partsOf(it)) complete = false;
      const live = this.liveMask.get(it.key);
      const rig = this.geometry(it), bm = rig.layers.map((l) => boneMatrices(l, mats));
      const r: Ready = { w, wkey: it.image + "|" + (live ? "live" + live.rev : it.mask && w.gone ? hashOf(it.mask) : ""), rig, posed: rig.layers.map((l, i) => skinMesh(l, mats, bm[i])), bm };
      ready.set(it.key, r);
      // 「移到身後」的部分用同一組網格變形，與前面的部分保持同步
      if (w.behind) layers(ctx, it, r, this.textures(it, "behind", w.behind, r.wkey, rig), base);
    }
    const front = new Set<string>(scene.front);
    for (const name of RIG_V2.body_parts) {
      if (name === "head" || front.has(name)) continue;
      const p = RIG_V2.parts[name];
      part(AVATAR_V2_BASE + p.src, p.x, p.y, p.w, p.h, p.bone);
    }
    const body = (over: boolean) => {
      for (const it of visible) {
        if (it.opts.over_head !== over) continue;
        const r = ready.get(it.key);
        if (!r) continue;
        drawItem(ctx, it, r, base);
        if (it.opts.neck && !over) this.neckOver(ctx, (c, pre) => drawItem(c, it, r, pre), base, mats);
      }
    };
    body(false);
    hair("mid");
    for (const name of scene.front) {
      const p = RIG_V2.parts[name];
      if (p) part(AVATAR_V2_BASE + p.src, p.x, p.y, p.w, p.h, p.bone);
    }
    part(scene.head.file, scene.head.x, scene.head.y, scene.head.w, scene.head.h, "head");
    hair("front");
    body(true);
    const ov = scene.overlay ? visible.find((it) => it.key === scene.overlay!.key) : null;
    if (ov && ready.has(ov.key)) {
      const r = ready.get(ov.key)!, o = this.overlay(ov, scene.overlay!.mode, r.rig);
      if (o) { ctx.globalAlpha = 0.55; layers(ctx, ov, r, this.textures(ov, "overlay", o.canvas, o.key, r.rig), base); ctx.globalAlpha = 1; }
    }
    const wi = scene.wire ? visible.find((it) => it.key === scene.wire) : null;
    if (wi && ready.has(wi.key)) {
      // 變形網格：每一格的邊線（衣身白色、右袖粉紅、左袖藍色）
      const r = ready.get(wi.key)!;
      set(base);
      ctx.lineWidth = 1 / Math.max(0.05, Math.hypot(base[0], base[1]));
      r.rig.layers.forEach((mesh, li) => {
        const P = r.posed[li], col = OVERLAY_COLOR[mesh.part];
        ctx.strokeStyle = col ? `rgb(${col[0]} ${col[1]} ${col[2]} / 0.9)` : "rgb(255 255 255 / 0.8)";
        ctx.beginPath();
        for (const k of mesh.order) { const [a, b, c, d] = cellVerts(mesh, k); ctx.moveTo(P[a * 2], P[a * 2 + 1]); ctx.lineTo(P[b * 2], P[b * 2 + 1]); ctx.lineTo(P[d * 2], P[d * 2 + 1]); ctx.lineTo(P[c * 2], P[c * 2 + 1]); ctx.closePath(); ctx.moveTo(P[b * 2], P[b * 2 + 1]); ctx.lineTo(P[c * 2], P[c * 2 + 1]); }
        ctx.stroke();
      });
    }
    ctx.restore();
    return complete;
  }

  /** 衣物原圖視圖：完整的原始衣物（不變形、沒有角色），上面以半透明顏色標示部件或遮罩 */
  private paintFlat(ctx: CanvasRenderingContext2D, it: SceneItem, scene: Scene, base: Mat): boolean {
    const src = this.img(it.image);
    if (!src) return false;
    const r = flatRect(it.content.ar);
    ctx.save();
    ctx.setTransform(base[0], base[1], base[2], base[3], base[4], base[5]);
    ctx.imageSmoothingQuality = "high";
    // 底板：淺色格仔，看得清透明位置及淺色布料
    ctx.fillStyle = "rgb(255 255 255 / 0.9)";
    ctx.fillRect(r.x - 12, r.y - 12, r.w + 24, r.h + 24);
    ctx.fillStyle = "rgb(120 90 120 / 0.10)";
    const q = 40;
    for (let j = 0; j * q < r.h + 24; j++) for (let i = j % 2; i * q < r.w + 24; i += 2) ctx.fillRect(r.x - 12 + i * q, r.y - 12 + j * q, Math.min(q, r.w + 24 - i * q), Math.min(q, r.h + 24 - j * q));
    ctx.drawImage(src, r.x, r.y, r.w, r.h);
    let complete = true;
    if (scene.overlay && scene.overlay.key === it.key) {
      if (it.parts && it.parts !== "whole" && !this.partsOf(it)) complete = false;
      const o = this.overlay(it, scene.overlay.mode, this.geometry(it));
      if (o) { ctx.globalAlpha = 0.6; ctx.drawImage(o.canvas, r.x, r.y, r.w, r.h); ctx.globalAlpha = 1; } else complete = false;
    }
    ctx.restore();
    return complete;
  }

  /** 把頸部重畫在這件衣物之上，但只限衣物蓋住頸部的位置（後領）。之後穿上的頸飾仍會在頸部前面。 */
  private neckOver(ctx: CanvasRenderingContext2D, draw: (c: CanvasRenderingContext2D, pre: Mat) => void, base: Mat, mats: Record<string, Mat>) {
    const n = this.neck();
    if (!n) return;
    const p = RIG_V2.parts.neck;
    const m = multiply(base, mats.neck);
    const corners = [[p.x, p.y], [p.x + p.w, p.y], [p.x, p.y + p.h], [p.x + p.w, p.y + p.h]].map(([x, y]) => applyMat(m, x, y));
    const x0 = Math.floor(Math.min(...corners.map((c) => c[0]))) - 1, y0 = Math.floor(Math.min(...corners.map((c) => c[1]))) - 1;
    const w = Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1 - x0, h = Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1 - y0;
    if (w < 2 || h < 2 || w > 4000 || h > 4000) return;
    const t = this.temp;
    if (t.width < w || t.height < h) { t.width = Math.max(t.width, w); t.height = Math.max(t.height, h); }
    const c = t.getContext("2d")!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-over";
    c.clearRect(0, 0, t.width, t.height);
    const pre: Mat = [base[0], base[1], base[2], base[3], base[4] - x0, base[5] - y0];
    draw(c, pre);
    const nm = multiply(pre, mats.neck);
    c.setTransform(nm[0], nm[1], nm[2], nm[3], nm[4], nm[5]);
    c.globalCompositeOperation = "destination-in";
    c.drawImage(n.mask, p.x, p.y, p.w, p.h);
    c.globalCompositeOperation = "source-in";
    c.drawImage(n.img, p.x, p.y, p.w, p.h);
    c.globalCompositeOperation = "source-over";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(t, 0, 0, w, h, x0, y0, w, h);
  }

  /** 造型縮圖：實際組裝完成的角色畫面（JPEG，約 20–40 KB） */
  async thumbnail(scene: Scene, width = 360): Promise<Blob | null> {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = Math.round((width * DOLL_H) / DOLL_W);
    const ctx = canvas.getContext("2d")!;
    const k = width / DOLL_W;
    const once = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
      g.addColorStop(0, "#f7f0f6"); g.addColorStop(1, "#e6d6ea");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return this.paint(ctx, scene, [k, 0, 0, k, 0, 0]);
    };
    const prev = this.onReady;
    try {
      for (let i = 0; i < 80; i++) {
        let ready = false;
        const wait = new Promise<void>((r) => { this.onReady = () => { prev(); r(); }; });
        ready = once();
        if (ready) break;
        if (this.errors.size) return null; // 有圖片讀取失敗：不保存不完整的縮圖
        await Promise.race([wait, new Promise((r) => setTimeout(r, 400))]);
      }
    } finally {
      this.onReady = prev;
    }
    if (!once()) return null;
    return new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", 0.84));
  }
}

/** 螢幕上的一點對應衣物靜止座標（把已選衣物的拖動換算回「相對骨骼」的位置） */
export function toRest(mats: Record<string, Mat>, bone: string, x: number, y: number): [number, number] {
  return applyMat(invert(mats[bone] ?? mats.root), x, y);
}
