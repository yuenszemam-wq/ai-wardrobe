import { PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AVATARS, BASE_V1, Content, DOLL_H, DOLL_W, Fit, FIT_LIMIT, HEAD_Z, SLOT_LABEL, SLOT_Z, Slot, defaultFit, drawOrder, hitTest, isSlot, normalizeFit, sameFit, slotFor, wear } from "../../shared/doll";
import { api, displayName, Garment } from "../api";
import { IconChevronLeft, IconPlus, IconSave, IconTrash } from "../components/icons";
import { Chips, GarmentTile, inputCls, Link, Spinner, toast } from "../components/ui";
import { DollImage } from "../doll/DollImage";
import { measureContent } from "../doll/content";
import { navigate } from "../router";
import { Sheet } from "../components/ui";
import { AvatarLook, AvatarPoseEditor } from "../doll/AvatarPoseEditor";
import { AvatarRigRenderer } from "../doll/AvatarRigRenderer";
import { AVATAR_V2_ID, ATTACH_BONE, DEFAULT_HAIR_STYLE, DEFAULT_HAIR_COLOR, HAIR_STYLES, RIG_V2, normalizeColorValue, singleImagePoseIssues } from "../../shared/avatarV2";
import { applyMat, matAngle, normalizePose, solve } from "../../shared/avatarRig";

type From = "default" | "template" | "override";
interface WornItem {
  garment_id: string;
  name: string;
  category: string | null;
  subcategory: string | null;
  slot: Slot;
  image_id: string | null;
  /** 衣物在圖片內實際佔的範圍（用於預設位置、點選及選取框） */
  content: Content;
  fit: Fit;
  /** 未調整時的位置（模板或分類預設），用作「還原」及判斷是否個別修改 */
  base: Fit;
  from: From;
}
interface Template { garment_id: string; image_id: string | null; fit: Fit; slot: string | null; version: number }
interface LookSummary { id: string; name: string; item_count: number }
interface LookDetail {
  id: string; name: string; avatar_id?: string; hair_style?: string | null; hair_color?: string | null; accent_color?: string | null; pose?: unknown;
  items: { garment_id: string; slot: string; name: string; category: string | null; subcategory: string | null; image_id: string | null; override: Fit | null }[];
}

type Gesture =
  | { kind: "move"; id: string; sx: number; sy: number; fit: Fit }
  | { kind: "pinch"; id: string; d0: number; a0: number; fit: Fit }
  | { kind: "resize"; id: string; d0: number; fit: Fit }
  | { kind: "rotate"; id: string; a0: number; fit: Fit };

