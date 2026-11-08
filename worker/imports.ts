import { createGarment, GarmentInput } from "./garments";
import { StoredImage } from "./images";
import { Actor, Env, HttpError, audit, intVar, newId, nowIso, randomToken, sha256Hex, str } from "./util";

export interface ImportItemInput {
  client_key?: unknown;
  kind?: unknown; // garment | outfit
  label?: unknown;
  garment?: GarmentInput;
  outfit?: { name?: unknown; notes?: unknown; style?: unknown };
  needs_review?: unknown;
  // 允許直接把衣物欄位放在 item 第一層
  [k: string]: unknown;
}

export async function createBatch(env: Env, actor: Actor, input: { source?: unknown; note?: unknown; client_ref?: unknown }) {
  const source = str(input.source, 40) || (actor.kind === "session" ? "app" : actor.label);
  const clientRef = str(input.client_ref, 120);
  if (clientRef) {
    const existing = await env.DB.prepare("SELECT * FROM import_batches WHERE client_ref = ?").bind(clientRef).first<Record<string, unknown>>();
    if (existing) return { batch: existing, resumed: true };
  }
  const id = newId("bat");
  const now = nowIso();
  await env.DB.prepare(
    "INSERT INTO import_batches (id, source, note, client_ref, status, created_at, updated_at) VALUES (?,?,?,?, 'open', ?, ?)",
  )
    .bind(id, source, str(input.note, 500), clientRef, now, now)
    .run();
  await audit(env, actor, "batch.create", id, { source });
  const batch = await env.DB.prepare("SELECT * FROM import_batches WHERE id = ?").bind(id).first();
  return { batch, resumed: false };
}

async function requireOpenBatch(env: Env, id: string) {
  const b = await env.DB.prepare("SELECT * FROM import_batches WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!b) throw new HttpError(404, "batch_not_found", "找不到這個匯入批次");
  return b;
}

/** 逐項建立；單項失敗不影響其他項目。重複的 client_key 會回傳原有記錄。 */
export async function addItems(env: Env, actor: Actor, batchId: string, items: ImportItemInput[]) {
  const batch = await requireOpenBatch(env, batchId);
  if (batch.status !== "open") throw new HttpError(409, "batch_finalized", "此批次已完成，請建立新批次");
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, "no_items", "items 不可為空");
  if (items.length > 30) throw new HttpError(400, "too_many_items", "每次最多 30 項，請分批加入");

  const source = String(batch.source || "api");
  const results: Record<string, unknown>[] = [];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx] || {};
    const clientKey = str(item.client_key, 120) || `item-${idx + 1}`;
    try {
      const existing = await env.DB.prepare("SELECT * FROM import_jobs WHERE batch_id = ? AND client_key = ?")
        .bind(batchId, clientKey)
        .first<Record<string, unknown>>();
      if (existing) {
        results.push({ client_key: clientKey, ok: true, deduplicated: true, job_id: existing.id, garment_id: existing.garment_id, outfit_id: existing.outfit_id, status: existing.status });
        continue;
      }
      const kind = item.kind === "outfit" ? "outfit" : "garment";
      const jobId = newId("job");
      const now = nowIso();
      let garmentId: string | null = null;
      let outfitId: string | null = null;
      const label = str(item.label, 120);

      if (kind === "garment") {
        const g: GarmentInput = { ...(item.garment ?? stripMeta(item)) };
        if (item.needs_review) g.needs_review = true;
        const created = await createGarment(env, actor, g, { source, clientKey: `${batchId}:${clientKey}` });
        garmentId = created.id;
      } else {
        // 真人穿搭照：先保存為整套穿搭並要求人工覆核，不假裝已拆成單品
        outfitId = newId("out");
        const o = item.outfit ?? {};
        await env.DB.prepare(
          "INSERT INTO outfits (id, name, notes, style, status, source, created_at, updated_at) VALUES (?,?,?,?, 'review', ?, ?, ?)",
        )
          .bind(outfitId, str(o.name, 120) || label || "待整理穿搭", str(o.notes, 2000), str(o.style, 40), source, now, now)
          .run();
      }
      await env.DB.prepare(
        `INSERT INTO import_jobs (id, batch_id, client_key, kind, garment_id, outfit_id, label, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'awaiting_image', ?, ?)`,
      )
        .bind(jobId, batchId, clientKey, kind, garmentId, outfitId, label, now, now)
        .run();
      results.push({ client_key: clientKey, ok: true, deduplicated: false, job_id: jobId, garment_id: garmentId, outfit_id: outfitId, status: "awaiting_image" });
    } catch (err) {
      const message = err instanceof HttpError ? err.message : "建立失敗";
      console.error("addItems item failed", clientKey, err);
      results.push({ client_key: clientKey, ok: false, error: message });
    }
  }
  await recomputeBatch(env, batchId);
  return results;
}

