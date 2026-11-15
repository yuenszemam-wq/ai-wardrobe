/**
 * 設定 › AI Lab／AI 實驗室（只限登入的擁有者；伺服器亦會檢查）。
 * 顯示開關、Provider、模型、Binding、今日／本月用量、剩餘額度、預計成本；可測試連線（會計入配額）、Kill Switch、設定更低上限。
 * 不展示任何 API Key、Cloudflare Token 或私人圖片網址。
 */
import { useEffect, useState } from "react";
import { AiLabEvent, AiLabStatus, aiLabAcceptLicense, aiLabEvents, aiLabSettings, aiLabStatus, aiLabTest } from "../aiLab";
import { Button, Spinner, toast } from "./ui";

const STATUS_TEXT: Record<string, string> = { success: "成功", invalid_output: "輸出不合格", failed: "失敗", timeout: "逾時", uncertain: "不確定（保留預算）", blocked: "被配額阻擋", reserved: "處理中" };

export function AiLabPanel() {
  const [st, setSt] = useState<AiLabStatus | null>(null);
  const [err, setErr] = useState("");
  const [events, setEvents] = useState<AiLabEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [lim, setLim] = useState({ daily: "", monthly: "", neurons: "" });
  const load = () => aiLabStatus().then((s) => { setSt(s); setLim({ daily: s.settings.daily_limit?.toString() ?? "", monthly: s.settings.monthly_limit?.toString() ?? "", neurons: s.settings.neuron_budget?.toString() ?? "" }); }).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);
  if (err) return <p role="alert" className="frame p-4 text-[13px] text-wine">{err}</p>;
  if (!st) return <Spinner />;
  const save = async (body: Parameters<typeof aiLabSettings>[0], msg: string) => { setBusy(true); try { await aiLabSettings(body); toast(msg); await load(); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); } };
  const num = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.floor(Number(v)) || 0));
  const u = st.usage;
  const row = (k: string, v: React.ReactNode, id?: string) => <div className="flex justify-between gap-3 py-1 text-[13px]" data-ai-row={id}><span className="text-mauve">{k}</span><span className="text-right">{v}</span></div>;
  return (
    <div className="space-y-3" data-testid="ai-lab-panel">
      <section className="frame p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-[16px] font-bold">AI 實驗室</h2>
          <span className={`rounded-full px-3 py-1 text-[12px] ${st.active ? "chip-on" : "chip"}`} data-testid="ai-lab-state">{st.active ? "可使用" : "未啟用"}</span>
        </div>
        {!st.active && st.reason && <p className="mt-1 text-[12px] text-wine" data-testid="ai-lab-reason">{st.reason}</p>}
        <div className="mt-2 divide-y divide-[color-mix(in_srgb,var(--aw-line)_25%,transparent)]">
          {row("伺服器設定", st.server_enabled ? "已允許" : "未允許（AI_LAB_ENABLED=false）")}
          {row("Provider／模型", <span className="break-all">{st.provider}｜{st.model}</span>)}
          {row("Prompt 版本", st.prompt_version)}
          {row("AI Binding", st.binding ? "可用" : "不可用", "binding")}
          {row("環境", st.environment ?? "—")}
          {row("Meta Llama 3.2 授權", st.license ? `已接受（${new Date(st.license.accepted_at).toLocaleString("zh-HK")}）` : "未在此 App 記錄", "license")}
        </div>
        {!st.license && st.server_enabled && st.binding && (
          <div className="mt-2 rounded-2xl bg-[color-mix(in_srgb,var(--aw-line)_10%,transparent)] p-3 text-[12px]">
            <p>首次使用模型前須接受 Meta 的 <a className="underline" href="https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE" target="_blank" rel="noreferrer">Llama 3.2 License</a> 及 <a className="underline" href="https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/USE_POLICY.md" target="_blank" rel="noreferrer">Acceptable Use Policy</a>。按下後會向模型送出官方的 "agree" 請求。</p>
            <Button className="mt-2" disabled={busy} data-testid="ai-lab-license" onClick={async () => {
              if (!confirm("確認接受 Meta Llama 3.2 License 及 Acceptable Use Policy？")) return;
              setBusy(true);
              try { await aiLabAcceptLicense(); toast("已接受授權"); await load(); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
            }}>接受 Meta Llama 3.2 授權</Button>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={busy || !st.server_enabled} onClick={() => void save({ enabled: !st.settings.enabled }, st.settings.enabled ? "已關閉 AI Lab" : "已開啟 AI Lab")} data-testid="ai-lab-toggle">{st.settings.enabled ? "關閉 AI Lab" : "開啟 AI Lab"}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void save({ killed: !st.settings.killed }, st.settings.killed ? "已解除緊急停止" : "已緊急停止所有新 AI 請求")} data-testid="ai-lab-kill">{st.settings.killed ? "解除緊急停止" : "緊急停止（Kill Switch）"}</Button>
          <Button variant="ghost" disabled={busy || !st.active} data-testid="ai-lab-test" onClick={async () => {
            if (!confirm("測試連線會實際呼叫模型一次，並計入今日配額。繼續？")) return;
            setBusy(true);
            try { const r = await aiLabTest(); toast(`連線成功（${r.latency_ms} ms）`); await load(); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
          }}>測試 AI 連線</Button>
        </div>
      </section>

      <section className="frame p-4" data-testid="ai-lab-usage">
        <h3 className="mb-1 text-[14px] font-semibold">用量（UTC {u.day}）</h3>
        {row("今日呼叫", `${u.today.requests} / ${st.limits.daily_requests}（剩 ${u.remaining.requests_today}）`, "today")}
        {row("今日 Neurons（預留＋結算）", `${u.today.neurons} / ${st.limits.daily_neurons}（剩 ${u.remaining.neurons_today}）`, "neurons")}
        {row("本月呼叫", `${u.month_requests} / ${st.limits.monthly_requests}`)}
        {row("今日成功／失敗", `${u.today.success}／${u.today.failed}`)}
        {row("平均處理時間", u.avg_latency_ms ? `${(u.avg_latency_ms / 1000).toFixed(1)} 秒` : "—")}
        {row("本月估算 Neurons", `${u.month_neurons}`)}
        {row("如按價計費（本月）", `約 US$${u.month_cost_usd_if_billed.toFixed(4)}`)}
        {row("最近一次使用", u.last_used_at ? new Date(u.last_used_at).toLocaleString("zh-HK") : "—")}
        {st.pricing && <p className="mt-2 text-[11px] text-mauve">價格：輸入 {st.pricing.input_neurons_per_m.toLocaleString()} neurons／百萬 tokens、輸出 {st.pricing.output_neurons_per_m.toLocaleString()} neurons／百萬 tokens、US${st.pricing.usd_per_1k_neurons}／1,000 neurons（{st.pricing.version}）。付費用量：{st.limits.paid_usage ? "已允許" : "禁止"}。</p>}
        {st.notes.map((n) => <p key={n} className="mt-1 text-[11px] text-mauve">{n}</p>)}
      </section>

      <section className="frame p-4">
        <h3 className="mb-2 text-[14px] font-semibold">設定更低上限（留空＝使用伺服器上限）</h3>
        {([["daily", "每日呼叫次數", st.limits.daily_requests], ["monthly", "每月呼叫次數", st.limits.monthly_requests], ["neurons", "每日 Neuron 預算", st.limits.daily_neurons]] as const).map(([k, label, cur]) => (
          <label key={k} className="mb-2 flex items-center gap-2 text-[13px]"><span className="w-32 shrink-0">{label}</span>
            <input inputMode="numeric" value={lim[k]} placeholder={`目前 ${cur}`} onChange={(e) => setLim((l) => ({ ...l, [k]: e.target.value.replace(/[^\d]/g, "") }))} className="min-w-0 flex-1 rounded-xl bg-[color-mix(in_srgb,var(--aw-line)_12%,transparent)] px-3 py-2" data-testid={`ai-lab-limit-${k}`} /></label>
        ))}
        <Button variant="ghost" disabled={busy} onClick={() => void save({ daily_limit: num(lim.daily), monthly_limit: num(lim.monthly), neuron_budget: num(lim.neurons) }, "已更新上限（不會高於伺服器上限）")} data-testid="ai-lab-save-limits">儲存上限</Button>
      </section>

      <section className="frame p-4">
        <div className="flex items-center justify-between"><h3 className="text-[14px] font-semibold">測試紀錄</h3><button type="button" className="chip h-8 rounded-full px-3 text-[12px]" onClick={() => aiLabEvents().then(setEvents).catch((e) => toast((e as Error).message, "err"))} data-testid="ai-lab-events">載入</button></div>
        {events && (events.length ? <ul className="mt-2 space-y-1 text-[12px]">{events.map((e) => (
          <li key={e.request_id} className="flex justify-between gap-2"><span>{new Date(e.created_at).toLocaleString("zh-HK")}｜{e.operation_type === "test" ? "測試" : e.operation_type === "retry" ? "重試" : "辨認"}</span><span>{STATUS_TEXT[e.request_status] ?? e.request_status}｜{(e.actual_neurons ?? e.estimated_neurons ?? 0).toFixed(1)} N{e.usage_source === "estimate" ? "（估算）" : ""}</span></li>
        ))}</ul> : <p className="mt-2 text-[12px] text-mauve">未有紀錄</p>)}
        <p className="mt-2 text-[11px] text-mauve">模型辨認準確度需要以人工答案（ground truth）測試集量度，尚未建立。</p>
      </section>
    </div>
  );
}
