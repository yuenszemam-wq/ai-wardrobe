import { dropCachedGarment, patchCachedGarment } from "../wardrobeList";
import { WardrobeImage } from "../components/WardrobeImage";
import { AttributeChoices, BrandInput } from "../components/GarmentChoices";
import { SplitSheet } from "../components/SplitSheet";
import { CutoutSheet } from "../components/CutoutSheet";
import { cutoutSource } from "../cutoutFlow";
import { useEffect, useState } from "react";
import { attributesFor, attributeValues, isColumnAttribute, Taxonomy } from "../../shared/taxonomy";
import { AI_STATUS_LABEL, api, displayName, formatBytes, formatDate, Garment, GarmentImage, imageUrl, STATUS_LABEL, uploadImage } from "../api";
import { IconChevronLeft, IconClose, IconHeart, IconMerge, IconPencil } from "../components/icons";
import { AiHandoffButton, Button, Field, inputCls, Link, money, PickChips, ProgressBar, Sheet, Spinner, toast } from "../components/ui";
import { fillQueue } from "../fillQueue";
import { useTaxonomy } from "../taxonomy";
import { makeThumbnail, prepareForUpload } from "../imageProcessing";
import { navigate } from "../router";

const FIELD_LABEL: Record<string, string> = {
  name: "名稱",
  category: "主類別",
  subcategory: "子類",
  brand: "品牌",
  style: "風格",
  primary_color: "主色",
  secondary_colors: "其他顏色",
  pattern: "圖案描述",
  season: "季節",
  attributes: "屬性",
  price: "價錢",
  notes: "備註",
};

