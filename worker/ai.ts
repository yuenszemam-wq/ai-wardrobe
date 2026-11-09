/**
 * AI 待整理流程
 *
 *  App 批量上傳（intake）→ 衣物以「待整理衣物 NNN」建立，ai_status = pending_ai
 *  → ChatGPT／Claude 讀取待整理清單（REST／MCP／D1 的 ai_image_links）及短效簽名圖片網址
 *  → AI 提交 ai_suggestions（永不直接覆寫 garments）
 *  → Worker 驗證（欄位、版本、冪等鍵、品牌證據）→ ai_status = pending_review
 *  → 使用者在 App 確認（全部／部分欄位／手動修改／保留原資料）後才正式寫入 garments。
 *
 *  注意：AI 分析本身由使用者在 ChatGPT／Claude 對話中觸發，Worker 不會自行辨認圖片。
 */
import { CATEGORIES, LOLITA_SUBCATEGORIES, STYLES } from "../shared/taxonomy";
import { AI_STATUSES, AiStatus, garmentToJson, normalizeGarment, updateGarment } from "./garments";
import { currentTaxonomy } from "./taxonomy";
import { maxUploadBytes, parseImage, storeImage, StoredImage } from "./images";
import { Actor, Env, HttpError, audit, intVar, newId, nowIso, parseJsonArray, sha256Hex, str, strArray, toBase64Url } from "./util";

const CLAIM_MINUTES = 30;
const LINK_MINUTES = 60;
const LINK_REFRESH_BEFORE_MINUTES = 20;
const ACTIVE_FOR_AI: AiStatus[] = ["pending_ai", "ai_processing", "needs_rework"];

export const AI_STATUS_LABEL: Record<AiStatus, string> = {
  pending_ai: "待 AI 辨認",
  ai_processing: "AI 整理中",
  pending_review: "待人工確認",
  done: "已完成",
  failed: "辨認失敗",
  needs_rework: "需要重新處理",
};

export const BRAND_CONFIDENCE = ["confirmed", "likely", "unconfirmed"] as const;
type BrandConfidence = (typeof BRAND_CONFIDENCE)[number];

/** 可經確認寫入 garments 的欄位 */
export const ACCEPTABLE_FIELDS = [
  "name",
  "category",
  "subcategory",
  "style",
  "primary_color",
  "secondary_colors",
  "pattern",
  "season",
  "brand",
  "details",
] as const;
type AcceptableField = (typeof ACCEPTABLE_FIELDS)[number];

// ───────────────────────── 公開網址及簽名 ─────────────────────────

let cachedOrigin: string | null = null;

