/**
 * 批量二進位上傳（上傳槽）
 *
 * 流程：
 *   1. AI 呼叫 create_upload_session，提交最多 10 件衣物的資料、預期檔名及解像度。
 *      伺服器只建立「上傳槽」並預留 garment_id，不建立 garments 記錄。
 *   2. 每個槽有一條短效 PUT 網址；上傳頁 /u/{token} 亦可一次選取多張相，按檔名自動配對。
 *   3. 收到原始二進位 → 驗證格式／尺寸／透明通道 → SHA-256 去重 → 寫入 R2
 *      → R2 成功後，才在同一個 D1 batch 內建立 garments、garment_images、import_jobs。
 *      D1 失敗即刪除 R2 物件，槽標為 failed，可用同一網址重試。
 *   4. 伺服器從不縮小或重新壓縮圖片；R2 存的是收到的原檔（以 SHA-256 校驗）。
 */
import { GarmentInput, normalizeGarment } from "./garments";
import { LOW_RES_PIXELS, maxUploadBytes, parseImage, storeImage } from "./images";
import { createBatch, loadTicket, recomputeBatch } from "./imports";
import { Actor, Env, HttpError, audit, intVar, json, newId, nowIso, randomToken, sha256Hex, str } from "./util";

export const MAX_SESSION_ITEMS = 10;
const MAX_RENEW_ITEMS = 40;
const LOCK_MS = 120_000;
const MAX_ATTEMPTS = 8;

export interface SlotInput {
  client_key?: unknown;
  label?: unknown;
  file_name?: unknown;
  image_type?: unknown;
  expected_width?: unknown;
  expected_height?: unknown;
  require_alpha?: unknown;
  needs_review?: unknown;
  garment?: GarmentInput;
}

export interface FileRef {
  download_url?: unknown;
  file_id?: unknown;
  mime_type?: unknown;
  file_name?: unknown;
}

interface SlotRow {
  id: string;
  ticket_hash: string | null;
  batch_id: string;
  position: number;
  client_key: string;
  label: string | null;
  file_name: string | null;
  image_type: "original" | "processed";
  garment_id: string;
  garment_json: string;
  needs_review: number;
  expected_width: number | null;
  expected_height: number | null;
  require_alpha: number;
  status: "pending" | "uploading" | "done" | "duplicate" | "failed";
  lock_until: string | null;
  attempts: number;
  error_message: string | null;
  image_id: string | null;
  r2_key: string | null;
  sha256: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  file_size: number | null;
  has_alpha: number | null;
  job_id: string | null;
  duplicate_of: string | null;
}

const FINISHED = new Set(["done", "duplicate"]);

function dim(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 16384) throw new HttpError(400, "bad_dimension", `${field} 必須是 1–16384 的整數`);
  return n;
}

export function baseName(name: unknown): string {
  return String(name ?? "")
    .split(/[\\/]/)
    .pop()!
    .trim()
    .toLowerCase();
}

/** 給 AI／上傳頁看的槽狀態（不含衣物 JSON 原文） */
export function slotView(s: SlotRow, putBase?: string) {
  let name = s.label || s.client_key;
  try {
    const g = JSON.parse(s.garment_json) as { name?: string };
    if (!s.label && g.name) name = String(g.name);
  } catch {
    /* ignore */
  }
  return {
    slot_id: s.id,
    position: s.position,
    client_key: s.client_key,
    label: name,
    file_name: s.file_name,
    image_type: s.image_type,
    expected_width: s.expected_width,
    expected_height: s.expected_height,
    status: s.status === "uploading" && s.lock_until && s.lock_until < nowIso() ? "failed" : s.status,
    attempts: s.attempts,
    error: s.error_message,
    garment_id: s.status === "done" ? s.garment_id : s.status === "duplicate" ? s.duplicate_of : null,
    image_id: s.image_id,
    width: s.width,
    height: s.height,
    has_alpha: s.has_alpha === null ? null : s.has_alpha === 1,
    file_size: s.file_size,
    ...(putBase && !FINISHED.has(s.status) ? { put_url: `${putBase}/${s.id}` } : {}),
  };
}

async function slotsForBatch(env: Env, batchId: string): Promise<SlotRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM upload_slots WHERE batch_id = ? ORDER BY position").bind(batchId).all<SlotRow>();
  return results;
}

