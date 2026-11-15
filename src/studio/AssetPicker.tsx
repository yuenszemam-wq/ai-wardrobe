/**
 * Phase 3.9A.3：共用素材面板（衣服配搭及角色換裝共用）。
 * - 從相簿／檔案／拍攝加入圖片（手機先解碼、壓縮；可手動去背），或從我的素材庫選擇。
 * - 上傳到工作室的素材不會成為衣櫃衣物，不計入衣物數目、總價或穿著統計。
 * - 「最近使用」記錄在這部手機（兩個工作室共用）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { IconCamera, IconImage, IconPlus, IconScissors } from "../components/icons";
import { Button, Sheet, Spinner, toast } from "../components/ui";
import { CutoutStudio } from "../cutoutStudio/CutoutStudio";
import { ASSET_KIND_LABEL, AssetKind, StudioAsset, cutoutBlob, listStudioAssets, prepareImage, saveCutout, uploadStudioAsset } from "./assets";

const RECENT = "aw:studio-asset-recent";
export const rememberAsset = (id: string) => { try { const l = JSON.parse(localStorage.getItem(RECENT) || "[]") as string[]; localStorage.setItem(RECENT, JSON.stringify([id, ...l.filter((x) => x !== id)].slice(0, 24))); } catch { /* ignore */ } };
const recentIds = () => { try { return JSON.parse(localStorage.getItem(RECENT) || "[]") as string[]; } catch { return []; } };

/** 素材分頁：從相簿／檔案／拍攝加入圖片，或從我的素材庫選擇。上傳到工作室不會成為衣櫃衣物 */
export function AssetPicker({ onAdd: add, defaultKind = "decoration" }: { onAdd: (a: StudioAsset, variant: "original" | "cutout") => void; defaultKind?: AssetKind }) {
  const onAdd = (a: StudioAsset, v: "original" | "cutout") => { rememberAsset(a.id); add(a, v); };
  const [lib, setLib] = useState<StudioAsset[] | null>(null);
  const [kind, setKind] = useState<AssetKind | "" | "recent">("");
  const [pending, setPending] = useState<File | null>(null);
  const load = useCallback(() => listStudioAssets(kind && kind !== "recent" ? { kind } : {}).then((all) => { if (kind !== "recent") return setLib(all); const ids = recentIds(); setLib(ids.map((id) => all.find((a) => a.id === id)).filter((a): a is StudioAsset => !!a)); }).catch(() => setLib([])), [kind]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-2" data-testid="assets-tab">
      <div className="grid grid-cols-3 gap-1.5 text-[12px]">
        <label className="chip flex h-10 cursor-pointer items-center justify-center gap-1 rounded-2xl"><IconImage />相簿<input type="file" accept="image/*" className="hidden" data-testid="asset-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setPending(f); }} /></label>
        <label className="chip flex h-10 cursor-pointer items-center justify-center gap-1 rounded-2xl"><IconPlus />檔案<input type="file" accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setPending(f); }} /></label>
        <label className="chip flex h-10 cursor-pointer items-center justify-center gap-1 rounded-2xl"><IconCamera />拍攝<input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setPending(f); }} /></label>
      </div>
      <div className="flex items-center gap-1"><p className="flex-1 font-serif text-[13px] text-gold-soft">我的素材庫</p>
        <select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)} className="field h-8 rounded-full px-2 text-[13px]" data-testid="asset-kind"><option value="">全部</option><option value="recent">最近使用</option>{Object.entries(ASSET_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      {!lib ? <Spinner /> : !lib.length ? <p className="py-3 text-center text-[12px] text-mauve">素材庫未有素材。上傳時選擇「保存到我的素材庫」即可重用。</p> : (
        <div className="grid grid-cols-4 gap-1.5" data-testid="asset-library">{lib.filter((a) => a.version).map((a) => <button key={a.id} type="button" onClick={() => onAdd(a, a.version!.has_cutout ? "cutout" : "original")} className="text-center text-[10px]" data-lib-asset={a.id}><span className="checker block aspect-square overflow-hidden rounded-xl"><img src={a.version!.thumb_url} alt="" className="h-full w-full object-contain" loading="lazy" /></span><span className="block truncate">{a.name}</span></button>)}</div>
      )}
      {pending && <AssetUploadSheet file={pending} defaultKind={defaultKind} onClose={() => setPending(null)} onDone={(a, v) => { setPending(null); onAdd(a, v); if (a.in_library) void load(); }} />}
    </div>
  );
}

