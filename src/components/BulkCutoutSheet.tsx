import { useRef, useState } from "react";
import { Garment, displayName } from "../api";
import { cutoutSource, hasCutout, loadGarment, runCutout, saveCutout } from "../cutoutFlow";
import { Button, ProgressBar, Sheet } from "./ui";

type State = "waiting" | "working" | "done" | "skipped" | "failed" | "cancelled";
interface Job { id: string; name: string; state: State; note?: string }
const LABEL: Record<State, string> = { waiting: "等候", working: "處理中", done: "已去背", skipped: "略過", failed: "失敗", cancelled: "已取消" };

/** 批量手動去背：使用者按「開始」才處理；逐件執行，可取消未開始的工作及個別重試。原圖永遠保留。 */
export function BulkCutoutSheet({ garments, onClose }: { garments: Garment[]; onClose: (changed: boolean) => void }) {
  const [jobs, setJobs] = useState<Job[]>(() => garments.map((g) => ({ id: g.id, name: displayName(g), state: "waiting" })));
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const changed = useRef(false);
  const set = (id: string, v: Partial<Job>) => setJobs((cur) => cur.map((j) => (j.id === id ? { ...j, ...v } : j)));
  async function one(id: string) {
    set(id, { state: "working", note: undefined });
    try {
      const g = await loadGarment(id);
      if (hasCutout(g)) return set(id, { state: "skipped", note: "已有去背圖" });
      const src = cutoutSource(g);
      if (!src) return set(id, { state: "skipped", note: "沒有可去背的原相" });
      const r = await runCutout(src);
      if (!r.ok) return set(id, { state: r.transparent ? "skipped" : "failed", note: r.note });
      try { await saveCutout(g, src, r.blob); } finally { URL.revokeObjectURL(r.url); }
      changed.current = true;
      set(id, { state: "done" });
    } catch (e) { set(id, { state: "failed", note: (e as Error).message }); }
  }
  async function start(ids: string[]) {
    stop.current = false; setRunning(true);
    for (const id of ids) {
      if (stop.current) { setJobs((cur) => cur.map((j) => (j.state === "waiting" ? { ...j, state: "cancelled" } : j))); break; }
      await one(id);
    }
    setRunning(false);
  }
  const count = (s: State) => jobs.filter((j) => j.state === s).length;
  const finished = jobs.filter((j) => !["waiting", "working"].includes(j.state)).length;
  return (
    <Sheet title={`批量去背（${jobs.length} 件）`} onClose={() => { if (!running) onClose(changed.current); }}>
      <div className="p-4" data-testid="bulk-cutout">
        <ProgressBar value={jobs.length ? finished / jobs.length : 0} />
        <p className="mt-2 text-[12px] text-mauve" data-testid="bulk-cutout-summary">成功 {count("done")}｜失敗 {count("failed")}｜略過 {count("skipped")}{count("cancelled") ? `｜已取消 ${count("cancelled")}` : ""}</p>
        <ul className="mt-3 max-h-[45vh] space-y-1.5 overflow-y-auto">
          {jobs.map((j) => (
            <li key={j.id} data-job={j.id} data-state={j.state} className="flex items-center gap-2 rounded-xl bg-cream/5 px-3 py-2 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate">{j.name}</span>
              <span className={j.state === "failed" ? "text-wine" : "text-mauve"}>{LABEL[j.state]}{j.note ? `：${j.note}` : ""}</span>
              {(j.state === "failed" || j.state === "cancelled") && !running && <button type="button" className="chip h-7 rounded-full px-2 text-[11.5px]" onClick={() => void start([j.id])}>重試</button>}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          {!running && count("waiting") > 0 && <Button data-testid="bulk-cutout-start" onClick={() => void start(jobs.filter((j) => j.state === "waiting").map((j) => j.id))}>開始去背</Button>}
          {running && <Button variant="ghost" onClick={() => { stop.current = true; }}>取消未開始的工作</Button>}
          {!running && <Button variant="ghost" onClick={() => onClose(changed.current)}>完成</Button>}
        </div>
        <p className="mt-3 text-[11px] text-mauve">只處理沒有去背圖的衣物；原圖永遠保留。已經是透明背景的圖片會略過。</p>
      </div>
    </Sheet>
  );
}
