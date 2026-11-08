import { useEffect, useRef, useState } from "react";
import { ProgressBar } from "../components/ui";
import { makeThumbnail } from "../imageProcessing";

export interface Slot {
  slot_id: string;
  position: number;
  client_key: string;
  label: string;
  file_name: string | null;
  image_type: "processed" | "original";
  expected_width: number | null;
  expected_height: number | null;
  status: "pending" | "uploading" | "done" | "duplicate" | "failed";
  attempts: number;
  error: string | null;
  width: number | null;
  height: number | null;
  has_alpha: boolean | null;
}

export interface SlotSession {
  batch_id: string;
  expires_at: string;
  slots: Slot[];
}

type Local = { p: number; msg?: string; tone?: "ok" | "err"; file?: string };

const base = (n: string | null | undefined) => (n || "").split(/[\\/]/).pop()!.trim().toLowerCase();
const finished = (s: Slot) => s.status === "done" || s.status === "duplicate";

/**
 * 批量上傳頁（上傳槽模式）：
 * - 一次選取多張圖，先按檔名配對，其餘按次序。
 * - 檔案原樣以二進位 PUT，瀏覽器不壓縮、不縮小、不轉檔（保留透明）。
 * - 失敗可逐項重試；伺服器以 SHA-256 去重，重傳同一張圖不會重複建立。
 */
