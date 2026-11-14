// 角色換裝工作室（Phase 3）：角色始終可見，底部短面板切換「衣服／圖層／外貌／姿勢」。
// 穿著衣服時可直接在畫布上調整骨架；衣物自由疊穿；頭部及髮型可在這裡上傳及校正。
import { PointerEvent as ReactPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { AvatarModel, DEFAULT_BODY_MODEL, adjustHair, adjustHead, headFitFor, isBuiltinModel, unadjustRect } from "../../shared/avatarModel";
import { RIG_V2 } from "../../shared/avatarV2";
import { ModelSummary, listModels, loadModel, modelLabel, modelRef } from "../doll/models";
import { PoseLibrary } from "../doll/PoseLibrary";
import { Pose, applyMat, boneMap, clampPose, invert, matAngle, samePose, solve } from "../../shared/avatarRig";
import { Camera, FULL_CAMERA, Rect, Size, VIEW_PRESETS, ZOOM, boundsOf, frame, zoomAt, zoomTo } from "../../shared/camera";
import { DragMode, Region, controlsFor, poseControls, regionBones } from "../../shared/poseControls";
import { HAIR_VIS_MAX, BUILTIN_HAIR_ID, BUILTIN_HEAD_ID, DollAsset, FrontPart, HairCat, HairConfig, HairPart, HAIR_CAT_BONE, HAIR_CAT_LABEL, HAIR_CAT_LAYER, hairCatOf, placeHairPart, refUrl, POSE_PRESETS, hairBoneId, hexToRgb, resolveHairColors, rigFor } from "../../shared/avatarV2";
import { DOLL_H, DOLL_W, FULL_CONTENT, Fit, Piece, SETUP_KEYS, SETUP_LABEL, SetupKey, SetupMark, SetupStatus, Slot, SLOT_SKIN, itemKey, fitHeight, LookState, SLEEVE_ROT_LIMIT, SY_LIMIT, insertIndex, layeringHints, normalizeFit, normalizeTemplateData, sameFit, defaultFit, Variant, WearOpts } from "../../shared/doll";
import { poseDistance, suggestSleeveRot } from "../../shared/garmentMesh";
import { api, ApiError, displayName, Garment } from "../api";
import { IconChevronLeft, IconChevronRight, IconEye, IconEyeOff, IconHand, IconHeart, IconLayers, IconMore, IconPerson, IconPose, IconSave, IconShirt, IconSparkle, IconTarget } from "../components/icons";
import { Spinner, toast } from "../components/ui";
import { AssetPanel, Draft } from "../doll/AssetPanel";
import { Analysis, analyze, canvasBlob, loadImage, prepareAsset } from "../doll/content";
import { BehindStats, DollRenderer, Scene, flatLocate, flatRect, mainBone } from "../doll/engine";
import { pieceImage, pieceKey } from "../doll/pieces";
import { SplitEditor } from "../doll/SplitEditor";
import { Appearance, DEFAULT_APPEARANCE, GarmentLite, Resolved, Template, Templates, Worn, fetchStudioGarments, fetchLook, fetchTemplates, templateFor, addHairParts, pieceOf, wearHairPart, hairOf, headOf, imageOf, resolve, sceneItem, userAsset, wornFor } from "../doll/model";
import { AppearancePanel, COMPARE_LABEL, CompareKind, ClothesPanel, PieceEntry, FitDelta, FitPanel, FitTool, GarmentView, WearMode, wearMode, LayersPanel, LookTab, MaskTool, PartTool, PosePanel, PoseTab, SkeletonMode } from "../doll/panels";
import { PaintPhase, Selection, Stage, StageMode } from "../doll/Stage";
import { navigate } from "../router";
import { ITEM_LABEL, pieceSetup, setupInfo } from "../doll/setup";

import { readDraft, writeDraft, clearDraft } from "../doll/drafts";

type Tab = "clothes" | "layers" | "look" | "pose";
const TABS: { id: Tab; label: string; Icon: typeof IconShirt }[] = [
  { id: "clothes", label: "衣服", Icon: IconShirt },
  { id: "layers", label: "圖層", Icon: IconLayers },
  { id: "look", label: "外貌", Icon: IconPerson },
  { id: "pose", label: "姿勢", Icon: IconPose },
];
/** 遮罩寬度（像素）。Phase 3.8 由 256 提高至 512：高倍率放大時蕾絲邊緣不再出現明顯方格；舊遮罩照常按比例讀入。 */
const MASK_W = 512;
/** 主要衣物：決定人物姿勢的衣物（配件、半裙、頭飾等不會改變姿勢） */
const MAIN_SLOTS = new Set<Slot>(["top", "dress", "set", "outer"]);
/** 正在編輯的遮罩／部件圖（像素緩衝）。塗抹時直接預覽，放手才寫入造型（每一筆＝一步，可以撤銷） */
interface EditBuf { kind: "mask" | "parts"; key: string; w: number; h: number; data: Uint8ClampedArray; ready: boolean; committed: string | null; last: [number, number] | null; dirty: boolean; at: number; /** 這一筆開始前的內容（第二根手指落下時用來作廢這一筆） */ backup: Uint8ClampedArray | null }
type PanelSize = "mini" | "mid" | "max";
interface Recovery { model?: { id: string; rev: number }; snap: Snap; name: string; favorite: boolean; selected: string | null; hairSelected: string | null; draft: Draft | null; versions: [string, number][]; images: [string, string | null | undefined][] }
interface Snap { worn: Worn[]; pose: Pose; front: FrontPart[]; look: Appearance }

/** 按檔名及形狀估計髮件分類（使用者之後可以更改） */
function guessHairCat(name: string, ar: number, small?: boolean): HairCat {
  const n = name.toLowerCase();
  if (/瀏海|劉海|bang|fringe|front/.test(n)) return "bangs";
  if (/馬尾|tail/.test(n)) return /左|_l\b|left/.test(n) ? "tail_l" : "tail_r";
  if (/側|side/.test(n)) return /左|_l\b|left/.test(n) ? "side_l" : "side_r";
  if (/後|back/.test(n)) return "back";
  if (/髮尾|tip/.test(n)) return "tip";
  return small ?? ar < 1.15 ? "bangs" : "back";
}

/** 衣服設定工作室：只校正一件衣物（或一個套裝部件）的預設，不建立穿搭造型 */
export interface SetupTarget { gid: string; piece?: string | null; model?: string | null }
export default function DressingRoom({ id, setup }: { id?: string; setup?: SetupTarget }) {
  const setupKey = setup ? setup.gid + "|" + (setup.piece ?? "") + "|" + (setup.model ?? "") : "";
  // One model revision for the complete room: renderer, controls, templates and saved look all use it.
  const [bodyModel, setBodyModel] = useState<AvatarModel>(DEFAULT_BODY_MODEL);
  const [models, setModels] = useState<ModelSummary[]>([]);
  /** 切換身體時記下各身體上的個別調整：切換回來時恢復，不會把另一個身體的位置當作已校正 */
  const perModel = useRef(new Map<string, Worn[]>());
  const renderer = useMemo(() => new DollRenderer(bodyModel), [bodyModel]);
  const [garments, setGarments] = useState<Garment[] | null>(null);
  /** 套裝部件的圖片（由原圖製作，只在記憶體） */
  const [pieceRefs, setPieceRefs] = useState<Map<string, string>>(new Map());
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
  const [panel, setPanel] = useState<PanelSize>("mid");
  /** 正在拖動面板把手時的高度（像素）；放手後貼到最近的一級 */
  const [panelDrag, setPanelDrag] = useState<number | null>(null);
  /** 乾淨預覽：隱藏骨架、選取框、遮罩及部件顏色、操作面板；退出後原有的編輯狀態全部保留 */
  const [preview, setPreview] = useState(false);
  // ───── 鏡頭（與造型分開：不會令造型變成未保存，也不會進入撤銷紀錄） ─────
  const [stageSize, setStageSize] = useState<Size>({ w: 0, h: 0 });
  /** 快速取景預設；手動縮放或平移後變成 null（自由視角，用 cam） */
  const [viewKey, setViewKey] = useState<string | null>("full");
  const [cam, setCam] = useState<Camera>(FULL_CAMERA);
  /** 衣物原圖視圖有自己的鏡頭，切換回穿著預覽時原本的視角不變 */
  const [srcCam, setSrcCam] = useState<Camera | null>(null);
  const [hand, setHand] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [gview, setGview] = useState<GarmentView>("worn");
  const [compare, setCompare] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<FitTool>("place");
  const [maskTool, setMaskTool] = useState<MaskTool>({ mode: "hide", size: 16 });
  /** label −1＝沒有在標記部件（畫布上仍可拖動衣物） */
  const [partTool, setPartTool] = useState<PartTool>({ label: -1, size: 20 });
  const [hint, setHint] = useState(true);
  const [, setHistN] = useState(0);
  const [skel, setSkel] = useState<SkeletonMode>("region");
  const [dragMode, setDragMode] = useState<DragMode>("ik");
  const [region, setRegion] = useState<Region>("arm_l");
  const [joint, setJoint] = useState<string | null>(null);
  const [controlId, setControlId] = useState<string | null>(null);
  const [skelOpacity, setSkelOpacity] = useState(0.8);
  const [poseTab, setPoseTab] = useState<PoseTab>("presets");
  const [lookTab, setLookTab] = useState<LookTab>("hair");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hairSelected,setHairSelected]=useState<string|null>(null);
  const [hairTool,setHairTool]=useState<"place"|"mesh"|"mask">("place");
  /** 髮件可見性遮罩筆刷：hide＝隱藏、show＝擦走遮罩（恢復顯示） */
  const [hairBrush, setHairBrush] = useState<{ mode: "hide" | "show"; size: number }>({ mode: "hide", size: 14 });
  const hairEdit = useRef<{ id: string; src: string | null; w: number; h: number; data: Uint8ClampedArray; ready: boolean; last: [number, number] | null; dirty: boolean; backup: Uint8ClampedArray | null; at: number } | null>(null);
  const [menu, setMenu] = useState(false);
  /** 新穿上的主要衣物有不同的預設姿勢：提示是否套用（不會自動更改） */
  const [posePrompt, setPosePrompt] = useState<{ label: string; pose: Pose; front: FrontPart[] } | null>(null);
  const [ready, setReady] = useState(false);

  const recoveryKey = "room:" + (setup ? "setup:" + setupKey : id ?? "new");
  const [recoveryReady, setRecoveryReady] = useState(false);
  const touchedRig = useRef(new Set<string>());
  const recoveryVersions = useRef<Map<string, number> | null>(null);
  const recoveryLatest = useRef<Recovery | null>(null);
  const recoveryWrite = useRef<Promise<unknown>>(Promise.resolve());
  const queueDraft = (key: string, value: Recovery) => {
    recoveryWrite.current = recoveryWrite.current.catch(() => undefined).then(() => writeDraft(key, value)).catch(() => { toast("本機草稿未能保存，請手動保存編輯", "err"); });
  };
  const discardRecovery = async () => { recoveryLatest.current = null; await recoveryWrite.current; await clearDraft(recoveryKey).catch(() => undefined); };

  const requested = useRef(new Set<string>());
  const generation = useRef(0);
  const autoView = useRef(false);
  const edit = useRef<EditBuf | null>(null);
  /** cancel：拖動被取消，等待還原到這個狀態（期間延遲處理的拖動畫面不會記入撤銷紀錄） */
  const hist = useRef<{ past: Snap[]; future: Snap[]; base: Snap | null; prev: Snap | null; timer: number; start: number; skip: boolean; cancel: { to: Snap; until: number } | null }>({ past: [], future: [], base: null, prev: null, timer: 0, start: 0, skip: false, cancel: null });
  const variantFile = useRef<HTMLInputElement>(null);
  const hairFrame = useRef<{ id: string; y0: number } | null>(null);
  const editBase = useRef<{ snap: Snap; dirty: boolean; draft: Draft | null; past: number } | null>(null);
  const panelGrab = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const panelBox = useRef<HTMLDivElement>(null);

  // ───── 載入 ─────
  useEffect(() => {
    fetchStudioGarments().then((r) => setGarments(r)).catch((e) => toast((e as Error).message, "err"));
  }, []);
  const loadAssets = () => api<{ assets: Parameters<typeof userAsset>[0][] }>("/api/doll/assets").then((r) => setAssets(r.assets.map(userAsset).filter((a): a is DollAsset => !!a)));
  useEffect(() => {
    const ticket = ++generation.current;
    setRecoveryReady(false); recoveryVersions.current = null; recoveryLatest.current = null;
    setLoaded(false); setSelected(null); setDraft(null); setHairSelected(null); setHairTool("place"); setDirty(false); setNotice(""); setMenu(false);
    void (async () => {
      const [l, ml] = await Promise.all([id ? fetchLook(id) : null, listModels().catch(() => ({ models: [], default_model: "avatar_v2" })), loadAssets().catch(() => undefined)]);
      if (generation.current !== ticket) return;
      setModels(ml.models);
      // 造型：保存時的身體及版本（舊造型＝Avatar V2）；衣服設定：網址指定；新造型：預設身體
      const ref = l?.look.state?.model ?? null;
      let m = DEFAULT_BODY_MODEL;
      try { m = await loadModel(ref ? ref.id : setup ? setup.model : ml.default_model, ref ? ref.rev : null); }
      catch { toast(ref ? "未能讀取造型使用的身體，暫時以 Avatar V2 顯示；保存前請檢查" : "未能讀取身體模型，改用 Avatar V2", "err"); }
      const t = await fetchTemplates(m.id);
      if (generation.current !== ticket) return;
      perModel.current.clear();
      setBodyModel(m);
      setTpls(t);
      const latest = ref ? ml.models.find((x) => x.id === ref.id) : null;
      if (ref && latest && latest.revision > ref.rev) setNotice(`這個造型使用「${modelLabel(m)}」第 ${ref.rev} 版（最新第 ${latest.revision} 版），已按保存時的樣子顯示。可在「外貌 › 身體」更新到最新版本。`);
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
      if (id) navigate("/dressing", true); else { setBodyModel(DEFAULT_BODY_MODEL); setTpls({ v2: new Map(), v1: new Map() }); setLoaded(true); }
    });
    return () => { generation.current++; };
  }, [id, setupKey]);

  // 角色素材頁點選頭部／髮型素材：/dressing?asset=<id> 直接進入該素材的編輯（只執行一次）
  const assetLink = useRef(new URLSearchParams(location.search).get("asset"));
  useEffect(() => {
    const aid = assetLink.current;
    if (!aid || !loaded || id || setup) return;
    const a = assets.find((x) => x.id === aid);
    if (!a) return;
    assetLink.current = null;
    try { history.replaceState(null, "", "/dressing"); } catch { /* ignore */ }
    setTab("look"); setLookTab(a.kind === "head" ? "head" : "hair");
    editAsset(a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, assets]);

  // ───── 衣服設定模式：載入目標衣物及其預設（含預設姿勢）；只在切換目標時執行一次 ─────
  const setupInit = useRef("");
  useEffect(() => {
    if (!setup || !loaded || !tpls || !garments || setupInit.current === setupKey) return;
    setupInit.current = setupKey;
    const g = garments.find((x) => x.id === setup.gid);
    if (!g) { toast("找不到這件衣物（可能未有透明圖或已封存）", "err"); navigate("/dressing/setup" + (setup.model && !isBuiltinModel(setup.model) ? `?model=${setup.model}` : ""), true); return; }
    const t = templateFor(tpls, g), pc = setup.piece ? t?.data?.pieces?.find((p) => p.id === setup.piece) ?? null : null;
    if (setup.piece && !pc) toast("找不到這個部件，改為設定整件衣物", "err");
    const w: Worn = pc ? { garment_id: g.id, piece: pc.id, slot: pc.slot, hidden: false, variant: null, fit: null, opts: null, mask: null } : wornFor(g, tpls);
    const p = pc ? pc.pose ?? t?.data?.pose ?? null : t?.data?.pose ?? null;
    hist.current.base = null;
    setWorn([w]); setPoseState(p ?? {}); setFront(pc ? [] : t?.data?.front ?? []);
    setSelected(itemKey(w)); setTool("place"); setTab("clothes"); setDirty(false); setPosePrompt(null);
  }, [setupKey, loaded, tpls, garments]);

  useEffect(() => {
    if (!loaded || !garments || !tpls) return;
    let off = false;
    void readDraft<Recovery>(recoveryKey).then(async (saved) => {
      if (off) return;
      if (saved && confirm("發現未保存的編輯，是否繼續？取消會捨棄這份本機草稿。")) {
        if (saved.model && saved.model.id !== bodyModel.id) {
          try { const m = await loadModel(saved.model.id, saved.model.rev); const t = await fetchTemplates(m.id); if (off) return; setBodyModel(m); setTpls(t); }
          catch { toast("草稿使用的身體未能讀取，以目前身體顯示", "err"); }
        }
        recoveryVersions.current = new Map(saved.versions);
        setWorn(saved.snap.worn); setPoseState(saved.snap.pose); setFront(saved.snap.front); setLook(saved.snap.look);
        setName(saved.name); setFavorite(saved.favorite); setSelected(saved.selected); setHairSelected(saved.hairSelected); setDraft(saved.draft); setDirty(true);
        const changed = saved.images.some(([gid, img]) => garments.find(g => g.id === gid)?.transparent_image_id !== img);
        setNotice(changed ? "草稿引用的衣物圖片已更新，請檢查畫面；保存預設前需重新載入最新資料。" : "已恢復本機草稿，正式造型尚未被修改。");
      } else if (saved) await clearDraft(recoveryKey);
      if (!off) setRecoveryReady(true);
    }).catch(() => { if (!off) { setRecoveryReady(true); toast("無法讀取本機草稿，請定期手動保存", "err"); } });
    return () => { off = true; };
    // Once per editor identity, after setup initialization; later template saves must not prompt again.
  }, [loaded, !!garments, recoveryKey]);

  useEffect(() => {
    const flush = () => { if (recoveryLatest.current) queueDraft(recoveryKey, recoveryLatest.current); };
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", hidden);
    return () => { flush(); window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); };
  }, [recoveryKey]);

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
      const valid = tpl && tpl.image_id === (g.transparent_image_id ?? null) ? tpl : null;
      if (w.piece) {
        // 套裝部件：由原圖製作部件圖片（原圖本身也要量度，用來換算部件在套裝上的位置）
        const piece = pieceOf(w, valid), full = w.snapshot && w.image ? w.image : g.transparent_image_id ? "img:" + g.transparent_image_id : null, key = itemKey(w);
        if (!piece || !full) continue;
        if (!requested.current.has(full)) { requested.current.add(full); void analyze(full).then((a) => setAnalyses((m) => new Map(m).set(full, a))); }
        const pk = pieceKey(full, piece, w.snapshot && w.piece_peers ? w.piece_peers : valid?.data?.pieces ?? [piece]);
        if (requested.current.has(pk)) continue;
        requested.current.add(pk);
        void pieceImage(full, piece, w.snapshot && w.piece_peers ? w.piece_peers : valid?.data?.pieces ?? [piece]).then(async (ref) => {
          const a = await analyze(ref);
          setAnalyses((m) => new Map(m).set(ref, a));
          setPieceRefs((m) => new Map(m).set(key, ref));
        }).catch((e) => { requested.current.delete(pk); toast((e as Error).message, "err"); });
        continue;
      }
      const ref = imageOf(w, g, valid);
      if (!ref || requested.current.has(ref)) continue;
      requested.current.add(ref);
      void analyze(ref).then((a) => {
        if (a.content.approximate) { requested.current.delete(ref); toast("高清圖未能讀取；暫用縮圖位置，請稍後重試"); }
        setAnalyses((m) => new Map(m).set(ref, a));
      });
    }
  }, [worn, tpls, gmap]);

  const body = useMemo(() => ({ rig: bodyModel.rig, base: RIG_V2 }), [bodyModel]);
  const resolved = useMemo(() => (tpls ? worn.map((w) => { const g = gmap.get(w.garment_id); return g ? resolve(w, g, tpls, analyses, pieceRefs, body) : null; }).filter((r): r is Resolved => !!r) : []), [worn, tpls, gmap, analyses, pieceRefs, body]);
  const pending = useMemo(() => { const ok = new Set(resolved.map((r) => r.key)); return new Set(worn.filter((w) => !ok.has(itemKey(w))).map((w) => w.garment_id)); }, [worn, resolved]);
  const sel = resolved.find((r) => r.key === selected) ?? null;

  function frozenItem(r: Resolved): Worn {
    return { snapshot: true, image: r.piece ? (r.worn.image ?? (r.garment.transparent_image_id ? "img:" + r.garment.transparent_image_id : undefined)) : r.image ?? undefined,
      garment_id: r.garment.id, ...(r.piece ? {piece: r.piece.id, piece_def: r.piece, ...(r.piece.rest ? {piece_peers: r.worn.piece_peers ?? r.template?.data?.pieces ?? [r.piece]} : {})} : {}), slot: r.worn.slot, hidden: r.worn.hidden,
      variant: r.worn.variant, fit: r.fit, opts: r.opts, mask: r.mask, parts: r.parts };
  }

  // ───── 場景 ─────
  const draftPart = draft?.parts.find((p) => p.id === draft.sel) ?? null;
  const hair = useMemo(() => (draft?.kind === "hair" ? { parts: draft.parts } : hairOf(assets, look.hair,look.hair_config)), [draft?.kind === "hair" ? draft.parts : null, assets, look.hair,look.hair_config]);
  const activeHair = !draft && tab === "look" && lookTab === "hair" ? hair?.parts.find(p=>p.id===hairSelected&&!p.hidden)??null : null;
  const hairMasking = !draft && !!activeHair && hairTool === "mask";
  const head = useMemo(() => { const p = draft?.kind === "head" ? draft.parts[0] : null; return p ? { file: p.file, x: p.x, y: p.y, w: p.w, h: p.h } : look.head_config ?? headOf(assets, look.head); }, [draft?.kind === "head" ? draft.parts : null, assets, look.head, look.head_config]);
  // 頭部及頭髮在這個身體上的對位：畫面、骨架及點選使用對位後的位置；保存一律用原本的素材座標
  const headFit = useMemo(() => headFitFor(bodyModel, draft?.kind === "head" ? draft.id : look.head), [bodyModel, look.head, draft?.kind, draft?.id]);
  const shownHair = useMemo(() => adjustHair(hair, headFit), [hair, headFit]);
  const shownHead = useMemo(() => adjustHead(head, headFit), [head, headFit]);
  const rig = useMemo(() => rigFor(shownHair, bodyModel.rig), [shownHair, bodyModel]);
  useEffect(() => {
    if (!recoveryReady || (!dirty && !draft)) { recoveryLatest.current = null; return; }
    const value: Recovery = { model: modelRef(bodyModel), snap: { worn: worn.map(w => { const r = resolved.find(r => r.key === itemKey(w)); return r ? frozenItem(r) : w; }), pose, front, look: {...look, ...(hair ? {hair_config: hair} : {})} }, name, favorite, selected, hairSelected, draft,
      versions: worn.map(w => [w.garment_id, recoveryVersions.current?.get(w.garment_id) ?? tpls?.v2.get(w.garment_id)?.version ?? 0]),
      images: worn.map(w => [w.garment_id, garments?.find(g => g.id === w.garment_id)?.transparent_image_id]) };
    recoveryLatest.current = value;
    const timer = window.setTimeout(() => queueDraft(recoveryKey, value), 700);
    return () => clearTimeout(timer);
  }, [recoveryReady, dirty, worn, pose, front, look, name, favorite, selected, hairSelected, draft, tpls, resolved, hair, bodyModel]);
  const colors = useMemo(() => (draft?.kind === "hair" ? { main: null, accent: null, tip: null } : { ...resolveHairColors(look.hair_color, look.accent_color), tip: look.tip_color ? hexToRgb(look.tip_color) : null }), [look.hair_color, look.accent_color, look.tip_color, draft?.kind]);
  const advanced = !!sel && !draft;
  const autoParts = !!sel && SLOT_SKIN[sel.worn.slot] === "upper" && wearMode(sel.opts) === "auto";
  const editing: "mask" | "parts" | null = !advanced || preview ? null : tool === "mask" ? "mask" : tool === "follow" && autoParts && partTool.label >= 0 ? "parts" : null;
  /** 目前的編輯視圖：遮罩／袖子範圍可以切換到衣物原圖或部件網格；其他情況一律是穿著預覽 */
  const view: GarmentView = !advanced || preview ? "worn" : tool === "mask" ? (gview === "mesh" ? "worn" : gview) : tool === "follow" && autoParts ? gview : "worn";
  const selId = sel?.key ?? null;
  // 部件顏色：標記袖子、衣物原圖及部件網格視圖一定顯示（完整衣物＋半透明顏色）；遮罩的已編輯位置按「顯示已編輯位置」
  // 衣物原圖：一定以顏色區分「隱藏」（紅）及「移到身後」（藍），否則兩者在平面原圖上很難分辨
  const overlayMode = compare || preview || !selId ? null : editing === "mask" ? (hint || view === "source" ? "mask" : null) : tool === "follow" && autoParts && (editing === "parts" || view !== "worn" || hint) ? "parts" : null;
  /**
   * 對比：只暫時停用目前工具負責的那一項設定（位置、大小、旋轉、姿勢及其他設定保持不變；不會改動衣物資料）。
   * 變形＝沒有手動網格；遮罩＝沒有遮罩；骨架＝不按骨架變形（整件跟隨主骨骼，即基準姿勢下的樣子）。
   */
  const compareKind: CompareKind | null = !compare || !sel ? null : tool === "mesh" ? "mesh" : tool === "mask" ? "mask" : tool === "follow" ? "rig" : null;
  const scene: Scene = useMemo(() => ({
    hair: shownHair, head: shownHead, ...colors, pose, front,
    items: resolved.filter((r) => r.image).map((r) => {
      const it = sceneItem(r);
      if (!compareKind || r.key !== selId) return it;
      if (compareKind === "mesh") return { ...it, fit: { ...it.fit, mesh: undefined } };
      if (compareKind === "mask") return { ...it, mask: null };
      return { ...it, parts: "whole", opts: { ...it.opts, follow: "none" as const, sleeve_r: 0, sleeve_l: 0, bind: undefined } };
    }),
    overlay: overlayMode && selId ? { key: selId, mode: overlayMode } : null,
    // 衣物原圖視圖與對比是兩件事：對比時仍然留在原圖，只是暫時不套用遮罩
    flat: view === "source" ? selId : null,
    wire: view === "mesh" && !compare ? selId : null,
  }), [shownHair, shownHead, colors, pose, front, resolved, overlayMode, selId, compareKind, view, compare]);
  const mats = useMemo(() => solve(rig, pose), [rig, pose]);
  // 「移到身後」的實際像素效果：停筆後量度一次（低解像度），讓使用者分辨「身後」與「隱藏」
  const [behindStats, setBehindStats] = useState<BehindStats | null>(null);
  const selMask = sel?.mask ?? null;
  useEffect(() => {
    if (editing !== "mask" || !selId || !selMask) { setBehindStats(null); return; }
    let alive = true, tries = 0;
    const run = () => {
      if (!alive) return;
      const st = renderer.behindStats({ ...scene, items: scene.items.map((i) => (i.key === selId ? { ...i, mask: selMask } : i)) }, selId);
      if (st || ++tries > 20) { if (alive) setBehindStats(st); return; }
      timer = window.setTimeout(run, 250);
    };
    let timer = window.setTimeout(run, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [editing, selId, selMask, pose, renderer, scene]);

  // ───── 撤銷／重做（衣物、位置、遮罩、部件、姿勢、外貌） ─────
  const snap: Snap = useMemo(() => ({ worn, pose, front, look }), [worn, pose, front, look]);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  useEffect(() => {
    const h = hist.current;
    if (!loaded) { clearTimeout(h.timer); h.past = []; h.future = []; h.base = null; return; }
    if (h.cancel) {
      if (sameSnap(h.cancel.to, snap) || Date.now() > h.cancel.until) { h.base = snap; h.cancel = null; h.skip = false; }
      clearTimeout(h.timer); h.timer = 0;
      return;
    }
    if (h.base === null || h.skip) { h.base = snap; h.skip = false; setHistN((n) => n + 1); return; }
    if (h.base === snap) return;
    // 內容與上一步完全相同（例如拖動被取消後還原）：不算改動
    if (sameSnap(h.base, snap)) { h.base = snap; if (h.timer && h.prev && sameSnap(h.prev, snap)) { clearTimeout(h.timer); h.timer = 0; } return; }
    // 連續的調整（拖動、滑桿）合併成一步；但連續超過一秒就分成另一步，不會把一連串不同的操作併成一步
    const now = Date.now();
    if (h.timer && now - h.start > 1000) { clearTimeout(h.timer); h.timer = 0; commitHist(h.prev ?? snap); }
    if (!h.timer) h.start = now;
    h.prev = snap;
    clearTimeout(h.timer);
    h.timer = window.setTimeout(() => { h.timer = 0; commitHist(snapRef.current); }, 380);
  }, [snap, loaded]);
  const sameSnap = (a: Snap | null, b: Snap | null) => !!a && !!b && a.worn === b.worn && a.pose === b.pose && a.front === b.front && a.look === b.look;
  /** 把目前累積的改動記為一步 */
  function commitHist(next: Snap) {
    const h = hist.current;
    if (h.base && h.base !== next && !sameSnap(h.base, next)) { h.past.push(h.base); if (h.past.length > 60) h.past.shift(); h.future = []; }
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
    if (selected && !target.worn.some((w) => itemKey(w) === selected)) setSelected(null);
  }
  const canUndo = hist.current.past.length > 0 || !!hist.current.timer, canRedo = hist.current.future.length > 0 && !hist.current.timer;
  useEffect(() => { renderer.prune(new Set(worn.map(itemKey))); }, [worn, renderer]);

  const change = (fn: (cur: Worn[]) => Worn[]) => { setWorn(fn); setDirty(true); };
  const setItem = (key: string, v: Partial<Worn>) => change((cur) => cur.map((w) => (itemKey(w) === key ? { ...w, ...v } : w)));
  const setPose = (p: Pose, f?: FrontPart[]) => { setPoseState(p); if (f) setFront(f); setDirty(true); };
  const editLook = (v: Appearance) => { setLook(v); setDirty(true); };
  const patchHair=(id:string,patch:Partial<HairPart>)=>{if(!hair)return;editLook({...look,hair_config:{...hair,parts:hair.parts.map(p=>p.id===id?{...p,...patch}:p)}});};
  const selectHair=(id:string|null)=>{setHairSelected(id);setHairTool("place");setSelected(null);};

  /**
   * 切換身體：穿著清單、圖層次序、隱藏狀態、髮型及髮色保持不變；衣物改用新身體自己的預設
   * （沒有的話由 Avatar V2 設定換算或自動對位，只當作初始建議）。之前在新身體上的個別調整會恢復。
   * 姿勢按新身體的活動範圍限制。撤銷紀錄清除，避免把另一個身體的位置撤銷回來。
   */
  async function switchModel(nextId: string, rev?: number | null) {
    if (busy || draft || (nextId === bodyModel.id && (!rev || rev === bodyModel.revision))) return;
    setBusy(true);
    try {
      const [m, t] = await Promise.all([loadModel(nextId, rev ?? null), fetchTemplates(nextId)]);
      perModel.current.set(bodyModel.id, worn);
      const remembered = perModel.current.get(m.id) ?? [];
      const has = (gid: string, pid: string) => !!(t.v2.get(gid)?.data?.pieces?.some((p) => p.id === pid) || t.base?.get(gid)?.data?.pieces?.some((p) => p.id === pid));
      const next: Worn[] = worn.map((w) => {
        const r = remembered.find((x) => itemKey(x) === itemKey(w));
        if (r) return { ...r, hidden: w.hidden, slot: w.slot, variant: w.variant };
        const pieceDef = w.piece && w.piece_def && !has(w.garment_id, w.piece) ? { ...w.piece_def, fit: null, opts: null, wear_mask: null, pose: null } : undefined;
        // 與新穿上時相同的預設：沒有衣物預設的衣物固定原圖（不自動變形）
        const g = gmap.get(w.garment_id), fresh = g && !w.piece ? wornFor(g, t) : null;
        return { garment_id: w.garment_id, ...(w.piece ? { piece: w.piece } : {}), ...(pieceDef ? { piece_def: pieceDef } : {}), slot: w.slot, hidden: w.hidden, variant: w.variant, fit: null, opts: fresh?.opts ?? null, mask: null };
      });
      const clamped = clampPose(m.rig, pose);
      const h = hist.current;
      clearTimeout(h.timer); h.timer = 0; h.past = []; h.future = []; h.base = null;
      setBodyModel(m); setTpls(t); setWorn(next); setSelected(null); setPoseState(clamped); setDirty(true); setPosePrompt(null);
      const unset = next.filter((w) => !w.piece && !t.v2.has(w.garment_id)).length;
      setNotice(`已切換到「${modelLabel(m)}」${unset ? `：${unset} 件衣物未有這個身體的設定，暫用自動對位或由 V2 換算的初始位置` : ""}${samePose(m.rig, clamped, pose) ? "" : "；部分關節超出新身體的活動範圍，已自動調整"}`);
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  }
  /** 只有使用者自己的姿勢庫需要：套用時按目前身體的活動範圍限制 */
  const applyLibraryPose = (p: Pose, f: FrontPart[]) => { const c = clampPose(rig, p); setPose(c, f); if (!samePose(rig, c, p)) toast("部分關節超出這個身體的活動範圍，已自動調整"); };

  function toggle(g: Garment) {
    if (!tpls || busy) return;
    if (worn.some((w) => w.garment_id === g.id && !w.piece)) {
      change((cur) => cur.filter((w) => !(w.garment_id === g.id && !w.piece)));
      if (selected === g.id) setSelected(null);
      return;
    }
    const w = wornFor(g, tpls);
    change((cur) => { const at = insertIndex(cur, w.slot); return [...cur.slice(0, at), w, ...cur.slice(at)]; });
    const d = templateFor(tpls, g)?.data;
    offerPose(w.slot, d?.pose ?? null, d?.front ?? [], displayName(g as Garment));
  }
  /** 直接穿上／脫下一個套裝部件（不需要先穿整套）；使用部件保存的完整預設 */
  function togglePiece(e: PieceEntry) {
    if (!tpls || busy) return;
    const key = e.g.id + "#" + e.piece.id;
    if (worn.some((w) => itemKey(w) === key)) { remove(key); return; }
    const w: Worn = { garment_id: e.g.id, piece: e.piece.id, slot: e.piece.slot, hidden: false, variant: null, fit: null, opts: null, mask: null };
    change((cur) => { const at = insertIndex(cur, w.slot); return [...cur.slice(0, at), w, ...cur.slice(at)]; });
    offerPose(e.piece.slot, e.piece.pose ?? null, [], e.piece.name);
  }
  /**
   * 穿上衣物時的姿勢：角色未穿著其他主要衣物（上衣／連身裙／套裝／外套）時，直接套用這件衣服的預設姿勢；
   * 已穿著其他主要衣物時只提示，不會強制改變整個人物。配件、半裙、頭飾等不會改變姿勢。
   */
  function offerPose(slot: Slot, p: Pose | null, f: FrontPart[], label: string) {
    // 預設姿勢是靜止站姿（舊預設會自動記下保存時的姿勢）：不當作指定姿勢，不改變目前人物
    if (!p || !Object.keys(p).length || !MAIN_SLOTS.has(slot) || poseDistance(p, pose) < 6) return;
    const others = worn.some((w) => !w.hidden && MAIN_SLOTS.has(w.slot));
    if (!others) { setPose(p, f); toast(`已套用「${label}」的預設姿勢（可撤銷）`); return; }
    setPosePrompt({ label, pose: p, front: f });
  }
  function remove(key: string) { change((cur) => cur.filter((w) => itemKey(w) !== key)); if (selected === key) setSelected(null); }
  function order(gid: string, to: "top" | "up" | "down" | "bottom") {
    change((cur) => {
      const i = cur.findIndex((w) => itemKey(w) === gid);
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
    setItem(r.key, { fit: sameFit(ok, r.base) ? null : ok, v1fit: null });
  }
  const nudge = (r: Resolved, f: FitDelta) => {
    // wide＝只改闊度（高度不變）；tall＝只改高度；w／rotation＝滑桿直接指定
    const sy = Math.min(SY_LIMIT.max, Math.max(SY_LIMIT.min, ((r.fit.sy ?? 1) * (f.tall ?? 1)) / (f.wide ?? 1)));
    applyFit(r, { ...r.fit, cx: r.fit.cx + (f.dx ?? 0), cy: r.fit.cy + (f.dy ?? 0), w: (f.w ?? r.fit.w) * (f.scale ?? 1) * (f.wide ?? 1), rotation: (f.rotation ?? r.fit.rotation) + (f.rot ?? 0), sy });
  };
  const setOpts = (r: Resolved, o: Partial<WearOpts>) => {
    touchedRig.current.add(r.key);
    const opts={...r.opts,...o}, from=mainBone({slot:r.worn.slot,opts:r.opts}), to=mainBone({slot:r.worn.slot,opts});
    if(from!==to && (from==="world"||to==="world")){
      const a=mats[from], b=mats[to]; let pt:[number,number]=[r.fit.cx,r.fit.cy];
      if(a)pt=applyMat(a,...pt); if(b)pt=applyMat(invert(b),...pt);
      setItem(r.key,{opts,fit:{...r.fit,cx:pt[0],cy:pt[1],rotation:r.fit.rotation+(a?matAngle(a):0)-(b?matAngle(b):0)}});
    } else setItem(r.key,{opts});
  };

  /** 切換衣物跟隨方式：位置（遮罩、網格）保留；固定原圖與跟隨身體之間換算座標，畫面上的位置不變 */
  const setMode = (r: Resolved, m: WearMode) => {
    if (m === wearMode(r.opts)) return;
    setPartTool((p) => ({ ...p, label: -1 }));
    if (m === "fixed") setOpts(r, { follow: "none", bone: "world" });
    else if (m === "body") setOpts(r, { follow: "none", bone: null });
    else setOpts(r, { follow: "auto", bone: null });
  };
  // ───── Phase 3.8A 快捷操作：還原姿勢、跟隨模式（與「骨架」分頁使用同一份設定） ─────
  const [quick, setQuick] = useState(false);
  /** 「跟隨手臂」只適用於有袖子的上身衣物（上衣、連身裙、外套、整套）；半裙、頭飾、頸飾等不強制使用袖子骨架 */
  const armCapable = (r: Resolved) => SLOT_SKIN[r.worn.slot] === "upper";
  /** 這件衣物（或套裝部件）未經造型調整時的跟隨模式 */
  const defaultModeOf = (r: Resolved): WearMode => {
    const base = r.piece ? r.piece.opts : (r.worn.variant ? r.template?.data?.variants[r.worn.variant]?.opts : null) ?? r.template?.data?.opts;
    if (base) return wearMode(base);
    // 與 model.ts 新穿上衣物一致：沒有衣物預設＝固定原圖；部件＝跟隨所附接的骨骼
    return r.piece ? "body" : "fixed";
  };
  /** 還原姿勢：當前身體模型自己的預設站姿（姿勢＝{}＝該身體的靜止骨架）；衣物、遮罩、網格、髮型、鏡頭全部保留，可撤銷 */
  const quickResetPose = () => { flushHist(); setPose({}, []); toast("已還原為預設站姿（衣物設定保留）"); };
  const quickTargets = (m: WearMode) => resolved.filter((r) => r.image && !r.worn.hidden && (m !== "auto" || armCapable(r)));
  const quickMode = (m: WearMode) => {
    if (!sel) return;
    if (m === "auto" && !armCapable(sel)) { toast("這件衣物沒有袖子骨架，不適用「跟隨手臂」", "err"); return; }
    flushHist(); setMode(sel, m);
  };
  const quickModeAll = (m: WearMode | "default") => {
    flushHist();
    let n = 0;
    for (const r of m === "default" ? resolved.filter((r) => r.image) : quickTargets(m)) {
      const to = m === "default" ? defaultModeOf(r) : m;
      if (wearMode(r.opts) === to) continue;
      setMode(r, to); n++;
    }
    toast(n ? `已改變 ${n} 件衣物（只影響這個造型）` : "沒有需要改變的衣物");
  };
  /**
   * 基準姿勢：以目前角色姿勢作為這件衣物的綁定基準。畫面上的衣物形狀（位置、網格）就是基準形狀；
   * 之後移動手臂時只按「目前姿勢與基準的差異」變形。袖子額外角度歸零，避免與網格／骨架重複計算。
   */
  const setBind = (r: Resolved, on: boolean) => {
    flushHist();
    if (!on) { setOpts(r, { bind: undefined }); return; }
    if (r.opts.follow !== "none" && (poseDistance(r.opts.bind ?? {}, pose) > 0.1 || r.opts.sleeve_r || r.opts.sleeve_l)) {
      toast("目前衣物已有骨架變形；請直接保存目前穿著效果。重新綁定需要先還原基準姿勢，避免畫面跳動。", "err");
      return;
    }
    setOpts(r, { bind: clampPose(rig, pose) });
    toast("已把目前姿勢設為這件衣物的基準姿勢；記得「存為衣物預設」");
  };
  /** 返回完整原圖：固定原圖，清除拆件、手動網格及遮罩（位置、大小、旋轉保留，可撤銷） */
  const wholeImage = (r: Resolved) => {
    const opts = { ...r.opts, follow: "none" as const, bone: "world", sleeve_r: 0, sleeve_l: 0, bind: undefined };
    const from = mainBone({ slot: r.worn.slot, opts: r.opts });
    let fit: Fit = { ...r.fit, mesh: undefined };
    if (from !== "world") { const a = mats[from]; if (a) { const [x, y] = applyMat(a, r.fit.cx, r.fit.cy); fit = { ...fit, cx: x, cy: y, rotation: r.fit.rotation + matAngle(a) }; } }
    flushHist();
    setItem(r.key, { snapshot: true, opts, fit, mask: null, parts: "whole" });
    setPartTool((p) => ({ ...p, label: -1 }));
  };
  async function saveTemplate(r: Resolved, patch: (data: ReturnType<typeof normalizeTemplateData>) => { data: ReturnType<typeof normalizeTemplateData>; fit: Fit }, done: string, after?: Partial<Worn>): Promise<boolean> {
    if (r.analysis.content.approximate) { toast("高清圖未讀取成功，暫時不能存為預設", "err"); return false; }
    if (r.worn.snapshot && r.worn.image?.startsWith("img:") && r.worn.image !== "img:" + r.garment.transparent_image_id) { toast("這份編輯使用舊圖片。請保留為造型，或重新開啟最新衣物再校正預設。", "err"); return false; }
    setBusy(true);
    try {
      const cur = r.template?.data ?? normalizeTemplateData(null, r.worn.slot);
      const { data, fit } = patch({ ...cur, converted: undefined, converted_from: undefined });
      const t = await api<Template>(`/api/doll/templates/${r.garment.id}`, { method: "PUT", json: { avatar_id: bodyModel.id, fit, slot: r.piece ? r.template?.slot ?? r.worn.slot : r.worn.slot, image_id: r.garment.transparent_image_id ?? null, expected_version: recoveryVersions.current?.get(r.garment.id) ?? (r.template?.converted ? 0 : r.template?.version) ?? tpls?.v2.get(r.garment.id)?.version ?? 0, data } });
      recoveryVersions.current?.set(r.garment.id, t.version);
      setTpls((cur) => (cur ? { ...cur, v2: new Map(cur.v2).set(r.garment.id, t) } : cur));
      setItem(r.key, { snapshot:false, fit: null, v1fit: null, opts: null, mask: null, parts: null, ...after });
      toast(done);
      return true;
    } catch (e) {
      toast((e as Error).message, "err");
      if (e instanceof ApiError && e.code === "template_conflict") setNotice("預設版本衝突：編輯已保留在本機草稿。請離開並重新開啟，檢查最新設定後再調整；不要直接覆蓋。");
      return false;
    } finally {
      setBusy(false);
    }
  }
  const savedStatus = (previous: SetupStatus | undefined, r: Resolved): SetupStatus => ({
    ...previous, place: "done",
    ...(r.fit.mesh ? { mesh: "done" as const } : {}),
    ...(r.mask ? { mask: "done" as const } : {}),
    // A full save records an explicit following choice, without inventing a "not needed" mark.
    ...(touchedRig.current.has(r.key) ? { rig: "done" as const } : {}),
  });
  const saveDefault = (r: Resolved) => {
    if (r.piece) {
      // 套裝部件：位置及跟隨方式存回套裝的拆件設定（其他造型穿上這個部件時使用）
      const pc = r.piece;
      // 完整預設：位置、網格（在 fit 內）、穿著遮罩、跟隨方式／基準姿勢及建議姿勢。只更新這一個部件，其他部件不受影響。
      const wearMask = r.mask;
      return saveTemplate(r, (d) => ({ data: { ...d, pieces: (d.pieces ?? []).map((q) => (q.id === pc.id ? { ...q, fit: r.fit, opts: r.opts, wear_mask: wearMask, parts: r.parts, status: savedStatus(q.status, r), pose: clampPose(rig, pose) } : q)) }, fit: r.template!.fit }), "已存為這個部件的完整預設", { piece_def: null });
    }
    const v = r.worn.variant;
    return saveTemplate(r, (d) => (v && d.variants[v] ? { data: { ...d, variants: { ...d.variants, [v]: { ...d.variants[v], fit: r.fit, opts: r.opts, mask: r.mask, parts: r.parts, pose: clampPose(rig, pose) } } }, fit: r.template!.fit } : { data: { ...d, status: savedStatus(d.status, r), opts: r.opts, mask: r.mask, parts: r.parts, pose: clampPose(rig, pose), front }, fit: r.fit }), "已存為這件衣物的預設，之後任何造型穿上都會自動套用");
  };
  const baseRowFit = (r: Resolved) => r.template?.fit ?? (r.worn.variant ? defaultFit(r.worn.slot, r.analysis.content, r.garment.category, r.garment.subcategory, r.garment.name, bodyModel.rig) : r.base);
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
  // ───── 套裝拆件 ─────
  const [split, setSplit] = useState<string | null>(null);
  const splitR = split ? resolved.find((r) => r.key === split) ?? null : null;
  async function saveSplit(r: Resolved, pieces: Piece[]) {
    const saved = await saveTemplate(r, (d) => ({ data: { ...d, pieces }, fit: baseRowFit(r) }), pieces.length ? `已保存 ${pieces.length} 個部件，可以獨立穿著` : "已清除拆件", { fit: r.worn.fit, opts: r.worn.opts, mask: r.worn.mask, parts: r.worn.parts ?? null, snapshot: r.worn.snapshot });
    if (saved) setSplit(null);
    return saved;
  }
  async function uploadPieceFile(r: Resolved, file: File, label: string): Promise<string | null> {
    setBusy(true);
    try {
      const prepared = await prepareAsset(file, 1800);
      const asset = await api<{ id: string }>("/api/doll/assets", { method: "POST", json: { kind: "garment_part", name: label.trim().slice(0, 30) || "部件", garment_id: r.garment.id } });
      const up = await api<{ ref: string }>(`/api/doll/assets/${asset.id}/files`, { method: "POST", body: prepared.blob, headers: { "content-type": "image/png" } });
      return up.ref;
    } catch (e) { toast((e as Error).message, "err"); return null; } finally { setBusy(false); }
  }
  /** 穿上套裝的部件（放在套裝原本的圖層位置）。replace＝同時脫下整件套裝 */
  function wearPieces(r: Resolved, ids: string[], replace: boolean) {
    flushHist();
    change((cur) => {
      const at = cur.findIndex((w) => itemKey(w) === r.key);
      const have = new Set(cur.map(itemKey));
      const pcs = (r.template?.data?.pieces ?? []).filter((p) => ids.includes(p.id) && !have.has(r.garment.id + "#" + p.id));
      const add: Worn[] = pcs.map((p) => ({ garment_id: r.garment.id, piece: p.id, slot: p.slot, hidden: false, variant: null, fit: null, opts: null, mask: null }));
      const next = [...cur];
      next.splice(at < 0 ? next.length : at + 1, 0, ...add);
      return replace ? next.filter((w) => itemKey(w) !== r.key) : next;
    });
    if (replace) setSelected(null);
    const main = r.template?.data?.pieces?.find(p => ids.includes(p.id) && MAIN_SLOTS.has(p.slot));
    if (main) offerPose(main.slot, main.pose ?? null, [], main.name);
  }
  async function deleteVariant(r: Resolved, vid: string) {
    const v = r.template?.data?.variants[vid];
    if (!v || !confirm(`刪除穿法「${v.name}」？`)) return;
    await saveTemplate(r, (d) => { const variants = { ...d.variants }; delete variants[vid]; return { data: { ...d, variants }, fit: r.template!.fit }; }, "已刪除穿法", { variant: r.worn.variant === vid ? null : r.worn.variant, fit: r.worn.fit, opts: r.worn.opts, mask: r.worn.mask, parts: r.worn.parts ?? null });
    // Variant images remain available to historical look snapshots; explicit asset cleanup checks references.
  }

  // ───── 遮罩／部件塗抹 ─────
  // 塗抹的位置沿著「目前姿勢下實際變形後的網格」換算回圖片，所以任何姿勢下都是塗在眼睛看到的那塊布料上。
  const selItem = useMemo(() => (sel && sel.image ? sceneItem(sel) : null), [sel]);
  const editSource = editing === "mask" ? sel?.mask ?? null : editing === "parts" ? sel?.parts ?? null : null;
  const editId = editing && sel ? [editing, sel.key, sel.image, sel.worn.variant ?? "", id ?? ""].join("|") : "";
  useEffect(() => {
    const prev = edit.current;
    if (prev && (prev.kind !== editing || prev.key !== sel?.key || !editId)) { renderer.setLiveMask(prev.key, null); renderer.setLiveParts(prev.key, null); edit.current = null; }
    if (!editing || !sel || !selItem) return;
    const cur = edit.current;
    // 撤銷、恢復預設、切換穿法或造型後，畫面上的遮罩已經不同：重新載入，避免用舊的暫存蓋掉新的
    if (cur && cur.committed === editSource && cur.ready) return;
    const gid = sel.key;
    renderer.setLiveMask(gid, null); renderer.setLiveParts(gid, null);
    if (editing === "parts") {
      // 部件圖由目前的分辨結果（自動或人工）開始修改
      const g = sel.analysis.grid, data = new Uint8ClampedArray(g.w * g.h * 4);
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      const manual = !!editSource && editSource.startsWith("data:");
      const buf: EditBuf = { kind: "parts", key: gid, w: g.w, h: g.h, data, ready: !manual, committed: editSource, last: null, dirty: false, at: 0, backup: null };
      edit.current = buf;
      if (manual) {
        // 人工標記：直接由已保存的部件圖讀取（不經渲染器的暫存，撤銷或重設後不會讀到舊的分辨結果）
        void loadImage(editSource!).then((img) => {
          if (edit.current !== buf) return;
          const c = document.createElement("canvas");
          c.width = g.w; c.height = g.h;
          const ctx = c.getContext("2d", { willReadFrequently: true })!;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, 0, 0, g.w, g.h);
          const px = ctx.getImageData(0, 0, g.w, g.h).data;
          for (let i = 0; i < g.w * g.h; i++) data[i * 4] = Math.min(2, Math.round(px[i * 4] / 50)) * 50;
          buf.ready = true;
        }).catch(() => { if (edit.current === buf) buf.ready = true; });
      } else if (editSource !== "whole") {
        const lab = renderer.geometry({ ...selItem, parts: null }).labels;
        if (lab.w === g.w && lab.h === g.h) for (let i = 0; i < g.w * g.h; i++) data[i * 4] = Math.min(2, lab.data[i]) * 50;
      }
      return;
    }
    const w = MASK_W, h = Math.max(8, Math.min(900, Math.round(MASK_W * sel.analysis.content.ar)));
    const buf: EditBuf = { kind: "mask", key: gid, w, h, data: new Uint8ClampedArray(w * h * 4), ready: !editSource, committed: editSource, last: null, dirty: false, at: 0, backup: null };
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
  function paint(r: Resolved, x: number, y: number, phase: PaintPhase, brushR: number) {
    const e = edit.current;
    if (!e || e.key !== r.key || !e.ready || !selItem) return;
    if (phase === "cancel") {
      // 第二根手指落下（開始縮放畫面）：這一筆作廢，還原到落筆之前
      e.last = null;
      if (e.backup) { e.data.set(e.backup); e.backup = null; if (e.dirty || e.at) pushLive(e); }
      e.dirty = false;
      return;
    }
    if (phase === "start") { e.backup = e.data.slice(); e.dirty = false; }
    if (phase === "end") {
      e.last = null;
      e.backup = null;
      if (!e.dirty) return;
      e.dirty = false;
      pushLive(e);
      const c = document.createElement("canvas");
      c.width = e.w; c.height = e.h;
      c.getContext("2d")!.putImageData(new ImageData(e.data.slice(), e.w, e.h), 0, 0);
      const url = c.toDataURL("image/png");
      e.committed = url;
      flushHist();
      setItem(r.key, e.kind === "mask" ? { mask: url } : { parts: url });
      return;
    }
    // 筆刷半徑以螢幕像素計：放大畫面後，同一枝筆在衣物上會更細。原圖視圖用原圖座標；穿著預覽沿變形網格逆向換算。
    const flat = view === "source", ar = r.analysis.content.ar;
    const radius = Math.max(0.8, (brushR / (flat ? flatRect(ar).w : r.fit.w)) * e.w);
    // 兩點之間補上中間的位置，快速塗抹也是連續的一筆
    const from = phase === "move" && e.last ? e.last : [x, y], dist = Math.hypot(x - from[0], y - from[1]), steps = Math.max(1, Math.ceil(dist / Math.max(1.5, brushR * 0.5)));
    let changed = false;
    for (let n = phase === "move" && e.last ? 1 : 0; n <= steps; n++) {
      const px0 = from[0] + ((x - from[0]) * n) / steps, py0 = from[1] + ((y - from[1]) * n) / steps;
      const uv = flat ? flatLocate(ar, px0, py0) : renderer.locate(selItem, mats, px0, py0);
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
    setItem(r.key, { mask: c.toDataURL("image/png") });
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
  async function newAsset(kind: "hair" | "head", cat?: HairCat) {
    setBusy(true);
    try {
      const a = await api<{ id: string; name: string }>("/api/doll/assets", { method: "POST", json: { kind, name: kind === "hair" ? "新髮型" : "新頭部" } });
      setDraft({ id: a.id, isNew: true, kind, name: "", category: cat ? HAIR_CAT_LABEL[cat] : "", parts: [], sel: null, cat }); setHairTool("place");
      setSelected(null);
      setViewKey("upper");
      if (panel === "mini") setPanel("mid");
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
          const pid = "p" + Math.random().toString(36).slice(2, 8);
          if (d.cat || files.length === 1) {
            // 單件髮件：按分類自動放到頭上（圖片已裁走透明留白，髮根＝圖片頂部）
            const cat: HairCat = d.cat ?? guessHairCat(f.name, ar);
            part = { id: pid, label: HAIR_CAT_LABEL[cat], cat, layer: HAIR_CAT_LAYER[cat], bone: HAIR_CAT_BONE[cat] ?? "head", file: up.ref, ...placeHairPart(cat, ar) };
          } else {
            // 一次上傳多張：通常是同一張畫布拆出來的部件，整張畫布按頭部比例縮放後置中，各部件的相對位置自動保持
            const k = 450 / Math.max(p.sourceW, 1);
            if (!hairFrame.current || hairFrame.current.id !== d.id) hairFrame.current = { id: d.id, y0: 12 - p.box.y0 * p.sourceH * k };
            const w = (p.box.x1 - p.box.x0) * p.sourceW * k;
            const cat = guessHairCat(f.name, ar, w * ar < 330);
            part = { id: pid, label: HAIR_CAT_LABEL[cat], cat, layer: HAIR_CAT_LAYER[cat], bone: HAIR_CAT_BONE[cat] ?? "head", file: up.ref, x: 601 - 225 + p.box.x0 * p.sourceW * k, y: hairFrame.current.y0 + p.box.y0 * p.sourceH * k, w, h: w * ar };
          }
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
      const parts = draft.parts.map(round).map((p) => (draft.kind === "hair" ? { ...p, cat: hairCatOf(p) } : p));
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
      if (draft.kind === "hair") {
        if (draft.isNew && parts.length === 1) {
          // 新增的單件髮件：像換裝一樣穿上，替換同一分類（例如舊瀏海），其他髮件不變
          const r = wearHairPart(hairOf(assets, look.hair, look.hair_config), { ...parts[0], src: draft.id });
          editLook({ ...look, hair_config: r.config });
        } else editLook({ ...look, hair: draft.id, hair_config: null });
      } else editLook({ ...look, head: draft.id, head_config: null });
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

  /** 把造型內校正好的髮件位置存回該髮件素材，以後每次選用都使用這個位置 */
  async function saveHairDefault(id: string) {
    const p = hair?.parts.find((x) => x.id === id);
    const a = p?.src ? assets.find((x) => x.id === p.src && x.kind === "hair") : null;
    if (!p || !a) return toast("這件髮件不是來自你上傳的素材", "err");
    setBusy(true);
    try {
      const cfg = a.config as HairConfig;
      const keep = { x: p.x, y: p.y, w: p.w, h: p.h, rotation: p.rotation, mesh: p.mesh, layer: p.layer, cat: hairCatOf(p), bone: p.bone, pivot: p.pivot, range: p.range, color: p.color };
      const parts = cfg.parts.map((q) => (q.file === p.file ? { ...q, ...keep } : q));
      await api(`/api/doll/assets/${a.id}`, { method: "PATCH", json: { name: a.name, category: a.category, config: { ...cfg, parts } } });
      await loadAssets();
      toast("已存為這件髮件的預設位置");
    } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  }
  const autoPlaceHair = (id: string) => { const p = hair?.parts.find((x) => x.id === id); if (p) patchHair(id, { ...placeHairPart(hairCatOf(p), p.h / p.w), rotation: undefined, mesh: undefined }); };
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

  // ───── 髮件可見性遮罩（Phase 3.6）：塗抹位置沿髮件實際變形換算回原圖；放手才寫入造型（每一筆＝一步，可撤銷） ─────
  const hairVisId = hairMasking && activeHair ? activeHair.id + "|" + (activeHair.vis ? activeHair.vis.length : 0) : "";
  useEffect(() => {
    const prev = hairEdit.current;
    if (!hairMasking || !activeHair) { if (prev) { renderer.setLiveHairMask(prev.id, null); hairEdit.current = null; } return; }
    if (prev && prev.id === activeHair.id && prev.src === (activeHair.vis ?? null)) return;
    if (prev) renderer.setLiveHairMask(prev.id, null);
    const w = 256, h = Math.max(8, Math.min(512, Math.round(256 * (activeHair.h / activeHair.w))));
    const buf = { id: activeHair.id, src: activeHair.vis ?? null, w, h, data: new Uint8ClampedArray(w * h * 4), ready: !activeHair.vis, last: null, dirty: false, backup: null, at: 0 };
    for (let i = 3; i < buf.data.length; i += 4) buf.data[i] = 255;
    hairEdit.current = buf;
    if (activeHair.vis) void loadImage(activeHair.vis).then((img) => {
      if (hairEdit.current !== buf) return;
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, w, h);
      buf.data.set(ctx.getImageData(0, 0, w, h).data);
      for (let i = 3; i < buf.data.length; i += 4) buf.data[i] = 255;
      buf.ready = true;
    }).catch(() => { if (hairEdit.current === buf) buf.ready = true; });
  }, [hairVisId, hairMasking, renderer]);
  useEffect(() => () => { const e = hairEdit.current; if (e) renderer.setLiveHairMask(e.id, null); }, [renderer]);
  function paintHair(x: number, y: number, phase: PaintPhase, brushR: number) {
    const e = hairEdit.current, shown = hp;
    if (!e || !e.ready || !activeHair || !shown || e.id !== activeHair.id) return;
    const push = () => renderer.setLiveHairMask(e.id, { w: e.w, h: e.h, data: e.data });
    if (phase === "cancel") { e.last = null; if (e.backup) { e.data.set(e.backup); e.backup = null; push(); } e.dirty = false; return; }
    if (phase === "start") { e.backup = e.data.slice(); e.dirty = false; }
    if (phase === "end") {
      e.last = null; e.backup = null;
      if (!e.dirty) return;
      e.dirty = false; push();
      let any = false;
      for (let i = 0; i < e.data.length; i += 4) if (e.data[i]) { any = true; break; }
      const c = document.createElement("canvas"); c.width = e.w; c.height = e.h;
      c.getContext("2d")!.putImageData(new ImageData(e.data.slice(), e.w, e.h), 0, 0);
      const url = any ? c.toDataURL("image/png") : undefined;
      if (url && url.length > HAIR_VIS_MAX) { toast("遮罩太複雜，請用較大的筆刷或分開幾件髮件", "err"); return; }
      e.src = url ?? null;
      flushHist();
      patchHair(activeHair.id, { vis: url });
      return;
    }
    const radius = Math.max(0.8, (brushR / shown.w) * e.w);
    const from = phase === "move" && e.last ? e.last : [x, y], dist = Math.hypot(x - from[0], y - from[1]), steps = Math.max(1, Math.ceil(dist / Math.max(1.5, brushR * 0.5)));
    let changed = false;
    for (let n = phase === "move" && e.last ? 1 : 0; n <= steps; n++) {
      const uv = renderer.locateHair(shown, mats, from[0] + ((x - from[0]) * n) / steps, from[1] + ((y - from[1]) * n) / steps);
      if (!uv) continue;
      const cx = uv[0] * e.w, cy = uv[1] * e.h;
      for (let py = Math.max(0, Math.floor(cy - radius)); py <= Math.min(e.h - 1, Math.ceil(cy + radius)); py++)
        for (let px = Math.max(0, Math.floor(cx - radius)); px <= Math.min(e.w - 1, Math.ceil(cx + radius)); px++) {
          if (Math.hypot(px + 0.5 - cx, py + 0.5 - cy) > radius) continue;
          e.data[(py * e.w + px) * 4] = hairBrush.mode === "hide" ? 255 : 0;
          changed = true;
        }
    }
    e.last = [x, y];
    if (!changed) return;
    e.dirty = true;
    const now = Date.now();
    if (now - e.at < 60) return;
    e.at = now; push();
  }

  // ───── 衣服設定模式：保存只更新衣物預設（不建立造型） ─────
  const setupTarget = setup ? resolved.find((r) => r.garment.id === setup.gid && (r.piece?.id ?? null) === (setup.piece ?? null)) ?? null : null;
  const neighbours = useMemo(() => {
    if (!setup) return { prev: null, next: null };
    let ids: string[] = [];
    try { ids = JSON.parse(sessionStorage.getItem("aw:setup:list") || "[]"); } catch { /* 私密瀏覽 */ }
    const i = ids.indexOf(setup.gid);
    return { prev: i > 0 ? ids[i - 1] : null, next: i >= 0 && i < ids.length - 1 ? ids[i + 1] : null };
  }, [setupKey]);
  const setupQs = setup?.model && !isBuiltinModel(setup.model) ? `?model=${setup.model}` : "";
  async function saveSetup() {
    if (!setupTarget) return;
    if (pending.size) return toast("衣物仍在載入，請稍後再保存", "err");
    if (await saveDefault(setupTarget)) { setDirty(false); await discardRecovery(); }
  }
  /** 手動標記設定項目：auto＝由程式判斷；done＝已完成；na＝不需要。立即保存到衣物預設（部件的標記存在部件內） */
  async function markSetup(r: Resolved, key: SetupKey, mark: SetupMark | null) {
    const set = (st: SetupStatus | undefined): SetupStatus | undefined => { const n: SetupStatus = { ...(st ?? {}) }; if (mark) n[key] = mark; else delete n[key]; return Object.keys(n).length ? n : undefined; };
    const keep = { fit: r.worn.fit, opts: r.worn.opts, mask: r.worn.mask, parts: r.worn.parts ?? null, snapshot: r.worn.snapshot };
    if (r.piece) { const pid = r.piece.id; return saveTemplate(r, (d) => ({ data: { ...d, pieces: (d.pieces ?? []).map((q) => (q.id === pid ? { ...q, status: set(q.status) } : q)) }, fit: r.template!.fit }), "已更新設定狀態", { ...keep, piece_def: null }); }
    return saveTemplate(r, (d) => ({ data: { ...d, status: set(d.status) }, fit: baseRowFit(r) }), "已更新設定狀態", keep);
  }

  // ───── 保存造型 ─────
  async function save(asNew = false) {
    if (pending.size) return toast("衣物仍在載入，請稍後再保存", "err");
    if (draft) return toast("請先儲存或取消正在編輯的素材", "err");
    setBusy(true);
    const state: LookState = {
      v: 3, model: modelRef(bodyModel), head: look.head, head_config: head, hair: look.hair, ...(hair?{hair_config:hair}:{}), hair_color: look.hair_color, accent_color: look.accent_color, tip_color: look.tip_color, pose: clampPose(rig, pose), front,
      items: resolved.map(frozenItem),
    };
    const target = asNew ? undefined : id;
    try {
      const res = await api<{ id: string }>(target ? `/api/doll/looks/${target}` : "/api/doll/looks", { method: target ? "PATCH" : "POST", json: { name: (asNew ? name.trim() + " 副本" : name.trim()) || "新造型", is_favorite: favorite, state } });
      try {
        const blob = await renderer.thumbnail({ ...scene, overlay: null });
        if (blob) await api(`/api/doll/looks/${res.id}/thumb`, { method: "PUT", body: blob, headers: { "content-type": "image/jpeg" } });
      } catch { /* 縮圖失敗不影響造型 */ }
      toast("已保存造型");
      setDirty(false); setNotice(""); await discardRecovery();
      if (res.id !== id) navigate(`/dressing/${res.id}`, true);
      else setWorn((cur) => cur.map((w) => (w.v1fit ? { ...w, fit: state.items.find((i) => itemKey(i) === itemKey(w))?.fit ?? null, v1fit: null } : w)));
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
  const leave = (to: string) => { if (!dirty || confirm(setup ? "這件衣服的設定尚未保存，確定離開？" : "造型尚未保存，確定離開？")) navigate(to); };

  // ───── 舞台互動 ─────
  const hpRaw = draftPart ?? activeHair;
  const hp = hpRaw ? (draft?.kind === "head" ? { ...hpRaw, ...adjustHead({ file: hpRaw.file, x: hpRaw.x, y: hpRaw.y, w: hpRaw.w, h: hpRaw.h }, headFit) } : adjustHair({ parts: [hpRaw] }, headFit)!.parts[0]) : null;
  const flatBox = sel && view === "source" ? flatRect(sel.analysis.content.ar) : null;
  const stageSel: Selection | null = hp
    ? { fit: { cx: hp.x + hp.w / 2, cy: hp.y + hp.h / 2, w: hp.w, rotation: hp.rotation ?? 0, mesh: hp.mesh }, content: FULL_CONTENT(hp.h / hp.w), bone: draft?.kind === "head" ? "head" : hairBoneId(hp), rotate: draft?.kind !== "head" }
    : sel && !draft ? { fit: sel.fit, content: sel.analysis.content, bone: mainBone({ slot: sel.worn.slot, opts: sel.opts }), bounds: flatBox ? [flatBox.x, flatBox.y, flatBox.x + flatBox.w, flatBox.y + flatBox.h] : selItem && tool !== "mesh" ? renderer.bounds(selItem, mats) : undefined } : null;
  const mode: StageMode = preview || compareKind ? "view" : hairMasking ? "mask" : draft || activeHair ? (hairTool === "mesh" && draft?.kind !== "head" ? "mesh" : "dress") : sel ? (editing ? "mask" : view === "source" ? "view" : tool === "mesh" ? "mesh" : "dress") : tab === "pose" ? "pose" : "dress";
  // 這個姿勢有對應的衣物校正（保存穿法時連同姿勢）：提示可以套用，不會自動更改
  const poseFix = useMemo(() => {
    for (const r of resolved) { const vs: Record<string, Variant> = r.template?.data?.variants ?? {}; for (const [vid, v] of Object.entries(vs)) if (v.pose && r.worn.variant !== vid && Object.keys(pose).length > 0 && poseDistance(pose, v.pose) < 13) return { gid: r.key, vid, name: v.name, garment: r.garment.name }; }
    return null;
  }, [resolved, pose]);
  function onFit(fit: Fit) {
    if (hp) {
      const h=fitHeight(fit,hp.h/hp.w),x=fit.cx-fit.w/2,y=fit.cy-h/2;
      const shown={x,y,w:fit.w,h,...(hp.bone==="own"?{pivot:[x+(hp.pivot? (hp.pivot[0]-hp.x)/hp.w:.5)*fit.w,y+(hp.pivot?(hp.pivot[1]-hp.y)/hp.h:0)*h] as [number,number]}:{})};
      const patch:Partial<HairPart>={...unadjustRect(shown,headFit),rotation:fit.rotation,mesh:fit.mesh};
      if(draft&&draftPart)setDraft({...draft,parts:draft.parts.map(p=>p.id===draftPart.id?{...p,...patch}:p)});else if(activeHair)patchHair(activeHair.id,patch);
    } else if (sel) applyFit(sel, fit);
  }
  function onPick(x: number, y: number) {
    if (draft) {
      const shownParts = draft.kind === "head" ? draft.parts.map((p) => ({ ...p, ...adjustHead({ file: p.file, x: p.x, y: p.y, w: p.w, h: p.h }, headFit) })) : adjustHair({ parts: draft.parts }, headFit)!.parts;
      const hit = [...shownParts].reverse().find((p) => { const [rx, ry] = applyMat(invert(mats[draft.kind === "head" ? "head" : hairBoneId(p)] ?? mats.root), x, y); return rx >= p.x && rx <= p.x + p.w && ry >= p.y && ry <= p.y + p.h; });
      setDraft({ ...draft, sel: hit?.id ?? null });
      return;
    }
    if(tab==="look"&&lookTab==="hair"&&shownHair){const hit=[...shownHair.parts].reverse().find(p=>{if(p.hidden)return false;const [rx,ry]=applyMat(invert(mats[hairBoneId(p)]??mats.root),x,y);return rx>=p.x&&rx<=p.x+p.w&&ry>=p.y&&ry<=p.y+p.h;});selectHair(hit?.id??null);return;}
    // 沿實際變形後的衣物判斷：點到真正有布料的位置才算（透明或已用遮罩隱藏的位置不會擋住下面的衣物）
    const hit = renderer.pick(scene, mats, x, y);
    setSelected(hit);
    if (hit) { setTool((t) => (t === "mask" ? "place" : t)); setPartTool((p) => ({ ...p, label: -1 })); }
  }
  // 一次拖動（衣物或關節）開始前記下狀態；第二根手指落下時完整還原，包括「未保存」標記及撤銷紀錄
  function onEditStart() { flushHist(); editBase.current = { snap: snapRef.current, dirty, draft, past: hist.current.past.length }; }
  function onEditCancel() {
    const b = editBase.current;
    editBase.current = null;
    if (!b) return;
    const h = hist.current;
    clearTimeout(h.timer); h.timer = 0;
    // 拖動期間（超過合併時間）已記下的步驟：這次操作已取消，所以一併移除，撤銷紀錄回到操作之前
    if (h.past.length > b.past) h.past.length = b.past;
    h.base = b.snap;
    const cancel = { to: b.snap, until: Date.now() + 600 };
    h.cancel = cancel;
    window.setTimeout(() => { if (h.cancel === cancel) h.cancel = null; }, 650);
    setWorn(b.snap.worn); setPoseState(b.snap.pose); setFront(b.snap.front); setLook(b.snap.look); setDirty(b.dirty);
    if (b.draft !== draft) setDraft(b.draft);
  }
  function switchTab(t: Tab) {
    setSelected(null); setHairSelected(null); setHairTool("place");
    if (t === "look" && viewKey === "full") { setViewKey("upper"); autoView.current = true; }
    else if (t !== "look" && autoView.current) { setViewKey("full"); autoView.current = false; }
    if (panel === "mini" && t !== tab) setPanel("mid");
    setTab(t);
  }
  /** 把某個袖子的標記清走（歸入衣身），之後可以重新塗 */
  function resetSleeve(r: Resolved, label: 1 | 2) {
    if (!selItem) return;
    const lab = renderer.geometry(selItem).labels;
    const c = document.createElement("canvas");
    c.width = lab.w; c.height = lab.h;
    const d = new ImageData(lab.w, lab.h);
    for (let i = 0; i < lab.w * lab.h; i++) { const v = lab.data[i]; d.data[i * 4] = (v === label || v > 2 ? 0 : v) * 50; d.data[i * 4 + 3] = 255; }
    c.getContext("2d")!.putImageData(d, 0, 0);
    flushHist();
    setItem(r.key, { parts: c.toDataURL("image/png") });
    setPartTool((p) => ({ ...p, label }));
  }

  // ───── 鏡頭 ─────
  const sourceOn = view === "source";
  const camera: Camera = useMemo(() => {
    if (sourceOn && sel) return srcCam ?? frame(flatRect(sel.analysis.content.ar), stageSize, 14);
    return viewKey && VIEW_PRESETS[viewKey] ? frame(VIEW_PRESETS[viewKey], stageSize) : cam;
  }, [sourceOn, sel?.analysis.content.ar, srcCam, viewKey, cam, stageSize]);
  const moveCamera = (c: Camera) => { if (sourceOn) setSrcCam(c); else { setCam(c); setViewKey(null); autoView.current = false; } };
  useEffect(() => { if (!sourceOn) setSrcCam(null); }, [sourceOn, selId]);
  useEffect(() => { setCompare(false); setPartTool((p) => (p.label < 0 ? p : { ...p, label: -1 })); }, [selId, tool]);
  /** 自動取景：對準目前正在編輯的衣物、素材部件或身體區域 */
  function frameTarget() {
    let rect: Rect | null = null;
    if (sourceOn && sel) { setSrcCam(null); return; }
    if (draftPart) rect = { x: draftPart.x - 40, y: draftPart.y - 40, w: draftPart.w + 80, h: draftPart.h + 80 };
    else if (sel && selItem) { const b = renderer.bounds(selItem, mats); if (Number.isFinite(b[0])) rect = { x: b[0] - 50, y: b[1] - 50, w: b[2] - b[0] + 100, h: b[3] - b[1] + 100 }; }
    else if (tab === "pose") {
      const ids = regionBones(rig, region), bm = boneMap(rig);
      const pts: [number, number][] = ids.map((id) => applyMat(mats[id] ?? mats.root, bm.get(id)!.pivot[0], bm.get(id)!.pivot[1]));
      for (const c of allControls) if (c.region === region) pts.push(applyMat(mats[c.follow] ?? mats.root, c.at[0], c.at[1]));
      if (pts.length) rect = boundsOf(pts, 150);
    }
    moveCamera(rect ? frame(rect, stageSize, 10) : FULL_CAMERA);
    if (!rect) setViewKey("full");
  }
  const zoomBy = (f: number) => moveCamera(zoomAt(camera, stageSize, f));

  // ───── 骨架控制點 ─────
  const allControls = useMemo(() => poseControls(rig, shownHair), [rig, shownHair]);
  const shownControls = useMemo(() => (skel === "clean" ? [] : controlsFor(allControls, dragMode, skel === "region" ? region : "all")), [allControls, skel, dragMode, region]);
  const skeletonStyle = useMemo(() => ({ opacity: skel === "wire" ? 1 : skelOpacity, bones: skel === "clean" ? null : new Set(skel === "region" ? regionBones(rig, region) : rig.bones.map((b) => b.id)) }), [skel, skelOpacity, region, rig]);
  const control = allControls.find((c) => c.id === controlId) ?? null;
  // 畫布上高亮的控制點：正在拖動的那一個；否則是目前用滑桿調整的關節所對應的控制點
  const activeControl = control && shownControls.includes(control) ? control.id : shownControls.find((c) => c.kind !== "ik" && c.bone === joint)?.id ?? null;
  const hints = useMemo(() => layeringHints(worn.filter((w) => !w.hidden).map((w) => w.slot)), [worn]);
  const wornIds = useMemo(() => new Set(worn.filter((w) => !w.piece).map((w) => w.garment_id)), [worn]);
  const wornKeys = useMemo(() => new Set(worn.map(itemKey)), [worn]);
  /** 衣服選單內的套裝部件（只列出圖片仍然有效的拆件設定） */
  const pieceEntries = useMemo(() => {
    const out: PieceEntry[] = [];
    if (!tpls) return out;
    for (const g of garments ?? []) { const t = templateFor(tpls, g); for (const piece of t?.data?.pieces ?? []) out.push({ g, piece }); }
    return out;
  }, [garments, tpls]);

  // ───── 底部面板高度：迷你／一般／展開，可以拖動把手 ─────
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const PANEL_H: Record<PanelSize, number> = { mini: draft || sel ? 96 : tab === "pose" ? 72 : 0, mid: Math.min(vh * (draft || sel ? 0.34 : 0.3), draft || sel ? 290 : 250), max: vh * 0.54 };
  const panelH = panelDrag ?? PANEL_H[panel];
  const grab = {
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => { e.currentTarget.setPointerCapture(e.pointerId); panelGrab.current = { y: e.clientY, h: panelBox.current?.getBoundingClientRect().height ?? panelH, moved: false }; },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => { const g = panelGrab.current; if (!g) return; const dy = g.y - e.clientY; if (!g.moved && Math.abs(dy) < 6) return; g.moved = true; setPanelDrag(Math.max(0, Math.min(vh * 0.62, g.h + dy))); },
    onPointerUp: () => {
      const g = panelGrab.current;
      panelGrab.current = null;
      if (!g) return;
      if (!g.moved) { setPanel(panel === "max" ? "mid" : panel === "mid" ? "max" : "mid"); return; }
      const h = panelDrag ?? g.h;
      setPanelDrag(null);
      setPanel((["mini", "mid", "max"] as PanelSize[]).reduce((best, k) => (Math.abs(PANEL_H[k] - h) < Math.abs(PANEL_H[best] - h) ? k : best), "mid" as PanelSize));
    },
    onPointerCancel: () => { panelGrab.current = null; setPanelDrag(null); },
  };

  if (!loaded || !tpls) return <div className="fixed inset-0 z-40 grid place-items-center bg-plum"><Spinner /></div>;
  const compact = panelDrag === null && panel === "mini";
  const float = "bg-ink/45 text-cream ring-1 ring-gold/40 backdrop-blur";
  const pct = Math.round(camera.z * 100);
  return (
    <div className="doll-room fixed inset-0 z-40 flex flex-col bg-plum" data-testid="dressing-room" data-dirty={dirty ? "1" : "0"} data-worn={worn.map((w) => itemKey(w) + (w.hidden ? ":hidden" : "")).join(",")} data-resolved={resolved.length} data-pose={JSON.stringify(pose)} data-front={front.join(",")} data-hair={look.hair} data-head={look.head} data-hair-color={look.hair_color} data-model={bodyModel.id} data-model-rev={bodyModel.revision} data-selected={selected ?? ""} data-masked={worn.filter((w) => w.mask).length} data-parts={worn.filter((w) => w.parts).length} data-undo={hist.current.past.length} data-preview={preview ? "1" : "0"} data-gview={view} data-wear={sel ? wearMode(sel.opts) : ""} data-panel={panel}
      data-fits={JSON.stringify(resolved.map((r) => [r.key, Math.round(r.fit.cx * 10) / 10, Math.round(r.fit.cy * 10) / 10, Math.round(r.fit.w * 10) / 10, Math.round(r.fit.rotation * 10) / 10]))}>
      {/* ───── 頂部 ───── */}
      <div className="safe-top shrink-0 bg-ink">
        {setup ? (
          <div className="flex h-12 items-center gap-1.5 px-2.5" data-testid="setup-header">
            <button type="button" aria-label="返回衣服設定列表" onClick={() => leave("/dressing/setup" + setupQs)} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconChevronLeft /></button>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-[10px] tracking-[0.12em] text-mauve" data-testid="setup-model">衣服設定{setupTarget?.piece ? "｜套裝部件" : ""}｜{modelLabel(bodyModel)}</div>
              <div className="truncate font-serif text-[14.5px] font-bold text-gold-soft" data-testid="setup-title">{setupTarget ? (setupTarget.piece ? setupTarget.piece.name + "・" : "") + displayName(setupTarget.garment as Garment) : "載入中…"}</div>
            </div>
            {dirty && <span className="shrink-0 text-[10.5px] text-wine">未保存</span>}
            <button type="button" aria-label="上一件" disabled={!neighbours.prev} onClick={() => neighbours.prev && leave(`/dressing/setup/${neighbours.prev}${setupQs}`)} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[16px] disabled:opacity-35"><IconChevronLeft /></button>
            <button type="button" aria-label="下一件" disabled={!neighbours.next} onClick={() => neighbours.next && leave(`/dressing/setup/${neighbours.next}${setupQs}`)} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[16px] disabled:opacity-35"><IconChevronRight /></button>
            <button type="button" data-testid="setup-save" disabled={busy || !setupTarget} onClick={() => void saveSetup()} className="btn-jewel flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] disabled:opacity-50"><IconSave className="text-[14px]" />{busy ? "…" : "保存設定"}</button>
          </div>
        ) : (
        <div className="flex h-12 items-center gap-1.5 px-2.5">
          <button type="button" aria-label="返回我的穿搭" onClick={() => leave("/outfits")} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconChevronLeft /></button>
          <input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder="未命名造型" aria-label="造型名稱" data-testid="look-name" className="h-9 min-w-0 flex-1 rounded-full border border-transparent bg-transparent px-2 font-serif text-[16px] font-bold tracking-[0.06em] text-gold-soft placeholder:text-mauve/70 focus:border-gold/50 focus:outline-none" />
          {dirty && <span className="shrink-0 text-[10.5px] text-wine">未保存</span>}
          <button type="button" aria-label={favorite ? "取消收藏" : "收藏"} aria-pressed={favorite} onClick={() => { setFavorite(!favorite); setDirty(true); }} className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[18px] ${favorite ? "text-[#f2a7c3]" : "text-mauve"}`}><IconHeart filled={favorite} /></button>
          <button type="button" data-testid="save-look" disabled={busy} onClick={() => void save()} className="btn-jewel flex h-9 shrink-0 items-center gap-1 rounded-full px-3.5 text-[13px] disabled:opacity-50"><IconSave className="text-[14px]" />{busy ? "…" : "保存"}</button>
          <button type="button" aria-label="更多" aria-expanded={menu} onClick={() => setMenu(!menu)} className="chip grid h-9 w-9 shrink-0 place-items-center rounded-full text-[17px]"><IconMore /></button>
        </div>
        )}
        {menu && !setup && (
          <div className="absolute right-2.5 z-50 mt-1 w-44 overflow-hidden rounded-2xl border border-gold/50 bg-velvet text-[13px] shadow-xl" role="menu">
            <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left" onClick={() => { setMenu(false); leave("/dressing"); }}>新造型</button>
            {id && <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left" onClick={() => { setMenu(false); void save(true); }}>另存為新造型</button>}
            <button type="button" role="menuitem" data-testid="export-png" className="block w-full px-4 py-2.5 text-left" onClick={() => void exportPng()}>匯出透明 PNG</button>
            {id && <button type="button" role="menuitem" className="block w-full px-4 py-2.5 text-left text-wine" onClick={() => { setMenu(false); void removeLook(); }}>刪除造型</button>}
          </div>
        )}
      </div>

      {/* ───── 舞台 ───── */}
      <div className="doll-stage relative min-h-0 flex-1" onClick={() => { if (menu) setMenu(false); }} onPointerDownCapture={(e) => { if (quick && !(e.target as HTMLElement).closest('[data-testid="quick-pop"],[data-testid="quick-toggle"]')) setQuick(false); }}>
        <Stage renderer={renderer} scene={scene} rig={rig} camera={camera} onCamera={moveCamera} onSize={setStageSize} mode={mode} hand={hand && !preview} selection={preview ? null : stageSel} onPick={sourceOn ? undefined : onPick} onFit={onFit}
          controls={shownControls} skeleton={skeletonStyle} activeControl={activeControl} dim={mode === "pose" && skel === "wire"}
          onPose={(p, c) => { setControlId(c.id); setJoint(c.kind === "ik" ? c.mid! : c.bone); if (c.region !== region) setRegion(c.region); if (p !== pose) setPose(p); }}
          onEditStart={onEditStart} onEditCancel={onEditCancel}
          onPaint={(x, y, phase, radius) => { if (hairMasking) paintHair(x, y, phase, radius); else if (sel) paint(sel, x, y, phase, radius); }} brush={hairMasking ? hairBrush.size : editing === "mask" ? maskTool.size : editing === "parts" ? partTool.size : undefined} onReadyChange={setReady}>
          {!preview && (
            <div data-stage-ui className="absolute left-2 top-2 flex flex-col gap-1" data-testid="view-presets">
              {Object.entries(VIEW_PRESETS).map(([k, v]) => <button key={k} type="button" data-view={k} aria-pressed={!sourceOn && viewKey === k} onClick={() => { if (sourceOn) setGview("worn"); setViewKey(k); autoView.current = false; }} className={`rounded-full px-2.5 py-1 text-[11px] ${!sourceOn && viewKey === k ? "chip-on" : float}`}>{v.label}</button>)}
            </div>
          )}
          {/* 右上：乾淨預覽（眼睛）及鏡頭控制。乾淨預覽時仍然保留，可以繼續放大及平移 */}
          <div data-stage-ui className="absolute right-2 top-2 flex flex-col items-center gap-1.5" data-testid="camera-bar">
            <button type="button" aria-label={preview ? "返回編輯" : "乾淨預覽"} data-testid="focus" aria-pressed={preview} onClick={() => { setPreview(!preview); setZoomOpen(false); }} className={`grid h-9 w-9 place-items-center rounded-full text-[17px] ${preview ? "chip-on" : float}`}>{preview ? <IconEyeOff /> : <IconEye />}</button>
            <button type="button" aria-label="放大畫面" data-testid="zoom-in" disabled={camera.z >= ZOOM.max - 0.001} onClick={() => zoomBy(1.4)} className={`grid h-8 w-8 place-items-center rounded-full text-[17px] leading-none disabled:opacity-40 ${float}`}>＋</button>
            <button type="button" aria-label="縮放比例及視角" aria-expanded={zoomOpen} data-testid="zoom-pct" onClick={() => setZoomOpen(!zoomOpen)} className={`h-6 min-w-10 rounded-full px-1 text-[10.5px] tabular-nums ${zoomOpen ? "chip-on" : float}`}>{pct}%</button>
            <button type="button" aria-label="縮小畫面" data-testid="zoom-out" disabled={camera.z <= ZOOM.min + 0.001} onClick={() => zoomBy(1 / 1.4)} className={`grid h-8 w-8 place-items-center rounded-full text-[17px] leading-none disabled:opacity-40 ${float}`}>－</button>
            {!preview && <button type="button" aria-label="畫面對準正在編輯的位置" data-testid="zoom-fit" onClick={frameTarget} className={`grid h-8 w-8 place-items-center rounded-full text-[15px] ${float}`}><IconTarget /></button>}
            {!preview && <button type="button" aria-label="手掌工具：單指移動畫面" data-testid="hand-tool" aria-pressed={hand} onClick={() => setHand(!hand)} className={`grid h-8 w-8 place-items-center rounded-full text-[15px] ${hand ? "chip-on" : float}`}><IconHand /></button>}
            {!preview && !draft && <button type="button" aria-label="快捷操作：還原姿勢及衣物跟隨" data-testid="quick-toggle" aria-expanded={quick} onClick={() => { setQuick(!quick); setZoomOpen(false); }} className={`grid h-8 w-8 place-items-center rounded-full text-[15px] ${quick ? "chip-on" : float}`}><IconSparkle /></button>}
          </div>
          {quick && !preview && !draft && (
            <div data-stage-ui data-testid="quick-pop" role="dialog" aria-label="快捷操作" className="absolute right-12 top-2 z-10 max-h-[calc(100%-1rem)] w-56 overflow-y-auto rounded-2xl border border-gold/50 bg-velvet/95 p-3 text-[12px] shadow-xl">
              <div className="flex items-center justify-between"><span className="text-gold-soft">快捷操作</span><button type="button" aria-label="關閉快捷操作" onClick={() => setQuick(false)} className="px-1 text-mauve">✕</button></div>
              <button type="button" data-quick="pose-reset" disabled={!Object.keys(pose).length && !front.length} onClick={quickResetPose} className="chip mt-2 h-9 w-full rounded-full px-3 disabled:opacity-40">還原姿勢（{bodyModel.name ?? "目前身體"}預設站姿）</button>
              <div className="mt-3 border-t border-gold/20 pt-2" data-testid="quick-item">
                {sel ? (
                  <>
                    <p className="truncate text-[11.5px]"><span className="text-mauve">目前衣物：</span>{sel.piece ? sel.piece.name : sel.garment.name}</p>
                    <p className="text-[10.5px] text-mauve" data-testid="quick-mode" data-mode={wearMode(sel.opts)}>跟隨：{({ fixed: "固定原圖", body: "跟隨身體", auto: "跟隨手臂" } as const)[wearMode(sel.opts)]}</p>
                    <div className="mt-1.5 grid grid-cols-3 gap-1">
                      {([["fixed", "固定原圖"], ["body", "跟隨身體"], ["auto", "跟隨手臂"]] as const).map(([m, label]) => (
                        <button key={m} type="button" data-quick-mode={m} aria-pressed={wearMode(sel.opts) === m} disabled={m === "auto" && !armCapable(sel)} onClick={() => quickMode(m)} className={`h-8 rounded-full px-1 text-[11px] disabled:opacity-35 ${wearMode(sel.opts) === m ? "chip-on" : "chip"}`}>{label}</button>
                      ))}
                    </div>
                    {!armCapable(sel) && <p className="mt-1 text-[10.5px] leading-snug text-mauve">這件衣物沒有袖子骨架，不適用「跟隨手臂」。</p>}
                  </>
                ) : <p className="text-[11px] leading-snug text-mauve" data-testid="quick-noselect">先在角色身上點選一件衣物，或使用下面的批量操作。</p>}
              </div>
              <details className="mt-2 border-t border-gold/20 pt-2" data-testid="quick-batch">
                <summary className="cursor-pointer text-[11.5px] text-gold-soft">批量操作（目前顯示的衣物）</summary>
                <div className="mt-1.5 flex flex-col gap-1">
                  <button type="button" data-quick-all="body" onClick={() => quickModeAll("body")} className="chip h-8 rounded-full px-3 text-left text-[11px]">全部跟隨身體（{quickTargets("body").length} 件）</button>
                  <button type="button" data-quick-all="auto" onClick={() => quickModeAll("auto")} className="chip h-8 rounded-full px-3 text-left text-[11px]">有袖衣物跟隨手臂（{quickTargets("auto").length} 件）</button>
                  <button type="button" data-quick-all="fixed" onClick={() => quickModeAll("fixed")} className="chip h-8 rounded-full px-3 text-left text-[11px]">全部固定原圖（{quickTargets("fixed").length} 件）</button>
                  <button type="button" data-quick-all="default" onClick={() => quickModeAll("default")} className="chip h-8 rounded-full px-3 text-left text-[11px]">還原各自預設跟隨模式</button>
                </div>
              </details>
              <p className="mt-2 text-[10.5px] leading-snug text-mauve">快捷操作只影響這個造型，可撤銷；位置、網格、遮罩及拆件保留。要更新衣物預設，請在衣物面板按「存為衣物預設」。</p>
            </div>
          )}
          {zoomOpen && (
            <div data-stage-ui data-testid="zoom-pop" className="absolute right-12 top-2 w-56 rounded-2xl border border-gold/50 bg-velvet/95 p-3 text-[12px] shadow-xl">
              <div className="flex items-center justify-between"><span className="text-gold-soft">畫面縮放</span><span className="tabular-nums">{pct}%</span></div>
              <input type="range" aria-label="畫面縮放" data-testid="zoom-slider" min={Math.log(ZOOM.min)} max={Math.log(ZOOM.max)} step={0.01} value={Math.log(camera.z)} onChange={(e) => moveCamera(zoomTo(camera, stageSize, Math.exp(Number(e.target.value))))} className="mt-1 w-full" />
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <button type="button" data-testid="zoom-reset" onClick={() => { if (sourceOn) setSrcCam(null); else { setViewKey("full"); setCam(FULL_CAMERA); } }} className="chip rounded-full px-3 py-1">恢復預設視角</button>
                <button type="button" onClick={frameTarget} className="chip rounded-full px-3 py-1">對準編輯位置</button>
              </div>
              <p className="mt-1.5 text-[10.5px] leading-snug text-mauve">雙指開合＝放大縮小，雙指拖動＝移動畫面。只改變觀看角度，不會改變衣物或造型。</p>
            </div>
          )}
          {!preview && (!ready || pending.size > 0) && <span data-stage-ui className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-ink/60 px-3 py-1 text-[11px] text-cream">載入中…</span>}
          {!preview && renderer.errors.size > 0 && <button data-stage-ui type="button" onClick={() => { renderer.retry(); setAnalyses((m) => new Map(m)); }} className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-[#a12c4b] px-3 py-1 text-[11px] text-white">有圖片未能讀取，按此重試</button>}
          {!preview && notice && <p data-stage-ui role="status" className="pointer-events-none absolute inset-x-14 top-2 rounded-2xl bg-ink/80 px-3 py-2 text-center text-[11px] leading-snug text-gold-soft">{notice}</p>}
          {!preview && (sourceOn || compareKind) && <span data-stage-ui data-testid="stage-badge" className={`pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full px-3 py-1 text-[11px] ${compareKind ? "bg-[#a12c4b]/85 text-white" : "bg-ink/70 text-gold-soft"}`}>{sourceOn ? "衣物原圖" : "穿著預覽"}{compareKind ? `｜對比：${COMPARE_LABEL[compareKind]}` : sourceOn ? "（塗抹位置＝原圖位置）" : ""}</span>}
          {!preview && (
            <div data-stage-ui className="absolute bottom-2 left-2 flex gap-1.5">
              <button type="button" aria-label="撤銷" data-testid="undo" disabled={!canUndo} onClick={() => timeTravel("undo")} className={`grid h-8 w-8 place-items-center rounded-full text-[15px] disabled:opacity-35 ${float}`}>↶</button>
              <button type="button" aria-label="重做" data-testid="redo" disabled={!canRedo} onClick={() => timeTravel("redo")} className={`grid h-8 w-8 place-items-center rounded-full text-[15px] disabled:opacity-35 ${float}`}>↷</button>
            </div>
          )}
          {!preview && posePrompt && !editing && (
            <div data-stage-ui data-testid="pose-prompt" className="absolute inset-x-2 bottom-12 mx-auto flex max-w-sm items-center gap-1.5 rounded-2xl bg-ink/80 px-3 py-2 text-[11.5px] text-gold-soft ring-1 ring-gold/50">
              <span className="min-w-0 flex-1 leading-snug">「{posePrompt.label}」有不同的預設姿勢，要套用嗎？</span>
              <button type="button" onClick={() => { setPose(posePrompt.pose, posePrompt.front); setPosePrompt(null); }} className="btn-jewel h-7 shrink-0 rounded-full px-3 text-[11.5px]">套用</button>
              <button type="button" onClick={() => setPosePrompt(null)} className="chip h-7 shrink-0 rounded-full px-2.5 text-[11.5px]">保持</button>
            </div>
          )}
          {!preview && poseFix && !editing && <button data-stage-ui type="button" data-testid="pose-fix" onClick={() => setItem(poseFix.gid, { variant: poseFix.vid, snapshot: false, fit: null, v1fit: null, opts: null, mask: null, parts: null })} className="absolute bottom-2 right-2 max-w-[62%] truncate rounded-full bg-ink/70 px-3 py-1.5 text-[11px] text-gold-soft ring-1 ring-gold/50">套用「{poseFix.name}」（{poseFix.garment}）</button>}
        </Stage>
      </div>

      {/* ───── 衣服設定：部件選擇及設定狀態 ───── */}
      {!preview && setup && setupTarget && (() => {
        const st = setupTarget.piece ? pieceSetup(setupTarget.piece) : tpls ? setupInfo(setupTarget.garment, tpls).items : null;
        const pcs = templateFor(tpls, setupTarget.garment)?.data?.pieces ?? [];
        const cycle = (k: SetupKey) => { const cur = (setupTarget.piece ? setupTarget.piece.status : setupTarget.template?.data?.status)?.[k] ?? null; void markSetup(setupTarget, k, cur === null ? "done" : cur === "done" ? "na" : null); };
        return (
          <div className="shrink-0 border-t border-gold/30 bg-ink/90 px-2.5 py-1.5" data-testid="setup-strip">
            <div className="scrollbar-none flex items-center gap-1.5 overflow-x-auto">
              {pcs.length > 0 && (
                <select aria-label="選擇要設定的部件" data-testid="setup-piece" value={setup.piece ?? ""} onChange={(e) => leave(`/dressing/setup/${setup.gid}${setupQs}${e.target.value ? (setupQs ? "&" : "?") + "piece=" + e.target.value : ""}`)} className="h-7 max-w-[9.5rem] shrink-0 rounded-full bg-white/10 px-2 text-[11.5px] text-cream ring-1 ring-gold/40">
                  <option value="">整件衣物</option>
                  {pcs.map((p) => <option key={p.id} value={p.id}>{p.name}{p.fit ? "" : "（未校正）"}</option>)}
                </select>
              )}
              {st && SETUP_KEYS.map((k) => <button key={k} type="button" data-mark={k} data-state={st[k]} disabled={busy} onClick={() => cycle(k)} title="輕按切換：自動判斷 → 已完成 → 不需要" className={`h-7 shrink-0 rounded-full px-2 text-[11px] ${st[k] === "done" ? "bg-[#6fbf8f]/30 text-[#d6f5e1]" : st[k] === "na" ? "bg-white/10 text-cream/60" : st[k] === "todo" ? "bg-[#a12c4b]/40 text-[#ffd3df]" : "bg-white/5 text-mauve"}`}>{SETUP_LABEL[k]}：{ITEM_LABEL[st[k]].replace("（可選）", "")}</button>)}
            </div>
          </div>
        );
      })()}

      {/* ───── 底部面板 ───── */}
      {!preview && (
        <div className="doll-panel relative shrink-0 border-t border-gold/40 bg-velvet" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
          <button type="button" aria-label="拖動調整面板高度；輕按切換一般及展開" data-testid="panel-size" {...grab} className="absolute -top-3.5 left-1/2 z-10 grid h-7 w-20 -translate-x-1/2 touch-none place-items-center">
            <span className="grid h-5 w-14 place-items-center rounded-full border border-gold/50 bg-velvet"><span className="h-1 w-7 rounded-full bg-gold-soft/80" /></span>
          </button>
          {!draft && !(compact && sel) && (
            <div className="grid grid-cols-4 gap-1.5 px-2.5 pt-2.5" role="tablist">
              {TABS.map((t) => {
                const on = tab === t.id && !sel;
                return (
                  <button key={t.id} type="button" role="tab" data-tab={t.id} aria-selected={on} onClick={() => switchTab(t.id)} className={`flex flex-col items-center justify-center gap-0.5 rounded-2xl text-[11.5px] ${compact ? "h-9 flex-row gap-1.5" : "h-12"} ${on ? "chip-on" : "bg-white/5 text-cream/85"}`}>
                    <span className={`relative ${compact ? "text-[15px]" : "text-[18px]"}`}><t.Icon />{t.id === "layers" && worn.length > 0 && <span className="absolute -right-3 -top-1 rounded-full bg-gold px-1 text-[9px] font-bold leading-[14px] text-ink">{worn.length}</span>}</span>
                    {t.label}
                  </button>
                );
              })}
            </div>
          )}
          <div ref={panelBox} className={`relative overflow-clip px-3 ${panelH > 0 ? "pt-2.5" : ""}`} style={{ height: panelH, minHeight: panelH > 0 ? undefined : 8 }} data-testid="doll-panel" data-size={panel}>
            {panelH < 40 ? null : draft ? <AssetPanel draft={draft} setDraft={setDraft} busy={busy} onFiles={(f) => void addAssetFiles(f)} onSave={() => void saveAsset()} onCancel={() => void cancelAsset()} onDelete={() => void deleteAsset()} hairTool={hairTool === "mask" ? "place" : hairTool} setHairTool={setHairTool} />
              : sel ? (
                <FitPanel behind={behindStats} onBind={(on) => setBind(sel, on)} onApplyBind={() => { if (sel.opts.bind) setPose(sel.opts.bind); }} r={sel} info={selItem ? renderer.info(selItem) : null} tool={tool} setTool={setTool} busy={busy} onFit={(f) => nudge(sel, f)} onMeshReset={() => applyFit(sel, { ...sel.fit, mesh: undefined })} onOpts={(o) => setOpts(sel, o)}
                  onMode={(m) => setMode(sel, m)} onWhole={() => wholeImage(sel)} compact={compact}
                  pieces={sel.piece ? null : sel.template?.data?.pieces ?? []} wornPieces={new Set(worn.filter((w) => w.garment_id === sel.garment.id && w.piece).map((w) => w.piece!))}
                  onOpenSplit={() => setSplit(sel.key)} onWearPieces={(ids, replace) => wearPieces(sel, ids, replace)} onTogglePiece={(pid) => { const k = sel.garment.id + "#" + pid; if (worn.some((w) => itemKey(w) === k)) remove(k); else wearPieces(sel, [pid], false); }} view={gview} setView={setGview} compare={compare} setCompare={setCompare} onFrame={frameTarget}
                  part={partTool} setPart={setPartTool} hint={hint} setHint={setHint} onParts={(v) => setItem(sel.key, { parts: v })} onResetSleeve={(l) => resetSleeve(sel, l)}
                  onSleeveAuto={() => { if (!selItem) return; const [a, b] = suggestSleeveRot(renderer.geometry({ ...selItem, opts: { ...selItem.opts, sleeve_r: 0, sleeve_l: 0 } }), sel.fit, sel.analysis.content.ar, bodyModel.rig); setOpts(sel, { sleeve_r: Math.max(-SLEEVE_ROT_LIMIT, Math.min(SLEEVE_ROT_LIMIT, a)), sleeve_l: Math.max(-SLEEVE_ROT_LIMIT, Math.min(SLEEVE_ROT_LIMIT, b)) }); }}
                  onPoseFix={() => void addVariant(sel, undefined, true)}
                  onAuto={() => applyFit(sel, defaultFit(sel.worn.slot, sel.analysis.content, sel.garment.category, sel.garment.subcategory, sel.garment.name, bodyModel.rig))}
                  onRestore={() => setItem(sel.key, { snapshot:false, fit: null, v1fit: null, opts: null, mask: null, parts: null })} onSaveDefault={() => void saveDefault(sel)} onRemove={() => remove(sel.key)} onDone={() => setSelected(null)}
                  onOrder={(to) => order(sel.key, to)} onVariant={(v) => setItem(sel.key, { variant: v, snapshot:false, fit: null, v1fit: null, opts: null, mask: null, parts: null })}
                  onAddVariant={(img) => (img ? variantFile.current?.click() : void addVariant(sel))} onDeleteVariant={(v) => void deleteVariant(sel, v)}
                  onSavePose={() => void saveTemplate(sel, (d) => ({ data: { ...d, pose: clampPose(rig, pose), front }, fit: baseRowFit(sel) }), "已把目前姿勢設為這件衣物的建議姿勢", { fit: sel.worn.fit, opts: sel.worn.opts, mask: sel.worn.mask, parts: sel.worn.parts ?? null })}
                  onApplyPose={() => { const d = sel.template?.data; if (d?.pose) setPose(d.pose, d.front); }}
                  mask={maskTool} setMask={setMaskTool} onClearMask={() => clearMask(sel)} />
              ) : tab === "clothes" ? <ClothesPanel garments={garments} wornIds={wornIds} wornKeys={wornKeys} pending={pending} onToggle={toggle} pieces={pieceEntries} onPiece={togglePiece} />
              : tab === "layers" ? <LayersPanel items={resolved} selected={selected} onSelect={(g) => { setSelected(g); setTool("place"); }} onReorder={(ids) => change((cur) => { const next = ids.map((i) => cur.find((w) => itemKey(w) === i)!).filter(Boolean); return next.length === cur.length ? next : cur; })} onHide={(g) => setItem(g, { hidden: !worn.find((w) => itemKey(w) === g)?.hidden })} onRemove={remove} onClear={() => { if (confirm("脫下全部衣物？")) { change(() => []); setSelected(null); } }} hints={hints}
                  onHideGroup={(gid, hide) => change((cur) => cur.map((w) => (w.garment_id === gid && w.piece ? { ...w, hidden: hide } : w)))} onRemoveGroup={(gid) => { change((cur) => cur.filter((w) => !(w.garment_id === gid && w.piece))); if (selected?.startsWith(gid + "#")) setSelected(null); }} />
              : tab === "look" ? <AppearancePanel tab={lookTab} setTab={t=>{setLookTab(t);selectHair(null);}} value={look} onChange={v => editLook(v.head !== look.head ? {...v, head_config: null} : v)} assets={assets} onNew={(k, c) => void newAsset(k, c)} onEdit={editAsset} hair={hair} selectedHair={hairSelected} onSelectHair={selectHair} hairTool={hairTool} setHairTool={setHairTool} onHairPatch={patchHair} onSaveHair={()=>void saveHairCombo()} busy={busy} onSaveHairDefault={(i) => void saveHairDefault(i)} onAutoPlace={autoPlaceHair} hairBrush={hairBrush} setHairBrush={setHairBrush}
                  body={setup ? null : { models, current: bodyModel, onPick: (mid) => void switchModel(mid), onLatest: () => void switchModel(bodyModel.id, models.find((x) => x.id === bodyModel.id)?.revision), onManage: () => leave("/dressing/assets") }} />
              : <PosePanel rig={rig} pose={pose} front={front} onPose={setPose} onFront={(f) => { setFront(f); setDirty(true); }} skel={skel} setSkel={(m) => { setSkel(m); setControlId(null); }} drag={dragMode} setDrag={(d) => { setDragMode(d); setControlId(null); }}
                  region={region} setRegion={(r) => { setRegion(r); setControlId(null); }} joint={joint} setJoint={(j) => { setJoint(j); setControlId(null); }} control={control} opacity={skelOpacity} setOpacity={setSkelOpacity} compact={compact} tab={poseTab} setTab={setPoseTab} onFrame={frameTarget}
                  library={<PoseLibrary model={bodyModel} rig={rig} pose={pose} front={front} onApply={applyLibraryPose} renderer={renderer} scene={scene} />} />}
          </div>
          {splitR && splitR.garment.transparent_image_id && <SplitEditor name={splitR.garment.name} imageRef={"img:" + splitR.garment.transparent_image_id} pieces={splitR.template?.data?.pieces ?? []} busy={busy} onClose={() => setSplit(null)} onSave={(p) => saveSplit(splitR, p)} onUpload={(f, label) => uploadPieceFile(splitR, f, label)} />}
          <input ref={variantFile} type="file" accept="image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f && sel) void addVariant(sel, f); }} />
        </div>
      )}
    </div>
  );
}