/** 記錄 App 的公開網址（cron 產生簽名網址時需要） */
export async function recordOrigin(env: Env, origin: string): Promise<void> {
  if (cachedOrigin === origin || !/^https:\/\//.test(origin)) return;
  cachedOrigin = origin;
  await env.DB.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('public_origin', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE app_settings.value != excluded.value`,
  )
    .bind(origin, nowIso())
    .run()
    .catch(() => undefined);
}

async function publicOrigin(env: Env): Promise<string | null> {
  if (cachedOrigin) return cachedOrigin;
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'public_origin'").first<{ value: string }>();
  return row?.value ?? null;
}

let cachedKey: CryptoKey | null = null;
async function signingKey(env: Env): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  let row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'ai_link_secret'").first<{ value: string }>();
  if (!row) {
    const secret = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('ai_link_secret', ?, ?)").bind(secret, nowIso()).run();
    row = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'ai_link_secret'").first<{ value: string }>();
  }
  cachedKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(row!.value), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return cachedKey;
}

async function sign(env: Env, imageId: string, exp: number): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await signingKey(env), new TextEncoder().encode(`${imageId}.${exp}`));
  return toBase64Url(new Uint8Array(mac));
}

export async function signedImageUrl(env: Env, origin: string, imageId: string, minutes = LINK_MINUTES) {
  const exp = Math.floor(Date.now() / 1000) + minutes * 60;
  return { url: `${origin}/api/ai-image/${imageId}?exp=${exp}&sig=${await sign(env, imageId, exp)}`, expires_at: new Date(exp * 1000).toISOString() };
}

/** 驗證短效簽名網址並串流圖片（不需登入；網址過期即失效） */
export async function serveSignedImage(env: Env, imageId: string, url: URL): Promise<Response> {
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) throw new HttpError(403, "link_expired", "圖片網址已過期，請重新取得待整理清單");
  if (exp * 1000 > Date.now() + 25 * 3600_000) throw new HttpError(403, "bad_signature", "簽名無效");
  const expected = await sign(env, imageId, exp);
  if (expected.length !== sig.length || !timingSafe(expected, sig)) throw new HttpError(403, "bad_signature", "簽名無效");
  const row = await env.DB.prepare("SELECT r2_key, mime_type, sha256 FROM garment_images WHERE id = ?").bind(imageId).first<{ r2_key: string; mime_type: string; sha256: string }>();
  if (!row) throw new HttpError(404, "image_not_found", "找不到圖片");
  const obj = await env.IMAGES.get(row.r2_key);
  if (!obj) throw new HttpError(404, "object_missing", "R2 找不到圖片檔案");
  return new Response(obj.body, {
    headers: {
      "content-type": row.mime_type,
      "content-length": String(obj.size),
      "cache-control": "private, max-age=600",
      etag: `"${row.sha256}"`,
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    },
  });
}

function timingSafe(a: string, b: string) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ───────────────────────── App 批量上傳（intake） ─────────────────────────

const PLACEHOLDER_INSERT = `
  INSERT INTO garments (id, name, status, source, client_key, created_at, updated_at, ai_status, display_no, name_is_placeholder)
  SELECT ?, '待整理衣物 ' || printf('%03d', n), 'review', 'app', ?, ?, ?, 'pending_ai', n, 1
  FROM (SELECT COALESCE(MAX(display_no), 0) + 1 AS n FROM garments)`;

async function createPlaceholderGarment(env: Env, clientKey: string): Promise<{ id: string; created: boolean }> {
  const existing = await env.DB.prepare("SELECT id FROM garments WHERE client_key = ?").bind(clientKey).first<{ id: string }>();
  if (existing) return { id: existing.id, created: false };
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = newId("gar");
    const now = nowIso();
    try {
      await env.DB.prepare(PLACEHOLDER_INSERT).bind(id, clientKey, now, now).run();
      return { id, created: true };
    } catch (err) {
      // 並發：client_key 已被另一個請求建立，或 display_no 撞號 → 重試
      const again = await env.DB.prepare("SELECT id FROM garments WHERE client_key = ?").bind(clientKey).first<{ id: string }>();
      if (again) return { id: again.id, created: false };
      if (attempt === 4) throw err;
    }
  }
  throw new HttpError(500, "create_failed", "未能建立衣物記錄");
}

export interface IntakeResult {
  garment_id: string;
  name: string;
  display_no: number | null;
  duplicate: boolean;
  verified: boolean;
  image: { id: string; image_type: string; mime_type: string; width: number; height: number; file_size: number; sha256: string; has_alpha: boolean };
  preview_id: string | null;
  thumbnail_id: string | null;
  analysis_id: string | null;
  warnings: string[];
}

/**
 * App 上傳一張相 = 一件待整理衣物。
 * multipart 欄位：file（原檔，原樣保存）、sha256（瀏覽器計算的原檔 SHA-256）、
 *   preview（HEIC 的 JPEG 預覽，可選）、thumbnail（480px，可選）、analysis（約 1600px 供 AI 辨認，可選）。
 * 冪等：同一張相（SHA-256 相同）重傳只會得到同一件衣物，不會重複建立。
 */
export async function intakeUpload(req: Request, env: Env, actor: Actor): Promise<IntakeResult> {
  const limit = maxUploadBytes(env);
  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > limit + 12 * 1024 * 1024) throw new HttpError(413, "file_too_large", "檔案超過上傳上限");
  if (!(req.headers.get("content-type") || "").startsWith("multipart/form-data")) {
    throw new HttpError(415, "bad_content_type", "請以 multipart/form-data 上傳");
  }
  const form = await req.formData();
  const blob = (k: string) => {
    const v = form.get(k);
    return v && typeof v !== "string" ? (v as unknown as File) : null;
  };
  const file = blob("file");
  if (!file) throw new HttpError(400, "no_file", "找不到上傳檔案（欄位名稱應為 file）");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength) throw new HttpError(400, "empty_file", "檔案是空的");
  if (bytes.byteLength > limit) throw new HttpError(413, "file_too_large", `檔案超過 ${intVar(env.MAX_UPLOAD_MB, 25)} MB 上限`);

  // 完整性：瀏覽器與伺服器計算的 SHA-256 必須一致（防止傳輸途中損壞或被改動）
  const sha = await sha256Hex(bytes);
  const clientSha = String(form.get("sha256") || "").toLowerCase();
  if (clientSha && clientSha !== sha) {
    throw new HttpError(422, "integrity_mismatch", "上傳內容與原檔不一致（SHA-256 不符），請重試", { server_sha256: sha });
  }
  const info = parseImage(bytes, { allowHeif: true });
  const mainType = info.hasAlpha ? "processed" : "original";

  // 衣櫃已有同一張相 → 不重複建立
  const dup = await env.DB.prepare(
    `SELECT gi.id, gi.garment_id, g.name, g.display_no FROM garment_images gi JOIN garments g ON g.id = gi.garment_id
     WHERE gi.sha256 = ? AND gi.image_type IN ('original','processed') AND gi.variant IS NULL LIMIT 1`,
  )
    .bind(sha)
    .first<{ id: string; garment_id: string; name: string; display_no: number | null }>();
  if (dup) {
    const img = await env.DB.prepare("SELECT * FROM garment_images WHERE id = ?").bind(dup.id).first<Record<string, unknown>>();
    return {
      garment_id: dup.garment_id,
      name: dup.name,
      display_no: dup.display_no,
      duplicate: true,
      verified: true,
      image: imageSummary(img!),
      preview_id: null,
      thumbnail_id: null,
      analysis_id: null,
      warnings: ["衣櫃已有同一張相片，沒有重複建立"],
    };
  }

  const { id: garmentId, created } = await createPlaceholderGarment(env, `intake:${sha}`);
  let main: StoredImage;
  try {
    main = await storeImage(env, { owner: "garment", ownerId: garmentId, imageType: mainType, bytes, actor, allowHeif: true });
  } catch (err) {
    if (created) {
      // 主圖失敗：移除剛建立、仍沒有圖片的衣物記錄，避免「有名無圖」
      await env.DB.prepare("DELETE FROM garments WHERE id = ? AND NOT EXISTS (SELECT 1 FROM garment_images WHERE garment_id = ?)")
        .bind(garmentId, garmentId)
        .run()
        .catch(() => undefined);
    }
    throw err;
  }
  const warnings = [...main.warnings];
  const isHeif = info.mime === "image/heic" || info.mime === "image/heif";

  let previewId: string | null = null;
  const preview = blob("preview");
  if (isHeif) {
    if (preview) {
      try {
        const p = await storeImage(env, {
          owner: "garment", ownerId: garmentId, imageType: "original", variant: "preview", isPrimary: true,
          bytes: new Uint8Array(await preview.arrayBuffer()), derivedFrom: main.id, actor,
        });
        previewId = p.id;
      } catch (e) {
        warnings.push(`HEIC 預覽未能保存：${(e as Error).message}`);
      }
    } else warnings.push("HEIC 原檔已保存，但沒有預覽圖；部分瀏覽器可能無法顯示");
  }

  const base = previewId ?? main.id;
  let thumbId: string | null = null;
  let analysisId: string | null = null;
  const thumb = blob("thumbnail");
  if (thumb) {
    try {
      thumbId = (await storeImage(env, { owner: "garment", ownerId: garmentId, imageType: "thumbnail", bytes: new Uint8Array(await thumb.arrayBuffer()), derivedFrom: base, actor })).id;
    } catch (e) {
      warnings.push(`縮圖未能保存：${(e as Error).message}`);
    }
  }
  const analysis = blob("analysis");
  if (analysis) {
    try {
      analysisId = (
        await storeImage(env, {
          owner: "garment", ownerId: garmentId, imageType: "thumbnail", variant: "analysis",
          bytes: new Uint8Array(await analysis.arrayBuffer()), derivedFrom: base, actor,
        })
      ).id;
    } catch (e) {
      warnings.push(`AI 辨認用圖片未能保存：${(e as Error).message}`);
    }
  }

  const g = await env.DB.prepare("SELECT name, display_no FROM garments WHERE id = ?").bind(garmentId).first<{ name: string; display_no: number | null }>();
  await audit(env, actor, "intake.upload", garmentId, { sha256: sha, size: bytes.byteLength, w: info.width, h: info.height, mime: info.mime, created });
  return {
    garment_id: garmentId,
    name: g?.name ?? "",
    display_no: g?.display_no ?? null,
    duplicate: main.deduplicated,
    verified: true,
    image: {
      id: main.id, image_type: main.image_type, mime_type: main.mime_type, width: main.width, height: main.height,
      file_size: main.file_size, sha256: main.sha256, has_alpha: main.has_alpha,
    },
    preview_id: previewId,
    thumbnail_id: thumbId,
    analysis_id: analysisId,
    warnings,
  };
}

function imageSummary(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    image_type: String(r.image_type),
    mime_type: String(r.mime_type),
    width: Number(r.width),
    height: Number(r.height),
    file_size: Number(r.file_size),
    sha256: String(r.sha256),
    has_alpha: Number(r.has_alpha) === 1,
  };
}

// ───────────────────────── AI 讀取待整理清單 ─────────────────────────

interface ImgRow {
  id: string;
  garment_id: string;
  image_type: string;
  variant: string | null;
  mime_type: string;
  width: number;
  height: number;
  file_size: number;
  sha256: string;
  has_alpha: number;
  is_primary: number;
}

/** 揀選 AI 用的圖片：analysis（中尺寸）→ HEIC 預覽 → 原圖 → 去背圖 */
function pickImages(imgs: ImgRow[]) {
  const browserOk = (i: ImgRow) => !/heic|heif/.test(i.mime_type);
  const analysis = imgs.find((i) => i.variant === "analysis");
  const preview = imgs.find((i) => i.variant === "preview");
  const original = imgs.find((i) => i.image_type === "original" && !i.variant);
  const processed = imgs.find((i) => i.image_type === "processed");
  const thumb = imgs.find((i) => i.image_type === "thumbnail" && !i.variant);
  const full = original && browserOk(original) ? original : preview ?? processed ?? original ?? null;
  return { analysis: analysis ?? full, full, original: original ?? null, processed: processed ?? null, thumb: thumb ?? null };
}

async function imagesFor(env: Env, ids: string[]): Promise<Map<string, ImgRow[]>> {
  const map = new Map<string, ImgRow[]>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results } = await env.DB.prepare(
      `SELECT id, garment_id, image_type, variant, mime_type, width, height, file_size, sha256, has_alpha, is_primary
       FROM garment_images WHERE garment_id IN (${chunk.map(() => "?").join(",")}) ORDER BY created_at`,
    )
      .bind(...chunk)
      .all<ImgRow>();
    for (const r of results) {
      const list = map.get(r.garment_id) ?? [];
      list.push(r);
      map.set(r.garment_id, list);
    }
  }
  return map;
}

function staleClaimIso() {
  return new Date(Date.now() - CLAIM_MINUTES * 60_000).toISOString();
}

/** AI 讀取待整理清單（含短效簽名圖片網址） */
export async function aiQueue(env: Env, origin: string, opts: { limit?: number; garment_ids?: string[]; include_review?: boolean } = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 30);
  let rows: Record<string, unknown>[];
  if (opts.garment_ids?.length) {
    const ids = opts.garment_ids.slice(0, 30);
    rows = (await env.DB.prepare(`SELECT * FROM garments WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<Record<string, unknown>>()).results;
  } else {
    const statuses = opts.include_review ? [...ACTIVE_FOR_AI, "pending_review", "failed"] : [...ACTIVE_FOR_AI, "failed"];
    rows = (
      await env.DB.prepare(
        `SELECT * FROM garments WHERE status != 'archived' AND ai_status IN (${statuses.map(() => "?").join(",")})
           AND NOT (ai_status = 'ai_processing' AND ai_claimed_at > ?)
         ORDER BY CASE ai_status WHEN 'needs_rework' THEN 0 WHEN 'pending_ai' THEN 1 ELSE 2 END, display_no, created_at LIMIT ?`,
      )
        .bind(...statuses, staleClaimIso(), limit)
        .all<Record<string, unknown>>()
    ).results;
  }
  const imgs = await imagesFor(env, rows.map((r) => String(r.id)));
  const items = [];
  for (const r of rows) {
    const g = garmentToJson(r);
    const pick = pickImages(imgs.get(String(r.id)) ?? []);
    const link = async (i: ImgRow | null, note: string) =>
      i ? { image_id: i.id, mime_type: i.mime_type, width: i.width, height: i.height, file_size: i.file_size, note, ...(await signedImageUrl(env, origin, i.id)) } : null;
    items.push({
      garment_id: g.id,
      version: Number(r.version),
      ai_status: r.ai_status,
      ai_status_label: AI_STATUS_LABEL[r.ai_status as AiStatus] ?? null,
      display_name: g.name,
      name_is_placeholder: g.name_is_placeholder,
      current: {
        name: g.name_is_placeholder ? null : g.name,
        category: r.category, subcategory: r.subcategory, style: r.style, brand: r.brand,
        primary_color: r.primary_color, secondary_colors: g.secondary_colors, pattern: r.pattern, season: r.season,
      },
      locked_fields: g.locked_fields,
      uploaded_at: r.created_at,
      analysis_image: await link(pick.analysis, pick.analysis?.variant === "analysis" ? "約 1600px 縮小版（未經 AI 改動），適合辨認" : "原圖"),
      original_image: await link(pick.full, "未經改動的高清原圖（品牌辨認請以此為準）"),
      has_processed_image: Boolean(pick.processed),
      images: (imgs.get(String(r.id)) ?? []).map((i) => ({
        image_id: i.id, image_type: i.image_type, variant: i.variant, mime_type: i.mime_type, width: i.width, height: i.height, file_size: i.file_size, sha256: i.sha256,
      })),
      analysis_done: r.ai_status === "pending_review" || r.ai_status === "done",
    });
  }
  return { items, count: items.length, link_minutes: LINK_MINUTES };
}

