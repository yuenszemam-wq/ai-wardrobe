/**
 * Phase 3.9A.2：工作室素材（背景、裝飾、道具、配件、其他）。
 *
 * - 上傳：手機先解碼及壓縮（必要時 HEIC 轉 JPEG），伺服器再驗證 MIME、檔案大小及尺寸；原圖存 R2 studio/ 路徑，小縮圖存 D1。
 * - 素材版本：造型引用版本 ID；去背圖只可加入一次，重新去背會建立新版本（共用原圖檔案），已保存的造型不會改變。
 * - 「只用於目前造型」的素材 in_library＝0：不在「我的素材庫」顯示，也不會出現在衣櫃，不計入衣物數目、總價或穿著統計。
 * - 刪除：仍被造型或背景引用時只從素材庫移除（保留檔案）；沒有引用時才刪除版本紀錄，R2 檔案按引用清理（共用檔案保留）。
 * - 所有 R2 讀寫經 meteredBucket 計數（用途：studio_background／studio_asset）。
 */
import { parseImage, storeImage } from "./images";
import { BackgroundSpec, normalizeBackground } from "../shared/studioScene";
import { createGarment } from "./garments";
import { findOp, opStatements, validOpId } from "./ops";
import { drainPurge, queueStatements } from "./purge";
import { hasTable } from "./schema";
import { Actor, Env, HttpError, audit, newId, nowIso, sha256Hex, str } from "./util";

