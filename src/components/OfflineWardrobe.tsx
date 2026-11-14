// Phase 3.8B：設定 →「離線衣櫃」。同步狀態、本機容量、離線下載（可暫停／取消）、容量及 R2 讀取估算。
import { useEffect, useState } from "react";
import { clearImageCaches, imageCacheUsage } from "../imageCache";
import { localDataBytes, localGarments, storageEstimate, syncWardrobe } from "../localWardrobe";
import { JobState, Plan, cancelJob, currentJob, onJob, pauseJob, planAssets, planHd, planThumbs, retryFailed, startJob } from "../offlineDownloads";
import { useTaxonomy } from "../taxonomy";
import { timeAgo, useLocalStatus } from "./OfflineBanner";
import { Button, Sheet, toast } from "./ui";

const mb = (b: number | null | undefined) => (b == null ? "—" : b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB");

export function OfflineWardrobe() {
  const s = useLocalStatus();
  const tax = useTaxonomy();
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof imageCacheUsage>> | null>(null);
  const [est, setEst] = useState<Awaited<ReturnType<typeof storageEstimate>> | null>(null);
  const [job, setJob] = useState<JobState | null>(currentJob);
  const [plan, setPlan] = useState<{ title: string; kind: "thumbs" | "hd" | "assets"; plan: Plan } | null>(null);
  const [cat, setCat] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = () => { void imageCacheUsage().then(setUsage); void storageEstimate().then(setEst); };
  useEffect(() => { reload(); return onJob((j) => { setJob(j); if (j?.finished) reload(); }); }, []);
  const garments = localGarments() ?? [];
  async function prepare(kind: "thumbs" | "hd" | "assets", title: string, filter?: (g: (typeof garments)[number]) => boolean) {
    if (!navigator.onLine) { toast("目前離線：連線後才可以下載", "err"); return; }
    setBusy(true);
    try { setPlan({ title, kind, plan: kind === "thumbs" ? planThumbs() : kind === "assets" ? await planAssets() : await planHd(filter ?? (() => true)) }); }
    catch (e) { toast((e as Error).message, "err"); } finally { setBusy(false); }
  }
  async function sync(full: boolean) {
    setBusy(true);
    try { const r = await syncWardrobe({ full }); toast(r.same ? "已是最新資料" : `已同步：更新 ${r.changed} 件、移除 ${r.removed} 件（共 ${r.total} 件）`); }
    catch (e) { toast(`同步失敗：${(e as Error).message}（已保留本機資料）`, "err"); } finally { setBusy(false); reload(); }
  }
  const running = job && !job.finished;
  return (
    <div className="space-y-3 text-[13px]" data-testid="offline-wardrobe">
      <section className="frame space-y-2 p-4" data-testid="offline-status" data-count={s.count}>
        <div className="grid grid-cols-2 gap-2 text-center">
          <Stat label="已同步衣物" value={`${s.count} 件`} />
          <Stat label="最後同步" value={timeAgo(s.lastSync)} />
          <Stat label="本機衣物資料" value={mb(localDataBytes())} />
          <Stat label="縮圖" value={usage ? `${usage.thumbs.count} 張｜${mb(usage.thumbs.bytes)}` : "…"} />
          <Stat label="高清圖片" value={usage ? `${usage.hd.count} 張｜${mb(usage.hd.bytes)}` : "…"} />
          <Stat label="角色素材" value={usage ? `${usage.assets.count} 個｜${mb(usage.assets.bytes)}` : "…"} />
        </div>
        <p className="text-[11.5px] text-mauve">瀏覽器總用量：{mb(est?.usage)}{est?.quota ? `／可用約 ${mb(est.quota)}` : ""}{est?.persisted === false ? "｜iOS 可能在空間不足或長時間未使用時清除網站資料；清除後重新開啟會自動重新同步。" : est?.persisted ? "｜已要求長期保存" : ""}</p>
        {s.error && <p className="rounded-xl bg-danger/25 px-3 py-1.5 text-[12px] text-danger-ink" data-status-color>上次同步失敗：{s.error}（已保留本機資料）</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" disabled={busy || s.syncing} data-testid="sync-now" onClick={() => void sync(false)}>{s.syncing ? "同步中…" : "立即同步"}</Button>
          <Button variant="ghost" disabled={busy || s.syncing} data-testid="sync-full" onClick={() => { if (confirm("重新下載全部衣物資料？（只是文字資料，不會清除圖片快取）")) void sync(true); }}>完整重新同步</Button>
          {est?.persisted === false && <Button variant="ghost" onClick={async () => { const ok = await navigator.storage?.persist?.(); toast(ok ? "瀏覽器已同意長期保存" : "瀏覽器未同意（iOS 可能不支援）", ok ? "ok" : "err"); reload(); }}>要求長期保存</Button>}
        </div>
      </section>

      <section className="frame space-y-2 p-4" data-testid="offline-downloads">
        <h3 className="font-serif text-[15px] text-gold-soft">離線下載</h3>
        <p className="text-[11.5px] text-mauve">高清圖片及角色素材不會自動全部下載；開始前會顯示容量及 R2 讀取估算。下載的項目會「指定保留」，普通清理不會刪除。</p>
        <div className="grid grid-cols-1 gap-1.5">
          <Button variant="ghost" disabled={busy || !!running || !garments.length} data-dl="thumbs" onClick={() => void prepare("thumbs", "下載全部衣物縮圖")}>只下載全部衣物縮圖</Button>
          <Button variant="ghost" disabled={busy || !!running || !garments.length} data-dl="fav" onClick={() => void prepare("hd", "下載收藏衣物高清圖", (g) => g.is_favorite)}>下載收藏衣物高清圖</Button>
          <div className="flex gap-1.5">
            <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="分類" className="chip h-11 min-w-0 flex-1 rounded-full bg-transparent px-3 text-[13px]" data-testid="dl-category"><option value="">選擇分類…</option>{tax.categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}</select>
            <Button variant="ghost" disabled={busy || !!running || !cat} data-dl="category" onClick={() => void prepare("hd", `下載「${cat}」高清圖`, (g) => g.category === cat)}>下載分類高清圖</Button>
          </div>
          <Button variant="ghost" disabled={busy || !!running || !garments.length} data-dl="all" onClick={() => void prepare("hd", "下載全部衣物高清圖")}>下載全部衣物高清圖</Button>
          <Button variant="ghost" disabled={busy || !!running} data-dl="assets" onClick={() => void prepare("assets", "下載角色頭部及髮件素材")}>下載角色及髮件素材</Button>
          <Button variant="ghost" disabled={busy || !!running} data-dl="clean" onClick={async () => { if (!confirm("清理未指定保留的高清圖片？已指定保留的離線圖片及縮圖不受影響。")) return; const r = await clearImageCaches({ thumbs: false, hd: true, includePinned: false }); toast(`已清理 ${r.hd.count} 張（${mb(r.hd.bytes)}）；保留 ${r.keptPinned} 張`); reload(); }}>清理未指定保留的快取</Button>
        </div>
        {job && <JobView job={job} />}
        <p className="text-[11px] text-mauve">檢查及補充缺失或損壞的圖片：設定 →「本機圖片快取」→「檢查及修復快取」。</p>
      </section>

      {plan && (
        <Sheet title={plan.title} onClose={() => setPlan(null)}>
          <div className="space-y-2 text-[13px]" data-testid="dl-plan" data-download={plan.plan.toDownload}>
            <p>共 {plan.plan.items.length} 項；手機已有 {plan.plan.cached} 項，需要下載 <b>{plan.plan.toDownload}</b> 項。</p>
            <p>預計下載容量：約 <b data-testid="dl-bytes">{mb(plan.plan.estBytes)}</b></p>
            <p>Cloudflare R2 讀取：約 <b>{plan.plan.r2Reads}</b> 次 Class B 操作{plan.kind === "thumbs" ? "（縮圖保存在 D1，不經 R2）" : "（每月免費 1,000 萬次，帳戶共用；這只是估算）"}</p>
            <p className="text-[11.5px] text-mauve">下載期間可以暫停或取消；已下載的項目會保留。</p>
            <div className="flex gap-2"><Button variant="ghost" onClick={() => setPlan(null)}>取消</Button><Button className="flex-1" data-testid="dl-start" disabled={!plan.plan.items.length} onClick={() => { startJob(plan.kind, plan.title, plan.plan.items); setPlan(null); }}>開始下載</Button></div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-xl bg-cream/5 p-2"><p className="font-serif text-[15px] text-gold-soft">{value}</p><p className="text-[10.5px] text-mauve">{label}</p></div>; }
function JobView({ job }: { job: JobState }) {
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 100;
  return (
    <div className="rounded-2xl bg-cream/5 p-3 text-[12.5px]" data-testid="dl-job" data-done={job.done} data-total={job.total} data-failed={job.failed.length} data-finished={job.finished ? "1" : "0"} data-paused={job.paused ? "1" : "0"}>
      <div className="flex items-center justify-between"><span>{job.label}</span><span className="tabular-nums">{job.done}／{job.total}</span></div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-cream/10"><div className="h-full rounded-full" style={{ width: pct + "%", background: "var(--aw-chart)" }} /></div>
      <p className="mt-1 text-[11px] text-mauve">已下載 {(job.bytes / 1048576).toFixed(1)} MB{job.skipped ? `｜已在手機 ${job.skipped} 項` : ""}{job.failed.length ? `｜失敗 ${job.failed.length} 項` : ""}{job.cancelled ? "｜已取消（未開始的項目沒有下載）" : job.finished ? "｜完成" : job.paused ? "｜已暫停" : "｜下載中"}</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {!job.finished && <button type="button" data-testid="dl-pause" onClick={() => pauseJob(!job.paused)} className="chip h-8 rounded-full px-3">{job.paused ? "繼續" : "暫停"}</button>}
        {!job.finished && <button type="button" data-testid="dl-cancel" onClick={cancelJob} className="chip h-8 rounded-full px-3">取消</button>}
        {job.finished && job.failed.length > 0 && <button type="button" data-testid="dl-retry" onClick={() => retryFailed()} className="chip h-8 rounded-full px-3">重試失敗項目</button>}
      </div>
      {job.failed.length > 0 && <ul className="mt-1 max-h-28 overflow-y-auto text-[11px] text-mauve">{job.failed.slice(0, 20).map((f) => <li key={f.item.key} className="flex items-center justify-between gap-2"><span className="truncate">{f.item.label}：{f.message}</span>{job.finished && <button type="button" className="underline" onClick={() => retryFailed(f.item)}>重試</button>}</li>)}</ul>}
    </div>
  );
}
