// 自訂角色身體模型及姿勢庫（Phase 3.6B/C）。
// 只讀寫 doll_models／doll_model_revisions／doll_model_files／doll_poses 及 R2 的 doll/models/ 路徑。
// 內置 Avatar V2 不存資料庫；自訂身體每次保存產生新的不可變版本，舊版本永遠保留給引用它的造型。
import { AVATAR_V2_ID, RIG_V2 } from "../shared/avatarV2";
import { EMPTY_DEF, ModelDef, ModelError, isModelId, modelFileRefs, normalizeModelDef } from "../shared/avatarModel";
import { normalizePose } from "../shared/avatarRig";
import { LOOSE_RIG } from "../shared/avatarModel";
import { parseImage } from "./images";
import { Actor, Env, HttpError, audit, json, newId, nowIso, sha256Hex, str } from "./util";

const DEF_MAX = 200_000;
const FILE_MAX = 12 * 1024 * 1024;
const FILES_PER_MODEL = 240;
const THUMB_MAX = 160_000;
const DEFAULT_KEY = "doll_default_model";

const parse = (v: unknown): unknown => { if (typeof v !== "string" || !v) return null; try { return JSON.parse(v); } catch { return null; } };
function defOrThrow(v: unknown): ModelDef {
  try { return normalizeModelDef(v); } catch (e) { if (e instanceof ModelError) throw new HttpError(400, "bad_model", e.message); throw e; }
}

interface ModelRow { id: string; name: string; base: string; revision: number; status: string; created_at: string; updated_at: string; has_thumb?: number; looks?: number; templates?: number }
const COLS = "m.id, m.name, m.base, m.revision, m.status, m.created_at, m.updated_at, (m.thumb IS NOT NULL) AS has_thumb";
const modelOut = (m: ModelRow) => ({
  id: m.id, name: m.name, base: m.base, revision: Number(m.revision), status: m.status, created_at: m.created_at, updated_at: m.updated_at,
  thumb: m.has_thumb ? `/api/doll/models/${m.id}/thumb?v=${encodeURIComponent(m.updated_at)}` : null,
  looks: Number(m.looks ?? 0), templates: Number(m.templates ?? 0),
});