export const ASSET_KINDS = ["background", "decoration", "prop", "accessory", "other"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
const MAX_BYTES = 15 * 1024 * 1024, MAX_SIDE = 6000, MAX_THUMB = 64 * 1024;
const kindOf = (v: unknown): AssetKind | null => (ASSET_KINDS.includes(v as AssetKind) ? (v as AssetKind) : null);
const keyFor = (kind: AssetKind, assetId: string, verId: string, ext: string, cutout = false) => `studio/${kind === "background" ? "background/" : ""}${assetId}/${verId}${cutout ? "-cutout" : ""}.${ext}`;

interface AssetRow { id: string; kind: AssetKind; name: string; is_favorite: number; in_library: number; current_version_id: string | null; created_at: string; updated_at: string }
interface VersionRow { id: string; asset_id: string; r2_key: string; cutout_key: string | null; mime_type: string; width: number; height: number; file_size: number; sha256: string; has_alpha: number; created_at: string }

async function readImage(form: FormData | null, field: string, allowPngOnly = false) {
  const file = form?.get(field);
  if (!file || typeof file === "string") throw new HttpError(400, "no_file", "請選擇圖片");
  const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
  if (!bytes.byteLength) throw new HttpError(400, "empty_file", "檔案是空的");
  if (bytes.byteLength > MAX_BYTES) throw new HttpError(413, "file_too_large", "圖片太大（上限 15 MB）");
  const info = parseImage(bytes);
  if (!["image/png", "image/jpeg", "image/webp"].includes(info.mime) || (allowPngOnly && info.mime !== "image/png")) throw new HttpError(415, "bad_type", allowPngOnly ? "去背圖必須是 PNG" : "只接受 PNG、JPG 或 WebP（HEIC 會在手機先轉換）");
  if (!info.width || !info.height || info.width > MAX_SIDE || info.height > MAX_SIDE) throw new HttpError(400, "bad_size", `圖片尺寸不正確（最長邊 ${MAX_SIDE}px）`);
  return { bytes, info };
}
async function readThumb(form: FormData | null) {
  const t = form?.get("thumb");
  if (!t || typeof t === "string") return null;
  const bytes = new Uint8Array(await (t as Blob).arrayBuffer());
  if (bytes.byteLength > MAX_THUMB) throw new HttpError(413, "thumb_too_large", "縮圖太大");
  const mime = parseImage(bytes).mime;
  if (!["image/webp", "image/png", "image/jpeg"].includes(mime)) throw new HttpError(415, "bad_thumb", "縮圖格式不正確");
  return { bytes, mime };
}

/**
 * 引用：造型圖層、造型背景及角色造型（背景及角色造型以 JSON 保存，按素材 ID 搜尋）。
 * 查詢失敗會拋出錯誤（以前角色造型查詢失敗時當作「沒有引用」，可能誤刪仍在使用的素材）。
 */
export async function usage(env: Env, assetId: string) {
  const layers = (await env.DB.prepare("SELECT DISTINCT l.outfit_id AS id, o.name FROM outfit_layers l JOIN outfits o ON o.id = l.outfit_id WHERE l.asset_id = ?").bind(assetId).all<{ id: string; name: string }>()).results;
  const bgs = (await env.DB.prepare("SELECT id, name FROM outfits WHERE background LIKE ?").bind(`%"asset_id":"${assetId}"%`).all<{ id: string; name: string }>()).results;
  const looks = (await hasTable(env, "doll_looks")) ? (await env.DB.prepare("SELECT id, name FROM doll_looks WHERE state LIKE ?").bind(`%${assetId}%`).all<{ id: string; name: string }>()).results : [];
  const map = new Map<string, { id: string; name: string; kind: "outfit" | "look" | "preset" }>();
  for (const x of [...layers, ...bgs]) map.set("o" + x.id, { ...x, kind: "outfit" });
  for (const x of looks) map.set("l" + x.id, { ...x, kind: "look" });
  // Phase 3.9A.3：背景預設庫引用的圖片背景
  for (const p of (await readPresets(env)).filter((p) => p.spec.image?.asset_id === assetId)) map.set("p" + p.id, { id: p.id, name: p.name, kind: "preset" });
  return [...map.values()];
}

function shape(a: AssetRow, v: VersionRow | null, used?: number) {
  return { id: a.id, kind: a.kind, name: a.name, is_favorite: !!a.is_favorite, in_library: !!a.in_library, created_at: a.created_at, updated_at: a.updated_at,
    version: v ? { id: v.id, width: v.width, height: v.height, has_alpha: !!v.has_alpha, has_cutout: !!v.cutout_key, url: `/api/studio/versions/${v.id}`, cutout_url: v.cutout_key ? `/api/studio/versions/${v.id}?cutout=1` : null, thumb_url: `/api/studio/versions/${v.id}/thumb` } : null,
    ...(used !== undefined ? { used_by: used } : {}) };
}

export async function listAssets(env: Env, p: URLSearchParams) {
  const where = ["1=1"], args: unknown[] = [];
  if (p.get("library") !== "0") where.push("a.in_library = 1");
  const kind = kindOf(p.get("kind")); if (kind) { where.push("a.kind = ?"); args.push(kind); }
  if (p.get("favorite") === "1") where.push("a.is_favorite = 1");
  const q = p.get("q")?.trim(); if (q) { where.push("a.name LIKE ?"); args.push("%" + q.replace(/[%_]/g, "") + "%"); }
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM studio_assets a WHERE ${where.join(" AND ")}`).bind(...args).first<{ n: number }>())?.n ?? 0;
  // 分頁：cursor＝「updated_at|id」；回應附 total 及 next_cursor
  const cur = p.get("cursor")?.split("|");
  if (cur && cur.length === 2) { where.push("(a.updated_at < ? OR (a.updated_at = ? AND a.id < ?))"); args.push(cur[0], cur[0], cur[1]); }
  const limit = Math.min(300, Math.max(1, Number(p.get("limit")) || 300));
  const rows = (await env.DB.prepare(`SELECT a.* FROM studio_assets a WHERE ${where.join(" AND ")} ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`).bind(...args, limit + 1).all<AssetRow>()).results;
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const vids = page.map((r) => r.current_version_id).filter((x): x is string => !!x);
  const vers = new Map<string, VersionRow>();
  for (let i = 0; i < vids.length; i += 80) { const part = vids.slice(i, i + 80); for (const v of (await env.DB.prepare(`SELECT id, asset_id, r2_key, cutout_key, mime_type, width, height, file_size, sha256, has_alpha, created_at FROM studio_asset_versions WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<VersionRow>()).results) vers.set(v.id, v); }
  const used = await usageCounts(env, page.map((a) => a.id));
  return { assets: page.map((a) => shape(a, a.current_version_id ? vers.get(a.current_version_id) ?? null : null, used.get(a.id) ?? 0)), total, next_cursor: more && page.length ? `${page[page.length - 1].updated_at}|${page[page.length - 1].id}` : null };
}

