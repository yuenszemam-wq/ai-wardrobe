/**
 * Phase 3.9B.2：設定 › 衣物及人物套件。匯出衣物（含衣服設定及套裝部件）或頭部／髮型素材為版本化 ZIP，
 * 朋友在自己的 AI Wardrobe 匯入成為獨立副本（不需要多帳戶；撤銷分享不會刪除已匯入的副本）。
 */
import { useEffect, useMemo, useState } from "react";
import { api, displayName, Garment } from "../api";
import { ImportPreview, commitImport, exportCharacterAssets, exportGarments, inspectPackage } from "../packages";
import { loadFullList } from "../wardrobeList";
import { navigate } from "../router";
import { Button, Spinner, toast } from "./ui";

async function deliver(blob: Blob, name: string) {
  const file = new File([blob], name, { type: "application/zip" });
  if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }).catch(() => undefined); return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

export function PackagesPanel() {
  const [tab, setTab] = useState<"export" | "character" | "import">("export");
  return (
    <div className="space-y-3 text-[13px]" data-testid="packages-panel">
      <p className="text-[12px] text-mauve">把衣物（圖片、衣服設定、套裝部件）或角色頭部／髮型打包成檔案，朋友可以在自己的 AI Wardrobe 匯入成獨立副本。只分享你有權使用及再分發的圖片；預設不包含價格、備註及原始相片。</p>
      <div className="seg" role="tablist">{([["export", "匯出衣物"], ["character", "匯出角色素材"], ["import", "匯入套件"]] as const).map(([k, l]) => <button key={k} type="button" aria-selected={tab === k} onClick={() => setTab(k)} data-pkg-tab={k}>{l}</button>)}</div>
      {tab === "export" ? <ExportGarments /> : tab === "character" ? <ExportCharacter /> : <ImportPackage />}
    </div>
  );
}

function ExportGarments() {
  const [all, setAll] = useState<Garment[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cat, setCat] = useState("");
  const [originals, setOriginals] = useState(false);
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { loadFullList(new URLSearchParams()).then(setAll).catch(() => setAll([])); }, []);
  const cats = useMemo(() => [...new Set((all ?? []).map((g) => g.category).filter((x): x is string => !!x))], [all]);
  const shown = (all ?? []).filter((g) => !cat || g.category === cat);
  if (!all) return <Spinner />;
  return (
    <div className="space-y-2" data-testid="pkg-export">
      <div className="scrollbar-none -mx-1 flex gap-1 overflow-x-auto px-1">{["", ...cats].map((c) => <button key={c || "all"} type="button" aria-pressed={cat === c} onClick={() => setCat(c)} className={`h-7 shrink-0 rounded-full px-2.5 text-[12px] ${cat === c ? "chip-on" : "chip"}`}>{c || "全部"}</button>)}</div>
      <div className="grid max-h-[40vh] grid-cols-4 gap-1.5 overflow-y-auto">
        {shown.map((g) => <button key={g.id} type="button" aria-pressed={picked.has(g.id)} onClick={() => setPicked((s) => { const n = new Set(s); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; })} className={`text-center text-[10px] ${picked.has(g.id) ? "" : "opacity-60"}`} data-pkg-pick={g.id}>
          <span className={`arch-base block aspect-[3/4] overflow-hidden rounded-xl ${picked.has(g.id) ? "ring-2 ring-[var(--aw-focus)]" : ""}`}>{g.thumb_image_id && <img src={`/api/thumbnails/${g.thumb_image_id}`} alt="" loading="lazy" className="h-full w-full object-contain" />}</span>
          <span className="block truncate">{displayName(g)}</span>
        </button>)}
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={originals} onChange={(e) => setOriginals(e.target.checked)} />包含原始相片（可能有人像或拍攝資料）</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />包含價格及備註</label>
      <Button className="w-full" disabled={!picked.size || !!busy} data-testid="pkg-export-run" onClick={async () => { setBusy("準備中…"); try { const r = await exportGarments([...picked], { originals, privateFields: priv }, (d, t) => setBusy(`打包圖片 ${d}/${t}`)); await deliver(r.blob, r.name); toast("已匯出套件"); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(null); } }}>{busy ?? `匯出 ${picked.size} 件衣物`}</Button>
    </div>
  );
}