function summarize(slots: SlotRow[]) {
  const c = { total: slots.length, pending: 0, uploading: 0, done: 0, duplicate: 0, failed: 0 };
  for (const s of slots) {
    const st = slotView(s).status as keyof typeof c;
    c[st]++;
  }
  return { ...c, complete: c.total > 0 && c.done + c.duplicate === c.total };
}

/** 建立或續用上傳工作階段。items 為空而有 batch_id 時，為未完成的槽重新產生連結。 */
export async function createUploadSession(
  env: Env,
  actor: Actor,
  origin: string,
  input: { batch_id?: unknown; client_ref?: unknown; source?: unknown; note?: unknown; minutes?: unknown; items?: unknown },
) {
  const items = (Array.isArray(input.items) ? input.items : []) as SlotInput[];
  if (items.length > MAX_SESSION_ITEMS) throw new HttpError(400, "too_many_items", `每次最多 ${MAX_SESSION_ITEMS} 件，請分批`);

  // ── 批次 ──
  let batch: Record<string, unknown> | null = null;
  const batchId = str(input.batch_id, 60);
  if (!items.length && !batchId && !str(input.client_ref, 120)) throw new HttpError(400, "no_items", "items 不可為空");
  if (batchId) {
    batch = await env.DB.prepare("SELECT * FROM import_batches WHERE id = ?").bind(batchId).first<Record<string, unknown>>();
    if (!batch) throw new HttpError(404, "batch_not_found", "找不到這個匯入批次");
  } else {
    batch = (await createBatch(env, actor, { source: input.source, note: input.note, client_ref: input.client_ref })).batch as Record<string, unknown>;
  }
  const bid = String(batch.id);
  if (batch.status !== "open") {
    await env.DB.prepare("UPDATE import_batches SET status = 'open', updated_at = ? WHERE id = ?").bind(nowIso(), bid).run();
  }

  // ── 建立／更新槽 ──
  const now = nowIso();
  const seen = new Set<string>();
  const touched: string[] = [];
  const maxPos = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM upload_slots WHERE batch_id = ?").bind(bid).first<{ p: number }>();
  let pos = (maxPos?.p ?? -1) + 1;
  for (const raw of items) {
    const it = raw || {};
    const key = str(it.client_key, 120);
    if (!key) throw new HttpError(400, "missing_client_key", "每件衣物都需要 client_key");
    if (seen.has(key)) throw new HttpError(400, "duplicate_client_key", `client_key 重複：${key}`);
    seen.add(key);
    const imageType = it.image_type === "original" ? "original" : "processed";
    const ew = dim(it.expected_width, "expected_width");
    const eh = dim(it.expected_height, "expected_height");
    if ((ew === null) !== (eh === null)) throw new HttpError(400, "bad_dimension", "expected_width 及 expected_height 要一起提供");
    const requireAlpha = it.require_alpha === undefined ? imageType === "processed" : Boolean(it.require_alpha);
    const garment = (it.garment && typeof it.garment === "object" ? it.garment : {}) as GarmentInput;
    normalizeGarment(garment, false); // 提早驗證（例如 status 不合法）
    const garmentJson = JSON.stringify(garment).slice(0, 8000);

    const existing = await env.DB.prepare("SELECT * FROM upload_slots WHERE batch_id = ? AND client_key = ?").bind(bid, key).first<SlotRow>();
    if (existing) {
      if (!FINISHED.has(existing.status)) {
        await env.DB.prepare(
          `UPDATE upload_slots SET label = ?, file_name = ?, image_type = ?, garment_json = ?, needs_review = ?,
             expected_width = ?, expected_height = ?, require_alpha = ?, updated_at = ? WHERE id = ?`,
        )
          .bind(str(it.label, 120), str(it.file_name, 200), imageType, garmentJson, it.needs_review ? 1 : 0, ew, eh, requireAlpha ? 1 : 0, now, existing.id)
          .run();
      }
      touched.push(existing.id);
      continue;
    }
    const legacy = await env.DB.prepare("SELECT id FROM import_jobs WHERE batch_id = ? AND client_key = ?").bind(bid, key).first();
    if (legacy) throw new HttpError(409, "client_key_in_use", `client_key「${key}」已在此批次的舊流程使用，請換一個`);
    const id = newId("slt");
    await env.DB.prepare(
      `INSERT INTO upload_slots (id, batch_id, position, client_key, label, file_name, image_type, garment_id, garment_json, needs_review,
         expected_width, expected_height, require_alpha, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`,
    )
      .bind(id, bid, pos++, key, str(it.label, 120), str(it.file_name, 200), imageType, newId("gar"), garmentJson, it.needs_review ? 1 : 0, ew, eh, requireAlpha ? 1 : 0, now, now)
      .run();
    touched.push(id);
  }

  // ── 需要連結的槽 ──
  const all = await slotsForBatch(env, bid);
  const scope = items.length ? all.filter((s) => touched.includes(s.id)) : all;
  const open = scope.filter((s) => !FINISHED.has(s.status));
  if (open.length > MAX_RENEW_ITEMS) throw new HttpError(400, "too_many_items", `未完成的項目超過 ${MAX_RENEW_ITEMS} 件，請分批`);

  let link: { url: string; put_base: string; expires_at: string; token: string } | null = null;
  if (open.length) {
    const maxMinutes = intVar(env.UPLOAD_LINK_MAX_MINUTES, 1440);
    const minutes = Math.min(Math.max(Number(input.minutes) || 180, 5), maxMinutes);
    const raw = randomToken(24);
    const hash = await sha256Hex(raw);
    const expires = new Date(Date.now() + minutes * 60_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO upload_tickets (token_hash, batch_id, targets, expires_at, max_files, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
    )
      .bind(hash, bid, "[]", expires, open.length * (MAX_ATTEMPTS + 2), `${actor.kind}:${actor.id}`, nowIso())
      .run();
    await env.DB.batch(open.map((s) => env.DB.prepare("UPDATE upload_slots SET ticket_hash = ?, updated_at = ? WHERE id = ?").bind(hash, nowIso(), s.id)));
    link = { url: `${origin}/u/${raw}`, put_base: `${origin}/api/upload/${raw}`, expires_at: expires, token: raw };
  }
  await recomputeBatch(env, bid);
  await audit(env, actor, "upload_session.create", bid, { items: items.length, open: open.length });

  const fresh = await slotsForBatch(env, bid);
  const view = (items.length ? fresh.filter((s) => touched.includes(s.id)) : fresh).map((s) => slotView(s, link?.put_base));
  return {
    batch_id: bid,
    client_ref: batch.client_ref ?? null,
    upload_page_url: link?.url ?? null,
    expires_at: link?.expires_at ?? null,
    summary: summarize(fresh),
    slots: view,
    _token: link?.token ?? null,
  };
}

export async function getUploadSession(env: Env, batchId: string) {
  const batch = await env.DB.prepare("SELECT * FROM import_batches WHERE id = ?").bind(batchId).first<Record<string, unknown>>();
  if (!batch) throw new HttpError(404, "batch_not_found", "找不到這個匯入批次");
  const slots = await slotsForBatch(env, batchId);
  return { batch, summary: summarize(slots), slots: slots.map((s) => slotView(s)) };
}

async function failSlot(env: Env, slot: SlotRow, message: string) {
  await env.DB.prepare("UPDATE upload_slots SET status = 'failed', lock_until = NULL, error_message = ?, updated_at = ? WHERE id = ?")
    .bind(message.slice(0, 500), nowIso(), slot.id)
    .run();
  await recomputeBatch(env, slot.batch_id);
}

/**
 * 核心：收到一個槽的原始二進位圖片。
 * 冪等：同一槽重傳同一張圖會回傳原結果；失敗後可以用同一網址重試。
 */
export async function ingestSlot(env: Env, slotId: string, bytes: Uint8Array, actor: Actor) {
  const slot = await env.DB.prepare("SELECT * FROM upload_slots WHERE id = ?").bind(slotId).first<SlotRow>();
  if (!slot) throw new HttpError(404, "slot_not_found", "找不到這個上傳項目");
  if (bytes.byteLength === 0) throw new HttpError(400, "empty_file", "檔案是空的");
  if (bytes.byteLength > maxUploadBytes(env)) throw new HttpError(413, "file_too_large", `檔案超過 ${intVar(env.MAX_UPLOAD_MB, 25)} MB 上限`);
  const sha = await sha256Hex(bytes);

  // 已完成：同一張圖 → 冪等回應；不同圖 → 拒絕覆蓋
  if (FINISHED.has(slot.status)) {
    if (slot.sha256 === sha) return { ...slotView(slot), deduplicated: slot.status === "duplicate", repeated: true, warnings: [] as string[] };
    throw new HttpError(409, "slot_already_done", "此項目已完成匯入；如要更換圖片，請在 App 內處理或建立新項目");
  }

  // 取得鎖（防止同時上傳同一槽）
  const now = nowIso();
  const lock = new Date(Date.now() + LOCK_MS).toISOString();
  const claim = await env.DB.prepare(
    `UPDATE upload_slots SET status = 'uploading', lock_until = ?, attempts = attempts + 1, error_message = NULL, updated_at = ?
     WHERE id = ? AND attempts < ? AND (status IN ('pending','failed') OR (status = 'uploading' AND lock_until < ?))`,
  )
    .bind(lock, now, slot.id, MAX_ATTEMPTS, now)
    .run();
  if (!claim.meta.changes) {
    if (slot.attempts >= MAX_ATTEMPTS) throw new HttpError(429, "too_many_attempts", "此項目重試次數過多，請建立新的上傳工作階段");
    throw new HttpError(409, "slot_busy", "此項目正在上傳中，請稍後再試");
  }

  // ── 驗證（不信任副檔名／Content-Type）──
  let info;
  const warnings: string[] = [];
  try {
    info = parseImage(bytes);
    if (slot.image_type === "processed" && info.mime === "image/jpeg") {
      throw new HttpError(415, "jpeg_not_allowed", "去背圖必須是 PNG 或 WebP（JPEG 沒有透明背景）");
    }
    if (slot.expected_width && slot.expected_height && (info.width !== slot.expected_width || info.height !== slot.expected_height)) {
      throw new HttpError(
        422,
        "resolution_mismatch",
        `收到 ${info.width}×${info.height}，預期 ${slot.expected_width}×${slot.expected_height}：圖片可能在傳送途中被縮小或轉檔，請改用原檔上傳`,
      );
    }
    if (slot.require_alpha && !info.hasAlpha) {
      throw new HttpError(422, "no_alpha", "此去背圖沒有透明通道（可能已被轉成 JPEG 或加上背景），請上傳原本的透明 PNG／WebP");
    }
  } catch (err) {
    await failSlot(env, slot, err instanceof HttpError ? err.message : "圖片驗證失敗");
    throw err;
  }
  if (info.width * info.height < LOW_RES_PIXELS) warnings.push(`解像度偏低（${info.width}×${info.height}）`);

  // ── 去重：整個衣櫃已有同一張圖 ──
  const dup = await env.DB.prepare("SELECT garment_id FROM garment_images WHERE sha256 = ? AND image_type = ? LIMIT 1")
    .bind(sha, slot.image_type)
    .first<{ garment_id: string }>();
  if (dup) {
    await env.DB.prepare(
      `UPDATE upload_slots SET status = 'duplicate', duplicate_of = ?, sha256 = ?, mime_type = ?, width = ?, height = ?, file_size = ?, has_alpha = ?,
         lock_until = NULL, error_message = '衣櫃已有同一張圖片，未重複建立', updated_at = ? WHERE id = ?`,
    )
      .bind(dup.garment_id, sha, info.mime, info.width, info.height, bytes.byteLength, info.hasAlpha ? 1 : 0, nowIso(), slot.id)
      .run();
    await recomputeBatch(env, slot.batch_id);
    await audit(env, actor, "slot.duplicate", slot.id, { garment_id: dup.garment_id });
    const fresh = (await env.DB.prepare("SELECT * FROM upload_slots WHERE id = ?").bind(slot.id).first<SlotRow>())!;
    return { ...slotView(fresh), deduplicated: true, repeated: false, warnings };
  }

  // ── 1. 先寫 R2（原檔原樣，R2 以 SHA-256 校驗）──
  const imageId = newId("img");
  const dir = slot.image_type === "original" ? "originals" : "processed";
  const key = `${dir}/${slot.garment_id}/${imageId}.${info.ext}`;
  try {
    const obj = await env.IMAGES.put(key, bytes, {
      httpMetadata: { contentType: info.mime, cacheControl: "private, max-age=31536000, immutable" },
      customMetadata: { sha256: sha, owner: "garment", owner_id: slot.garment_id, image_type: slot.image_type, slot_id: slot.id },
      sha256: sha,
    });
    if (!obj || obj.size !== bytes.byteLength) throw new Error(`R2 size mismatch ${obj?.size} != ${bytes.byteLength}`);
  } catch (err) {
    console.error("R2 put failed", key, err);
    await env.IMAGES.delete(key).catch(() => {});
    await failSlot(env, slot, "圖片儲存（R2）失敗，請重試");
    throw new HttpError(502, "r2_write_failed", "圖片儲存（R2）失敗，請用同一網址重試");
  }

  // ── 2. R2 成功後，才在同一個 D1 transaction 建立衣物、圖片及匯入記錄 ──
  const batch = await env.DB.prepare("SELECT source FROM import_batches WHERE id = ?").bind(slot.batch_id).first<{ source: string }>();
  const g = (() => {
    try {
      return JSON.parse(slot.garment_json) as GarmentInput;
    } catch {
      return {} as GarmentInput;
    }
  })();
  const { values, uncertain } = normalizeGarment(g, false);
  const needsReview = slot.needs_review === 1 || Boolean(g.needs_review) || uncertain.length > 0 || warnings.length > 0;
  const status = (values.status as string) || (needsReview ? "review" : "active");
  const jobId = newId("job");
  const t = nowIso();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO garments (id, name, category, subcategory, brand, style, primary_color, secondary_colors, pattern, season, notes,
           status, is_favorite, uncertain_fields, ai_note, source, client_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        slot.garment_id,
        values.name ?? "未命名衣物",
        values.category ?? null,
        values.subcategory ?? null,
        values.brand ?? null,
        values.style ?? null,
        values.primary_color ?? null,
        values.secondary_colors ?? null,
        values.pattern ?? null,
        values.season ?? null,
        values.notes ?? null,
        status,
        values.is_favorite ?? 0,
        uncertain.length ? JSON.stringify(uncertain) : null,
        values.ai_note ?? null,
        batch?.source ?? actor.label,
        `slot:${slot.id}`,
        t,
        t,
      ),
      env.DB.prepare(
        `INSERT INTO garment_images (id, garment_id, image_type, r2_key, mime_type, width, height, file_size, sha256, has_alpha, is_primary, derived_from, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,NULL,?)`,
      ).bind(imageId, slot.garment_id, slot.image_type, key, info.mime, info.width, info.height, bytes.byteLength, sha, info.hasAlpha ? 1 : 0, t),
      env.DB.prepare(
        `INSERT INTO import_jobs (id, batch_id, client_key, kind, image_id, garment_id, label, status, error_message, created_at, updated_at)
         VALUES (?,?,?, 'garment', ?,?,?,?,?,?,?)`,
      ).bind(jobId, slot.batch_id, slot.client_key, imageId, slot.garment_id, slot.label ?? values.name ?? null, status === "review" ? "review" : "done", warnings.join("；") || null, t, t),
      env.DB.prepare(
        `UPDATE upload_slots SET status = 'done', lock_until = NULL, error_message = NULL, image_id = ?, r2_key = ?, sha256 = ?, mime_type = ?,
           width = ?, height = ?, file_size = ?, has_alpha = ?, job_id = ?, updated_at = ? WHERE id = ?`,
      ).bind(imageId, key, sha, info.mime, info.width, info.height, bytes.byteLength, info.hasAlpha ? 1 : 0, jobId, t, slot.id),
    ]);
  } catch (err) {
    console.error("D1 write failed after R2 put; rolling back", key, err);
    await env.IMAGES.delete(key).catch((e) => console.error("compensation delete failed", key, e));
    await failSlot(env, slot, "資料庫寫入失敗，圖片已回滾，請重試");
    throw new HttpError(500, "db_write_failed", "資料庫寫入失敗，圖片已回滾，請用同一網址重試");
  }
  if (slot.ticket_hash) {
    await env.DB.prepare("UPDATE upload_tickets SET used_files = used_files + 1 WHERE token_hash = ?").bind(slot.ticket_hash).run();
  }
  await recomputeBatch(env, slot.batch_id);
  await audit(env, actor, "slot.upload", slot.id, { garment_id: slot.garment_id, image_id: imageId, w: info.width, h: info.height, size: bytes.byteLength });
  const fresh = (await env.DB.prepare("SELECT * FROM upload_slots WHERE id = ?").bind(slot.id).first<SlotRow>())!;
  return { ...slotView(fresh), deduplicated: false, repeated: false, warnings };
}

