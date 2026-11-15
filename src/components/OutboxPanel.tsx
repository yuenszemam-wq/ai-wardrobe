// Phase 3.8C：待同步操作（離線修改、離線上傳、離線保存的造型）。顯示狀態、重試、衝突處理及捨棄。
import { useEffect, useMemo, useState } from "react";
import { OutboxOp, discard, flushOutbox, onOutbox, overwrite, retry, saveAsCopy } from "../outbox";
import { Button, Sheet } from "./ui";

export function useOutbox(): OutboxOp[] { const [ops, set] = useState<OutboxOp[]>([]); useEffect(() => onOutbox(set), []); return ops; }

const STATE: Record<OutboxOp["state"], string> = { pending: "等待同步", sending: "同步中…", failed: "未能同步", conflict: "版本衝突" };
function Thumb({ op }: { op: OutboxOp }) {
  const f = op.files?.thumb ?? op.files?.file;
  const url = useMemo(() => (f && /^image\//.test(f.type) ? URL.createObjectURL(new Blob([f.buf], { type: f.type })) : null), [f]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url ? <img src={url} alt="" className="h-10 w-8 shrink-0 rounded-lg object-cover" /> : <span className="grid h-10 w-8 shrink-0 place-items-center rounded-lg bg-cream/10 text-[14px]">⇅</span>;
}

/** 頁面頂部的小提示：有待同步操作時顯示（離線或連線都會顯示） */
export function OutboxBar() {
  const ops = useOutbox();
  const [open, setOpen] = useState(false);
  if (!ops.length) return null;
  const bad = ops.filter((o) => o.state === "conflict" || o.state === "failed").length;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`mb-2 flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-[12px] ${bad ? "bg-wine/25 text-cream" : "bg-head text-gold-soft"}`} data-testid="outbox-bar" data-count={ops.length} data-bad={bad}>
        <span>{bad ? `${bad} 項需要處理・` : ""}{ops.length} 項修改等待同步{navigator.onLine ? "" : "（離線，連線後自動同步）"}</span><span className="text-mauve">查看</span>
      </button>
      {open && <OutboxSheet ops={ops} onClose={() => setOpen(false)} />}
    </>
  );
}

export function OutboxSheet({ ops, onClose }: { ops: OutboxOp[]; onClose: () => void }) {
  return (
    <Sheet title="等待同步" onClose={onClose}>
      <div className="space-y-2 text-[12.5px]" data-testid="outbox-sheet">
        <p className="text-[11.5px] text-mauve">這些修改已保存在這部手機，連線後會按次序自動上傳。重送不會重複建立。</p>
        {ops.map((o) => (
          <div key={o.id} className="rounded-2xl p-2 chip" data-op={o.id} data-op-kind={o.kind} data-op-state={o.state}>
            <div className="flex items-center gap-2">
              <Thumb op={o} />
              <div className="min-w-0 flex-1"><div className="truncate font-bold">{o.label}</div><div className={`text-[11px] ${o.state === "conflict" || o.state === "failed" ? "text-wine" : "opacity-75"}`}>{STATE[o.state]}{o.attempts ? `・已嘗試 ${o.attempts} 次` : ""}{o.error ? `・${o.error}` : ""}</div></div>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {o.state === "conflict" && <>
                <Button variant="ghost" onClick={() => void overwrite(o.id)} data-op-action="overwrite">用我的修改覆寫</Button>
                {(o.kind === "outfit.save" || o.kind === "look.save") && <Button variant="ghost" onClick={() => void saveAsCopy(o.id)} data-op-action="copy">另存副本</Button>}
              </>}
              {(o.state === "failed" || o.state === "pending") && <Button variant="ghost" onClick={() => void retry(o.id)} data-op-action="retry">立即重試</Button>}
              <Button variant="ghost" className="text-wine" onClick={() => { if (confirm("捨棄這項未同步的修改？依賴它的操作亦會一併捨棄。")) void discard(o.id); }} data-op-action="discard">捨棄</Button>
            </div>
          </div>
        ))}
        <Button className="w-full" disabled={!navigator.onLine} onClick={() => void flushOutbox()} data-testid="outbox-flush">{navigator.onLine ? "立即同步" : "離線中"}</Button>
      </div>
    </Sheet>
  );
}
