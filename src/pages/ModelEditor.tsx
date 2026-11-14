// 身體模型編輯器（Phase 3.6C）：角色預覽始終可見，底部面板「部件／骨架／錨點／圖層／頭部／預覽」。
// 骨架設定＝修改模型的靜止關節位置、旋轉中心及活動範圍（只在靜止姿勢下編輯）；姿勢只在「預覽」分頁改變，不會保存到身體。
// 雙指＝縮放及平移畫面，不會改動部件或骨架。每次保存產生新的不可變版本，舊造型不受影響。
import { PointerEvent as ReactPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ANCHOR_LABEL, AvatarModel, EDITABLE_PARTS, ModelDef, PART_LABEL, BODY_BONES, adjustHair, adjustHead, buildModel, compactDef, headFitFor, moveJoint, partImage } from "../../shared/avatarModel";
import { Pose, clampPose } from "../../shared/avatarRig";
import { BONE_LABEL, BUILTIN_HAIRS, BUILTIN_HEADS, DollAsset, HeadConfig, POSE_PRESETS, RIG_V2, refUrl } from "../../shared/avatarV2";
import { Camera, FULL_CAMERA, Size, VIEW_PRESETS, ZOOM, frame, transform, zoomAt } from "../../shared/camera";
import { FULL_CONTENT, Fit, fitHeight } from "../../shared/doll";
import { controlsFor, poseControls } from "../../shared/poseControls";
import { api, ApiError } from "../api";
import { IconChevronLeft, IconEye, IconEyeOff, IconSave } from "../components/icons";
import { Spinner, toast } from "../components/ui";
import { prepareAsset } from "../doll/content";
import { clearDraft, readDraft, writeDraft } from "../doll/drafts";
import { DollRenderer, Scene } from "../doll/engine";
import { ModelDetail, getModel } from "../doll/models";
import { userAsset } from "../doll/model";
import { Stage } from "../doll/Stage";
import { fetchPoses, SavedPose } from "../doll/PoseLibrary";
import { exportModelPackage } from "../doll/modelPackage";
import { navigate } from "../router";

type Tab = "parts" | "bones" | "anchors" | "layers" | "head" | "preview";
const TABS: [Tab, string][] = [["parts", "部件"], ["bones", "骨架"], ["anchors", "錨點"], ["layers", "圖層"], ["head", "頭部"], ["preview", "預覽"]];
const pill = (on: boolean) => `shrink-0 rounded-full px-3 py-1.5 text-[12.5px] ${on ? "chip-on" : "chip"}`;
const r1 = (v: number) => Math.round(v * 10) / 10;
interface Draft { def: ModelDef; rev: number; name: string }

/** 數值微調欄（拖動之外的精確調整） */
function Num({ label, value, onChange, step = 1, min, max }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <label className="flex items-center gap-1 text-[11.5px]">
      <span className="w-9 shrink-0 text-mauve">{label}</span>
      <button type="button" className="chip h-7 w-7 rounded-full" onClick={() => onChange(r1(value - step))}>−</button>
      <input type="number" inputMode="decimal" value={r1(value)} step={step} min={min} max={max} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(v); }} className="h-7 w-16 rounded-full bg-white/10 px-2 text-center text-cream ring-1 ring-gold/30" />
      <button type="button" className="chip h-7 w-7 rounded-full" onClick={() => onChange(r1(value + step))}>＋</button>
    </label>
  );
}
const Row = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`scrollbar-none -mx-3 flex gap-1.5 overflow-x-auto px-3 ${className}`}>{children}</div>;

