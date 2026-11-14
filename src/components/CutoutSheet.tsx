import { useEffect, useRef, useState } from "react";
import { Garment, GarmentImage } from "../api";
import { CutoutResult, runCutout, saveCutout } from "../cutoutFlow";
import { Button, Sheet, toast } from "./ui";
import { WardrobeImage } from "./WardrobeImage";
import { imageUrl } from "../api";

/** 手動去背：顯示結果、可對比原圖，確認後才保存透明圖片（原圖保留） */
export function CutoutSheet({ g, image, onClose, onSaved }: { g: Garment; image: GarmentImage; onClose: () => void; onSaved: () => void }) {
  const [res, setRes] = useState<CutoutResult | null>(null);
  const [err, setErr] = useState("");
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(0);
  const urlRef = useRef("");
  useEffect(() => {
    const ac = new AbortController();
    setRes(null); setErr("");
    runCutout(image, ac.signal).then((r) => { if (ac.signal.aborted) { if (r.ok) URL.revokeObjectURL(r.url); return; } if (r.ok) urlRef.current = r.url; setRes(r); }).catch((e) => { if (!ac.signal.aborted) setErr((e as Error).message || "去背失敗"); });
    return () => { ac.abort(); if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = ""; } };
  }, [image, run]);
  async function save() {
    if (!res?.ok) return;
    setBusy(true);
    try { await saveCutout(g, image, res.blob); toast("已保存去背圖，原圖保留"); onSaved(); onClose(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Sheet title="去背" onClose={() => { if (!busy) onClose(); }}>
      <div className="p-4" data-testid="cutout-sheet">
        <div className="checker relative mx-auto aspect-[3/4] max-w-xs overflow-hidden rounded-2xl">
          {res?.ok && !compare ? <img src={res.url} alt="去背結果" data-testid="cutout-result" className="absolute inset-0 h-full w-full object-contain p-2" />
            : <WardrobeImage src={imageUrl(image.id)} quality="high" alt="原圖" className="absolute inset-0 h-full w-full object-contain p-2" />}
          {!res && !err && <span className="absolute inset-x-0 bottom-2 text-center text-[12px] text-ink" role="status">去背處理中…</span>}
        </div>
        {res && !res.ok && <p className="mt-3 text-center text-[13px] text-wine" data-testid="cutout-note">{res.note}</p>}
        {err && <p className="mt-3 text-center text-[13px] text-wine" role="alert">{err}</p>}
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {res?.ok && <Button variant="ghost" onClick={() => setCompare((v) => !v)}>{compare ? "顯示去背結果" : "對比原圖"}</Button>}
          {(err || (res && !res.ok && !res.transparent)) && <Button variant="ghost" onClick={() => setRun((n) => n + 1)}>重試</Button>}
          {res?.ok && <Button onClick={save} disabled={busy} data-testid="cutout-save">{busy ? "保存中…" : "保存去背圖"}</Button>}
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
        </div>
        <p className="mt-3 text-center text-[11px] text-mauve">原始圖片永遠保留。去背失敗或取消不會改變現有主圖。</p>
      </div>
    </Sheet>
  );
}