/** 標記為 AI 整理中（租約 30 分鐘，逾時自動退回待 AI 辨認） */
export async function claimGarments(env: Env, actor: Actor, ids: string[], by?: string) {
  const list = (ids || []).map(String).filter(Boolean).slice(0, 30);
  if (!list.length) throw new HttpError(400, "missing_ids", "需要 garment_ids");
  const now = nowIso();
  const res = await env.DB.prepare(
    `UPDATE garments SET ai_status = 'ai_processing', ai_claimed_at = ?, ai_claimed_by = ?
     WHERE id IN (${list.map(() => "?").join(",")})
       AND (ai_status IN ('pending_ai','needs_rework','failed') OR (ai_status = 'ai_processing' AND ai_claimed_at <= ?))
     RETURNING id`,
  )
    .bind(now, str(by, 40) ?? actor.label, ...list, staleClaimIso())
    .run();
  const claimed = ((res as unknown as { results?: { id: string }[] }).results ?? []).map((r) => r.id);
  return { claimed, skipped: list.filter((x) => !claimed.includes(x)), lease_minutes: CLAIM_MINUTES };
}

// ───────────────────────── AI 建議：驗證 ─────────────────────────

export interface SuggestionInput {
  garment_id?: unknown;
  idempotency_key?: unknown;
  base_version?: unknown;
  source?: unknown;
  image_id?: unknown;
  vision_checked?: unknown;
  outcome?: unknown; // suggestion | failed
  failure_reason?: unknown;
  fields?: Record<string, unknown>;
  [k: string]: unknown;
}

