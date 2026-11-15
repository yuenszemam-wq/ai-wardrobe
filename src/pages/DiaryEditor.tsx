// Phase 3.9A.1／3.9A.1.1：新增／修改穿搭紀錄。真人照片（相機或相簿，多張、排序、旋轉、裁切、封面）、衣物、已有穿搭、場合、標籤等。
// 未保存的內容（包括未上傳照片）存為這部手機的 IndexedDB 草稿；照片上傳失敗可以只重試失敗部分，不會遺失已填寫資料。
import { useEffect, useMemo, useRef, useState } from "react";
import { Garment, api } from "../api";
import { Button, GarmentTile, Link, Sheet, Spinner, toast } from "../components/ui";
import { IconCamera, IconImage, IconPlus, IconSearch } from "../components/icons";
import { DiaryEntry, DiaryKind, KIND_LABEL, PendingPhoto, diaryApi, fmtDate, loadEntry, localDate, localTime, localTz, monthOf, photoThumb, processPhoto, snapUrl, uploadPhoto } from "../diary";
import { DraftPhoto, dropDraft, getDraft, moveDraft, newOp, putDraft } from "../diaryDrafts";
import { loadFullList } from "../wardrobeList";
import { navigate, usePath } from "../router";
import { useTaxonomy } from "../taxonomy";

interface Form { title: string; worn_date: string; worn_time: string; kind: DiaryKind; occasion: string; location: string; weather: string; tags: string; notes: string; is_favorite: boolean; items: { garment_id: string; part: string; name: string; thumb: string | null }[]; outfit_id: string | null; look_id: string | null; source_name: string | null }
const emptyForm = (date: string, kind: DiaryKind = "worn"): Form => ({ title: "", worn_date: date, worn_time: date === localDate() ? localTime() : "", kind, occasion: "", location: "", weather: "", tags: "", notes: "", is_favorite: false, items: [], outfit_id: null, look_id: null, source_name: null });
const fromEntry = (e: DiaryEntry): Form => ({ title: e.title ?? "", worn_date: e.worn_date, worn_time: e.worn_time ?? "", kind: e.kind, occasion: e.occasion ?? "", location: e.location ?? "", weather: e.weather ?? "", tags: e.tags.map((t) => "#" + t).join(" "), notes: e.notes ?? "", is_favorite: e.is_favorite, items: e.items.map((i) => ({ garment_id: i.garment_id, part: i.part, name: i.name, thumb: i.snap_id ? snapUrl(i.snap_id) : null })), outfit_id: e.outfit_id, look_id: e.look_id, source_name: e.source_name });
let seq = 0;
type Pending = PendingPhoto & { op: string };
type SaveState = "draft" | "saving" | "server" | "photos_pending" | "failed" | "offline";
const STATE_TEXT: Record<SaveState, string> = { draft: "本機草稿（未上傳）", saving: "保存中…", server: "已保存至伺服器", photos_pending: "日誌已保存，仍有照片待上傳", failed: "保存失敗（草稿保留在這部手機）", offline: "離線：草稿保留在這部手機，連線後再保存" };

/**
 * Phase 3.9A.1.1：記錄穿搭編輯頁。
 * 分區：①基本資料 ②真人照片 ③實際穿著衣物 ④其他資料（預設收合） ⑤固定保存欄（考慮底部選單、安全區及鍵盤）。
 * 草稿（含未上傳照片 Blob、旋轉、裁切、排序及封面）存於 IndexedDB，按帳戶及草稿 ID 分開；成功保存後才清除，取消時經確認才刪除。
 * 照片部分上傳失敗：日誌已保存，已成功的照片不重複上傳（op 冪等），只重試失敗部分。
 */