export default function GarmentDetail({ id }: { id: string }) {
  const [g, setG] = useState<Garment | null>(null);
  const [err, setErr] = useState("");
  const [viewId, setViewId] = useState<string | null>(null);
  // 上傳後直接進入填寫資料（/g/:id?edit=1）
  const [editing, setEditing] = useState(() => new URLSearchParams(location.search).get("edit") === "1");
  const [merging, setMerging] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [checker, setChecker] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  // 手動去背：由上傳完成頁進入（?cutout=1）時自動打開
  const [cutout, setCutout] = useState(() => new URLSearchParams(location.search).get("cutout") === "1");
  const tax = useTaxonomy();

  async function load() {
    try {
      const data = await api<Garment>(`/api/garments/${id}`);
      setG(data);
      return data;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  }

  useEffect(() => {
    setG(null);
    setViewId(null);
    setEditing(new URLSearchParams(location.search).get("edit") === "1");
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (err) return <p className="py-10 text-center text-wine">{err}</p>;
  if (!g) return <Spinner />;

  // HEIC 原檔已保存，但以 JPEG 預覽顯示（大部分瀏覽器不能直接顯示 HEIC）
  const heicOriginal = (g.images || []).find((i) => /heic|heif/.test(i.mime_type));
  const fullImages = (g.images || []).filter((i) => i.image_type !== "thumbnail" && !/heic|heif/.test(i.mime_type));
  const shown = fullImages.find((i) => i.id === viewId) || fullImages.find((i) => i.is_primary) || fullImages[0];

  async function patch(body: Record<string, unknown>, msg = "已儲存") {
    try {
      const updated = await api<Garment>(`/api/garments/${id}`, { method: "PATCH", json: body });
      setG(updated);
      patchCachedGarment(updated);
      toast(msg);
    } catch (e) {
      toast((e as Error).message, "err");
    }
  }

  async function addImage(file: File, type: "processed" | "original") {
    setUploadPct(0);
    try {
      const prepared = await prepareForUpload(file);
      const res = await uploadImage("/api/images/upload", { garment_id: id, image_type: type }, prepared.blob, prepared.filename, setUploadPct);
      try {
        const thumb = await makeThumbnail(prepared.blob);
        await uploadImage("/api/images/upload", { garment_id: id, image_type: "thumbnail", derived_from: res.id }, thumb, "thumb.webp");
      } catch { /* Original is saved; durable thumbnail job will retry later. */ }
      if (res.warnings?.length) toast(res.warnings[0], "err");
      else toast(res.deduplicated ? "這張圖片已經存在" : "已加入圖片");
      await load();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setUploadPct(null);
    }
  }

  const queue = fillQueue.position(id);
  const pending = g.ai_status && g.ai_status !== "done";

  function nextInQueue() {
    const next = fillQueue.next(id);
    if (next) navigate(`/g/${next}?edit=1`, true);
    else {
      fillQueue.clear();
      navigate("/?tab=todo#todo", true);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2 pt-4">
        <button type="button" onClick={() => (queue ? (fillQueue.clear(), navigate("/wardrobe", true)) : history.back())} className="btn-dark flex items-center gap-1 rounded-full py-1.5 pl-2 pr-3.5 text-[13px]">
          <IconChevronLeft className="text-[15px]" />
          {queue ? "結束填寫" : "返回"}
        </button>
        {queue && (
          <span className="text-[13px] text-mauve">
            填寫資料 {queue.index + 1}／{queue.total}
          </span>
        )}
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className="btn-jewel flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[14px]">
            <IconPencil className="text-[14px]" />
            編輯資料
          </button>
        )}
      </div>

      <div className="mt-4 lg:grid lg:grid-cols-2 lg:gap-8">
        <div>
          <div className={`relative mx-auto ${editing ? "max-w-[13rem]" : "max-w-sm"} lg:max-w-none`}>
            <div data-testid="detail-image" className={`relative aspect-[3/4] overflow-hidden ${checker ? "checker rounded-2xl" : "arch"}`}>
              {shown ? (
                <WardrobeImage
                  src={shown.url}
                  quality="high"
                  alt={displayName(g)}
                  className={`absolute inset-0 h-full w-full object-contain ${checker ? "p-2" : "px-[7%] pb-[6%] pt-[17%]"}`}
                  decoding="async"
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center text-mauve">未有圖片</div>
              )}
            </div>
            {/* 刪除目前顯示的這張圖：右上角的小交叉 */}
            {shown && (
              <button
                type="button"
                aria-label="刪除此圖"
                className="btn-dark absolute right-0 top-0 grid h-8 w-8 place-items-center rounded-full text-[14px]"
                onClick={async () => {
                  if (!confirm("確定刪除這張圖片？R2 中的檔案亦會刪除。")) return;
                  await api(`/api/images/${shown.id}`, { method: "DELETE" });
                  setViewId(null);
                  toast("已刪除圖片");
                  load();
                }}
              >
                <IconClose />
              </button>
            )}
          </div>
          {shown && !editing && (
            <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-mauve">
              <span>
                {shown.image_type === "processed" ? "去背圖" : shown.variant === "preview" ? "HEIC 原檔預覽" : "原始照片"}｜{shown.width}×{shown.height}｜{formatBytes(shown.file_size)}
                {shown.has_alpha ? "｜透明" : ""}
                {heicOriginal ? `｜HEIC 原檔 ${formatBytes(heicOriginal.file_size)} 已保存` : ""}
                {!(g.images || []).some((i) => i.image_type === "processed") ? "｜未有去背圖" : ""}
              </span>
              <button type="button" className="shrink-0 text-amethyst-deep" onClick={() => setChecker((v) => !v)}>
                {checker ? "一般背景" : "檢查透明"}
              </button>
            </div>
          )}
          {fullImages.length > 1 && (
            <div className="scrollbar-none mt-3 flex justify-center gap-2 overflow-x-auto">
              {fullImages.map((im) => (
                <button
                  key={im.id}
                  type="button"
                  onClick={() => setViewId(im.id)}
                  className={`relative h-20 w-16 shrink-0 overflow-hidden rounded-xl bg-rose-soft ${shown?.id === im.id ? "ring-2 ring-[#f2a7c3]" : "ring-1 ring-gold/50"}`}
                >
                  <WardrobeImage src={thumbFor(g, im)} alt="" loading="lazy" className="h-full w-full object-contain" />
                  <span className="absolute inset-x-0 bottom-0 bg-ink/80 text-center text-[10px] text-rose">{im.is_primary ? "主圖" : im.image_type === "processed" ? "去背圖" : "原相"}</span>
                </button>
              ))}
            </div>
          )}
          {uploadPct !== null && (
            <div className="mt-3">
              <ProgressBar value={uploadPct} />
            </div>
          )}
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {shown && shown.image_type !== "processed" && !shown.has_alpha && <button type="button" data-testid="cutout-start" onClick={() => setCutout(true)} className="btn-jewel min-h-9 rounded-full px-4 text-[13px]">去背</button>}
            <FileButton label="＋ 去背圖" onFile={(f) => addImage(f, "processed")} disabled={uploadPct !== null} />
            <FileButton label="＋ 原相" onFile={(f) => addImage(f, "original")} disabled={uploadPct !== null} />
            <button type="button" onClick={() => setMerging(true)} className="chip inline-flex min-h-9 items-center gap-1 rounded-full px-3.5 text-[13px]">
              <IconMerge className="text-[14px]" />
              合併同一件
            </button>
            <button type="button" onClick={() => setSplitting(true)} className="chip min-h-9 rounded-full px-3.5 text-[13px]">拆開圖片</button>
            {shown && !shown.is_primary && (
              <button
                type="button"
                className="chip-on inline-flex min-h-9 items-center rounded-full px-3.5 text-[13px]"
                onClick={async () => {
                  await api(`/api/images/${shown.id}/primary`, { method: "POST" });
                  toast("已設為主圖");
                  load();
                }}
              >
                設為主圖
              </button>
            )}
          </div>
        </div>

        <div className="mt-6 lg:mt-0">
          <div className="flex items-start justify-between gap-3">
            <h1 className="font-serif text-[24px] font-bold leading-snug text-gold-soft">{displayName(g)}</h1>
            <button
              type="button"
              aria-label={g.is_favorite ? "取消收藏" : "收藏"}
              onClick={() => patch({ is_favorite: !g.is_favorite }, g.is_favorite ? "已取消收藏" : "已收藏")}
              className={`text-[26px] leading-none ${g.is_favorite ? "text-[#f2a7c3]" : "text-mauve/60"}`}
            >
              <IconHeart filled={g.is_favorite} />
            </button>
          </div>
          <p className="mt-1 text-[13px] text-mauve">
            {STATUS_LABEL[g.status]}
            {pending ? `｜${AI_STATUS_LABEL[g.ai_status!]}` : ""}｜{formatDate(g.created_at)} 加入{g.source ? `｜來源：${g.source}` : ""}
          </p>
          {g.ai_status === "pending_review" && (
            <Link to="/?tab=pending_review" className="frame mt-3 block px-4 py-3 text-[14px]">
              AI 已提交整理建議，按此到主頁「待整理」對比及確認 →
            </Link>
          )}

          {/* 未整理的衣物：自己填，或把指令交給 AI */}
          {pending && g.ai_status !== "pending_review" && (
            <div className="frame pat-dots mt-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <p className="min-w-0 flex-1 text-[13px] text-mauve">不想逐項填？複製指令，貼到已連接電子衣櫃的 Claude／ChatGPT，AI 會查看圖片後提交建議。</p>
              <AiHandoffButton />
            </div>
          )}

          {g.status === "review" && !editing && (
            <div className="paper mt-4 p-4 text-sm">
              <p className="font-medium">此衣物待你確認</p>
              {g.uncertain_fields.length > 0 && (
                <p className="mt-1 text-mauve">AI 未能確定：{g.uncertain_fields.map((f) => FIELD_LABEL[f] || f).join("、")}</p>
              )}
              {g.ai_note && <p className="mt-1 text-mauve">{g.ai_note}</p>}
              <div className="mt-3 flex gap-2">
                <Button onClick={() => patch({ confirm: true }, "已確認入庫")}>確認入庫</Button>
              </div>
            </div>
          )}

          {editing ? (
            <EditForm
              g={g}
              tax={tax}
              saveLabel={pending ? (queue && queue.index + 1 < queue.total ? "入庫，下一件" : "儲存並入庫") : "儲存"}
              onSkip={queue ? nextInQueue : undefined}
              onCancel={() => setEditing(false)}
              onSave={async (body) => {
                // 待整理的衣物：儲存即確認入庫
                await patch(pending ? { ...body, confirm: true } : body, pending ? "已儲存並入庫" : "已儲存");
                if (queue) nextInQueue();
                else setEditing(false);
              }}
              // 只儲存已填的部分，保持「待 AI 辨認」：已填的欄位會鎖定，AI 不會覆寫
              onSaveDraft={
                pending
                  ? async (body) => {
                      await patch(body, "已儲存，其餘可交給 AI 填寫");
                      if (queue) nextInQueue();
                      else setEditing(false);
                    }
                  : undefined
              }
            />
          ) : (
            <>
              {/* 沒有填寫的欄位不顯示 */}
              <dl className="mt-5 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2.5 text-[15px]">
                <Row k="主分類" v={g.category} uncertain={g.uncertain_fields.includes("category")} />
                <Row k="子分類" v={g.subcategory} />
                <Row k="名稱原文" v={String(g.attributes?.original_name || "")} />
                <Row k="品牌" v={g.brand} uncertain={g.uncertain_fields.includes("brand")} />
                <Row k="價錢" v={g.price != null ? `HK${money(g.price)}` : null} />
                {shownAttributes(tax, g).map((a) => (
                  <Row key={a.id} k={a.name} v={attributeValues(g, a.id).join("、")} uncertain={isColumnAttribute(a.id) && g.uncertain_fields.includes(a.id)} />
                ))}
                <Row k="圖案描述" v={g.pattern} />
                <Row k="備註" v={g.notes} />
                {typeof g.attributes?.source_url === "string" && /^https?:\/\//i.test(g.attributes.source_url) && <><dt className="text-mauve">連結</dt><dd className="min-w-0 break-all"><a href={g.attributes.source_url} target="_blank" rel="noopener noreferrer" className="text-gold-soft underline">{g.attributes.source_url}</a></dd></>}
              </dl>
              {!hasAnyDetail(tax, g) && <p className="mt-5 text-[14px] text-mauve">仍未填寫資料。按上方「編輯資料」開始填寫。</p>}
              {g.locked_fields && g.locked_fields.length > 0 && (
                <p className="mt-4 text-[12px] text-mauve">已人工修正（AI 不會覆寫）：{g.locked_fields.map((f) => FIELD_LABEL[f] || f).join("、")}</p>
              )}
              {g.outfits && g.outfits.length > 0 && (
                <div className="mt-4 text-sm">
                  <span className="text-mauve">出現在穿搭：</span>
                  {g.outfits.map((o) => (
                    <Link key={o.id} to={`/outfits/${o.id}`} className="mr-2 text-amethyst-deep underline underline-offset-4">
                      {o.name}
                    </Link>
                  ))}
                </div>
              )}
              <div className="mt-7 flex flex-wrap gap-2 border-t border-gold/25 pt-4">
                {g.status !== "archived" ? (
                  <Button variant="ghost" onClick={() => patch({ status: "archived" }, "已封存")}>
                    封存
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => patch({ status: "active" }, "已還原")}>
                    還原
                  </Button>
                )}
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (!confirm(`確定永久刪除「${displayName(g)}」及其所有圖片？此動作無法復原。`)) return;
                    await api(`/api/garments/${id}`, { method: "DELETE" });
                    dropCachedGarment(id);
                    toast("已刪除");
                    navigate("/wardrobe", true);
                  }}
                >
                  永久刪除
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {cutout && g && (() => { const src = cutoutSource(g, shown?.image_type === "original" ? shown : null); return src ? <CutoutSheet g={g} image={src} onClose={() => setCutout(false)} onSaved={() => { void load(); }} /> : null; })()}
      {splitting && <SplitSheet id={id} onClose={() => setSplitting(false)} onSplit={(r) => { setSplitting(false); setG(r.source); setViewId(null); }} />}
      {merging && (
        <MergeSheet
          g={g}
          onClose={() => setMerging(false)}
          onMerged={async () => {
            setMerging(false);
            setViewId(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

/** 揀選另一件衣物（同一件衣服的原相或透明圖），把它的圖片併入目前這一件 */
function MergeSheet({ g, onClose, onMerged }: { g: Garment; onClose: () => void; onMerged: () => Promise<void> }) {
  const [list, setList] = useState<Garment[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // 最近上傳的排最前：同一批上傳的另一張相通常就在頭幾件
    api<{ garments: Garment[] }>("/api/garments?limit=200&status=all&sort=updated").then((r) => setList(r.garments.filter((x) => x.id !== g.id)));
  }, [g.id]);
  const kw = q.trim().toLowerCase();
  const shown = (list ?? []).filter((x) => !kw || `${displayName(x)} ${x.brand ?? ""} ${x.subcategory ?? ""}`.toLowerCase().includes(kw));

  async function merge(other: Garment) {
    if (busy) return;
    if (!confirm(`把「${displayName(other)}」的圖片併入「${displayName(g)}」？\n「${displayName(other)}」這個項目會被移除，圖片及已填資料會保留在這一件。`)) return;
    setBusy(true);
    try {
      await api(`/api/garments/${g.id}/merge`, { method: "POST", json: { source_id: other.id } });
      fillQueue.remove(other.id);
      toast("已合併，透明圖會作主圖");
      await onMerged();
    } catch (e) {
      toast((e as Error).message, "err");
      setBusy(false);
    }
  }

  return (
    <Sheet title="合併同一件衣服" onClose={onClose}>
      <p className="text-[13px] text-mauve">同一件衣服分別上傳了透明圖和原相？揀選另一件，它的圖片會搬到這一件，並以透明圖作主圖。</p>
      <input type="search" className={`${inputCls} mt-3 rounded-full py-2`} placeholder="搜尋名稱、品牌…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜尋衣物" />
      {!list ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-[13px] text-mauve">沒有其他衣物</p>
      ) : (
        <ul className="mt-3 grid grid-cols-3 gap-x-3 gap-y-3">
          {shown.slice(0, 60).map((x) => (
            <li key={x.id}>
              <button type="button" disabled={busy} onClick={() => merge(x)} className="block w-full text-center disabled:opacity-50">
                <span className="arch relative block aspect-[3/4] overflow-hidden">
                  {(x.primary_image_id || x.thumb_image_id) && <WardrobeImage src={imageUrl(x.primary_image_id || x.thumb_image_id)} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-contain px-[9%] pb-[8%] pt-[20%]" />}
                </span>
                <span className="mt-1 block truncate text-[11px]">{displayName(x)}</span>
                <span className="block text-[10px] text-mauve">{x.has_processed ? "有透明圖" : "只有原相"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

function hasAnyDetail(tax: Taxonomy, g: Garment) {
  return Boolean(g.category || g.subcategory || g.brand || g.price != null || g.pattern || g.notes || tax.attributes.some((a) => attributeValues(g, a.id).length));
}

function thumbFor(g: Garment, im: GarmentImage) {
  const t = g.images?.find((x) => x.image_type === "thumbnail" && x.derived_from === im.id);
  return im.url;
}

/** 顯示：只列出已有值的屬性（未填的欄位在預覽時隱藏） */
function shownAttributes(tax: Taxonomy, g: Garment) {
  return tax.attributes.filter((a) => attributeValues(g, a.id).length > 0);
}

function Row({ k, v, uncertain }: { k: string; v: string | null | undefined; uncertain?: boolean }) {
  if (!v && !uncertain) return null;
  return (
    <>
      <dt className="text-mauve">{k}</dt>
      <dd className={`whitespace-pre-line ${uncertain && !v ? "text-wine" : ""}`}>{v || "AI 未能確定"}</dd>
    </>
  );
}

function FileButton({ label, onFile, disabled }: { label: string; onFile: (f: File) => void; disabled?: boolean }) {
  return (
    <label className={`chip inline-flex min-h-9 cursor-pointer items-center rounded-full px-3.5 text-[13px] ${disabled ? "pointer-events-none opacity-40" : ""}`}>
      {label}
      <input
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}

type AttrState = Record<string, string[]>;

function initialAttrs(tax: Taxonomy, g: Garment): AttrState {
  const out: AttrState = {};
  for (const a of tax.attributes) {
    const v = attributeValues(g, a.id);
    if (v.length) out[a.id] = v;
  }
  // 字典已刪除的屬性也保留，避免儲存時被清走
  for (const [k, v] of Object.entries(g.attributes ?? {})) if (!out[k]) out[k] = Array.isArray(v) ? v.map(String) : [String(v)];
  return out;
}

function EditForm({
  g,
  tax,
  onSave,
  onCancel,
  onSkip,
  onSaveDraft,
  saveLabel = "儲存",
}: {
  g: Garment;
  tax: Taxonomy;
  onSave: (b: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
  onSkip?: () => void;
  onSaveDraft?: (b: Record<string, unknown>) => Promise<void>;
  saveLabel?: string;
}) {
  const [price, setPrice] = useState(g.price != null ? String(g.price) : "");
  const [f, setF] = useState({
    name: g.name_is_placeholder ? "" : g.name,
    category: g.category || "",
    subcategory: g.subcategory || "",
    brand: g.brand || "",
    original_name: String(g.attributes?.original_name || ""),
    source_url: String(g.attributes?.source_url || ""),
    pattern: g.pattern || "",
    notes: g.notes || "",
  });
  const [attrs, setAttrs] = useState<AttrState>(() => initialAttrs(tax, g));
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const cat = tax.categories.find((c) => c.name === f.category);
  const subs = cat?.subs.map((s) => s.name) ?? [];
  const visible = attributesFor(tax, f.category);

  function buildBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const initial = { name: g.name_is_placeholder ? "" : g.name, category: g.category || "", subcategory: g.subcategory || "", brand: g.brand || "", original_name: String(g.attributes?.original_name || ""), source_url: String(g.attributes?.source_url || ""), pattern: g.pattern || "", notes: g.notes || "" };
    for (const [k, v] of Object.entries(f)) if (!["original_name", "source_url"].includes(k) && v !== initial[k as keyof typeof initial] && !(k === "name" && !v.trim())) body[k] = v;
    if (price.trim() !== (g.price != null ? String(g.price) : "")) body.price = price.trim();
    // 只送出有改動的欄位：被改動的欄位會被鎖定，AI 之後不會覆寫
    const before = initialAttrs(tax, g);
    const same = (a: string[] = [], b: string[] = []) => a.join("|") === b.join("|");
    const visibleIds = new Set(visible.map((a) => a.id));
    for (const col of ["style", "primary_color", "secondary_colors", "season"] as const) {
      const now = visibleIds.has(col) ? attrs[col] ?? [] : [];
      if (!same(now, before[col])) body[col] = now;
    }
    // 屬性：不相關（已隱藏）的屬性不保留
    const nextObj: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (isColumnAttribute(k) || !v.length) continue;
      const def = tax.attributes.find((a) => a.id === k);
      if (def && !visibleIds.has(k)) continue;
      nextObj[k] = def && !def.multi ? v[0] : v;
    }
    delete nextObj.original_name;
    delete nextObj.source_url;
    if (f.original_name.trim()) nextObj.original_name = f.original_name.trim();
    if (f.source_url.trim()) nextObj.source_url = f.source_url.trim();
    const prevObj = JSON.stringify(Object.fromEntries(Object.entries(g.attributes ?? {}).sort()));
    if (JSON.stringify(Object.fromEntries(Object.entries(nextObj).sort())) !== prevObj) body.attributes = nextObj;
    return body;
  }

  return (
    <form
      className="mt-5 space-y-4 pb-24"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSave(buildBody());
        setBusy(false);
      }}
    >
      <Field label="名稱">
        <input className={inputCls} value={f.name} onChange={set("name")} required={!g.name_is_placeholder} placeholder={g.name_is_placeholder ? `${displayName(g)}（可稍後再改）` : undefined} />
      </Field>
      <Field label="名稱原文"><input className={inputCls} maxLength={300} value={f.original_name} onChange={set("original_name")} placeholder="日文／英文原名" /></Field>
      <div>
        <p className="mb-1.5 text-[13px] text-mauve">主分類</p>
        <PickChips
          options={tax.categories.map((c) => c.name)}
          value={f.category ? [f.category] : []}
          extra
          onChange={(v) => setF((cur) => ({ ...cur, category: v[0] ?? "", subcategory: "" }))}
        />
      </div>
      {(subs.length > 0 || f.subcategory) && (
        <div>
          <p className="mb-1.5 text-[13px] text-mauve">子分類</p>
          <PickChips options={subs} value={f.subcategory ? [f.subcategory] : []} extra onChange={(v) => setF((cur) => ({ ...cur, subcategory: v[0] ?? "" }))} />
        </div>
      )}
      <div className="grid grid-cols-[1fr_8.5rem] gap-3">
        <Field label="品牌">
          <BrandInput value={f.brand} onChange={brand=>setF(cur=>({...cur,brand}))} />
        </Field>
        <Field label="價錢（HK$）">
          <input className={inputCls} inputMode="decimal" placeholder="例如 1280" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.,]/g, ""))} />
        </Field>
      </div>
      {visible.map((a) => (
        <div key={a.id}>
          <p className="mb-1.5 text-[13px] text-mauve">
            {a.name}
            {a.multi ? <span className="ml-1 text-[11px]">（多選{a.max_select ? `，最多 ${a.max_select} 個` : ""}）</span> : null}
          </p>
          <AttributeChoices id={a.id}
            options={a.options.map((o) => o.name)}
            value={attrs[a.id] ?? []}
            multi={a.multi}
            max={a.max_select}
            extra
            onChange={(v) => setAttrs((cur) => ({ ...cur, [a.id]: v }))}
          />
        </div>
      ))}
      <Field label="圖案描述（例如系列名、印花主題）">
        <input className={inputCls} value={f.pattern} onChange={set("pattern")} />
      </Field>
      <Field label="備註">
        <textarea className={`${inputCls} min-h-24`} value={f.notes} onChange={set("notes")} />
      </Field>
      <Field label="連結"><input type="url" className={inputCls} maxLength={2048} value={f.source_url} onChange={set("source_url")} placeholder="https://…" /></Field>
      <div className="detail-actions z-30 flex flex-wrap items-center gap-2 border-t border-gold/30 bg-ink/95 px-4 py-2 backdrop-blur">
        <Button type="submit" disabled={busy}>
          {busy ? "儲存中…" : saveLabel}
        </Button>
        {onSaveDraft && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSaveDraft(buildBody());
              setBusy(false);
            }}
          >
            只儲存
          </Button>
        )}
        <button type="button" onClick={onSkip ?? onCancel} className="ml-auto px-2 text-[14px] text-mauve underline underline-offset-4">
          {onSkip ? "略過" : "取消"}
        </button>
      </div>
    </form>
  );
}