export default function ModelEditor({ id }: { id: string }) {
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [def, setDefState] = useState<ModelDef | null>(null);
  const [rev, setRev] = useState(1);
  const [name, setName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<Tab>("parts");
  const [selPart, setSelPart] = useState<string | null>(null);
  const [selJoint, setSelJoint] = useState<string | null>(null);
  const [selAnchor, setSelAnchor] = useState<string | null>(null);
  const [withChildren, setWithChildren] = useState(true);
  const [heads, setHeads] = useState<DollAsset[]>(BUILTIN_HEADS);
  const [headId, setHeadId] = useState(BUILTIN_HEADS[0].id);
  const [headOnly, setHeadOnly] = useState(false);
  const [showHair, setShowHair] = useState(true);
  const [compare, setCompare] = useState(false);
  const [pose, setPose] = useState<Pose>({});
  const [poses, setPoses] = useState<SavedPose[]>([]);
  const [stageSize, setStageSize] = useState<Size>({ w: 0, h: 0 });
  const [cam, setCam] = useState<Camera>(FULL_CAMERA);
  const [viewKey, setViewKey] = useState<string | null>("full");
  const [, setHistN] = useState(0);
  const hist = useRef<{ past: ModelDef[]; future: ModelDef[] }>({ past: [], future: [] });
  const dragBase = useRef<ModelDef | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const bulkInput = useRef<HTMLInputElement>(null);

  // ───── 載入 ─────
  useEffect(() => {
    let off = false;
    void (async () => {
      try {
        const [m, a] = await Promise.all([getModel(id), api<{ assets: Parameters<typeof userAsset>[0][] }>("/api/doll/assets?kind=head").catch(() => ({ assets: [] }))]);
        if (off) return;
        setDetail(m); setRev(m.revision); setName(m.name); setDefState(m.def);
        setHeads([...BUILTIN_HEADS, ...a.assets.map(userAsset).filter((x): x is DollAsset => !!x && x.kind === "head")]);
        const saved = await readDraft<Draft>("model:" + id).catch(() => null);
        if (off) return;
        if (saved && confirm("發現這個身體未保存的編輯，是否繼續？取消會捨棄這份本機草稿。")) {
          setDefState(saved.def); setName(saved.name); setDirty(true);
          if (saved.rev !== m.revision) setNotice(`草稿基於第 ${saved.rev} 版，目前最新是第 ${m.revision} 版；保存前請重新檢查。`);
        } else if (saved) await clearDraft("model:" + id);
      } catch (e) { toast((e as Error).message, "err"); navigate("/dressing/assets", true); }
    })();
    fetchPoses().then(setPoses).catch(() => undefined);
    return () => { off = true; };
  }, [id]);
  useEffect(() => {
    if (!dirty || !def) return;
    const t = window.setTimeout(() => void writeDraft("model:" + id, { def, rev, name } satisfies Draft).catch(() => undefined), 600);
    return () => clearTimeout(t);
  }, [def, dirty, name, rev, id]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // ───── 模型、渲染器 ─────
  const model: AvatarModel | null = useMemo(() => (def ? buildModel(id, rev, def, name) : null), [def, id, rev, name]);
  const renderer = useMemo(() => new DollRenderer(), []);
  const original = useMemo(() => new DollRenderer(), []);
  useEffect(() => { if (model) renderer.setModel(model); }, [model, renderer]);
  const rig = model?.rig ?? RIG_V2;

  /** 修改定義：commit＝記入撤銷紀錄（拖動期間只在開始時記一次） */
  const setDef = (next: ModelDef, commit = true) => {
    if (!def) return;
    if (commit) { hist.current.past.push(def); if (hist.current.past.length > 80) hist.current.past.shift(); hist.current.future = []; setHistN((n) => n + 1); }
    setDefState(next); setDirty(true);
  };
  const undo = (dir: "undo" | "redo") => {
    if (!def) return;
    const from = dir === "undo" ? hist.current.past : hist.current.future, to = dir === "undo" ? hist.current.future : hist.current.past;
    const t = from.pop();
    if (!t) return;
    to.push(def); setDefState(t); setDirty(true); setHistN((n) => n + 1);
  };

  const headAsset = heads.find((h) => h.id === headId) ?? BUILTIN_HEADS[0];
  const rawHead = headAsset.config as HeadConfig;
  const fit = model ? headFitFor(model, headId) : { dx: 0, dy: 0, s: 1 };
  const restPose = tab === "preview" ? pose : {};
  const scene: Scene = useMemo(() => ({
    hair: showHair ? adjustHair(BUILTIN_HAIRS[0].config, compare ? { dx: 0, dy: 0, s: 1 } : fit) : null,
    head: compare ? rawHead : adjustHead(rawHead, fit), main: null, accent: null, tip: null, pose: clampPose(compare ? RIG_V2 : rig, restPose), front: [], items: [],
  }), [showHair, compare, fit.dx, fit.dy, fit.s, rawHead, rig, restPose]);

  // ───── 鏡頭 ─────
  const camera = viewKey && VIEW_PRESETS[viewKey] ? frame(VIEW_PRESETS[viewKey], stageSize) : cam;
  const moveCamera = (c: Camera) => { setCam(c); setViewKey(null); };
  const xf = transform(camera, stageSize);

  // ───── 部件 ─────
  const partRect = (name: string) => { const p = rig.parts[name]; return { x: p.x, y: p.y, w: p.w, h: p.h, rot: p.rot ?? 0 }; };
  const setPart = (name: string, patch: Partial<ModelDef["parts"][string]>, commit = true) => {
    if (!def) return;
    const p = rig.parts[name];
    const cur = def.parts[name] ?? { x: p.x, y: p.y, w: p.w, h: p.h };
    setDef({ ...def, parts: { ...def.parts, [name]: { ...cur, ...patch } } }, commit);
  };
  const resetPart = (name: string) => { if (!def) return; const parts = { ...def.parts }; delete parts[name]; setDef({ ...def, parts }); };
  async function uploadPart(name: string, file: File) {
    if (!def || !model) return null;
    const p = await prepareAsset(file, 2048);
    const crop = [p.box.x0 * p.sourceW, p.box.y0 * p.sourceH, p.box.x1 * p.sourceW, p.box.y1 * p.sourceH].map(Math.round);
    const q = new URLSearchParams({ src_w: String(p.sourceW), src_h: String(p.sourceH), x0: String(crop[0]), y0: String(crop[1]), x1: String(crop[2]), y1: String(crop[3]) });
    const up = await api<{ ref: string }>(`/api/doll/models/${id}/files?${q}`, { method: "POST", body: p.blob, headers: { "content-type": "image/png" } });
    // 與角色完全對齊的全畫布 PNG（2:3）：直接按原圖座標對位；已裁剪的圖片：放在原本部件的位置，之後手動微調
    const full = Math.abs(p.sourceH / p.sourceW - 1.5) < 0.015;
    const o = rig.parts[name], ar = p.height / p.width;
    let rect: { x: number; y: number; w: number; h: number };
    if (full) rect = { x: p.box.x0 * 1200, y: p.box.y0 * 1800, w: (p.box.x1 - p.box.x0) * 1200, h: (p.box.y1 - p.box.y0) * 1800 };
    else { let h = o.h, w = h / ar; if (w > o.w * 1.6) { w = o.w; h = w * ar; } rect = { x: o.x + o.w / 2 - w / 2, y: o.y + o.h / 2 - h / 2, w, h }; }
    return { name, patch: { file: up.ref, x: r1(rect.x), y: r1(rect.y), w: r1(rect.w), h: r1(rect.h), src: { w: p.sourceW, h: p.sourceH, crop: crop as [number, number, number, number] } }, full };
  }
  async function onFiles(files: File[], bulk: boolean) {
    if (!def) return;
    setBusy(true);
    let next = def, n = 0, aligned = 0;
    try {
      for (const f of files) {
        const base = f.name.replace(/\.[a-z]+$/i, "").toLowerCase();
        const target = bulk ? EDITABLE_PARTS.find((p) => p === base || base.endsWith("_" + p) || base.endsWith("-" + p)) : selPart;
        if (!target) { toast(`「${f.name}」未能對應身體部件（檔名例如 hand_r.png）`, "err"); continue; }
        const r = await uploadPart(target, f);
        if (!r) continue;
        const p = rig.parts[target];
        next = { ...next, parts: { ...next.parts, [target]: { ...(next.parts[target] ?? { x: p.x, y: p.y, w: p.w, h: p.h }), ...r.patch } } };
        n++; if (r.full) aligned++;
      }
      if (n) { setDef(next); toast(`已替換 ${n} 個部件${aligned ? `（${aligned} 個按全畫布座標自動對位）` : "，請拖動微調位置"}`); }
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  }

  // ───── 舞台選取及拖動 ─────
  const selection = useMemo(() => {
    if (compare) return null;
    if (tab === "parts" && selPart) { const p = partRect(selPart); return { fit: { cx: p.x + p.w / 2, cy: p.y + p.h / 2, w: p.w, rotation: p.rot }, content: FULL_CONTENT(p.h / p.w), bone: "world", rotate: true }; }
    if (tab === "head") { const h = adjustHead(rawHead, fit); return { fit: { cx: h.x + h.w / 2, cy: h.y + h.h / 2, w: h.w, rotation: 0 }, content: FULL_CONTENT(h.h / h.w), bone: "world", rotate: false }; }
    return null;
  }, [tab, selPart, rig, compare, rawHead, fit.dx, fit.dy, fit.s]);
  function onFit(f: Fit) {
    if (!def) return;
    const commit = !dragBase.current;
    if (commit) dragBase.current = def;
    window.clearTimeout(fitTimer.current); fitTimer.current = window.setTimeout(() => { dragBase.current = null; }, 400);
    if (tab === "parts" && selPart) {
      const h = fitHeight(f, selection!.content.ar);
      setPart(selPart, { x: r1(f.cx - f.w / 2), y: r1(f.cy - h / 2), w: r1(f.w), h: r1(h), rot: r1(f.rotation) || undefined }, commit);
    } else if (tab === "head") {
      const s = Math.min(2, Math.max(0.5, f.w / rawHead.w)), nx = f.cx - (rawHead.w * s) / 2, ny = f.cy - (rawHead.h * s) / 2;
      setHeadFit({ s: Math.round(s * 1000) / 1000, dx: r1(nx - 600 - (rawHead.x - 600) * s), dy: r1(ny - 300 - (rawHead.y - 300) * s) }, commit);
    }
  }
  const fitTimer = useRef(0);
  function onPick(x: number, y: number) {
    if (tab !== "parts") return;
    // 靜止姿勢：找出包含這一點、面積最小的部件（重疊時較細的部件優先，例如手掌在前臂上）
    let best: string | null = null, area = Infinity;
    for (const n of EDITABLE_PARTS) {
      const p = rig.parts[n];
      if (!p || p.hidden) continue;
      const t = (-(p.rot ?? 0) * Math.PI) / 180, cx = p.x + p.w / 2, cy = p.y + p.h / 2;
      const lx = (x - cx) * Math.cos(t) - (y - cy) * Math.sin(t), ly = (x - cx) * Math.sin(t) + (y - cy) * Math.cos(t);
      if (Math.abs(lx) <= p.w / 2 && Math.abs(ly) <= p.h / 2 && p.w * p.h < area) { best = n; area = p.w * p.h; }
    }
    setSelPart(best);
  }
  const setHeadFit = (f: { dx: number; dy: number; s: number }, commit = true) => {
    if (!def) return;
    if (headOnly) setDef({ ...def, heads: { ...(def.heads ?? {}), [headId]: f } }, commit);
    else setDef({ ...def, head: f }, commit);
  };

  // ───── 骨架及錨點控制點（疊在舞台上；只有圓點可以點，其他位置照常縮放平移） ─────
  const handles = useMemo(() => {
    if (compare) return [];
    if (tab === "bones") return rig.bones.filter((b) => BODY_BONES.has(b.id)).map((b) => ({ id: b.id, at: b.pivot as [number, number], label: BONE_LABEL[b.id] ?? b.id }));
    if (tab === "anchors") return Object.entries(rig.anchors).map(([k, v]) => ({ id: k, at: v as [number, number], label: ANCHOR_LABEL[k] ?? k }));
    return [];
  }, [tab, rig, compare]);
  const active = tab === "bones" ? selJoint : selAnchor;
  const drag = useRef<{ id: string; pointer: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const toLogical = (e: { clientX: number; clientY: number }): [number, number] => { const r = svgRef.current!.getBoundingClientRect(); return [(e.clientX - r.left - xf.ox) / xf.k, (e.clientY - r.top - xf.oy) / xf.k]; };
  const moveHandle = (hid: string, to: [number, number], base: ModelDef) => {
    if (tab === "bones") setDefState(moveJoint(base, buildModel(id, rev, base).rig, hid, [r1(to[0]), r1(to[1])], withChildren));
    else setDefState({ ...base, anchors: { ...base.anchors, [hid]: [r1(to[0]), r1(to[1])] } });
    setDirty(true);
  };
  const hDown = (hid: string) => (e: ReactPointerEvent<SVGCircleElement>) => {
    if (!def) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { id: hid, pointer: e.pointerId };
    dragBase.current = def;
    hist.current.past.push(def); hist.current.future = []; setHistN((n) => n + 1);
    if (tab === "bones") setSelJoint(hid); else setSelAnchor(hid);
  };
  const hMove = (e: ReactPointerEvent<SVGCircleElement>) => { const d = drag.current; if (!d || d.pointer !== e.pointerId || !dragBase.current) return; moveHandle(d.id, toLogical(e), dragBase.current); };
  const hUp = () => { drag.current = null; dragBase.current = null; };
  const resetJoint = (bid: string) => { if (!def) return; const v2 = RIG_V2.bones.find((b) => b.id === bid)!; let next = moveJoint(def, rig, bid, [v2.pivot[0], v2.pivot[1]], withChildren); const b = { ...next.bones }; if (b[bid]) { const { min: _a, max: _b, ...rest } = b[bid]; void _a; void _b; b[bid] = rest; } next = { ...next, bones: b }; setDef(next); };
  const joint = selJoint ? rig.bones.find((b) => b.id === selJoint) : null;
  const setLimits = (bid: string, min: number, max: number) => { if (!def) return; setDef({ ...def, bones: { ...def.bones, [bid]: { ...def.bones[bid], min: Math.min(0, Math.max(-180, min)), max: Math.max(0, Math.min(180, max)) } } }); };

  // ───── 姿勢預覽 ─────
  const previewControls = useMemo(() => (tab === "preview" && !compare ? controlsFor(poseControls(rig, null), "ik", "all") : []), [tab, rig, compare]);

  // ───── 保存 ─────
  async function save() {
    if (!def || !model) return;
    setBusy(true);
    try {
      const r = await api<ModelDetail>(`/api/doll/models/${id}/def`, { method: "PUT", json: { def: compactDef(def), expected_revision: rev } });
      if (name.trim() && name.trim() !== detail?.name) await api(`/api/doll/models/${id}`, { method: "PATCH", json: { name: name.trim() } });
      try {
        const thumbRenderer = new DollRenderer(buildModel(id, r.revision, r.def, name));
        const blob = await thumbRenderer.thumbnail({ ...scene, pose: {} }, 240);
        if (blob) await api(`/api/doll/models/${id}/thumb`, { method: "PUT", body: blob, headers: { "content-type": "image/jpeg" } });
      } catch { /* 縮圖失敗不影響身體 */ }
      setDetail(r); setRev(r.revision); setDefState(r.def); setDirty(false); setNotice("");
      await clearDraft("model:" + id).catch(() => undefined);
      toast(`已保存為第 ${r.revision} 版。已保存的舊造型仍使用原本版本。`);
    } catch (e) {
      toast((e as Error).message, "err");
      if (e instanceof ApiError && e.code === "model_conflict") setNotice("另一裝置已更新這個身體：你的編輯已保留在本機草稿。請重新開啟並檢查最新版本後再修改。");
    } finally { setBusy(false); }
  }
  const leave = () => { if (!dirty || confirm("身體的修改尚未保存，確定離開？（本機草稿會保留）")) navigate("/dressing/assets"); };

  if (!def || !model || !detail) return <div className="fixed inset-0 z-40 grid place-items-center bg-plum"><Spinner /></div>;
  const float = "bg-ink/45 text-cream ring-1 ring-gold/40 backdrop-blur";
  const sp = selPart ? partRect(selPart) : null;
  const order = def.order ?? RIG_V2.body_parts;
  const curFit = headOnly ? def.heads?.[headId] ?? def.head : def.head;
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-plum" data-testid="model-editor" data-dirty={dirty ? "1" : "0"} data-rev={rev} data-def={JSON.stringify(compactDef(def))}>
      <div className="safe-top shrink-0 bg-ink">
        <div className="flex h-12 items-center gap-1.5 px-2.5">
          <button type="button" aria-label="返回角色素材" onClick={leave} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconChevronLeft /></button>
          <input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} aria-label="身體名稱" data-testid="model-name" className="h-9 min-w-0 flex-1 rounded-full border border-transparent bg-transparent px-2 font-serif text-[16px] font-bold text-gold-soft focus:border-gold/50 focus:outline-none" />
          <span className="shrink-0 text-[10.5px] text-mauve">第 {rev} 版</span>
          {dirty && <span className="shrink-0 text-[10.5px] text-wine">未保存</span>}
          <button type="button" data-testid="model-save" disabled={busy || !dirty} onClick={() => void save()} className="btn-jewel flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] disabled:opacity-50"><IconSave className="text-[14px]" />{busy ? "…" : "保存"}</button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <Stage renderer={compare ? original : renderer} scene={scene} rig={compare ? RIG_V2 : rig} camera={camera} onCamera={moveCamera} onSize={setStageSize}
          mode={compare ? "view" : tab === "preview" ? "pose" : tab === "parts" || tab === "head" ? "dress" : "view"} selection={selection} onPick={onPick} onFit={onFit}
          controls={previewControls} skeleton={{ opacity: 0.9, bones: tab === "preview" ? new Set(rig.bones.map((b) => b.id)) : null }} onPose={(p) => setPose(p)}>
          <svg ref={svgRef} data-stage-ui className="pointer-events-none absolute inset-0 h-full w-full" data-testid="model-handles">
            {tab === "parts" && sp && !compare && <text x={8} y={stageSize.h - 10} fill="#f0d9c0" fontSize={11}>{PART_LABEL[selPart!]}</text>}
            {tab === "bones" && rig.bones.filter((b) => b.parent && BODY_BONES.has(b.id) && BODY_BONES.has(b.parent)).map((b) => {
              const a = rig.bones.find((x) => x.id === b.parent)!.pivot;
              return <line key={b.id} x1={a[0] * xf.k + xf.ox} y1={a[1] * xf.k + xf.oy} x2={b.pivot[0] * xf.k + xf.ox} y2={b.pivot[1] * xf.k + xf.oy} stroke="#fffaf6" strokeOpacity={0.7} strokeWidth={1.2} />;
            })}
            {handles.map((h) => {
              const x = h.at[0] * xf.k + xf.ox, y = h.at[1] * xf.k + xf.oy, on = active === h.id;
              return (
                <g key={h.id} data-model-handle={h.id} data-x={x.toFixed(1)} data-y={y.toFixed(1)}>
                  <circle cx={x} cy={y} r={on ? 7 : 5} fill={on ? "#f28ba3" : "rgb(255 250 246 / 0.3)"} stroke="#2a1526" strokeWidth={2.5} />
                  <circle cx={x} cy={y} r={on ? 7 : 5} fill="none" stroke={tab === "bones" ? "#f28ba3" : "#9fd7ff"} strokeWidth={1.4} />
                  <circle cx={x} cy={y} r={18} fill="transparent" style={{ pointerEvents: "auto", touchAction: "none", cursor: "grab" }} onPointerDown={hDown(h.id)} onPointerMove={hMove} onPointerUp={hUp} onPointerCancel={hUp} />
                  {on && <text x={x + 10} y={y - 8} fill="#fffaf6" fontSize={11} stroke="#2a1526" strokeWidth={3} paintOrder="stroke">{h.label}</text>}
                </g>
              );
            })}
          </svg>
          <div data-stage-ui className="absolute left-2 top-2 flex flex-col gap-1">
            {Object.entries(VIEW_PRESETS).map(([k, v]) => <button key={k} type="button" aria-pressed={viewKey === k} onClick={() => setViewKey(k)} className={`rounded-full px-2.5 py-1 text-[11px] ${viewKey === k ? "chip-on" : float}`}>{v.label}</button>)}
          </div>
          <div data-stage-ui className="absolute right-2 top-2 flex flex-col items-center gap-1.5">
            <button type="button" aria-label="放大" disabled={camera.z >= ZOOM.max} onClick={() => moveCamera(zoomAt(camera, stageSize, 1.4))} className={`grid h-8 w-8 place-items-center rounded-full ${float}`}>＋</button>
            <span className={`rounded-full px-1.5 text-[10.5px] ${float}`}>{Math.round(camera.z * 100)}%</span>
            <button type="button" aria-label="縮小" disabled={camera.z <= ZOOM.min} onClick={() => moveCamera(zoomAt(camera, stageSize, 1 / 1.4))} className={`grid h-8 w-8 place-items-center rounded-full ${float}`}>－</button>
            <button type="button" aria-label={compare ? "顯示修改後" : "比較原本 Avatar V2"} data-testid="model-compare" aria-pressed={compare} onClick={() => setCompare(!compare)} className={`rounded-full px-2 py-1 text-[10.5px] ${compare ? "chip-on" : float}`}>{compare ? "原本" : "對比"}</button>
            <button type="button" aria-label={showHair ? "隱藏頭髮" : "顯示頭髮"} onClick={() => setShowHair(!showHair)} className={`grid h-8 w-8 place-items-center rounded-full ${float}`}>{showHair ? <IconEye /> : <IconEyeOff />}</button>
          </div>
          <div data-stage-ui className="absolute bottom-2 left-2 flex gap-1.5">
            <button type="button" aria-label="撤銷" data-testid="model-undo" disabled={!hist.current.past.length} onClick={() => undo("undo")} className={`grid h-8 w-8 place-items-center rounded-full disabled:opacity-35 ${float}`}>↶</button>
            <button type="button" aria-label="重做" disabled={!hist.current.future.length} onClick={() => undo("redo")} className={`grid h-8 w-8 place-items-center rounded-full disabled:opacity-35 ${float}`}>↷</button>
          </div>
          {notice && <p data-stage-ui role="status" className="pointer-events-none absolute inset-x-14 top-2 rounded-2xl bg-ink/80 px-3 py-2 text-center text-[11px] text-gold-soft">{notice}</p>}
          {compare && <span data-stage-ui className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-danger/85 px-3 py-1 text-[11px] text-white">原本 Avatar V2（修改前）</span>}
        </Stage>
      </div>
      <div className="shrink-0 border-t border-gold/40 bg-velvet px-3 pb-[max(env(safe-area-inset-bottom),8px)] pt-2" style={{ maxHeight: "42vh" }}>
        <Row className="pb-2">{TABS.map(([t, label]) => <button key={t} type="button" data-model-tab={t} aria-pressed={tab === t} onClick={() => { setTab(t); if (t !== "preview") setPose({}); }} className={pill(tab === t)}>{label}</button>)}</Row>
        <div className="scrollbar-none max-h-[30vh] overflow-y-auto pb-2 text-[12.5px]">
          {tab === "parts" && (<>
            <Row className="pb-2">
              {EDITABLE_PARTS.map((n) => {
                const p = rig.parts[n];
                return (
                  <button key={n} type="button" data-part={n} aria-pressed={selPart === n} onClick={() => setSelPart(selPart === n ? null : n)} className="w-[58px] shrink-0">
                    <div className={`relative aspect-square rounded-xl bg-cream/80 ${selPart === n ? "outline-2 outline-offset-1 outline-gold-soft" : ""} ${p.hidden ? "opacity-40" : ""}`}>
                      <img src={refUrl(partImage(model, p))} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-1" />
                      {def.parts[n] && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-gold" title="已修改" />}
                    </div>
                    <div className="truncate pt-0.5 text-center text-[10px]">{PART_LABEL[n]}</div>
                  </button>
                );
              })}
            </Row>
            {selPart && sp ? (
              <div className="space-y-1.5 rounded-xl bg-white/5 p-2" data-testid="part-editor">
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" disabled={busy} onClick={() => fileInput.current?.click()} className="btn-jewel rounded-full px-3 py-1.5 text-[12px]">上傳替換圖片</button>
                  <button type="button" onClick={() => setPart(selPart, { hidden: !rig.parts[selPart].hidden || undefined })} className="chip rounded-full px-3 py-1.5">{rig.parts[selPart].hidden ? "顯示部件" : "隱藏部件"}</button>
                  <button type="button" disabled={!def.parts[selPart]} onClick={() => resetPart(selPart)} className="chip rounded-full px-3 py-1.5 disabled:opacity-40">重設此部件</button>
                  <a href={refUrl(partImage(model, rig.parts[selPart]))} target="_blank" rel="noreferrer" className="chip rounded-full px-3 py-1.5">查看原始圖片</a>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <Num label="X" value={sp.x} onChange={(v) => setPart(selPart, { x: v })} />
                  <Num label="Y" value={sp.y} onChange={(v) => setPart(selPart, { y: v })} />
                  <Num label="闊度" value={sp.w} onChange={(v) => setPart(selPart, { w: Math.max(4, v) })} step={2} />
                  <Num label="高度" value={sp.h} onChange={(v) => setPart(selPart, { h: Math.max(4, v) })} step={2} />
                  <Num label="旋轉" value={sp.rot} onChange={(v) => setPart(selPart, { rot: Math.max(-180, Math.min(180, v)) || undefined })} />
                  <label className="flex items-center gap-1 text-[11.5px]"><span className="w-9 shrink-0 text-mauve">附接</span>
                    <select aria-label="附接骨骼" value={rig.parts[selPart].bone} onChange={(e) => setPart(selPart, { bone: e.target.value })} className="h-7 flex-1 rounded-full bg-white/10 px-2 text-cream">{[...BODY_BONES].map((b) => <option key={b} value={b}>{BONE_LABEL[b] ?? b}</option>)}</select>
                  </label>
                </div>
                {def.parts[selPart]?.src && <p className="text-[10.5px] text-mauve">原圖 {def.parts[selPart]!.src!.w}×{def.parts[selPart]!.src!.h}，裁剪範圍 {def.parts[selPart]!.src!.crop.join(", ")}</p>}
              </div>
            ) : <p className="text-[11.5px] leading-snug text-mauve">在角色上點選或在上面選擇部件，拖動移動，角位把手縮放及旋轉。與角色對齊的全畫布 PNG（1200×1800 或同比例）會自動對位；已裁剪的圖片放在原部件位置後手動微調。</p>}
            <button type="button" disabled={busy} onClick={() => bulkInput.current?.click()} className="chip mt-2 rounded-full px-3 py-1.5 text-[12px]">按檔名批量替換（例如 hand_r.png）</button>
          </>)}
          {tab === "bones" && (<>
            <label className="flex items-center gap-2 pb-1.5 text-[12px]"><input type="checkbox" checked={withChildren} onChange={(e) => setWithChildren(e.target.checked)} />連同下游部件一起移動（改變比例，例如加長手臂）；不勾選＝只改旋轉中心</label>
            <Row className="pb-1.5">{rig.bones.filter((b) => BODY_BONES.has(b.id)).map((b) => <button key={b.id} type="button" data-joint={b.id} onClick={() => setSelJoint(b.id)} className={pill(selJoint === b.id)}>{BONE_LABEL[b.id] ?? b.id}{def.bones[b.id] ? " ●" : ""}</button>)}</Row>
            {joint ? (
              <div className="space-y-1.5 rounded-xl bg-white/5 p-2" data-testid="joint-editor">
                <div className="grid grid-cols-2 gap-1.5">
                  <Num label="X" value={joint.pivot[0]} onChange={(v) => setDef(moveJoint(def, rig, joint.id, [v, joint.pivot[1]], withChildren))} />
                  <Num label="Y" value={joint.pivot[1]} onChange={(v) => setDef(moveJoint(def, rig, joint.id, [joint.pivot[0], v], withChildren))} />
                  <Num label="最小" value={joint.min_angle} onChange={(v) => setLimits(joint.id, v, joint.max_angle)} step={5} />
                  <Num label="最大" value={joint.max_angle} onChange={(v) => setLimits(joint.id, joint.min_angle, v)} step={5} />
                </div>
                <p className="text-[10.5px] text-mauve">原本 Avatar V2：活動範圍 {RIG_V2.bones.find((b) => b.id === joint.id)!.min_angle}° 至 {RIG_V2.bones.find((b) => b.id === joint.id)!.max_angle}°。不建議完全取消角度限制，以免部件接縫露出空隙。</p>
                <button type="button" onClick={() => resetJoint(joint.id)} className="chip rounded-full px-3 py-1.5">重設這個關節</button>
              </div>
            ) : <p className="text-[11.5px] text-mauve">拖動畫面上的粉紅圓點修改靜止關節位置。這裡只改變身體模型，不是擺姿勢；擺姿勢請到「預覽」。</p>}
          </>)}
          {tab === "anchors" && (<>
            <Row className="pb-1.5">{Object.keys(rig.anchors).map((k) => <button key={k} type="button" onClick={() => setSelAnchor(k)} className={pill(selAnchor === k)}>{ANCHOR_LABEL[k] ?? k}{def.anchors[k] ? " ●" : ""}</button>)}</Row>
            {selAnchor ? (
              <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-white/5 p-2">
                <Num label="X" value={rig.anchors[selAnchor][0]} onChange={(v) => setDef({ ...def, anchors: { ...def.anchors, [selAnchor]: [v, rig.anchors[selAnchor][1]] } })} />
                <Num label="Y" value={rig.anchors[selAnchor][1]} onChange={(v) => setDef({ ...def, anchors: { ...def.anchors, [selAnchor]: [rig.anchors[selAnchor][0], v] } })} />
                <button type="button" disabled={!def.anchors[selAnchor]} onClick={() => { const a = { ...def.anchors }; delete a[selAnchor]; setDef({ ...def, anchors: a }); }} className="chip rounded-full px-3 py-1.5 disabled:opacity-40">重設</button>
              </div>
            ) : <p className="text-[11.5px] text-mauve">錨點是衣物自動對位及換算用的身體地標（肩線、腰線、膝、踝…）。身體比例改變後，把藍色圓點拖到新身體的對應位置。</p>}
          </>)}
          {tab === "layers" && (
            <ol className="space-y-1" data-testid="model-layers">
              {[...order].reverse().map((n, ri) => {
                const i = order.length - 1 - ri;
                const swap = (j: number) => { const a = [...order]; [a[i], a[j]] = [a[j], a[i]]; setDef({ ...def, order: a }); };
                return (
                  <li key={n} className="flex items-center gap-1.5 rounded-xl bg-white/5 px-2 py-1">
                    <span className="min-w-0 flex-1 truncate">{PART_LABEL[n] ?? n}</span>
                    <button type="button" aria-label="移前" disabled={i === order.length - 1} onClick={() => swap(i + 1)} className="chip h-7 rounded-full px-2 disabled:opacity-30">↑</button>
                    <button type="button" aria-label="移後" disabled={i === 0} onClick={() => swap(i - 1)} className="chip h-7 rounded-full px-2 disabled:opacity-30">↓</button>
                  </li>
                );
              })}
              <li className="pt-1"><button type="button" disabled={!def.order} onClick={() => { const { order: _o, ...rest } = def; void _o; setDef(rest as ModelDef); }} className="chip rounded-full px-3 py-1.5 disabled:opacity-40">恢復 V2 次序</button></li>
            </ol>
          )}
          {tab === "head" && (<>
            <Row className="pb-1.5">{heads.map((h) => <button key={h.id} type="button" onClick={() => { setHeadId(h.id); setHeadOnly(!!def.heads?.[h.id]); }} className={pill(headId === h.id)}>{h.name}{def.heads?.[h.id] ? " ●" : ""}</button>)}</Row>
            <label className="flex items-center gap-2 pb-1.5 text-[12px]"><input type="checkbox" checked={headOnly} onChange={(e) => setHeadOnly(e.target.checked)} />只套用於這個頭部（其他頭部使用身體的預設頭部對位）</label>
            <div className="grid grid-cols-2 gap-1.5">
              <Num label="左右" value={curFit.dx} onChange={(v) => setHeadFit({ ...curFit, dx: v })} />
              <Num label="上下" value={curFit.dy} onChange={(v) => setHeadFit({ ...curFit, dy: v })} />
              <Num label="大小" value={curFit.s} step={0.02} onChange={(v) => setHeadFit({ ...curFit, s: Math.min(2, Math.max(0.5, Math.round(v * 1000) / 1000)) })} />
              {headOnly && def.heads?.[headId] && <button type="button" onClick={() => { const h = { ...(def.heads ?? {}) }; delete h[headId]; setDef({ ...def, heads: h }); }} className="chip rounded-full px-3 py-1.5">改回使用身體預設</button>}
            </div>
            <p className="pt-1 text-[11px] text-mauve">拖動畫面上的頭部框移動及縮放。頭髮會跟隨頭部一起移動。頭部素材本身（位置及圖片）不會被修改。</p>
          </>)}
          {tab === "preview" && (<>
            <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-8">
              {POSE_PRESETS.map((p) => <button key={p.id} type="button" onClick={() => setPose(p.pose)} className="rounded-xl bg-white/5 px-1 py-2 text-[11px]">{p.label}</button>)}
              {poses.filter((p) => !p.model_id || p.model_id === id).map((p) => <button key={p.id} type="button" onClick={() => setPose(p.pose)} className="rounded-xl bg-amethyst/25 px-1 py-2 text-[11px]">{p.name}</button>)}
              <button type="button" onClick={() => setPose({})} className="chip rounded-xl px-1 py-2 text-[11px]">靜止</button>
            </div>
            <p className="pt-1.5 text-[11px] text-mauve">拖動手腳控制點預覽活動範圍。預覽姿勢不會保存到身體。</p>
            <button type="button" disabled={busy || dirty} onClick={() => void exportModelPackage(id).catch((e) => toast((e as Error).message, "err"))} className="chip mt-2 rounded-full px-3 py-1.5 text-[12px]">匯出角色套件（ZIP）{dirty ? "（先保存）" : ""}</button>
          </>)}
        </div>
      </div>
      <input ref={fileInput} type="file" accept="image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onFiles([f], false); }} />
      <input ref={bulkInput} type="file" accept="image/png,image/webp" multiple hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) void onFiles(f, true); }} />
    </div>
  );
}