export default function DiaryEditor({ id }: { id?: string }) {
  const path = usePath();
  const qs = useMemo(() => new URLSearchParams(path.split("?")[1] ?? ""), [path]);
  const draftKey = id ?? "new";
  const [entry, setEntry] = useState<DiaryEntry | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [photos, setPhotos] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<"garments" | "looks" | null>(null);
  const [cover, setCover] = useState<string | null>(null);
  const [pendingCover, setPendingCover] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>("draft");
  const [draftWarn, setDraftWarn] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const camera = useRef<HTMLInputElement>(null), album = useRef<HTMLInputElement>(null);
  const loaded = useRef(false);
  /** 使用者已修改（或已恢復草稿）：之後才寫入草稿，避免打開空白頁就產生草稿 */
  const dirty = useRef(false);

  // 初始化：修改＝讀取紀錄；新增＝草稿或空白（可由工作室帶入造型）
  useEffect(() => {
    let live = true;
    void (async () => {
      const draft = await getDraft<Form>(draftKey);
      if (!live) return;
      const restorePhotos = (d: typeof draft) => {
        if (!d?.photos.length) return;
        // 已上傳的照片不再列為待上傳（重新讀取紀錄後會在「已上傳」顯示）
        setPhotos(d.photos.filter((p) => p.state !== "done").map((p) => ({ key: p.key, op: p.op, file: p.blob as File, rotate: p.rotate, crop: p.crop, preview: URL.createObjectURL(p.blob), state: p.state === "uploading" ? "failed" : p.state, progress: 0, error: p.error, uploadedId: p.uploadedId })));
        setPendingCover(d.pendingCover);
      };
      if (id) {
        try {
          const { data } = await loadEntry(id);
          if (!live) return;
          setEntry(data); setForm(draft?.form ?? fromEntry(data)); if (draft) dirty.current = true;
          const ids = data.photos.map((p) => p.id);
          setCover(draft?.cover && ids.includes(draft.cover) ? draft.cover : data.cover_photo_id);
          setOrder(draft?.order?.length ? [...draft.order.filter((x) => ids.includes(x)), ...ids.filter((x) => !draft.order.includes(x))] : ids);
          restorePhotos(draft);
          if (draft?.photos.some((p) => p.state !== "done")) setState("photos_pending");
          else if (draft) setState("draft");
          else setState("server");
          if (draft) toast(draft.photos.some((p) => p.state !== "done") ? "已恢復草稿：仍有照片待上傳" : "已恢復未保存的草稿");
        } catch (e) { if (live) setError((e as Error).message); }
        loaded.current = true;
        return;
      }
      const date = /^\d{4}-\d{2}-\d{2}$/.test(qs.get("date") ?? "") ? qs.get("date")! : localDate();
      const kind = (["worn", "planned", "inspiration"].includes(qs.get("kind") ?? "") ? qs.get("kind") : date > localDate() ? "planned" : "worn") as DiaryKind;
      const useDraft = draft && !qs.get("outfit") && !qs.get("look");
      setForm(useDraft ? draft!.form : emptyForm(date, kind));
      if (useDraft) { dirty.current = true; restorePhotos(draft); toast(draft!.photos.length ? `已恢復草稿（包括 ${draft!.photos.length} 張未上傳照片）` : "已恢復未保存的草稿"); }
      const outfit = qs.get("outfit"), look = qs.get("look");
      // 由工作室「加入穿搭日誌」帶入造型的衣物清單（不修改原造型）
      if (outfit || look) setPendingImport({ kind: outfit ? "outfit" : "look", id: (outfit || look)! });
      else if (qs.get("garment")) setPendingImport({ kind: "garment", id: qs.get("garment")! });
      loaded.current = true;
    })();
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pendingImport, setPendingImport] = useState<{ kind: "outfit" | "look" | "garment"; id: string } | null>(null);
  useEffect(() => { if (form && pendingImport) { const p = pendingImport; setPendingImport(null); void importLook(p.kind, p.id); } }, [form, pendingImport]); // eslint-disable-line react-hooks/exhaustive-deps
  async function importLook(kind: "outfit" | "look" | "garment", lid: string, name?: string) {
    try {
      const o: { name?: string; items?: { garment_id: string }[]; garments?: { id: string }[] } = kind === "garment" ? { items: [{ garment_id: lid }], name: "" } : await api<{ name?: string; items?: { garment_id: string }[]; garments?: { id: string }[] }>(kind === "outfit" ? `/api/outfits/${lid}` : `/api/doll/looks/${lid}`);
      const ids = o.items?.map((x) => x.garment_id) ?? o.garments?.map((g) => g.id) ?? [];
      const all = await loadFullList(new URLSearchParams("status=all")).catch(() => [] as Garment[]);
      const label = name ?? o.name ?? "";
      dirty.current = true;
      setForm((f) => {
        if (!f) return f;
        const add = [...new Set(ids)].filter((gid) => !f.items.some((x) => x.garment_id === gid && !x.part)).map((gid) => { const g = all.find((x) => x.id === gid); return { garment_id: gid, part: "", name: g?.name ?? gid, thumb: g && (g.primary_image_id || g.thumb_image_id) ? `/api/thumbnails/${g.primary_image_id || g.thumb_image_id}` : null }; });
        if (kind !== "garment") toast(`已帶入 ${add.length} 件衣物（原造型不會被修改）`);
        return { ...f, items: [...f.items, ...add], outfit_id: kind === "outfit" ? lid : f.outfit_id, look_id: kind === "look" ? lid : f.look_id, source_name: label || f.source_name, title: f.title || label };
      });
    } catch (e) { toast((e as Error).message, "err"); }
  }
  // 草稿：每次修改都保存在這部手機（IndexedDB，包括未上傳照片）
  const persist = useRef(0);
  const draftOf = (over?: Partial<{ photos: Pending[]; entryId: string | null }>) => ({
    form: form!, photos: (over?.photos ?? photos).map((p): DraftPhoto => ({ key: p.key, op: p.op, blob: p.file, name: p.file.name || "photo", rotate: p.rotate, crop: p.crop, state: p.state, uploadedId: p.uploadedId, error: p.error })),
    cover, pendingCover, order, entryId: over?.entryId ?? entry?.id ?? null, at: Date.now(),
  });
  useEffect(() => {
    if (!form || !loaded.current || (!dirty.current && !photos.length)) return;
    const n = ++persist.current;
    const t = window.setTimeout(() => { void putDraft(draftKey, draftOf()).then((r) => { if (n === persist.current) setDraftWarn(r === "text" && photos.length > 0); }); }, 250);
    return () => clearTimeout(t);
  }, [form, photos, cover, pendingCover, order, draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="frame mt-3 p-4 text-[13px]" role="alert">未能開啟紀錄：{error}<Link to="/diary" className="ml-2 underline">返回日誌</Link></div>;
  if (!form) return <Spinner />;
  const up = (patch: Partial<Form>) => { dirty.current = true; if (state === "server") setState("draft"); setForm({ ...form, ...patch }); };
  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const list = [...files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)).slice(0, Math.max(0, 12 - photos.length - order.length));
    if (list.length < files.length) toast("每筆紀錄最多 12 張照片", "err");
    dirty.current = true;
    setPhotos((p) => [...p, ...list.map((file) => ({ key: "p" + Date.now().toString(36) + ++seq, op: newOp(), file, rotate: 0 as const, crop: "original" as const, preview: URL.createObjectURL(file), state: "waiting" as const, progress: 0 }))]);
  };
  const patchPhoto = (key: string, v: Partial<Pending>) => setPhotos((ps) => ps.map((p) => (p.key === key ? { ...p, ...v } : p)));
  /** 上傳等待中及失敗的照片；已成功的不再上傳。回傳最新的照片狀態 */
  async function uploadAll(entryId: string, list: Pending[]) {
    const cur = list.map((p) => ({ ...p }));
    for (const p of cur) {
      if (p.state === "done") continue;
      patchPhoto(p.key, { state: "uploading", progress: 0, error: undefined });
      try {
        const out = await processPhoto(p.file, { rotate: p.rotate, crop: p.crop });
        patchPhoto(p.key, { size: out.main.size });
        const r = await uploadPhoto(entryId, out.main, out.thumb, (x) => patchPhoto(p.key, { progress: x }), p.op);
        p.state = "done"; p.uploadedId = r.photo.id; p.error = undefined;
        patchPhoto(p.key, { state: "done", progress: 1, uploadedId: r.photo.id });
      } catch (e) { p.state = "failed"; p.error = (e as Error).message; patchPhoto(p.key, { state: "failed", error: p.error }); }
      // 每張照片完成後即時更新草稿：重新打開時已成功的照片不會再上傳
      void putDraft(entryId, draftOf({ photos: cur, entryId }));
    }
    return cur;
  }
  async function save() {
    if (!form) return;
    if (!navigator.onLine) { setState("offline"); await putDraft(draftKey, draftOf()); toast("目前離線：草稿（包括照片）已保留在這部手機", "err"); return; }
    setBusy(true); setState("saving");
    const body = { title: form.title, worn_date: form.worn_date, worn_time: form.worn_time || null, kind: form.kind, occasion: form.occasion, location: form.location, weather: form.weather, tags: form.tags, notes: form.notes, is_favorite: form.is_favorite, tz: localTz(), items: form.items.map((i) => ({ garment_id: i.garment_id, part: i.part })) };
    try {
      let saved: DiaryEntry;
      if (entry) saved = await diaryApi.update(entry.id, { ...body, base_updated_at: entry.updated_at, cover_photo_id: cover, photo_order: order });
      else {
        saved = await diaryApi.create({ ...body, outfit_id: form.outfit_id, look_id: form.look_id, import_items: false });
        // 紀錄已在伺服器建立：草稿改以紀錄 ID 保存（之後重試只上傳照片，不會建立第二筆紀錄）
        await moveDraft(draftKey, saved.id, draftOf({ entryId: saved.id }));
      }
      setEntry(saved);
      const result = await uploadAll(saved.id, photos);
      const failed = result.filter((p) => p.state !== "done");
      // 新上傳照片的封面及排序
      const coverId = pendingCover ? result.find((p) => p.key === pendingCover)?.uploadedId : null;
      if (coverId) { try { saved = await diaryApi.update(saved.id, { cover_photo_id: coverId }); setEntry(saved); setCover(coverId); setPendingCover(null); } catch { /* 封面稍後可再設定 */ } }
      if (failed.length) {
        setState("photos_pending"); setBusy(false);
        toast(`日誌已保存，仍有 ${failed.length} 張照片待上傳；可以按「重試上傳」`, "err");
        if (!id) navigate(`/diary/${saved.id}/edit`, true, false);
        return;
      }
      await dropDraft(saved.id); await dropDraft(draftKey);
      dirty.current = false; setState("server");
      toast(entry ? "已保存" : "已新增穿搭紀錄");
      navigate(`/diary?m=${monthOf(saved.worn_date)}&d=${saved.worn_date}`, true);
    } catch (e) {
      setState(navigator.onLine ? "failed" : "offline");
      toast((e as Error).message + "（已保留草稿，可以重試）", "err");
    } finally { setBusy(false); }
  }
  async function retryPhotos() {
    if (!entry) return;
    setBusy(true);
    const result = await uploadAll(entry.id, photos);
    setBusy(false);
    if (result.every((p) => p.state === "done")) { await dropDraft(entry.id); setState("server"); toast("照片已全部上傳"); navigate(`/diary?m=${monthOf(entry.worn_date)}&d=${entry.worn_date}`, true); }
    else toast("仍有照片未能上傳，可以稍後再試", "err");
  }
  const existing = entry ? order.map((pid) => entry.photos.find((p) => p.id === pid)).filter((p): p is NonNullable<typeof p> => !!p) : [];
  const failed = photos.some((p) => p.state === "failed");
  const waiting = photos.filter((p) => p.state !== "done").length;
  const moveExisting = (i: number, d: -1 | 1) => { const o = [...order]; const j = i + d; if (j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; dirty.current = true; setOrder(o); };
  const movePending = (i: number, d: -1 | 1) => setPhotos((ps) => { const o = [...ps]; const j = i + d; if (j < 0 || j >= o.length) return ps; [o[i], o[j]] = [o[j], o[i]]; return o; });
  const effCover = cover ?? (pendingCover ? null : existing[0]?.id ?? null);
  const pendCover = pendingCover ?? (!effCover && photos[0] ? photos[0].key : null);

  return (
    <div className="space-y-2.5" data-testid="diary-editor" data-mode={entry ? "edit" : "new"} data-save-state={state}>
      <div className="flex items-center gap-2 pt-2">
        <Link to="/diary" className="icon-btn" aria-label="返回">‹</Link>
        <h1 className="flex-1 font-serif text-[19px] font-bold text-gold-soft">{entry ? "修改穿搭紀錄" : "記錄穿搭"}</h1>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${state === "server" ? "text-mauve" : "chip"}`} data-testid="diary-save-state">{STATE_TEXT[state]}</span>
      </div>

      {/* ① 基本資料 */}
      <section className="card-flat space-y-2 p-3 text-[13px]" data-testid="diary-basic">
        <div className="seg" role="group" aria-label="穿搭類型">
          {(["worn", "planned", "inspiration"] as const).map((k) => <button key={k} type="button" aria-pressed={form.kind === k} aria-selected={form.kind === k} data-kind={k} onClick={() => up({ kind: k })}>{KIND_LABEL[k]}</button>)}
        </div>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <label className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-mauve">日期</span><input type="date" value={form.worn_date} onChange={(e) => up({ worn_date: e.target.value })} className="field h-9 min-w-0 flex-1 rounded-full px-3 text-[16px]" data-testid="diary-date" /></label>
          <label className="flex items-center gap-2"><span className="shrink-0 text-mauve">時間</span><input type="time" value={form.worn_time} onChange={(e) => up({ worn_time: e.target.value })} aria-label="時間（選填）" className="field h-9 w-[7.75rem] rounded-full px-2 text-[16px]" /></label>
        </div>
        <input value={form.title} onChange={(e) => up({ title: e.target.value })} maxLength={60} placeholder="穿搭名稱（選填）" className="field h-10 w-full rounded-full px-3 text-[16px]" data-testid="diary-title" />
        <p className="text-[11px] text-mauve">{fmtDate(form.worn_date)}（本地日期）{form.source_name ? `｜來自：${form.source_name}` : ""}</p>
      </section>

      {/* ② 真人照片 */}
      <section className="card-flat space-y-2 p-3" data-testid="diary-photos">
        <div className="flex items-center gap-2">
          <h3 className="flex-1 font-serif text-[14px] text-gold-soft">真人照片<span className="ml-1 font-sans text-[11px] text-mauve">{existing.length + photos.filter((p) => p.state !== "done").length}／12</span></h3>
          <button type="button" className="chip flex h-8 items-center gap-1 rounded-full px-3 text-[12.5px]" onClick={() => camera.current?.click()} data-testid="diary-camera"><IconCamera />拍攝</button>
          <button type="button" className="chip flex h-8 items-center gap-1 rounded-full px-3 text-[12.5px]" onClick={() => album.current?.click()} data-testid="diary-album"><IconImage />相簿</button>
          <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          <input ref={album} type="file" accept="image/*" multiple className="hidden" data-testid="diary-file" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        </div>
        {(existing.length > 0 || photos.length > 0) && <div className="grid grid-cols-3 gap-2">
          {existing.map((p, i) => (
            <div key={p.id} className="relative overflow-hidden rounded-xl" data-photo={p.id}>
              <img src={photoThumb(p.id)} alt="" className="aspect-[3/4] w-full object-cover" />
              {effCover === p.id && <span className="chip-on absolute left-1 top-1 rounded-full px-1.5 text-[10px]" data-testid="cover-badge">封面</span>}
              <div className="absolute inset-x-1 bottom-1 flex justify-between gap-0.5 text-[11px]">
                <button type="button" className="doll-tool rounded-full px-1.5" onClick={() => { dirty.current = true; setCover(p.id); setPendingCover(null); }} aria-label="設為封面">★</button>
                <button type="button" className="doll-tool rounded-full px-1.5" disabled={i === 0} onClick={() => moveExisting(i, -1)} aria-label="向前">‹</button>
                <button type="button" className="doll-tool rounded-full px-1.5" disabled={i === existing.length - 1} onClick={() => moveExisting(i, 1)} aria-label="向後">›</button>
                <button type="button" className="doll-tool rounded-full px-1.5" onClick={async () => { if (!entry || !confirm("刪除這張照片？")) return; try { await diaryApi.removePhoto(entry.id, p.id); setOrder(order.filter((x) => x !== p.id)); setEntry({ ...entry, photos: entry.photos.filter((x) => x.id !== p.id) }); if (cover === p.id) setCover(null); } catch (e) { toast((e as Error).message, "err"); } }} aria-label="刪除">✕</button>
              </div>
            </div>
          ))}
          {photos.map((p, i) => p.state === "done" ? null : (
            <div key={p.key} className="relative overflow-hidden rounded-xl" data-pending={p.state}>
              <img src={p.preview} alt="" className={`aspect-[3/4] w-full ${p.crop === "original" ? "object-contain" : "object-cover"} bg-cream/5`} style={{ transform: `rotate(${p.rotate}deg)` }} />
              {pendCover === p.key && <span className="chip-on absolute left-1 top-1 rounded-full px-1.5 text-[10px]">封面</span>}
              <span className="absolute inset-x-1 bottom-8 rounded-full bg-black/55 px-1.5 text-center text-[10px] text-white" data-status-color>{p.state === "uploading" ? `${Math.round(p.progress * 100)}%` : p.state === "failed" ? "上傳失敗" : "待上傳"}</span>
              {p.state === "failed" && p.error && <span className="absolute inset-x-1 top-7 line-clamp-2 rounded bg-black/55 px-1 text-[9.5px] text-white" data-status-color>{p.error}</span>}
              {p.state !== "uploading" && <>
                <button type="button" className="doll-tool absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full text-[11px]" onClick={() => { URL.revokeObjectURL(p.preview); setPhotos((ps) => ps.filter((x) => x.key !== p.key)); if (pendingCover === p.key) setPendingCover(null); }} aria-label="移除">✕</button>
                <div className="absolute inset-x-1 bottom-1 flex justify-between gap-0.5 text-[11px]">
                  <button type="button" className="doll-tool h-6 rounded-full px-1.5" onClick={() => { setPendingCover(p.key); setCover(null); }} aria-label="設為封面">★</button>
                  <button type="button" className="doll-tool h-6 rounded-full px-1.5" onClick={() => patchPhoto(p.key, { rotate: ((p.rotate + 90) % 360) as PendingPhoto["rotate"] })} aria-label="旋轉">⟳</button>
                  <button type="button" className="doll-tool h-6 rounded-full px-1.5" onClick={() => patchPhoto(p.key, { crop: p.crop === "original" ? "3:4" : p.crop === "3:4" ? "1:1" : "original" })} aria-label="裁切">{p.crop === "original" ? "原" : p.crop}</button>
                  <button type="button" className="doll-tool h-6 rounded-full px-1.5" disabled={i === 0} onClick={() => movePending(i, -1)} aria-label="向前">‹</button>
                </div>
              </>}
            </div>
          ))}
        </div>}
        <p className="text-[11px] text-mauve">照片壓縮至最長邊 2560px，並移除位置及相機資料；預設私人。{draftWarn ? "　⚠ 這部手機未能保存照片草稿，請在離開前保存。" : ""}</p>
        {waiting > 0 && entry && <div className="flex items-center gap-2 rounded-xl bg-cream/5 p-2 text-[12px]" role="status" data-testid="diary-photos-pending"><span className="flex-1">{failed ? `${photos.filter((p) => p.state === "failed").length} 張照片上傳失敗，日誌本身已保存。` : `${waiting} 張照片待上傳。`}</span><Button variant="ghost" data-testid="diary-retry" disabled={busy || !navigator.onLine} onClick={() => void retryPhotos()}>重試上傳</Button></div>}
      </section>

      {/* ③ 實際穿著衣物 */}
      <section className="card-flat space-y-2 p-3" data-testid="diary-items">
        <div className="flex items-center gap-1.5"><h3 className="flex-1 font-serif text-[14px] text-gold-soft">實際穿著衣物<span className="ml-1 font-sans text-[11px] text-mauve">{new Set(form.items.map((i) => i.garment_id)).size} 件</span></h3>
          <button type="button" className="chip h-8 rounded-full px-3 text-[12.5px]" onClick={() => setPicker("looks")} data-testid="diary-pick-look">使用已有穿搭</button>
          <button type="button" className="chip flex h-8 items-center gap-1 rounded-full px-3 text-[12.5px]" onClick={() => setPicker("garments")} data-testid="diary-pick-garments"><IconPlus />加入衣物</button></div>
        {form.items.length ? (
          <ul className="grid grid-cols-4 gap-2" data-testid="diary-item-list">
            {form.items.map((it) => (
              <li key={it.garment_id + it.part} className="relative text-center text-[10.5px]" data-item={it.garment_id}>
                <div className="arch-base aspect-[3/4] overflow-hidden rounded-xl">{it.thumb ? <img src={it.thumb} alt="" className="h-full w-full object-contain" /> : null}</div>
                <p className="line-clamp-2 leading-tight" title={it.name}>{it.name}</p>
                <button type="button" aria-label={`移除 ${it.name}`} className="doll-tool absolute right-0 top-0 grid h-6 w-6 place-items-center rounded-full text-[11px]" onClick={() => up({ items: form.items.filter((x) => x !== it) })}>✕</button>
              </li>
            ))}
          </ul>
        ) : <p className="text-[12px] text-mauve">可以只拍照、只選衣物，或兩者都有。</p>}
      </section>

      {/* ④ 其他資料（預設收合） */}
      <section className="card-flat p-3 text-[13px]" data-testid="diary-more">
        <button type="button" className="flex w-full items-center justify-between" aria-expanded={moreOpen || !!(form.occasion || form.location || form.tags || form.notes)} onClick={() => setMoreOpen(!moreOpen)} data-testid="diary-more-toggle">
          <span className="font-serif text-[14px] text-gold-soft">其他資料</span>
          <span className="text-[11.5px] text-mauve">{[form.occasion, form.location, form.tags && "標籤", form.notes && "備註", form.is_favorite && "♥"].filter(Boolean).join("・") || "場合、地點、標籤、備註、收藏"} {moreOpen ? "▲" : "▼"}</span>
        </button>
        <div className={`mt-2 space-y-2 ${moreOpen ? "" : "hidden"}`}>
          <div className="grid grid-cols-2 gap-2">
            <input value={form.occasion} onChange={(e) => up({ occasion: e.target.value })} placeholder="場合（例如上班）" className="field h-9 rounded-full px-3 text-[16px]" data-testid="diary-occasion" />
            <input value={form.weather} onChange={(e) => up({ weather: e.target.value })} placeholder="天氣（選填）" className="field h-9 rounded-full px-3 text-[16px]" />
          </div>
          <input value={form.location} onChange={(e) => up({ location: e.target.value })} placeholder="地點（選填；不會讀取定位）" className="field h-9 w-full rounded-full px-3 text-[16px]" />
          <input value={form.tags} onChange={(e) => up({ tags: e.target.value })} placeholder="#標籤 #茶會" className="field h-9 w-full rounded-full px-3 text-[16px]" data-testid="diary-tags" />
          <textarea value={form.notes} onChange={(e) => up({ notes: e.target.value })} rows={3} placeholder="備註" className="field w-full rounded-2xl px-3 py-2 text-[16px]" />
          <label className="flex items-center justify-between">收藏<button type="button" role="switch" aria-checked={form.is_favorite} onClick={() => up({ is_favorite: !form.is_favorite })} className="switch" /></label>
        </div>
      </section>

      {/* ⑤ 保存欄：固定在底部選單之上（鍵盤開啟時移到鍵盤之上）；下方預留空間，最後一項內容不會被遮住 */}
      <div className="action-bar -mx-4 flex gap-2 px-4 py-2" data-testid="diary-action-bar">
        <Button variant="ghost" disabled={busy} onClick={async () => { if (confirm(waiting ? "放棄未保存的修改？未上傳的照片亦會從這部手機刪除。" : "放棄未保存的修改？")) { await dropDraft(draftKey); if (entry) await dropDraft(entry.id); navigate("/diary"); } }} data-testid="diary-cancel">取消</Button>
        <Button className="flex-1" disabled={busy || !form.worn_date} onClick={() => void save()} data-testid="diary-save">{busy ? "保存中…" : state === "photos_pending" ? "保存並重試上傳" : "保存"}</Button>
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
        {!data ? <Spinner /> : list.length ? <ul className="max-h-[50dvh] space-y-1 overflow-y-auto">{list.map((x) => { const th = tab === "outfit" ? (x as { thumb_url?: string | null }).thumb_url : (x as { thumb_at?: string | null }).thumb_at ? `/api/doll/looks/${x.id}/thumb?v=${encodeURIComponent((x as { thumb_at?: string }).thumb_at!)}` : null; return <li key={x.id}><button type="button" data-pick-look={x.id} onClick={() => onPick(tab, x.id, x.name)} className="chip flex w-full items-center gap-2 rounded-2xl px-2 py-1.5 text-left text-[13px]"><span className="checker block h-12 w-9 shrink-0 overflow-hidden rounded-lg">{th && <img src={th} alt="" className="h-full w-full object-contain" loading="lazy" />}</span><span className="min-w-0 flex-1 truncate">{x.is_favorite ? "♥ " : ""}{x.name}</span></button></li>; })}</ul> : <p className="py-4 text-center text-[12.5px] text-mauve">沒有已保存的{tab === "outfit" ? "衣服配搭" : "角色造型"}</p>}
        <p className="text-[11px] text-mauve">只會帶入衣物清單，不會修改原本的造型。</p>
      </div>
    </Sheet>
  );
}
