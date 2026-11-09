import { DragEvent, useEffect, useRef, useState } from "react";
import { ApiError, formatBytes, intakeUpload } from "../api";
import { Button, Link, ProgressBar, toast } from "../components/ui";
import { fileKey, prepareIntake } from "../imageProcessing";
import { navigate } from "../router";

/**
 * 批量上傳：一張相＝一件「待整理衣物」。
 * - 每批最多 30 張；同時上傳 3 張，減少 iPhone 記憶體壓力。
 * - 原檔原樣上傳（不縮小、不重新壓縮）；瀏覽器另外產生縮圖、AI 辨認圖、HEIC 預覽。
 * - 伺服器以 SHA-256 核對及去重：重試或重選同一張相不會重複建立。
 */

const MAX_FILES = 30;
const CONCURRENCY = 3;
const ACCEPT = "image/*,.heic,.heif,image/heic,image/heif";

type ItemState = "waiting" | "preparing" | "uploading" | "done" | "duplicate" | "failed";
interface Item {
  file: File;
  key: string;
  preview: string;
  state: ItemState;
  progress: number;
  message?: string;
  garmentId?: string;
  name?: string;
}

const STATE_TEXT: Record<ItemState, string> = {
  waiting: "等待上傳",
  preparing: "準備中（計算校驗碼）",
  uploading: "上傳中",
  done: "已保存",
  duplicate: "衣櫃已有這張相",
  failed: "失敗",
};

