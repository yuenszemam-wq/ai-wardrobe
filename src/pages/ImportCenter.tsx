import { useEffect, useState } from "react";
import { api, Batch, formatDate, STATUS_LABEL } from "../api";
import { Link, PageTitle, ProgressBar, toast } from "../components/ui";
import UploadCenter from "./UploadCenter";

export const AI_COMMAND =
  "請整理電子衣櫃的待處理衣物：用 AI Wardrobe 的 list_pending_garments 取得清單，逐件用 get_garment_image 實際查看圖片後分析名稱、類別、子類別、風格、顏色、印花、裝飾細節及季節；不清楚就留空並列入 uncertain_fields，不要猜。品牌只有找到官方或可靠來源才標為 confirmed 並附連結，印花一致但版本未能區分標 likely，只是風格相似標 unconfirmed。每件用 submit_ai_suggestion 提交（附 base_version 及 idempotency_key）。完成後告訴我處理了幾件、哪些辨認失敗。";

export default function ImportCenter() {
  const [batches, setBatches] = useState<Batch[]>([]);
  useEffect(() => {
    api<{ batches: Batch[] }>("/api/import/batches?limit=15").then((r) => setBatches(r.batches)).catch(() => undefined);
  }, []);

  return (
    <div>
      <PageTitle>上傳及匯入</PageTitle>

      <UploadCenter />

      <section className="mt-6 rounded-3xl bg-ink p-4 text-rose">
        <h2 className="font-serif text-lg font-bold">請 AI 整理待處理衣物</h2>
        <p className="mt-1 text-[13px] text-rose/80">
          上傳完成後，在已連接 AI Wardrobe 的 Claude（或 ChatGPT）對話中貼上以下指令。AI 只會提交建議，要你在主頁「待整理」確認後才正式寫入。
        </p>
        <CopyBlock text={AI_COMMAND} />
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
          <Link to="/?tab=todo#todo" className="text-rose underline decoration-amethyst underline-offset-4">前往主頁「待整理」</Link>
          <Link to="/settings" className="text-rose underline decoration-amethyst underline-offset-4">設定 AI 連接</Link>
        </div>
      </section>

      <section className="mt-7">
        <h2 className="mb-3 font-serif text-lg font-bold">舊有匯入批次</h2>
        {batches.length === 0 ? (
          <p className="text-sm text-mauve">仍未有匯入批次。</p>
        ) : (
          <ul className="space-y-2">
            {batches.map((b) => (
              <li key={b.id}>
                <Link to={`/import/${b.id}`} className="block rounded-2xl bg-white p-3 ring-1 ring-ink/5">
                  <div className="flex items-center justify-between text-[14px]">
                    <span className="font-medium">{b.source}｜{formatDate(b.created_at)}</span>
                    <span className={`text-[12px] ${b.status === "open" ? "text-amethyst-deep" : "text-mauve"}`}>{STATUS_LABEL[b.status]}</span>
                  </div>
                  <div className="mt-2"><ProgressBar value={b.total_images ? b.processed_count / b.total_images : 0} /></div>
                  <div className="mt-1.5 text-[12px] text-mauve">
                    共 {b.total_images}｜完成 {b.success_count}｜待確認 {b.review_count}｜失敗 {b.failed_count}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function CopyBlock({ text, dark = true }: { text: string; dark?: boolean }) {
  return (
    <div className={`mt-3 rounded-2xl p-3 text-[13px] leading-relaxed ${dark ? "bg-velvet text-rose" : "bg-white ring-1 ring-ink/10"}`}>
      <p className="break-all">{text}</p>
      <button
        type="button"
        className={`mt-2 text-[13px] ${dark ? "text-rose underline decoration-amethyst" : "text-amethyst-deep underline"} underline-offset-4`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast("已複製");
          } catch {
            toast("未能自動複製，請長按文字複製", "err");
          }
        }}
      >
        複製
      </button>
    </div>
  );
}
