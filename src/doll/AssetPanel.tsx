// 角色素材編輯面板：新增／修改頭部及髮型。在角色身上直接拖動、縮放校正位置，角色保持可見。
import { useRef } from "react";
import { HAIR_LAYER_LABEL, HairLayer, HairPart } from "../../shared/avatarV2";
import { IconChevronDown, IconChevronUp, IconPlus, IconTrash } from "../components/icons";
import { pill } from "./panels";

export interface Draft { id: string; isNew: boolean; kind: "hair" | "head"; name: string; category: string; parts: HairPart[]; sel: string | null }
const LAYERS: HairLayer[] = ["back", "mid", "front"];

export function AssetPanel({ draft, setDraft, busy, onFiles, onSave, onCancel, onDelete, hairTool, setHairTool }: { draft: Draft; setDraft: (d: Draft) => void; busy: boolean; onFiles: (files: File[]) => void; onSave: () => void; onCancel: () => void; onDelete: () => void; hairTool:"place"|"mesh"; setHairTool:(t:"place"|"mesh")=>void }) {
  const input = useRef<HTMLInputElement>(null);
  const part = draft.parts.find((p) => p.id === draft.sel) ?? null;
  const patch = (id: string, v: Partial<HairPart>) => setDraft({ ...draft, parts: draft.parts.map((p) => (p.id === id ? { ...p, ...v } : p)) });
  const scale = (p: HairPart, k: number) => patch(p.id, { x: p.x + (p.w * (1 - k)) / 2, y: p.y + (p.h * (1 - k)) / 2, w: p.w * k, h: p.h * k });
  const move = (id: string, d: number) => {
    const i = draft.parts.findIndex((p) => p.id === id), j = i + d;
    if (j < 0 || j >= draft.parts.length) return;
    const parts = [...draft.parts];
    [parts[i], parts[j]] = [parts[j], parts[i]];
    setDraft({ ...draft, parts });
  };
  const hair = draft.kind === "hair";
  return (
    <div className="flex h-full flex-col text-[12.5px]" data-testid="asset-panel">
      <div className="flex items-center gap-2 pb-2">
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={hair ? "髮型名稱" : "頭部名稱"} aria-label="素材名稱" data-testid="asset-name" className="h-9 min-w-0 flex-1 rounded-full bg-white px-3 text-[13px] text-ink ring-1 ring-gold focus:outline-none" />
        {hair && <input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="分類" aria-label="分類" className="h-9 w-20 rounded-full bg-white px-3 text-[13px] text-ink ring-1 ring-gold focus:outline-none" />}
        <button type="button" onClick={onCancel} className="chip h-9 rounded-full px-3">取消</button>
        <button type="button" disabled={busy || !draft.parts.length} data-testid="asset-save" onClick={onSave} className="btn-jewel h-9 rounded-full px-4 disabled:opacity-40">儲存</button>
      </div>
      <div className="scrollbar-none -mx-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2">
        <input ref={input} type="file" accept="image/png,image/webp" multiple={hair} hidden data-testid="asset-file" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ""; if (f.length) onFiles(f); }} />
        <div className="scrollbar-none -mx-3 flex gap-1.5 overflow-x-auto px-3 pb-2">
          <button type="button" disabled={busy} onClick={() => input.current?.click()} className="chip flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5"><IconPlus className="text-[12px]" />{busy ? "處理中…" : hair ? "加入透明圖（可多選）" : draft.parts.length ? "更換透明圖" : "選擇透明頭部圖"}</button>
          {hair && draft.parts.map((p) => <button key={p.id} type="button" data-part={p.id} onClick={() => setDraft({ ...draft, sel: p.id })} className={pill(draft.sel === p.id)}>{p.label}</button>)}
        </div>
        {!draft.parts.length && <p className="py-3 text-[11.5px] leading-relaxed text-mauve">{hair ? "上傳透明背景的髮型圖。只有一張圖也可以；有拆件（後髮、瀏海、側髮、馬尾…）的話可一次選多張，各自設定在身體前面或後面。" : "上傳透明背景的頭部圖（臉、妝容或表情）。頭部獨立於頭髮和身體，可隨時更換。"}上傳後在角色身上拖動及縮放，對好位置再儲存。</p>}
        {part && (
          <div className="rounded-2xl bg-white/5 p-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {hair && <input value={part.label} onChange={(e) => patch(part.id, { label: e.target.value.slice(0, 30) })} aria-label="部件名稱" className="h-8 w-24 rounded-full bg-white px-3 text-[12.5px] text-ink ring-1 ring-gold focus:outline-none" />}
              <button type="button" aria-label="放大" onClick={() => scale(part, 1.03)} className="chip grid h-8 w-8 place-items-center rounded-full">＋</button>
              <button type="button" aria-label="縮小" onClick={() => scale(part, 1 / 1.03)} className="chip grid h-8 w-8 place-items-center rounded-full">－</button>
              {(["←", "→", "↑", "↓"] as const).map((a, i) => <button key={a} type="button" aria-label={"微調" + a} onClick={() => patch(part.id, i < 2 ? { x: part.x + (i ? 3 : -3) } : { y: part.y + (i === 3 ? 3 : -3) })} className="chip grid h-8 w-8 place-items-center rounded-full">{a}</button>)}
              {hair && (
                <>
                  <button type="button" aria-label="圖層上移" onClick={() => move(part.id, 1)} className="chip grid h-8 w-8 place-items-center rounded-full"><IconChevronUp /></button>
                  <button type="button" aria-label="圖層下移" onClick={() => move(part.id, -1)} className="chip grid h-8 w-8 place-items-center rounded-full"><IconChevronDown /></button>
                  <button type="button" aria-label="刪除這個部件" onClick={() => setDraft({ ...draft, parts: draft.parts.filter((p) => p.id !== part.id), sel: null })} className="chip grid h-8 w-8 place-items-center rounded-full"><IconTrash /></button>
                </>
              )}
            </div>
            {hair && (
              <>
                <div className="mt-2 flex gap-1"><button type="button" className={pill(hairTool==="place")} onClick={()=>setHairTool("place")}>位置</button><button type="button" className={pill(hairTool==="mesh")} onClick={()=>setHairTool("mesh")}>變形</button><button type="button" className="chip rounded-full px-3" onClick={()=>patch(part.id,{mesh:undefined})}>重設變形</button></div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="part-layer">
                  <span className="text-[11px] text-mauve">位置</span>
                  {LAYERS.map((l) => <button key={l} type="button" data-layer={l} onClick={() => patch(part.id, { layer: l })} className={pill(part.layer === l)}>{HAIR_LAYER_LABEL[l]}</button>)}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-mauve">活動</span>
                  <button type="button" onClick={() => patch(part.id, { bone: "head", pivot: undefined, range: undefined })} className={pill(part.bone !== "own")}>跟隨頭部</button>
                  <button type="button" data-testid="part-own-bone" onClick={() => patch(part.id, { bone: "own", pivot: [part.x + part.w / 2, part.y + 8], range: part.range ?? 20 })} className={pill(part.bone === "own")}>獨立髮束（可在姿勢中擺動）</button>
                </div>
                {part.bone === "own" && <p className="mt-1.5 text-[11px] leading-snug text-mauve">髮束會以頂部中間為軸擺動；儲存後在「姿勢」拖動髮尾的圓點調整。</p>}
              </>
            )}
          </div>
        )}
      </div>
      {!draft.isNew && <button type="button" disabled={busy} onClick={onDelete} className="mt-1 self-start text-[11.5px] text-wine underline">刪除這個素材</button>}
    </div>
  );
}
