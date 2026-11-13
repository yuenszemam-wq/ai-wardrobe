// 角色舞台（Phase 3.2）：Canvas 繪畫角色及衣物，上面一層 SVG 顯示選取框及骨架控制點；所有手勢在這裡處理。
// 鏡頭（Camera）與造型分開：雙指＝縮放及平移畫面，任何模式都一樣，永遠不會改動衣物或骨架。
// 衣物大小只可以用角位把手、滑桿或按鈕調整。第二根手指落下時，正在進行的單指操作（拖動衣物、關節、塗抹）會被取消並還原。
import { PointerEvent as ReactPointerEvent, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Mat, Pose, Rig, aimBone, applyMat, boneMap, ikSide, invert, moveBone, reachIK, solve } from "../../shared/avatarRig";
import { Camera, Size, panBy, pinchCamera, transform, zoomAt } from "../../shared/camera";
import { Content, FIT_LIMIT, Fit, fitHeight, hitTest, manualPoint, normalizeManualMesh, toImage } from "../../shared/doll";
import { ControlKind, PoseControl } from "../../shared/poseControls";
import { DollRenderer, Scene } from "./engine";

export interface Selection { fit: Fit; content: Content; bone: string; /** 可否旋轉（髮束、頭部只可移動及縮放） */ rotate?: boolean; /** 變形後實際佔的範圍（邏輯座標）；有＝選取框跟隨實際衣物範圍 */ bounds?: [number, number, number, number] }
/** dress＝選取及移動衣物；pose＝拖動骨架；mask＝塗抹（遮罩／部件）；mesh＝拖動 4×4 手動網格；view＝只看（乾淨預覽） */
export type StageMode = "dress" | "pose" | "mask" | "mesh" | "view";
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
/** "world"＝固定在畫布，不跟隨骨架 */
const matOf = (mats: Record<string, Mat>, bone: string): Mat => (bone === "world" ? IDENT : mats[bone] ?? mats.root);
export type PaintPhase = "start" | "move" | "end" | "cancel";
export interface SkeletonStyle { /** 平時的透明度（拖動期間一定是完全顯示） */ opacity: number; /** 要畫骨骼連線的骨骼；null＝不畫 */ bones: Set<string> | null }

interface Props {
  renderer: DollRenderer;
  scene: Scene;
  rig: Rig;
  camera: Camera;
  onCamera: (c: Camera) => void;
  onSize?: (s: Size) => void;
  mode: StageMode;
  /** 手掌工具：單指只平移畫面 */
  hand?: boolean;
  selection: Selection | null;
  onPick?: (x: number, y: number) => void;
  onFit?: (fit: Fit) => void;
  /** 要顯示及可以拖動的骨架控制點（已按顯示方式篩選） */
  controls?: PoseControl[];
  skeleton?: SkeletonStyle;
  activeControl?: string | null;
  onPose?: (pose: Pose, control: PoseControl) => void;
  /** 塗抹（遮罩／部件）：畫面上的位置（邏輯座標）及筆刷半徑（邏輯像素）；cancel＝第二根手指落下，這一筆作廢 */
  onPaint?: (x: number, y: number, phase: PaintPhase, radius: number) => void;
  /** 塗抹筆刷半徑（螢幕像素）：放大畫面後，同一枝筆在衣物上會變得更細 */
  brush?: number;
  /** 一次會改動造型的手勢（拖動衣物／關節）開始前及被取消時通知上層，用來完整還原 */
  onEditStart?: () => void;
  onEditCancel?: () => void;
  onReadyChange?: (ready: boolean) => void;
  /** 弱化角色及衣服（線框模式） */
  dim?: boolean;
  children?: ReactNode;
}
type Gesture =
  | { kind: "move"; sx: number; sy: number; fit: Fit; started: boolean }
  | { kind: "resize"; d0: number; fit: Fit; started: boolean }
  | { kind: "rotate"; a0: number; fit: Fit; started: boolean }
  | { kind: "pose"; control: PoseControl; dx: number; dy: number; started: boolean; side: number; target?: [number, number]; from: [number, number] }
  | { kind: "mesh"; index: number; fit: Fit; started: boolean }
  | { kind: "paint" }
  | { kind: "pan"; cam: Camera; moved: boolean; pick: boolean }
  | { kind: "pinch"; cam: Camera; m0: [number, number]; d0: number }
  | { kind: "idle" };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/** 手指要移動超過這個距離（螢幕像素）才算拖動：輕觸、或準備雙指縮放時第一指的輕微移動，不會改動任何東西 */
