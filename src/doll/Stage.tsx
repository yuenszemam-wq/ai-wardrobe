import { PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Mat, Pose, Rig, aimBone, applyMat, boneMap, invert, moveBone, reachIK, solve } from "../../shared/avatarRig";
import { HairConfig, RIG_V2, hairBoneId } from "../../shared/avatarV2";
import { Content, FIT_LIMIT, Fit, fitHeight, hitTest } from "../../shared/doll";
import { DollRenderer, Scene, View } from "./engine";

export interface Selection { fit: Fit; content: Content; bone: string; /** 可否旋轉（髮束、頭部只可移動及縮放） */ rotate?: boolean; /** 變形後實際佔的範圍（邏輯座標）；有＝選取框跟隨實際衣物範圍 */ bounds?: [number, number, number, number] }
export type StageMode = "dress" | "pose" | "mask";
type HandleKind = "ik" | "aim" | "move";
export interface PoseHandle { id: string; kind: HandleKind; bone: string; /** 靜止姿勢下的位置，以及它跟隨的骨骼 */ at: [number, number]; follow: string; upper?: string; mid?: string }

const P = (id: string) => boneMap(RIG_V2).get(id)!.pivot as [number, number];
/** 畫布上可拖動的骨架控制點：手腳末端（IK）、各節骨骼末端（旋轉）、重心及肩膊（平移）、髮束 */
export function poseHandles(hair: HairConfig | null): PoseHandle[] {
  const out: PoseHandle[] = [
    { id: "root", kind: "move", bone: "root", at: P("pelvis"), follow: "root" },
    { id: "torso", kind: "aim", bone: "torso", at: P("chest"), follow: "torso" },
    { id: "chest", kind: "aim", bone: "chest", at: P("neck"), follow: "chest" },
    { id: "head", kind: "aim", bone: "head", at: RIG_V2.anchors.head_top, follow: "head" },
  ];
  for (const s of ["r", "l"] as const) {
    const sign = s === "r" ? -1 : 1;
    out.push(
      { id: "shoulder_" + s, kind: "move", bone: "shoulder_" + s, at: P("shoulder_" + s), follow: "shoulder_" + s },
      { id: "elbow_" + s, kind: "aim", bone: "shoulder_" + s, at: P("elbow_" + s), follow: "shoulder_" + s },
      { id: "wrist_" + s, kind: "ik", bone: "wrist_" + s, at: P("wrist_" + s), follow: "elbow_" + s, upper: "shoulder_" + s, mid: "elbow_" + s },
      { id: "hand_" + s, kind: "aim", bone: "wrist_" + s, at: [RIG_V2.anchors["hand_" + s][0] + sign * 18, RIG_V2.anchors["hand_" + s][1] + 30], follow: "wrist_" + s },
      { id: "knee_" + s, kind: "aim", bone: "hip_" + s, at: P("knee_" + s), follow: "hip_" + s },
      { id: "ankle_" + s, kind: "ik", bone: "ankle_" + s, at: P("ankle_" + s), follow: "knee_" + s, upper: "hip_" + s, mid: "knee_" + s },
      { id: "foot_" + s, kind: "aim", bone: "ankle_" + s, at: [P("ankle_" + s)[0], P("ankle_" + s)[1] + 118], follow: "ankle_" + s },
    );
  }
  const seen = new Set<string>();
  for (const p of hair?.parts ?? []) {
    const bone = hairBoneId(p);
    if (bone === "head" || seen.has(bone)) continue;
    seen.add(bone);
    out.push({ id: bone, kind: "aim", bone, at: [p.x + p.w / 2, p.y + p.h - 12], follow: bone });
  }
  return out;
}

