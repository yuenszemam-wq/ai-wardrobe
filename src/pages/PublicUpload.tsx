import { useEffect, useState } from "react";
import { api } from "../api";
import { ProgressBar } from "../components/ui";
import { makeThumbnail, prepareForUpload } from "../imageProcessing";
import SlotUpload, { type SlotSession } from "./SlotUpload";

interface Target {
  index: number;
  label: string;
  image_type: string;
  uploaded: boolean;
}

/** 上傳連結頁：新式（批量上傳槽）或舊式（逐件衣物）自動判斷 */
export default function PublicUpload({ token }: { token: string }) {
  const [slots, setSlots] = useState<SlotSession | null | undefined>(undefined);
  useEffect(() => {
    fetch(`/api/upload/${token}`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as SlotSession) : null))
      .then((s) => setSlots(s && s.slots.length ? s : null))
      .catch(() => setSlots(null));
  }, [token]);
  if (slots === undefined) return <div className="min-h-screen bg-lace" />;
  if (slots) return <SlotUpload token={token} initial={slots} />;
  return <LegacyUpload token={token} />;
}

/** 舊式：AI 產生的短效上傳連結頁，不需登入，只能上傳到指定的衣物 */
function LegacyUpload({ token }: { token: string }) {
  const [info, setInfo] = useState<{ expires_at: string; targets: Target[] } | null>(null);
  const [err, setErr] = useState("");
  const [state, setState] = useState<Record<number, { p: number; msg?: string; tone?: "ok" | "err" }>>({});

  const load = () =>
    api<{ expires_at: string; targets: Target[] }>(`/api/public/upload/${token}`)
      .then(setInfo)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function put(index: number, blob: Blob, fields: Record<string, string>, onProgress?: (r: number) => void) {
    return new Promise<{ id: string; warnings: string[]; width: number; height: number }>((resolve, reject) => {
      const qs = new URLSearchParams(fields).toString();
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/public/upload/${token}/${index}${qs ? `?${qs}` : ""}`);
      xhr.setRequestHeader("x-requested-with", "ai-wardrobe");
      xhr.setRequestHeader("content-type", blob.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        const data = JSON.parse(xhr.responseText || "{}");
        if (xhr.status < 300) resolve(data);
        else reject(new Error(data?.error?.message || `上傳失敗（${xhr.status}）`));
      };
      xhr.onerror = () => reject(new Error("網絡中斷，請重試"));
      xhr.send(blob);
    });
  }

  async function upload(t: Target, file: File) {
    setState((s) => ({ ...s, [t.index]: { p: 0 } }));
    try {
      const prepared = await prepareForUpload(file);
      const img = await put(t.index, prepared.blob, {}, (p) => setState((s) => ({ ...s, [t.index]: { p: p * 0.92 } })));
      if (t.image_type !== "thumbnail") {
        const thumb = await makeThumbnail(prepared.blob).catch(() => null);
        if (thumb) await put(t.index, thumb, { image_type: "thumbnail", derived_from: img.id }).catch(() => {});
      }
      setState((s) => ({
        ...s,
        [t.index]: { p: 1, msg: img.warnings?.[0] || `已上傳 ${img.width}×${img.height}`, tone: img.warnings?.length ? "err" : "ok" },
      }));
      load();
    } catch (e) {
      setState((s) => ({ ...s, [t.index]: { p: 0, msg: (e as Error).message, tone: "err" } }));
    }
  }

  return (
    <div className="safe-top min-h-screen bg-lace">
      <header className="bg-head px-4 py-4 text-rose">
        <p className="font-serif text-lg tracking-[0.12em]">✝ 電子衣櫃</p>
        <p className="mt-1 text-[13px] text-rose/80">請按次序為每件衣物選擇對應的相片（建議用去背後的高清圖）。</p>
      </header>
      <main className="mx-auto max-w-xl px-4 py-5">
        {err && <p className="rounded-2xl bg-wine/10 p-4 text-wine">{err}</p>}
        {info && (
          <>
            <p className="mb-3 text-[12px] text-mauve">連結有效至 {new Date(info.expires_at).toLocaleString("zh-HK")}</p>
            <ol className="space-y-3">
              {info.targets.map((t) => {
                const st = state[t.index];
                return (
                  <li key={t.index} className="rounded-2xl bg-field p-3 ring-1 ring-ink/5">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[12px] text-mauve">第 {t.index + 1} 件｜{t.image_type === "processed" ? "去背圖" : "原相"}</div>
                        <div className="truncate text-[15px] font-medium">{t.label}</div>
                      </div>
                      <label className={`shrink-0 cursor-pointer rounded-full px-4 py-2 text-[14px] ${t.uploaded ? "bg-rose-soft text-amethyst-deep" : "bg-amethyst text-white"}`}>
                        {t.uploaded ? "重新選擇" : "選擇相片"}
                        <input type="file" accept="image/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(t, f); e.target.value = ""; }} />
                      </label>
                    </div>
                    {st && st.p > 0 && st.p < 1 && <div className="mt-2"><ProgressBar value={st.p} /></div>}
                    {st?.msg && <p className={`mt-2 text-[13px] ${st.tone === "err" ? "text-wine" : "text-amethyst-deep"}`}>{st.msg}</p>}
                    {!st && t.uploaded && <p className="mt-2 text-[13px] text-amethyst-deep">已有圖片</p>}
                  </li>
                );
              })}
            </ol>
            {info.targets.every((t) => t.uploaded) && (
              <p className="mt-5 rounded-2xl bg-rose-soft p-4 text-center text-sm">全部完成，可以返回對話請 AI 核實結果。</p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