export default function SlotUpload({ token, initial }: { token: string; initial: SlotSession }) {
  const [session, setSession] = useState<SlotSession>(initial);
  const [local, setLocal] = useState<Record<string, Local>>({});
  const [busy, setBusy] = useState(false);
  const pending = useRef(new Map<string, File>());

  const reload = async () => {
    const res = await fetch(`/api/upload/${token}`, { cache: "no-store" });
    if (res.ok) setSession(await res.json());
  };
  useEffect(() => {
    const t = setInterval(() => !busy && reload(), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const set = (id: string, v: Local) => setLocal((s) => ({ ...s, [id]: { ...s[id], ...v } }));

  function put(path: string, blob: Blob, onProgress?: (r: number) => void) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", path);
      xhr.setRequestHeader("content-type", blob.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(xhr.responseText || "{}");
        } catch {
          /* ignore */
        }
        if (xhr.status < 300) resolve(data);
        else reject(new Error((data as { error?: { message?: string } })?.error?.message || `上傳失敗（${xhr.status}）`));
      };
      xhr.onerror = () => reject(new Error("網絡中斷，請按重試"));
      xhr.send(blob);
    });
  }

  async function uploadOne(slot: Slot, file: File) {
    pending.current.set(slot.slot_id, file);
    set(slot.slot_id, { p: 0.01, msg: undefined, tone: undefined, file: file.name });
    try {
      const r = await put(`/api/upload/${token}/${slot.slot_id}`, file, (p) => set(slot.slot_id, { p: Math.max(0.01, p * 0.95) }));
      const w = r.width as number;
      const h = r.height as number;
      const dup = r.deduplicated === true;
      set(slot.slot_id, { p: 1, tone: "ok", msg: dup ? "衣櫃已有同一張圖，未重複建立" : `已入庫 ${w}×${h}${r.has_alpha ? "・透明背景" : ""}` });
      pending.current.delete(slot.slot_id);
      if (!dup && r.status === "done") {
        const thumb = await makeThumbnail(file).catch(() => null);
        if (thumb) await put(`/api/upload/${token}/${slot.slot_id}/thumbnail`, thumb).catch(() => {});
      }
    } catch (e) {
      set(slot.slot_id, { p: 0, tone: "err", msg: (e as Error).message });
    }
  }

  async function runQueue(jobs: [Slot, File][]) {
    setBusy(true);
    const queue = [...jobs];
    const worker = async () => {
      for (let j = queue.shift(); j; j = queue.shift()) await uploadOne(j[0], j[1]);
    };
    await Promise.all([worker(), worker()]);
    setBusy(false);
    reload();
  }

  function pickMany(files: FileList | null) {
    if (!files?.length) return;
    const list = [...files];
    const open = session.slots.filter((s) => !finished(s));
    const jobs: [Slot, File][] = [];
    const used = new Set<File>();
    for (const s of open) {
      const f = list.find((x) => !used.has(x) && s.file_name && base(x.name) === base(s.file_name));
      if (f) {
        jobs.push([s, f]);
        used.add(f);
      }
    }
    const rest = list.filter((f) => !used.has(f));
    for (const s of open) {
      if (jobs.some(([x]) => x.slot_id === s.slot_id)) continue;
      const f = rest.shift();
      if (f) jobs.push([s, f]);
    }
    jobs.sort((a, b) => a[0].position - b[0].position);
    runQueue(jobs);
  }

  const done = session.slots.filter(finished).length;
  const total = session.slots.length;
  const expired = new Date(session.expires_at).getTime() < Date.now();

  return (
    <div className="safe-top min-h-screen bg-lace">
      <header className="bg-ink px-4 py-4 text-rose">
        <p className="font-serif text-lg tracking-[0.12em]">✝ 電子衣櫃</p>
        <p className="mt-1 text-[13px] text-rose/80">批量上傳去背圖：可一次選取全部檔案，系統會按檔名自動配對。</p>
      </header>
      <main className="mx-auto max-w-xl px-4 py-5">
        <div className="mb-4 rounded-2xl bg-white p-4 ring-1 ring-ink/5">
          <div className="flex items-center justify-between text-[14px]">
            <span>
              已完成 {done} / {total}
            </span>
            <span className="text-[12px] text-mauve">有效至 {new Date(session.expires_at).toLocaleString("zh-HK")}</span>
          </div>
          <div className="mt-2">
            <ProgressBar value={total ? done / total : 0} />
          </div>
          {expired ? (
            <p className="mt-3 text-[13px] text-wine">連結已過期，請返回對話叫 AI 重新產生（未完成的項目會保留）。</p>
          ) : done < total ? (
            <label className={`mt-3 block cursor-pointer rounded-full px-4 py-3 text-center text-[15px] text-white ${busy ? "bg-mauve" : "bg-amethyst"}`}>
              {busy ? "上傳中…" : "一次選擇全部圖片"}
              <input
                type="file"
                multiple
                accept="image/png,image/webp,.png,.webp"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  pickMany(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          ) : (
            <p className="mt-3 rounded-xl bg-rose-soft p-3 text-center text-sm">全部完成，可以返回對話請 AI 核實結果。</p>
          )}
          <p className="mt-2 text-[12px] text-mauve">請從「檔案」選取 AI 給你的原檔；經截圖或社交軟件轉傳的圖可能被縮小，會被拒絕。</p>
        </div>

        <ol className="space-y-3">
          {session.slots.map((s) => {
            const st = local[s.slot_id];
            const isDone = finished(s) || st?.tone === "ok";
            const failed = !isDone && (st?.tone === "err" || s.status === "failed");
            return (
              <li key={s.slot_id} className="rounded-2xl bg-white p-3 ring-1 ring-ink/5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[12px] text-mauve">
                      第 {s.position + 1} 件｜{s.image_type === "processed" ? "去背圖" : "原相"}
                      {s.expected_width ? `｜${s.expected_width}×${s.expected_height}` : ""}
                    </div>
                    <div className="truncate text-[15px] font-medium">{s.label}</div>
                    {s.file_name && <div className="truncate text-[12px] text-mauve">{st?.file || s.file_name}</div>}
                  </div>
                  {!isDone && !expired && (
                    <div className="flex shrink-0 gap-2">
                      {failed && pending.current.has(s.slot_id) && !busy && (
                        <button className="rounded-full bg-wine px-4 py-2 text-[14px] text-white" onClick={() => runQueue([[s, pending.current.get(s.slot_id)!]])}>
                          重試
                        </button>
                      )}
                      <label className="cursor-pointer rounded-full bg-rose-soft px-4 py-2 text-[14px] text-amethyst-deep">
                        {failed ? "換檔案" : "單獨選擇"}
                        <input
                          type="file"
                          accept="image/png,image/webp,.png,.webp"
                          className="sr-only"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) runQueue([[s, f]]);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </div>
                  )}
                </div>
                {st && st.p > 0 && st.p < 1 && (
                  <div className="mt-2">
                    <ProgressBar value={st.p} />
                  </div>
                )}
                {st?.msg ? (
                  <p className={`mt-2 text-[13px] ${st.tone === "err" ? "text-wine" : "text-amethyst-deep"}`}>{st.msg}</p>
                ) : finished(s) ? (
                  <p className="mt-2 text-[13px] text-amethyst-deep">
                    {s.status === "duplicate" ? "衣櫃已有同一張圖" : `已入庫 ${s.width}×${s.height}${s.has_alpha ? "・透明背景" : ""}`}
                  </p>
                ) : s.status === "failed" && s.error ? (
                  <p className="mt-2 text-[13px] text-wine">{s.error}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </main>
    </div>
  );
}