interface Props {
  renderer: DollRenderer;
  scene: Scene;
  rig: Rig;
  view: View;
  mode: StageMode;
  selection: Selection | null;
  onPick?: (x: number, y: number) => void;
  onFit?: (fit: Fit) => void;
  showHandles?: boolean;
  activeHandle?: string | null;
  onPose?: (pose: Pose, handle: PoseHandle) => void;
  /** 塗抹（遮罩／部件）：畫面上的位置（邏輯座標，已變形）；由上層沿變形網格換算到圖片位置 */
  onPaint?: (x: number, y: number, phase: "start" | "move" | "end") => void;
  /** 塗抹筆刷半徑（邏輯像素），顯示游標 */
  brush?: number;
  onReadyChange?: (ready: boolean) => void;
  children?: React.ReactNode;
}
type Gesture =
  | { kind: "move"; sx: number; sy: number; fit: Fit }
  | { kind: "pinch"; d0: number; a0: number; fit: Fit }
  | { kind: "resize"; d0: number; fit: Fit }
  | { kind: "rotate"; a0: number; fit: Fit }
  | { kind: "pose"; handle: PoseHandle; dx: number; dy: number }
  | { kind: "paint" };
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** 角色舞台：Canvas 繪畫角色及衣物，上面一層 SVG 顯示選取框及骨架控制點；所有手勢在這裡處理。 */
export function Stage({ renderer, scene, rig, view, mode, selection, onPick, onFit, showHandles, activeHandle, onPose, onPaint, brush, onReadyChange, children }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tick, setTick] = useState(0);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ scene, selection, onFit, onPose, onPick, onPaint });
  latest.current = { scene, selection, onFit, onPose, onPick, onPaint };

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); setSize({ w: Math.round(r.width), h: Math.round(r.height) }); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 邏輯座標 → 螢幕（CSS 像素）
  const k = size.w && size.h ? Math.min(size.w / view.w, size.h / view.h) : 0;
  const ox = (size.w - view.w * k) / 2 - view.x * k, oy = (size.h - view.h * k) / 2 - view.y * k;
  const mats = useMemo(() => solve(rig, scene.pose), [rig, scene.pose]);
  const handles = useMemo(() => (showHandles ? poseHandles(scene.hair) : []), [showHandles, scene.hair]);
  const toScreen = (x: number, y: number): [number, number] => [x * k + ox, y * k + oy];
  const toLogical = (cx: number, cy: number): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    return [(cx - r.left - ox) / k, (cy - r.top - oy) / k];
  };

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

  // ───── 選取框（已計及骨骼變換） ─────
  const frame = useMemo(() => {
    if (!selection || !k) return null;
    const { fit, content, bone } = selection;
    const m = mats[bone] ?? mats.root;
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
  }, [selection, mats, k, ox, oy]);

  const restPoint = (clientX: number, clientY: number, bone: string): [number, number] => {
    const [x, y] = toLogical(clientX, clientY);
    return applyMat(invert(mats[bone] ?? mats.root), x, y);
  };
  const near = (p: [number, number] | undefined, e: { clientX: number; clientY: number }, r: number) => {
    if (!p) return false;
    const b = wrap.current!.getBoundingClientRect();
    return Math.hypot(e.clientX - b.left - p[0], e.clientY - b.top - p[1]) <= r;
  };
  const startPinch = () => {
    const sel = latest.current.selection;
    if (!sel) return;
    const [a, b] = [...pointers.current.values()];
    gesture.current = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x), fit: sel.fit };
  };
  const emitFit = (fit: Fit) => {
    const sel = latest.current.selection;
    if (!sel) return;
    latest.current.onFit?.({ ...fit, cx: clamp(fit.cx, -FIT_LIMIT.pad + 1, 1200 + FIT_LIMIT.pad - 1), cy: clamp(fit.cy, -FIT_LIMIT.pad + 1, 1800 + FIT_LIMIT.pad - 1), w: clamp(fit.w, FIT_LIMIT.minW, FIT_LIMIT.maxW), rotation: sel.rotate === false ? sel.fit.rotation : fit.rotation });
  };

  function onDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!k) return;
    if ((e.target as HTMLElement).closest("[data-stage-ui]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const sel = selection;
    if (mode === "pose") {
      if (pointers.current.size > 1) return;
      const b = wrap.current!.getBoundingClientRect();
      let best: PoseHandle | null = null, bestD = 34;
      for (const h of handles) {
        const [x, y] = applyMat(mats[h.follow] ?? mats.root, h.at[0], h.at[1]);
        const d = Math.hypot(e.clientX - b.left - (x * k + ox), e.clientY - b.top - (y * k + oy));
        if (d < bestD) { best = h; bestD = d; }
      }
      if (best) {
        const [x, y] = applyMat(mats[best.follow] ?? mats.root, best.at[0], best.at[1]);
        const [lx, ly] = toLogical(e.clientX, e.clientY);
        gesture.current = { kind: "pose", handle: best, dx: x - lx, dy: y - ly };
        latest.current.onPose?.(latest.current.scene.pose, best);
      }
      return;
    }
    if (mode === "mask") {
      if (!sel || pointers.current.size > 1) return;
      gesture.current = { kind: "paint" };
      onPaint?.(...toLogical(e.clientX, e.clientY), "start");
      return;
    }
    if (pointers.current.size >= 2 && sel) return startPinch();
    if (sel && frame) {
      if (near(frame.resize, e, 24)) {
        const b = wrap.current!.getBoundingClientRect();
        gesture.current = { kind: "resize", d0: Math.hypot(e.clientX - b.left - frame.center[0], e.clientY - b.top - frame.center[1]) || 1, fit: sel.fit };
        return;
      }
      if (sel.rotate !== false && near(frame.rotate, e, 24)) {
        const b = wrap.current!.getBoundingClientRect();
        gesture.current = { kind: "rotate", a0: Math.atan2(e.clientY - b.top - frame.center[1], e.clientX - b.left - frame.center[0]), fit: sel.fit };
        return;
      }
      const [x, y] = restPoint(e.clientX, e.clientY, sel.bone);
      const [lx, ly] = toLogical(e.clientX, e.clientY), bd = sel.bounds, pad = 20 / k;
      if (bd ? lx >= bd[0] - pad && lx <= bd[2] + pad && ly >= bd[1] - pad && ly <= bd[3] + pad : hitTest(sel.fit, sel.content, x, y, pad)) {
        gesture.current = { kind: "move", sx: x, sy: y, fit: sel.fit };
        return;
      }
    }
    const [x, y] = toLogical(e.clientX, e.clientY);
    onPick?.(x, y);
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (mode === "mask" && brush) { const b = wrap.current!.getBoundingClientRect(); setCursor([e.clientX - b.left, e.clientY - b.top]); }
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const sel = latest.current.selection;
    if (!g || !k) return;
    if (g.kind === "pose") {
      const [lx, ly] = toLogical(e.clientX, e.clientY);
      const target: [number, number] = [lx + g.dx, ly + g.dy];
      const pose = latest.current.scene.pose, h = g.handle;
      const next = h.kind === "ik" ? reachIK(rig, pose, h.upper!, h.mid!, h.bone, target) : h.kind === "move" ? moveBone(rig, pose, h.bone, target) : aimBone(rig, pose, h.bone, h.at, target);
      latest.current.onPose?.(next, h);
      return;
    }
    if (!sel) return;
    if (g.kind === "paint") {
      latest.current.onPaint?.(...toLogical(e.clientX, e.clientY), "move");
      return;
    }
    const f = g.fit;
    if (g.kind === "move") {
      const [x, y] = restPoint(e.clientX, e.clientY, sel.bone);
      emitFit({ ...f, cx: f.cx + x - g.sx, cy: f.cy + y - g.sy });
    } else if (g.kind === "pinch") {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const a = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
      emitFit({ ...f, w: (f.w * d) / g.d0, rotation: f.rotation + ((a - g.a0) * 180) / Math.PI });
    } else if (frame) {
      const b = wrap.current!.getBoundingClientRect();
      const dx = e.clientX - b.left - frame.center[0], dy = e.clientY - b.top - frame.center[1];
      if (g.kind === "resize") emitFit({ ...f, w: (f.w * Math.hypot(dx, dy)) / g.d0 });
      else emitFit({ ...f, rotation: f.rotation + ((Math.atan2(dy, dx) - g.a0) * 180) / Math.PI });
    }
  }
  function onUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "paint") latest.current.onPaint?.(0, 0, "end");
    const rest = [...pointers.current.values()];
    const sel = latest.current.selection;
    if (g.kind === "pinch" && rest.length === 1 && sel) {
      const [x, y] = restPoint(rest[0].x, rest[0].y, sel.bone);
      gesture.current = { kind: "move", sx: x, sy: y, fit: sel.fit };
    } else if (!rest.length) gesture.current = null;
  }

  const COLOR: Record<HandleKind, string> = { ik: "#f28ba3", aim: "#c9a0e8", move: "#f0d9c0" };
  return (
    <div ref={wrap} data-testid="doll-stage" data-mode={mode} data-k={k.toFixed(5)} data-ox={ox.toFixed(2)} data-oy={oy.toFixed(2)} className="absolute inset-0 select-none overflow-hidden" style={{ touchAction: "none" }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => setCursor(null)}>
      <canvas ref={canvas} data-testid="doll-canvas" className="pointer-events-none absolute inset-0 h-full w-full" />
      {k > 0 && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" width={size.w} height={size.h}>
          {frame && mode !== "pose" && (
            <g data-testid="fit-frame">
              <polygon points={frame.pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="#c9a0e8" strokeWidth={1.5} strokeDasharray="5 4" />
              {mode === "dress" && (
                <>
                  {selection?.rotate !== false && (
                    <g data-testid="handle-rotate" transform={`translate(${frame.rotate[0]},${frame.rotate[1]})`}>
                      <circle r={12} fill="#8f4d7c" stroke="#f0d9c0" strokeWidth={1.2} />
                      <path d="M-5 1a5 5 0 1 0 2-5m-3-2v3.5h3.5" fill="none" stroke="#fffaf6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                    </g>
                  )}
                  <g data-testid="handle-resize" transform={`translate(${frame.resize[0]},${frame.resize[1]})`}>
                    <circle r={12} fill="#8f4d7c" stroke="#f0d9c0" strokeWidth={1.2} />
                    <path d="M-4.5-4.5l9 9m0-4.5v4.5h-4.5m-4.5-4.5v-4.5h4.5" fill="none" stroke="#fffaf6" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                  </g>
                </>
              )}
            </g>
          )}
          {mode === "pose" && handles.length > 0 && (
            <g data-testid="pose-handles">
              {rig.bones.filter((b) => b.parent && b.parent !== "root" && !b.id.startsWith("hair") && !b.id.startsWith("hp_")).map((b) => {
                const a = toScreen(...applyMat(mats[b.parent!], ...(boneMap(rig).get(b.parent!)!.pivot as [number, number])));
                const c = toScreen(...applyMat(mats[b.id], b.pivot[0], b.pivot[1]));
                return <line key={b.id} x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} stroke="#fffaf6" strokeOpacity={0.55} strokeWidth={1.5} strokeLinecap="round" />;
              })}
              {handles.map((h) => {
                const [x, y] = toScreen(...applyMat(mats[h.follow] ?? mats.root, h.at[0], h.at[1]));
                const on = activeHandle === h.id;
                return (
                  <g key={h.id} data-handle={h.id} data-x={x.toFixed(1)} data-y={y.toFixed(1)} transform={`translate(${x},${y})`}>
                    <circle r={on ? 11 : 8} fill={COLOR[h.kind]} fillOpacity={on ? 0.95 : 0.8} stroke="#3b1f35" strokeWidth={1.5} />
                    {h.kind === "move" && <path d="M-4 0h8M0-4v8" stroke="#3b1f35" strokeWidth={1.6} strokeLinecap="round" />}
                    {on && <circle r={15} fill="none" stroke="#fffaf6" strokeWidth={1.2} />}
                  </g>
                );
              })}
            </g>
          )}
          {mode === "mask" && brush && cursor && <circle cx={cursor[0]} cy={cursor[1]} r={brush * k} fill="rgb(242 139 163 / 0.25)" stroke="#f28ba3" strokeWidth={1} />}
        </svg>
      )}
      {children}
    </div>
  );
}