function stripMeta(item: ImportItemInput): GarmentInput {
  const { client_key, kind, label, garment, outfit, ...rest } = item;
  void client_key; void kind; void label; void garment; void outfit;
  return rest as GarmentInput;
}

/** 圖片成功寫入後，更新相關匯入工作狀態 */
export async function onImageStored(env: Env, img: StoredImage, jobId?: string | null) {
  if (img.image_type === "thumbnail") return;
  const col = img.owner === "garment" ? "garment_id" : "outfit_id";
  const jobs = jobId
    ? (await env.DB.prepare("SELECT * FROM import_jobs WHERE id = ?").bind(jobId).all<Record<string, unknown>>()).results
    : (await env.DB.prepare(`SELECT * FROM import_jobs WHERE ${col} = ? AND status IN ('awaiting_image','failed')`).bind(img.owner_id).all<Record<string, unknown>>()).results;
  for (const job of jobs) {
    let status = "done";
    let error: string | null = null;
    if (img.warnings.length) {
      status = "review";
      error = img.warnings.join("；");
    }
    if (img.owner === "outfit") status = "review";
    else {
      const g = await env.DB.prepare("SELECT status FROM garments WHERE id = ?").bind(img.owner_id).first<{ status: string }>();
      if (g?.status === "review") status = "review";
    }
    // 已完成的項目再加附加圖片時不要改動狀態
    if (job.status === "done" && !img.warnings.length) continue;
    await env.DB.prepare("UPDATE import_jobs SET status = ?, image_id = COALESCE(image_id, ?), error_message = ?, updated_at = ? WHERE id = ?")
      .bind(status, img.id, error, nowIso(), job.id)
      .run();
    await recomputeBatch(env, String(job.batch_id));
  }
}

export async function failJob(env: Env, jobId: string, message: string) {
  const job = await env.DB.prepare("SELECT batch_id FROM import_jobs WHERE id = ?").bind(jobId).first<{ batch_id: string }>();
  if (!job) return;
  await env.DB.prepare("UPDATE import_jobs SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ? AND status != 'done'")
    .bind(message.slice(0, 500), nowIso(), jobId)
    .run();
  await recomputeBatch(env, job.batch_id);
}

export async function recomputeBatch(env: Env, batchId: string) {
  await env.DB.prepare(
    `UPDATE import_batches SET
       total_images    = (SELECT COUNT(*) FROM import_jobs WHERE batch_id = ?1)
                       + (SELECT COUNT(*) FROM upload_slots WHERE batch_id = ?1 AND job_id IS NULL),
       processed_count = (SELECT COUNT(*) FROM import_jobs WHERE batch_id = ?1 AND status != 'awaiting_image')
                       + (SELECT COUNT(*) FROM upload_slots WHERE batch_id = ?1 AND job_id IS NULL AND status IN ('failed','duplicate')),
       success_count   = (SELECT COUNT(*) FROM import_jobs WHERE batch_id = ?1 AND status = 'done')
                       + (SELECT COUNT(*) FROM upload_slots WHERE batch_id = ?1 AND job_id IS NULL AND status = 'duplicate'),
       review_count    = (SELECT COUNT(*) FROM import_jobs WHERE batch_id = ?1 AND status = 'review'),
       failed_count    = (SELECT COUNT(*) FROM import_jobs WHERE batch_id = ?1 AND status = 'failed')
                       + (SELECT COUNT(*) FROM upload_slots WHERE batch_id = ?1 AND job_id IS NULL AND status = 'failed'),
       updated_at = ?2
     WHERE id = ?1`,
  )
    .bind(batchId, nowIso())
    .run();
}

export async function finalizeBatch(env: Env, actor: Actor, batchId: string) {
  const batch = await requireOpenBatch(env, batchId);
  if (batch.status === "open") {
    await env.DB.prepare(
      "UPDATE import_jobs SET status = 'failed', error_message = '完成批次時仍未收到圖片', updated_at = ? WHERE batch_id = ? AND status = 'awaiting_image'",
    )
      .bind(nowIso(), batchId)
      .run();
    await env.DB.prepare(
      `UPDATE upload_slots SET status = 'failed', lock_until = NULL, error_message = '完成批次時仍未收到圖片', updated_at = ?
       WHERE batch_id = ? AND (status = 'pending' OR (status = 'uploading' AND lock_until < ?))`,
    )
      .bind(nowIso(), batchId, nowIso())
      .run();
    await recomputeBatch(env, batchId);
    await env.DB.prepare("UPDATE import_batches SET status = 'finalized', updated_at = ? WHERE id = ?").bind(nowIso(), batchId).run();
    await audit(env, actor, "batch.finalize", batchId);
  }
  return getBatch(env, batchId);
}

