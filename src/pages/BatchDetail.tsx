import { WardrobeImage } from "../components/WardrobeImage";
import { useEffect, useState } from "react";
import { api, Batch, formatDate, imageUrl, Job, STATUS_LABEL, uploadImage } from "../api";
import { Button, Link, PageTitle, ProgressBar, Spinner, toast } from "../components/ui";
import { makeThumbnail, prepareForUpload } from "../imageProcessing";
import { CopyBlock } from "./ImportCenter";

const STATUS_TONE: Record<string, string> = {
  done: "bg-amethyst/15 text-amethyst-deep",
  review: "bg-rose text-ink",
  failed: "bg-wine/15 text-wine",
  awaiting_image: "bg-ink/10 text-ink",
};

export default function BatchDetail({ id }: { id: string }) {
  const [data, setData] = useState<{ batch: Batch; jobs: Job[] } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const load = () => api<{ batch: Batch; jobs: Job[] }>(`/api/import/batches/${id}`).then(setData).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    // AI 匯入進行中時自動更新
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (err) return <p className="py-10 text-center text-wine">{err}</p>;
  if (!data) return <Spinner />;
  const { batch, jobs } = data;

  async function act(jobId: string, action: "approve" | "reject" | "retry") {
    if (action === "reject" && !confirm("拒絕會刪除這項衣物及其圖片，確定？")) return;
    setBusy(jobId);
    try {
      await api(`/api/import/jobs/${jobId}`, { method: "POST", json: { action } });
      toast(action === "approve" ? "已確認入庫" : action === "reject" ? "已拒絕並刪除" : "可重新上傳圖片");
      await load();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  }

  async function upload(job: Job, file: File) {
    setBusy(job.id);
    try {
      const prepared = await prepareForUpload(file);
      const res = await uploadImage("/api/images/upload", { job_id: job.id, image_type: job.kind === "outfit" ? "original" : "processed" }, prepared.blob, prepared.filename);
      try { if (job.garment_id) {
        const thumb = await makeThumbnail(prepared.blob);
        await uploadImage("/api/images/upload", { garment_id: job.garment_id, image_type: "thumbnail", derived_from: res.id }, thumb, "thumb.webp");
      } } catch { /* Original is saved; thumbnail failure is independent. */ }
      toast(res.warnings?.[0] || "已上傳", res.warnings?.length ? "err" : "ok");
      await load();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(null);
    }
  }

  const missing = jobs.filter((j) => j.status === "awaiting_image" || j.status === "failed").length;
  const reviewJobs = jobs.filter((j) => j.status === "review");

  return (
    <div>
      <div className="pt-4">
        <Link to="/import" className="text-[14px] text-amethyst-deep">‹ 匯入中心</Link>
      </div>
      <PageTitle>匯入批次</PageTitle>
      <div className="rounded-3xl bg-rose-soft p-4">
        <div className="flex justify-between text-[14px]">
          <span>{batch.source}｜{formatDate(batch.created_at)}</span>
          <span className="text-amethyst-deep">{STATUS_LABEL[batch.status]}</span>
        </div>
        <div className="mt-3"><ProgressBar value={batch.total_images ? batch.processed_count / batch.total_images : 0} /></div>
        <div className="mt-2 grid grid-cols-4 text-center text-[12px]">
          <Stat n={batch.total_images} label="總數" />
          <Stat n={batch.success_count} label="完成" />
          <Stat n={batch.review_count} label="待確認" />
          <Stat n={batch.failed_count} label="失敗" />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {reviewJobs.length > 0 && (
            <Button
              disabled={!!busy}
              onClick={async () => {
                if (!confirm(`把 ${reviewJobs.length} 項待確認全部入庫？`)) return;
                for (const j of reviewJobs) await api(`/api/import/jobs/${j.id}`, { method: "POST", json: { action: "approve" } }).catch(() => {});
                toast("已全部入庫");
                load();
              }}
            >
              全部確認入庫
            </Button>
          )}
          {missing > 0 && (
            <Button
              variant="ghost"
              onClick={async () => {
                try {
                  const r = await api<{ url: string }>(`/api/import/batches/${id}/upload-link`, { method: "POST", json: { minutes: 120 } });
                  setLink(r.url);
                } catch (e) {
                  toast((e as Error).message, "err");
                }
              }}
            >
              產生上傳連結
            </Button>
          )}
          {batch.status === "open" && (
            <Button
              variant="ghost"
              onClick={async () => {
                if (missing && !confirm(`仍有 ${missing} 項未有圖片，完成後會標記為失敗（之後仍可重試）。確定？`)) return;
                await api(`/api/import/batches/${id}/finalize`, { method: "POST" });
                toast("批次已完成");
                load();
              }}
            >
              完成批次
            </Button>
          )}
        </div>
        {link && <CopyBlock text={link} dark={false} />}
      </div>

      <ul className="mt-5 space-y-3">
        {jobs.map((j) => (
          <li key={j.id} className="flex gap-3 rounded-2xl bg-white p-3 ring-1 ring-ink/5">
            <div className="arch relative h-24 w-[4.5rem] shrink-0 overflow-hidden">
              {j.preview_image_id && <WardrobeImage src={imageUrl(j.preview_image_id)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain p-1.5 pt-3" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <Link to={j.garment_id ? `/g/${j.garment_id}` : j.outfit_id ? `/outfits/${j.outfit_id}` : "#"} className="min-w-0 truncate text-[14px] font-medium">
                  {j.garment_name || j.outfit_name || j.label || j.client_key}
                </Link>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${STATUS_TONE[j.status]}`}>{STATUS_LABEL[j.status]}</span>
              </div>
              <div className="mt-0.5 text-[12px] text-mauve">
                {j.kind === "outfit" ? "整套穿搭（需人工拆分）" : j.label}
                {j.retry_count > 0 ? `｜重試 ${j.retry_count} 次` : ""}
              </div>
              {j.error_message && <div className="mt-1 text-[12px] text-wine">{j.error_message}</div>}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                {j.status === "review" && (
                  <button type="button" disabled={busy === j.id} onClick={() => act(j.id, "approve")} className="text-amethyst-deep">確認入庫</button>
                )}
                {(j.status === "awaiting_image" || j.status === "failed") && (
                  <label className={`cursor-pointer text-amethyst-deep ${busy === j.id ? "opacity-40" : ""}`}>
                    {busy === j.id ? "上傳中…" : "上傳圖片"}
                    <input type="file" accept="image/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(j, f); e.target.value = ""; }} />
                  </label>
                )}
                {j.status === "failed" && (
                  <button type="button" disabled={busy === j.id} onClick={() => act(j.id, "retry")} className="text-amethyst-deep">標記重新處理</button>
                )}
                {j.status !== "done" && (
                  <button type="button" disabled={busy === j.id} onClick={() => act(j.id, "reject")} className="text-wine">拒絕</button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <div className="font-serif text-lg font-bold">{n}</div>
      <div className="text-mauve">{label}</div>
    </div>
  );
}
