import { useEffect, useMemo, useState } from "react";
import { HomeLayout, WIDGETS, Widget, WidgetType, defaultHomeLayout, normalizeHomeLayout, widgetSpec } from "../../shared/homeLayout";
import { saveHomeLayout } from "../homeLayoutStore";
import { useTaxonomy } from "../taxonomy";
import { IconChevronDown, IconChevronUp, IconEye, IconEyeOff, IconGrip, IconTrash } from "./icons";
import { SortableList } from "./Sortable";
import { Button, toast } from "./ui";

/**
 * 主頁布局編輯器（Phase 3.8A）：由主頁「編輯」或「設定 → 主頁佈局」進入同一套編輯器。
 * 新增／隱藏／顯示元件、拖動排序（另有向上／向下按鈕作手機後備）、每個元件獨立設定、還原預設；
 * 主頁即時預覽（onDraft），按「保存」才寫入，按「取消」放棄。
 */
export function HomeEditor({ layout, onDraft, onClose, inline }: { layout: HomeLayout; onDraft?: (l: HomeLayout | null) => void; onClose: () => void; inline?: boolean }) {
  const [draft, setDraft] = useState<HomeLayout>(() => normalizeHomeLayout(layout));
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const tax = useTaxonomy();
  useEffect(() => { onDraft?.(draft); }, [draft, onDraft]);
  const changed = useMemo(() => JSON.stringify(normalizeHomeLayout(layout).widgets) !== JSON.stringify(draft.widgets), [layout, draft]);
  const set = (widgets: Widget[]) => setDraft({ ...draft, widgets });
  const patch = (id: string, p: Partial<Widget>) => set(draft.widgets.map((w) => (w.id === id ? { ...w, ...p, opts: { ...w.opts, ...(p.opts ?? {}) } } : w)));
  const move = (id: string, d: -1 | 1) => { const i = draft.widgets.findIndex((w) => w.id === id), j = i + d; if (j < 0 || j >= draft.widgets.length) return; const next = [...draft.widgets]; [next[i], next[j]] = [next[j], next[i]]; set(next); };
  const add = (type: WidgetType) => {
    const spec = widgetSpec(type)!;
    const existing = draft.widgets.find((w) => w.type === type);
    if (existing && !spec.multi) { patch(existing.id, { visible: true }); setAdding(false); return; }
    let id: string = type, n = 2;
    while (draft.widgets.some((w) => w.id === id)) id = `${type}_${n++}`;
    const base = defaultHomeLayout().widgets.find((w) => w.type === type)!;
    set([...draft.widgets, { ...base, id, visible: true }]);
    setAdding(false); setOpen(id);
  };
  async function save() {
    setBusy(true);
    try { await saveHomeLayout(draft); toast("已保存主頁布局"); onDraft?.(null); onClose(); }
    catch (e) { toast((e as Error).message, "err"); }
    finally { setBusy(false); }
  }
  const cancel = () => { onDraft?.(null); onClose(); };
  const body = (
    <div data-testid="home-editor" className="flex max-h-full flex-col">
      <div className="flex items-center gap-2 border-b border-gold/25 px-4 py-2.5">
        <h2 className="flex-1 font-serif text-[16px] font-bold text-gold-soft">主頁佈局</h2>
        <button type="button" onClick={() => { setDraft(defaultHomeLayout()); setOpen(null); }} data-testid="home-reset" className="chip h-8 rounded-full px-3 text-[12px]">還原預設</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <SortableList<Widget> items={draft.widgets} onReorder={(ids) => set(ids.map((id) => draft.widgets.find((w) => w.id === id)!))} className="space-y-1.5"
          render={(w, handle) => {
            const spec = widgetSpec(w.type)!;
            const i = draft.widgets.indexOf(w);
            return (
              <div className={`rounded-2xl border border-gold/25 ${w.visible ? "bg-cream/5" : "bg-cream/[0.02] opacity-60"}`} data-widget={w.id} data-visible={w.visible ? "1" : "0"}>
                <div className="flex items-center gap-1 px-1.5 py-1.5">
                  <span {...handle} className="grid h-9 w-8 shrink-0 place-items-center text-mauve"><IconGrip /></span>
                  <button type="button" onClick={() => setOpen(open === w.id ? null : w.id)} aria-expanded={open === w.id} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[13.5px]">{spec.label}{w.opts.category ? `｜${w.opts.category}` : ""}</span>
                    <span className="block truncate text-[10.5px] text-mauve">{w.visible ? (w.size === "compact" ? "緊湊" : "標準") : "已隱藏"}{w.opts.count ? `｜${w.opts.count} 項` : ""}</span>
                  </button>
                  <button type="button" aria-label="向上" data-move="up" disabled={i === 0} onClick={() => move(w.id, -1)} className="grid h-9 w-8 place-items-center text-[14px] disabled:opacity-30"><IconChevronUp /></button>
                  <button type="button" aria-label="向下" data-move="down" disabled={i === draft.widgets.length - 1} onClick={() => move(w.id, 1)} className="grid h-9 w-8 place-items-center text-[14px] disabled:opacity-30"><IconChevronDown /></button>
                  <button type="button" aria-label={w.visible ? "隱藏" : "顯示"} data-toggle={w.id} onClick={() => patch(w.id, { visible: !w.visible })} className="grid h-9 w-9 place-items-center text-[16px]">{w.visible ? <IconEye /> : <IconEyeOff />}</button>
                </div>
                {open === w.id && (
                  <div className="space-y-2 border-t border-gold/20 px-3 py-2.5 text-[12.5px]" data-widget-settings={w.id}>
                    <p className="text-[11px] text-mauve">{spec.hint}</p>
                    {w.type !== "cover" && <label className="flex items-center gap-2"><input type="checkbox" checked={w.opts.title !== false} onChange={(e) => patch(w.id, { opts: { title: e.target.checked } })} />顯示標題</label>}
                    <div className="flex items-center gap-2">大小
                      {(["compact", "standard"] as const).map((sz) => <button key={sz} type="button" aria-pressed={w.size === sz} onClick={() => patch(w.id, { size: sz })} className={`h-7 rounded-full px-3 ${w.size === sz ? "chip-on" : "chip"}`}>{sz === "compact" ? "緊湊" : "標準"}</button>)}
                    </div>
                    {spec.count !== undefined && <label className="flex items-center gap-2">顯示數量<input type="number" min={1} max={spec.maxCount} value={w.opts.count ?? spec.count} data-opt="count" onChange={(e) => patch(w.id, { opts: { count: Math.max(1, Math.min(spec.maxCount ?? 24, Number(e.target.value) || 1)) } })} className="field h-8 w-16 rounded-full px-2 text-center text-[14px]" /></label>}
                    {spec.sorts && <label className="flex items-center gap-2">{w.type === "analysis" ? "顯示內容" : "排序"}<select value={(w.type === "analysis" ? w.opts.mode : w.opts.sort) ?? spec.sorts[0][0]} data-opt="sort" onChange={(e) => patch(w.id, { opts: w.type === "analysis" ? { mode: e.target.value } : { sort: e.target.value } })} className="chip h-8 rounded-full bg-transparent px-2 text-[12.5px] text-cream">{spec.sorts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
                    {spec.category && <label className="flex items-center gap-2">分類篩選<select value={w.opts.category ?? ""} data-opt="category" onChange={(e) => patch(w.id, { opts: { category: e.target.value || undefined } })} className="chip h-8 rounded-full bg-transparent px-2 text-[12.5px] text-cream"><option value="">全部</option>{tax.categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>}
                    {spec.onlyWhen && <label className="flex items-center gap-2"><input type="checkbox" checked={!!w.opts.only_when_content} onChange={(e) => patch(w.id, { opts: { only_when_content: e.target.checked } })} />只在有內容時顯示</label>}
                    {w.type === "cover" && <>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={w.opts.show_name !== false} onChange={(e) => patch(w.id, { opts: { show_name: e.target.checked } })} />顯示衣櫃名稱</label>
                      <label className="flex items-center gap-2">名稱<input value={w.opts.name ?? ""} placeholder="我的衣櫃" maxLength={20} onChange={(e) => patch(w.id, { opts: { name: e.target.value } })} className="field h-8 flex-1 rounded-full px-3 text-[14px]" /></label>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={w.opts.show_stats !== false} onChange={(e) => patch(w.id, { opts: { show_stats: e.target.checked } })} />顯示統計資訊</label>
                      <label className="flex items-center gap-2">文字陰影<input type="range" min={0} max={0.9} step={0.05} value={w.opts.shade ?? 0.55} onChange={(e) => patch(w.id, { opts: { shade: Number(e.target.value) } })} className="flex-1" /></label>
                      <p className="text-[11px] text-mauve">背景圖片、比例、裁切位置、縮放及封面高度：在主頁按「背景」調整（原有背景保留）。</p>
                    </>}
                    {spec.multi && draft.widgets.filter((x) => x.type === w.type).length > 1 && <button type="button" onClick={() => set(draft.widgets.filter((x) => x.id !== w.id))} className="flex items-center gap-1 text-wine"><IconTrash />移除這個元件</button>}
                  </div>
                )}
              </div>
            );
          }} />
        {adding ? (
          <div className="mt-2 grid grid-cols-2 gap-1.5" data-testid="home-add-list">
            {WIDGETS.map((spec) => { const has = draft.widgets.find((w) => w.type === spec.type); const disabled = !!has && has.visible && !spec.multi; return <button key={spec.type} type="button" data-add={spec.type} disabled={disabled} onClick={() => add(spec.type)} className="chip rounded-2xl px-3 py-2 text-left text-[12px] disabled:opacity-35">{spec.label}{spec.multi && has ? "（再加一個）" : ""}</button>; })}
          </div>
        ) : <button type="button" data-testid="home-add" onClick={() => setAdding(true)} className="chip mt-2 h-10 w-full rounded-full text-[13px]">＋ 新增元件</button>}
      </div>
      <div className="flex gap-2 border-t border-gold/25 px-4 py-2.5" style={{ paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))" }}>
        <Button variant="ghost" onClick={cancel} disabled={busy}>取消</Button>
        <Button onClick={save} disabled={busy || !changed} data-testid="home-save" className="flex-1">{busy ? "保存中…" : "保存"}</Button>
      </div>
    </div>
  );
  if (inline) return <div className="frame overflow-hidden">{body}</div>;
  // 下半部彈層：上半部可以看到主頁即時預覽
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 mx-auto flex h-[58vh] max-w-5xl flex-col rounded-t-3xl border-t border-gold/50 shadow-2xl sheet-surface" role="dialog" aria-label="主頁佈局編輯器">
      {body}
    </div>
  );
}
