/**
 * 「AI 自動辨認／重新辨認」按鈕：只在 AI Lab 可使用時顯示。結果進入「AI 待整理」，由使用者確認才寫入正式資料。
 */
import { useEffect, useState } from "react";
import { Garment } from "../api";
import { AiLabStatus, aiLabStatus, recognizeGarment } from "../aiLab";
import { navigate } from "../router";
import { toast } from "./ui";

let cached: Promise<AiLabStatus | null> | null = null;
const status = () => (cached ??= aiLabStatus().catch(() => null));

export function AiRecognizeButton({ g, onDone }: { g: Garment; onDone: () => void }) {
  const [st, setSt] = useState<AiLabStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; status().then((s) => live && setSt(s)); return () => { live = false; }; }, []);
  if (!st?.active || g.status === "archived") return null;
  const hasAi = Boolean(g.ai_status && g.ai_status !== "pending_ai");
  const run = async (force: boolean) => {
    if (force && !confirm(`重新辨認會再呼叫 AI 一次並消耗額度（今日剩 ${st.usage.remaining.requests_today} 次）。繼續？`)) return;
    setBusy(true);
    try {
      const r = await recognizeGarment(g, { force });
      cached = null;
      if (r.cached) toast("已有相同圖片的 AI 建議（沒有再次消耗額度）");
      else if (r.ok === false) toast("AI 輸出不合格，已標示需要手動整理", "err");
      else toast("AI 建議已放入「AI 待整理」，確認後才會寫入");
      onDone();
    } catch (e) { toast((e as Error).message || "AI 辨認失敗", "err"); }
    finally { setBusy(false); }
  };
  return (
    <span className="inline-flex gap-1" data-testid="ai-recognize">
      <button type="button" disabled={busy} onClick={() => void run(false)} className="chip min-h-9 rounded-full px-3.5 text-[13px] disabled:opacity-50" data-testid="ai-recognize-run">{busy ? "AI 辨認中…" : "AI 自動辨認"}</button>
      {hasAi && <button type="button" disabled={busy} onClick={() => void run(true)} className="chip min-h-9 rounded-full px-3 text-[12px] disabled:opacity-50" data-testid="ai-recognize-force">重新辨認</button>}
      {g.ai_status === "pending_review" && <button type="button" onClick={() => navigate("/?tab=pending_review#todo")} className="chip min-h-9 rounded-full px-3 text-[12px]">查看 AI 建議</button>}
    </span>
  );
}
