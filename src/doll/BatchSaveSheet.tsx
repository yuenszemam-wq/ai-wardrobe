// Phase 3.8A.1：一次保存全部衣物設定的確認清單。
// 只保存衣物／部件的校正預設（目前身體模型），不會建立或覆寫造型。
import { useMemo, useState } from "react";
import { Sheet } from "../components/ui";
import { BatchEntry, BatchState, STATE_LABEL } from "./batchSave";

export type BatchScope = "changed" | "set" | "all" | "custom";
const SCOPE_TEXT: Record<BatchScope, string> = { changed: "有修改或未校正", set: "目前套裝", all: "全部已穿", custom: "自行勾選" };
export interface BatchFailure { key: string; label: string; message: string }
export interface BatchResult { saved: string[]; failed: BatchFailure[] }

const STATE_TONE: Record<BatchState, string> = {
  modified: "bg-gold/20 text-gold-soft",
  uncalibrated: "bg-wine/40 text-cream",
  saved: "bg-cream/10 text-mauve",
  hidden: "bg-cream/10 text-mauve",
  blocked: "bg-black/30 text-mauve line-through",
};

export function BatchSaveSheet({ entries, bodyName, selectedGid, onSave, onClose, groupName, alsoLook }: {
  /** 「保存造型及全部衣物設定」：衣物設定全部成功後，再保存造型 */
  alsoLook?: boolean;
  entries: BatchEntry[];
  bodyName: string;
  /** 目前選中衣物所屬的衣物 id（「目前套裝」範圍） */
  selectedGid: string | null;
  groupName: (gid: string) => string;
  onSave: (keys: string[], layouts: string[]) => Promise<BatchResult>;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<BatchScope>("changed");
  const pick = (s: BatchScope): Set<string> => new Set(entries.filter((e) => e.state !== "blocked" && (s === "all" ? e.state !== "hidden" : s === "set" ? e.gid === selectedGid : e.defaultOn)).map((e) => e.key));
  const [on, setOn] = useState<Set<string>>(() => pick("changed"));
  // 有兩個或以上部件同時穿著的套裝：可以同時保存整套穿著配置
  const sets = useMemo(() => {
    const m = new Map<string, BatchEntry[]>();
    for (const e of entries) if (e.pieceId) m.set(e.gid, [...(m.get(e.gid) ?? []), e]);
    return [...m].filter(([, v]) => v.length >= 2).map(([gid]) => gid);
  }, [entries]);
  const [layouts, setLayouts] = useState<Set<string>>(() => new Set(sets));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BatchResult | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, BatchEntry[]>();
    for (const e of entries) m.set(e.gid, [...(m.get(e.gid) ?? []), e]);
    return [...m];
  }, [entries]);
  const chosen = entries.filter((e) => on.has(e.key) && e.state !== "blocked");
  const overwrites = chosen.filter((e) => e.overwrite).length;
  const applyScope = (s: BatchScope) => { setScope(s); if (s !== "custom") setOn(pick(s)); };
  const toggle = (k: string) => { setScope("custom"); setOn((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; }); };
  const run = async (keys: string[]) => {
    if (busy || (!keys.length && !layouts.size)) return;
    setBusy(true);
    try {
      const res = await onSave(keys, [...layouts].filter((gid) => keys.some((k) => entries.find((e) => e.key === k)?.gid === gid)));
      setResult(res);
      if (!res.failed.length) setOn(new Set());
      else setOn(new Set(res.failed.map((f) => f.key)));
    } finally { setBusy(false); }
  };

  return (
    <Sheet title={alsoLook ? "保存造型及全部衣物設定" : "一次保存全部衣物設定"} onClose={busy ? () => undefined : onClose}>
      <div data-testid="batch-sheet" className="space-y-3 text-[12.5px] text-cream">
        <p className="leading-snug text-mauve">目前身體：<b className="text-gold-soft" data-testid="batch-body">{bodyName}</b>｜{alsoLook ? "會同時執行兩種保存：先更新這個身體的衣物預設，全部成功後再保存目前造型。" : "只更新這個身體的衣物預設，不會建立或覆寫造型，其他身體模型不受影響。"}</p>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="保存範圍">
          {(["changed", "set", "all", "custom"] as BatchScope[]).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={scope === s} data-batch-scope={s} disabled={s === "set" && !selectedGid} onClick={() => applyScope(s)} className={`h-8 rounded-full px-3 text-[12px] disabled:opacity-40 ${scope === s ? "chip-on" : "chip"}`}>{SCOPE_TEXT[s]}</button>
          ))}
        </div>
        <div className="space-y-2" data-testid="batch-list">
          {groups.map(([gid, list]) => (
            <div key={gid} data-batch-group={gid} className="rounded-2xl bg-cream/5 p-2">
              <p className="mb-1 truncate px-1 text-[12px] font-bold text-gold-soft">{groupName(gid)}{list.some((e) => e.pieceId) ? `（${list.length} 個部件）` : ""}</p>
              {list.map((e) => (
                <label key={e.key} data-batch-item={e.key} data-state={e.state} className={`flex min-h-11 items-center gap-2 rounded-xl px-1.5 py-1 ${e.state === "blocked" ? "opacity-60" : ""}`}>
                  <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--aw-check)]" checked={on.has(e.key)} disabled={e.state === "blocked" || busy} onChange={() => toggle(e.key)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{e.pieceId ? e.label : "整件衣物"}</span>
                    {(e.reason || (e.overwrite && on.has(e.key))) && <span className="block text-[10.5px] leading-snug text-mauve">{e.reason ?? "會覆寫現有預設"}</span>}
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] ${STATE_TONE[e.state]}`}>{STATE_LABEL[e.state]}</span>
                </label>
              ))}
              {sets.includes(gid) && (
                <label className="mt-1 flex min-h-10 items-center gap-2 border-t border-gold/15 px-1.5 pt-1 text-[11.5px]">
                  <input type="checkbox" data-batch-layout={gid} className="h-5 w-5 shrink-0 accent-[var(--aw-check)]" checked={layouts.has(gid)} disabled={busy} onChange={() => setLayouts((cur) => { const n = new Set(cur); if (n.has(gid)) n.delete(gid); else n.add(gid); return n; })} />
                  <span className="leading-snug">同時保存整套穿著配置（部件的相對圖層次序及建議姿勢；不包括其他衣物）</span>
                </label>
              )}
            </div>
          ))}
        </div>
        {result && (
          <div role="status" data-testid="batch-result" data-saved={result.saved.length} data-failed={result.failed.length} className={`rounded-2xl px-3 py-2 leading-snug ${result.failed.length ? "bg-wine/40" : "bg-gold/15"}`}>
            {result.failed.length
              ? <>已保存 {result.saved.length} 項，<b>{result.failed.length} 項未保存</b>：{result.failed.map((f) => `${f.label}（${f.message}）`).join("；")}。未保存的編輯仍保留在畫面及本機草稿。</>
              : <>已保存 {result.saved.length} 項衣物設定。{alsoLook ? "造型亦已保存。" : <>造型本身<b>未被保存</b>，如需要請另外按「保存」。</>}</>}
          </div>
        )}
        <div className="sticky bottom-0 flex items-center gap-2 bg-inherit pt-1">
          <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-mauve" data-testid="batch-count">將保存 {chosen.length} 項{overwrites ? `，其中 ${overwrites} 項會覆寫現有預設` : ""}</span>
          {result?.failed.length ? <button type="button" data-testid="batch-retry" disabled={busy} onClick={() => void run(result.failed.map((f) => f.key))} className="chip h-10 rounded-full px-3 text-[12.5px]">只重試失敗項目</button> : null}
          <button type="button" data-testid="batch-confirm" disabled={busy || !chosen.length} onClick={() => void run(chosen.map((e) => e.key))} className="btn-jewel h-10 rounded-full px-4 text-[13px] disabled:opacity-50">{busy ? "保存中…" : `保存 ${chosen.length} 項`}</button>
        </div>
      </div>
    </Sheet>
  );
}
