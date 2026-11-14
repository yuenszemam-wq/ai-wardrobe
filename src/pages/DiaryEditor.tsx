// Phase 3.9A.1：新增／修改穿搭紀錄。真人照片（相機或相簿，多張、排序、旋轉、裁切、封面）、衣物、已有穿搭、場合、標籤等。
// 未保存的內容存為這部手機的草稿；照片上傳失敗可以重試，不會遺失已填寫資料。
import { useEffect, useMemo, useRef, useState } from "react";
import { Garment, api } from "../api";
import { Button, GarmentTile, Link, Sheet, Spinner, toast } from "../components/ui";
import { IconPlus, IconSearch } from "../components/icons";
import { DiaryEntry, DiaryKind, KIND_LABEL, PendingPhoto, clearDraft, diaryApi, fmtDate, loadEntry, localDate, localTime, localTz, monthOf, photoThumb, processPhoto, readDraft, saveDraft, snapUrl, uploadPhoto } from "../diary";
import { loadFullList } from "../wardrobeList";
import { navigate, usePath } from "../router";
import { useTaxonomy } from "../taxonomy";

interface Form { title: string; worn_date: string; worn_time: string; kind: DiaryKind; occasion: string; location: string; weather: string; tags: string; notes: string; is_favorite: boolean; items: { garment_id: string; part: string; name: string; thumb: string | null }[]; outfit_id: string | null; look_id: string | null; source_name: string | null }
const emptyForm = (date: string, kind: DiaryKind = "worn"): Form => ({ title: "", worn_date: date, worn_time: date === localDate() ? localTime() : "", kind, occasion: "", location: "", weather: "", tags: "", notes: "", is_favorite: false, items: [], outfit_id: null, look_id: null, source_name: null });
const fromEntry = (e: DiaryEntry): Form => ({ title: e.title ?? "", worn_date: e.worn_date, worn_time: e.worn_time ?? "", kind: e.kind, occasion: e.occasion ?? "", location: e.location ?? "", weather: e.weather ?? "", tags: e.tags.map((t) => "#" + t).join(" "), notes: e.notes ?? "", is_favorite: e.is_favorite, items: e.items.map((i) => ({ garment_id: i.garment_id, part: i.part, name: i.name, thumb: i.snap_id ? snapUrl(i.snap_id) : null })), outfit_id: e.outfit_id, look_id: e.look_id, source_name: e.source_name });
let seq = 0;

