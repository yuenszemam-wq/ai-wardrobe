/**
 * Cutout Studio 去背圖來源關聯（migration 0017：cutout_edits）。
 * - 只記錄 metadata；圖片仍經 /api/images/upload 存入私人 R2。
 * - 未套用 migration 時：寫入回傳 recorded=false（去背圖照常保存），讀取回傳 null，不影響其他功能。
 */
import { Env, HttpError, nowIso } from "./util";

const missingTable = (e: unknown) => /no such table: cutout_edits/i.test(String((e as Error)?.message ?? e));

export interface CutoutEditInput {
  image_id?: unknown; source_image_id?: unknown; mask_width?: unknown; mask_height?: unknown; editor_version?: unknown; edit_summary?: unknown;
}

export async function recordCutoutEdit(env: Env, body: CutoutEditInput) {
  const imageId = String(body.image_id || ""), sourceId = String(body.source_image_id || "");
  if (!imageId || !sourceId) throw new HttpError(400, "bad_cutout_edit", "需要 image_id 及 source_image_id");
  const img = await env.DB.prepare("SELECT id, image_type, width, height FROM garment_images WHERE id = ?").bind(imageId).first<{ id: string; image_type: string; width: number; height: number }>();
  if (!img) throw new HttpError(404, "image_not_found", "找不到去背圖");
  if (img.image_type !== "processed") throw new HttpError(400, "bad_cutout_edit", "只可以為去背圖記錄來源");
  const src = await env.DB.prepare("SELECT id, image_type, width, height, sha256 FROM garment_images WHERE id = ?").bind(sourceId).first<{ id: string; image_type: string; width: number; height: number; sha256: string }>();
  if (!src) throw new HttpError(404, "source_not_found", "找不到原圖");
  if (src.image_type === "thumbnail") throw new HttpError(400, "bad_cutout_edit", "縮圖不能作為原圖");
  const mw = Math.round(Number(body.mask_width)), mh = Math.round(Number(body.mask_height));
  if (!(mw > 0 && mh > 0) || mw !== img.width || mh !== img.height) throw new HttpError(400, "bad_cutout_edit", "遮罩尺寸與去背圖不符");
  let summary: string | null = null;
  if (body.edit_summary && typeof body.edit_summary === "object") {
    summary = JSON.stringify(body.edit_summary).slice(0, 2000);
  }
  try {
    await env.DB.prepare(
      `INSERT INTO cutout_edits (image_id, source_image_id, source_sha256, source_width, source_height, mask_width, mask_height, editor_version, edit_summary, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(image_id) DO UPDATE SET source_image_id = excluded.source_image_id, source_sha256 = excluded.source_sha256,
         source_width = excluded.source_width, source_height = excluded.source_height, mask_width = excluded.mask_width,
         mask_height = excluded.mask_height, editor_version = excluded.editor_version, edit_summary = excluded.edit_summary`,
    ).bind(imageId, sourceId, src.sha256, src.width, src.height, mw, mh, Math.max(1, Math.round(Number(body.editor_version) || 1)), summary, nowIso()).run();
    return { recorded: true };
  } catch (e) {
    if (missingTable(e)) return { recorded: false, note: "資料庫未套用 migration 0017，來源關聯未記錄（去背圖已保存）" };
    throw e;
  }
}

export async function getCutoutEdit(env: Env, imageId: string) {
  try {
    const row = await env.DB.prepare(
      `SELECT c.image_id, c.source_image_id, c.source_sha256, c.source_width, c.source_height, c.mask_width, c.mask_height, c.editor_version, c.created_at,
              s.garment_id AS source_garment_id, s.sha256 AS current_source_sha256
       FROM cutout_edits c LEFT JOIN garment_images s ON s.id = c.source_image_id WHERE c.image_id = ?`,
    ).bind(imageId).first<Record<string, unknown>>();
    if (!row) return { edit: null };
    return { edit: { ...row, source_intact: row.source_image_id ? row.current_source_sha256 === row.source_sha256 : false } };
  } catch (e) {
    if (missingTable(e)) return { edit: null, note: "migration 0017 未套用" };
    throw e;
  }
}