export async function getBatch(env: Env, batchId: string) {
  const batch = await requireOpenBatch(env, batchId);
  const { results: jobs } = await env.DB.prepare(
    `SELECT j.*, g.name AS garment_name, g.status AS garment_status, g.category, g.subcategory, g.style, g.uncertain_fields,
       o.name AS outfit_name,
       COALESCE(
         (SELECT t.id FROM garment_images t WHERE t.garment_id = j.garment_id AND t.image_type = 'thumbnail' ORDER BY t.created_at DESC LIMIT 1),
         (SELECT p.id FROM garment_images p WHERE p.garment_id = j.garment_id AND p.is_primary = 1 LIMIT 1),
         (SELECT oi.id FROM outfit_images oi WHERE oi.outfit_id = j.outfit_id ORDER BY oi.is_primary DESC LIMIT 1)
       ) AS preview_image_id
     FROM import_jobs j
     LEFT JOIN garments g ON g.id = j.garment_id
     LEFT JOIN outfits o ON o.id = j.outfit_id
     WHERE j.batch_id = ? ORDER BY j.created_at`,
  )
    .bind(batchId)
    .all();
  // 上傳槽：仍在等待圖片（或失敗、重複）的項目，尚未有 garments 記錄
  const { results: slots } = await env.DB.prepare(
    `SELECT id AS slot_id, position, client_key, label, file_name, image_type, status, attempts, error_message AS error,
       expected_width, expected_height, width, height, has_alpha, garment_id, duplicate_of, job_id
     FROM upload_slots WHERE batch_id = ? ORDER BY position`,
  )
    .bind(batchId)
    .all();
  return { batch, jobs, slots };
}

export async function listBatches(env: Env, limit = 30) {
  const { results } = await env.DB.prepare("SELECT * FROM import_batches ORDER BY created_at DESC LIMIT ?").bind(Math.min(limit, 100)).all();
  return results;
}

/** 覆核：approve → 正式入庫；reject → 刪除該衣物及圖片；retry → 重新等待圖片 */
export async function actOnJob(env: Env, actor: Actor, jobId: string, action: string) {
  const job = await env.DB.prepare("SELECT * FROM import_jobs WHERE id = ?").bind(jobId).first<Record<string, unknown>>();
  if (!job) throw new HttpError(404, "job_not_found", "找不到這個匯入項目");
  const now = nowIso();
  if (action === "approve") {
    if (job.garment_id) {
      await env.DB.prepare("UPDATE garments SET status = 'active', uncertain_fields = NULL, updated_at = ? WHERE id = ?").bind(now, job.garment_id).run();
    }
    if (job.outfit_id) {
      await env.DB.prepare("UPDATE outfits SET status = 'active', updated_at = ? WHERE id = ?").bind(now, job.outfit_id).run();
    }
    const hasImage = job.image_id || (job.garment_id
      ? await env.DB.prepare("SELECT 1 FROM garment_images WHERE garment_id = ? LIMIT 1").bind(job.garment_id).first()
      : await env.DB.prepare("SELECT 1 FROM outfit_images WHERE outfit_id = ? LIMIT 1").bind(job.outfit_id).first());
    if (!hasImage) throw new HttpError(409, "no_image", "此項目仍未有圖片，未能入庫");
    await env.DB.prepare("UPDATE import_jobs SET status = 'done', error_message = NULL, updated_at = ? WHERE id = ?").bind(now, jobId).run();
  } else if (action === "reject") {
    const keys: string[] = [];
    if (job.garment_id) {
      const { results } = await env.DB.prepare("SELECT r2_key FROM garment_images WHERE garment_id = ?").bind(job.garment_id).all<{ r2_key: string }>();
      keys.push(...results.map((r) => r.r2_key));
      await env.DB.prepare("DELETE FROM garments WHERE id = ?").bind(job.garment_id).run();
    }
    if (job.outfit_id) {
      const { results } = await env.DB.prepare("SELECT r2_key FROM outfit_images WHERE outfit_id = ?").bind(job.outfit_id).all<{ r2_key: string }>();
      keys.push(...results.map((r) => r.r2_key));
      await env.DB.prepare("DELETE FROM outfits WHERE id = ?").bind(job.outfit_id).run();
    }
    if (keys.length) await env.IMAGES.delete(keys);
    await env.DB.prepare("UPDATE import_jobs SET status = 'failed', error_message = '已由使用者拒絕', updated_at = ? WHERE id = ?").bind(now, jobId).run();
  } else if (action === "retry") {
    await env.DB.prepare(
      "UPDATE import_jobs SET status = 'awaiting_image', error_message = NULL, retry_count = retry_count + 1, updated_at = ? WHERE id = ?",
    )
      .bind(now, jobId)
      .run();
    await env.DB.prepare("UPDATE import_batches SET status = 'open', updated_at = ? WHERE id = ?").bind(now, job.batch_id).run();
  } else throw new HttpError(400, "bad_action", "action 只可以是 approve、reject、retry");
  await recomputeBatch(env, String(job.batch_id));
  await audit(env, actor, `job.${action}`, jobId);
  return { ok: true };
}

