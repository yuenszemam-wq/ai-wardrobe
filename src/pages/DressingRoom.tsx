// 角色換裝工作室（Phase 3）：角色始終可見，底部短面板切換「衣服／圖層／外貌／姿勢」。
// 穿著衣服時可直接在畫布上調整骨架；衣物自由疊穿；頭部及髮型可在這裡上傳及校正。
import { useEffect, useMemo, useRef, useState } from "react";
import { Pose, applyMat, clampPose, invert, samePose, solve } from "../../shared/avatarRig";
import { BUILTIN_HAIR_ID, BUILTIN_HEAD_ID, DollAsset, FrontPart, HairConfig, HairPart, refUrl, POSE_PRESETS, hairBoneId, hexToRgb, resolveHairColors, rigFor } from "../../shared/avatarV2";
import { DOLL_H, DOLL_W, FULL_CONTENT, Fit, fitHeight, LookState, SLEEVE_ROT_LIMIT, SY_LIMIT, insertIndex, layeringHints, normalizeFit, normalizeTemplateData, sameFit, defaultFit, Variant, WearOpts } from "../../shared/doll";
import { poseDistance, suggestSleeveRot } from "../../shared/garmentMesh";
import { api, Garment } from "../api";
import { IconChevronLeft, IconChevronUp, IconExpand, IconHeart, IconLayers, IconMore, IconPerson, IconPose, IconSave, IconShirt } from "../components/icons";
import { Spinner, toast } from "../components/ui";
import { AssetPanel, Draft } from "../doll/AssetPanel";
import { Analysis, analyze, canvasBlob, loadImage, prepareAsset } from "../doll/content";
import { DollRenderer, Scene, VIEWS, mainBone } from "../doll/engine";
import { Appearance, DEFAULT_APPEARANCE, GarmentLite, Resolved, Template, Templates, Worn, fetchLook, fetchTemplates, addHairParts, hairOf, headOf, imageOf, resolve, sceneItem, userAsset, wornFor } from "../doll/model";
import { AppearancePanel, ClothesPanel, FitPanel, FitTool, LayersPanel, LookTab, MaskTool, PartTool, PosePanel } from "../doll/panels";
import { Selection, Stage, poseHandles, PoseHandle } from "../doll/Stage";
import { navigate } from "../router";

type Tab = "clothes" | "layers" | "look" | "pose";
const TABS: { id: Tab; label: string; Icon: typeof IconShirt }[] = [
  { id: "clothes", label: "衣服", Icon: IconShirt },
  { id: "layers", label: "圖層", Icon: IconLayers },
  { id: "look", label: "外貌", Icon: IconPerson },
  { id: "pose", label: "姿勢", Icon: IconPose },
];
const MASK_W = 256;
/** 正在編輯的遮罩／部件圖（像素緩衝）。塗抹時直接預覽，放手才寫入造型（每一筆＝一步，可以撤銷） */
interface EditBuf { kind: "mask" | "parts"; key: string; w: number; h: number; data: Uint8ClampedArray; ready: boolean; committed: string | null; last: [number, number] | null; dirty: boolean; at: number }
interface Snap { worn: Worn[]; pose: Pose; front: FrontPart[]; look: Appearance }