const DEFAULT_APPEARANCE: AvatarLook = { hair_style: DEFAULT_HAIR_STYLE, hair_color: DEFAULT_HAIR_COLOR, accent_color: null, pose: {} };
function appearanceOf(look: LookDetail): AvatarLook {
  return { hair_style: look.hair_style && Object.prototype.hasOwnProperty.call(HAIR_STYLES, look.hair_style) ? look.hair_style : DEFAULT_HAIR_STYLE,
    hair_color: normalizeColorValue(look.hair_color) ?? DEFAULT_HAIR_COLOR,
    accent_color: look.accent_color === "original" ? "original" : normalizeColorValue(look.accent_color),
    pose: normalizePose(RIG_V2, look.pose) ?? {} };
}
function matchingTemplate(map: Map<string, Template> | null, id: string, imageId: string | null) {
  const t = map?.get(id);
  return t && t.image_id === imageId ? t : undefined;
}
async function templatesFor(avatarId: string) {
  const r = await api<{ templates: Template[] }>(`/api/doll/templates?avatar=${avatarId}`);
  return new Map(r.templates.map((t) => [t.garment_id, t]));
}
const FROM_LABEL: Record<From, string> = { default: "分類預設位置", template: "已儲存的穿著位置", override: "只用於這個造型" };
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export default function DressingRoom({ id }: { id?: string }) {
  const [avatarId, setAvatarId] = useState(BASE_V1.id);
  const avatar = AVATARS[avatarId] ?? BASE_V1;
  const [appearance, setAppearance] = useState<AvatarLook>(DEFAULT_APPEARANCE);
  const [avatarPanel, setAvatarPanel] = useState(false);
  const [fitPanel, setFitPanel] = useState(false);
  const [skeleton, setSkeleton] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [garments, setGarments] = useState<Garment[] | null>(null);
  const [templates, setTemplates] = useState<Map<string, Template> | null>(null);
  const [looks, setLooks] = useState<LookSummary[]>([]);
  const [worn, setWorn] = useState<WornItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [cat, setCat] = useState("");
  const [loaded, setLoaded] = useState(!id);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [k, setK] = useState(0); // 螢幕像素 ÷ 邏輯像素

  const generation = useRef(0);
  const pending = useRef(new Map<string, number>());
  const serial = useRef(0);
  const wearQueue = useRef<Promise<void>>(Promise.resolve());
  const canvas = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const wornRef = useRef(worn);
  wornRef.current = worn;

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => setK(el.getBoundingClientRect().width / DOLL_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loaded]);

  useEffect(() => {
    api<{ garments: Garment[] }>("/api/garments?limit=200&status=active&transparent=1").then((r) => setGarments(r.garments)).catch((e) => toast((e as Error).message, "err"));

  }, []);
  useEffect(() => {
    api<{ looks: LookSummary[] }>("/api/doll/looks").then((r) => setLooks(r.looks)).catch(() => undefined);
  }, [id]);

  // 先讀造型的角色，再讀該角色的模板；避免 V1／V2 混用。
  useEffect(() => {
    const ticket = ++generation.current;
    pending.current.clear();
    setSelected(null); setDirty(false); setLoaded(false); setTemplates(null); setSwitching(false);
    setAvatarPanel(false); setFitPanel(false); setSkeleton(false);
    void (async () => {
      const look = id ? await api<LookDetail>(`/api/doll/looks/${id}`) : null;
      const next = AVATARS[look?.avatar_id || BASE_V1.id] ?? BASE_V1;
      const map = await templatesFor(next.id);
      const items: WornItem[] = [];
      for (const it of look?.items ?? []) {
        const t = matchingTemplate(map, it.garment_id, it.image_id);
        const slot = isSlot(it.slot) ? it.slot : slotFor(it.category, it.subcategory);
        const content = await measureContent(it.image_id);
        const base = t?.fit ?? defaultFit(slot, content, it.category, next, it.subcategory, it.name);
        items.push({ garment_id: it.garment_id, name: it.name, category: it.category, subcategory: it.subcategory, slot, image_id: it.image_id, content, base, fit: it.override ?? base, from: it.override ? "override" : t ? "template" : "default" });
      }
      if (generation.current !== ticket) return;
      setAvatarId(next.id); setTemplates(map); setAppearance(look ? appearanceOf(look) : DEFAULT_APPEARANCE);
      setName(look?.name ?? ""); setWorn(items); setLoaded(true);
    })().catch((e) => { if (generation.current === ticket) { toast((e as Error).message, "err"); if (id) navigate("/dressing", true); else { setTemplates(new Map()); setWorn([]); setLoaded(true); } } });
    return () => { generation.current++; pending.current.clear(); };
  }, [id]);

  async function switchAvatar(nextId: string) {
    if (nextId === avatarId || switching || busy) return;
    setFitPanel(false);
    if (wornRef.current.some((w) => w.from === "override") && !confirm("切換角色會重新計算這個造型的衣物位置，原有角色的穿著模板不會被修改。繼續？")) return;
    const ticket = ++generation.current;
    pending.current.clear(); setSwitching(true); setSelected(null); gesture.current = null; pointers.current.clear();
    try {
      const next = AVATARS[nextId];
      const map = await templatesFor(nextId);
      if (generation.current !== ticket) return;
      setWorn((cur) => cur.map((w) => {
        const t = matchingTemplate(map, w.garment_id, w.image_id);
        const slot = isSlot(t?.slot) ? t.slot : slotFor(w.category, w.subcategory);
        const base = t?.fit ?? defaultFit(slot, w.content, w.category, next, w.subcategory, w.name);
        return { ...w, slot, base, fit: base, from: t ? "template" : "default" };
      }));
      setTemplates(map); setAvatarId(nextId); setDirty(true);
    } catch (e) { if (generation.current === ticket) toast((e as Error).message, "err"); }
    finally { if (generation.current === ticket) setSwitching(false); }
  }

  const cats = useMemo(() => [...new Set((garments || []).map((g) => g.category || "").filter(Boolean))], [garments]);
  const visible = useMemo(() => (garments || []).filter((g) => !cat || g.category === cat), [garments, cat]);
  const ordered = useMemo(() => drawOrder(worn), [worn]);
  const sel = worn.find((w) => w.garment_id === selected) ?? null;
  const isV2 = avatarId === AVATAR_V2_ID;
  const mats = useMemo(() => solve(RIG_V2, appearance.pose), [appearance.pose]);
  function poseFit(w: WornItem, fit = w.fit, inverse = false): Fit {
    if (!isV2) return fit;
    const m = mats[ATTACH_BONE[w.slot] ?? "root"];
    if (!m) return fit;
    const [x, y] = inverse
      ? [m[0] * (fit.cx - m[4]) + m[1] * (fit.cy - m[5]), m[2] * (fit.cx - m[4]) + m[3] * (fit.cy - m[5])]
      : applyMat(m, fit.cx, fit.cy);
    return { ...fit, cx: x, cy: y, rotation: fit.rotation + (inverse ? -1 : 1) * matAngle(m) };
  }
  const poseWarnings = isV2 ? worn.filter((w) => singleImagePoseIssues(w.slot, appearance.pose).length > 0) : [];


  function change(fn: (cur: WornItem[]) => WornItem[]) {
    setWorn(fn);
    setDirty(true);
  }
  function setFit(gid: string, fit: Fit) {
    const ok = normalizeFit(fit);
    if (!ok) return;
    change((cur) => cur.map((w) => (w.garment_id === gid ? { ...w, fit: ok, from: sameFit(ok, w.base) ? (matchingTemplate(templates, gid, w.image_id) ? "template" : "default") : "override" } : w)));
  }
  const fitOf = (gid: string) => poseFit(wornRef.current.find((w) => w.garment_id === gid)!);
  function setPosedFit(gid: string, fit: Fit) {
    const w = wornRef.current.find((x) => x.garment_id === gid);
    if (w) setFit(gid, poseFit(w, fit, true));
  }

  /** 一鍵穿著／脫下 */
  async function toggle(g: Garment) {
    if (switching || busy || !templates) return;
    if (pending.current.has(g.id)) { pending.current.delete(g.id); return; }
    if (wornRef.current.some((w) => w.garment_id === g.id)) {
      change((cur) => cur.filter((w) => w.garment_id !== g.id));
      if (selected === g.id) setSelected(null);
      return;
    }
    const ticket = generation.current, token = ++serial.current;
    pending.current.set(g.id, token);
    const imageId = g.transparent_image_id || null;
    const t = matchingTemplate(templates, g.id, imageId);
    const slot = isSlot(t?.slot) ? t.slot : slotFor(g.category, g.subcategory);
    const measurement = measureContent(imageId);
    // Decode in parallel, apply in tap order. Cancelling a tap must not re-equip it later.
    wearQueue.current = wearQueue.current.catch(() => undefined).then(async () => {
      const content = await measurement;
      if (generation.current !== ticket || pending.current.get(g.id) !== token) return;
      pending.current.delete(g.id);
      if (templates.get(g.id) && !t) toast("衣物圖片已更新，請重新校正穿著位置");
      if (content.approximate) toast("高清圖未能讀取；暫用縮圖位置，請稍後重試");
      const base = t?.fit ?? defaultFit(slot, content, g.category, avatar, g.subcategory, g.name);
      const item: WornItem = { garment_id: g.id, name: displayName(g), category: g.category, subcategory: g.subcategory, slot, image_id: imageId, content, base, fit: base, from: t ? "template" : "default" };
      change((cur) => wear(cur, item));
    });
    await wearQueue.current;
  }

  // ───── 手勢（只對已選取的衣物生效）：單指拖動、雙指縮放＋旋轉、把手縮放／旋轉 ─────
  const centerOf = (fit: Fit) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: r.left + fit.cx * k, y: r.top + fit.cy * k };
  };
  function startPinch(gid: string) {
    const [a, b] = [...pointers.current.values()];
    gesture.current = { kind: "pinch", id: gid, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, a0: Math.atan2(b.y - a.y, b.x - a.x), fit: fitOf(gid) };
  }
  /** 這一點最上面的衣物（只計實際內容，透明留白不算） */
  function pickAt(clientX: number, clientY: number): string | null {
    const r = canvas.current!.getBoundingClientRect();
    const x = (clientX - r.left) / k, y = (clientY - r.top) / k;
    const top = [...drawOrder(wornRef.current)].reverse().find((w) => hitTest(poseFit(w), w.content, x, y));
    return top ? top.garment_id : null;
  }
  function onItemDown(e: ReactPointerEvent<HTMLDivElement>, gid: string) {
    e.stopPropagation();
    // 按在已選衣物的透明留白上、而下面有另一件衣物：改為選取那一件
    if (!pointers.current.size) {
      const hit = pickAt(e.clientX, e.clientY);
      if (hit && hit !== gid) {
        setSelected(hit);
        return;
      }
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size >= 2) startPinch(gid);
    else gesture.current = { kind: "move", id: gid, sx: e.clientX, sy: e.clientY, fit: fitOf(gid) };
  }
  function onHandleDown(e: ReactPointerEvent<HTMLDivElement>, gid: string, kind: "resize" | "rotate") {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const fit = fitOf(gid), c = centerOf(fit);
    gesture.current = kind === "resize" ? { kind, id: gid, d0: Math.hypot(e.clientX - c.x, e.clientY - c.y) || 1, fit } : { kind, id: gid, a0: Math.atan2(e.clientY - c.y, e.clientX - c.x), fit };
  }
  function onCanvasDown(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (g && pointers.current.size === 1) {
      // 第二隻手指落在衣物旁邊，同樣當作雙指手勢
      e.currentTarget.setPointerCapture(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      startPinch(g.id);
    } else if (!g && k) setSelected(pickAt(e.clientX, e.clientY));
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g || !k) return;
    const f = g.fit;
    if (g.kind === "move") {
      setPosedFit(g.id, { ...f, cx: clamp(f.cx + (e.clientX - g.sx) / k, -200, DOLL_W + 200), cy: clamp(f.cy + (e.clientY - g.sy) / k, -200, DOLL_H + 200) });
    } else if (g.kind === "pinch") {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const a = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
      setPosedFit(g.id, { ...f, w: clamp((f.w * d) / g.d0, FIT_LIMIT.minW, FIT_LIMIT.maxW), rotation: f.rotation + ((a - g.a0) * 180) / Math.PI });
    } else {
      const c = centerOf(f);
      if (g.kind === "resize") setPosedFit(g.id, { ...f, w: clamp((f.w * Math.hypot(e.clientX - c.x, e.clientY - c.y)) / g.d0, FIT_LIMIT.minW, FIT_LIMIT.maxW) });
      else setPosedFit(g.id, { ...f, rotation: f.rotation + ((Math.atan2(e.clientY - c.y, e.clientX - c.x) - g.a0) * 180) / Math.PI });
    }
  }
  function onUp(e: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    const rest = [...pointers.current.values()];
    if (g.kind === "pinch" && rest.length === 1) gesture.current = { kind: "move", id: g.id, sx: rest[0].x, sy: rest[0].y, fit: fitOf(g.id) };
    else if (!rest.length) gesture.current = null;
  }
  const stop = (fn: (e: ReactPointerEvent<HTMLDivElement>) => void) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    fn(e);
  };

  // ───── 穿著模板 ─────
  async function saveTemplate(w: WornItem) {
    if (w.content.approximate) return toast("請先重新穿上衣物，等高清圖讀取成功後再校正", "err");
    setBusy(true);
    try {
      const t = await api<Template>(`/api/doll/templates/${w.garment_id}`, { method: "PUT", json: { avatar_id: avatar.id, fit: w.fit, slot: w.slot, image_id: w.image_id } });
      setTemplates((cur) => new Map(cur).set(w.garment_id, t));
      setWorn((cur) => cur.map((x) => (x.garment_id === w.garment_id ? { ...x, base: t.fit, fit: t.fit, from: "template" } : x)));
      toast("已儲存這件衣物的穿著位置，下次會自動套用");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (switching || pending.current.size) return toast("衣物仍在載入，請稍後再保存", "err");
    if (!worn.length && !id) return toast("請先替角色穿上衣物", "err");
    setBusy(true);
    const body = {
      name: name.trim() || "新造型",
      avatar_id: avatar.id,
      ...(isV2 ? appearance : {}),
      items: worn.map((w) => ({ garment_id: w.garment_id, slot: w.slot, override: w.from === "override" ? w.fit : null })),
    };
    try {
      const res = await api<{ id: string }>(id ? `/api/doll/looks/${id}` : "/api/doll/looks", { method: id ? "PATCH" : "POST", json: body });
      toast("已保存造型");
      setDirty(false);
      if (!id) navigate(`/dressing/${res.id}`, true);
      else api<{ looks: LookSummary[] }>("/api/doll/looks").then((r) => setLooks(r.looks)).catch(() => undefined);
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!id || !confirm("確定刪除這個造型？衣物及穿著位置不會被刪除。")) return;
    await api(`/api/doll/looks/${id}`, { method: "DELETE" });
    toast("已刪除");
    navigate("/dressing", true);
  }

  if (!loaded) return <Spinner />;
  return (
    <div>
      <div className="flex items-center justify-between gap-2 pt-5">
        <Link to="/outfits" className="btn-dark flex items-center gap-1 rounded-full py-1.5 pl-2 pr-3.5 text-[13px]">
          <IconChevronLeft className="text-[15px]" />
          我的穿搭
        </Link>
        <h1 className="min-w-0 truncate text-center font-serif text-[17px] font-bold tracking-[0.12em] text-gold-soft">
          角色換裝{dirty && <span className="ml-1.5 align-middle font-sans text-[11px] font-normal tracking-normal text-wine">未保存</span>}
        </h1>
        <Link to="/dressing" className="btn-dark flex items-center gap-1 rounded-full py-1.5 pl-3.5 pr-3 text-[13px]">
          新造型
          <IconPlus className="text-[13px]" />
        </Link>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
        <button type="button" disabled={switching || busy} onClick={() => void switchAvatar(BASE_V1.id)} className={`rounded-full px-3 py-1.5 ${!isV2 ? "chip-on" : "chip"}`}>Avatar V1</button>
        <button type="button" disabled={switching || busy} onClick={() => void switchAvatar(AVATAR_V2_ID)} className={`rounded-full px-3 py-1.5 ${isV2 ? "chip-on" : "chip"}`}>Avatar V2</button>
        {isV2 && <button type="button" onClick={() => setAvatarPanel(true)} className="btn-jewel rounded-full px-3 py-1.5">角色設定</button>}
        <Link to="/dressing/avatar-lab" className="chip rounded-full px-3 py-1.5">骨架測試</Link>
      </div>
      {switching && <p className="text-center text-[11px] text-mauve">正在切換角色及衣物位置…</p>}
      {poseWarnings.length > 0 && <p role="status" className="mt-1 text-[11px] text-gold-soft">目前姿勢未完全支援：{poseWarnings.map((w) => w.name).join("、")}。單圖衣物不會彎曲，可重設姿勢。</p>}
      <div className="mt-1.5">
        <Chips options={cats} value={cat} onChange={(v) => { setCat(v); setSelected(null); }} />
      </div>

      {/* ───── 左：角色畫布｜右：揀選衣物（校正時換成工具），兩者同時在畫面內 ───── */}
      <div className="mt-1 flex justify-center gap-2">
        {/* ───── 畫布：邏輯尺寸 1200×1800 ───── */}
        <div className="frame min-w-0 shrink-0 self-start p-1.5" style={{ width: "min(calc(100% - 86px), calc((100dvh - 344px) * 2 / 3 + 12px))", minWidth: 190 }}>
          <div
            ref={canvas}
            data-testid="doll-canvas"
            className="relative overflow-hidden rounded-[12px] select-none"
            style={{ aspectRatio: `${DOLL_W} / ${DOLL_H}`, background: "linear-gradient(#f7f0f6, #eadff0)", touchAction: selected ? "none" : "manipulation" }}
            onPointerDown={onCanvasDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            {isV2 ? <AvatarRigRenderer rig={RIG_V2} pose={appearance.pose} scale={k} hairStyle={appearance.hair_style} hairColor={appearance.hair_color} accentColor={appearance.accent_color} showSkeleton={skeleton} zFront={HEAD_Z} /> : avatar.layers.map((l, i) => (
              <img key={l.src} src={l.src} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full select-none" style={{ zIndex: l.place === "over" ? HEAD_Z : i + 1 }} />
            ))}
            {k > 0 &&
              ordered.map((w, i) => {
                const isSel = w.garment_id === selected;
                const shown = poseFit(w);
                return (
                  <div
                    key={w.garment_id}
                    data-testid={`worn-${w.garment_id}`}
                    data-slot={w.slot}
                    className="absolute"
                    style={{ left: shown.cx * k, top: shown.cy * k, width: shown.w * k, transform: `translate(-50%, -50%) rotate(${shown.rotation}deg)`, zIndex: SLOT_Z[w.slot] + i, pointerEvents: isSel ? "auto" : "none", touchAction: "none", cursor: "move" }}
                    onPointerDown={(e) => onItemDown(e, w.garment_id)}
                    onPointerMove={stop(onMove)}
                    onPointerUp={stop(onUp)}
                    onPointerCancel={stop(onUp)}
                  >
                    <DollImage imageId={w.image_id} alt={w.name} canonical={!w.content.approximate} />
                    {isSel && (
                      <div data-testid="fit-frame" className="pointer-events-none absolute outline-2 outline-dashed outline-amethyst" style={{ left: `${w.content.x0 * 100}%`, top: `${w.content.y0 * 100}%`, width: `${(w.content.x1 - w.content.x0) * 100}%`, height: `${(w.content.y1 - w.content.y0) * 100}%` }}>
                        <Handle label="拖拉旋轉" className="-top-4 left-1/2 -translate-x-1/2" cursor="grab" onDown={(e) => onHandleDown(e, w.garment_id, "rotate")} onMove={stop(onMove)} onUp={stop(onUp)}>⟳</Handle>
                        <Handle label="拖拉縮放" className="-bottom-3 -right-3" cursor="nwse-resize" onDown={(e) => onHandleDown(e, w.garment_id, "resize")} onMove={stop(onMove)} onUp={stop(onUp)}>⤡</Handle>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>

        <div className="frame relative w-[78px] shrink-0" style={{ borderRadius: 12 }}>
          <div className="scrollbar-none absolute inset-0 overflow-y-auto overscroll-contain p-1.5">
            {sel ? (
              <div className="flex flex-col gap-1.5 text-[13px]" data-testid="fit-tools">
                <Tool label="放大" onClick={() => setFit(sel.garment_id, { ...sel.fit, w: sel.fit.w * 1.04 })}>＋</Tool>
                <Tool label="縮小" onClick={() => setFit(sel.garment_id, { ...sel.fit, w: sel.fit.w * 0.96 })}>－</Tool>
                <Tool label="向左轉" onClick={() => setFit(sel.garment_id, { ...sel.fit, rotation: sel.fit.rotation - 1 })}>↺</Tool>
                <Tool label="向右轉" onClick={() => setFit(sel.garment_id, { ...sel.fit, rotation: sel.fit.rotation + 1 })}>↻</Tool>
                <Tool label="還原位置" disabled={sel.from !== "override"} onClick={() => setFit(sel.garment_id, sel.base)}>還原</Tool>
                <Tool label="脫下" onClick={() => { change((cur) => cur.filter((w) => w.garment_id !== sel.garment_id)); setSelected(null); }}>脫下</Tool>
                <button type="button" aria-label="存為這件衣物的穿著位置" disabled={busy || sel.content.approximate || sel.from !== "override"} onClick={() => saveTemplate(sel)} className="btn-jewel min-h-12 rounded-2xl px-1 text-[12px] leading-tight disabled:opacity-40">
                  存為<br />穿著位置
                </button>
                <button type="button" onClick={() => setSelected(null)} className="btn-dark min-h-9 rounded-full text-[13px]">完成</button>
              </div>
            ) : !garments ? (
              <Spinner />
            ) : visible.length === 0 ? (
              <p className="py-6 text-center text-[11px] leading-relaxed text-mauve">{garments.length ? "這個分類未有衣物" : "衣櫃未有已入庫而且有透明圖的衣物"}</p>
            ) : (
              <div className="grid grid-cols-1 gap-y-1" data-testid="doll-picker">
                {visible.map((g) => (
                  <GarmentTile transparentOnly key={g.id} g={g} size="sm" selected={worn.some((w) => w.garment_id === g.id)} onSelect={() => void toggle(g)} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ───── 已穿上的衣物（點選即校正） ───── */}
      {worn.length > 0 && (
        <div className="scrollbar-none -mx-4 mt-2 flex gap-1.5 overflow-x-auto px-4" aria-label="已穿上">
          {[...ordered].reverse().map((w) => (
            <button key={w.garment_id} type="button" onClick={() => setSelected(w.garment_id === selected ? null : w.garment_id)} className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] ${w.garment_id === selected ? "chip-on" : "chip"}`}>
              {SLOT_LABEL[w.slot]}｜<span className="inline-block max-w-[7rem] truncate align-bottom">{w.name}</span>
            </button>
          ))}
        </div>
      )}
      {sel ? (
        <p className="mt-1.5 text-center text-[11px] leading-relaxed text-mauve">
          <span className="text-gold-soft" data-testid="fit-from">{FROM_LABEL[sel.from]}</span>｜拖動衣物，雙指縮放及旋轉。不按「存為穿著位置」，調整只保存在這個造型內。 <button type="button" className="underline text-gold-soft" onClick={() => setFitPanel(true)}>精細校正</button>
        </p>
      ) : (
        <p className="mt-1.5 text-center text-[11px] text-mauve">{worn.length ? "點選角色身上的衣物或上面的標籤，可校正位置。" : "在右邊點選衣物，角色會即時換上。"}</p>
      )}

      {fitPanel && sel && <Sheet title="衣物精細校正" onClose={() => setFitPanel(false)}>
        <p className="mb-2 text-[12px] text-mauve">{sel.name}｜每次移動 5 個邏輯像素</p>
        <div className="grid grid-cols-3 gap-2">
          <div /><Tool label="向上微調" onClick={() => setFit(sel.garment_id, { ...sel.fit, cy: sel.fit.cy - 5 })}>↑</Tool><div />
          <Tool label="向左微調" onClick={() => setFit(sel.garment_id, { ...sel.fit, cx: sel.fit.cx - 5 })}>←</Tool>
          <Tool label="重新自動對位" onClick={() => setFit(sel.garment_id, defaultFit(sel.slot, sel.content, sel.category, avatar, sel.subcategory, sel.name))}>自動</Tool>
          <Tool label="向右微調" onClick={() => setFit(sel.garment_id, { ...sel.fit, cx: sel.fit.cx + 5 })}>→</Tool>
          <div /><Tool label="向下微調" onClick={() => setFit(sel.garment_id, { ...sel.fit, cy: sel.fit.cy + 5 })}>↓</Tool><div />
        </div>
        <button type="button" className="btn-jewel mt-3 min-h-10 w-full rounded-full" onClick={() => setFitPanel(false)}>完成微調</button>
      </Sheet>}
      {avatarPanel && isV2 && <Sheet title="角色設定" onClose={() => setAvatarPanel(false)}>
        <AvatarPoseEditor rig={RIG_V2} value={appearance} onChange={(v) => { setAppearance(v); setDirty(true); }} showSkeleton={skeleton} onShowSkeleton={setSkeleton} />
      </Sheet>}

      {/* ───── 造型 ───── */}
      <section className="frame mt-6 px-3 pb-3 pt-4" aria-label="已保存的造型">
        <h2 className="orn mb-2.5 text-center font-serif text-[15px] tracking-[0.14em] text-gold-soft">已保存的造型</h2>
        {looks.length === 0 ? (
          <p className="text-center text-[12px] text-mauve">仍未有造型</p>
        ) : (
          <div className="scrollbar-none flex gap-2 overflow-x-auto pb-1">
            {looks.map((l) => (
              <Link key={l.id} to={`/dressing/${l.id}`} aria-current={l.id === id ? "page" : undefined} className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] ${l.id === id ? "chip-on" : "chip"}`}>
                {l.name}（{l.item_count}）
              </Link>
            ))}
          </div>
        )}
        <input className={`${inputCls} mt-3`} value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} placeholder="造型名稱，例如：月夜茶會" aria-label="造型名稱" />
        <div className={`mt-3 grid gap-2 ${id ? "grid-cols-2" : "grid-cols-1"}`}>
          <button type="button" onClick={save} disabled={busy || switching} className="btn-jewel flex min-h-12 items-center justify-center gap-2 rounded-2xl text-[14px] disabled:opacity-40">
            <IconSave /> {busy ? "處理中…" : "保存造型"}
          </button>
          {id && (
            <button type="button" onClick={remove} disabled={busy} className="btn-dark flex min-h-12 items-center justify-center gap-2 rounded-2xl text-[14px] disabled:opacity-40">
              <IconTrash /> 刪除造型
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function Tool({ onClick, label, disabled, children }: { onClick: () => void; label: string; disabled?: boolean; children: string }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="chip min-h-9 min-w-9 rounded-full px-3 disabled:opacity-40">
      {children}
    </button>
  );
}

function Handle({ label, className, cursor, onDown, onMove, onUp, children }: { label: string; className: string; cursor: string; onDown: (e: ReactPointerEvent<HTMLDivElement>) => void; onMove: (e: ReactPointerEvent<HTMLDivElement>) => void; onUp: (e: ReactPointerEvent<HTMLDivElement>) => void; children: string }) {
  return (
    <div role="slider" aria-label={label} aria-valuenow={0} className={`btn-jewel pointer-events-auto absolute grid h-7 w-7 place-items-center rounded-full text-[12px] ${className}`} style={{ touchAction: "none", cursor }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {children}
    </div>
  );
}
