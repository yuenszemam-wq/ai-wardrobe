// Phase 3.8A.1：主頁原位編輯（類似 iPhone 主畫面編輯 Widget）。
// 真正的首頁元件留在原位；按住把手（或長按元件）拖動，其他元件即時讓位，並顯示插入位置。
// 拖動期間只直接改動元件的 transform，不重新建立圖片及元件；放手才更新草稿次序。
// pointercancel／系統取消手勢：還原拖動前狀態，不保存。按「完成」才保存，「取消」還原開始編輯前的完整布局。
import { PointerEvent as ReactPointerEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { HomeLayout, WIDGETS, Widget, WidgetType, defaultHomeLayout, normalizeHomeLayout, widgetSpec } from "../../shared/homeLayout";
import { LayoutConflict, adoptServerLayout, baseOf, saveHomeLayout } from "../homeLayoutStore";
import { IconChevronDown, IconChevronUp, IconEyeOff, IconGear, IconGrip, IconPlus } from "./icons";
import { Sheet, toast } from "./ui";
import { WidgetSettings } from "./WidgetSettings";

const LONG_PRESS_MS = 420;
const EDGE = 56;

interface DragState { id: string; pointerId: number; el: HTMLElement; startY: number; startScroll: number; lastY: number; from: number; to: number; rects: { id: string; top: number; height: number }[]; raf: number; done: boolean }

export function HomeEditSurface({ layout, render, onDraft, onClose }: {
  layout: HomeLayout;
  render: (w: Widget) => ReactNode;
  onDraft: (l: HomeLayout | null) => void;
  onClose: () => void;
}) {
  const initial = useMemo(() => normalizeHomeLayout(layout), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<HomeLayout>(initial);
  // 開始編輯時凍結版本
  const [base, setBase] = useState(() => baseOf(initial));
  const [conflict, setConflict] = useState<LayoutConflict | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const drag = useRef<DragState | null>(null);
  const press = useRef<{ timer: number; x: number; y: number; id: string; pointerId: number; el: HTMLElement } | null>(null);
  useEffect(() => { onDraft(draft); }, [draft, onDraft]);
  useEffect(() => () => { stopDrag(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = draft.widgets.filter((w) => w.visible);
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

  // ───── 拖動 ─────
  const blockTouch = (e: TouchEvent) => { if (drag.current) e.preventDefault(); };
  function layoutAt(clientY: number) {
    const d = drag.current;
    if (!d) return;
    const dy = clientY - d.startY + (window.scrollY - d.startScroll);
    const me = d.rects[d.from];
    const center = me.top + me.height / 2 + dy;
    const others = d.rects.filter((_, i) => i !== d.from);
    let to = others.findIndex((r) => center < r.top + r.height / 2);
    if (to < 0) to = others.length;
    d.to = to;
    d.el.style.transform = `translateY(${dy}px) scale(1.02)`;
    // 其他元件讓位
    d.rects.forEach((r, i) => {
      if (i === d.from) return;
      const n = nodes.current.get(r.id);
      if (!n) return;
      const oi = i < d.from ? i : i - 1;
      const shift = d.from < i && oi < to ? -me.height : d.from > i && oi >= to ? me.height : 0;
      n.style.transform = shift ? `translateY(${shift}px)` : "";
    });
    // 插入位置
    const host = box.current?.getBoundingClientRect();
    if (line.current && host) {
      const y = to >= others.length ? (others.length ? others[others.length - 1].top + others[others.length - 1].height : me.top) : others[to].top;
      const adj = to < others.length && d.from < d.rects.indexOf(others[to]) ? -me.height : 0;
      line.current.style.display = "block";
      line.current.style.top = `${y + adj - (host.top + window.scrollY) - 2}px`;
    }
  }
  function tick() {
    const d = drag.current;
    if (!d || d.done) return;
    // 手指停留在畫面邊緣：持續自動捲動（以實際捲動容器＝整頁）
    // 上方有固定頁首、下方有編輯工具列：邊緣區域由它們的邊界起計
    const vh = window.innerHeight, topEdge = 56 + EDGE, bottomEdge = vh - 70 - EDGE;
    const speed = d.lastY < topEdge ? -Math.ceil((topEdge - d.lastY) / 5) : d.lastY > bottomEdge ? Math.ceil((d.lastY - bottomEdge) / 5) : 0;
    if (speed) { window.scrollBy(0, speed); layoutAt(d.lastY); }
    d.raf = requestAnimationFrame(tick);
  }
  function startDrag(id: string, el: HTMLElement, pointerId: number, clientY: number) {
    const ids = visible.map((w) => w.id);
    const rects = ids.map((x) => { const r = nodes.current.get(x)!.getBoundingClientRect(); return { id: x, top: r.top + window.scrollY, height: r.height }; });
    const node = nodes.current.get(id)!;
    try { el.setPointerCapture(pointerId); } catch { /* 已釋放 */ }
    drag.current = { id, pointerId, el: node, startY: clientY, startScroll: window.scrollY, lastY: clientY, from: ids.indexOf(id), to: ids.indexOf(id), rects, raf: 0, done: false };
    for (const r of rects) { const n = nodes.current.get(r.id); if (n) n.style.transition = r.id === id ? "none" : "transform 160ms ease"; }
    node.style.zIndex = "30";
    node.style.boxShadow = "0 14px 32px rgb(0 0 0 / 0.45)";
    document.addEventListener("touchmove", blockTouch, { passive: false });
    setDragging(id);
    navigator.vibrate?.(8);
    drag.current.raf = requestAnimationFrame(tick);
    layoutAt(clientY);
  }
  /** commit＝放手；false＝取消（pointercancel、系統中斷）：還原拖動前狀態 */
  function stopDrag(commit: boolean) {
    const d = drag.current;
    if (!d || d.done) return;
    d.done = true;
    cancelAnimationFrame(d.raf);
    document.removeEventListener("touchmove", blockTouch);
    for (const r of d.rects) { const n = nodes.current.get(r.id); if (n) { n.style.transform = ""; n.style.transition = ""; n.style.zIndex = ""; n.style.boxShadow = ""; } }
    if (line.current) line.current.style.display = "none";
    drag.current = null;
    setDragging(null);
    if (commit && d.to !== d.from) {
      const ids = d.rects.map((r) => r.id);
      const [m] = ids.splice(d.from, 1);
      ids.splice(d.to, 0, m);
      reorderVisible(ids);
    }
  }
  const handlers = (id: string, immediate: boolean) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (immediate) e.stopPropagation();
      if (drag.current || (e.pointerType === "mouse" && e.button !== 0)) return;
      const el = e.currentTarget;
      if (immediate) { e.preventDefault(); startDrag(id, el, e.pointerId, e.clientY); return; }
      // 長按元件本身：手指移動超過 8px 前未到時間＝正常捲動
      const pointerId = e.pointerId, x = e.clientX, y = e.clientY;
      press.current = { timer: window.setTimeout(() => { if (press.current) { startDrag(id, el, pointerId, press.current.y); press.current = null; } }, LONG_PRESS_MS), x, y, id, pointerId, el };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (immediate) e.stopPropagation();
      const p = press.current;
      if (p && (Math.abs(e.clientX - p.x) > 8 || Math.abs(e.clientY - p.y) > 8)) { clearTimeout(p.timer); press.current = null; }
      else if (p) p.y = e.clientY;
      const d = drag.current;
      if (d && e.pointerId === d.pointerId) { d.lastY = e.clientY; layoutAt(e.clientY); }
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
  const add = (type: WidgetType) => {
    const spec = widgetSpec(type)!;
    const existing = draft.widgets.find((w) => w.type === type);
    if (existing && !spec.multi) { patch(existing.id, { visible: true }); setAdding(false); toast(`已重新加入「${spec.label}」`); return; }
    let id: string = type, n = 2;
    while (draft.widgets.some((w) => w.id === id)) id = `${type}_${n++}`;
    const tpl = defaultHomeLayout().widgets.find((w) => w.type === type)!;
    setWidgets([...draft.widgets, { ...tpl, id, visible: true }]);
    setAdding(false);
    setTimeout(() => nodes.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
  };
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
      <p className="mt-1 rounded-2xl bg-cream/5 px-3 py-2 text-[11.5px] leading-snug text-mauve">編輯主頁：按住 <IconGrip className="inline" /> 拖動（或長按元件），放手放下。⚙ 設定、<IconEyeOff className="inline" /> 隱藏；隱藏的元件可在「新增元件」重新加入。</p>
      {conflict && (
        <div role="alert" data-testid="home-conflict" className="sticky top-14 z-40 mt-2 rounded-2xl bg-wine px-3 py-2 text-[12px] leading-snug text-cream shadow-xl">
          <p>主頁布局已在另一部裝置更新（第 {conflict.server?.rev ?? 0} 版）。你的草稿仍然保留，沒有覆寫。</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <button type="button" data-testid="home-conflict-reload" onClick={() => { const srv = conflict.server ?? defaultHomeLayout(); adoptServerLayout(conflict.server); setDraft(normalizeHomeLayout(srv)); setBase(baseOf(srv)); setConflict(null); }} className="chip h-9 rounded-full px-3">載入伺服器版本</button>
            <button type="button" data-testid="home-conflict-overwrite" onClick={() => { setBase(baseOf(conflict.server ?? defaultHomeLayout())); setConflict(null); toast("再按「完成」即以你的草稿覆寫伺服器版本"); }} className="chip h-9 rounded-full px-3">以我的草稿覆寫</button>
          </div>
        </div>
      )}
      <div ref={line} aria-hidden className="pointer-events-none absolute inset-x-1 z-20 hidden h-1 rounded-full bg-gold shadow-[0_0_8px_var(--color-gold)]" data-testid="home-insert-line" />
      {visible.map((w, i) => {
        const spec = widgetSpec(w.type)!;
        return (
          <div key={w.id} ref={(el) => { if (el) nodes.current.set(w.id, el); else nodes.current.delete(w.id); }} data-widget={w.id} data-type={w.type}
            className={`relative mt-3 flow-root rounded-2xl outline-dashed outline-1 outline-offset-2 outline-gold/50 ${dragging === w.id ? "bg-velvet/80" : ""}`} {...handlers(w.id, false)}>
            <div className="flex items-center gap-0.5 rounded-t-2xl bg-head/70 px-1 py-0.5 text-[12px]">
              <span role="button" tabIndex={-1} aria-label={`拖動「${spec.label}」`} data-drag-handle={w.id} style={{ touchAction: "none" }} className="grid h-10 w-10 shrink-0 cursor-grab select-none place-items-center text-[17px] text-gold-soft" {...handlers(w.id, true)}><IconGrip /></span>
              <span className="min-w-0 flex-1 truncate text-gold-soft">{spec.label}{w.opts.category ? `｜${w.opts.category}` : ""}</span>
              <button type="button" aria-label="上移" data-move="up" disabled={i === 0} onClick={() => move(w.id, -1)} className="grid h-10 w-9 place-items-center disabled:opacity-30"><IconChevronUp /></button>
              <button type="button" aria-label="下移" data-move="down" disabled={i === visible.length - 1} onClick={() => move(w.id, 1)} className="grid h-10 w-9 place-items-center disabled:opacity-30"><IconChevronDown /></button>
              <button type="button" aria-label={`設定「${spec.label}」`} aria-expanded={settingsFor === w.id} data-settings={w.id} onClick={() => setSettingsFor(w.id)} className="grid h-10 w-10 place-items-center text-[16px]"><IconGear /></button>
              <button type="button" aria-label={`隱藏「${spec.label}」`} data-toggle={w.id} onClick={() => patch(w.id, { visible: false })} className="grid h-10 w-10 place-items-center text-[16px]"><IconEyeOff /></button>
            </div>
            {/* 編輯時元件內容不可點擊（不會誤觸衣物詳情等連結），但仍可單指捲動整頁 */}
            <div className="pointer-events-none select-none px-0.5 pb-2" aria-hidden>{render(w)}</div>
          </div>
        );
      })}
      {!visible.length && <p className="mt-6 text-center text-[13px] text-mauve">主頁沒有元件，按「新增元件」加入。</p>}
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-gold/40 bg-velvet/95 px-3 pt-2 shadow-2xl" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }} data-testid="home-edit-bar">
        <div className="mx-auto flex max-w-lg items-center gap-2">
          <button type="button" data-testid="home-add" onClick={() => setAdding(true)} className="chip flex h-11 items-center gap-1 rounded-full px-4 text-[13px]"><IconPlus />新增元件</button>
          <span className="flex-1" />
          <button type="button" data-testid="home-cancel" onClick={cancel} disabled={busy} className="chip h-11 rounded-full px-4 text-[13px]">取消</button>
          <button type="button" data-testid="home-save" onClick={() => void save()} disabled={busy} className="btn-jewel h-11 rounded-full px-5 text-[13px] disabled:opacity-50">{busy ? "保存中…" : "完成"}</button>
        </div>
      </div>
      {adding && (
        <Sheet title="新增元件" onClose={() => setAdding(false)}>
          <div className="grid grid-cols-2 gap-1.5 text-cream" data-testid="home-add-list">
            {WIDGETS.map((spec) => {
              const has = draft.widgets.find((w) => w.type === spec.type);
              const on = !!has && has.visible;
              const disabled = on && !spec.multi;
              return (
                <button key={spec.type} type="button" data-add={spec.type} disabled={disabled} onClick={() => add(spec.type)} className="chip rounded-2xl px-3 py-2 text-left text-[12.5px] disabled:opacity-40">
                  <span className="block">{spec.label}</span>
                  <span className="block text-[10.5px] text-mauve">{disabled ? "已在主頁" : has && !has.visible ? "重新加入" : spec.multi && on ? "再加一個" : "加入"}</span>
                </button>
              );
            })}
          </div>
          <button type="button" data-testid="home-reset" onClick={() => { setDraft((d) => ({ ...defaultHomeLayout(), ...(d.rev ? { rev: d.rev } : {}), ...(d.updated_at ? { updated_at: d.updated_at } : {}) })); setAdding(false); }} className="chip mt-3 h-10 w-full rounded-full text-[12.5px]">還原建議預設布局</button>
        </Sheet>
      )}
      {editingW && (
        <Sheet title={`設定：${widgetSpec(editingW.type)!.label}`} onClose={() => setSettingsFor(null)}>
          <WidgetSettings w={editingW} onPatch={(p) => patch(editingW.id, p)} onRemove={widgetSpec(editingW.type)!.multi && draft.widgets.filter((x) => x.type === editingW.type).length > 1 ? () => { setWidgets(draft.widgets.filter((x) => x.id !== editingW.id)); setSettingsFor(null); } : undefined} />
          <p className="mt-3 text-[11px] text-mauve">主頁會即時預覽；按底部「完成」才保存。</p>
        </Sheet>
      )}
    </div>
  );
}