export default function DressingRoom({ id }: { id?: string }) {
  const renderer = useMemo(() => new DollRenderer(), []);
  const [garments, setGarments] = useState<Garment[] | null>(null);
  const [extra, setExtra] = useState<GarmentLite[]>([]);
  const [tpls, setTpls] = useState<Templates | null>(null);
  const [assets, setAssets] = useState<DollAsset[]>([]);
  const [analyses, setAnalyses] = useState<Map<string, Analysis>>(new Map());
  const [worn, setWorn] = useState<Worn[]>([]);
  const [look, setLook] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [pose, setPoseState] = useState<Pose>({});
  const [front, setFront] = useState<FrontPart[]>([]);
  const [name, setName] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const [tab, setTab] = useState<Tab>("clothes");
  const [panel, setPanel] = useState<"mid" | "max">("mid");
  const [focus, setFocus] = useState(false);
  const [viewKey, setViewKey] = useState("full");
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<FitTool>("place");
  const [maskTool, setMaskTool] = useState<MaskTool>({ mode: "hide", size: 34 });
  const [partTool, setPartTool] = useState<PartTool>({ label: 1, size: 40 });
  const [hint, setHint] = useState(true);
  const [, setHistN] = useState(0);
  const [showHandles, setShowHandles] = useState(true);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const [lookTab, setLookTab] = useState<LookTab>("hair");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hairSelected,setHairSelected]=useState<string|null>(null);
  const [hairTool,setHairTool]=useState<"place"|"mesh">("place");
  const [menu, setMenu] = useState(false);
  const [ready, setReady] = useState(false);

  const requested = useRef(new Set<string>());
  const generation = useRef(0);
  const autoView = useRef(false);
  const edit = useRef<EditBuf | null>(null);
  const hist = useRef<{ past: Snap[]; future: Snap[]; base: Snap | null; prev: Snap | null; timer: number; start: number; skip: boolean }>({ past: [], future: [], base: null, prev: null, timer: 0, start: 0, skip: false });
  const variantFile = useRef<HTMLInputElement>(null);
  const hairFrame = useRef<{ id: string; y0: number } | null>(null);

  // ───── 載入 ─────
  useEffect(() => {
    api<{ garments: Garment[] }>("/api/garments?limit=200&status=active&transparent=1").then((r) => setGarments(r.garments)).catch((e) => toast((e as Error).message, "err"));
  }, []);
  const loadAssets = () => api<{ assets: Parameters<typeof userAsset>[0][] }>("/api/doll/assets").then((r) => setAssets(r.assets.map(userAsset).filter((a): a is DollAsset => !!a)));
  useEffect(() => {
    const ticket = ++generation.current;
    setLoaded(false); setSelected(null); setDraft(null); setHairSelected(null); setHairTool("place"); setDirty(false); setNotice(""); setMenu(false);
    void (async () => {
      const [t, l] = await Promise.all([fetchTemplates(), id ? fetchLook(id) : null, loadAssets().catch(() => undefined)]);
      if (generation.current !== ticket) return;
      setTpls(t);
      if (l) {
        setExtra(l.look.garments); setWorn(l.worn); setLook(l.appearance); setPoseState(l.pose); setFront(l.front); setName(l.look.name); setFavorite(l.look.is_favorite);
        if (l.converted) { setNotice("這個造型原本用舊角色保存，已自動換算到新角色。檢查位置後按「保存」即完成轉換。"); setDirty(true); }
      } else {
        setExtra([]); setWorn([]); setLook(DEFAULT_APPEARANCE); setPoseState({}); setFront([]); setName(""); setFavorite(false);
      }
      setLoaded(true);
    })().catch((e) => {
      if (generation.current !== ticket) return;
      toast((e as Error).message, "err");
      if (id) navigate("/dressing", true); else { setTpls({ v2: new Map(), v1: new Map() }); setLoaded(true); }
    });
    return () => { generation.current++; };
  }, [id]);

  const gmap = useMemo(() => {
    const m = new Map<string, GarmentLite>();
    for (const g of extra) m.set(g.id, g);
    for (const g of garments ?? []) m.set(g.id, g);
    return m;
  }, [garments, extra]);

  // 需要的圖片：穿上才讀高清圖並量度
  useEffect(() => {
    if (!tpls) return;
    for (const w of worn) {
      const g = gmap.get(w.garment_id);
      if (!g) continue;
      const tpl = tpls.v2.get(g.id);
      const ref = imageOf(w, g, tpl && tpl.image_id === (g.transparent_image_id ?? null) ? tpl : null);
      if (!ref || requested.current.has(ref)) continue;
      requested.current.add(ref);
      void analyze(ref).then((a) => {
        if (a.content.approximate) { requested.current.delete(ref); toast("高清圖未能讀取；暫用縮圖位置，請稍後重試"); }
        setAnalyses((m) => new Map(m).set(ref, a));
      });
    }
  }, [worn, tpls, gmap]);

  const resolved = useMemo(() => (tpls ? worn.map((w) => { const g = gmap.get(w.garment_id); return g ? resolve(w, g, tpls, analyses) : null; }).filter((r): r is Resolved => !!r) : []), [worn, tpls, gmap, analyses]);
  const pending = useMemo(() => { const ok = new Set(resolved.map((r) => r.garment.id)); return new Set(worn.filter((w) => !ok.has(w.garment_id)).map((w) => w.garment_id)); }, [worn, resolved]);
  const sel = resolved.find((r) => r.garment.id === selected) ?? null;

  // ───── 場景 ─────
  const draftPart = draft?.parts.find((p) => p.id === draft.sel) ?? null;
  const hair = useMemo(() => (draft?.kind === "hair" ? { parts: draft.parts } : hairOf(assets, look.hair,look.hair_config)), [draft?.kind === "hair" ? draft.parts : null, assets, look.hair,look.hair_config]);
  const activeHair = !draft && tab === "look" && lookTab === "hair" ? hair?.parts.find(p=>p.id===hairSelected&&!p.hidden)??null : null;
  const head = useMemo(() => { const p = draft?.kind === "head" ? draft.parts[0] : null; return p ? { file: p.file, x: p.x, y: p.y, w: p.w, h: p.h } : headOf(assets, look.head); }, [draft?.kind === "head" ? draft.parts : null, assets, look.head]);
  const rig = useMemo(() => rigFor(hair), [hair]);
  const colors = useMemo(() => (draft?.kind === "hair" ? { main: null, accent: null, tip: null } : { ...resolveHairColors(look.hair_color, look.accent_color), tip: look.tip_color ? hexToRgb(look.tip_color) : null }), [look.hair_color, look.accent_color, look.tip_color, draft?.kind]);
  const editing = sel && !draft && (tool === "mask" || tool === "parts") ? tool : null;
  const overlayKey = editing && hint ? sel!.garment.id : null;
  const scene: Scene = useMemo(() => ({ hair, head, ...colors, pose, front, items: resolved.filter((r) => r.image).map(sceneItem), overlay: overlayKey && editing ? { key: overlayKey, mode: editing } : null }), [hair, head, colors, pose, front, resolved, overlayKey, editing]);
  const mats = useMemo(() => solve(rig, pose), [rig, pose]);

  // ───── 撤銷／重做（衣物、位置、遮罩、部件、姿勢、外貌） ─────
  const snap: Snap = useMemo(() => ({ worn, pose, front, look }), [worn, pose, front, look]);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  useEffect(() => {
    const h = hist.current;
    if (!loaded) { clearTimeout(h.timer); h.past = []; h.future = []; h.base = null; return; }
    if (h.base === null || h.skip) { h.base = snap; h.skip = false; setHistN((n) => n + 1); return; }
    if (h.base === snap) return;
    // 連續的調整（拖動、滑桿）合併成一步；但連續超過一秒就分成另一步，不會把一連串不同的操作併成一步
    const now = Date.now();
    if (h.timer && now - h.start > 1000) { clearTimeout(h.timer); h.timer = 0; commitHist(h.prev ?? snap); }
    if (!h.timer) h.start = now;
    h.prev = snap;
    clearTimeout(h.timer);
    h.timer = window.setTimeout(() => { h.timer = 0; commitHist(snapRef.current); }, 380);
  }, [snap, loaded]);
  /** 把目前累積的改動記為一步 */
  function commitHist(next: Snap) {
    const h = hist.current;
    if (h.base && h.base !== next) { h.past.push(h.base); if (h.past.length > 60) h.past.shift(); h.future = []; }
    h.base = next;
    setHistN((n) => n + 1);
  }
  /** 開始一個獨立的操作（例如一筆遮罩）之前：先把之前未記錄的改動記為一步 */
  function flushHist() { const h = hist.current; if (h.timer) { clearTimeout(h.timer); h.timer = 0; commitHist(snapRef.current); } }
  function timeTravel(dir: "undo" | "redo") {
    const h = hist.current;
    flushHist();
    const from = dir === "undo" ? h.past : h.future, to = dir === "undo" ? h.future : h.past;
    const target = from.pop();
    if (!target) return;
    to.push(snapRef.current);
    h.skip = true;
    setWorn(target.worn); setPoseState(target.pose); setFront(target.front); setLook(target.look); setDirty(true);
    if (selected && !target.worn.some((w) => w.garment_id === selected)) setSelected(null);
  }
  const canUndo = hist.current.past.length > 0 || !!hist.current.timer, canRedo = hist.current.future.length > 0 && !hist.current.timer;
  useEffect(() => { renderer.prune(new Set(worn.map((w) => w.garment_id))); }, [worn, renderer]);

  const change = (fn: (cur: Worn[]) => Worn[]) => { setWorn(fn); setDirty(true); };
  const setItem = (gid: string, v: Partial<Worn>) => change((cur) => cur.map((w) => (w.garment_id === gid ? { ...w, ...v } : w)));
  const setPose = (p: Pose, f?: FrontPart[]) => { setPoseState(p); if (f) setFront(f); setDirty(true); };
  const editLook = (v: Appearance) => { setLook(v); setDirty(true); };
  const patchHair=(id:string,patch:Partial<HairPart>)=>{if(!hair)return;editLook({...look,hair_config:{...hair,parts:hair.parts.map(p=>p.id===id?{...p,...patch}:p)}});};
  const selectHair=(id:string|null)=>{setHairSelected(id);setHairTool("place");setSelected(null);};

  function toggle(g: Garment) {
    if (!tpls || busy) return;
    if (worn.some((w) => w.garment_id === g.id)) {
      change((cur) => cur.filter((w) => w.garment_id !== g.id));
      if (selected === g.id) setSelected(null);
      return;
    }
    const w = wornFor(g, tpls);
    change((cur) => { const at = insertIndex(cur, w.slot); return [...cur.slice(0, at), w, ...cur.slice(at)]; });
  }
  function remove(gid: string) { change((cur) => cur.filter((w) => w.garment_id !== gid)); if (selected === gid) setSelected(null); }
  function order(gid: string, to: "top" | "up" | "down" | "bottom") {
    change((cur) => {
      const i = cur.findIndex((w) => w.garment_id === gid);
      if (i < 0) return cur;
      const j = to === "top" ? cur.length - 1 : to === "bottom" ? 0 : Math.min(cur.length - 1, Math.max(0, i + (to === "up" ? 1 : -1)));
      const next = [...cur];
      const [it] = next.splice(i, 1);
      next.splice(j, 0, it);
      return next;
    });
  }

  // ───── 已選衣物 ─────
  function applyFit(r: Resolved, fit: Fit) {
    const ok = normalizeFit(fit);
    if (!ok) return;
    setItem(r.garment.id, { fit: sameFit(ok, r.base) ? null : ok, v1fit: null });
  }
  const nudge = (r: Resolved, f: { dx?: number; dy?: number; scale?: number; rot?: number; wide?: number; tall?: number }) => {
    // wide＝只改闊度（高度不變）；tall＝只改高度
    const sy = Math.min(SY_LIMIT.max, Math.max(SY_LIMIT.min, ((r.fit.sy ?? 1) * (f.tall ?? 1)) / (f.wide ?? 1)));
    applyFit(r, { ...r.fit, cx: r.fit.cx + (f.dx ?? 0), cy: r.fit.cy + (f.dy ?? 0), w: r.fit.w * (f.scale ?? 1) * (f.wide ?? 1), rotation: r.fit.rotation + (f.rot ?? 0), sy });
  };
  const setOpts = (r: Resolved, o: Partial<WearOpts>) => setItem(r.garment.id, { opts: { ...r.opts, ...o } });

  async function saveTemplate(r: Resolved, patch: (data: ReturnType<typeof normalizeTemplateData>) => { data: ReturnType<typeof normalizeTemplateData>; fit: Fit }, done: string, after?: Partial<Worn>) {
    if (r.analysis.content.approximate) return toast("高清圖未讀取成功，暫時不能存為預設", "err");
    setBusy(true);
    try {
      const cur = r.template?.data ?? normalizeTemplateData(null, r.worn.slot);
      const { data, fit } = patch({ ...cur, converted: undefined });
      const t = await api<Template>(`/api/doll/templates/${r.garment.id}`, { method: "PUT", json: { fit, slot: r.worn.slot, image_id: r.garment.transparent_image_id ?? null, data } });
      setTpls((cur) => (cur ? { v1: cur.v1, v2: new Map(cur.v2).set(r.garment.id, t) } : cur));
      setItem(r.garment.id, { fit: null, v1fit: null, opts: null, mask: null, parts: null, ...after });
      toast(done);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }
  const saveDefault = (r: Resolved) => {
    const v = r.worn.variant;
    return saveTemplate(r, (d) => (v && d.variants[v] ? { data: { ...d, variants: { ...d.variants, [v]: { ...d.variants[v], fit: r.fit, opts: r.opts, mask: r.mask, parts: r.parts, pose: clampPose(rig, pose) } } }, fit: r.template!.fit } : { data: { ...d, opts: r.opts, mask: r.mask, parts: r.parts, pose: clampPose(rig, pose), front }, fit: r.fit }), "已存為這件衣物的預設，之後任何造型穿上都會自動套用");
  };
  const baseRowFit = (r: Resolved) => r.template?.fit ?? (r.worn.variant ? defaultFit(r.worn.slot, r.analysis.content, r.garment.category, r.garment.subcategory, r.garment.name) : r.base);
  async function addVariant(r: Resolved, file?: File, forPose = false) {
    const label = prompt(forPose ? "這個姿勢校正的名稱（之後擺出相近姿勢時會提示套用）" : "這個穿法的名稱", forPose ? (POSE_PRESETS.find((p) => samePose(rig, p.pose, pose))?.label ?? "姿勢") + "校正" : file ? "打開" : "收入裙內");
    if (!label?.trim()) return;
    const vid = "v" + Date.now().toString(36);
    let image: string | null = null;
    if (file) {
      setBusy(true);
      try {
        const prepared = await prepareAsset(file, 1800);
        const asset = await api<{ id: string }>("/api/doll/assets", { method: "POST", json: { kind: "garment_part", name: label.trim(), garment_id: r.garment.id } });
        const up = await api<{ ref: string }>(`/api/doll/assets/${asset.id}/files`, { method: "POST", body: prepared.blob, headers: { "content-type": "image/png" } });
        image = up.ref;
      } catch (e) {
        setBusy(false);
        return toast((e as Error).message, "err");
      }
    }
    await saveTemplate(r, (d) => ({ data: { ...d, variants: { ...d.variants, [vid]: { name: label.trim().slice(0, 20), image, fit: image ? null : r.fit, opts: r.opts, mask: image ? null : r.mask, parts: image ? null : r.parts, ...(forPose ? { pose: clampPose(rig, pose) } : {}) } } }, fit: baseRowFit(r) }), forPose ? `已保存「${label.trim()}」：之後擺出相近姿勢時可以選用` : `已新增穿法「${label.trim()}」`, { variant: vid });
  }
  async function deleteVariant(r: Resolved, vid: string) {
    const v = r.template?.data?.variants[vid];
    if (!v || !confirm(`刪除穿法「${v.name}」？`)) return;
    await saveTemplate(r, (d) => { const variants = { ...d.variants }; delete variants[vid]; return { data: { ...d, variants }, fit: r.template!.fit }; }, "已刪除穿法", { variant: r.worn.variant === vid ? null : r.worn.variant, fit: r.worn.fit, opts: r.worn.opts, mask: r.worn.mask, parts: r.worn.parts ?? null });
    if (v.image?.startsWith("file:")) void api(`/api/doll/files/${v.image.slice(5)}`, { method: "DELETE" }).catch(() => undefined);
  }

  // ───── 遮罩／部件塗抹 ─────
  // 塗抹的位置沿著「目前姿勢下實際變形後的網格」換算回圖片，所以任何姿勢下都是塗在眼睛看到的那塊布料上。
  const selItem = useMemo(() => (sel && sel.image ? sceneItem(sel) : null), [sel]);
  const editSource = editing === "mask" ? sel?.mask ?? null : editing === "parts" ? sel?.parts ?? null : null;
  const editId = editing && sel ? [editing, sel.garment.id, sel.image, sel.worn.variant ?? "", id ?? ""].join("|") : "";
  useEffect(() => {
    const prev = edit.current;
    if (prev && (prev.kind !== editing || prev.key !== sel?.garment.id || !editId)) { renderer.setLiveMask(prev.key, null); renderer.setLiveParts(prev.key, null); edit.current = null; }
    if (!editing || !sel || !selItem) return;
    const cur = edit.current;
    // 撤銷、恢復預設、切換穿法或造型後，畫面上的遮罩已經不同：重新載入，避免用舊的暫存蓋掉新的
    if (cur && cur.committed === editSource && cur.ready) return;
    const gid = sel.garment.id;
    renderer.setLiveMask(gid, null); renderer.setLiveParts(gid, null);
    if (editing === "parts") {
      // 部件圖由目前的分辨結果（自動或人工）開始修改
      const lab = renderer.geometry(selItem).labels, data = new Uint8ClampedArray(lab.w * lab.h * 4);
      for (let i = 0; i < lab.w * lab.h; i++) { data[i * 4] = lab.data[i] * 50; data[i * 4 + 3] = 255; }
      edit.current = { kind: "parts", key: gid, w: lab.w, h: lab.h, data, ready: true, committed: editSource, last: null, dirty: false, at: 0 };
      return;
    }
    const w = MASK_W, h = Math.max(8, Math.min(420, Math.round(MASK_W * sel.analysis.content.ar)));
    const buf: EditBuf = { kind: "mask", key: gid, w, h, data: new Uint8ClampedArray(w * h * 4), ready: !editSource, committed: editSource, last: null, dirty: false, at: 0 };
    for (let i = 3; i < buf.data.length; i += 4) buf.data[i] = 255;
    edit.current = buf;
    if (editSource) void loadImage(editSource).then((img) => {
      if (edit.current !== buf) return;
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, w, h);
      buf.data.set(ctx.getImageData(0, 0, w, h).data);
      for (let i = 3; i < buf.data.length; i += 4) buf.data[i] = 255;
      buf.ready = true;
    }).catch(() => { if (edit.current === buf) buf.ready = true; });
  }, [editId, editSource, editing, renderer, selItem]);
  useEffect(() => () => { const e = edit.current; if (e) { renderer.setLiveMask(e.key, null); renderer.setLiveParts(e.key, null); } }, [renderer]);
  const pushLive = (e: EditBuf) => {
    if (e.kind === "mask") renderer.setLiveMask(e.key, { w: e.w, h: e.h, data: e.data });
    else { const data = new Uint8Array(e.w * e.h); for (let i = 0; i < data.length; i++) data[i] = Math.round(e.data[i * 4] / 50); renderer.setLiveParts(e.key, { w: e.w, h: e.h, data }); }
  };
  function paint(r: Resolved, x: number, y: number, phase: "start" | "move" | "end") {
    const e = edit.current;
    if (!e || e.key !== r.garment.id || !e.ready || !selItem) return;
    if (phase === "end") {
      e.last = null;
      if (!e.dirty) return;
      e.dirty = false;
      pushLive(e);
      const c = document.createElement("canvas");
      c.width = e.w; c.height = e.h;
      c.getContext("2d")!.putImageData(new ImageData(e.data.slice(), e.w, e.h), 0, 0);
      const url = c.toDataURL("image/png");
      e.committed = url;
      flushHist();
      setItem(r.garment.id, e.kind === "mask" ? { mask: url } : { parts: url });
      return;
    }
    const size = e.kind === "mask" ? maskTool.size : partTool.size;
    const radius = Math.max(1.2, (size / r.fit.w) * e.w);
    // 兩點之間補上中間的位置，快速塗抹也是連續的一筆
    const from = phase === "move" && e.last ? e.last : [x, y], dist = Math.hypot(x - from[0], y - from[1]), steps = Math.max(1, Math.ceil(dist / Math.max(4, size * 0.4)));
    let changed = false;
    for (let n = phase === "move" && e.last ? 1 : 0; n <= steps; n++) {
      const uv = renderer.locate(selItem, mats, from[0] + ((x - from[0]) * n) / steps, from[1] + ((y - from[1]) * n) / steps);
      if (!uv) continue;
      const cx = uv[0] * e.w, cy = uv[1] * e.h;
      for (let py = Math.max(0, Math.floor(cy - radius)); py <= Math.min(e.h - 1, Math.ceil(cy + radius)); py++) {
        for (let px = Math.max(0, Math.floor(cx - radius)); px <= Math.min(e.w - 1, Math.ceil(cx + radius)); px++) {
          if (Math.hypot(px + 0.5 - cx, py + 0.5 - cy) > radius) continue;
          const i = (py * e.w + px) * 4;
          if (e.kind === "parts") e.data[i] = partTool.label * 50;
          else if (maskTool.mode === "hide") { e.data[i] = 255; e.data[i + 1] = 0; }
          else if (maskTool.mode === "behind") { e.data[i] = 0; e.data[i + 1] = 255; }
          else { e.data[i] = 0; e.data[i + 1] = 0; }
          changed = true;
        }
      }
    }
    e.last = [x, y];
    if (!changed) return;
    e.dirty = true;
    const now = Date.now();
    if (now - e.at < 60) return;
    e.at = now;
    pushLive(e);
  }
  function clearMask(r: Resolved) {
    // 明確清除（空白遮罩）：與「跟隨衣物預設」不同，衣物預設有遮罩時也會清走
    const c = document.createElement("canvas");
    c.width = 8; c.height = 8;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 8, 8);
    setItem(r.garment.id, { mask: c.toDataURL("image/png") });
  }
  async function exportPng() {
    setMenu(false);
    if (pending.size) return toast("衣物仍在載入，請稍後再試", "err");
    const c = document.createElement("canvas");
    c.width = DOLL_W; c.height = DOLL_H;
    const ctx = c.getContext("2d")!;
    const still = { ...scene, overlay: null };
    for (let i = 0; i < 60 && !renderer.paint(ctx, still, [1, 0, 0, 1, 0, 0]); i++) { await new Promise((r) => setTimeout(r, 120)); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height); }
    try {
      const blob = await canvasBlob(c, "image/png"), file = new File([blob], `${name.trim() || "造型"}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }).catch(() => undefined); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    } catch (e) { toast((e as Error).message, "err"); }
  }

  // ───── 角色素材（頭部／髮型） ─────
  async function newAsset(kind: "hair" | "head") {
    setBusy(true);
    try {
      const a = await api<{ id: string; name: string }>("/api/doll/assets", { method: "POST", json: { kind, name: kind === "hair" ? "新髮型" : "新頭部" } });
      setDraft({ id: a.id, isNew: true, kind, name: "", category: "", parts: [], sel: null }); setHairTool("place");
      setSelected(null);
      setViewKey("upper");
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  }
  function editAsset(a: DollAsset) {
    const parts: HairPart[] = a.kind === "hair" ? (a.config as { parts: HairPart[] }).parts : [{ id: "head", label: "頭部", layer: "front", bone: "head", ...(a.config as { file: string; x: number; y: number; w: number; h: number }) }];
    setDraft({ id: a.id, isNew: false, kind: a.kind as "hair" | "head", name: a.name, category: a.category ?? "", parts, sel: parts[0]?.id ?? null }); setHairTool("place");
    setSelected(null);
    setViewKey("upper");
  }
  async function addAssetFiles(files: File[]) {
    if (!draft) return;
    setBusy(true);
    let d = draft;
    try {
      for (const f of files) {
        const p = await prepareAsset(f);
        const up = await api<{ ref: string }>(`/api/doll/assets/${d.id}/files`, { method: "POST", body: p.blob, headers: { "content-type": "image/png" } });
        const ar = p.height / p.width;
        let part: HairPart;
        if (d.kind === "head") {
          const h = 272, w = h / ar;
          part = { id: "head", label: "頭部", layer: "front", bone: "head", file: up.ref, x: 601 - w / 2, y: 36, w, h };
          d = { ...d, parts: [part], sel: "head" };
        } else {
          // 同一組拆件通常畫在相同的畫布上：整張畫布按頭部比例縮放後置中，各部件的相對位置自動保持。
          // 第一張圖的頂部對齊頭頂稍上的位置；之後加入的部件沿用同一個畫布位置。
          const k = 450 / Math.max(p.sourceW, 1);
          if (!hairFrame.current || hairFrame.current.id !== d.id) hairFrame.current = { id: d.id, y0: 12 - p.box.y0 * p.sourceH * k };
          const w = (p.box.x1 - p.box.x0) * p.sourceW * k;
          const pid = "p" + Math.random().toString(36).slice(2, 8);
          part = { id: pid, label: f.name.replace(/\.[^.]+$/, "").slice(0, 12) || "髮束", layer: w * ar < 330 ? "front" : "back", bone: "head", file: up.ref, x: 601 - 225 + p.box.x0 * p.sourceW * k, y: hairFrame.current.y0 + p.box.y0 * p.sourceH * k, w, h: w * ar };
          d = { ...d, parts: [...d.parts, part], sel: pid };
        }
        setDraft(d);
      }
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  }
  async function saveAsset() {
    if (!draft || !draft.parts.length) return;
    setBusy(true);
    try {
      const round = (p: HairPart) => ({ ...p, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, w: Math.round(p.w * 10) / 10, h: Math.round(p.h * 10) / 10 });
      const parts = draft.parts.map(round);
      const config = draft.kind === "hair" ? { parts } : { file: parts[0].file, x: parts[0].x, y: parts[0].y, w: parts[0].w, h: parts[0].h };
      await api(`/api/doll/assets/${draft.id}`, { method: "PATCH", json: { name: draft.name.trim() || (draft.kind === "hair" ? "我的髮型" : "我的頭部"), category: draft.category.trim() || null, config } });
      // 縮圖：把各部件按位置合成
      try {
        const x0 = Math.min(...parts.map((p) => p.x)), y0 = Math.min(...parts.map((p) => p.y)), x1 = Math.max(...parts.map((p) => p.x + p.w)), y1 = Math.max(...parts.map((p) => p.y + p.h));
        const s = Math.min(150 / (x1 - x0), 190 / (y1 - y0));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round((x1 - x0) * s)); c.height = Math.max(1, Math.round((y1 - y0) * s));
        const ctx = c.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        for (const layer of ["back", "mid", "front"]) for (const p of parts) if (p.layer === layer) ctx.drawImage(await loadImage(p.file), (p.x - x0) * s, (p.y - y0) * s, p.w * s, p.h * s);
        await api(`/api/doll/assets/${draft.id}/thumb`, { method: "PUT", body: await canvasBlob(c, "image/png"), headers: { "content-type": "image/png" } });
      } catch { /* 縮圖失敗不影響素材 */ }
      await loadAssets();
      if(draft.kind==="hair"){if(draft.isNew&&parts.length===1){const next=addHairParts(hairOf(assets,look.hair,look.hair_config),parts);editLook({...look,hair_config:next});}else editLook({...look,hair:draft.id,hair_config:null});} else editLook({...look,head:draft.id});
      setDraft(null);
      toast(draft.kind === "hair" ? "已儲存髮型，並套用到角色" : "已儲存頭部，並套用到角色");
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  }
  async function cancelAsset() {
    if (!draft) return;
    if (draft.isNew) void api(`/api/doll/assets/${draft.id}`, { method: "DELETE" }).catch(() => undefined);
    setDraft(null);
  }
  async function deleteAsset() {
    if (!draft || !confirm("刪除這個素材？使用它的造型會改用預設頭部／髮型。")) return;
    setBusy(true);
    try {
      await api(`/api/doll/assets/${draft.id}`, { method: "DELETE" });
      if (look.hair === draft.id) setLook({ ...look, hair: BUILTIN_HAIR_ID,hair_config:null });
      else if(look.hair_config && draft.kind === "hair") setLook({...look,hair_config:{...look.hair_config,parts:look.hair_config.parts.filter(p=>!draft.parts.some(d=>d.file===p.file))}});
      if (look.head === draft.id) setLook({ ...look, head: BUILTIN_HEAD_ID });
      await loadAssets();
      setDraft(null);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  }

  async function saveHairCombo(){
    if(!hair?.parts.length||busy)return;
    const name=prompt("新髮型名稱", "我的混搭髮型")?.trim();if(!name)return;
    setBusy(true);let assetId:string|null=null;
    try{const asset=await api<{id:string}>("/api/doll/assets",{method:"POST",json:{kind:"hair",name}});assetId=asset.id;
      const copied=new Map<string,string>();
      const copy=async(ref:string)=>{if(!ref.startsWith("file:"))return ref; const old=copied.get(ref);if(old)return old;const res=await fetch(refUrl(ref),{credentials:"same-origin"});if(!res.ok)throw Error("髮件圖片未能讀取");const blob=await res.blob();const up=await api<{ref:string}>(`/api/doll/assets/${asset.id}/files`,{method:"POST",body:blob,headers:{"content-type":blob.type||"image/png"}});copied.set(ref,up.ref);return up.ref;};
      const parts:HairPart[]=[]; for(const p of hair.parts)parts.push({...p,file:await copy(p.file),mask:p.mask?await copy(p.mask):p.mask});
      await api(`/api/doll/assets/${asset.id}`,{method:"PATCH",json:{name,category:"混搭",config:{...hair,parts}}});
      await loadAssets();editLook({...look,hair:asset.id,hair_config:null});selectHair(null);toast("已保存新的髮型組合");
    }catch(e){if(assetId)await api(`/api/doll/assets/${assetId}`,{method:"DELETE"}).catch(()=>undefined);toast((e as Error).message,"err");}finally{setBusy(false);}
  }

  // ───── 保存造型 ─────
  async function save(asNew = false) {
    if (pending.size) return toast("衣物仍在載入，請稍後再保存", "err");
    if (draft) return toast("請先儲存或取消正在編輯的素材", "err");
    setBusy(true);
    const state: LookState = {
      v: 3, head: look.head, hair: look.hair, ...(look.hair_config?{hair_config:look.hair_config}:{}), hair_color: look.hair_color, accent_color: look.accent_color, tip_color: look.tip_color, pose: clampPose(rig, pose), front,
      items: resolved.map((r) => ({ garment_id: r.garment.id, slot: r.worn.slot, hidden: r.worn.hidden, variant: r.worn.variant, fit: r.fit, opts: r.opts, mask: r.mask, ...(r.parts ? { parts: r.parts } : {}) })),
    };
    const target = asNew ? undefined : id;
    try {
      const res = await api<{ id: string }>(target ? `/api/doll/looks/${target}` : "/api/doll/looks", { method: target ? "PATCH" : "POST", json: { name: (asNew ? name.trim() + " 副本" : name.trim()) || "新造型", is_favorite: favorite, state } });
      try {
        const blob = await renderer.thumbnail({ ...scene, overlay: null });
        if (blob) await api(`/api/doll/looks/${res.id}/thumb`, { method: "PUT", body: blob, headers: { "content-type": "image/jpeg" } });
      } catch { /* 縮圖失敗不影響造型 */ }
      toast("已保存造型");
      setDirty(false); setNotice("");
      if (res.id !== id) navigate(`/dressing/${res.id}`, true);
      else setWorn((cur) => cur.map((w) => (w.v1fit ? { ...w, fit: state.items.find((i) => i.garment_id === w.garment_id)?.fit ?? null, v1fit: null } : w)));
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }
  async function removeLook() {
    if (!id || !confirm("確定刪除這個造型？衣物及衣物預設不會被刪除。")) return;
    await api(`/api/doll/looks/${id}`, { method: "DELETE" });
    toast("已刪除");
    navigate("/outfits", true);
  }
  const leave = (to: string) => { if (!dirty || confirm("造型尚未保存，確定離開？")) navigate(to); };

  // ───── 舞台互動 ─────
  const hp=draftPart??activeHair;
  const stageSel: Selection | null = hp
    ? { fit: { cx: hp.x + hp.w / 2, cy: hp.y + hp.h / 2, w: hp.w, rotation: hp.rotation??0, mesh:hp.mesh }, content: FULL_CONTENT(hp.h / hp.w), bone: draft?.kind === "head" ? "head" : hairBoneId(hp), rotate: draft?.kind !== "head" }
    : sel && !draft ? { fit: sel.fit, content: sel.analysis.content, bone: mainBone({ slot: sel.worn.slot, opts: sel.opts }), bounds: selItem ? renderer.bounds(selItem, mats) : undefined } : null;
  const mode = focus ? "preview" : draft || activeHair ? (hairTool==="mesh" && draft?.kind!=="head" ? "mesh" : "dress") : sel ? (editing ? "mask" : tool === "mesh" ? "mesh" : "dress") : tab === "pose" ? "pose" : "dress";
  // 這個姿勢有對應的衣物校正（保存穿法時連同姿勢）：提示可以套用，不會自動更改
  const poseFix = useMemo(() => {
    for (const r of resolved) { const vs: Record<string, Variant> = r.template?.data?.variants ?? {}; for (const [vid, v] of Object.entries(vs)) if (v.pose && r.worn.variant !== vid && Object.keys(pose).length > 0 && poseDistance(pose, v.pose) < 13) return { gid: r.garment.id, vid, name: v.name, garment: r.garment.name }; }
    return null;
  }, [resolved, pose]);
  function onFit(fit: Fit) {
    if (hp) {
      const h=fitHeight(fit,hp.h/hp.w),x=fit.cx-fit.w/2,y=fit.cy-h/2;
      const patch:Partial<HairPart>={x,y,w:fit.w,h,rotation:fit.rotation,mesh:fit.mesh,...(hp.bone==="own"?{pivot:[x+(hp.pivot? (hp.pivot[0]-hp.x)/hp.w:.5)*fit.w,y+(hp.pivot?(hp.pivot[1]-hp.y)/hp.h:0)*h] as [number,number]}:{})};
      if(draft&&draftPart)setDraft({...draft,parts:draft.parts.map(p=>p.id===draftPart.id?{...p,...patch}:p)});else if(activeHair)patchHair(activeHair.id,patch);
    } else if (sel) applyFit(sel, fit);
  }
  function onPick(x: number, y: number) {
    if (draft) {
      const hit = [...draft.parts].reverse().find((p) => { const [rx, ry] = applyMat(invert(mats[draft.kind === "head" ? "head" : hairBoneId(p)] ?? mats.root), x, y); return rx >= p.x && rx <= p.x + p.w && ry >= p.y && ry <= p.y + p.h; });
      setDraft({ ...draft, sel: hit?.id ?? null });
      return;
    }
    if(tab==="look"&&lookTab==="hair"&&hair){const hit=[...hair.parts].reverse().find(p=>{if(p.hidden)return false;const [rx,ry]=applyMat(invert(mats[hairBoneId(p)]??mats.root),x,y);return rx>=p.x&&rx<=p.x+p.w&&ry>=p.y&&ry<=p.y+p.h;});selectHair(hit?.id??null);return;}
    // 沿實際變形後的衣物判斷：點到真正有布料的位置才算（透明或已用遮罩隱藏的位置不會擋住下面的衣物）
    const hit = renderer.pick(scene, mats, x, y);
    setSelected(hit);
    if (hit) setTool((t) => (t === "mask" || t === "parts" ? "place" : t));
  }
  function switchTab(t: Tab) {
    setSelected(null); setFocus(false); setHairSelected(null); setHairTool("place");
    if (t === "look" && viewKey === "full") { setViewKey("upper"); autoView.current = true; }
    else if (t !== "look" && autoView.current) { setViewKey("full"); autoView.current = false; }
    setTab(t);
  }
  const handles = useMemo<PoseHandle[]>(() => poseHandles(hair), [hair]);
  const hints = useMemo(() => layeringHints(worn.filter((w) => !w.hidden).map((w) => w.slot)), [worn]);
  const wornIds = useMemo(() => new Set(worn.map((w) => w.garment_id)), [worn]);

  if (!loaded || !tpls) return <div className="fixed inset-0 z-40 grid place-items-center bg-plum"><Spinner /></div>;
  const showPanel = !focus;
  return (
    <div className="doll-room fixed inset-0 z-40 flex flex-col bg-plum" data-testid="dressing-room" data-dirty={dirty ? "1" : "0"} data-worn={worn.map((w) => w.garment_id + (w.hidden ? ":hidden" : "")).join(",")} data-resolved={resolved.length} data-pose={JSON.stringify(pose)} data-front={front.join(",")} data-hair={look.hair} data-head={look.head} data-hair-color={look.hair_color} data-selected={selected ?? ""} data-masked={worn.filter((w) => w.mask).length} data-parts={worn.filter((w) => w.parts).length} data-undo={hist.current.past.length}>
      {/* ───── 頂部 ───── */}
      <div className="safe-top shrink-0 bg-ink">
        <div className="flex h-12 items-center gap-1.5 px-2.5">
          <button type="button" aria-label="返回我的穿搭" onClick={() => leave("/outfits")} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconChevronLeft /></button>
          <input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder="未命名造型" aria-label="造型名稱" data-testid="look-name" className="h-9 min-w-0 flex-1 rounded-full border border-transparent bg-transparent px-2 font-serif text-[16px] font-bold tracking-[0.06em] text-gold-soft placeholder:text-mauve/70 focus:border-gold/50 focus:outline-none" />
          {dirty && <span className="shrink-0 text-[10.5px] text-wine">未保存</span>}
          <button type="button" aria-label={favorite ? "取消收藏" : "收藏"} aria-pressed={favorite} onClick={() => { setFavorite(!favorite); setDirty(true); }} className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[18px] ${favorite ? "text-[#f2a7c3]" : "text-mauve"}`}><IconHeart filled={favorite} /></button>
          <button type="button" data-testid="save-look" disabled={busy} onClick={() => void save()} className="btn-jewel flex h-9 shrink-0 items-center gap-1 rounded-full px-3.5 text-[13px] disabled:opacity-50"><IconSave className="text-[14px]" />{busy ? "…" : "保存"}</button>
          <button type="button" aria-label="更多" aria-expanded={menu} onClick={() => setMenu(!menu)} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconMore /></button>
        </div>
        {menu && (
          <div className="absolute right-2.5 z-50 mt-1 w-44 overflow-hidden rounded-2xl border border-gold/50 bg-velvet text-[13px] shadow-xl" role="menu">
            <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left" onClick={() => { setMenu(false); leave("/dressing"); }}>新造型</button>
            {id && <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left" onClick={() => { setMenu(false); void save(true); }}>另存為新造型</button>}
            <button type="button" role="menuitem" data-testid="export-png" className="block w-full px-4 py-2.5 text-left" onClick={() => void exportPng()}>匯出透明 PNG</button>
            {id && <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left text-wine" onClick={() => { setMenu(false); void removeLook(); }}>刪除造型</button>}
          </div>
        )}
      </div>

      {/* ───── 舞台 ───── */}
      <div className="doll-stage relative min-h-0 flex-1" onClick={() => menu && setMenu(false)}>
        <Stage renderer={renderer} scene={focus ? {...scene,overlay:null} : scene} rig={rig} view={VIEWS[viewKey]} mode={mode} selection={stageSel} onPick={onPick} onFit={onFit}
          showHandles={showHandles && mode === "pose"} activeHandle={activeHandle} onPose={(p, h) => { setActiveHandle(h.id); if (p !== pose) setPose(p); }}
          onPaint={(x, y, phase) => sel && paint(sel, x, y, phase)} brush={editing === "mask" ? maskTool.size : editing === "parts" ? partTool.size : undefined} onReadyChange={setReady}>
          <div data-stage-ui className="absolute left-2 top-2 flex flex-col gap-1">
            {Object.entries(VIEWS).map(([k, v]) => <button key={k} type="button" data-view={k} aria-pressed={viewKey === k} onClick={() => { setViewKey(k); autoView.current = false; }} className={`rounded-full px-2.5 py-1 text-[11px] backdrop-blur ${viewKey === k ? "chip-on" : "bg-ink/45 text-cream ring-1 ring-gold/40"}`}>{v.label}</button>)}
          </div>
          <button data-stage-ui type="button" aria-label={focus ? "顯示操作面板" : "專注預覽"} data-testid="focus" aria-pressed={focus} onClick={() => setFocus(!focus)} className={`absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full text-[15px] backdrop-blur ${focus ? "chip-on" : "bg-ink/45 text-cream ring-1 ring-gold/40"}`}><IconExpand /></button>
          {(!ready || pending.size > 0) && <span data-stage-ui className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-ink/60 px-3 py-1 text-[11px] text-cream">載入中…</span>}
          {renderer.errors.size > 0 && <button data-stage-ui type="button" onClick={() => { renderer.retry(); setAnalyses((m) => new Map(m)); }} className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-[#a12c4b] px-3 py-1 text-[11px] text-white">有圖片未能讀取，按此重試</button>}
          {notice && <p data-stage-ui role="status" className="absolute inset-x-12 top-2 rounded-2xl bg-ink/80 px-3 py-2 text-center text-[11px] leading-snug text-gold-soft">{notice}</p>}
          <div data-stage-ui className="absolute bottom-2 left-2 flex gap-1.5">
            <button type="button" aria-label="撤銷" data-testid="undo" disabled={!canUndo} onClick={() => timeTravel("undo")} className="grid h-8 w-8 place-items-center rounded-full bg-ink/45 text-[15px] text-cream ring-1 ring-gold/40 backdrop-blur disabled:opacity-35">↶</button>
            <button type="button" aria-label="重做" data-testid="redo" disabled={!canRedo} onClick={() => timeTravel("redo")} className="grid h-8 w-8 place-items-center rounded-full bg-ink/45 text-[15px] text-cream ring-1 ring-gold/40 backdrop-blur disabled:opacity-35">↷</button>
          </div>
          {poseFix && !editing && <button data-stage-ui type="button" data-testid="pose-fix" onClick={() => setItem(poseFix.gid, { variant: poseFix.vid, fit: null, v1fit: null, opts: null, mask: null, parts: null })} className="absolute bottom-2 right-2 max-w-[62%] truncate rounded-full bg-ink/70 px-3 py-1.5 text-[11px] text-gold-soft ring-1 ring-gold/50">套用「{poseFix.name}」（{poseFix.garment}）</button>}
          {focus && <button data-stage-ui type="button" onClick={() => setFocus(false)} className="btn-dark absolute left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full px-4 py-2 text-[12.5px]" style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)" }}><IconChevronUp />顯示面板</button>}
        </Stage>
      </div>

      {/* ───── 底部面板 ───── */}
      {showPanel && (
        <div className="doll-panel shrink-0 border-t border-gold/40 bg-velvet" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
          {!draft && (
            <div className="grid grid-cols-4 gap-1.5 px-2.5 pt-2" role="tablist">
              {TABS.map((t) => {
                const on = tab === t.id && !sel;
                return (
                  <button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={on} onClick={() => switchTab(t.id)} className={`flex h-12 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11.5px] ${on ? "chip-on" : "bg-white/5 text-cream/85"}`}>
                    <span className="relative text-[18px]"><t.Icon />{t.id === "layers" && worn.length > 0 && <span className="absolute -right-3 -top-1 rounded-full bg-gold px-1 text-[9px] font-bold leading-[14px] text-ink">{worn.length}</span>}</span>
                    {t.label}
                  </button>
                );
              })}
            </div>
          )}
          <div className="relative px-3 pt-2.5" style={{ height: panel === "max" ? "52dvh" : draft || sel ? "min(34dvh, 280px)" : "min(30dvh, 250px)" }} data-testid="doll-panel">
            <button type="button" aria-label={panel === "max" ? "縮小面板" : "放大面板"} data-testid="panel-size" onClick={() => setPanel(panel === "max" ? "mid" : "max")} className="absolute -top-3 left-1/2 z-10 grid h-5 w-12 -translate-x-1/2 place-items-center rounded-full border border-gold/50 bg-velvet text-[12px] text-gold-soft">{panel === "max" ? "︾" : "︽"}</button>
            {draft ? <AssetPanel draft={draft} setDraft={setDraft} busy={busy} onFiles={(f) => void addAssetFiles(f)} onSave={() => void saveAsset()} onCancel={() => void cancelAsset()} onDelete={() => void deleteAsset()} hairTool={hairTool} setHairTool={setHairTool} />
              : sel ? (
                <FitPanel r={sel} info={selItem ? renderer.info(selItem) : null} tool={tool} setTool={setTool} busy={busy} onFit={(f) => nudge(sel, f)} onMeshReset={() => applyFit(sel, {...sel.fit, mesh:undefined})} onOpts={(o) => setOpts(sel, o)}
                  part={partTool} setPart={setPartTool} hint={hint} setHint={setHint} onParts={(v) => setItem(sel.garment.id, { parts: v })}
                  onSleeveAuto={() => { if (!selItem) return; const [a, b] = suggestSleeveRot(renderer.geometry({ ...selItem, opts: { ...selItem.opts, sleeve_r: 0, sleeve_l: 0 } }), sel.fit, sel.analysis.content.ar); setOpts(sel, { sleeve_r: Math.max(-SLEEVE_ROT_LIMIT, Math.min(SLEEVE_ROT_LIMIT, a)), sleeve_l: Math.max(-SLEEVE_ROT_LIMIT, Math.min(SLEEVE_ROT_LIMIT, b)) }); }}
                  onPoseFix={() => void addVariant(sel, undefined, true)}
                  onAuto={() => applyFit(sel, defaultFit(sel.worn.slot, sel.analysis.content, sel.garment.category, sel.garment.subcategory, sel.garment.name))}
                  onRestore={() => setItem(sel.garment.id, { fit: null, v1fit: null, opts: null, mask: null, parts: null })} onSaveDefault={() => void saveDefault(sel)} onRemove={() => remove(sel.garment.id)} onDone={() => setSelected(null)}
                  onOrder={(to) => order(sel.garment.id, to)} onVariant={(v) => setItem(sel.garment.id, { variant: v, fit: null, v1fit: null, opts: null, mask: null, parts: null })}
                  onAddVariant={(img) => (img ? variantFile.current?.click() : void addVariant(sel))} onDeleteVariant={(v) => void deleteVariant(sel, v)}
                  onSavePose={() => void saveTemplate(sel, (d) => ({ data: { ...d, pose: clampPose(rig, pose), front }, fit: baseRowFit(sel) }), "已把目前姿勢設為這件衣物的建議姿勢", { fit: sel.worn.fit, opts: sel.worn.opts, mask: sel.worn.mask, parts: sel.worn.parts ?? null })}
                  onApplyPose={() => { const d = sel.template?.data; if (d?.pose) setPose(d.pose, d.front); }}
                  mask={maskTool} setMask={setMaskTool} onClearMask={() => clearMask(sel)} />
              ) : tab === "clothes" ? <ClothesPanel garments={garments} wornIds={wornIds} pending={pending} onToggle={toggle} />
              : tab === "layers" ? <LayersPanel items={resolved} selected={selected} onSelect={(g) => { setSelected(g); setTool("place"); }} onReorder={(ids) => change((cur) => ids.map((i) => cur.find((w) => w.garment_id === i)!).filter(Boolean))} onHide={(g) => setItem(g, { hidden: !worn.find((w) => w.garment_id === g)?.hidden })} onRemove={remove} onClear={() => { if (confirm("脫下全部衣物？")) { change(() => []); setSelected(null); } }} hints={hints} />
              : tab === "look" ? <AppearancePanel tab={lookTab} setTab={t=>{setLookTab(t);selectHair(null);}} value={look} onChange={editLook} assets={assets} onNew={(k) => void newAsset(k)} onEdit={editAsset} hair={hair} selectedHair={hairSelected} onSelectHair={selectHair} hairTool={hairTool} setHairTool={setHairTool} onHairPatch={patchHair} onSaveHair={()=>void saveHairCombo()} busy={busy} />
              : <PosePanel rig={rig} pose={pose} front={front} onPose={setPose} onFront={(f) => { setFront(f); setDirty(true); }} show={showHandles} setShow={setShowHandles} active={activeHandle} setActive={setActiveHandle} handles={handles} />}
          </div>
          <input ref={variantFile} type="file" accept="image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f && sel) void addVariant(sel, f); }} />
        </div>
      )}
    </div>
  );
}
