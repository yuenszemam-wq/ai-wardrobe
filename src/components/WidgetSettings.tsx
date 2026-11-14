// 主頁元件的獨立設定（Phase 3.8A／3.8A.1）。主頁原位編輯及設定頁列表編輯共用，資料由 shared/homeLayout 驗證。
import { OVERVIEW_DEFAULT, OVERVIEW_ITEMS, QUICK_DEFAULT, QUICK_ITEMS, Widget, WidgetOpts, widgetSpec } from "../../shared/homeLayout";
import { useTaxonomy } from "../taxonomy";
import { IconChevronDown, IconChevronUp, IconTrash } from "./icons";

/** 可選項目及次序（概覽統計、快捷入口） */
function ItemPicker({ all, value, onChange, testid }: { all: [string, string][]; value: string[]; onChange: (v: string[]) => void; testid: string }) {
  const rest = all.filter(([k]) => !value.includes(k));
  const label = (k: string) => all.find(([x]) => x === k)?.[1] ?? k;
  const move = (i: number, d: -1 | 1) => { const j = i + d; if (j < 0 || j >= value.length) return; const n = [...value]; [n[i], n[j]] = [n[j], n[i]]; onChange(n); };
  return (
    <div className="space-y-1" data-testid={testid}>
      {value.map((k, i) => (
        <div key={k} className="flex items-center gap-1 rounded-xl bg-white/5 py-0.5 pl-2 pr-1" data-item={k}>
          <label className="flex min-h-9 flex-1 items-center gap-2"><input type="checkbox" checked disabled={value.length <= 1} onChange={() => onChange(value.filter((x) => x !== k))} />{label(k)}</label>
          <button type="button" aria-label={`${label(k)} 上移`} data-item-move="up" disabled={i === 0} onClick={() => move(i, -1)} className="grid h-9 w-8 place-items-center disabled:opacity-30"><IconChevronUp /></button>
          <button type="button" aria-label={`${label(k)} 下移`} data-item-move="down" disabled={i === value.length - 1} onClick={() => move(i, 1)} className="grid h-9 w-8 place-items-center disabled:opacity-30"><IconChevronDown /></button>
        </div>
      ))}
      {rest.map(([k, l]) => (
        <label key={k} className="flex min-h-9 items-center gap-2 rounded-xl px-2 text-mauve" data-item={k}><input type="checkbox" checked={false} onChange={() => onChange([...value, k])} />{l}</label>
      ))}
    </div>
  );
}

