// Phase 3.8A.2：主頁 Widget 編輯（類似 iPhone 桌面）。兩欄 Grid：半寬及全寬元件可以自由組合。
// - 按住把手（或長按元件）拖動：元件跟隨手指，其他元件即時讓位（同一行左右交換、跨行移動），虛線框顯示放置位置；
//   畫面邊緣自動捲動；pointercancel／系統取消手勢＝還原。拖動期間只改變編輯畫面的次序，放手才更新草稿。
// - 新增小工具：可視化元件庫，預覽與正式主頁共用同一個渲染器；左右滑動切換展示方式，選擇大小後直接加入。
// - 「完成」才保存（凍結開始編輯時的版本，衝突時保留草稿）；「取消」還原開始編輯前的完整布局。
import { PointerEvent as ReactPointerEvent, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DISPLAYS, HomeLayout, SIZE_LABEL, WIDGETS, Widget, WidgetSize, WidgetType, defaultHomeLayout, displayLabel, newWidget, normalizeHomeLayout, spanFor, widgetSpec } from "../../shared/homeLayout";
import { LayoutConflict, adoptServerLayout, baseOf, saveHomeLayout } from "../homeLayoutStore";
import { IconChevronLeft, IconChevronRight, IconEyeOff, IconGear, IconGrip, IconPlus } from "./icons";
import { Sheet, toast } from "./ui";
import { WidgetSettings } from "./WidgetSettings";

const LONG_PRESS_MS = 420;
const EDGE = 56;

interface DragState { id: string; pointerId: number; offX: number; offY: number; lastX: number; lastY: number; tx: number; ty: number; start: string[]; raf: number; done: boolean; lastSwap: number }

