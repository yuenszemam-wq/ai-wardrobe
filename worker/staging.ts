/**
 * D1 暫存匯入：處理 import_staging 中已完整的項目。
 * 由 Worker 排程（每分鐘）呼叫；同一流程亦在測試中直接呼叫。
 *
 * 安全要點：
 * - 必須提供原檔 SHA-256，接回的位元組不符即拒絕（防止 Base64 被截斷或寫錯）。
 * - 之後完全沿用上傳槽流程：驗證格式／尺寸／透明 → 先寫 R2 → 成功後才寫 D1 衣物記錄。
 * - 處理完（無論成功或失敗）即清空暫存 Base64。
 */
import { maxUploadBytes } from "./images";
import { createUploadSession, ingestSlot } from "./uploads";
import { Actor, Env, HttpError, nowIso, sha256Hex } from "./util";

const STAGING_ORIGIN = "https://staging.invalid";
const STALE_MS = 24 * 3600_000;

interface StagingRow {
  id: number;
  client_ref: string;
  client_key: string;
  part_no: number;
  part_count: number;
  data: string;
  sha256: string | null;
  file_name: string | null;
  image_type: "original" | "processed";
  expected_width: number | null;
  expected_height: number | null;
  garment_json: string | null;
  source: string;
}

function decodeBase64(input: string): Uint8Array {
  const b64 = input
    .replace(/^data:[^;,]+;base64,/, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new HttpError(400, "bad_base64", "Base64 格式錯誤（可能被截斷）");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function finish(env: Env, ref: string, key: string, status: string, fields: { error?: string | null; garment_id?: string | null; batch_id?: string | null }) {
  await env.DB.prepare(
    `UPDATE import_staging SET status = ?, error_message = ?, garment_id = ?, batch_id = ?, data = '', processed_at = ?
     WHERE client_ref = ? AND client_key = ?`,
  )
    .bind(status, fields.error ?? null, fields.garment_id ?? null, fields.batch_id ?? null, nowIso(), ref, key)
    .run();
}

export async function processStaging(env: Env, limit = 10) {
  const actor: Actor = { kind: "ticket", id: "d1-staging", scopes: new Set(["import", "upload"]), label: "d1-staging" };
  const summary: { client_ref: string; client_key: string; status: string; error?: string; garment_id?: string | null }[] = [];

  // 已收齊所有分段的項目
  const { results: groups } = await env.DB.prepare(
    `SELECT client_ref, client_key, MAX(part_count) AS part_count, COUNT(*) AS parts, MIN(id) AS first_id
     FROM import_staging WHERE status = 'pending'
     GROUP BY client_ref, client_key
     HAVING COUNT(*) >= MAX(part_count)
     ORDER BY first_id LIMIT ?`,
  )
    .bind(limit)
    .all<{ client_ref: string; client_key: string; part_count: number; parts: number }>();

  for (const g of groups) {
    // 鎖定：pending → processing（避免兩次排程重疊處理）
    const claim = await env.DB.prepare(
      "UPDATE import_staging SET status = 'processing' WHERE client_ref = ? AND client_key = ? AND status = 'pending'",
    )
      .bind(g.client_ref, g.client_key)
      .run();
    if (!claim.meta.changes) continue;

    let batchId: string | null = null;
    try {
      const { results: rows } = await env.DB.prepare(
        "SELECT * FROM import_staging WHERE client_ref = ? AND client_key = ? ORDER BY part_no",
      )
        .bind(g.client_ref, g.client_key)
        .all<StagingRow>();
      const count = rows[0].part_count;
      if (rows.length !== count || rows.some((r, i) => r.part_no !== i + 1 || r.part_count !== count)) {
        throw new HttpError(400, "bad_parts", `分段不正確：應有 1–${count} 段，收到 ${rows.map((r) => r.part_no).join(",")}`);
      }
      const meta = rows[0];
      const expectedSha = (rows.find((r) => r.sha256)?.sha256 || "").trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new HttpError(400, "missing_sha256", "必須提供原檔的 SHA-256（64 位十六進位）");

      const bytes = decodeBase64(rows.map((r) => r.data).join(""));
      if (bytes.byteLength > maxUploadBytes(env)) throw new HttpError(413, "file_too_large", "檔案超過上傳上限");
      const actual = await sha256Hex(bytes);
      if (actual !== expectedSha) {
        throw new HttpError(422, "sha256_mismatch", `SHA-256 不符：收到 ${bytes.byteLength} bytes，雜湊 ${actual.slice(0, 12)}…，預期 ${expectedSha.slice(0, 12)}…；資料可能被截斷或寫錯`);
      }

      let garment: Record<string, unknown> = {};
      if (meta.garment_json) {
        try {
          garment = JSON.parse(meta.garment_json);
        } catch {
          throw new HttpError(400, "bad_garment_json", "garment_json 不是有效的 JSON");
        }
      }
      const session = await createUploadSession(env, actor, STAGING_ORIGIN, {
        client_ref: meta.client_ref,
        source: meta.source || "chatgpt",
        note: "經 D1 暫存匯入",
        items: [
          {
            client_key: meta.client_key,
            file_name: meta.file_name,
            image_type: meta.image_type,
            expected_width: meta.expected_width,
            expected_height: meta.expected_height,
            garment,
          },
        ],
      });
      batchId = session.batch_id;
      const result = await ingestSlot(env, session.slots[0].slot_id, bytes, actor);
      await finish(env, g.client_ref, g.client_key, result.status === "duplicate" ? "duplicate" : "done", {
        garment_id: result.garment_id,
        batch_id: batchId,
        error: result.status === "duplicate" ? "衣櫃已有同一張圖片，未重複建立" : null,
      });
      summary.push({ client_ref: g.client_ref, client_key: g.client_key, status: result.status, garment_id: result.garment_id });
    } catch (err) {
      const message = err instanceof HttpError ? `${err.message}（${err.code}）` : "處理失敗";
      if (!(err instanceof HttpError)) console.error("staging failed", g.client_ref, g.client_key, err);
      await finish(env, g.client_ref, g.client_key, "failed", { error: message, batch_id: batchId });
      summary.push({ client_ref: g.client_ref, client_key: g.client_key, status: "failed", error: message });
    }
  }

  // 超過 24 小時仍未收齊分段 → 失敗並清空
  const stale = new Date(Date.now() - STALE_MS).toISOString();
  await env.DB.prepare(
    `UPDATE import_staging SET status = 'failed', error_message = '24 小時內未收齊所有分段', data = '', processed_at = ?
     WHERE status = 'pending' AND created_at < ?`,
  )
    .bind(nowIso(), stale)
    .run();
  // 處理中途 Worker 中斷 → 10 分鐘後重設為 pending（資料仍在）
  await env.DB.prepare(
    "UPDATE import_staging SET status = 'pending' WHERE status = 'processing' AND data != '' AND created_at < ?",
  )
    .bind(new Date(Date.now() - 600_000).toISOString())
    .run();

  return summary;
}