function ExportCharacter() {
  const [list, setList] = useState<{ id: string; kind: string; name: string; has_thumb?: boolean | number }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { api<{ assets: { id: string; kind: string; name: string; has_thumb?: number }[] }>("/api/doll/assets").then((r) => setList(r.assets.filter((a) => a.kind === "head" || a.kind === "hair"))).catch(() => setList([])); }, []);
  if (!list) return <Spinner />;
  if (!list.length) return <p className="py-4 text-center text-mauve">未有自訂的頭部或髮型素材（內置素材毋須分享）。</p>;
  return (
    <div className="space-y-2" data-testid="pkg-character">
      {list.map((a) => <label key={a.id} className="chip flex items-center gap-2 rounded-2xl p-2" data-pkg-asset={a.id}><input type="checkbox" checked={picked.has(a.id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(a.id)) n.delete(a.id); else n.add(a.id); return n; })} />{a.has_thumb ? <img src={`/api/doll/assets/${a.id}/thumb`} alt="" className="h-10 w-10 rounded-lg object-contain" /> : null}<span className="flex-1">{a.name}</span><span className="text-[11px] text-mauve">{a.kind === "head" ? "頭部" : "髮型"}</span></label>)}
      <Button className="w-full" disabled={!picked.size || !!busy} data-testid="pkg-character-run" onClick={async () => { setBusy("準備中…"); try { const r = await exportCharacterAssets([...picked], (d, t) => setBusy(`打包圖片 ${d}/${t}`)); await deliver(r.blob, r.name); toast("已匯出套件"); } catch (e) { toast((e as Error).message, "err"); } finally { setBusy(null); } }}>{busy ?? `匯出 ${picked.size} 個素材`}</Button>
    </div>
  );
}

function ImportPackage() {
  const [prev, setPrev] = useState<ImportPreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<{ garments: string[]; assets: string[]; applied: number; skipped: number } | null>(null);
  return (
    <div className="space-y-2" data-testid="pkg-import" data-state={done ? "done" : prev ? "preview" : err ? "error" : "idle"}>
      <label className="chip flex h-11 cursor-pointer items-center justify-center rounded-2xl">選擇套件檔案（.zip）<input type="file" accept=".zip,application/zip" className="hidden" data-testid="pkg-file" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; setErr(null); setPrev(null); setDone(null); setBusy("驗證中…"); try { setPrev(await inspectPackage(f)); } catch (x) { setErr((x as Error).message); } finally { setBusy(null); } }} /></label>
      {busy && <p role="status" className="text-mauve">{busy}</p>}
      {err && <p role="alert" className="text-wine" data-testid="pkg-error">未能匯入：{err}（沒有寫入任何資料）</p>}
      {prev && !done && (
        <div className="paper space-y-1.5 p-3" data-testid="pkg-preview">
          <p className="font-serif text-[15px] font-bold">{prev.manifest.title}</p>
          <p className="text-[12px] text-mauve">{prev.manifest.package_type === "garments" ? "衣物套件" : "角色素材套件"}・版本 {prev.manifest.format_version}・{prev.manifest.garments.length} 件衣物・{prev.manifest.assets.length} 個素材・{Object.keys(prev.manifest.files).length} 張圖片</p>
          {prev.compat.length > 0 && <ul className="text-[12px]" data-testid="pkg-compat">{prev.compat.map((c, i) => <li key={i}>{c.garment}：{c.model} {c.compat === "same" ? "✓ 直接套用" : "⚠ 需要重新校正"}</li>)}</ul>}
          {prev.warnings.map((w) => <p key={w} className="text-[12px] text-wine">⚠ {w}</p>)}
          <p className="text-[11px] text-mauve">匯入會建立新的獨立副本（新 ID），不會覆蓋你現有的衣物或素材。</p>
          <Button className="w-full" disabled={!!busy} data-testid="pkg-confirm" onClick={async () => { setBusy("匯入中…"); try { const r = await commitImport(prev, setBusy); setDone({ garments: r.garments, assets: r.assets, applied: r.applied_templates, skipped: r.skipped_templates }); toast("已匯入"); } catch (x) { setErr((x as Error).message); setPrev(null); } finally { setBusy(null); } }}>確認匯入</Button>
        </div>
      )}
      {done && (
        <div className="paper space-y-1.5 p-3" data-testid="pkg-done">
          <p>已匯入 {done.garments.length} 件衣物、{done.assets.length} 個素材；套用 {done.applied} 個衣服設定{done.skipped ? `，${done.skipped} 個需要重新校正` : ""}。</p>
          {done.garments[0] && <Button variant="ghost" onClick={() => navigate(`/g/${done.garments[0]}`)}>查看衣物</Button>}
        </div>
      )}
    </div>
  );
}