// ───────── 短效上傳連結 ─────────
export interface UploadTarget {
  garment_id?: string;
  outfit_id?: string;
  image_type: "original" | "processed";
  label: string;
}

export async function createUploadLink(
  env: Env,
  actor: Actor,
  origin: string,
  input: { batch_id?: unknown; garment_ids?: unknown; targets?: unknown; minutes?: unknown; image_type?: unknown },
) {
  const maxMinutes = intVar(env.UPLOAD_LINK_MAX_MINUTES, 1440);
  const minutes = Math.min(Math.max(Number(input.minutes) || 120, 5), maxMinutes);
  const defaultType = input.image_type === "original" ? "original" : "processed";
  const batchId = str(input.batch_id, 60);
  let targets: UploadTarget[] = [];

  if (Array.isArray(input.targets)) {
    targets = (input.targets as Record<string, unknown>[]).map((t) => ({
      garment_id: str(t.garment_id, 60) ?? undefined,
      outfit_id: str(t.outfit_id, 60) ?? undefined,
      image_type: t.image_type === "original" ? "original" : t.image_type === "processed" ? "processed" : defaultType,
      label: "",
    }));
  } else if (Array.isArray(input.garment_ids)) {
    targets = (input.garment_ids as unknown[]).map((id) => ({ garment_id: String(id), image_type: defaultType, label: "" }));
  } else if (batchId) {
    // 預設：該批次所有仍等待圖片或失敗的項目
    const { results } = await env.DB.prepare(
      "SELECT garment_id, outfit_id FROM import_jobs WHERE batch_id = ? AND status IN ('awaiting_image','failed') ORDER BY created_at",
    )
      .bind(batchId)
      .all<{ garment_id: string | null; outfit_id: string | null }>();
    targets = results.map((r) => ({ garment_id: r.garment_id ?? undefined, outfit_id: r.outfit_id ?? undefined, image_type: defaultType, label: "" }));
  }
  targets = targets.filter((t) => t.garment_id || t.outfit_id);
  if (!targets.length) throw new HttpError(400, "no_targets", "沒有需要上傳圖片的項目");
  if (targets.length > 40) throw new HttpError(400, "too_many_targets", "每條連結最多 40 張圖片");

  for (const t of targets) {
    const row = t.garment_id
      ? await env.DB.prepare("SELECT name FROM garments WHERE id = ?").bind(t.garment_id).first<{ name: string }>()
      : await env.DB.prepare("SELECT name FROM outfits WHERE id = ?").bind(t.outfit_id).first<{ name: string }>();
    if (!row) throw new HttpError(404, "target_not_found", `找不到 ${t.garment_id || t.outfit_id}`);
    t.label = row.name;
  }

  const raw = randomToken(24);
  const expires = new Date(Date.now() + minutes * 60_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO upload_tickets (token_hash, batch_id, targets, expires_at, max_files, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(await sha256Hex(raw), batchId, JSON.stringify(targets), expires, targets.length * 3, `${actor.kind}:${actor.id}`, nowIso())
    .run();
  await audit(env, actor, "upload_link.create", batchId ?? undefined, { count: targets.length, minutes });
  return { url: `${origin}/u/${raw}`, expires_at: expires, targets };
}

export async function loadTicket(env: Env, raw: string) {
  const row = await env.DB.prepare("SELECT * FROM upload_tickets WHERE token_hash = ?")
    .bind(await sha256Hex(raw))
    .first<{ token_hash: string; batch_id: string | null; targets: string; expires_at: string; max_files: number; used_files: number }>();
  if (!row) throw new HttpError(404, "link_invalid", "上傳連結無效");
  if (row.expires_at < nowIso()) throw new HttpError(410, "link_expired", "上傳連結已過期，請要求 AI 重新產生");
  return { ...row, targets: JSON.parse(row.targets) as UploadTarget[] };
}