/** 讀取原始二進位 body（拒絕 Base64 JSON／表單以外的格式） */
async function readBinary(req: Request, env: Env): Promise<Uint8Array> {
  const limit = maxUploadBytes(env);
  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > limit) throw new HttpError(413, "file_too_large", "檔案超過上傳上限");
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (ctype.startsWith("application/json") || ctype.startsWith("text/")) {
    throw new HttpError(415, "json_upload_not_allowed", "請以原始二進位上傳圖片（Content-Type: image/png 或 image/webp），不接受 Base64／JSON");
  }
  if (ctype.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const f = form.get("file");
    if (!f || typeof f === "string") throw new HttpError(400, "no_file", "找不到上傳檔案（欄位名稱應為 file）");
    const b = new Uint8Array(await (f as File).arrayBuffer());
    if (b.byteLength > limit) throw new HttpError(413, "file_too_large", "檔案超過上傳上限");
    return b;
  }
  const b = new Uint8Array(await req.arrayBuffer());
  if (b.byteLength > limit) throw new HttpError(413, "file_too_large", "檔案超過上傳上限");
  return b;
}

/**
 * 公開短效網址（不需登入，憑網址中的一次性權杖）：
 *   GET  /api/upload/{token}                     → 狀態
 *   PUT  /api/upload/{token}/{slot_id}           → 上傳原始二進位（curl --upload-file 可用）
 *   PUT  /api/upload/{token}/{slot_id}/thumbnail → 上傳頁產生的縮圖
 * 跨網域的 PUT 需要 CORS preflight，而本 API 不回 CORS 標頭，所以惡意網頁無法代為上傳；
 * POST（multipart）則必須帶 X-Requested-With。
 */