const SUGGESTION_KEYS = new Set([
  "name", "category", "subcategory", "style", "primary_color", "secondary_colors", "pattern", "season", "details",
  "is_full_outfit", "has_multiple_items", "needs_review", "uncertain_fields", "ai_note",
  "brand", "brand_confidence", "official_name", "series_name", "release_year", "source_urls", "source_type", "brand_note",
  "brand_evidence_from_generated_image",
]);

function boolOrNull(v: unknown): boolean | null {
  if (v === true || v === "true" || v === 1 || v === "1") return true;
  if (v === false || v === "false" || v === 0 || v === "0") return false;
  return null;
}

/** 驗證 AI 提交的欄位；不認識的值一律留空並標記不確定，絕不強行猜測 */
export function normalizeSuggestion(fields: Record<string, unknown>) {
  const warnings: string[] = [];
  const unknown = Object.keys(fields).filter((k) => !SUGGESTION_KEYS.has(k));
  if (unknown.length) warnings.push(`已忽略不支援的欄位：${unknown.join("、")}`);

  const { values, uncertain } = normalizeGarment(
    {
      name: fields.name, category: fields.category, subcategory: fields.subcategory, style: fields.style,
      primary_color: fields.primary_color, secondary_colors: fields.secondary_colors, pattern: fields.pattern,
      season: fields.season, brand: fields.brand, uncertain_fields: fields.uncertain_fields, ai_note: fields.ai_note,
    },
    true,
  );
  const sub = values.subcategory as string | null | undefined;
  if (sub && !currentTaxonomy().categories.some((c) => c.subs.some((x) => x.name === sub))) warnings.push(`子類別「${sub}」不在分類字典內，已照錄，請人工確認`);

  let conf = (str(fields.brand_confidence, 20) ?? "unconfirmed") as BrandConfidence;
  if (!BRAND_CONFIDENCE.includes(conf)) {
    warnings.push(`brand_confidence「${conf}」無效，已改為 unconfirmed`);
    conf = "unconfirmed";
  }
  const sourceUrls = (strArray(fields.source_urls, 8) ?? []).filter((u) => /^https?:\/\//i.test(u));
  const fromGenerated = boolOrNull(fields.brand_evidence_from_generated_image) === true;
  const brandRaw = (values.brand as string | null | undefined) ?? null;
  if (conf === "confirmed" && !sourceUrls.length) {
    warnings.push("品牌標示為已確認但沒有來源連結，已降為「高度可能」");
    conf = "likely";
  }
  if (conf === "confirmed" && fromGenerated) {
    warnings.push("品牌證據來自 AI 生成／去背圖片，可能與實物不同，已降為「高度可能」");
    conf = "likely";
  }
  if (conf === "confirmed" && !brandRaw) conf = "unconfirmed";
  const brand = conf === "confirmed" ? brandRaw : null; // 未確認的品牌一律不填入 brand
  const brandCandidate = brandRaw && conf !== "confirmed" ? brandRaw : null;

  const yearRaw = fields.release_year;
  const year = yearRaw === undefined || yearRaw === null || yearRaw === "" ? null : Number(yearRaw);
  const releaseYear = year && Number.isInteger(year) && year >= 1980 && year <= 2100 ? year : null;
  if (yearRaw && releaseYear === null) warnings.push("發售年份無效，已留空");

  const hasMultiple = boolOrNull(fields.has_multiple_items);
  const needsReview = boolOrNull(fields.needs_review) === true || hasMultiple === true || uncertain.length > 0;

  const normalized = {
    name: (values.name as string | null | undefined) ?? null,
    category: (values.category as string | null | undefined) ?? null,
    subcategory: sub ?? null,
    style: (values.style as string | null | undefined) ?? null,
    primary_color: (values.primary_color as string | null | undefined) ?? null,
    secondary_colors: values.secondary_colors ? (JSON.parse(String(values.secondary_colors)) as string[]) : null,
    pattern: (values.pattern as string | null | undefined) ?? null,
    season: (values.season as string | null | undefined) ?? null,
    details: str(fields.details, 500),
    is_full_outfit: boolOrNull(fields.is_full_outfit),
    has_multiple_items: hasMultiple,
    needs_review: needsReview,
    uncertain_fields: uncertain,
    ai_note: (values.ai_note as string | null | undefined) ?? null,
    brand,
    brand_candidate: brandCandidate,
    brand_confidence: conf,
    official_name: str(fields.official_name, 160),
    series_name: str(fields.series_name, 160),
    release_year: releaseYear,
    source_urls: sourceUrls,
    source_type: str(fields.source_type, 60),
    brand_note: str(fields.brand_note, 1000),
    brand_evidence_from_generated_image: fromGenerated,
  };
  const anyField = ACCEPTABLE_FIELDS.some((f) => normalized[f] !== null && normalized[f] !== undefined) || brandCandidate;
  return { normalized, warnings, anyField: Boolean(anyField) };
}

/** 把 AI 的扁平或 fields 包裝輸入統一成欄位物件 */
function fieldsOf(input: SuggestionInput): Record<string, unknown> {
  if (input.fields && typeof input.fields === "object") return input.fields;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (SUGGESTION_KEYS.has(k)) out[k] = v;
  return out;
}

interface Validated {
  ok: boolean;
  error?: string;
  code?: string;
  normalized?: ReturnType<typeof normalizeSuggestion>["normalized"];
  warnings: string[];
  failed?: boolean;
}

async function validate(env: Env, garment: Record<string, unknown> | null, input: SuggestionInput, baseVersion: number): Promise<Validated> {
  if (!garment) return { ok: false, code: "garment_not_found", error: "找不到這件衣物", warnings: [] };
  if (garment.status === "archived") return { ok: false, code: "archived", error: "衣物已封存", warnings: [] };
  if (!Number.isInteger(baseVersion)) return { ok: false, code: "missing_version", error: "需要 base_version（讀取衣物時的 version）", warnings: [] };
  if (baseVersion !== Number(garment.version)) {
    return { ok: false, code: "stale_version", error: `衣物已被修改（目前 version ${garment.version}，你讀取時是 ${baseVersion}），請重新讀取後再分析`, warnings: [] };
  }
  const outcome = str(input.outcome, 20) ?? "suggestion";
  if (outcome === "failed") {
    return { ok: true, failed: true, warnings: [], error: str(input.failure_reason, 500) ?? "AI 未能辨認" };
  }
  if (boolOrNull(input.vision_checked) !== true) {
    return { ok: false, code: "vision_required", error: "必須實際查看圖片像素後才可提交辨認結果（vision_checked=true）；只看到 metadata 時請以 outcome=failed 回報", warnings: [] };
  }
  const warnings: string[] = [];
  const imageId = str(input.image_id, 40);
  if (imageId) {
    const own = await env.DB.prepare("SELECT 1 FROM garment_images WHERE id = ? AND garment_id = ?").bind(imageId, garment.id).first();
    if (!own) return { ok: false, code: "bad_image", error: "image_id 不屬於這件衣物", warnings: [] };
  } else warnings.push("沒有提供 image_id，未能記錄 AI 實際查看了哪張圖");
  const n = normalizeSuggestion(fieldsOf(input));
  if (!n.anyField) return { ok: false, code: "empty", error: "沒有任何可用欄位；不清楚時請用 outcome=failed", warnings: n.warnings };
  return { ok: true, normalized: n.normalized, warnings: [...warnings, ...n.warnings] };
}

function markGarmentStmts(env: Env, garmentId: string, v: Validated, suggestionId: number | null) {
  const now = nowIso();
  if (v.failed) {
    return [
      env.DB.prepare("UPDATE garments SET ai_status = 'failed', ai_error = ?, ai_claimed_at = NULL, ai_claimed_by = NULL, ai_updated_at = ? WHERE id = ?").bind(v.error ?? null, now, garmentId),
    ];
  }
  return [
    env.DB.prepare("UPDATE ai_suggestions SET status = 'superseded' WHERE garment_id = ? AND status = 'valid' AND id != ?").bind(garmentId, suggestionId ?? -1),
    env.DB.prepare(
      "UPDATE garments SET ai_status = 'pending_review', ai_error = NULL, ai_claimed_at = NULL, ai_claimed_by = NULL, ai_updated_at = ? WHERE id = ?",
    ).bind(now, garmentId),
  ];
}

/** AI 經 REST／MCP 提交建議（立即驗證） */
export async function submitSuggestion(env: Env, actor: Actor, input: SuggestionInput) {
  const garmentId = str(input.garment_id, 40);
  const key = str(input.idempotency_key, 120);
  if (!garmentId) throw new HttpError(400, "missing_garment_id", "需要 garment_id");
  if (!key) throw new HttpError(400, "missing_idempotency_key", "需要 idempotency_key（例如 garment_id + 日期 + 次數）");

  const prev = await env.DB.prepare("SELECT * FROM ai_suggestions WHERE idempotency_key = ?").bind(key).first<Record<string, unknown>>();
  if (prev) {
    if (prev.garment_id !== garmentId) throw new HttpError(409, "idempotency_conflict", "此 idempotency_key 已用於另一件衣物");
    return { ...suggestionJson(prev), idempotent_replay: true };
  }
  const garment = await env.DB.prepare("SELECT * FROM garments WHERE id = ?").bind(garmentId).first<Record<string, unknown>>();
  const v = await validate(env, garment, input, Number(input.base_version));
  if (!v.ok) throw new HttpError(v.code === "stale_version" || v.code === "idempotency_conflict" ? 409 : v.code === "garment_not_found" ? 404 : 422, v.code ?? "invalid", v.error ?? "驗證失敗", { warnings: v.warnings, current_version: garment?.version ?? null });

  const source = str(input.source, 40) ?? (actor.kind === "session" ? "app" : actor.label);
  const now = nowIso();
  const ins = await env.DB.prepare(
    `INSERT INTO ai_suggestions (garment_id, idempotency_key, base_version, source, image_id, vision_checked, payload, normalized, status, error_message, created_at, validated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  )
    .bind(
      garmentId, key, Number(input.base_version), source, str(input.image_id, 40), v.failed ? 0 : 1,
      JSON.stringify(input).slice(0, 20000), v.normalized ? JSON.stringify({ ...v.normalized, warnings: v.warnings }) : null,
      v.failed ? "invalid" : "valid", v.failed ? v.error ?? null : null, now, now,
    )
    .run();
  const id = Number((ins as unknown as { results: { id: number }[] }).results[0].id);
  await env.DB.batch(markGarmentStmts(env, garmentId, v, id));
  await audit(env, actor, v.failed ? "ai.failed" : "ai.suggest", garmentId, { suggestion_id: id, source });
  const row = await env.DB.prepare("SELECT * FROM ai_suggestions WHERE id = ?").bind(id).first<Record<string, unknown>>();
  const g = await env.DB.prepare("SELECT id, name, ai_status, version FROM garments WHERE id = ?").bind(garmentId).first();
  return { ...suggestionJson(row!), garment: g, locked_fields: parseJsonArray(garment!.locked_fields) };
}

/** 處理 ChatGPT 經 Cloudflare D1 連接器直接 INSERT 的建議（status = 'submitted'） */
export async function validateSubmitted(env: Env, max = 50) {
  const { results } = await env.DB.prepare("SELECT * FROM ai_suggestions WHERE status = 'submitted' ORDER BY id LIMIT ?").bind(max).all<Record<string, unknown>>();
  const out: { id: number; status: string; error?: string }[] = [];
  for (const row of results) {
    let input: SuggestionInput;
    try {
      input = JSON.parse(String(row.payload));
      if (!input || typeof input !== "object") throw new Error();
    } catch {
      await env.DB.prepare("UPDATE ai_suggestions SET status = 'invalid', error_message = ?, validated_at = ? WHERE id = ?").bind("payload 不是有效 JSON", nowIso(), row.id).run();
      out.push({ id: Number(row.id), status: "invalid", error: "payload 不是有效 JSON" });
      continue;
    }
    // D1 欄位優先（ChatGPT 可只把欄位放在 payload 內）
    input.vision_checked = Number(row.vision_checked) === 1 ? true : input.vision_checked;
    input.image_id = row.image_id ?? input.image_id;
    const garment = await env.DB.prepare("SELECT * FROM garments WHERE id = ?").bind(row.garment_id).first<Record<string, unknown>>();
    const v = await validate(env, garment, input, Number(row.base_version));
    const now = nowIso();
    if (!v.ok) {
      await env.DB.prepare("UPDATE ai_suggestions SET status = 'invalid', error_message = ?, normalized = ?, validated_at = ? WHERE id = ?")
        .bind(`${v.code}: ${v.error}`, v.warnings.length ? JSON.stringify({ warnings: v.warnings }) : null, now, row.id)
        .run();
      out.push({ id: Number(row.id), status: "invalid", error: v.error });
      continue;
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE ai_suggestions SET status = ?, normalized = ?, error_message = ?, vision_checked = ?, validated_at = ? WHERE id = ?").bind(
        v.failed ? "invalid" : "valid",
        v.normalized ? JSON.stringify({ ...v.normalized, warnings: v.warnings }) : null,
        v.failed ? v.error ?? null : null,
        v.failed ? 0 : 1,
        now,
        row.id,
      ),
      ...markGarmentStmts(env, String(row.garment_id), v, Number(row.id)),
    ]);
    await audit(env, `d1:${row.source}`, v.failed ? "ai.failed" : "ai.suggest", String(row.garment_id), { suggestion_id: row.id });
    out.push({ id: Number(row.id), status: v.failed ? "failed" : "valid" });
  }
  return out;
}

export function suggestionJson(r: Record<string, unknown>) {
  let normalized: Record<string, unknown> | null = null;
  try {
    normalized = r.normalized ? JSON.parse(String(r.normalized)) : null;
  } catch {
    normalized = null;
  }
  return {
    suggestion_id: Number(r.id),
    garment_id: r.garment_id,
    status: r.status,
    source: r.source,
    base_version: Number(r.base_version),
    image_id: r.image_id ?? null,
    vision_checked: Number(r.vision_checked) === 1,
    normalized,
    error_message: r.error_message ?? null,
    accepted_fields: parseJsonArray(r.accepted_fields),
    created_at: r.created_at,
    decided_at: r.decided_at ?? null,
  };
}

// ───────────────────────── App：確認中心 ─────────────────────────

export async function reviewList(env: Env, params: URLSearchParams) {
  await validateSubmitted(env).catch((e) => console.error("validateSubmitted", e));
  const statusParam = params.get("ai_status");
  const statuses = statusParam
    ? statusParam.split(",").filter((s) => (AI_STATUSES as readonly string[]).includes(s))
    : ["pending_ai", "ai_processing", "pending_review", "failed", "needs_rework"];
  const sort = params.get("sort") === "oldest" ? "g.created_at ASC" : params.get("sort") === "number" ? "g.display_no ASC" : "g.created_at DESC";
  const { results } = await env.DB.prepare(
    `SELECT g.*,
       (SELECT t.id FROM garment_images t WHERE t.garment_id = g.id AND t.image_type = 'thumbnail' AND t.variant IS NULL ORDER BY t.created_at DESC LIMIT 1) AS thumb_image_id,
       (SELECT p.id FROM garment_images p WHERE p.garment_id = g.id AND p.is_primary = 1 LIMIT 1) AS primary_image_id,
       EXISTS (SELECT 1 FROM garment_images x WHERE x.garment_id = g.id AND x.image_type = 'processed') AS has_processed
     FROM garments g
     WHERE g.status != 'archived' AND g.ai_status IN (${statuses.map(() => "?").join(",")})
     ORDER BY ${sort} LIMIT 200`,
  )
    .bind(...statuses)
    .all<Record<string, unknown>>();
  const ids = results.map((r) => String(r.id));
  const sugg = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const { results: s } = await env.DB.prepare(
      `SELECT * FROM ai_suggestions WHERE garment_id IN (${chunk.map(() => "?").join(",")}) AND status IN ('valid','invalid') ORDER BY id DESC`,
    )
      .bind(...chunk)
      .all<Record<string, unknown>>();
    for (const r of s) if (!sugg.has(String(r.garment_id)) || (sugg.get(String(r.garment_id))!.status !== "valid" && r.status === "valid")) sugg.set(String(r.garment_id), r);
  }
  const { results: counts } = await env.DB.prepare(
    "SELECT ai_status, COUNT(*) AS n FROM garments WHERE status != 'archived' AND ai_status IS NOT NULL GROUP BY ai_status",
  ).all<{ ai_status: string; n: number }>();
  return {
    items: results.map((r) => {
      const s = sugg.get(String(r.id));
      return { ...garmentToJson(r), has_processed: Number(r.has_processed) === 1, suggestion: s ? suggestionJson(s) : null };
    }),
    counts: Object.fromEntries(AI_STATUSES.map((st) => [st, counts.find((c) => c.ai_status === st)?.n ?? 0])),
    labels: AI_STATUS_LABEL,
  };
}

export interface DecideInput {
  suggestion_id?: unknown;
  action?: unknown; // accept_all | accept_fields | keep_original | mark_unconfirmed | rework
  fields?: unknown;
  edits?: Record<string, unknown>;
  version?: unknown;
}

/** 使用者確認 AI 建議（只限 App 登入使用者） */
export async function decide(env: Env, actor: Actor, garmentId: string, input: DecideInput) {
  const action = String(input.action || "");
  if (!["accept_all", "accept_fields", "keep_original", "mark_unconfirmed", "rework"].includes(action)) {
    throw new HttpError(400, "bad_action", "action 只可以是 accept_all、accept_fields、keep_original、mark_unconfirmed、rework");
  }
  const g = await env.DB.prepare("SELECT * FROM garments WHERE id = ?").bind(garmentId).first<Record<string, unknown>>();
  if (!g) throw new HttpError(404, "garment_not_found", "找不到這件衣物");
  if (input.version !== undefined && input.version !== null && Number(input.version) !== Number(g.version)) {
    throw new HttpError(409, "stale_version", "這件衣物剛被修改，請重新整理後再確認", { current_version: g.version });
  }
  const sid = Number(input.suggestion_id);
  const s = Number.isInteger(sid) && sid > 0
    ? await env.DB.prepare("SELECT * FROM ai_suggestions WHERE id = ? AND garment_id = ?").bind(sid, garmentId).first<Record<string, unknown>>()
    : await env.DB.prepare("SELECT * FROM ai_suggestions WHERE garment_id = ? AND status = 'valid' ORDER BY id DESC LIMIT 1").bind(garmentId).first<Record<string, unknown>>();
  const now = nowIso();

  if (action === "rework") {
    await env.DB.batch([
      env.DB.prepare("UPDATE garments SET ai_status = 'needs_rework', ai_claimed_at = NULL, ai_claimed_by = NULL, updated_at = ?, version = version + 1 WHERE id = ?").bind(now, garmentId),
      ...(s && s.status === "valid" ? [env.DB.prepare("UPDATE ai_suggestions SET status = 'rejected', decided_at = ? WHERE id = ?").bind(now, s.id)] : []),
    ]);
    await audit(env, actor, "ai.rework", garmentId);
    return { garment_id: garmentId, ai_status: "needs_rework", applied: [] };
  }
  if (action === "keep_original") {
    await env.DB.batch([
      env.DB.prepare("UPDATE garments SET ai_status = 'done', updated_at = ?, version = version + 1 WHERE id = ?").bind(now, garmentId),
      ...(s && s.status === "valid" ? [env.DB.prepare("UPDATE ai_suggestions SET status = 'rejected', decided_at = ? WHERE id = ?").bind(now, s.id)] : []),
    ]);
    await audit(env, actor, "ai.keep_original", garmentId);
    return { garment_id: garmentId, ai_status: "done", applied: [] };
  }

  const norm = (s && s.status === "valid" && s.normalized ? JSON.parse(String(s.normalized)) : {}) as Record<string, unknown>;
  const locked = new Set(parseJsonArray(g.locked_fields));
  const edits = input.edits && typeof input.edits === "object" ? input.edits : {};
  let chosen: AcceptableField[];
  if (action === "accept_all" || action === "mark_unconfirmed") {
    chosen = ACCEPTABLE_FIELDS.filter((f) => {
      const v = norm[f];
      if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return false;
      if (locked.has(f)) return false; // 人工修正過的欄位不會被「接受全部」覆寫
      if (f === "brand") return action === "accept_all" && norm.brand_confidence === "confirmed";
      return true;
    });
  } else {
    const want = (Array.isArray(input.fields) ? input.fields : []).map(String);
    chosen = ACCEPTABLE_FIELDS.filter((f) => want.includes(f) && norm[f] !== null && norm[f] !== undefined);
  }
  if (!s && !Object.keys(edits).length) throw new HttpError(404, "no_suggestion", "這件衣物沒有可接受的 AI 建議");

  // 組合要寫入的值：AI 建議 → 手動修改覆蓋
  const patch: Record<string, unknown> = {};
  for (const f of chosen) patch[f] = norm[f];
  const editKeys: string[] = [];
  for (const [k, v] of Object.entries(edits)) {
    if ((ACCEPTABLE_FIELDS as readonly string[]).includes(k)) {
      patch[k] = v;
      editKeys.push(k);
    }
  }
  const { values } = normalizeGarment(
    { ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== "details")) },
    true,
  );
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (k === "ai_note" || k === "uncertain_fields") continue;
    if (k === "name" && !v) continue;
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  if (values.name) sets.push("name_is_placeholder = 0");
  if (patch.details) {
    const line = `裝飾細節：${String(patch.details).slice(0, 500)}`;
    const notes = String(g.notes ?? "");
    if (!notes.includes(line)) {
      sets.push("notes = ?");
      binds.push(notes ? `${notes}\n${line}` : line);
    }
  }
  // AI 判斷說明及品牌證據保存在 ai_note，方便日後追查
  const noteParts = [
    norm.ai_note ? String(norm.ai_note) : null,
    norm.brand_candidate ? `品牌候選（${norm.brand_confidence === "likely" ? "高度可能" : "未確認"}）：${norm.brand_candidate}` : null,
    norm.official_name ? `官方款式：${norm.official_name}` : null,
    norm.series_name ? `系列：${norm.series_name}` : null,
    norm.release_year ? `發售年份：${norm.release_year}` : null,
    Array.isArray(norm.source_urls) && norm.source_urls.length ? `來源：${(norm.source_urls as string[]).join(" ")}` : null,
  ].filter(Boolean);
  if (noteParts.length) {
    sets.push("ai_note = ?");
    binds.push(noteParts.join("；").slice(0, 1000));
  }
  // 品牌已確認並寫入：同步「品牌確認」屬性
  if (patch.brand && chosen.includes("brand") && norm.brand_confidence === "confirmed") {
    const opt = currentTaxonomy().attributes.find((a) => a.id === "brand_confidence")?.options[0]?.name;
    if (opt) {
      sets.push("attributes = json_set(COALESCE(attributes, '{}'), '$.brand_confidence', ?)");
      binds.push(opt);
    }
  }
  const uncertain = action === "mark_unconfirmed" ? ["brand"] : [];
  sets.push("uncertain_fields = ?");
  binds.push(uncertain.length ? JSON.stringify(uncertain) : null);
  if (editKeys.length) {
    sets.push("locked_fields = ?");
    binds.push(JSON.stringify([...new Set([...locked, ...editKeys])]));
  }
  sets.push("status = 'active'", "ai_status = 'done'", "ai_claimed_at = NULL", "ai_claimed_by = NULL", "updated_at = ?", "version = version + 1");
  binds.push(now);

  const applied = [...new Set([...chosen, ...editKeys])];
  const stmts = [env.DB.prepare(`UPDATE garments SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, garmentId)];
  if (s && s.status === "valid") {
    const all = ACCEPTABLE_FIELDS.filter((f) => norm[f] !== null && norm[f] !== undefined);
    stmts.push(
      env.DB.prepare("UPDATE ai_suggestions SET status = ?, accepted_fields = ?, decided_at = ? WHERE id = ?").bind(
        chosen.length && chosen.length >= all.length ? "accepted" : "partially_accepted",
        JSON.stringify(chosen),
        now,
        s.id,
      ),
    );
  }
  await env.DB.batch(stmts);
  await audit(env, actor, "ai.accept", garmentId, { action, applied, suggestion_id: s?.id ?? null });
  const after = await env.DB.prepare("SELECT id, name, category, subcategory, style, brand, ai_status, status, version FROM garments WHERE id = ?").bind(garmentId).first();
  return { garment_id: garmentId, ai_status: "done", applied, skipped_locked: action === "accept_all" ? [...locked] : [], garment: after };
}