export function HomeEditSurface({ layout, render, onDraft, onClose, onNeed }: {
  layout: HomeLayout;
  render: (w: Widget, preview?: boolean) => ReactNode;
  onDraft: (l: HomeLayout | null) => void;
  onClose: () => void;
  /** 預覽某類元件前，先讀取它需要的資料（共用正式主頁的資料，不重複下載） */
  onNeed?: (t: WidgetType) => void;
}) {
  const initial = useMemo(() => normalizeHomeLayout(layout), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<HomeLayout>(initial);
  const [base, setBase] = useState(() => baseOf(initial));
  const [conflict, setConflict] = useState<LayoutConflict | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const drag = useRef<DragState | null>(null);
  const press = useRef<{ timer: number; x: number; y: number; id: string; pointerId: number; el: HTMLElement } | null>(null);
  useEffect(() => { onDraft(draft); }, [draft, onDraft]);
  useEffect(() => () => { stopDrag(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = draft.widgets.filter((w) => w.visible);
  // 拖動期間以 CSS order 讓位（不移動 DOM 節點，避免失去 pointer capture）
  const orderOf = (id: string, i: number) => (dragOrder ? Math.max(0, dragOrder.indexOf(id)) : i);
  const ordered = visible;
  const changed = JSON.stringify(initial.widgets) !== JSON.stringify(draft.widgets);
  const setWidgets = (widgets: Widget[]) => setDraft((d) => ({ ...d, widgets }));
  const patch = (id: string, p: Partial<Widget>) => setDraft((d) => ({ ...d, widgets: d.widgets.map((w) => (w.id === id ? { ...w, ...p, opts: { ...w.opts, ...(p.opts ?? {}) } } : w)) }));
  /** 只改變可見元件的次序；隱藏元件保留在原本的位置 */
  const reorderVisible = (ids: string[]) => setDraft((d) => {
    const slots = d.widgets.map((w) => w.visible);
    const queue = ids.map((id) => d.widgets.find((w) => w.id === id)!).filter(Boolean);
    let k = 0;
    return { ...d, widgets: d.widgets.map((w, i) => (slots[i] ? queue[k++] ?? w : w)) };
  });
  const move = (id: string, dir: -1 | 1) => {
    const ids = visible.map((w) => w.id), i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorderVisible(ids);
  };

  // ───── 拖動（兩欄 Grid） ─────
  const blockTouch = (e: TouchEvent) => { if (drag.current) e.preventDefault(); };
  /** 讓被拖動的元件留在手指下，並在原位顯示放置位置 */
  function position() {
    const d = drag.current;
    const el = d && nodes.current.get(d.id);
    if (!d || !el) return;
    const r = el.getBoundingClientRect();
    const natX = r.left - d.tx, natY = r.top - d.ty;
    d.tx = d.lastX - d.offX - natX; d.ty = d.lastY - d.offY - natY;
    el.style.transform = `translate(${d.tx}px, ${d.ty}px) scale(1.02)`;
    const host = box.current?.getBoundingClientRect();
    if (slot.current && host) Object.assign(slot.current.style, { display: "block", left: `${natX - host.left}px`, top: `${natY - host.top}px`, width: `${r.width / 1.02}px`, height: `${Math.max(40, r.height / 1.02)}px` });
  }
  /** 手指所在的元件：移入其內部（避開邊緣以免來回跳動）就交換位置 */
  function hitTest() {
    const d = drag.current;
    if (!d || !dragOrderRef.current) return;
    const order = dragOrderRef.current;
    if (Date.now() - d.lastSwap < 120) return;
    for (const id of order) {
      if (id === d.id) continue;
      const n = nodes.current.get(id);
      if (!n) continue;
      const r = n.getBoundingClientRect();
      const mx = Math.min(r.width * 0.12, 16), my = Math.min(r.height * 0.25, 40);
      if (d.lastX > r.left + mx && d.lastX < r.right - mx && d.lastY > r.top + my && d.lastY < r.bottom - my) {
        const next = order.filter((x) => x !== d.id);
        const at = next.indexOf(id) + (order.indexOf(id) > order.indexOf(d.id) ? 1 : 0);
        next.splice(at, 0, d.id);
        d.lastSwap = Date.now();
        dragOrderRef.current = next;
        setDragOrder(next);
        return;
      }
    }
  }
  const dragOrderRef = useRef<string[] | null>(null);
  useLayoutEffect(() => { if (drag.current) position(); }, [dragOrder]); // eslint-disable-line react-hooks/exhaustive-deps
  function tick() {
    const d = drag.current;
    if (!d || d.done) return;
    // 手指停留在畫面邊緣：持續自動捲動（上方有固定頁首、下方有編輯工具列）
    const vh = window.innerHeight, topEdge = 56 + EDGE, bottomEdge = vh - 70 - EDGE;
    const speed = d.lastY < topEdge ? -Math.ceil((topEdge - d.lastY) / 5) : d.lastY > bottomEdge ? Math.ceil((d.lastY - bottomEdge) / 5) : 0;
    if (speed) { window.scrollBy(0, speed); position(); hitTest(); }
    d.raf = requestAnimationFrame(tick);
  }
  function startDrag(id: string, el: HTMLElement, pointerId: number, clientX: number, clientY: number) {
    const node = nodes.current.get(id)!;
    const r = node.getBoundingClientRect();
    try { el.setPointerCapture(pointerId); } catch { /* 已釋放 */ }
    const ids = visible.map((w) => w.id);
    drag.current = { id, pointerId, offX: clientX - r.left, offY: clientY - r.top, lastX: clientX, lastY: clientY, tx: 0, ty: 0, start: ids, raf: 0, done: false, lastSwap: 0 };
    node.style.transition = "none";
    node.style.zIndex = "30";
    node.style.boxShadow = "0 14px 32px var(--aw-shadow-strong)";
    document.addEventListener("touchmove", blockTouch, { passive: false });
    dragOrderRef.current = ids;
    setDragOrder(ids);
    setDragging(id);
    navigator.vibrate?.(8);
    drag.current.raf = requestAnimationFrame(tick);
    position();
  }
  /** commit＝放手；false＝取消（pointercancel、系統中斷）：還原拖動前次序 */
  function stopDrag(commit: boolean) {
    const d = drag.current;
    if (!d || d.done) return;
    d.done = true;
    cancelAnimationFrame(d.raf);
    document.removeEventListener("touchmove", blockTouch);
    const n = nodes.current.get(d.id);
    if (n) { n.style.transform = ""; n.style.transition = ""; n.style.zIndex = ""; n.style.boxShadow = ""; }
    if (slot.current) slot.current.style.display = "none";
    const order = dragOrderRef.current;
    drag.current = null; dragOrderRef.current = null;
    setDragging(null); setDragOrder(null);
    if (commit && order && order.join() !== d.start.join()) reorderVisible(order);
  }
  const handlers = (id: string, immediate: boolean) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (immediate) e.stopPropagation();
      if (drag.current || (e.pointerType === "mouse" && e.button !== 0)) return;
      const el = e.currentTarget;
      if (immediate) { e.preventDefault(); startDrag(id, el, e.pointerId, e.clientX, e.clientY); return; }
      // 長按元件本身：手指移動超過 8px 前未到時間＝正常捲動
      const pointerId = e.pointerId, x = e.clientX, y = e.clientY;
      press.current = { timer: window.setTimeout(() => { if (press.current) { startDrag(id, el, pointerId, press.current.x, press.current.y); press.current = null; } }, LONG_PRESS_MS), x, y, id, pointerId, el };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (immediate) e.stopPropagation();
      const p = press.current;
      if (p && (Math.abs(e.clientX - p.x) > 8 || Math.abs(e.clientY - p.y) > 8)) { clearTimeout(p.timer); press.current = null; }
      const d = drag.current;
      if (d && e.pointerId === d.pointerId) { d.lastX = e.clientX; d.lastY = e.clientY; position(); hitTest(); }
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      if (immediate) e.stopPropagation();
      if (press.current) { clearTimeout(press.current.timer); press.current = null; }
      if (drag.current && e.pointerId === drag.current.pointerId) stopDrag(true);
    },
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => {
      if (immediate) e.stopPropagation(); if (press.current) { clearTimeout(press.current.timer); press.current = null; } stopDrag(false); },
    onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => { if (drag.current && e.pointerId === drag.current.pointerId && !drag.current.done) stopDrag(false); },
  });

  // ───── 新增、保存 ─────
  const uniqueId = (type: string) => { let id = type, n = 2; while (draft.widgets.some((w) => w.id === id)) id = `${type}_${n++}`; return id; };
  const addWidget = (w: Widget) => {
    setWidgets([...draft.widgets, w]);
    setAdding(false);
    toast(`已加入「${widgetSpec(w.type)!.label}」`);
    setTimeout(() => nodes.current.get(w.id)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
  };
  const readd = (id: string) => { patch(id, { visible: true }); setAdding(false); toast(`已重新加入「${widgetSpec(draft.widgets.find((w) => w.id === id)!.type)!.label}」`); setTimeout(() => nodes.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60); };
  async function save() {
    if (busy) return;
    if (!changed) { onDraft(null); onClose(); return; }
    setBusy(true);
    try { await saveHomeLayout(draft, base); toast("已保存主頁布局"); onDraft(null); onClose(); }
    catch (e) { if (e instanceof LayoutConflict) setConflict(e); else toast(`${(e as Error).message}（草稿已保留，可以再按「完成」）`, "err"); }
    finally { setBusy(false); }
  }
  const cancel = () => { stopDrag(false); onDraft(null); onClose(); };
  const editingW = settingsFor ? draft.widgets.find((w) => w.id === settingsFor) ?? null : null;

  return (
    <div data-testid="home-editor" data-dragging={dragging ?? ""} className="relative pb-24" ref={box}>
      <p className="mt-1 rounded-2xl bg-cream/5 px-3 py-2 text-[11.5px] leading-snug text-mauve">按住 <IconGrip className="inline" /> 拖動（或長按元件）；半寬元件可左右交換或跨行移動。⚙ 設定大小及展示方式、<IconEyeOff className="inline" /> 隱藏。</p>
      {conflict && (
        <div role="alert" data-testid="home-conflict" className="sticky top-14 z-40 mt-2 rounded-2xl bg-danger px-3 py-2 text-[12px] leading-snug text-[#fffaf6] shadow-xl" data-status-color>
          <p>主頁布局已在另一部裝置更新（第 {conflict.server?.rev ?? 0} 版）。你的草稿仍然保留，沒有覆寫。</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button type="button" data-testid="home-conflict-reload" onClick={() => { const srv = conflict.server ?? defaultHomeLayout(); adoptServerLayout(conflict.server); setDraft(normalizeHomeLayout(srv)); setBase(baseOf(srv)); setConflict(null); }} className="h-9 rounded-full bg-black/25 px-3">載入伺服器版本</button>
            <button type="button" data-testid="home-conflict-overwrite" onClick={() => { setBase(baseOf(conflict.server ?? defaultHomeLayout())); setConflict(null); toast("再按「完成」即以你的草稿覆寫伺服器版本"); }} className="h-9 rounded-full bg-black/25 px-3">以我的草稿覆寫</button>
          </div>
        </div>
      )}
      <div ref={slot} aria-hidden className="pointer-events-none absolute z-10 hidden rounded-2xl border-2 border-dashed border-gold bg-gold/10" data-testid="home-insert-line" />
      <div className="mt-3 grid grid-cols-2 items-start gap-x-3 gap-y-3" data-testid="home-edit-grid">
        {ordered.map((w, i) => {
          const spec = widgetSpec(w.type)!;
          return (
            <div key={w.id} ref={(el) => { if (el) nodes.current.set(w.id, el); else nodes.current.delete(w.id); }} data-widget={w.id} data-type={w.type} data-span={w.span} data-size={w.size} data-display={w.display}
              style={{ order: orderOf(w.id, i) }} className={`relative min-w-0 flow-root rounded-2xl outline-dashed outline-1 outline-offset-2 outline-gold/50 ${w.span === 2 ? "col-span-2" : "col-span-1"} ${dragging === w.id ? "bg-velvet/80" : ""}`} {...handlers(w.id, false)}>
              <div className="flex items-center gap-0 rounded-t-2xl bg-head/70 px-0.5 py-0.5 text-[12px]">
                <span role="button" tabIndex={-1} aria-label={`拖動「${spec.label}」`} data-drag-handle={w.id} style={{ touchAction: "none" }} className="grid h-10 w-9 shrink-0 cursor-grab select-none place-items-center text-[17px] text-gold-soft" {...handlers(w.id, true)}><IconGrip /></span>
                <span className="min-w-0 flex-1 truncate text-gold-soft">{spec.label}{w.span === 2 && <span className="ml-1 text-[10.5px] text-mauve">{SIZE_LABEL[w.size]}・{displayLabel(w.type, w.display)}</span>}</span>
                {w.span === 2 && <>
                  <button type="button" aria-label="上移" data-move="up" disabled={i === 0} onClick={() => move(w.id, -1)} className="grid h-10 w-7 place-items-center disabled:opacity-30"><IconChevronLeft /></button>
                  <button type="button" aria-label="下移" data-move="down" disabled={i === ordered.length - 1} onClick={() => move(w.id, 1)} className="grid h-10 w-7 place-items-center disabled:opacity-30"><IconChevronRight /></button>
                </>}
                <button type="button" aria-label={`設定「${spec.label}」`} aria-expanded={settingsFor === w.id} data-settings={w.id} onClick={() => setSettingsFor(w.id)} className="grid h-10 w-8 place-items-center text-[16px]"><IconGear /></button>
                <button type="button" aria-label={`隱藏「${spec.label}」`} data-toggle={w.id} onClick={() => patch(w.id, { visible: false })} className="grid h-10 w-8 place-items-center text-[16px]"><IconEyeOff /></button>
              </div>
              {/* 編輯時元件內容不可點擊（不會誤觸衣物詳情等連結），但仍可單指捲動整頁；空元件保留預覽 */}
              <div className="pointer-events-none select-none px-0.5 pb-2 pt-1" aria-hidden>{render(w, true)}</div>
            </div>
          );
        })}
      </div>
      {!visible.length && <p className="mt-6 text-center text-[13px] text-mauve">主頁沒有元件，按「新增小工具」加入。</p>}
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-gold/40 bg-velvet/95 px-3 pt-2 shadow-2xl" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }} data-testid="home-edit-bar">
        <div className="mx-auto flex max-w-lg items-center gap-2">
          <button type="button" data-testid="home-add" onClick={() => setAdding(true)} className="chip flex h-11 items-center gap-1 rounded-full px-4 text-[13px]"><IconPlus />新增小工具</button>
          <span className="flex-1" />
          <button type="button" data-testid="home-cancel" onClick={cancel} disabled={busy} className="chip h-11 rounded-full px-4 text-[13px]">取消</button>
          <button type="button" data-testid="home-save" onClick={() => void save()} disabled={busy} className="btn-jewel h-11 rounded-full px-5 text-[13px] disabled:opacity-50">{busy ? "保存中…" : "完成"}</button>
        </div>
      </div>
      {adding && (
        <Sheet title="新增小工具" onClose={() => setAdding(false)}>
          <WidgetGallery draft={draft} render={render} onNeed={onNeed} onAdd={(w) => addWidget({ ...w, id: uniqueId(w.type) })} onReadd={readd} />
          <button type="button" data-testid="home-reset" onClick={() => { setDraft((d) => ({ ...defaultHomeLayout(), ...(d.rev ? { rev: d.rev } : {}), ...(d.updated_at ? { updated_at: d.updated_at } : {}) })); setAdding(false); }} className="chip mt-3 h-10 w-full rounded-full text-[12.5px]">還原建議預設布局</button>
        </Sheet>
      )}
      {editingW && (
        <Sheet title={`設定：${widgetSpec(editingW.type)!.label}`} onClose={() => setSettingsFor(null)}>
          <div className="mb-3 grid grid-cols-2 gap-2 rounded-2xl bg-cream/5 p-2" data-testid="widget-settings-preview">
            <div className={`pointer-events-none min-w-0 ${editingW.span === 2 ? "col-span-2" : "col-span-1"}`} inert>{render(editingW, true)}</div>
          </div>
          <div className="mb-2 flex items-center gap-1.5 text-[12.5px]">位置
            <button type="button" data-settings-move="up" onClick={() => move(editingW.id, -1)} className="chip flex h-8 items-center gap-1 rounded-full px-3"><IconChevronLeft />往前</button>
            <button type="button" data-settings-move="down" onClick={() => move(editingW.id, 1)} className="chip flex h-8 items-center gap-1 rounded-full px-3">往後<IconChevronRight /></button>
          </div>
          <WidgetSettings w={editingW} onPatch={(p) => patch(editingW.id, p)} onRemove={draft.widgets.filter((x) => x.type === editingW.type).length > 1 ? () => { setWidgets(draft.widgets.filter((x) => x.id !== editingW.id)); setSettingsFor(null); } : undefined} />
          <p className="mt-3 text-[11px] text-mauve">主頁會即時預覽；按底部「完成」才保存。</p>
        </Sheet>
      )}
    </div>
  );
}

/**
 * 可視化元件庫：每種元件以正式渲染器顯示真實預覽（使用目前衣櫃資料；沒有資料時顯示空狀態示意）。
 * 點選後左右滑動切換展示方式，選擇大小及基本內容，按「加入小工具」直接加入主頁。
 */
export function WidgetGallery({ draft, render, onNeed, onAdd, onReadd }: { draft: HomeLayout; render: (w: Widget, preview?: boolean) => ReactNode; onNeed?: (t: WidgetType) => void; onAdd: (w: Widget) => void; onReadd: (id: string) => void }) {
  const [type, setType] = useState<WidgetType | null>(null);
  useEffect(() => { for (const s of WIDGETS) onNeed?.(s.type); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (type) return <GalleryDetail key={type} type={type} draft={draft} render={render} onBack={() => setType(null)} onAdd={onAdd} onReadd={onReadd} />;
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="home-add-list">
      {WIDGETS.map((spec) => {
        const hidden = draft.widgets.find((w) => w.type === spec.type && !w.visible);
        const on = draft.widgets.some((w) => w.type === spec.type && w.visible);
        const disabled = on && !spec.multi && !hidden;
        const sample = newWidget(spec.type, "preview_" + spec.type);
        return (
          <button key={spec.type} type="button" data-add={spec.type} disabled={disabled} onClick={() => setType(spec.type)} className="chip flex flex-col overflow-hidden rounded-2xl p-1.5 text-left disabled:opacity-40">
            <span className="relative block h-[104px] w-full overflow-hidden rounded-xl bg-plum/60" aria-hidden>
              <span className="pointer-events-none absolute left-0 top-0 block origin-top-left p-1.5" style={{ width: "200%", transform: "scale(0.5)" }} inert>{render(sample, true)}</span>
            </span>
            <span className="mt-1 block px-1 text-[12.5px]">{spec.label}</span>
            <span className="block px-1 text-[10.5px] text-mauve">{disabled ? "已在主頁" : hidden ? "重新加入／再加一個" : on ? "再加一個" : `${DISPLAYS[spec.type].length} 種展示方式`}</span>
          </button>
        );
      })}
    </div>
  );
}

function GalleryDetail({ type, draft, render, onBack, onAdd, onReadd }: { type: WidgetType; draft: HomeLayout; render: (w: Widget, preview?: boolean) => ReactNode; onBack: () => void; onAdd: (w: Widget) => void; onReadd: (id: string) => void }) {
  const spec = widgetSpec(type)!;
  const list = DISPLAYS[type];
  const [idx, setIdx] = useState(0);
  const [size, setSize] = useState<WidgetSize>(list[0][2]);
  const [span, setSpan] = useState<1 | 2>(2);
  const [w, setW] = useState<Widget>(() => newWidget(type, "preview_" + type));
  const rail = useRef<HTMLDivElement>(null);
  const display = list[idx][0];
  const current: Widget = { ...w, display, size, span: spanFor(type, display, size, span) };
  const hidden = draft.widgets.find((x) => x.type === type && !x.visible);
  const jumping = useRef<number | null>(null);
  const settle = useRef(0);
  const choose = (i: number) => { setIdx(i); setSize(list[i][2]); jumping.current = i; const c = rail.current?.children[i] as HTMLElement | undefined; if (c && rail.current) rail.current.scrollTo({ left: c.offsetLeft - (rail.current.clientWidth - c.offsetWidth) / 2, behavior: "smooth" }); setTimeout(() => { if (jumping.current === i) jumping.current = null; }, 2500); };
  const sizes: WidgetSize[] = type === "cover" ? (display === "mini" ? ["small"] : ["large"]) : ["small", "medium", "large"];
  return (
    <div data-testid="gallery-detail" data-type={type} data-display={display} data-size={size} data-span={current.span}>
      <button type="button" onClick={onBack} className="mb-2 flex items-center gap-1 text-[12.5px] text-amethyst-deep"><IconChevronLeft />全部小工具</button>
      <p className="mb-2 text-[11.5px] text-mauve">{spec.hint}</p>
      {/* 左右滑動切換展示方式；每一頁都是正式渲染器的真實預覽 */}
      <div ref={rail} className="scrollbar-none -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4" data-testid="gallery-rail"
        onScroll={(e) => {
          // 停止捲動後（防抖）才以最接近中央的一頁為目前展示方式；按圓點捲動時等到達目標才更新
          const el = e.currentTarget;
          clearTimeout(settle.current);
          settle.current = window.setTimeout(() => {
            const mid = el.scrollLeft + el.clientWidth / 2;
            let best = 0, dist = Infinity;
            Array.from(el.children).forEach((c, i) => { const h = c as HTMLElement, d = Math.abs(h.offsetLeft + h.offsetWidth / 2 - mid); if (d < dist) { dist = d; best = i; } });
            if (jumping.current !== null) { if (best === jumping.current) jumping.current = null; return; }
            setIdx((cur) => { if (cur !== best) setSize(list[best][2]); return best; });
          }, 160);
        }}>
        {list.map(([k], i) => {
          const pw: Widget = { ...w, display: k, size: i === idx ? size : list[i][2], span: spanFor(type, k, i === idx ? size : list[i][2], span) };
          return (
            <div key={k} className="w-[calc(100%-1.25rem)] shrink-0 snap-center rounded-2xl bg-plum/50 p-2" data-gallery-slide={k}>
              <div className="grid grid-cols-2 gap-2"><div className={`pointer-events-none min-w-0 ${pw.span === 2 ? "col-span-2" : "col-span-1"}`} inert>{render(pw, true)}</div></div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-center gap-1.5" role="tablist" aria-label="展示方式">
        {list.map(([k, l], i) => <button key={k} type="button" role="tab" aria-selected={i === idx} aria-label={l} data-gallery-display={k} onClick={() => choose(i)} className={`h-2 rounded-full transition-all ${i === idx ? "w-5 bg-gold" : "w-2 bg-gold/35"}`} />)}
      </div>
      <p className="mt-1.5 text-center text-[12.5px]" data-testid="gallery-current">展示方式：<b>{list[idx][1]}</b>｜大小：<b>{SIZE_LABEL[size]}</b>（{current.span === 2 ? "全寬" : "半寬"}）</p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-[12.5px]">
        {sizes.map((sz) => <button key={sz} type="button" aria-pressed={size === sz} data-gallery-size={sz} onClick={() => setSize(sz)} className={`h-8 rounded-full px-3 ${size === sz ? "chip-on" : "chip"}`}>{SIZE_LABEL[sz]}</button>)}
        {size === "medium" && type !== "cover" && ([[1, "半寬"], [2, "全寬"]] as const).map(([s, l]) => <button key={s} type="button" aria-pressed={span === s} data-gallery-span={s} onClick={() => setSpan(s)} className={`h-8 rounded-full px-3 ${span === s ? "chip-on" : "chip"}`}>{l}</button>)}
      </div>
      <details className="mt-2 rounded-2xl bg-cream/5 px-3 py-2">
        <summary className="cursor-pointer text-[12.5px] text-gold-soft">基本內容設定</summary>
        <div className="mt-2"><WidgetSettings w={current} basic onPatch={(p) => setW((x) => ({ ...x, ...p, opts: { ...x.opts, ...(p.opts ?? {}) } }))} /></div>
      </details>
      <div className="mt-3 flex gap-2">
        {hidden && <button type="button" data-testid="gallery-readd" onClick={() => onReadd(hidden.id)} className="chip h-11 flex-1 rounded-full text-[13px]">重新加入已隱藏的</button>}
        <button type="button" data-testid="gallery-add" onClick={() => onAdd(current)} className="btn-jewel flex h-11 flex-1 items-center justify-center gap-1 rounded-full text-[13px]"><IconPlus />加入小工具</button>
      </div>
    </div>
  );
}
