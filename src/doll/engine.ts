// 角色換裝的畫布渲染器：身體部件、頭部、髮型、衣物全部畫在同一張 Canvas 上。
// 衣物按身體區域分成柔邊區域跟隨骨架（shared/skin.ts）；畫面與造型縮圖用同一套繪畫程式。
import { Mat, Pose, Rig, applyMat, invert, multiply, solve } from "../../shared/avatarRig";
import { AVATAR_V2_BASE, FrontPart, HairConfig, HairPart, HairStats, HeadConfig, RIG_V2, Rgb, analyzeHair, hairBoneId, recolorHair, rigFor } from "../../shared/avatarV2";
import { Content, DOLL_H, DOLL_W, Fit, SLOT_BONE, SLOT_SKIN, Slot, WearOpts } from "../../shared/doll";
import { armSamples, findSleeveGap, legSamples, skinMasks } from "../../shared/skin";
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
  hidden: boolean;
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
}
export interface View { x: number; y: number; w: number; h: number }
export const VIEWS: Record<string, View & { label: string }> = {
  full: { label: "全身", x: 0, y: 0, w: DOLL_W, h: DOLL_H },
  upper: { label: "上半身", x: 220, y: 0, w: 760, h: 980 },
  head: { label: "頭部", x: 370, y: -20, w: 460, h: 520 },
  lower: { label: "下半身", x: 220, y: 900, w: 760, h: 900 },
};

const MASK_STEP = 5;
const BAKE_SCALE = 0.8;

/** 衣物是否跟隨手腳：auto 時按圖片內容判斷（有沒有袖子、袖子是否長到前臂） */
export function resolveFollow(item: Pick<SceneItem, "slot" | "fit" | "content" | "grid" | "opts">): "none" | "upper" | "full" {
  const kind = SLOT_SKIN[item.slot];
  if (kind === "rigid" || item.opts.bone) return "none";
  if (item.opts.follow !== "auto") return item.opts.follow;
  const covered = (pts: [number, number][]) => pts.filter(([x, y]) => { const [u, v] = toImage(item.fit, item.content.ar, x, y); return alphaAt(item.grid, u, v) > 60; }).length / pts.length;
  if (kind === "legs") return covered(legSamples()) > 0.2 ? "full" : "none";
  const s = armSamples();
  const opaque = (x: number, y: number) => { const [u, v] = toImage(item.fit, item.content.ar, x, y); return alphaAt(item.grid, u, v) > 50; };
  // 衣物輪廓有明顯的袖子（與衣身之間有空隙）：整隻袖跟隨手臂
  const lower = covered(s.lower);
  // 衣物輪廓有明顯的袖子：袖子沿著手臂的才連前臂一起彎曲，否則整隻袖跟隨上臂（較闊或垂直的袖）
  if (findSleeveGap(opaque, "r") || findSleeveGap(opaque, "l")) return lower >= 0.6 ? "full" : "upper";
  if (covered(s.upper) < 0.45) return "none";
  if (item.slot === "top" || item.slot === "outer") return lower >= 0.6 ? "full" : "upper";
  // 連身裙／整套：前臂位置可能是裙身而不是袖子。前臂被蓋住而外側沒有布料，才當作長袖
  return lower >= 0.75 && covered(s.outside) < 0.4 ? "full" : "upper";
}
/** 靜止畫布座標 → 圖片內的位置（0–1） */
export function toImage(fit: Fit, ar: number, x: number, y: number): [number, number] {
  const t = (-fit.rotation * Math.PI) / 180;
  const dx = x - fit.cx, dy = y - fit.cy;
  const h = fit.w * (ar > 0 ? ar : 4 / 3);
  return [(dx * Math.cos(t) - dy * Math.sin(t)) / fit.w + 0.5, (dx * Math.sin(t) + dy * Math.cos(t)) / h + 0.5];
}
/** 衣物整件附接的骨骼 */
export const mainBone = (item: Pick<SceneItem, "slot" | "opts">) => item.opts.bone ?? SLOT_BONE[item.slot];

interface Baked { key: string; segs: { bone: string; canvas: Bitmap; x: number; y: number; w: number; h: number }[]; behind: { canvas: Bitmap } | null }
const keyOf = (it: SceneItem, follow: string) => [it.image, it.fit.cx, it.fit.cy, it.fit.w, it.fit.rotation, follow, it.mask ? it.mask.length + ":" + it.mask.slice(-24) : "", it.opts.bone ?? ""].join("|");