/** 每個素材被多少個造型／角色造型使用（圖層＋背景＋角色造型） */
async function usageCounts(env: Env, ids: string[]): Promise<Map<string, number>> {
  const sets = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    for (const r of (await env.DB.prepare(`SELECT DISTINCT asset_id, outfit_id FROM outfit_layers WHERE asset_id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ asset_id: string; outfit_id: string }>()).results) sets.get(r.asset_id)?.add("o" + r.outfit_id);
  }
  const scan = (owner: string, text: string | null) => { for (const m of (text ?? "").matchAll(/sta_[a-z2-7]+/g)) sets.get(m[0])?.add(owner); };
  for (const r of (await env.DB.prepare("SELECT id, background FROM outfits WHERE background LIKE '%sta_%'").all<{ id: string; background: string | null }>()).results) scan("o" + r.id, r.background);
  if (await hasTable(env, "doll_looks")) for (const r of (await env.DB.prepare("SELECT id, state FROM doll_looks WHERE state LIKE '%sta_%'").all<{ id: string; state: string | null }>()).results) scan("l" + r.id, r.state);
  for (const p of await readPresets(env)) if (p.spec.image) sets.get(p.spec.image.asset_id)?.add("p" + p.id);
  return new Map([...sets].map(([k, v]) => [k, v.size]));
}

export async function getAsset(env: Env, id: string) {
  const a = await env.DB.prepare("SELECT * FROM studio_assets WHERE id = ?").bind(id).first<AssetRow>();
  if (!a) throw new HttpError(404, "asset_not_found", "找不到素材");
  const v = a.current_version_id ? await env.DB.prepare("SELECT * FROM studio_asset_versions WHERE id = ?").bind(a.current_version_id).first<VersionRow>() : null;
  return { ...shape(a, v), usage: await usage(env, id) };
}

/** 上傳新素材（建立素材及第一個版本） */
export async function createAsset(env: Env, actor: Actor, req: Request) {
  const form = await req.formData().catch(() => null);
  // 冪等：網絡在提交後中斷、App 重試同一次上傳（同一 op_id）＝取回第一次建立的素材，不會重複上傳
  const opId = validOpId(form?.get("op_id"));
  const done = await findOp(env, opId, "studio.asset_create");
  if (done && (await env.DB.prepare("SELECT id FROM studio_assets WHERE id = ?").bind(done).first())) return getAsset(env, done);
  const kind = kindOf(form?.get("kind")) ?? "decoration";
  const { bytes, info } = await readImage(form, "file");
  const thumb = await readThumb(form);
  const id = newId("sta"), vid = newId("stv"), now = nowIso();
  const name = str(form?.get("name"), 60) || "未命名素材";
  const inLib = form?.get("in_library") === "1" ? 1 : 0;
  const key = keyFor(kind, id, vid, info.ext);
  const sha = await sha256Hex(bytes);
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: info.mime } });
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO studio_assets (id, kind, name, is_favorite, in_library, current_version_id, created_at, updated_at) VALUES (?,?,?,0,?,?,?,?)").bind(id, kind, name, inLib, vid, now, now),
      env.DB.prepare("INSERT INTO studio_asset_versions (id, asset_id, r2_key, cutout_key, mime_type, width, height, file_size, sha256, has_alpha, thumb, thumb_mime, created_at) VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?)").bind(vid, id, key, info.mime, info.width, info.height, bytes.byteLength, sha, info.hasAlpha ? 1 : 0, thumb?.bytes ?? null, thumb?.mime ?? null, now),
      ...(await opStatements(env, opId, "studio.asset_create", id)),
    ]);
  } catch (e) { await env.IMAGES.delete(key).catch(() => undefined); throw e; }
  await audit(env, actor, "studio.asset_create", id, { kind });
  return getAsset(env, id);
}

/** 加入去背圖：版本未有去背圖時加入同一版本；已有時建立新版本（共用原圖），舊造型不受影響 */
export async function addCutout(env: Env, actor: Actor, req: Request, versionId: string) {
  const v = await env.DB.prepare("SELECT * FROM studio_asset_versions WHERE id = ?").bind(versionId).first<VersionRow & { thumb: ArrayBuffer | null; thumb_mime: string | null }>();
  if (!v) throw new HttpError(404, "version_not_found", "找不到素材版本");
  const a = await env.DB.prepare("SELECT * FROM studio_assets WHERE id = ?").bind(v.asset_id).first<AssetRow>();
  const form = await req.formData().catch(() => null);
  const { bytes, info } = await readImage(form, "file", true);
  if (!info.hasAlpha) throw new HttpError(400, "not_transparent", "去背圖沒有透明通道，未有保存");
  if (info.width !== v.width || info.height !== v.height) throw new HttpError(400, "size_mismatch", "去背圖尺寸與原圖不同");
  const thumb = await readThumb(form);
  // 每次去背都寫入新的檔案名稱（不可變）：兩部裝置同時去背不會互相覆蓋同一個 R2 檔案，快取亦不會混淆
  let target = v.cutout_key ? newId("stv") : v.id;
  const key = keyFor(a!.kind, v.asset_id, `${target}-${newId("c").slice(2, 10)}`, "png", true);
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  try {
    if (target === v.id) {
      const r = await env.DB.prepare("UPDATE studio_asset_versions SET cutout_key = ?, cutout_size = ? WHERE id = ? AND cutout_key IS NULL").bind(key, bytes.byteLength, v.id).run();
      // 另一個去背剛剛先完成：改為建立新版本（兩個結果都保留，不會遺失）
      if (!r.meta.changes) target = newId("stv");
    }
    if (target !== v.id) await env.DB.batch([
      env.DB.prepare("INSERT INTO studio_asset_versions (id, asset_id, r2_key, cutout_key, cutout_size, mime_type, width, height, file_size, sha256, has_alpha, thumb, thumb_mime, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(target, v.asset_id, v.r2_key, key, bytes.byteLength, v.mime_type, v.width, v.height, v.file_size, v.sha256, v.has_alpha, thumb?.bytes ?? v.thumb, thumb?.mime ?? v.thumb_mime, nowIso()),
      env.DB.prepare("UPDATE studio_assets SET current_version_id = ?, updated_at = ? WHERE id = ?").bind(target, nowIso(), v.asset_id),
    ]);
  } catch (e) { await env.IMAGES.delete(key).catch(() => undefined); throw e; }
  await audit(env, actor, "studio.cutout", v.asset_id, { version: target });
  return { version_id: target, cutout_url: `/api/studio/versions/${target}?cutout=1`, ...(await getAsset(env, v.asset_id)) };
}

export async function updateAsset(env: Env, actor: Actor, id: string, input: Record<string, unknown>) {
  const a = await env.DB.prepare("SELECT id FROM studio_assets WHERE id = ?").bind(id).first();
  if (!a) throw new HttpError(404, "asset_not_found", "找不到素材");
  const sets: string[] = [], args: unknown[] = [];
  if (typeof input.name === "string" && input.name.trim()) { sets.push("name = ?"); args.push(input.name.trim().slice(0, 60)); }
  if (input.kind !== undefined) { const k = kindOf(input.kind); if (!k) throw new HttpError(400, "bad_kind", "素材分類不正確"); sets.push("kind = ?"); args.push(k); }
  if (input.is_favorite !== undefined) { sets.push("is_favorite = ?"); args.push(input.is_favorite ? 1 : 0); }
  if (input.in_library !== undefined) { sets.push("in_library = ?"); args.push(input.in_library ? 1 : 0); }
  if (!sets.length) return getAsset(env, id);
  sets.push("updated_at = ?"); args.push(nowIso());
  await env.DB.prepare(`UPDATE studio_assets SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
  await audit(env, actor, "studio.asset_update", id);
  return getAsset(env, id);
}

/** 從素材庫刪除：仍被造型使用時只移出素材庫（保留檔案，舊造型不會缺圖） */
export async function deleteAsset(env: Env, actor: Actor, id: string) {
  const a = await env.DB.prepare("SELECT id FROM studio_assets WHERE id = ?").bind(id).first();
  if (!a) throw new HttpError(404, "asset_not_found", "找不到素材");
  const used = await usage(env, id);
  if (used.length) {
    await env.DB.prepare("UPDATE studio_assets SET in_library = 0, updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
    await audit(env, actor, "studio.asset_unlist", id, { used: used.length });
    return { deleted: false, removed_from_library: true, used_by: used };
  }
  const removed = await purgeAsset(env, id);
  await audit(env, actor, "studio.asset_delete", id, { files: removed });
  return { deleted: true, files_removed: removed };
}

/** 刪除素材及版本；R2 檔案只在沒有其他版本引用時刪除 */
async function purgeAsset(env: Env, id: string): Promise<number> {
  const vers = (await env.DB.prepare("SELECT r2_key, cutout_key FROM studio_asset_versions WHERE asset_id = ?").bind(id).all<{ r2_key: string; cutout_key: string | null }>()).results;
  const keys = [...new Set(vers.flatMap((v) => [v.r2_key, v.cutout_key]).filter((k): k is string => !!k))];
  // 紀錄刪除及清理佇列在同一個交易；R2 刪除失敗時檔案留在佇列，之後重試（drainPurge 刪除前會再核對引用）
  await env.DB.batch([env.DB.prepare("DELETE FROM studio_asset_versions WHERE asset_id = ?").bind(id), env.DB.prepare("DELETE FROM studio_assets WHERE id = ?").bind(id), ...(await queueStatements(env, keys, "studio_asset"))]);
  const r = await drainPurge(env, { keys });
  if (r.failed.length) console.warn("studio_purge_failed", r.failed.length);
  return r.deleted.length;
}
/** 造型刪除後：只用於該造型、而且已沒有任何引用的素材一併清理（素材庫內的素材保留） */
export async function purgeUnusedAssets(env: Env, ids: string[]) {
  for (const id of ids) {
    const a = await env.DB.prepare("SELECT in_library FROM studio_assets WHERE id = ?").bind(id).first<{ in_library: number }>();
    if (!a || a.in_library) continue;
    if ((await usage(env, id)).length) continue;
    await purgeAsset(env, id);
  }
}

export async function serveVersion(req: Request, env: Env, versionId: string, kind: "original" | "cutout" | "thumb"): Promise<Response> {
  const v = await env.DB.prepare(`SELECT r2_key, cutout_key, mime_type, sha256${kind === "thumb" ? ", thumb, thumb_mime" : ""} FROM studio_asset_versions WHERE id = ?`).bind(versionId).first<{ r2_key: string; cutout_key: string | null; mime_type: string; sha256: string; thumb?: ArrayBuffer | null; thumb_mime?: string | null }>();
  if (!v) throw new HttpError(404, "version_not_found", "找不到素材版本");
  const etag = `"${v.sha256.slice(0, 24)}-${kind}${kind === "cutout" ? "-" + (v.cutout_key ?? "").slice(-12) : ""}"`;
  const headers = (mime: string) => ({ "content-type": mime, "cache-control": "private, max-age=31536000, immutable", etag, "x-content-type-options": "nosniff" });
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: headers(v.mime_type) });
  if (kind === "thumb") {
    if (v.thumb) return new Response(new Uint8Array(v.thumb), { headers: headers(v.thumb_mime || "image/webp") });
    kind = v.cutout_key ? "cutout" : "original"; // 沒有小縮圖：退回原圖（只有很舊或上傳時縮圖失敗才會出現）
  }
  const key = kind === "cutout" ? v.cutout_key : v.r2_key;
  if (!key) throw new HttpError(404, "no_cutout", "這個素材未有去背圖");
  const obj = await env.IMAGES.get(key);
  if (!obj) throw new HttpError(404, "object_missing", "R2 找不到素材檔案");
  return new Response(obj.body, { headers: headers(kind === "cutout" ? "image/png" : v.mime_type) });
}

/** 使用者明確選擇「另存為衣櫃衣物」：建立新的正式衣物並複製圖片（原圖或去背圖） */
export async function versionToGarment(env: Env, actor: Actor, versionId: string, input: Record<string, unknown>) {
  const v = await env.DB.prepare("SELECT v.*, a.name AS asset_name FROM studio_asset_versions v JOIN studio_assets a ON a.id = v.asset_id WHERE v.id = ?").bind(versionId).first<VersionRow & { asset_name: string }>();
  if (!v) throw new HttpError(404, "version_not_found", "找不到素材版本");
  const cutout = input.variant === "cutout";
  const key = cutout ? v.cutout_key : v.r2_key;
  if (!key) throw new HttpError(400, "no_cutout", "這個素材未有去背圖");
  const obj = await env.IMAGES.get(key);
  if (!obj) throw new HttpError(404, "object_missing", "R2 找不到素材檔案");
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  const g = await createGarment(env, actor, { name: str(input.name, 120) || v.asset_name, category: str(input.category, 40) || "其他裝飾" }, { source: "studio" });
  const gid = g.id;
  await storeImage(env, { owner: "garment", ownerId: gid, imageType: cutout ? "processed" : "original", bytes, isPrimary: true, actor });
  await audit(env, actor, "studio.to_garment", gid, { version: versionId });
  return { garment_id: gid };
}

// ───── Phase 3.9A.3：背景預設庫（衣服配搭及角色換裝共用） ─────
// 保存純色、漸層、條紋、波點、格紋及圖片背景的完整設定（app_settings，最多 40 個）；圖片背景引用素材版本，該素材因此不會被清理。
const PRESET_KEY = "studio_bg_presets", MAX_PRESETS = 40;
export interface BgPreset { id: string; name: string; spec: BackgroundSpec; created_at: string }
async function readPresets(env: Env): Promise<BgPreset[]> {
  const r = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(PRESET_KEY).first<{ value: string }>();
  if (!r) return [];
  try {
    const arr = JSON.parse(r.value);
    return Array.isArray(arr) ? arr.map((p) => ({ id: String(p?.id ?? ""), name: String(p?.name ?? "").slice(0, 30), spec: normalizeBackground(p?.spec), created_at: String(p?.created_at ?? "") })).filter((p): p is BgPreset => /^bgp_[\w]{4,40}$/.test(p.id) && !!p.spec) : [];
  } catch { return []; }
}
const writePresets = (env: Env, list: BgPreset[]) => env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(PRESET_KEY, JSON.stringify(list), nowIso()).run();
export async function listPresets(env: Env) { return { presets: await readPresets(env) }; }
export async function addPreset(env: Env, actor: Actor, input: Record<string, unknown>) {
  const spec = normalizeBackground(input.spec);
  if (!spec) throw new HttpError(400, "bad_background", "背景設定不正確");
  if (spec.image && !(await env.DB.prepare("SELECT id FROM studio_asset_versions WHERE id = ? AND asset_id = ?").bind(spec.image.version_id, spec.image.asset_id).first())) throw new HttpError(400, "background_not_found", "找不到背景圖片");
  const list = await readPresets(env);
  if (list.length >= MAX_PRESETS) throw new HttpError(400, "too_many_presets", `背景預設最多 ${MAX_PRESETS} 個，請先刪除部分`);
  const p: BgPreset = { id: newId("bgp"), name: str(input.name, 30) || "我的背景", spec, created_at: nowIso() };
  // 圖片背景：素材保留在「我的背景」（避免造型刪除後被清理）
  if (spec.image) await env.DB.prepare("UPDATE studio_assets SET in_library = 1, updated_at = ? WHERE id = ?").bind(nowIso(), spec.image.asset_id).run();
  await writePresets(env, [p, ...list]);
  await audit(env, actor, "studio.bg_preset_add", p.id);
  return { presets: [p, ...list] };
}
export async function deletePreset(env: Env, actor: Actor, id: string) {
  const list = await readPresets(env);
  if (!list.some((p) => p.id === id)) throw new HttpError(404, "preset_not_found", "找不到這個背景預設");
  const next = list.filter((p) => p.id !== id);
  await writePresets(env, next);
  await audit(env, actor, "studio.bg_preset_delete", id);
  return { presets: next };
}
