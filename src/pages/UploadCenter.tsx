import { DragEvent, useEffect, useRef, useState } from "react";
import { ApiError, formatBytes, intakeUpload } from "../api";
import { AiHandoffButton, Button, Link, ProgressBar, toast } from "../components/ui";
import { fillQueue } from "../fillQueue";
import { fileKey, prepareIntake } from "../imageProcessing";
import { navigate } from "../router";

/**
 * 上傳：一張相＝一件「待整理衣物」。選相後馬上開始上傳，完成後直接進入填寫資料。
 * - 可以同時選透明圖和原相；同一件衣服的兩張相可在填寫資料時「合併同一件」，或交給 AI 歸類後確認合併。
 * - 每批最多 30 張；同時上傳 3 張，減少 iPhone 記憶體壓力。
 * - 原檔原樣上傳（不縮小、不重新壓縮）；瀏覽器另外產生縮圖、AI 辨認圖、HEIC 預覽。
 * - 圖片不是真透明、而背景是棋盤格（假 PNG）或純色時，瀏覽器自動去背並另存為「去背圖」（主圖），原檔照樣保留。
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
  waiting: "排隊中",
  preparing: "準備中（校驗碼、自動去背）",
  uploading: "上傳中",
  done: "已保存",
  duplicate: "衣櫃已有這張相",
  failed: "失敗",
};

function cutoutText(duplicate: boolean, cutoutId: string | null | undefined, kind?: string, note?: string) {
  if (duplicate) return "";
  if (cutoutId) return `｜已自動去背（${kind === "checkerboard" ? "假透明棋盤格" : "純色背景"}），原檔已保留`;
  return note ? `｜${note}` : "";
}

export default function UploadCenter() {
  const [items, setItems] = useState<Item[]>([]);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const runningRef = useRef(false);

  useEffect(() => () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview)), []);

  // 選相後馬上上傳：有新加入（排隊中）的相片就自動開始
  useEffect(() => {
    if (!running && items.some((i) => i.state === "waiting")) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, running]);

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
            { file: p.original, filename: p.filename, sha256: p.sha256, preview: p.preview, thumbnail: p.thumbnail, analysis: p.analysis, cutout: p.cutout },
            (ratio) => update(item.key, { progress: ratio * 0.97 }),
          );
          const dims = `${r.image.width}×${r.image.height}`;
          update(item.key, {
            state: r.duplicate ? "duplicate" : "done",
            progress: 1,
            garmentId: r.garment_id,
            name: r.name,
            message: `${r.name}｜${dims}｜${formatBytes(r.image.file_size)}${p.isHeif ? "｜HEIC 原檔" : ""}${p.warning ? `｜${p.warning}` : ""}${cutoutText(r.duplicate, r.cutout_id, p.cutoutKind, p.cutoutNote)}${r.warnings[0] && !r.duplicate ? `｜${r.warnings[0]}` : ""}`,
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

  /** 剛上傳成功的衣物：按上傳次序進入填寫資料 */
  function goFill() {
    const ids = itemsRef.current.filter((i) => (i.state === "done" || i.state === "duplicate") && i.garmentId).map((i) => i.garmentId!);
    if (!ids.length) return;
    fillQueue.start(ids);
    navigate(`/g/${ids[0]}?edit=1`);
  }

  async function run(retryFailed = false) {
    if (runningRef.current) return; // 防止重複提交
    runningRef.current = true;
    setRunning(true);
    try {
      const queue = itemsRef.current.filter((i) => i.state === "waiting" || (retryFailed && i.state === "failed"));
      let idx = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          while (idx < queue.length) await uploadOne(queue[idx++]);
        }),
      );
      const cur = itemsRef.current;
      const failed = cur.filter((i) => i.state === "failed").length;
      const ok = cur.filter((i) => i.state === "done").length;
      // 選相途中再加入的相片：留給下一輪自動上傳
      if (cur.some((i) => i.state === "waiting")) return;
      if (failed) toast(`${failed} 張未能上傳，其他已保存；可按「重試失敗項目」`, "err");
      else if (ok) {
        toast(ok === 1 ? "已上傳，請填寫資料" : `已上傳 ${ok} 件，逐件填寫資料`);
        setTimeout(goFill, 700);
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
  const batchProgress = total ? items.reduce((s, i) => s + (i.state === "done" || i.state === "duplicate" ? 1 : i.progress), 0) / total : 0;

  return (
    <section className="paper px-4 pb-4 pt-7">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`pat-dots flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-4 py-6 text-center transition-colors ${
          dragging ? "border-amethyst bg-rose" : "border-amethyst/50 bg-white"
        } ${running ? "pointer-events-none opacity-60" : ""}`}
      >
        <span className="mt-2 font-serif text-[18px] font-bold text-amethyst-deep">{total ? "再選相片" : "選擇相片"}</span>
        <span className="mt-1 text-[12px] text-mauve">選好即自動上傳｜最多 {MAX_FILES} 張｜HEIC、JPG、PNG、WebP</span>
        <input type="file" accept={ACCEPT} multiple className="sr-only" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
      </label>
      <p className="mt-3 text-[12px] leading-relaxed text-mauve">
        一張相＝一件衣物，原檔完整保存。可以同時選<b>透明圖</b>和<b>原相</b>：同一件衣服的兩張相，可在填寫資料時按「合併同一件」，或交給 AI 整理時歸類。
      </p>

      {total > 0 && (
        <>
          <div className="mt-4 rounded-2xl bg-white p-3">
            <div className="flex items-baseline justify-between text-[13px]">
              <span className="font-medium">{running ? "上傳中…" : failed ? "部分未能上傳" : "已完成"}</span>
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
                {i.state === "failed" && !running && (
                  <button type="button" aria-label="移除" className="px-2 text-lg text-mauve" onClick={() => setItems((c) => c.filter((x) => x.key !== i.key))}>
                    ×
                  </button>
                )}
                {(i.state === "done" || i.state === "duplicate") && i.garmentId && (
                  <Link to={`/g/${i.garmentId}?edit=1`} className="shrink-0 text-[12px] text-amethyst-deep underline underline-offset-4">
                    填寫
                  </Link>
                )}
              </li>
            ))}
          </ul>

          {!running && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {failed > 0 && (
                <Button variant="ghost" onClick={() => run(true)}>
                  重試失敗項目（{failed}）
                </Button>
              )}
              {finished > 0 && (
                <>
                  <Button onClick={goFill}>填寫資料{finished > 1 ? `（${finished} 件）` : ""}</Button>
                  <AiHandoffButton />
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