export async function handleSlotUpload(req: Request, env: Env, token: string, slotId?: string, sub?: string): Promise<Response> {
  const ticket = await loadTicket(env, token);
  if (!slotId) {
    if (req.method !== "GET") throw new HttpError(405, "method_not_allowed", "不支援此方法");
    const { results } = await env.DB.prepare("SELECT * FROM upload_slots WHERE ticket_hash = ? ORDER BY position").bind(ticket.token_hash).all<SlotRow>();
    return json({
      batch_id: ticket.batch_id,
      expires_at: ticket.expires_at,
      summary: summarize(results),
      slots: results.map((s) => slotView(s)),
    });
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 405, headers: { allow: "PUT" } });
  if (req.method !== "PUT" && req.method !== "POST") throw new HttpError(405, "method_not_allowed", "請用 PUT 上傳原始二進位");
  if (req.method === "POST" && req.headers.get("x-requested-with") !== "ai-wardrobe") throw new HttpError(403, "csrf", "請求來源驗證失敗");
  const slot = await env.DB.prepare("SELECT * FROM upload_slots WHERE id = ? AND ticket_hash = ?").bind(slotId, ticket.token_hash).first<SlotRow>();
  if (!slot) throw new HttpError(404, "slot_not_found", "此連結沒有這個上傳項目");
  if (ticket.used_files >= ticket.max_files) throw new HttpError(429, "link_used_up", "此連結的上傳次數已用完，請要求 AI 重新產生");
  const bytes = await readBinary(req, env);
  const actor: Actor = { kind: "ticket", id: ticket.token_hash.slice(0, 12), scopes: new Set(["upload"]), label: "upload-link" };

  if (sub === "thumbnail") {
    if (slot.status !== "done") throw new HttpError(409, "slot_not_done", "主圖未完成，暫時不能上傳縮圖");
    const img = await storeImage(env, { owner: "garment", ownerId: slot.garment_id, imageType: "thumbnail", bytes, derivedFrom: slot.image_id, actor });
    return json(img, img.deduplicated ? 200 : 201);
  }
  const result = await ingestSlot(env, slot.id, bytes, actor);
  return json(result, result.deduplicated || result.repeated ? 200 : 201);
}