export class DollRenderer {
  private images = new Map<string, Bitmap | "loading" | "error">();
  private work = new Map<string, { front: Bitmap; behind: Bitmap | null }>();
  private baked = new Map<string, Baked>();
  private hairPx = new Map<string, HTMLCanvasElement>();
  private hairStats = new WeakMap<HairConfig, HairStats | "pending">();
  private neckMask: HTMLCanvasElement | null = null;
  private temp = document.createElement("canvas");
  private maskCanvas = document.createElement("canvas");
  onReady: () => void = () => undefined;
  /** 讀取失敗的圖片（顯示提示用） */
  errors = new Set<string>();

  private img(ref: string): Bitmap | null {
    const hit = this.images.get(ref);
    if (hit && typeof hit !== "string") return hit;
    if (!hit) {
      this.images.set(ref, "loading");
      loadImage(ref).then((i) => { this.images.set(ref, i); this.onReady(); }).catch(() => { this.images.set(ref, "error"); this.errors.add(ref); this.onReady(); });
    }
    return null;
  }
  /** 讓讀取失敗的圖片可以重試 */
  retry() { for (const [k, v] of this.images) if (v === "error") this.images.delete(k); this.errors.clear(); }

  /** 套用使用者塗抹的遮罩（R＝隱藏、G＝移到身後）；原圖不變 */
  private worked(it: SceneItem): { front: Bitmap; behind: Bitmap | null } | null {
    const src = this.img(it.image);
    if (!src) return null;
    if (!it.mask) return { front: src, behind: null };
    const key = it.image + "|" + it.mask.length + it.mask.slice(-32);
    const hit = this.work.get(key);
    if (hit) return hit;
    const mask = this.img(it.mask);
    if (!mask) return { front: src, behind: null };
    const sw = (src as HTMLImageElement).naturalWidth || src.width, sh = (src as HTMLImageElement).naturalHeight || src.height;
    const s = Math.min(1, 1200 / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * s)), h = Math.max(1, Math.round(sh * s));
    const m = pixelsOf(mask, w, h).data;
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
    const put = (d: ImageData) => { const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d")!.putImageData(d, 0, 0); return c; };
    const out = { front: put(front), behind: any ? put(back) : null };
    this.work.set(key, out);
    if (this.work.size > 24) this.work.delete(this.work.keys().next().value!);
    return out;
  }

