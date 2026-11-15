/**
 * Phase 3.9A.2：我的素材庫／我的背景。緊湊卡片，每件素材以「⋯」集中管理（改名、分類、收藏、原圖／去背圖、刪除）。
 * 刪除仍被造型使用的素材時只移出素材庫，不會令舊造型缺圖。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { IconChevronLeft, IconHeart, IconMore, IconPlus, IconSearch } from "../components/icons";
import { Button, Empty, Link, Sheet, Spinner, toast } from "../components/ui";
import { navigate, usePath } from "../router";
import { ASSET_KIND_LABEL, AssetKind, StudioAsset, deleteStudioAsset, getStudioAsset, listStudioAssets, patchStudioAsset } from "../studio/assets";
import { AssetUploadSheet } from "./OutfitStudio";

export default function StudioAssets() {
  const path = usePath();
  const qs = useMemo(() => new URLSearchParams(path.split("?")[1] || ""), [path]);
  const kind = (qs.get("kind") ?? "") as AssetKind | "";
  const [q, setQ] = useState("");
  const [fav, setFav] = useState(false);
  const [list, setList] = useState<StudioAsset[] | null>(null);
  const [open, setOpen] = useState<StudioAsset | null>(null);
  const [upload, setUpload] = useState<File | null>(null);
  const load = useCallback(() => listStudioAssets({ ...(kind ? { kind } : {}), ...(q ? { q } : {}), favorite: fav }).then(setList).catch((e) => { toast((e as Error).message, "err"); setList([]); }), [kind, q, fav]);
  useEffect(() => { void load(); }, [load]);
  const setKind = (k: string) => navigate(`/studio/assets${k ? `?kind=${k}` : ""}`, true, false);
  return (
    <div className="space-y-3 pb-6" data-testid="studio-assets" data-kind={kind}>
      <div className="flex items-center gap-2 pt-3">
        <Link to="/outfits?tab=assets" className="icon-btn" aria-label="返回素材管理"><IconChevronLeft /></Link>
        <h1 className="flex-1 font-serif text-[20px] font-bold text-gold-soft">{kind === "background" ? "我的背景" : "我的素材庫"}</h1>
        <label className="btn-jewel flex h-9 cursor-pointer items-center gap-1 rounded-full px-3 text-[13px]"><IconPlus />上傳<input type="file" accept="image/*" className="hidden" data-testid="library-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) setUpload(f); }} /></label>
      </div>
      <div className="flex gap-1.5">
        <div className="relative min-w-0 flex-1"><IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--aw-placeholder)]" /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋素材名稱" className="field h-9 w-full rounded-full pl-9 pr-3 text-[16px]" /></div>
        <button type="button" aria-pressed={fav} aria-label="只看收藏" onClick={() => setFav(!fav)} className={`icon-btn h-9 w-9 ${fav ? "icon-btn-on" : ""}`}><IconHeart filled={fav} /></button>
      </div>
      <div className="scrollbar-none -mx-4 flex gap-1.5 overflow-x-auto px-4">{[["", "全部"], ...Object.entries(ASSET_KIND_LABEL)].map(([k, l]) => <button key={k || "all"} type="button" aria-pressed={kind === k} data-kind={k || "all"} onClick={() => setKind(k)} className={`h-8 shrink-0 rounded-full px-3 text-[12.5px] ${kind === k ? "chip-on" : "chip"}`}>{l}</button>)}</div>
      {!list ? <Spinner /> : !list.length ? <Empty title="未有素材">上傳圖片並選擇「保存到我的素材庫」，或在工作室把素材保存到素材庫。</Empty> : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" data-testid="library-grid">
          {list.map((a) => (
            <div key={a.id} className="card-flat relative overflow-hidden p-1.5" data-asset={a.id}>
              <button type="button" onClick={() => setOpen(a)} className="checker block aspect-square w-full overflow-hidden rounded-xl">{a.version && <img src={a.version.thumb_url} alt="" loading="lazy" className="h-full w-full object-contain" />}</button>
              <p className="mt-1 truncate text-[12px]">{a.is_favorite ? "♥ " : ""}{a.name}</p>
              <p className="truncate text-[10.5px] text-mauve">{ASSET_KIND_LABEL[a.kind]}{a.version?.has_cutout ? "・已去背" : ""}{a.used_by ? `・${a.used_by} 個造型使用` : ""}</p>
              <button type="button" aria-label="更多" onClick={() => setOpen(a)} className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full doll-tool" data-testid="asset-more"><IconMore /></button>
            </div>
          ))}
        </div>
      )}
      {open && <AssetSheet a={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); void load(); }} />}
      {upload && <AssetUploadSheet file={upload} defaultKind={kind || "decoration"} onClose={() => setUpload(null)} onDone={async (a) => { setUpload(null); if (!a.in_library) await patchStudioAsset(a.id, { in_library: true }).catch(() => undefined); toast("已加入素材庫"); void load(); }} />}
    </div>
  );
}

function AssetSheet({ a, onClose, onChanged }: { a: StudioAsset; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(a.name);
  const [kind, setKind] = useState<AssetKind>(a.kind);
  const [show, setShow] = useState<"original" | "cutout">(a.version?.has_cutout ? "cutout" : "original");
  const [detail, setDetail] = useState<StudioAsset | null>(null);
  useEffect(() => { getStudioAsset(a.id).then(setDetail).catch(() => undefined); }, [a.id]);
  const save = async (p: Parameters<typeof patchStudioAsset>[1], msg = "已更新") => { try { await patchStudioAsset(a.id, p); toast(msg); onChanged(); } catch (e) { toast((e as Error).message, "err"); } };
  return (
    <Sheet title={a.name} onClose={onClose}>
      <div className="space-y-2.5 text-[12.5px]" data-testid="asset-sheet">
        {a.version && <div className="checker mx-auto aspect-square w-full max-w-[14rem] overflow-hidden rounded-2xl"><img src={show === "cutout" && a.version.cutout_url ? a.version.cutout_url : a.version.url} alt="" className="h-full w-full object-contain" /></div>}
        {a.version?.has_cutout && <div className="seg">{(["original", "cutout"] as const).map((v) => <button key={v} type="button" aria-selected={show === v} onClick={() => setShow(v)}>{v === "original" ? "原圖" : "去背圖"}</button>)}</div>}
        <label className="flex items-center gap-2"><span className="w-10 text-mauve">名稱</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className="field h-9 flex-1 rounded-full px-3 text-[16px]" /></label>
        <div className="flex flex-wrap gap-1"><span className="w-10 self-center text-mauve">分類</span>{Object.entries(ASSET_KIND_LABEL).map(([k, l]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k as AssetKind)} className={`h-7 rounded-full px-2.5 ${kind === k ? "chip-on" : "chip"}`}>{l}</button>)}</div>
        <p className="text-mauve" data-testid="asset-usage">{detail?.usage ? (detail.usage.length ? `使用中：${detail.usage.map((u) => u.name).join("、")}` : "未被任何造型使用") : "讀取使用情況…"}</p>
        <div className="grid grid-cols-2 gap-1.5">
          <Button onClick={() => void save({ name, kind })} disabled={!name.trim()}>保存修改</Button>
          <Button variant="ghost" onClick={() => void save({ is_favorite: !a.is_favorite }, a.is_favorite ? "已取消收藏" : "已收藏")}>{a.is_favorite ? "取消收藏" : "收藏"}</Button>
          <Button variant="ghost" onClick={() => navigate("/outfits/new")}>到衣服配搭使用</Button>
          <Button variant="ghost" className="text-wine" data-testid="asset-delete" onClick={async () => {
            const used = detail?.usage?.length ?? 0;
            if (!confirm(used ? `這個素材仍被 ${used} 個造型使用。只會從素材庫移除，已保存的造型不受影響。繼續？` : "刪除這個素材？")) return;
            try { const r = await deleteStudioAsset(a.id); toast(r.deleted ? "已刪除" : "已從素材庫移除（造型仍保留這個素材）"); onChanged(); } catch (e) { toast((e as Error).message, "err"); }
          }}>刪除</Button>
        </div>
      </div>
    </Sheet>
  );
}