/** 上傳素材：先顯示原圖 → 使用者按「去背」→ 處理進度 → 預覽 → 確認套用。失敗時保留原圖並可重試 */
export function AssetUploadSheet({ file, onClose, onDone, defaultKind = "decoration" }: { file: File; onClose: () => void; onDone: (a: StudioAsset, variant: "original" | "cutout") => void; defaultKind?: AssetKind }) {
  const [img, setImg] = useState<Awaited<ReturnType<typeof prepareImage>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [kind, setKind] = useState<AssetKind>(defaultKind);
  const [name, setName] = useState(file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "素材");
  const [keep, setKeep] = useState<"outfit" | "library">("outfit");
  const [cut, setCut] = useState<{ state: "idle" | "running" | "done" | "failed"; url?: string; blob?: Blob; note?: string }>({ state: "idle" });
  const [show, setShow] = useState<"original" | "cutout">("original");
  const [busy, setBusy] = useState(false);
  const [studio, setStudio] = useState(false);
  useEffect(() => { let live = true; prepareImage(file).then((r) => live && setImg(r)).catch((e) => live && setErr((e as Error).message)); return () => { live = false; }; }, [file]);
  async function runCut() {
    if (!img) return;
    setCut({ state: "running" });
    try { const r = await cutoutBlob(img.blob); setCut(r.ok ? { state: "done", url: r.url, blob: r.blob } : { state: "failed", note: r.note }); if (r.ok) setShow("cutout"); }
    catch (e) { setCut({ state: "failed", note: (e as Error).message }); }
  }
  // 重試不會重複上傳原圖：同一個 op_id；原圖已上傳成功、只有去背圖失敗時，重試只上傳去背圖
  const op = useRef("op_" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36));
  const uploaded = useRef<StudioAsset | null>(null);
  const cutSaved = useRef<StudioAsset | null>(null);
  async function confirm() {
    if (!img) return;
    setBusy(true);
    try {
      // 離線：已去背時直接以去背圖作為素材（透明 PNG），連線後上傳
      const offlineCut = !navigator.onLine && show === "cutout" && cut.blob ? { ...img, blob: cut.blob, hasAlpha: true } : null;
      let a = uploaded.current ?? (uploaded.current = await uploadStudioAsset(offlineCut ?? img, { kind, name, inLibrary: keep === "library", opId: op.current, allowOffline: true }));
      let variant: "original" | "cutout" = "original";
      if (!offlineCut && show === "cutout" && cut.blob) { a = cutSaved.current ?? (cutSaved.current = await saveCutout(a.version!.id, cut.blob)); variant = "cutout"; }
      if (a.id.startsWith("local:")) toast("離線：素材已保存在這部手機，保存造型後連線會自動上傳");
      onDone(a, variant);
    } catch (e) { toast(`${(e as Error).message}${uploaded.current ? "（原圖已上傳，重試只會補上未完成的部分）" : ""}`, "err"); } finally { setBusy(false); }
  }
  if (studio && img) return <CutoutStudio target={{ kind: "blob", blob: img.blob, name }} onClose={() => setStudio(false)}
    onExport={(b) => { if (cut.url) URL.revokeObjectURL(cut.url); setCut({ state: "done", blob: b, url: URL.createObjectURL(b) }); setShow("cutout"); setStudio(false); }} />;
  return (
    <Sheet title="加入圖片素材" onClose={onClose}>
      <div className="space-y-2.5 text-[12.5px]" data-testid="asset-upload" data-cut={cut.state}>
        {err ? <p role="alert" className="text-wine">{err}</p> : !img ? <Spinner /> : <>
          <div className="checker relative mx-auto aspect-square w-full max-w-[16rem] overflow-hidden rounded-2xl"><img src={show === "cutout" && cut.url ? cut.url : img.preview} alt="" className="h-full w-full object-contain" data-testid="asset-preview" data-show={show} /></div>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {img.hasAlpha ? <span className="text-mauve">已是透明圖片，不需要去背</span> : cut.state === "idle" ? <Button variant="ghost" onClick={() => void runCut()} data-testid="asset-cutout"><IconScissors />去背</Button>
              : cut.state === "running" ? <span className="text-mauve" role="status">去背處理中…</span>
              : cut.state === "failed" ? <><span className="text-wine" role="alert">去背失敗：{cut.note}（已保留原圖）</span><Button variant="ghost" onClick={() => void runCut()}>重試</Button></>
              : <>{(["original", "cutout"] as const).map((v) => <button key={v} type="button" aria-pressed={show === v} data-show-variant={v} onClick={() => setShow(v)} className={`h-8 rounded-full px-3 ${show === v ? "chip-on" : "chip"}`}>{v === "original" ? "原圖" : "去背圖"}</button>)}</>}
          </div>
          {!img.hasAlpha && cut.state !== "running" && <div className="text-center"><button type="button" className="chip h-8 rounded-full px-3" onClick={() => setStudio(true)} data-testid="asset-manual-cutout">手動去背／選取</button></div>}
          <label className="flex items-center gap-2"><span className="w-10 text-mauve">名稱</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="field h-9 flex-1 rounded-full px-3 text-[16px]" /></label>
          <div className="flex flex-wrap gap-1"><span className="w-10 self-center text-mauve">用途</span>{Object.entries(ASSET_KIND_LABEL).map(([k, l]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k as AssetKind)} className={`h-7 rounded-full px-2.5 ${kind === k ? "chip-on" : "chip"}`}>{l}</button>)}</div>
          <div className="seg" role="radiogroup" aria-label="保存方式">
            <button type="button" aria-selected={keep === "outfit"} onClick={() => setKeep("outfit")} data-keep="outfit">只用於目前造型</button>
            <button type="button" aria-selected={keep === "library"} onClick={() => setKeep("library")} data-keep="library">保存到我的素材庫</button>
          </div>
          <p className="text-[11px] text-mauve">素材不會加入衣櫃，不計入衣物數目、總價或穿著統計。需要成為正式衣物時，可在圖層「⋯」選擇「另存為衣櫃衣物」。</p>
          <Button className="w-full" disabled={busy || cut.state === "running"} onClick={() => void confirm()} data-testid="asset-confirm">{busy ? "上傳中…" : show === "cutout" ? "套用去背圖並加入" : "加入畫布"}</Button>
        </>}
      </div>
    </Sheet>
  );
}

