/**
 * AI 批量辨認：每批最多 limits.max_batch（≤10）件，逐件處理（一次只有一個模型請求）。
 * 顯示進度及成功／失敗／未處理數量；可取消尚未開始的項目；可單獨重試失敗項目。
 * 每件都經伺服器同一套權限、配額、驗證；到達上限即停止。
 */
import { useEffect, useRef, useState } from "react";
import { api, Garment } from "../api";
import { AiLabStatus, aiLabStatus, recognizeGarment } from "../aiLab";
import { Button, Sheet } from "./ui";

type State = "waiting" | "running" | "done" | "failed" | "cancelled";

export function AiBatchRecognize({ ids, onClose, onChanged }: { ids: string[]; onClose: () => void; onChanged: () => void }) {
  const [st, setSt] = useState<AiLabStatus | null>(null);
  const [rows, setRows] = useState<{ id: string; name: string; state: State; note?: string }[]>([]);
  const [running, setRunning] = useState(false);
  const cancel = useRef(false);
  useEffect(() => { aiLabStatus().then((s) => { setSt(s); setRows(ids.slice(0, s.limits.max_batch).map((id) => ({ id, name: id, state: "waiting" }))); }).catch(() => setSt(null)); }, [ids]);
  const patch = (id: string, p: Partial<{ state: State; note: string; name: string }>) => setRows((r) => r.map((x) => (x.id === id ? { ...x, ...p } : x)));
  async function runOne(id: string): Promise<boolean> {
    patch(id, { state: "running", note: "" });
    try {
      const g = await api<Garment>(`/api/garments/${id}`);
      patch(id, { name: g.name });
      const r = await recognizeGarment(g);
      patch(id, { state: r.ok === false ? "failed" : "done", note: r.cached ? "使用已有建議" : r.ok === false ? "AI 輸出不合格" : "已產生建議" });
      return true;
    } catch (e) {
      const msg = (e as Error).message || "失敗";
      patch(id, { state: "failed", note: msg });
      // 配額、停止開關：之後的項目不再開始
      return !/上限|預算|Kill|未開啟|停止|額度/.test(msg);
    }
  }
  async function start(only?: string[]) {
    setRunning(true); cancel.current = false;
    for (const r of rows) {
      if (only ? !only.includes(r.id) : r.state !== "waiting") continue;
      if (cancel.current) break;
      const cont = await runOne(r.id);
      if (!cont) break;
    }
    setRunning(false); onChanged();
  }
  if (!st) return null;
  const c = (s: State) => rows.filter((r) => r.state === s).length;
  return (
    <Sheet title="AI 批量辨認" onClose={() => { if (!running) onClose(); }}>
      <div className="space-y-2 p-1 text-[13px]" data-testid="ai-batch">
        {!st.active ? <p className="text-wine">{st.reason}</p> : <>
          <p className="text-mauve">每批最多 {st.limits.max_batch} 件，逐件處理。今日剩 {st.usage.remaining.requests_today} 次。{ids.length > st.limits.max_batch ? `已選 ${ids.length} 件，只處理前 ${st.limits.max_batch} 件。` : ""}</p>
          <p data-testid="ai-batch-counts">成功 {c("done")}｜失敗 {c("failed")}｜未處理 {c("waiting")}{c("cancelled") ? `｜已取消 ${c("cancelled")}` : ""}</p>
          <ul className="max-h-[40vh] space-y-1 overflow-auto">{rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2" data-batch-item={r.id} data-state={r.state}>
              <span className="truncate">{r.name}</span>
              <span className="shrink-0 text-[12px]">{({ waiting: "等待", running: "辨認中…", done: "完成", failed: "失敗", cancelled: "已取消" } as const)[r.state]}{r.note ? `｜${r.note}` : ""}
                {r.state === "failed" && !running && <button type="button" className="chip ml-1 rounded-full px-2" onClick={() => void start([r.id])}>重試</button>}
                {r.state === "waiting" && <button type="button" className="chip ml-1 rounded-full px-2" onClick={() => patch(r.id, { state: "cancelled" })}>取消</button>}
              </span>
            </li>))}</ul>
          <div className="flex gap-2">
            <Button disabled={running || !c("waiting")} onClick={() => void start()} data-testid="ai-batch-start">{running ? "處理中…" : "開始"}</Button>
            {running && <Button variant="ghost" onClick={() => { cancel.current = true; }}>停止（不再開始下一件）</Button>}
            {!running && <Button variant="ghost" onClick={onClose}>關閉</Button>}
          </div>
          <p className="text-[11px] text-mauve">AI 建議只會放入「待確認」，不會直接修改正式衣物資料；每次呼叫（包括重試）都計入配額。</p>
        </>}
      </div>
    </Sheet>
  );
}