export default function UploadCenter() {
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const runningRef = useRef(false);

  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

  // 上傳途中離開頁面前提醒
  useEffect(() => {
    if (!running) return;
    const on = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [running]);

  function update(key: string, patch: Partial<Item>) {
    setItems((cur) => cur.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  async function pick(list: FileList | File[] | null) {
    if (!list || !list.length) return;
    const files = Array.from(list).filter((f) => f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
    const room = MAX_FILES - itemsRef.current.filter((i) => i.state !== "done" && i.state !== "duplicate").length;
    if (files.length > room) toast(`每批最多 ${MAX_FILES} 張，已加入前 ${Math.max(room, 0)} 張`, "err");
    const added: Item[] = [];
    for (const f of files.slice(0, Math.max(room, 0))) {
      const key = await fileKey(f);
      if (itemsRef.current.some((i) => i.key === key) || added.some((i) => i.key === key)) continue; // 同一張相不重複加入
      added.push({ file: f, key, preview: URL.createObjectURL(f), state: "waiting", progress: 0 });
    }
    setItems((cur) => [...cur.filter((i) => i.state !== "done" && i.state !== "duplicate"), ...added]);
  }

  async function uploadOne(item: Item) {
    update(item.key, { state: "preparing", progress: 0, message: undefined });
    try {
      const p = await prepareIntake(item.file);
      update(item.key, { state: "uploading" });
      let lastErr: unknown;
      // 網絡中斷自動重試 2 次；伺服器以 SHA-256 去重，不會重複建立
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await intakeUpload(
            { file: p.original, filename: p.filename, sha256: p.sha256, preview: p.preview, thumbnail: p.thumbnail, analysis: p.analysis },
            (ratio) => update(item.key, { progress: ratio * 0.97 }),
          );
          const dims = `${r.image.width}×${r.image.height}`;
          update(item.key, {
            state: r.duplicate ? "duplicate" : "done",
            progress: 1,
            garmentId: r.garment_id,
            name: r.name,
            message: `${r.name}｜${dims}｜${formatBytes(r.image.file_size)}${p.isHeif ? "｜HEIC 原檔" : ""}${p.warning ? `｜${p.warning}` : ""}${r.warnings[0] && !r.duplicate ? `｜${r.warnings[0]}` : ""}`,
          });
          return;
        } catch (e) {
          lastErr = e;
          const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429);
          if (!retryable) break;
          await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        }
      }
      throw lastErr;
    } catch (e) {
      update(item.key, { state: "failed", progress: 0, message: (e as Error).message });
    }
  }

  async function run() {
    if (runningRef.current) return; // 防止重複提交
    runningRef.current = true;
    setRunning(true);
    try {
      const queue = itemsRef.current.filter((i) => i.state === "waiting" || i.state === "failed");
      let idx = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          while (idx < queue.length) await uploadOne(queue[idx++]);
        }),
      );
      const cur = itemsRef.current;
      const failed = cur.filter((i) => i.state === "failed").length;
      const ok = cur.filter((i) => i.state === "done").length;
      if (failed) toast(`${failed} 張未能上傳，其他已保存；可按「重試失敗項目」`, "err");
      else if (ok) {
        toast(`已保存 ${ok} 件，已加入主頁「待整理」`);
        setTimeout(() => navigate("/?tab=pending_ai#todo"), 900);
      } else toast("這些相片衣櫃已經有了");
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!running) pick(e.dataTransfer.files);
  }

  const total = items.length;
  const finished = items.filter((i) => i.state === "done" || i.state === "duplicate").length;
  const failed = items.filter((i) => i.state === "failed").length;
  const pending = items.filter((i) => i.state === "waiting" || i.state === "failed").length;
  const batchProgress = total ? items.reduce((s, i) => s + (i.state === "done" || i.state === "duplicate" ? 1 : i.progress), 0) / total : 0;

  return (
    <section className="rounded-3xl bg-rose-soft p-4">
      <h2 className="font-serif text-lg font-bold">上傳中心</h2>
      <p className="mt-1 text-[13px] text-mauve">
        一張相＝一件衣物。原檔完整保存（HEIC 亦保留），系統另外產生縮圖。上傳後自動放入主頁「待整理」，再請 ChatGPT／Claude 一次整理。
      </p>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`mt-4 flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dragging ? "border-amethyst bg-rose" : "border-amethyst/40 bg-white"
        } ${running ? "pointer-events-none opacity-50" : ""}`}
      >
        <span className="font-serif text-[17px] text-amethyst-deep">選擇相片（最多 {MAX_FILES} 張）</span>
        <span className="mt-1 text-[12px] text-mauve">相片圖庫或「檔案」App｜電腦可直接拖放｜HEIC、JPG、PNG、WebP</span>
        <input type="file" accept={ACCEPT} multiple className="sr-only" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
      </label>

      {total > 0 && (
        <>
          <div className="mt-4 rounded-2xl bg-white p-3">
            <div className="flex items-baseline justify-between text-[13px]">
              <span className="font-medium">批次進度</span>
              <span className="text-mauve">
                {finished}/{total}
                {failed ? `｜失敗 ${failed}` : ""}
              </span>
            </div>
            <div className="mt-2">
              <ProgressBar value={batchProgress} />
            </div>
          </div>

          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {items.map((i) => (
              <li key={i.key} className="flex items-center gap-3 rounded-2xl bg-white p-2 pr-3">
                <img src={i.preview} alt="" className="checker h-16 w-12 shrink-0 rounded-lg object-cover" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{i.name || i.file.name}</div>
                  {i.state === "uploading" || i.state === "preparing" ? (
                    <div className="mt-1.5">
                      <ProgressBar value={i.progress} />
                      <div className="mt-1 text-[11px] text-mauve">{STATE_TEXT[i.state]}</div>
                    </div>
                  ) : (
                    <div className={`mt-0.5 line-clamp-2 text-[12px] ${i.state === "failed" ? "text-wine" : "text-mauve"}`}>
                      {i.state === "waiting" ? `${STATE_TEXT.waiting}｜${formatBytes(i.file.size)}` : `${STATE_TEXT[i.state]}${i.message ? `｜${i.message}` : ""}`}
                    </div>
                  )}
                </div>
                {(i.state === "waiting" || i.state === "failed") && !running && (
                  <button type="button" aria-label="移除" className="px-2 text-lg text-mauve" onClick={() => setItems((c) => c.filter((x) => x.key !== i.key))}>
                    ×
                  </button>
                )}
                {(i.state === "done" || i.state === "duplicate") && i.garmentId && (
                  <Link to={`/g/${i.garmentId}`} className="shrink-0 text-[12px] text-amethyst-deep">
                    查看
                  </Link>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={run} disabled={running || pending === 0}>
              {running ? `上傳中（${finished}/${total}）` : failed && pending === failed ? `重試失敗項目（${failed}）` : `開始上傳 ${pending} 張`}
            </Button>
            {finished > 0 && !running && (
              <Link to="/?tab=todo#todo" className="text-[14px] text-amethyst-deep underline underline-offset-4">
                前往主頁「待整理」
              </Link>
            )}
          </div>
        </>
      )}
    </section>
  );
}
