import { useEffect, useState } from "react";
import { attributesFor, attributeValues, isColumnAttribute, Taxonomy } from "../../shared/taxonomy";
import { AI_STATUS_LABEL, api, displayName, formatBytes, formatDate, Garment, GarmentImage, STATUS_LABEL, uploadImage } from "../api";
import { Button, Field, inputCls, Link, PickChips, ProgressBar, Spinner, toast } from "../components/ui";
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
};

export default function GarmentDetail({ id }: { id: string }) {
  const [g, setG] = useState<Garment | null>(null);
  const [err, setErr] = useState("");
  const [viewId, setViewId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [checker, setChecker] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
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
    load().then((data) => data && backfillThumbnail(data).then((did) => did && load()));
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
      const thumb = await makeThumbnail(prepared.blob);
      await uploadImage("/api/images/upload", { garment_id: id, image_type: "thumbnail", derived_from: res.id }, thumb, "thumb.webp");
      if (res.warnings?.length) toast(res.warnings[0], "err");
      else toast(res.deduplicated ? "這張圖片已經存在" : "已加入圖片");
      await load();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setUploadPct(null);
    }
  }

  return (
    <div>
      <div className="pt-4">
        <button type="button" onClick={() => history.back()} className="text-[14px] text-amethyst-deep">
          ‹ 返回
        </button>
      </div>

      <div className="mt-3 lg:grid lg:grid-cols-2 lg:gap-8">
        <div>
          <div className={`relative aspect-[3/4] overflow-hidden ${checker ? "checker rounded-2xl" : "arch"}`}>
            {shown ? (
              <img
                src={shown.url}
                alt={displayName(g)}
                className={`absolute inset-0 h-full w-full object-contain ${checker ? "p-2" : "p-[6%] pt-[12%]"}`}
                decoding="async"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-mauve">未有圖片</div>
            )}
          </div>
          {shown && (
            <div className="mt-2 flex items-center justify-between text-[12px] text-mauve">
              <span>
                {shown.image_type === "processed" ? "去背圖" : shown.variant === "preview" ? "HEIC 原檔預覽" : "原始照片"}｜{shown.width}×{shown.height}｜{formatBytes(shown.file_size)}
                {shown.has_alpha ? "｜透明" : ""}
                {heicOriginal ? `｜HEIC 原檔 ${formatBytes(heicOriginal.file_size)} 已保存` : ""}
                {!(g.images || []).some((i) => i.image_type === "processed") ? "｜等待去背" : ""}
              </span>
              <button type="button" className="text-amethyst-deep" onClick={() => setChecker((v) => !v)}>
                {checker ? "一般背景" : "檢查透明"}
              </button>
            </div>
          )}
          {fullImages.length > 1 && (
            <div className="scrollbar-none mt-3 flex gap-2 overflow-x-auto">
              {fullImages.map((im) => (
                <button
                  key={im.id}
                  type="button"
                  onClick={() => setViewId(im.id)}
                  className={`relative h-20 w-16 shrink-0 overflow-hidden rounded-xl bg-rose-soft ${shown?.id === im.id ? "ring-2 ring-amethyst" : ""}`}
                >
                  <img src={thumbFor(g, im)} alt="" loading="lazy" className="h-full w-full object-contain" />
                  {im.is_primary && <span className="absolute inset-x-0 bottom-0 bg-ink/80 text-center text-[10px] text-rose">主圖</span>}
                </button>
              ))}
            </div>
          )}
          {uploadPct !== null && (
            <div className="mt-3">
              <ProgressBar value={uploadPct} />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <FileButton label="加入去背圖" onFile={(f) => addImage(f, "processed")} disabled={uploadPct !== null} />
            <FileButton label="加入原相" onFile={(f) => addImage(f, "original")} disabled={uploadPct !== null} variant="ghost" />
            {shown && !shown.is_primary && (
              <Button
                variant="ghost"
                onClick={async () => {
                  await api(`/api/images/${shown.id}/primary`, { method: "POST" });
                  toast("已設為主圖");
                  load();
                }}
              >
                設為主圖
              </Button>
            )}
            {shown && (
              <Button
                variant="danger"
                onClick={async () => {
                  if (!confirm("確定刪除這張圖片？R2 中的檔案亦會刪除。")) return;
                  await api(`/api/images/${shown.id}`, { method: "DELETE" });
                  setViewId(null);
                  toast("已刪除圖片");
                  load();
                }}
              >
                刪除此圖
              </Button>
            )}
          </div>
        </div>

        <div className="mt-6 lg:mt-0">
          <div className="flex items-start justify-between gap-3">
            <h1 className="font-serif text-[24px] font-bold leading-snug">{displayName(g)}</h1>
            <button
              type="button"
              aria-label={g.is_favorite ? "取消收藏" : "收藏"}
              onClick={() => patch({ is_favorite: !g.is_favorite }, g.is_favorite ? "已取消收藏" : "已收藏")}
              className={`text-[26px] leading-none ${g.is_favorite ? "text-amethyst" : "text-mauve/50"}`}
            >
              ♥
            </button>
          </div>
          <p className="mt-1 text-[13px] text-mauve">
            {STATUS_LABEL[g.status]}
            {g.ai_status && g.ai_status !== "done" ? `｜${AI_STATUS_LABEL[g.ai_status]}` : ""}｜{formatDate(g.created_at)} 加入{g.source ? `｜來源：${g.source}` : ""}
          </p>
          {g.ai_status === "pending_review" && (
            <Link to="/?tab=pending_review" className="mt-3 block rounded-2xl bg-ink px-4 py-3 text-[14px] text-rose">
              AI 已提交整理建議，按此到主頁「待整理」對比及確認 →
            </Link>
          )}
          {g.locked_fields && g.locked_fields.length > 0 && (
            <p className="mt-1 text-[12px] text-mauve">已人工修正（AI 不會覆寫）：{g.locked_fields.map((f) => FIELD_LABEL[f] || f).join("、")}</p>
          )}

          {g.status === "review" && (
            <div className="mt-4 rounded-2xl bg-rose-soft p-4 text-sm">
              <p className="font-medium">此衣物待你確認</p>
              {g.uncertain_fields.length > 0 && (
                <p className="mt-1 text-mauve">AI 未能確定：{g.uncertain_fields.map((f) => FIELD_LABEL[f] || f).join("、")}</p>
              )}
              {g.ai_note && <p className="mt-1 text-mauve">{g.ai_note}</p>}
              <div className="mt-3 flex gap-2">
                <Button onClick={() => patch({ confirm: true }, "已確認入庫")}>確認入庫</Button>
                <Button variant="ghost" onClick={() => setEditing(true)}>
                  修改分類
                </Button>
              </div>
            </div>
          )}

          {editing ? (
            <EditForm
              g={g}
              tax={tax}
              onCancel={() => setEditing(false)}
              onSave={async (body) => {
                await patch(body);
                setEditing(false);
              }}
            />
          ) : (
            <>
              <dl className="mt-5 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2.5 text-[15px]">
                <Row k="主分類" v={g.category} uncertain={g.uncertain_fields.includes("category")} />
                <Row k="子分類" v={g.subcategory} />
                <Row k="品牌" v={g.brand} uncertain={g.uncertain_fields.includes("brand")} />
                {shownAttributes(tax, g).map((a) => (
                  <Row key={a.id} k={a.name} v={attributeValues(g, a.id).join("、")} uncertain={isColumnAttribute(a.id) && g.uncertain_fields.includes(a.id)} />
                ))}
                {g.pattern && <Row k="圖案描述" v={g.pattern} />}
                {g.notes && <Row k="備註" v={g.notes} />}
              </dl>
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
              <div className="mt-6 flex flex-wrap gap-2">
                <Button onClick={() => setEditing(true)}>編輯資料</Button>
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
                    if (!confirm(`確定永久刪除「${g.name}」及其所有圖片？此動作無法復原。`)) return;
                    await api(`/api/garments/${id}`, { method: "DELETE" });
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
    </div>
  );
}

function thumbFor(g: Garment, im: GarmentImage) {
  const t = g.images?.find((x) => x.image_type === "thumbnail" && x.derived_from === im.id);
  return t ? t.url : im.url;
}

/** 主圖若未有縮圖，在瀏覽器產生並上傳（不需要付費的圖片處理服務） */
async function backfillThumbnail(g: Garment): Promise<boolean> {
  const primary = g.images?.find((i) => i.is_primary);
  if (!primary) return false;
  if (g.images?.some((i) => i.image_type === "thumbnail" && i.derived_from === primary.id)) return false;
  try {
    const blob = await (await fetch(primary.url, { credentials: "same-origin" })).blob();
    const thumb = await makeThumbnail(blob);
    await uploadImage("/api/images/upload", { garment_id: g.id, image_type: "thumbnail", derived_from: primary.id }, thumb, "thumb.webp");
    return true;
  } catch {
    return false;
  }
}

/** 顯示：適用於此主分類的屬性，加上任何已有值的屬性 */
function shownAttributes(tax: Taxonomy, g: Garment) {
  const fit = new Set(attributesFor(tax, g.category).map((a) => a.id));
  return tax.attributes.filter((a) => fit.has(a.id) || attributeValues(g, a.id).length > 0);
}

function Row({ k, v, uncertain }: { k: string; v: string | null | undefined; uncertain?: boolean }) {
  return (
    <>
      <dt className="text-mauve">{k}</dt>
      <dd className={uncertain ? "text-wine" : ""}>{v || (uncertain ? "AI 未能確定" : "—")}</dd>
    </>
  );
}

function FileButton({ label, onFile, disabled, variant = "soft" }: { label: string; onFile: (f: File) => void; disabled?: boolean; variant?: "soft" | "ghost" }) {
  return (
    <label
      className={`inline-flex min-h-11 cursor-pointer items-center rounded-full px-5 text-[15px] ${
        variant === "soft" ? "bg-rose" : "ring-1 ring-amethyst/30 text-amethyst-deep"
      } ${disabled ? "pointer-events-none opacity-40" : ""}`}
    >
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

function EditForm({ g, tax, onSave, onCancel }: { g: Garment; tax: Taxonomy; onSave: (b: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState({
    name: g.name,
    category: g.category || "",
    subcategory: g.subcategory || "",
    brand: g.brand || "",
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
    const initial = { name: g.name, category: g.category || "", subcategory: g.subcategory || "", brand: g.brand || "", pattern: g.pattern || "", notes: g.notes || "" };
    for (const [k, v] of Object.entries(f)) if (v !== initial[k as keyof typeof initial]) body[k] = v;
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
    const prevObj = JSON.stringify(Object.fromEntries(Object.entries(g.attributes ?? {}).sort()));
    if (JSON.stringify(Object.fromEntries(Object.entries(nextObj).sort())) !== prevObj) body.attributes = nextObj;
    return body;
  }

  return (
    <form
      className="mt-5 space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSave(buildBody());
        setBusy(false);
      }}
    >
      <Field label="名稱">
        <input className={inputCls} value={f.name} onChange={set("name")} required />
      </Field>
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
      <Field label="品牌">
        <input className={inputCls} value={f.brand} onChange={set("brand")} />
      </Field>
      {visible.map((a) => (
        <div key={a.id}>
          <p className="mb-1.5 text-[13px] text-mauve">
            {a.name}
            {a.multi ? <span className="ml-1 text-[11px]">（多選{a.max_select ? `，最多 ${a.max_select} 個` : ""}）</span> : null}
          </p>
          <PickChips
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
      <div className="sticky bottom-20 z-10 flex gap-2 bg-lace/95 py-2 backdrop-blur">
        <Button type="submit" disabled={busy}>
          {busy ? "儲存中…" : "儲存"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Link to="/taxonomy" className="ml-auto self-center text-[13px] text-amethyst-deep underline underline-offset-4">
          管理分類
        </Link>
      </div>
    </form>
  );
}