export function WidgetSettings({ w, onPatch, onRemove }: { w: Widget; onPatch: (p: Partial<Widget>) => void; onRemove?: () => void }) {
  const spec = widgetSpec(w.type)!;
  const tax = useTaxonomy();
  const opts = (o: WidgetOpts) => onPatch({ opts: o });
  const subs = w.opts.category ? tax.categories.find((c) => c.name === w.opts.category)?.subs.map((s) => s.name) ?? [] : [];
  const sel = "chip h-8 rounded-full bg-transparent px-2 text-[12.5px] text-cream";
  return (
    <div className="space-y-2.5 text-[12.5px] text-cream" data-widget-settings={w.id}>
      <p className="text-[11px] text-mauve">{spec.hint}</p>
      {w.type !== "cover" && <label className="flex items-center gap-2"><input type="checkbox" checked={w.opts.title !== false} onChange={(e) => opts({ title: e.target.checked })} />顯示標題</label>}
      <div className="flex items-center gap-2">大小
        {(["compact", "standard"] as const).map((sz) => <button key={sz} type="button" aria-pressed={w.size === sz} data-size={sz} onClick={() => onPatch({ size: sz })} className={`h-8 rounded-full px-3 ${w.size === sz ? "chip-on" : "chip"}`}>{sz === "compact" ? "緊湊" : "標準"}</button>)}
      </div>
      {spec.count !== undefined && <label className="flex items-center gap-2">顯示數量<input type="number" min={1} max={spec.maxCount} value={w.opts.count ?? spec.count} data-opt="count" onChange={(e) => opts({ count: Math.max(1, Math.min(spec.maxCount ?? 24, Number(e.target.value) || 1)) })} className="field h-8 w-16 rounded-full px-2 text-center text-[14px]" /></label>}
      {spec.sorts && <label className="flex items-center gap-2">{w.type === "analysis" ? "分析類型" : "排序"}<select value={(w.type === "analysis" ? w.opts.mode : w.opts.sort) ?? spec.sorts[0][0]} data-opt="sort" onChange={(e) => opts(w.type === "analysis" ? { mode: e.target.value } : { sort: e.target.value })} className={sel}>{spec.sorts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
      {spec.category && <label className="flex items-center gap-2">主分類<select value={w.opts.category ?? ""} data-opt="category" onChange={(e) => opts({ category: e.target.value || undefined, subcategory: undefined })} className={sel}><option value="">全部</option>{tax.categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select></label>}
      {spec.category && subs.length > 0 && <label className="flex items-center gap-2">子分類<select value={w.opts.subcategory ?? ""} data-opt="subcategory" onChange={(e) => opts({ subcategory: e.target.value || undefined })} className={sel}><option value="">全部</option>{subs.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>}
      {spec.category && w.type !== "favorites" && <label className="flex items-center gap-2"><input type="checkbox" data-opt="favorite" checked={!!w.opts.favorite} onChange={(e) => opts({ favorite: e.target.checked })} />只顯示收藏</label>}
      {spec.category && <div className="flex items-center gap-2">顯示
        {([[false, "簡潔"], [true, "詳細"]] as const).map(([d, l]) => <button key={l} type="button" aria-pressed={!!w.opts.detail === d} onClick={() => opts({ detail: d })} className={`h-8 rounded-full px-3 ${!!w.opts.detail === d ? "chip-on" : "chip"}`}>{l}</button>)}
      </div>}
      {spec.onlyWhen && <label className="flex items-center gap-2"><input type="checkbox" checked={!!w.opts.only_when_content} onChange={(e) => opts({ only_when_content: e.target.checked })} />只在有內容時顯示</label>}
      {w.type === "overview" && <><p className="text-[11.5px] text-gold-soft">顯示的統計及次序</p><ItemPicker testid="overview-items" all={OVERVIEW_ITEMS} value={w.opts.items ?? OVERVIEW_DEFAULT} onChange={(v) => opts({ items: v })} /></>}
      {w.type === "quick" && <><p className="text-[11.5px] text-gold-soft">顯示的功能及次序</p><ItemPicker testid="quick-items" all={QUICK_ITEMS} value={w.opts.items ?? QUICK_DEFAULT} onChange={(v) => opts({ items: v })} /></>}
      {w.type === "analysis" && <>
        <div className="flex items-center gap-2">圖表
          {([["donut", "圓環"], ["bars", "長條"]] as const).map(([c, l]) => <button key={c} type="button" data-chart={c} aria-pressed={(w.opts.chart ?? "auto") === c} onClick={() => opts({ chart: c })} className={`h-8 rounded-full px-3 ${w.opts.chart === c ? "chip-on" : "chip"}`}>{l}</button>)}
        </div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={w.opts.show_pct !== false} onChange={(e) => opts({ show_pct: e.target.checked })} />顯示比例</label>
      </>}
      {w.type === "cover" && <>
        <label className="flex items-center gap-2"><input type="checkbox" checked={w.opts.show_name !== false} onChange={(e) => opts({ show_name: e.target.checked })} />顯示衣櫃名稱</label>
        <label className="flex items-center gap-2">名稱<input value={w.opts.name ?? ""} placeholder="我的衣櫃" maxLength={20} onChange={(e) => opts({ name: e.target.value })} className="field h-8 flex-1 rounded-full px-3 text-[14px]" /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={w.opts.show_stats !== false} onChange={(e) => opts({ show_stats: e.target.checked })} />顯示統計資訊</label>
        <label className="flex items-center gap-2">文字漸層<input type="range" min={0} max={0.9} step={0.05} value={w.opts.shade ?? 0.55} onChange={(e) => opts({ shade: Number(e.target.value) })} className="flex-1" /></label>
        <label className="flex items-center gap-2">封面高度<input type="range" data-opt="height" min={30} max={140} step={2} value={w.opts.height ?? 78} onChange={(e) => opts({ height: Number(e.target.value) })} className="flex-1" /><button type="button" onClick={() => opts({ height: undefined })} className="chip h-7 rounded-full px-2 text-[11px]">跟隨背景</button></label>
        <div className="flex items-center gap-2">文字位置
          {([["top", "上方"], ["bottom", "下方"]] as const).map(([p, l]) => <button key={p} type="button" aria-pressed={(w.opts.text_pos ?? "bottom") === p} onClick={() => opts({ text_pos: p })} className={`h-8 rounded-full px-3 ${(w.opts.text_pos ?? "bottom") === p ? "chip-on" : "chip"}`}>{l}</button>)}
        </div>
        <p className="text-[11px] text-mauve">背景圖片、圖片比例、裁切位置及縮放：在封面按「背景」調整（原有背景保留）。</p>
      </>}
      {onRemove && <button type="button" onClick={onRemove} className="flex items-center gap-1 text-wine"><IconTrash />移除這個元件</button>}
    </div>
  );
}
