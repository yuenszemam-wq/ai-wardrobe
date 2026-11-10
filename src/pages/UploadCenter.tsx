import { SplitSheet } from "../components/SplitSheet";
import { PointerEvent as ReactPointerEvent, DragEvent, useEffect, useRef, useState } from "react";
import { api, AiStatus, AI_STATUS_LABEL, Garment, ApiError, formatBytes, intakeUpload } from "../api";
import { AiHandoffButton, Button, Link, ProgressBar, toast } from "../components/ui";
import { fillQueue } from "../fillQueue";
import { fileKey, prepareIntake } from "../imageProcessing";
import { navigate } from "../router";

/**
 * 上傳：一張相＝一件「待整理衣物」。選相後馬上開始上傳，完成後可拖拉合併，再選擇填寫資料。
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
  imageId?: string;
  name?: string;
  aiStatus?: AiStatus | null;
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
  const mergingRef = useRef(false);
  const [merging, setMerging] = useState(false);
  const [splitId, setSplitId] = useState<string | null>(null);
  const [mergeSource, setMergeSource] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; moved: boolean } | null>(null);

  async function mergeInto(source: string, target: string) {
    if (source === target || runningRef.current || mergingRef.current) return;
    mergingRef.current = true;
    setMerging(true);
    try {
      const result = await api<Garment>(`/api/garments/${target}/merge`, { method: "POST", json: { source_id: source } });
      setItems((cur) => cur.map((i) => i.garmentId === source || i.garmentId === target
        ? { ...i, garmentId: target, name: result.name, aiStatus: result.ai_status } : i));
      fillQueue.remove(source);
      setMergeSource(null);
      toast("已合併圖片，AI 辨認狀態已保留");
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      mergingRef.current = false;
      setMerging(false);
    }
  }

  function targetAt(x: number, y: number) {
    return document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-merge-id]")?.dataset.mergeId || null;
  }
  function startMerge(e: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (runningRef.current || mergingRef.current || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id, pointer: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  }
  function moveMerge(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) d.moved = true;
    if (!d.moved) return;
    const target = targetAt(e.clientX, e.clientY);
    setMergeSource(d.id);
    setDropTarget(target !== d.id ? target : null);
    if (e.clientY < 90) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 100) window.scrollBy(0, 12);
  }
  function endMerge(e: ReactPointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    drag.current = null;
    setDropTarget(null);
    if (!d || d.pointer !== e.pointerId) return;
    const target = targetAt(e.clientX, e.clientY);
    if (e.type === "pointerup" && d.moved && target && target !== d.id) void mergeInto(d.id, target);
    else setMergeSource(null);
  }

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
    if (!list || !list.length || mergingRef.current) return;
    const files = Array.from(list).filter((f) => f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
    const room = MAX_FILES - itemsRef.current.filter((i) => i.state !== "done" && i.state !== "duplicate").length;
    if (files.length > room) toast(`每批最多 ${MAX_FILES} 張，已加入前 ${Math.max(room, 0)} 張`, "err");
    const added: Item[] = [];
    for (const f of files.slice(0, Math.max(room, 0))) {
      const key = await fileKey(f);
      if (itemsRef.current.some((i) => i.key === key) || added.some((i) => i.key === key)) continue; // 同一張相不重複加入
      added.push({ file: f, key, preview: URL.createObjectURL(f), state: "waiting", progress: 0 });
    }
    setItems((cur) => [...cur, ...added]);
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
            imageId: r.image.id,
            name: r.name,
            aiStatus: r.duplicate ? undefined : "pending_ai",
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
    if (mergingRef.current || runningRef.current) return;
    const ids = [...new Set(itemsRef.current.filter((i) => (i.state === "done" || i.state === "duplicate") && i.garmentId).map((i) => i.garmentId!))];
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
        toast(`已上傳 ${ok} 張，可拖拉合併同一件衣物`);
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

  // Multiple photos remain visible together after merging; one card per garment.
  const groups = items.reduce<Item[][]>((all, item) => {
    const existing = item.garmentId && all.find((group) => group[0].garmentId === item.garmentId);
    if (existing) existing.push(item); else all.push([item]);
    return all;
  }, []);
  const garmentCount = groups.filter((group) => group[0].garmentId).length;
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
        } ${running || merging ? "pointer-events-none opacity-60" : ""}`}
      >
        <span className="mt-2 font-serif text-[18px] font-bold text-amethyst-deep">{total ? "再選相片" : "選擇相片"}</span>
        <span className="mt-1 text-[12px] text-mauve">選好即自動上傳｜最多 {MAX_FILES} 張｜HEIC、JPG、PNG、WebP</span>
        <input type="file" accept={ACCEPT} multiple className="sr-only" onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
      </label>
      <p className="mt-3 text-[12px] leading-relaxed text-mauve">
        原檔完整保存。上傳後，按住「拖拉合併」拖到同一件衣服的另一張相上；亦可先點「選取合併」，再點目標。合併只整理圖片，不會標記為已辨認。
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
            {groups.map(([i, ...photos]) => (
              <li key={i.key} data-merge-id={i.garmentId} aria-busy={merging}
                className={`flex flex-wrap items-center gap-3 rounded-2xl bg-white p-2 pr-3 ${dropTarget === i.garmentId ? "ring-2 ring-amethyst" : ""} ${mergeSource === i.garmentId ? "opacity-60" : ""}`}>
                {dropTarget === i.garmentId && <div className="w-full text-sm text-amethyst-deep">放手合併到這一件</div>}
                <img src={i.preview} alt="" className="checker h-16 w-12 shrink-0 rounded-lg object-cover" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{i.name || i.file.name}</div>
                  {i.aiStatus && i.aiStatus !== "done" && <span className="chip-on rounded-full px-2 py-0.5 text-[10px]">{AI_STATUS_LABEL[i.aiStatus]}</span>}
                  {photos.length > 0 && <div className="mt-1 flex flex-wrap gap-1" aria-label={`已合併 ${photos.length + 1} 張相片`}>
                    {photos.map((photo) => <img key={photo.key} src={photo.preview} alt="已合併相片" className="h-10 w-8 rounded object-contain" />)}
                    <span className="text-[11px]">共 {photos.length + 1} 張</span>
                  </div>}
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
                  <div className="flex w-full items-center justify-end gap-2 text-[12px] text-amethyst-deep">
                    <button type="button" disabled={running || merging} style={{ touchAction: "none" }}
                      className="min-h-11 select-none rounded-xl border border-gold px-2 disabled:opacity-40"
                      aria-label={`拖拉合併 ${i.name || i.file.name}`}
                      onPointerDown={(e) => startMerge(e, i.garmentId!)} onPointerMove={moveMerge}
                      onPointerUp={endMerge} onPointerCancel={endMerge} onLostPointerCapture={() => { drag.current = null; setDropTarget(null); }}>
                      ↔ 拖拉合併
                    </button>
                    <button type="button" disabled={running || merging} className="min-h-11 px-2 disabled:opacity-40"
                      onClick={() => mergeSource && mergeSource !== i.garmentId ? void mergeInto(mergeSource, i.garmentId!) : setMergeSource(mergeSource ? null : i.garmentId!)}>
                      {mergeSource === i.garmentId ? "取消選取" : mergeSource ? "合併到這件" : "選取合併"}
                    </button>
                    <button type="button" disabled={running || merging} onClick={() => setSplitId(i.garmentId!)} className="min-h-11 px-2">拆開</button>
                    {!merging && <Link to={`/g/${i.garmentId}?edit=1`} className="underline underline-offset-4">填寫</Link>}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {!running && !merging && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {failed > 0 && (
                <Button variant="ghost" onClick={() => run(true)}>
                  重試失敗項目（{failed}）
                </Button>
              )}
              {finished > 0 && (
                <>
                  <Button onClick={goFill}>填寫資料{garmentCount > 1 ? `（${garmentCount} 件）` : ""}</Button>
                  <AiHandoffButton />
                </>
              )}
            </div>
          )}
        </>
      )}
      {splitId && <SplitSheet id={splitId} onClose={() => setSplitId(null)} onSplit={(r) => {
        setItems((cur) => cur.map((item) => {
          if (item.garmentId !== splitId) return item;
          const g = item.imageId && r.moved_image_ids.includes(item.imageId) ? r.garment : r.source;
          return { ...item, garmentId: g.id, name: g.name, aiStatus: g.ai_status };
        }));
        setSplitId(null); setMergeSource(null);
      }} />}
    </section>
  );
}