export default function DiaryEditor({ id }: { id?: string }) {
  const path = usePath();
  const qs = useMemo(() => new URLSearchParams(path.split("?")[1] ?? ""), [path]);
  const draftKey = id ?? "new";
  const [entry, setEntry] = useState<DiaryEntry | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<"garments" | "looks" | null>(null);
  const [cover, setCover] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const camera = useRef<HTMLInputElement>(null), album = useRef<HTMLInputElement>(null);

  // 初始化：修改＝讀取紀錄；新增＝草稿或空白（可由工作室帶入造型）
  useEffect(() => {
    const draft = readDraft<Form>(draftKey);
    if (id) {
      loadEntry(id).then(({ data }) => { setEntry(data); setForm(draft ?? fromEntry(data)); setCover(data.cover_photo_id); setOrder(data.photos.map((p) => p.id)); if (draft) toast("已恢復未保存的草稿"); }).catch((e) => setError((e as Error).message));
      return;
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(qs.get("date") ?? "") ? qs.get("date")! : localDate();
    const kind = (["worn", "planned", "inspiration"].includes(qs.get("kind") ?? "") ? qs.get("kind") : date > localDate() ? "planned" : "worn") as DiaryKind;
    const f = draft && !qs.get("outfit") && !qs.get("look") ? draft : emptyForm(date, kind);
    if (draft && f === draft) toast("已恢復未保存的草稿");
    const outfit = qs.get("outfit"), look = qs.get("look");
    setForm(f);
    // 由工作室「加入穿搭日誌」帶入造型的衣物清單（不修改原造型）
    if (outfit || look) setPending({ kind: outfit ? "outfit" : "look", id: (outfit || look)! });
    else if (qs.get("garment")) setPending({ kind: "garment", id: qs.get("garment")! });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pending, setPending] = useState<{ kind: "outfit" | "look" | "garment"; id: string } | null>(null);
  useEffect(() => { if (form && pending) { const p = pending; setPending(null); void importLook(p.kind, p.id); } }, [form, pending]); // eslint-disable-line react-hooks/exhaustive-deps
  async function importLook(kind: "outfit" | "look" | "garment", lid: string, name?: string) {
    try {
      const o: { name?: string; items?: { garment_id: string }[]; garments?: { id: string }[] } = kind === "garment" ? { items: [{ garment_id: lid }], name: "" } : await api<{ name?: string; items?: { garment_id: string }[]; garments?: { id: string }[] }>(kind === "outfit" ? `/api/outfits/${lid}` : `/api/doll/looks/${lid}`);
      const ids = o.items?.map((x) => x.garment_id) ?? o.garments?.map((g) => g.id) ?? [];
      const all = await loadFullList(new URLSearchParams("status=all")).catch(() => [] as Garment[]);
      const label = name ?? o.name ?? "";
      setForm((f) => {
        if (!f) return f;
        const add = ids.filter((gid) => !f.items.some((x) => x.garment_id === gid && !x.part)).map((gid) => { const g = all.find((x) => x.id === gid); return { garment_id: gid, part: "", name: g?.name ?? gid, thumb: g && (g.primary_image_id || g.thumb_image_id) ? `/api/thumbnails/${g.primary_image_id || g.thumb_image_id}` : null }; });
        if (kind !== "garment") toast(`已帶入 ${add.length} 件衣物（原造型不會被修改）`);
        return { ...f, items: [...f.items, ...add], outfit_id: kind === "outfit" ? lid : f.outfit_id, look_id: kind === "look" ? lid : f.look_id, source_name: label || f.source_name, title: f.title || label };
      });
    } catch (e) { toast((e as Error).message, "err"); }
  }
  // 草稿：每次修改都保存在這部手機
  useEffect(() => { if (form) saveDraft(draftKey, form); }, [form, draftKey]);
  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="frame mt-3 p-4 text-[13px]" role="alert">未能開啟紀錄：{error}<Link to="/diary" className="ml-2 underline">返回日誌</Link></div>;
  if (!form) return <Spinner />;
  const up = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)).slice(0, 12 - photos.length - order.length);
    setPhotos((p) => [...p, ...list.map((file) => ({ key: "p" + ++seq, file, rotate: 0 as const, crop: "original" as const, preview: URL.createObjectURL(file), state: "waiting" as const, progress: 0 }))]);
  };
  const patchPhoto = (key: string, v: Partial<PendingPhoto>) => setPhotos((ps) => ps.map((p) => (p.key === key ? { ...p, ...v } : p)));
  /** 上傳等待中的照片；失敗的保留，可重試 */
  async function uploadAll(entryId: string, list = photos) {
    let ok = true;
    for (const p of list) {
      if (p.state === "done") continue;
      patchPhoto(p.key, { state: "uploading", progress: 0, error: undefined });
      try {
        const out = await processPhoto(p.file, { rotate: p.rotate, crop: p.crop });
        patchPhoto(p.key, { size: out.main.size });
        const r = await uploadPhoto(entryId, out.main, out.thumb, (x) => patchPhoto(p.key, { progress: x }));
        patchPhoto(p.key, { state: "done", progress: 1, uploadedId: r.photo.id });
      } catch (e) { ok = false; patchPhoto(p.key, { state: "failed", error: (e as Error).message }); }
    }
    return ok;
  }
  async function save() {
    if (!form) return;
    setBusy(true);
    const body = { title: form.title, worn_date: form.worn_date, worn_time: form.worn_time || null, kind: form.kind, occasion: form.occasion, location: form.location, weather: form.weather, tags: form.tags, notes: form.notes, is_favorite: form.is_favorite, tz: localTz(), items: form.items.map((i) => ({ garment_id: i.garment_id, part: i.part })) };
    try {
      let saved: DiaryEntry;
      if (entry) saved = await diaryApi.update(entry.id, { ...body, base_updated_at: entry.updated_at, cover_photo_id: cover, photo_order: order });
      else saved = await diaryApi.create({ ...body, outfit_id: form.outfit_id, look_id: form.look_id, import_items: false });
      setEntry(saved);
      const ok = await uploadAll(saved.id);
      if (!ok) { toast("紀錄已保存，但部分照片上傳失敗；可以按「重試上傳」", "err"); setBusy(false); return; }
      clearDraft(draftKey);
      toast(entry ? "已保存" : "已新增穿搭紀錄");
      navigate(`/diary?m=${monthOf(saved.worn_date)}&d=${saved.worn_date}`, true);
    } catch (e) {
      toast((e as Error).message + "（已保留草稿，可以重試）", "err");
    } finally { setBusy(false); }
  }
  const existing = entry ? order.map((pid) => entry.photos.find((p) => p.id === pid)).filter((p): p is NonNullable<typeof p> => !!p) : [];
  const failed = photos.some((p) => p.state === "failed");

  return (
    <div className="space-y-3 pb-28" data-testid="diary-editor" data-mode={entry ? "edit" : "new"}>
      <div className="flex items-center gap-2 pt-2">
        <Link to="/diary" className="chip grid h-9 w-9 place-items-center rounded-full" aria-label="返回">‹</Link>
        <h1 className="flex-1 font-serif text-[19px] font-bold text-gold-soft">{entry ? "修改穿搭紀錄" : "記錄穿搭"}</h1>
      </div>

      <section className="frame space-y-2 p-3 text-[13px]">
        <div className="flex gap-1.5" role="group" aria-label="穿搭類型">
          {(["worn", "planned", "inspiration"] as const).map((k) => <button key={k} type="button" aria-pressed={form.kind === k} data-kind={k} onClick={() => up({ kind: k })} className={`h-8 flex-1 rounded-full text-[12.5px] ${form.kind === k ? "chip-on" : "chip"}`}>{KIND_LABEL[k]}</button>)}
        </div>
        <label className="flex items-center gap-2">日期<input type="date" value={form.worn_date} onChange={(e) => up({ worn_date: e.target.value })} className="field h-9 flex-1 rounded-full px-3 text-[16px]" data-testid="diary-date" /></label>
        <label className="flex items-center gap-2">時間<input type="time" value={form.worn_time} onChange={(e) => up({ worn_time: e.target.value })} className="field h-9 flex-1 rounded-full px-3 text-[16px]" />（選填）</label>
        <input value={form.title} onChange={(e) => up({ title: e.target.value })} maxLength={60} placeholder="穿搭名稱（選填）" className="field h-10 w-full rounded-full px-3 text-[16px]" data-testid="diary-title" />
        <p className="text-[11px] text-mauve">{fmtDate(form.worn_date)}（本地日期）{form.source_name ? `｜來自：${form.source_name}` : ""}</p>
      </section>

      <section className="frame space-y-2 p-3" data-testid="diary-photos">
        <h3 className="font-serif text-[14px] text-gold-soft">真人穿搭照片<span className="ml-1 font-sans text-[11px] text-mauve">預設私人；上傳前移除位置等資料</span></h3>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => camera.current?.click()} data-testid="diary-camera">拍攝</Button>
          <Button variant="ghost" onClick={() => album.current?.click()} data-testid="diary-album">從相簿選擇</Button>
          <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          <input ref={album} type="file" accept="image/*" multiple className="hidden" data-testid="diary-file" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {existing.map((p, i) => (
            <div key={p.id} className="relative overflow-hidden rounded-xl" data-photo={p.id}>
              <img src={photoThumb(p.id)} alt="" className="aspect-[3/4] w-full object-cover" />
              {cover === p.id && <span className="chip-on absolute left-1 top-1 rounded-full px-1.5 text-[10px]">封面</span>}
              <div className="absolute inset-x-1 bottom-1 flex justify-between gap-0.5 text-[11px]">
                <button type="button" className="doll-tool rounded-full px-1.5" onClick={() => setCover(p.id)} aria-label="設為封面">★</button>
                <button type="button" className="doll-tool rounded-full px-1.5" disabled={i === 0} onClick={() => { const o = [...order]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; setOrder(o); }} aria-label="向前">‹</button>
                <button type="button" className="doll-tool rounded-full px-1.5" onClick={async () => { if (!entry || !confirm("刪除這張照片？")) return; try { await diaryApi.removePhoto(entry.id, p.id); setOrder(order.filter((x) => x !== p.id)); if (cover === p.id) setCover(null); } catch (e) { toast((e as Error).message, "err"); } }} aria-label="刪除">✕</button>
              </div>
            </div>
          ))}
          {photos.map((p, i) => (
            <div key={p.key} className="relative overflow-hidden rounded-xl" data-pending={p.state}>
              <img src={p.preview} alt="" className={`aspect-[3/4] w-full ${p.crop === "original" ? "object-contain" : "object-cover"} bg-cream/5`} style={{ transform: `rotate(${p.rotate}deg)` }} />
              {p.state !== "waiting" && <span className="absolute inset-x-1 top-1 rounded-full bg-black/55 px-1.5 text-center text-[10px] text-white" data-status-color>{p.state === "uploading" ? `${Math.round(p.progress * 100)}%${p.size ? "｜" + (p.size / 1e6).toFixed(1) + " MB" : ""}` : p.state === "done" ? "已上傳" : "失敗"}</span>}
              {p.state !== "done" && <div className="absolute inset-x-1 bottom-1 flex justify-between gap-0.5 text-[11px]">
                <button type="button" className="doll-tool rounded-full px-1.5" onClick={() => patchPhoto(p.key, { rotate: ((p.rotate + 90) % 360) as PendingPhoto["rotate"] })} aria-label="旋轉">⟳</button>
                <button type="button" className="doll-tool rounded-full px-1.5" onClick={() => patchPhoto(p.key, { crop: p.crop === "original" ? "3:4" : p.crop === "3:4" ? "1:1" : "original" })} aria-label="裁切">{p.crop === "original" ? "原" : p.crop}</button>
                <button type="button" className="doll-tool rounded-full px-1.5" disabled={i === 0} onClick={() => setPhotos((ps) => { const o = [...ps]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; return o; })} aria-label="向前">‹</button>
                <button type="button" className="doll-tool rounded-full px-1.5" onClick={() => { URL.revokeObjectURL(p.preview); setPhotos((ps) => ps.filter((x) => x.key !== p.key)); }} aria-label="移除">✕</button>
              </div>}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-mauve">{existing.length + photos.length}／12 張｜照片會壓縮至最長邊 2560px（約 0.5–2 MB），原有位置及相機資料會被移除。{!entry && photos.length ? "第一張照片會成為封面。" : ""}</p>
        {failed && entry && <Button variant="ghost" data-testid="diary-retry" disabled={busy} onClick={async () => { setBusy(true); const ok = await uploadAll(entry.id); setBusy(false); if (ok) { clearDraft(draftKey); toast("照片已上傳"); navigate(`/diary?m=${monthOf(entry.worn_date)}&d=${entry.worn_date}`, true); } }}>重試上傳</Button>}
      </section>

      <section className="frame space-y-2 p-3" data-testid="diary-items">
        <div className="flex items-center gap-2"><h3 className="flex-1 font-serif text-[14px] text-gold-soft">實際穿著衣物（{new Set(form.items.map((i) => i.garment_id)).size} 件）</h3>
          <Button variant="ghost" onClick={() => setPicker("looks")} data-testid="diary-pick-look">使用已有穿搭</Button>
          <Button variant="ghost" onClick={() => setPicker("garments")} data-testid="diary-pick-garments"><IconPlus />衣物</Button></div>
        {form.items.length ? (
          <ul className="grid grid-cols-4 gap-2" data-testid="diary-item-list">
            {form.items.map((it) => (
              <li key={it.garment_id + it.part} className="relative text-center text-[10.5px]" data-item={it.garment_id}>
                <div className="arch-base aspect-[3/4] overflow-hidden rounded-xl">{it.thumb ? <img src={it.thumb} alt="" className="h-full w-full object-contain" /> : null}</div>
                <p className="truncate">{it.name}</p>
                <button type="button" aria-label="移除" className="doll-tool absolute right-0 top-0 grid h-6 w-6 place-items-center rounded-full text-[11px]" onClick={() => up({ items: form.items.filter((x) => x !== it) })}>✕</button>
              </li>
            ))}
          </ul>
        ) : <p className="text-[12px] text-mauve">可以只拍照、只選衣物，或兩者都有。</p>}
      </section>

      <section className="frame space-y-2 p-3 text-[13px]">
        <div className="grid grid-cols-2 gap-2">
          <input value={form.occasion} onChange={(e) => up({ occasion: e.target.value })} placeholder="場合（例如上班）" className="field h-9 rounded-full px-3 text-[16px]" data-testid="diary-occasion" />
          <input value={form.weather} onChange={(e) => up({ weather: e.target.value })} placeholder="天氣（選填）" className="field h-9 rounded-full px-3 text-[16px]" />
        </div>
        <input value={form.location} onChange={(e) => up({ location: e.target.value })} placeholder="地點（選填；不會讀取定位）" className="field h-9 w-full rounded-full px-3 text-[16px]" />
        <input value={form.tags} onChange={(e) => up({ tags: e.target.value })} placeholder="#標籤 #茶會" className="field h-9 w-full rounded-full px-3 text-[16px]" data-testid="diary-tags" />
        <textarea value={form.notes} onChange={(e) => up({ notes: e.target.value })} rows={3} placeholder="備註" className="field w-full rounded-2xl px-3 py-2 text-[16px]" />
        <label className="flex items-center justify-between">收藏<button type="button" role="switch" aria-checked={form.is_favorite} onClick={() => up({ is_favorite: !form.is_favorite })} className="switch" /></label>
      </section>

      <div className="sticky-actions frame flex gap-2 p-2">
        <Button variant="ghost" disabled={busy} onClick={() => { if (confirm("放棄未保存的修改？")) { clearDraft(draftKey); navigate("/diary"); } }}>取消</Button>
        <Button className="flex-1" disabled={busy || !form.worn_date} onClick={() => void save()} data-testid="diary-save">{busy ? "保存中…" : "保存"}</Button>
      </div>
      {picker === "garments" && <GarmentPicker chosen={form.items} onClose={() => setPicker(null)} onDone={(items) => { up({ items }); setPicker(null); }} />}
      {picker === "looks" && <LookPicker onClose={() => setPicker(null)} onPick={(kind, lid, name) => { setPicker(null); void importLook(kind, lid, name); }} />}
    </div>
  );
}

/** 從衣櫃選擇衣物：主分類、子分類、搜尋、收藏；套裝可選擇部件 */
function GarmentPicker({ chosen, onClose, onDone }: { chosen: Form["items"]; onClose: () => void; onDone: (items: Form["items"]) => void }) {
  const tax = useTaxonomy();
  const [all, setAll] = useState<Garment[] | null>(null);
  const [cat, setCat] = useState(""), [sub, setSub] = useState(""), [q, setQ] = useState(""), [fav, setFav] = useState(false);
  const [sel, setSel] = useState<Form["items"]>(chosen);
  const [parts, setParts] = useState<{ g: Garment; list: { id: string; name: string }[] } | null>(null);
  useEffect(() => { loadFullList(new URLSearchParams()).then(setAll).catch((e) => { toast((e as Error).message, "err"); setAll([]); }); }, []);
  const list = (all ?? []).filter((g) => (!cat || g.category === cat) && (!sub || g.subcategory === sub) && (!fav || g.is_favorite) && (!q || [g.name, g.brand, g.subcategory].some((x) => x?.toLowerCase().includes(q.toLowerCase()))));
  const subs = [...new Set((all ?? []).filter((g) => g.category === cat).map((g) => g.subcategory).filter(Boolean))] as string[];
  const thumbOf = (g: Garment) => (g.primary_image_id || g.thumb_image_id ? `/api/thumbnails/${g.primary_image_id || g.thumb_image_id}` : null);
  const has = (gid: string, part = "") => sel.some((x) => x.garment_id === gid && x.part === part);
  const toggle = (g: Garment, part = "", name = g.name) => setSel((s) => (has(g.id, part) ? s.filter((x) => !(x.garment_id === g.id && x.part === part)) : [...s, { garment_id: g.id, part, name, thumb: thumbOf(g) }]));
  return (
    <Sheet title="選擇今天穿過的衣服" onClose={onClose}>
      <div className="space-y-2" data-testid="diary-garment-picker">
        <div className="relative"><IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋名稱、品牌…" className="field h-9 w-full rounded-full pl-9 pr-3 text-[16px]" /></div>
        <div className="scrollbar-none flex gap-1 overflow-x-auto">{["", ...tax.categories.map((c) => c.name)].map((c) => <button key={c || "all"} type="button" aria-pressed={cat === c} onClick={() => { setCat(c); setSub(""); }} className={`h-7 shrink-0 rounded-full px-2.5 text-[12px] ${cat === c ? "chip-on" : "chip"}`}>{c || "全部"}</button>)}
          <button type="button" aria-pressed={fav} onClick={() => setFav(!fav)} className={`h-7 shrink-0 rounded-full px-2.5 text-[12px] ${fav ? "chip-on" : "chip"}`}>♥</button></div>
        {cat && subs.length > 0 && <div className="scrollbar-none flex gap-1 overflow-x-auto">{["", ...subs].map((s) => <button key={s || "all"} type="button" aria-pressed={sub === s} onClick={() => setSub(s)} className={`h-6 shrink-0 rounded-full px-2 text-[11.5px] ${sub === s ? "chip-on" : "chip"}`}>{s || "全部"}</button>)}</div>}
        {!all ? <Spinner /> : (
          <div className="grid max-h-[46dvh] grid-cols-3 gap-2 overflow-y-auto overscroll-contain">
            {list.map((g) => (
              <div key={g.id} className="relative" data-pick-garment={g.id}>
                <GarmentTile g={g} size="sm" selected={has(g.id)} onSelect={() => toggle(g)} />
                {(g.category === "套裝" || g.category === "套裝部件") && <button type="button" className="chip absolute right-0 top-0 rounded-full px-1.5 text-[10px]" onClick={async () => { try { const r = await api<{ assets: { id: string; name: string }[] }>(`/api/doll/assets?kind=garment_part&garment_id=${g.id}`); setParts({ g, list: r.assets }); } catch (e) { toast((e as Error).message, "err"); } }}>部件</button>}
              </div>
            ))}
          </div>
        )}
        {parts && (
          <div className="frame space-y-1 p-2 text-[12.5px]" data-testid="diary-parts">
            <p>「{parts.g.name}」的部件（只計一件衣物）</p>
            <div className="flex flex-wrap gap-1">{parts.list.length ? parts.list.map((p) => <button key={p.id} type="button" aria-pressed={has(parts.g.id, p.id)} onClick={() => toggle(parts.g, p.id, `${parts.g.name}｜${p.name}`)} className={`h-7 rounded-full px-2.5 ${has(parts.g.id, p.id) ? "chip-on" : "chip"}`}>{p.name}</button>) : <span className="text-mauve">沒有部件</span>}</div>
          </div>
        )}
        <Button className="w-full" onClick={() => onDone(sel)} data-testid="diary-picker-done">完成（{new Set(sel.map((x) => x.garment_id)).size} 件）</Button>
      </div>
    </Sheet>
  );
}

function LookPicker({ onClose, onPick }: { onClose: () => void; onPick: (kind: "outfit" | "look", id: string, name: string) => void }) {
  const [data, setData] = useState<{ outfits: { id: string; name: string; is_favorite?: boolean | number }[]; looks: { id: string; name: string; is_favorite?: boolean | number }[] } | null>(null);
  const [tab, setTab] = useState<"outfit" | "look">("outfit"), [fav, setFav] = useState(false);
  useEffect(() => { Promise.all([api<{ outfits: { id: string; name: string; is_favorite?: boolean | number }[] }>("/api/outfits"), api<{ looks: { id: string; name: string; is_favorite?: boolean | number }[] }>("/api/doll/looks")]).then(([o, l]) => setData({ outfits: o.outfits, looks: l.looks })).catch((e) => { toast((e as Error).message, "err"); setData({ outfits: [], looks: [] }); }); }, []);
  const list = (tab === "outfit" ? data?.outfits : data?.looks)?.filter((x) => !fav || x.is_favorite) ?? [];
  return (
    <Sheet title="使用已有穿搭" onClose={onClose}>
      <div className="space-y-2" data-testid="diary-look-picker">
        <div className="flex gap-1"><button type="button" aria-pressed={tab === "outfit"} onClick={() => setTab("outfit")} className={`h-8 flex-1 rounded-full text-[12.5px] ${tab === "outfit" ? "chip-on" : "chip"}`}>衣服配搭</button><button type="button" aria-pressed={tab === "look"} onClick={() => setTab("look")} className={`h-8 flex-1 rounded-full text-[12.5px] ${tab === "look" ? "chip-on" : "chip"}`}>角色換裝</button><button type="button" aria-pressed={fav} onClick={() => setFav(!fav)} className={`h-8 rounded-full px-3 text-[12.5px] ${fav ? "chip-on" : "chip"}`}>♥ 收藏</button></div>
        {!data ? <Spinner /> : list.length ? <ul className="max-h-[50dvh] space-y-1 overflow-y-auto">{list.map((x) => <li key={x.id}><button type="button" data-pick-look={x.id} onClick={() => onPick(tab, x.id, x.name)} className="chip w-full rounded-2xl px-3 py-2 text-left text-[13px]">{x.is_favorite ? "♥ " : ""}{x.name}</button></li>)}</ul> : <p className="py-4 text-center text-[12.5px] text-mauve">沒有已保存的{tab === "outfit" ? "衣服配搭" : "角色造型"}</p>}
        <p className="text-[11px] text-mauve">只會帶入衣物清單，不會修改原本的造型。</p>
      </div>
    </Sheet>
  );
}