/**
 * 批量入庫：選取的衣物一次轉為正式衣物（status = active、ai_status = done）。
 * - 有 AI 建議（待人工確認）的，預設接受 AI 建議（未確認品牌不會寫入）；
 * - 其他的保留現有資料直接入庫；
 * - set 可同時為全部衣物指定主分類／子分類等（會覆蓋 AI 建議並鎖定，AI 之後不會改動）。
 */
export async function bulkIntake(env: Env, actor: Actor, ids: string[], set: Record<string, unknown>, useAi: boolean) {
  const list = [...new Set((ids || []).map(String))].slice(0, 200);
  if (!list.length) throw new HttpError(400, "missing_ids", "請先選取衣物");
  const allowed = ["category", "subcategory", "style", "season", "primary_color"];
  const edits = Object.fromEntries(Object.entries(set || {}).filter(([k, v]) => allowed.includes(k) && v !== null && v !== undefined && String(v).trim() !== ""));
  const results: { garment_id: string; ok: boolean; mode?: string; error?: string }[] = [];
  for (const id of list) {
    try {
      const g = await env.DB.prepare("SELECT id, ai_status FROM garments WHERE id = ?").bind(id).first<{ id: string; ai_status: string | null }>();
      if (!g) throw new HttpError(404, "garment_not_found", "找不到這件衣物");
      const s = useAi && g.ai_status === "pending_review"
        ? await env.DB.prepare("SELECT id FROM ai_suggestions WHERE garment_id = ? AND status = 'valid' ORDER BY id DESC LIMIT 1").bind(id).first<{ id: number }>()
        : null;
      if (s) {
        await decide(env, actor, id, { action: "accept_all", suggestion_id: s.id, edits: Object.keys(edits).length ? edits : undefined });
        results.push({ garment_id: id, ok: true, mode: "ai" });
      } else {
        await updateGarment(env, actor, id, { ...edits, confirm: true });
        await env.DB.prepare("UPDATE ai_suggestions SET status = 'rejected', decided_at = ? WHERE garment_id = ? AND status = 'valid'").bind(nowIso(), id).run();
        results.push({ garment_id: id, ok: true, mode: "as_is" });
      }
    } catch (e) {
      results.push({ garment_id: id, ok: false, error: e instanceof HttpError ? e.message : "失敗" });
    }
  }
  await audit(env, actor, "garment.bulk_intake", undefined, { count: list.length, ok: results.filter((r) => r.ok).length, set: Object.keys(edits) });
  return { results };
}