export async function listModels(env: Env, params: URLSearchParams) {
  const all = params.get("all") === "1";
  const { results } = await env.DB.prepare(
    `SELECT ${COLS}, (SELECT COUNT(*) FROM doll_looks l WHERE l.avatar_id = m.id) AS looks, (SELECT COUNT(*) FROM doll_fit_templates t WHERE t.avatar_id = m.id) AS templates
     FROM doll_models m ${all ? "" : "WHERE m.status = 'active'"} ORDER BY m.created_at LIMIT 200`,
  ).all<ModelRow>();
  return { models: results.map(modelOut), default_model: await defaultModel(env) };
}
async function modelRow(env: Env, id: string) {
  const m = await env.DB.prepare(`SELECT ${COLS} FROM doll_models m WHERE m.id = ?`).bind(id).first<ModelRow>();
  if (!m) throw new HttpError(404, "model_not_found", "找不到這個身體模型");
  return m;
}
async function revisionDef(env: Env, id: string, rev: number): Promise<ModelDef> {
  const r = await env.DB.prepare("SELECT def FROM doll_model_revisions WHERE model_id = ? AND revision = ?").bind(id, rev).first<{ def: string }>();
  if (!r) throw new HttpError(404, "revision_not_found", "找不到這個模型版本");
  return normalizeModelDef(parse(r.def));
}
export async function getModel(env: Env, id: string) {
  const m = await modelRow(env, id);
  const counts = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM doll_looks WHERE avatar_id = ?) AS looks, (SELECT COUNT(*) FROM doll_fit_templates WHERE avatar_id = ?) AS templates").bind(id, id).first<{ looks: number; templates: number }>();
  return { ...modelOut({ ...m, looks: counts?.looks, templates: counts?.templates }), def: await revisionDef(env, id, Number(m.revision)) };
}
/** 不可變版本：可以長期快取 */
export async function getModelRevision(env: Env, id: string, rev: number) {
  const m = await modelRow(env, id);
  const def = await revisionDef(env, id, rev);
  return json({ id, name: m.name, revision: rev, def }, 200, { "cache-control": "private, max-age=31536000, immutable" });
}
async function checkFiles(env: Env, def: ModelDef) {
  for (const ref of modelFileRefs(def)) {
    if (!/^file:dmf_[a-z2-7]+$/.test(ref)) throw new HttpError(400, "bad_model", "身體部件只可以使用上傳到身體模型的圖片");
    const f = await env.DB.prepare("SELECT id FROM doll_model_files WHERE id = ?").bind(ref.slice(5)).first();
    if (!f) throw new HttpError(400, "bad_model", "有身體部件圖片不存在，請重新上傳");
  }
}
export async function createModel(env: Env, actor: Actor, input: Record<string, unknown>) {
  const from = typeof input.from === "string" ? input.from : AVATAR_V2_ID;
  let def: ModelDef = EMPTY_DEF;
  let baseName = "Avatar V2";
  if (input.def != null) def = defOrThrow(input.def);
  else if (from !== AVATAR_V2_ID) {
    if (!isModelId(from)) throw new HttpError(400, "bad_model", "來源模型不正確");
    const src = await modelRow(env, from);
    def = await revisionDef(env, from, Number(src.revision));
    baseName = src.name;
  }
  await checkFiles(env, def);
  const text = JSON.stringify(def);
  if (text.length > DEF_MAX) throw new HttpError(413, "model_too_large", "模型資料過大");
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_models").first<{ n: number }>();
  if ((count?.n ?? 0) >= 60) throw new HttpError(400, "too_many_models", "身體模型已達上限，請先封存或刪除不用的模型");
  const id = newId("dm");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO doll_models (id, name, base, revision, status, created_at, updated_at) VALUES (?,?,?,1,'active',?,?)").bind(id, str(input.name, 40) || baseName + " 副本", AVATAR_V2_ID, now, now),
    env.DB.prepare("INSERT INTO doll_model_revisions (model_id, revision, def, created_at) VALUES (?,1,?,?)").bind(id, text, now),
  ]);
  await audit(env, actor, "doll.model.create", id, { from });
  return getModel(env, id);
}
/** 保存新版本（不可變）。expected_revision 防止兩部裝置互相覆蓋。 */
export async function saveModelDef(env: Env, actor: Actor, id: string, input: Record<string, unknown>) {
  const m = await modelRow(env, id);
  const def = defOrThrow(input.def);
  await checkFiles(env, def);
  const text = JSON.stringify(def);
  if (text.length > DEF_MAX) throw new HttpError(413, "model_too_large", "模型資料過大");
  const expected = Number(input.expected_revision);
  if (!Number.isSafeInteger(expected) || expected < 1) throw new HttpError(400, "bad_version", "版本不正確");
  if (expected !== Number(m.revision)) throw new HttpError(409, "model_conflict", "另一裝置已更新這個身體。你的編輯仍保留；請重新載入後再保存。");
  const next = expected + 1, now = nowIso();
  try {
    const res = await env.DB.batch([
      env.DB.prepare("INSERT INTO doll_model_revisions (model_id, revision, def, created_at) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM doll_models WHERE id = ? AND revision = ?)").bind(id, next, text, now, id, expected),
      env.DB.prepare("UPDATE doll_models SET revision = ?, updated_at = ? WHERE id = ? AND revision = ?").bind(next, now, id, expected),
    ]);
    if (!res[1].meta.changes) throw new HttpError(409, "model_conflict", "另一裝置已更新這個身體。你的編輯仍保留；請重新載入後再保存。");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(409, "model_conflict", "另一裝置已更新這個身體。你的編輯仍保留；請重新載入後再保存。");
  }
  await audit(env, actor, "doll.model.save", id, { revision: next });
  return getModel(env, id);
}
export async function updateModelMeta(env: Env, actor: Actor, id: string, input: Record<string, unknown>) {
  await modelRow(env, id);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const sets = ["updated_at = ?"], binds: unknown[] = [nowIso()];
  if (has("name") && str(input.name, 40)) { sets.push("name = ?"); binds.push(str(input.name, 40)); }
  if (has("status")) {
    if (input.status !== "active" && input.status !== "archived") throw new HttpError(400, "bad_status", "status 不正確");
    sets.push("status = ?"); binds.push(input.status);
    if (input.status === "archived" && (await defaultModel(env)) === id) await setDefaultModel(env, actor, AVATAR_V2_ID);
  }
  await env.DB.prepare(`UPDATE doll_models SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  await audit(env, actor, "doll.model.update", id);
  return getModel(env, id);
}
/** 刪除：只限沒有任何造型引用的模型（連同它的衣物預設、版本及圖片）。有造型引用時請封存。 */
export async function deleteModel(env: Env, actor: Actor, id: string) {
  await modelRow(env, id);
  if (await env.DB.prepare("SELECT id FROM doll_looks WHERE avatar_id = ? LIMIT 1").bind(id).first()) throw new HttpError(409, "model_in_use", "已保存的造型仍在使用這個身體；請改為封存，保留歷史造型");
  // 其他模型（例如由這個身體複製出來的）仍引用這些圖片：只刪除沒有被引用的檔案
  const { results: files } = await env.DB.prepare("SELECT id, r2_key FROM doll_model_files WHERE model_id = ?").bind(id).all<{ id: string; r2_key: string }>();
  const shared: string[] = [];
  for (const f of files) if (await env.DB.prepare("SELECT model_id FROM doll_model_revisions WHERE model_id != ? AND def LIKE ? LIMIT 1").bind(id, "%file:" + f.id + "%").first()) shared.push(f.id);
  if (shared.length) throw new HttpError(409, "model_files_shared", "另一個身體仍在使用這個身體的部件圖片；請改為封存");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM doll_fit_templates WHERE avatar_id = ?").bind(id),
    env.DB.prepare("DELETE FROM doll_poses WHERE model_id = ?").bind(id),
    env.DB.prepare("DELETE FROM doll_model_files WHERE model_id = ?").bind(id),
    env.DB.prepare("DELETE FROM doll_model_revisions WHERE model_id = ?").bind(id),
    env.DB.prepare("DELETE FROM doll_models WHERE id = ?").bind(id),
  ]);
  const keys = files.map((f) => f.r2_key).filter((k) => k.startsWith("doll/models/"));
  if (keys.length) await env.IMAGES.delete(keys).catch(() => undefined);
  if ((await defaultModel(env)) === id) await setDefaultModel(env, actor, AVATAR_V2_ID);
  await audit(env, actor, "doll.model.delete", id);
  return { ok: true };
}

// ───── 身體部件圖片 ─────
export async function addModelFile(req: Request, env: Env, actor: Actor, id: string, params: URLSearchParams) {
  await modelRow(env, id);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_model_files WHERE model_id = ?").bind(id).first<{ n: number }>();
  if ((count?.n ?? 0) >= FILES_PER_MODEL) throw new HttpError(400, "too_many_files", "這個身體的圖片已達上限");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.byteLength) throw new HttpError(400, "empty_file", "檔案是空的");
  if (bytes.byteLength > FILE_MAX) throw new HttpError(413, "file_too_large", "圖片超過 12 MB 上限");
  const info = parseImage(bytes);
  if (info.mime !== "image/png" && info.mime !== "image/webp") throw new HttpError(415, "bad_image", "請上傳透明背景的 PNG 或 WebP");
  if (!info.hasAlpha) throw new HttpError(400, "no_alpha", "這張圖片沒有透明背景");
  if (info.width > 4096 || info.height > 4096) throw new HttpError(400, "bad_image", "圖片尺寸不可超過 4096 像素");
  // 原始畫布尺寸及透明留白裁剪範圍（前端裁剪時提供），保存以便日後重新對位
  const n = (k: string) => { const v = Number(params.get(k)); return Number.isFinite(v) && v >= 0 && v <= 8192 ? Math.round(v) : null; };
  const meta = { src_w: n("src_w"), src_h: n("src_h"), crop: [n("x0"), n("y0"), n("x1"), n("y1")] };
  const sha = await sha256Hex(bytes);
  const fileId = newId("dmf");
  const key = `doll/models/${id}/${fileId}.${info.ext}`;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: info.mime, cacheControl: "private, max-age=31536000, immutable" }, customMetadata: { sha256: sha, owner: "doll_model" } });
  try {
    await env.DB.prepare("INSERT INTO doll_model_files (id, model_id, r2_key, mime_type, width, height, file_size, sha256, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(fileId, id, key, info.mime, info.width, info.height, bytes.byteLength, sha, JSON.stringify(meta), nowIso()).run();
  } catch (e) {
    await env.IMAGES.delete(key).catch(() => undefined);
    throw e;
  }
  await audit(env, actor, "doll.model.file", id, { file: fileId });
  return json({ id: fileId, ref: "file:" + fileId, width: info.width, height: info.height, file_size: bytes.byteLength }, 201);
}
export async function serveModelFile(req: Request, env: Env, fileId: string) {
  const row = await env.DB.prepare("SELECT r2_key, mime_type, sha256 FROM doll_model_files WHERE id = ?").bind(fileId).first<{ r2_key: string; mime_type: string; sha256: string }>();
  if (!row) throw new HttpError(404, "file_not_found", "找不到這張圖片");
  const etag = `"${row.sha256}"`;
  const headers = { "content-type": row.mime_type, "cache-control": "private, max-age=31536000, immutable", etag, "x-content-type-options": "nosniff" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const obj = await env.IMAGES.get(row.r2_key);
  if (!obj) throw new HttpError(404, "object_missing", "R2 找不到身體部件檔案");
  return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
}

// ───── 縮圖（D1 細小圖片，列表不讀 R2） ─────
function smallImage(bytes: Uint8Array) {
  if (!bytes.byteLength) throw new HttpError(400, "empty_file", "檔案是空的");
  if (bytes.byteLength > THUMB_MAX) throw new HttpError(413, "file_too_large", "縮圖過大");
  const info = parseImage(bytes);
  if (info.mime !== "image/jpeg" && info.mime !== "image/png" && info.mime !== "image/webp") throw new HttpError(415, "bad_image", "縮圖格式不支援");
  if (info.width > 1024 || info.height > 1536) throw new HttpError(400, "bad_image", "縮圖尺寸過大");
  return info;
}
const blob = (data: ArrayBuffer | ArrayLike<number>, mime: string) => new Response(data instanceof ArrayBuffer ? data : new Uint8Array(data), { headers: { "content-type": mime, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
export async function putModelThumb(req: Request, env: Env, id: string) {
  await modelRow(env, id);
  const bytes = new Uint8Array(await req.arrayBuffer());
  const info = smallImage(bytes);
  await env.DB.prepare("UPDATE doll_models SET thumb = ?, thumb_mime = ?, updated_at = ? WHERE id = ?").bind(bytes, info.mime, nowIso(), id).run();
  return json({ ok: true });
}
export async function getModelThumb(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT thumb, thumb_mime FROM doll_models WHERE id = ?").bind(id).first<{ thumb: ArrayBuffer | null; thumb_mime: string | null }>();
  if (!row?.thumb) throw new HttpError(404, "thumb_not_found", "未有縮圖");
  return blob(row.thumb, row.thumb_mime || "image/png");
}

// ───── 預設模型（存於 app_settings） ─────
export async function defaultModel(env: Env): Promise<string> {
  const r = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(DEFAULT_KEY).first<{ value: string }>();
  const id = typeof r?.value === "string" ? r.value : AVATAR_V2_ID;
  if (id === AVATAR_V2_ID || !isModelId(id)) return AVATAR_V2_ID;
  const ok = await env.DB.prepare("SELECT id FROM doll_models WHERE id = ? AND status = 'active'").bind(id).first();
  return ok ? id : AVATAR_V2_ID;
}
export async function setDefaultModel(env: Env, actor: Actor, id: unknown) {
  if (!isModelId(id)) throw new HttpError(400, "bad_model", "模型不正確");
  if (id !== AVATAR_V2_ID) {
    const ok = await env.DB.prepare("SELECT id FROM doll_models WHERE id = ? AND status = 'active'").bind(id).first();
    if (!ok) throw new HttpError(400, "bad_model", "找不到這個身體模型");
  }
  await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(DEFAULT_KEY, id, nowIso()).run();
  await audit(env, actor, "doll.model.default", id);
  return { default_model: id };
}
/** 造型引用的模型版本必須存在（V2 永遠存在） */
export async function checkModelRef(env: Env, ref: { id: string; rev: number } | null | undefined): Promise<string> {
  if (!ref || ref.id === AVATAR_V2_ID) return AVATAR_V2_ID;
  const r = await env.DB.prepare("SELECT 1 AS ok FROM doll_model_revisions WHERE model_id = ? AND revision = ?").bind(ref.id, ref.rev).first();
  if (!r) throw new HttpError(400, "bad_model", "造型使用的身體模型版本不存在");
  return ref.id;
}
export async function modelExists(env: Env, id: string) {
  if (id === AVATAR_V2_ID) return true;
  return !!(isModelId(id) && (await env.DB.prepare("SELECT id FROM doll_models WHERE id = ?").bind(id).first()));
}

// ───── 我的姿勢庫 ─────
interface PoseRow { id: string; name: string; model_id: string | null; pose: string; front: string | null; created_at: string; updated_at: string; has_thumb?: number }
const poseOut = (p: PoseRow) => ({ id: p.id, name: p.name, model_id: p.model_id, pose: parse(p.pose) ?? {}, front: parse(p.front) ?? [], created_at: p.created_at, updated_at: p.updated_at, thumb: p.has_thumb ? `/api/doll/poses/${p.id}/thumb?v=${encodeURIComponent(p.updated_at)}` : null });
const POSE_COLS = "id, name, model_id, pose, front, created_at, updated_at, (thumb IS NOT NULL) AS has_thumb";
function poseInput(input: Record<string, unknown>) {
  const pose = normalizePose(LOOSE_RIG, input.pose);
  if (!pose) throw new HttpError(400, "bad_pose", "姿勢資料不正確");
  const front = Array.isArray(input.front) ? (["hand_r", "hand_l"] as const).filter((k) => (input.front as unknown[]).includes(k)) : [];
  return { pose, front };
}
export async function listPoses(env: Env) {
  const { results } = await env.DB.prepare(`SELECT ${POSE_COLS} FROM doll_poses ORDER BY created_at LIMIT 500`).all<PoseRow>();
  return results.map(poseOut);
}
async function poseRow(env: Env, id: string) {
  const p = await env.DB.prepare(`SELECT ${POSE_COLS} FROM doll_poses WHERE id = ?`).bind(id).first<PoseRow>();
  if (!p) throw new HttpError(404, "pose_not_found", "找不到這個姿勢");
  return p;
}
export async function createPose(env: Env, actor: Actor, input: Record<string, unknown>) {
  const { pose, front } = poseInput(input);
  const model = input.model_id == null ? null : String(input.model_id);
  if (model && !(await modelExists(env, model))) throw new HttpError(400, "bad_model", "找不到這個身體模型");
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_poses").first<{ n: number }>();
  if ((n?.n ?? 0) >= 400) throw new HttpError(400, "too_many_poses", "姿勢庫已達上限");
  const id = newId("dps"), now = nowIso();
  await env.DB.prepare("INSERT INTO doll_poses (id, name, model_id, pose, front, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").bind(id, str(input.name, 30) || "我的姿勢", model, JSON.stringify(pose), JSON.stringify(front), now, now).run();
  await audit(env, actor, "doll.pose.create", id);
  return poseOut(await poseRow(env, id));
}
export async function updatePose(env: Env, actor: Actor, id: string, input: Record<string, unknown>) {
  await poseRow(env, id);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const sets = ["updated_at = ?"], binds: unknown[] = [nowIso()];
  if (has("name") && str(input.name, 30)) { sets.push("name = ?"); binds.push(str(input.name, 30)); }
  if (has("pose")) { const p = poseInput(input); sets.push("pose = ?", "front = ?"); binds.push(JSON.stringify(p.pose), JSON.stringify(p.front)); }
  if (has("model_id")) {
    const model = input.model_id == null ? null : String(input.model_id);
    if (model && !(await modelExists(env, model))) throw new HttpError(400, "bad_model", "找不到這個身體模型");
    sets.push("model_id = ?"); binds.push(model);
  }
  await env.DB.prepare(`UPDATE doll_poses SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  await audit(env, actor, "doll.pose.update", id);
  return poseOut(await poseRow(env, id));
}
export async function deletePose(env: Env, actor: Actor, id: string) {
  const res = await env.DB.prepare("DELETE FROM doll_poses WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, "pose_not_found", "找不到這個姿勢");
  await audit(env, actor, "doll.pose.delete", id);
  return { ok: true };
}
export async function putPoseThumb(req: Request, env: Env, id: string) {
  await poseRow(env, id);
  const bytes = new Uint8Array(await req.arrayBuffer());
  const info = smallImage(bytes);
  await env.DB.prepare("UPDATE doll_poses SET thumb = ?, thumb_mime = ?, updated_at = ? WHERE id = ?").bind(bytes, info.mime, nowIso(), id).run();
  return json({ ok: true });
}
export async function getPoseThumb(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT thumb, thumb_mime FROM doll_poses WHERE id = ?").bind(id).first<{ thumb: ArrayBuffer | null; thumb_mime: string | null }>();
  if (!row?.thumb) throw new HttpError(404, "thumb_not_found", "未有縮圖");
  return blob(row.thumb, row.thumb_mime || "image/jpeg");
}
export const V2_REVISION = RIG_V2.version;