  /** 把衣物按骨骼區域預先切好（位置或圖片改變時才重做） */
  private bake(it: SceneItem): Baked | null {
    const follow = resolveFollow(it);
    const key = keyOf(it, follow);
    const hit = this.baked.get(it.key);
    if (hit?.key === key) return hit;
    const w = this.worked(it);
    if (!w) return null;
    const out: Baked = { key, segs: [], behind: w.behind ? { canvas: w.behind } : null };
    const kind = SLOT_SKIN[it.slot];
    if (follow !== "none" && kind !== "rigid") {
      const h = it.fit.w * it.content.ar;
      const t = (it.fit.rotation * Math.PI) / 180, c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
      const bw = (it.fit.w * c + h * s) / 2, bh = (it.fit.w * s + h * c) / 2;
      // 只計算衣物覆蓋的範圍；上身衣物先由輪廓找出袖子與衣身之間的空隙，按衣物實際形狀分區
      const gx0 = Math.max(-400, it.fit.cx - bw), gy0 = Math.max(-400, it.fit.cy - bh), gx1 = Math.min(DOLL_W + 400, it.fit.cx + bw), gy1 = Math.min(DOLL_H + 400, it.fit.cy + bh);
      const grid = { x0: gx0, y0: gy0, w: Math.max(1, Math.ceil((gx1 - gx0) / MASK_STEP)), h: Math.max(1, Math.ceil((gy1 - gy0) / MASK_STEP)), step: MASK_STEP };
      const opaque = (x: number, y: number) => { const [u, v] = toImage(it.fit, it.content.ar, x, y); return alphaAt(it.grid, u, v) > 50; };
      const open = it.slot === "top" || it.slot === "outer";
      const gaps = kind === "upper" ? { r: findSleeveGap(opaque, "r", open), l: findSleeveGap(opaque, "l", open) } : undefined;
      const mc = this.maskCanvas;
      mc.width = grid.w; mc.height = grid.h;
      const mctx = mc.getContext("2d")!;
      const md = mctx.createImageData(grid.w, grid.h);
      for (const seg of skinMasks(kind, follow === "full", grid, gaps)) {
        let i0 = grid.w, j0 = grid.h, i1 = -1, j1 = -1;
        for (let i = 0; i < seg.alpha.length; i++) {
          md.data[i * 4 + 3] = seg.alpha[i];
          if (seg.alpha[i] > 2) { const ci = i % grid.w, cj = (i - ci) / grid.w; if (ci < i0) i0 = ci; if (ci > i1) i1 = ci; if (cj < j0) j0 = cj; if (cj > j1) j1 = cj; }
        }
        if (i1 < 0) continue;
        mctx.putImageData(md, 0, 0);
        // 只保留這個區域實際佔用的範圍（節省記憶體）
        const x0 = gx0 + Math.max(0, i0 - 1) * MASK_STEP, y0 = gy0 + Math.max(0, j0 - 1) * MASK_STEP, x1 = Math.min(gx1, gx0 + (i1 + 2) * MASK_STEP), y1 = Math.min(gy1, gy0 + (j1 + 2) * MASK_STEP);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.ceil((x1 - x0) * BAKE_SCALE)); canvas.height = Math.max(1, Math.ceil((y1 - y0) * BAKE_SCALE));
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(BAKE_SCALE, 0, 0, BAKE_SCALE, -x0 * BAKE_SCALE, -y0 * BAKE_SCALE);
        ctx.translate(it.fit.cx, it.fit.cy);
        ctx.rotate(t);
        ctx.drawImage(w.front, -it.fit.w / 2, -h / 2, it.fit.w, h);
        ctx.setTransform(BAKE_SCALE, 0, 0, BAKE_SCALE, -x0 * BAKE_SCALE, -y0 * BAKE_SCALE);
        ctx.globalCompositeOperation = "destination-in";
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(mc, gx0, gy0, grid.w * MASK_STEP, grid.h * MASK_STEP);
        out.segs.push({ bone: seg.bone, canvas, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
    }
    const old = this.baked.get(it.key);
    if (old) for (const s of old.segs) if (s.canvas instanceof HTMLCanvasElement) s.canvas.width = s.canvas.height = 0; // 即時釋放記憶體
    this.baked.set(it.key, out);
    return out;
  }
  /** 清走已脫下衣物的暫存 */
  prune(keys: Set<string>) {
    for (const [k, b] of this.baked) if (!keys.has(k)) { for (const s of b.segs) if (s.canvas instanceof HTMLCanvasElement) s.canvas.width = s.canvas.height = 0; this.baked.delete(k); }
  }

  private hairImage(hair: HairConfig, part: HairPart, scene: Scene): Bitmap | null {
    const src = this.img(part.file);
    if (!src) return null;
    if (!scene.main && !scene.accent && !scene.tip) return src;
    const key = [part.file, scene.main, scene.accent, scene.tip, part.y, part.h].join("|");
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
        if (p.layer !== layer) continue;
        const img = this.hairImage(scene.hair, p, scene);
        if (!img) { complete = false; continue; }
        set(T(hairBoneId(p)));
        ctx.drawImage(img, p.x, p.y, p.w, p.h);
      }
    };
    const drawItem = (c: CanvasRenderingContext2D, it: SceneItem, b: Baked, pre: Mat) => {
      const TT = (bone: string) => multiply(pre, mats[bone] ?? mats.root);
      if (b.segs.length) {
        for (const s of b.segs) {
          const m = TT(s.bone);
          c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          c.drawImage(s.canvas, s.x, s.y, s.w, s.h);
        }
        return;
      }
      const w = this.worked(it);
      if (!w) return;
      this.rigid(c, w.front, it, TT(mainBone(it)));
    };

    ctx.save();
    ctx.imageSmoothingQuality = "high";
    hair("back");
    const visible = scene.items.filter((it) => !it.hidden);
    const bakes = new Map<string, Baked>();
    for (const it of visible) {
      const b = this.bake(it);
      if (!b) { complete = false; continue; }
      bakes.set(it.key, b);
      if (b.behind) this.rigid(ctx, b.behind.canvas, it, T(mainBone(it)));
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
        const b = bakes.get(it.key);
        if (!b) continue;
        drawItem(ctx, it, b, base);
        if (it.opts.neck && !over) this.neckOver(ctx, it, b, base, mats, drawItem);
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
    ctx.restore();
    return complete;
  }

  private rigid(ctx: CanvasRenderingContext2D, img: Bitmap, it: SceneItem, m: Mat) {
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.translate(it.fit.cx, it.fit.cy);
    ctx.rotate((it.fit.rotation * Math.PI) / 180);
    const h = it.fit.w * it.content.ar;
    ctx.drawImage(img, -it.fit.w / 2, -h / 2, it.fit.w, h);
  }

  /** 把頸部重畫在這件衣物之上，但只限衣物蓋住頸部的位置（後領）。之後穿上的頸飾仍會在頸部前面。 */
  private neckOver(ctx: CanvasRenderingContext2D, it: SceneItem, b: Baked, base: Mat, mats: Record<string, Mat>, drawItem: (c: CanvasRenderingContext2D, it: SceneItem, b: Baked, pre: Mat) => void) {
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
    drawItem(c, it, b, pre);
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