export async function setAiStatus(env: Env, actor: Actor, ids: string[], status: string) {
  if (!["pending_ai", "needs_rework", "done", "failed"].includes(status)) throw new HttpError(400, "bad_status", "不支援的狀態");
  const list = (ids || []).map(String).slice(0, 200);
  if (!list.length) throw new HttpError(400, "missing_ids", "需要 garment_ids");
  const res = await env.DB.prepare(
    `UPDATE garments SET ai_status = ?, ai_claimed_at = NULL, ai_claimed_by = NULL, updated_at = ?, version = version + 1
     WHERE id IN (${list.map(() => "?").join(",")}) AND ai_status IS NOT NULL`,
  )
    .bind(status, nowIso(), ...list)
    .run();
  await audit(env, actor, "ai.set_status", undefined, { status, count: res.meta.changes });
  return { updated: res.meta.changes };
}

// ───────────────────────── 每分鐘維護 ─────────────────────────

/** 釋放逾時租約、驗證 D1 直接提交的建議、為待整理衣物更新短效圖片網址（ai_image_links） */
export async function aiMaintenance(env: Env) {
  const released = await env.DB.prepare(
    "UPDATE garments SET ai_status = 'pending_ai', ai_claimed_at = NULL, ai_claimed_by = NULL WHERE ai_status = 'ai_processing' AND ai_claimed_at <= ?",
  )
    .bind(staleClaimIso())
    .run();
  const validated = await validateSubmitted(env);

  const now = nowIso();
  await env.DB.prepare(
    `DELETE FROM ai_image_links WHERE expires_at <= ? OR garment_id NOT IN (SELECT id FROM garments WHERE ai_status IN ('pending_ai','ai_processing','needs_rework','failed'))`,
  )
    .bind(now)
    .run();
  const origin = await publicOrigin(env);
  let refreshed = 0;
  if (origin) {
    const soon = new Date(Date.now() + LINK_REFRESH_BEFORE_MINUTES * 60_000).toISOString();
    const { results } = await env.DB.prepare(
      `SELECT g.id FROM garments g WHERE g.status != 'archived' AND g.ai_status IN ('pending_ai','ai_processing','needs_rework','failed')
         AND NOT EXISTS (SELECT 1 FROM ai_image_links l WHERE l.garment_id = g.id AND l.purpose = 'analysis' AND l.expires_at > ?)
       ORDER BY g.display_no LIMIT 100`,
    )
      .bind(soon)
      .all<{ id: string }>();
    const imgs = await imagesFor(env, results.map((r) => r.id));
    const stmts: D1PreparedStatement[] = [];
    for (const { id } of results) {
      const pick = pickImages(imgs.get(id) ?? []);
      const seen = new Set<string>();
      for (const [purpose, img] of [["analysis", pick.analysis], ["original", pick.full], ["thumbnail", pick.thumb]] as const) {
        if (!img || seen.has(img.id)) continue;
        seen.add(img.id);
        const l = await signedImageUrl(env, origin, img.id);
        stmts.push(
          env.DB.prepare(
            `INSERT INTO ai_image_links (image_id, garment_id, purpose, url, width, height, mime_type, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)
             ON CONFLICT(image_id) DO UPDATE SET purpose = excluded.purpose, url = excluded.url, expires_at = excluded.expires_at, created_at = excluded.created_at`,
          ).bind(img.id, id, purpose, l.url, img.width, img.height, img.mime_type, l.expires_at, now),
        );
      }
      refreshed++;
    }
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  }
  return { released: released.meta.changes, validated: validated.length, links_refreshed: refreshed, origin_known: Boolean(origin) };
}

export const AI_TAXONOMY = { CATEGORIES, LOLITA_SUBCATEGORIES, STYLES };