/** 只接受 https；串流讀取並限制大小（ChatGPT fileParams 的 download_url 用） */
export async function downloadHttps(urlStr: string, max: number): Promise<Uint8Array> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new HttpError(400, "bad_url", "圖片網址格式錯誤");
  }
  if (u.protocol !== "https:") throw new HttpError(400, "bad_url", "只接受 https 圖片網址");
  const res = await fetch(u.toString(), { redirect: "follow" });
  if (!res.ok || !res.body) throw new HttpError(502, "download_failed", `下載圖片失敗（HTTP ${res.status}）`);
  const declared = Number(res.headers.get("content-length") || "0");
  if (declared > max) throw new HttpError(413, "file_too_large", "圖片超過上傳上限");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new HttpError(413, "file_too_large", "圖片超過上傳上限");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * ChatGPT 檔案參數（openai/fileParams）路徑：
 * ChatGPT 把對話中的檔案以 {download_url, file_id, mime_type?, file_name?} 傳入，
 * 伺服器下載原檔 → 同一套 R2 先寫、D1 後寫流程。失敗的項目可用回傳的上傳頁補傳。
 */
export async function importGarmentFiles(
  env: Env,
  actor: Actor,
  origin: string,
  input: { batch_id?: unknown; client_ref?: unknown; source?: unknown; note?: unknown; items?: unknown; files?: unknown },
  fetcher: (url: string, max: number) => Promise<Uint8Array> = downloadHttps,
) {
  const files = (Array.isArray(input.files) ? input.files : input.files ? [input.files] : []) as FileRef[];
  let items = (Array.isArray(input.items) ? input.items : []) as SlotInput[];
  if (!files.length) throw new HttpError(400, "no_files", "沒有收到檔案；ChatGPT 只能傳送對話中的檔案，否則請改用 create_upload_session 的上傳連結");
  if (files.length > MAX_SESSION_ITEMS) throw new HttpError(400, "too_many_files", `每次最多 ${MAX_SESSION_ITEMS} 個檔案`);
  if (!items.length) items = files.map((f, i) => ({ client_key: str(f.file_name, 120) || `file-${i + 1}`, file_name: f.file_name }));

  // 檔案配對：先按檔名，餘下按次序
  const pairs = new Map<number, FileRef>();
  const usedFiles = new Set<number>();
  items.forEach((it, i) => {
    const want = baseName(it.file_name);
    if (!want) return;
    const fi = files.findIndex((f, j) => !usedFiles.has(j) && baseName(f.file_name) === want);
    if (fi >= 0) {
      pairs.set(i, files[fi]);
      usedFiles.add(fi);
    }
  });
  let next = 0;
  items.forEach((_, i) => {
    if (pairs.has(i)) return;
    while (next < files.length && usedFiles.has(next)) next++;
    if (next < files.length) {
      pairs.set(i, files[next]);
      usedFiles.add(next++);
    }
  });
  // 未提供 file_name 的項目，用實際檔名補上（方便之後在上傳頁補傳時配對）
  items = items.map((it, i) => (it.file_name || !pairs.get(i)?.file_name ? it : { ...it, file_name: pairs.get(i)!.file_name }));

  const session = await createUploadSession(env, actor, origin, { ...input, items });
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const key = str(items[i].client_key, 120)!;
    const slot = session.slots.find((s) => s.client_key === key)!;
    const file = pairs.get(i);
    if (FINISHED.has(slot.status)) {
      results.push({ client_key: key, ok: true, status: slot.status, garment_id: slot.garment_id, width: slot.width, height: slot.height, has_alpha: slot.has_alpha });
      continue;
    }
    if (!file || typeof file.download_url !== "string") {
      results.push({ client_key: key, ok: false, status: "pending", error: "沒有對應的檔案" });
      continue;
    }
    try {
      const bytes = await fetcher(file.download_url, maxUploadBytes(env));
      const r = await ingestSlot(env, slot.slot_id, bytes, actor);
      results.push({ client_key: key, ok: true, status: r.status, garment_id: r.garment_id, width: r.width, height: r.height, has_alpha: r.has_alpha, file_size: r.file_size, deduplicated: r.deduplicated, warnings: r.warnings });
    } catch (err) {
      const message = err instanceof HttpError ? `${err.message}（${err.code}）` : "匯入失敗";
      if (!(err instanceof HttpError)) console.error("importGarmentFiles item failed", key, err);
      // 下載失敗時槽仍是 pending；標為 failed 讓進度反映
      const cur = await env.DB.prepare("SELECT * FROM upload_slots WHERE id = ?").bind(slot.slot_id).first<SlotRow>();
      if (cur && cur.status === "pending") await failSlot(env, cur, message);
      results.push({ client_key: key, ok: false, status: "failed", error: message });
    }
  }
  const after = await getUploadSession(env, session.batch_id);
  return {
    batch_id: session.batch_id,
    summary: after.summary,
    results,
    retry_upload_page_url: results.some((r) => !r.ok) ? session.upload_page_url : null,
    expires_at: session.expires_at,
  };
}
