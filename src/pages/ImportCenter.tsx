import { useEffect, useRef, useState } from "react";
import { CATEGORIES, STYLES } from "../../shared/taxonomy";
import { api, Batch, formatDate, STATUS_LABEL, uploadImage } from "../api";
import { Button, Field, inputCls, Link, PageTitle, ProgressBar, toast } from "../components/ui";
import { fileKey, hasTransparency, makeThumbnail, prepareForUpload } from "../imageProcessing";

type ItemState = "waiting" | "uploading" | "done" | "warning" | "failed";
interface Item {
  file: File;
  key: string;
  preview: string;
  state: ItemState;
  progress: number;
  message?: string;
  jobId?: string;
  garmentId?: string;
}

const CONCURRENCY = 2;

export default function ImportCenter() {
  const [items, setItems] = useState<Item[]>([]);
  const [imageType, setImageType] = useState<"auto" | "processed" | "original">("auto");
  const [category, setCategory] = useState("");
  const [style, setStyle] = useState("");
  const [running, setRunning] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  useEffect(() => {
    api<{ batches: Batch[] }>("/api/import/batches?limit=15").then((r) => setBatches(r.batches));
  }, [running]);

  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

  function update(key: string, patch: Partial<Item>) {
    setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  async function pick(files: FileList | null) {
    if (!files?.length) return;
    const added: Item[] = [];
    for (const f of Array.from(files)) {
      const key = await fileKey(f);
      if (itemsRef.current.some((i) => i.key === key) || added.some((i) => i.key === key)) continue; // 同一張相不重複加入
      added.push({ file: f, key, preview: URL.createObjectURL(f), state: "waiting", progress: 0 });
    }
    setItems((cur) => [...cur, ...added]);
  }

  async function processOne(item: Item, bid: string) {
    update(item.key, { state: "uploading", progress: 0, message: undefined });
    try {
      let jobId = item.jobId;
      let garmentId = item.garmentId;
      if (!jobId) {
        const res = await api<{ results: { ok: boolean; job_id: string; garment_id: string; error?: string }[] }>(
          `/api/import/batches/${bid}/items`,
          {
            method: "POST",
            json: {
              items: [
                {
                  client_key: item.key,
                  label: item.file.name,
                  needs_review: true,
                  garment: {
                    name: item.file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "新衣物",
                    category: category || undefined,
                    style: style || undefined,
                    uncertain_fields: [category ? "" : "category", style ? "" : "style"].filter(Boolean),
                  },
                },
              ],
            },
          },
        );
        const r = res.results[0];
        if (!r.ok) throw new Error(r.error || "建立失敗");
        jobId = r.job_id;
        garmentId = r.garment_id;
        update(item.key, { jobId, garmentId });
      }
      const prepared = await prepareForUpload(item.file);
      let type = imageType;
      if (type === "auto") type = (await hasTransparency(prepared.blob)) ? "processed" : "original";
      const img = await uploadImage("/api/images/upload", { job_id: jobId!, image_type: type }, prepared.blob, prepared.filename, (p) =>
        update(item.key, { progress: p * 0.92 }),
      );
      const thumb = await makeThumbnail(prepared.blob);
      await uploadImage("/api/images/upload", { garment_id: garmentId!, image_type: "thumbnail", derived_from: img.id }, thumb, "thumb.webp");
      update(item.key, {
        state: img.warnings?.length ? "warning" : "done",
        progress: 1,
        message: img.warnings?.[0] || `${img.width}×${img.height}${img.deduplicated ? "（已存在）" : ""}`,
      });
    } catch (e) {
      update(item.key, { state: "failed", message: (e as Error).message });
    }
  }

  async function run(onlyFailed = false) {
    if (running) return;
    setRunning(true);
    try {
      let bid = batchId;
      if (!bid) {
        const r = await api<{ batch: Batch }>("/api/import/batches", { method: "POST", json: { source: "app", note: `App 上傳 ${items.length} 張` } });
        bid = r.batch.id;
        setBatchId(bid);
      }
      const queue = itemsRef.current.filter((i) => (onlyFailed ? i.state === "failed" : i.state === "waiting" || i.state === "failed"));
      let idx = 0;
      const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (idx < queue.length) {
          const it = queue[idx++];
          await processOne(it, bid!);
        }
      });
      await Promise.all(workers);
      const failed = itemsRef.current.filter((i) => i.state === "failed").length;
      if (failed) toast(`${failed} 張未能上傳，可按「重試失敗項目」`, "err");
      else toast("全部上傳完成，請到批次頁確認分類");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setRunning(false);
    }
  }

  const done = items.filter((i) => i.state === "done" || i.state === "warning").length;
  const failed = items.filter((i) => i.state === "failed").length;
  const waiting = items.filter((i) => i.state === "waiting").length;

  return (
    <div>
      <PageTitle>AI 匯入中心</PageTitle>

      <section className="rounded-3xl bg-rose-soft p-4">
        <h2 className="font-serif text-lg font-bold">在 App 直接上傳</h2>
        <p className="mt-1 text-[13px] text-mauve">高清原檔會完整保存，系統另外產生縮圖。上傳後衣物會放在「待確認」，可之後由你或 AI 補上分類。</p>

        <label className={`mt-4 flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-amethyst/40 bg-white px-4 py-5 text-center ${running ? "pointer-events-none opacity-50" : ""}`}>
          <span className="text-[15px] font-medium text-amethyst-deep">選擇相片（可多選）</span>
          <span className="mt-1 text-[12px] text-mauve">支援 PNG、JPEG、WebP、iPhone HEIC</span>
          <input type="file" accept="image/*" multiple className="sr-only" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
        </label>

        {items.length > 0 && (
          <>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <Field label="圖片類型">
                <select className={inputCls} value={imageType} onChange={(e) => setImageType(e.target.value as never)} disabled={running}>
                  <option value="auto">自動判斷</option>
                  <option value="processed">去背圖</option>
                  <option value="original">原相</option>
                </select>
              </Field>
              <Field label="主類別">
                <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)} disabled={running}>
                  <option value="">稍後再定</option>
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="風格">
                <select className={inputCls} value={style} onChange={(e) => setStyle(e.target.value)} disabled={running}>
                  <option value="">稍後再定</option>
                  {STYLES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </Field>
            </div>

            <ul className="mt-4 space-y-2">
              {items.map((i) => (
                <li key={i.key} className="flex items-center gap-3 rounded-2xl bg-white p-2 pr-3">
                  <img src={i.preview} alt="" className="checker h-14 w-11 shrink-0 rounded-lg object-contain" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]">{i.file.name}</div>
                    {i.state === "uploading" ? (
                      <div className="mt-1.5"><ProgressBar value={i.progress} /></div>
                    ) : (
                      <div className={`mt-0.5 truncate text-[12px] ${i.state === "failed" ? "text-wine" : i.state === "warning" ? "text-amethyst-deep" : "text-mauve"}`}>
                        {i.state === "waiting" ? "等待上傳" : i.state === "done" ? `完成　${i.message ?? ""}` : i.message}
                      </div>
                    )}
                  </div>
                  {i.state === "waiting" && !running && (
                    <button type="button" aria-label="移除" className="px-2 text-mauve" onClick={() => setItems((c) => c.filter((x) => x.key !== i.key))}>
                      ×
                    </button>
                  )}
                  {i.state === "done" && i.garmentId && <Link to={`/g/${i.garmentId}`} className="text-[12px] text-amethyst-deep">查看</Link>}
                </li>
              ))}
            </ul>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button onClick={() => run(false)} disabled={running || (waiting === 0 && failed === 0)}>
                {running ? `上傳中（${done}/${items.length}）` : `開始上傳 ${waiting + failed} 張`}
              </Button>
              {failed > 0 && !running && (
                <Button variant="ghost" onClick={() => run(true)}>重試失敗項目</Button>
              )}
              {batchId && !running && done > 0 && (
                <Link to={`/import/${batchId}`} className="text-[14px] text-amethyst-deep underline underline-offset-4">
                  到批次頁確認分類
                </Link>
              )}
            </div>
          </>
        )}
      </section>

      <section className="mt-6 rounded-3xl bg-ink p-4 text-rose">
        <h2 className="font-serif text-lg font-bold">用 ChatGPT／Claude 匯入</h2>
        <p className="mt-1 text-[13px] text-rose/80">
          先在「設定」產生 AI 連接網址，加入 ChatGPT 或 Claude 的自訂連接器。之後在對話上傳最多約 10 張衣物相，再這樣說：
        </p>
        <CopyBlock
          text={"請用 AI Wardrobe 工具匯入這批衣物：逐張識別分類（不確定就標記待確認，不要猜），去背後以最高解像度上傳，真人穿搭照存為穿搭。完成後用 get_import_status 核實。"}
        />
        <Link to="/settings" className="mt-3 inline-block text-[14px] text-rose underline decoration-amethyst underline-offset-4">
          前往設定 AI 連接
        </Link>
      </section>

      <section className="mt-7">
        <h2 className="mb-3 font-serif text-lg font-bold">最近的匯入批次</h2>
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