const SLOP = 5;
const HIT = 30;
const COLOR: Record<ControlKind, string> = { ik: "#f28ba3", aim: "#c9a0e8", move: "#f0d9c0" };

export function Stage({ renderer, scene, rig, camera, onCamera, onSize, mode, hand, selection, onPick, onFit, controls, skeleton, activeControl, onPose, onPaint, brush, onEditStart, onEditCancel, onReadyChange, dim, children }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const [tick, setTick] = useState(0);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number; x0: number; y0: number }>());
  const gesture = useRef<Gesture | null>(null);
  const poseFrame = useRef(0);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); const s = { w: Math.round(r.width), h: Math.round(r.height) }; setSize((p) => (p.w === s.w && p.h === s.h ? p : s)); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (size.w && size.h) onSize?.(size); }, [size.w, size.h]);

  // 邏輯座標 → 螢幕（CSS 像素）。畫布、選取框、骨架控制點、點選、筆刷全部用同一組 k／ox／oy。
  const { k, ox, oy } = transform(camera, size);
  const mats = useMemo(() => solve(rig, scene.pose), [rig, scene.pose]);
  const shown = mode === "pose" ? controls ?? [] : [];
  const latest = useRef({ scene, selection, onFit, onPose, onPick, onPaint, onCamera, onEditStart, onEditCancel, camera, size, k, ox, oy, mats, mode, hand, brush, shown });
  latest.current = { scene, selection, onFit, onPose, onPick, onPaint, onCamera, onEditStart, onEditCancel, camera, size, k, ox, oy, mats, mode, hand, brush, shown };
  const local = (e: { clientX: number; clientY: number }): [number, number] => { const r = wrap.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const toScreen = (x: number, y: number): [number, number] => [x * k + ox, y * k + oy];
  const toLogical = (e: { clientX: number; clientY: number }): [number, number] => { const [sx, sy] = local(e), c = latest.current; return [(sx - c.ox) / c.k, (sy - c.oy) / c.k]; };

  useEffect(() => {
    renderer.onReady = () => setTick((t) => t + 1);
    return () => { renderer.onReady = () => undefined; };
  }, [renderer]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !k) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const pw = Math.round(size.w * dpr), ph = Math.round(size.h * dpr);
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    const id = requestAnimationFrame(() => {
      const ctx = c.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, pw, ph);
      const ready = renderer.paint(ctx, scene, [k * dpr, 0, 0, k * dpr, ox * dpr, oy * dpr]);
      c.dataset.ready = ready ? "1" : "0";
      onReadyChange?.(ready);
    });
    return () => cancelAnimationFrame(id);
  }, [renderer, scene, k, ox, oy, size.w, size.h, tick]);
  // 滑鼠滾輪／觸控板：以游標位置為中心縮放（桌面瀏覽器）
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest("[data-stage-ui]")) return;
      e.preventDefault();
      const c = latest.current, [sx, sy] = local(e);
      c.onCamera(zoomAt(c.camera, c.size, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0022)), sx, sy));
    };
    // iOS Safari 的網頁縮放手勢：交由舞台自己處理
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", stop);
    el.addEventListener("gesturechange", stop);
    return () => { el.removeEventListener("wheel", wheel); el.removeEventListener("gesturestart", stop); el.removeEventListener("gesturechange", stop); };
  }, []);

  // ───── 選取框（已計及骨骼變換） ─────
  const frame = useMemo(() => {
    if (!selection || !k || mode === "view") return null;
    const { fit, content, bone } = selection;
    const m = matOf(mats, bone);
    const h = fitHeight(fit, content.ar);
    const t = (fit.rotation * Math.PI) / 180;
    const corner = (u: number, v: number): [number, number] => {
      const lx = (u - 0.5) * fit.w, ly = (v - 0.5) * h;
      const [x, y] = applyMat(m, fit.cx + lx * Math.cos(t) - ly * Math.sin(t), fit.cy + lx * Math.sin(t) + ly * Math.cos(t));
      return [x * k + ox, y * k + oy];
    };
    if (selection.bounds) {
      // 衣物已隨骨架變形：選取框用實際顯示的範圍
      const [x0, y0, x1, y1] = selection.bounds;
      const pts: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [x * k + ox, y * k + oy]);
      return { pts, resize: pts[2], rotate: [(pts[0][0] + pts[1][0]) / 2, pts[0][1] - 22] as [number, number], center: [(pts[0][0] + pts[2][0]) / 2, (pts[0][1] + pts[2][1]) / 2] as [number, number] };
    }
    const pts = [corner(content.x0, content.y0), corner(content.x1, content.y0), corner(content.x1, content.y1), corner(content.x0, content.y1)];
    const top = corner((content.x0 + content.x1) / 2, content.y0);
    const c = applyMat(m, fit.cx, fit.cy);
    const up = Math.hypot(top[0] - (c[0] * k + ox), top[1] - (c[1] * k + oy)) || 1;
    const rot: [number, number] = [top[0] + ((top[0] - (c[0] * k + ox)) / up) * 22, top[1] + ((top[1] - (c[1] * k + oy)) / up) * 22];
    return { pts, resize: pts[2], rotate: rot, center: [c[0] * k + ox, c[1] * k + oy] as [number, number] };
  }, [selection, mats, k, ox, oy, mode]);
  // 4×4 手動網格控制點（螢幕座標）
  const meshPts = useMemo(() => {
    if (mode !== "mesh" || !selection || !k) return null;
    const m = matOf(mats, selection.bone);
    return Array.from({ length: 16 }, (_, i) => toScreen(...applyMat(m, ...manualPoint(selection.fit, selection.content.ar, (i % 4) / 3, Math.floor(i / 4) / 3))));
  }, [mode, selection, mats, k, ox, oy]);
  const meshRef = useRef(meshPts);
  meshRef.current = meshPts;
  const frameRef = useRef(frame);
  frameRef.current = frame;

  const restPoint = (e: { clientX: number; clientY: number }, bone: string): [number, number] => {
    const [x, y] = toLogical(e);
    return applyMat(invert(matOf(latest.current.mats, bone)), x, y);
  };
  const near = (p: [number, number] | undefined, e: { clientX: number; clientY: number }, r: number) => {
    if (!p) return false;
    const [sx, sy] = local(e);
    return Math.hypot(sx - p[0], sy - p[1]) <= r;
  };
  const emitFit = (fit: Fit) => {
    const sel = latest.current.selection;
    if (!sel) return;
    latest.current.onFit?.({ ...fit, cx: clamp(fit.cx, -FIT_LIMIT.pad + 1, 1200 + FIT_LIMIT.pad - 1), cy: clamp(fit.cy, -FIT_LIMIT.pad + 1, 1800 + FIT_LIMIT.pad - 1), w: clamp(fit.w, FIT_LIMIT.minW, FIT_LIMIT.maxW), rotation: sel.rotate === false ? sel.fit.rotation : fit.rotation });
  };
  const brushRadius = () => (latest.current.brush ?? 0) / (latest.current.k || 1);
  /** 取消正在進行的單指操作（第二根手指落下）：塗抹的一筆作廢，拖動中的衣物／關節還原 */
  const cancelSingle = () => {
    const g = gesture.current, c = latest.current;
    if (!g) return;
    if (poseFrame.current) { cancelAnimationFrame(poseFrame.current); poseFrame.current = 0; }
    if (g.kind === "paint") c.onPaint?.(0, 0, "cancel", 0);
    else if ((g.kind === "move" || g.kind === "resize" || g.kind === "rotate" || g.kind === "pose" || g.kind === "mesh") && g.started) c.onEditCancel?.();
    setDragging(false);
  };
  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    const r = wrap.current!.getBoundingClientRect();
    gesture.current = { kind: "pinch", cam: latest.current.camera, m0: [(a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top], d0: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };

  function onDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!k) return;
    if ((e.target as HTMLElement).closest("[data-stage-ui]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
    const n = pointers.current.size;
    if (n >= 2) {
      // 第二根手指：任何模式都是縮放／平移畫面
      if (n === 2) { cancelSingle(); startPinch(); }
      return;
    }
    const sel = selection, fr = frameRef.current;
    const pan = (pick: boolean): Gesture => ({ kind: "pan", cam: camera, moved: false, pick });
    if (hand || mode === "view") { gesture.current = pan(false); return; }
    if (mode === "pose") {
      const [sx, sy] = local(e);
      let best: PoseControl | null = null, bestD = HIT;
      for (const h of shown) {
        const [x, y] = toScreen(...applyMat(mats[h.follow] ?? mats.root, h.at[0], h.at[1]));
        // 相同距離時，目前選中的控制點優先（相鄰關節重疊時不會跳到另一個）
        const d = Math.hypot(sx - x, sy - y) - (h.id === activeControl ? 6 : 0);
        if (d < bestD) { best = h; bestD = d; }
      }
      if (best) {
        const [x, y] = applyMat(mats[best.follow] ?? mats.root, best.at[0], best.at[1]);
        const [lx, ly] = toLogical(e);
        gesture.current = { kind: "pose", control: best, dx: x - lx, dy: y - ly, started: false, side: best.kind === "ik" ? ikSide(rig, scene.pose, best.upper!, best.mid!, best.bone) : 0, from: [x, y] };
        setDragging(true);
        onPose?.(scene.pose, best);
      } else gesture.current = pan(false);
      return;
    }
    if (mode === "mesh") {
      const pts = meshRef.current, [sx, sy] = local(e);
      let best = -1, bestD = HIT;
      pts?.forEach((q, i) => { const d = Math.hypot(sx - q[0], sy - q[1]); if (d < bestD) { best = i; bestD = d; } });
      gesture.current = best >= 0 && sel ? { kind: "mesh", index: best, fit: sel.fit, started: false } : pan(false);
      return;
    }
    if (mode === "mask") {
      if (!sel) { gesture.current = pan(false); return; }
      gesture.current = { kind: "paint" };
      onPaint?.(...toLogical(e), "start", brushRadius());
      return;
    }
    if (sel && fr) {
      const [sx, sy] = local(e);
      if (near(fr.resize, e, 24)) { gesture.current = { kind: "resize", d0: Math.hypot(sx - fr.center[0], sy - fr.center[1]) || 1, fit: sel.fit, started: false }; return; }
      if (sel.rotate !== false && near(fr.rotate, e, 24)) { gesture.current = { kind: "rotate", a0: Math.atan2(sy - fr.center[1], sx - fr.center[0]), fit: sel.fit, started: false }; return; }
      const [x, y] = restPoint(e, sel.bone);
      const [lx, ly] = toLogical(e), bd = sel.bounds, pad = 20 / k;
      if (bd ? lx >= bd[0] - pad && lx <= bd[2] + pad && ly >= bd[1] - pad && ly <= bd[3] + pad : hitTest(sel.fit, sel.content, x, y, pad)) { gesture.current = { kind: "move", sx: x, sy: y, fit: sel.fit, started: false }; return; }
    }
    // 空白位置：輕觸＝點選衣物；拖動＝平移畫面
    gesture.current = pan(true);
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (mode === "mask" && brush && e.pointerType !== "touch") setCursor(local(e));
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    const g = gesture.current, c = latest.current;
    if (!g || !c.k) return;
    if (g.kind === "pinch") {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const r = wrap.current!.getBoundingClientRect();
      c.onCamera(pinchCamera(g.cam, c.size, g.m0, g.d0, [(pts[0].x + pts[1].x) / 2 - r.left, (pts[0].y + pts[1].y) / 2 - r.top], Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)));
      return;
    }
    if (g.kind === "idle" || pointers.current.size !== 1) return;
    const far = Math.hypot(p.x - p.x0, p.y - p.y0) > SLOP;
    if (g.kind === "pan") {
      if (!g.moved && !far) return;
      g.moved = true;
      c.onCamera(panBy(g.cam, c.size, p.x - p.x0, p.y - p.y0));
      return;
    }
    if (g.kind === "paint") {
      if (mode === "mask" && brush) setCursor(local(e));
      c.onPaint?.(...toLogical(e), "move", brushRadius());
      return;
    }
    if (!g.started) { if (!far) return; g.started = true; c.onEditStart?.(); }
    if (g.kind === "pose") {
      const [lx, ly] = toLogical(e);
      const target: [number, number] = [lx + g.dx, ly + g.dy];
      // 每一幀只計算一次（手指移動事件比畫面更新頻繁），用最新的手指位置，不做平滑，不會延遲
      g.target = target;
      if (!poseFrame.current) poseFrame.current = requestAnimationFrame(() => {
        poseFrame.current = 0;
        const gg = gesture.current, cc = latest.current;
        if (!gg || gg.kind !== "pose" || !gg.target) return;
        const hh = gg.control, cur = cc.scene.pose;
        const next = hh.kind === "ik" ? reachIK(rig, cur, hh.upper!, hh.mid!, hh.bone, gg.target) : hh.kind === "move" ? moveBone(rig, cur, hh.bone, gg.target) : aimBone(rig, cur, hh.bone, hh.at, gg.target);
        cc.onPose?.(next, hh);
      });
      return;
    }
    const sel = c.selection, fr = frameRef.current;
    if (!sel) return;
    const f = g.fit;
    if (g.kind === "mesh") {
      // 拖動網格控制點：只改變這一點（相對原圖位置的偏移），會翻面或過度拉伸的位置不接受
      const [x, y] = restPoint(e, sel.bone), [u, v] = toImage(f, sel.content.ar, x, y);
      const a = [...(f.mesh ?? Array(32).fill(0))];
      a[g.index * 2] = clamp(u - (g.index % 4) / 3, -0.75, 0.75);
      a[g.index * 2 + 1] = clamp(v - Math.floor(g.index / 4) / 3, -0.75, 0.75);
      const mesh = normalizeManualMesh(a);
      if (mesh || a.every((n) => Math.abs(n) < 1e-4)) c.onFit?.({ ...f, mesh });
      return;
    }
    if (g.kind === "move") {
      const [x, y] = restPoint(e, sel.bone);
      emitFit({ ...f, cx: f.cx + x - g.sx, cy: f.cy + y - g.sy });
    } else if (fr) {
      const [sx, sy] = local(e), dx = sx - fr.center[0], dy = sy - fr.center[1];
      if (g.kind === "resize") emitFit({ ...f, w: (f.w * Math.hypot(dx, dy)) / g.d0 });
      else emitFit({ ...f, rotation: f.rotation + ((Math.atan2(dy, dx) - g.a0) * 180) / Math.PI });
    }
  }
  function onUp(e: ReactPointerEvent<HTMLDivElement>) {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current, c = latest.current;
    if (!g) return;
    const left = pointers.current.size;
    if (g.kind === "pinch") {
      // 雙指手勢結束後，剩下的一根手指不會變成拖動衣物或塗抹；全部手指離開才可以開始下一個操作
      gesture.current = left ? { kind: "idle" } : null;
      return;
    }
    if (left) return;
    if (g.kind === "pose" && poseFrame.current && g.target && e.type !== "pointercancel") {
      // 放手前最後一個位置仍未計算：立即計算，避免放手後手臂停在較早的位置
      cancelAnimationFrame(poseFrame.current); poseFrame.current = 0;
      const h = g.control, cur = c.scene.pose;
      c.onPose?.(h.kind === "ik" ? reachIK(rig, cur, h.upper!, h.mid!, h.bone, g.target) : h.kind === "move" ? moveBone(rig, cur, h.bone, g.target) : aimBone(rig, cur, h.bone, h.at, g.target), h);
    }
    if (g.kind === "paint") c.onPaint?.(0, 0, e.type === "pointercancel" ? "cancel" : "end", 0);
    else if (g.kind === "pan" && g.pick && !g.moved && e.type !== "pointercancel") c.onPick?.(...toLogical(e));
    else if (e.type === "pointercancel" && (g.kind === "move" || g.kind === "resize" || g.kind === "rotate" || g.kind === "pose" || g.kind === "mesh") && g.started) c.onEditCancel?.();
    gesture.current = null;
    setDragging(false);
    if (e.pointerType === "touch") setCursor(null);
  }

  const sk = skeleton ?? { opacity: 0.85, bones: null };
  const bones = boneMap(rig);
  return (
    <div ref={wrap} data-testid="doll-stage" data-mode={mode} data-k={k.toFixed(5)} data-ox={ox.toFixed(2)} data-oy={oy.toFixed(2)} data-zoom={camera.z.toFixed(3)} data-cx={camera.x.toFixed(1)} data-cy={camera.y.toFixed(1)}
      className="absolute inset-0 select-none overflow-hidden" style={{ touchAction: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none" }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => setCursor(null)}>
      <canvas ref={canvas} data-testid="doll-canvas" className="pointer-events-none absolute inset-0 h-full w-full transition-opacity duration-200" style={{ opacity: dim ? 0.38 : 1 }} />
      {k > 0 && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" width={size.w} height={size.h}>
          {meshPts && (
            <g data-testid="manual-mesh">
              {meshPts.map((q, i) => (
                <g key={i}>
                  {i % 4 < 3 && <line x1={q[0]} y1={q[1]} x2={meshPts[i + 1][0]} y2={meshPts[i + 1][1]} stroke="#a96bda" strokeOpacity={0.85} strokeWidth={1.2} />}
                  {i < 12 && <line x1={q[0]} y1={q[1]} x2={meshPts[i + 4][0]} y2={meshPts[i + 4][1]} stroke="#a96bda" strokeOpacity={0.85} strokeWidth={1.2} />}
                </g>
              ))}
              {meshPts.map((q, i) => <circle key={"p" + i} data-mesh-point={i} data-x={q[0].toFixed(1)} data-y={q[1].toFixed(1)} cx={q[0]} cy={q[1]} r={6} fill="rgb(255 250 246 / 0.85)" stroke="#8f4d7c" strokeWidth={2} />)}
            </g>
          )}
          {frame && mode !== "pose" && mode !== "mesh" && (
            <g data-testid="fit-frame">
              <polygon points={frame.pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="#c9a0e8" strokeWidth={1.2} strokeDasharray="5 4" strokeOpacity={mode === "mask" ? 0.45 : 0.9} />
              {mode === "dress" && !hand && (
                <>
                  {selection?.rotate !== false && (
                    <g data-testid="handle-rotate" transform={`translate(${frame.rotate[0]},${frame.rotate[1]})`}>
                      <circle r={11} fill="#8f4d7c" stroke="#f0d9c0" strokeWidth={1.2} />
                      <path d="M-5 1a5 5 0 1 0 2-5m-3-2v3.5h3.5" fill="none" stroke="#fffaf6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                    </g>
                  )}
                  <g data-testid="handle-resize" transform={`translate(${frame.resize[0]},${frame.resize[1]})`}>
                    <circle r={11} fill="#8f4d7c" stroke="#f0d9c0" strokeWidth={1.2} />
                    <path d="M-4.5-4.5l9 9m0-4.5v4.5h-4.5m-4.5-4.5v-4.5h4.5" fill="none" stroke="#fffaf6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                  </g>
                </>
              )}
            </g>
          )}
          {mode === "pose" && (shown.length > 0 || sk.bones) && (
            <g data-testid="pose-handles" style={{ opacity: dragging ? 1 : sk.opacity, transition: "opacity .25s" }}>
              {sk.bones && rig.bones.filter((b) => b.parent && b.parent !== "root" && sk.bones!.has(b.id) && !b.id.startsWith("hair") && !b.id.startsWith("hp_")).map((b) => {
                const a = toScreen(...applyMat(mats[b.parent!], ...(bones.get(b.parent!)!.pivot as [number, number])));
                const c = toScreen(...applyMat(mats[b.id], b.pivot[0], b.pivot[1]));
                return <g key={b.id} data-bone-line={b.id}><line x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} stroke="#2a1526" strokeOpacity={0.35} strokeWidth={dim ? 4.5 : 2.6} strokeLinecap="round" /><line x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} stroke="#fffaf6" strokeOpacity={0.9} strokeWidth={dim ? 2.6 : 1.1} strokeLinecap="round" /></g>;
              })}
              {shown.map((h) => {
                const [x, y] = toScreen(...applyMat(mats[h.follow] ?? mats.root, h.at[0], h.at[1]));
                const on = activeControl === h.id, r = on ? 7 : 5, col = COLOR[h.kind];
                // 視覺上是細小的空心點；實際可點範圍（HIT）比圓點大得多
                return (
                  <g key={h.id} data-handle={h.id} data-kind={h.kind} data-x={x.toFixed(1)} data-y={y.toFixed(1)} transform={`translate(${x},${y})`} opacity={on || !activeControl || dragging ? 1 : 0.7}>
                    {h.kind === "ik" ? (
                      <rect x={-r} y={-r} width={r * 2} height={r * 2} transform="rotate(45)" fill={on ? col : "rgb(255 250 246 / 0.25)"} stroke="#2a1526" strokeOpacity={0.55} strokeWidth={3.4} />
                    ) : <circle r={r} fill={on ? col : "rgb(255 250 246 / 0.25)"} stroke="#2a1526" strokeOpacity={0.55} strokeWidth={3.4} />}
                    {h.kind === "ik" ? <rect x={-r} y={-r} width={r * 2} height={r * 2} transform="rotate(45)" fill="none" stroke={col} strokeWidth={1.6} /> : <circle r={r} fill="none" stroke={col} strokeWidth={1.6} />}
                    {h.kind === "move" && <path d="M-3 0h6M0-3v6" stroke={on ? "#3b1f35" : col} strokeWidth={1.3} strokeLinecap="round" />}
                    {on && <circle r={12} fill="none" stroke="#fffaf6" strokeOpacity={0.9} strokeWidth={1} />}
                  </g>
                );
              })}
            </g>
          )}
          {mode === "mask" && brush && cursor && <circle cx={cursor[0]} cy={cursor[1]} r={brush} fill="rgb(242 139 163 / 0.22)" stroke="#f28ba3" strokeWidth={1} />}
        </svg>
      )}
      {children}
    </div>
  );
}
