// 角色換裝 API：穿著模板（doll_fit_templates）及造型（doll_looks／doll_look_items）。
// 只讀寫 0008 新增的三個資料表；不修改 garments、garment_images、outfits 或 R2。
import { AVATARS, DEFAULT_AVATAR, Fit, SLOT_Z, isSlot, normalizeFit, slotFor } from "../shared/doll";
import { HAIR_STYLES, RIG_V2, normalizeColorValue } from "../shared/avatarV2";
import { normalizePose } from "../shared/avatarRig";
import { transparentImageSql } from "./transparent";
import { Actor, Env, HttpError, audit, newId, nowIso, str } from "./util";

const avatarOf = (v: unknown): string => {
  const id = typeof v === "string" && v ? v : DEFAULT_AVATAR;
  if (!AVATARS[id]) throw new HttpError(400, "bad_avatar", "找不到這個角色");
  return id;
};
const fitOrThrow = (v: unknown): Fit => {
  const f = normalizeFit(v);
  if (!f) throw new HttpError(400, "bad_fit", "位置資料不正確");
  return f;
};

interface TemplateRow { garment_id: string; avatar_id: string; image_id: string | null; cx: number; cy: number; w: number; rotation: number; slot: string | null; version: number; updated_at: string }
const templateOut = (r: TemplateRow) => ({ garment_id: r.garment_id, avatar_id: r.avatar_id, image_id: r.image_id, fit: { cx: r.cx, cy: r.cy, w: r.w, rotation: r.rotation }, slot: r.slot, version: r.version, updated_at: r.updated_at });

export async function listTemplates(env: Env, params: URLSearchParams) {
  const avatar = avatarOf(params.get("avatar"));
  const { results } = await env.DB.prepare("SELECT * FROM doll_fit_templates WHERE avatar_id = ? ORDER BY updated_at DESC LIMIT 2000").bind(avatar).all<TemplateRow>();
  return results.map(templateOut);
}

export async function putTemplate(env: Env, actor: Actor, garmentId: string, input: Record<string, unknown>) {
  const avatar = avatarOf(input.avatar_id);
  const fit = fitOrThrow(input.fit);
  const slot = input.slot === undefined || input.slot === null ? null : isSlot(input.slot) ? input.slot : null;
  if (input.slot && !slot) throw new HttpError(400, "bad_slot", "圖層位置不正確");
  const g = await env.DB.prepare(`SELECT g.id, ${transparentImageSql()} AS image_id FROM garments g WHERE g.id = ?`).bind(garmentId).first<{ id: string; image_id: string | null }>();
  if (!g) throw new HttpError(404, "garment_not_found", "找不到這件衣物");
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO doll_fit_templates (garment_id, avatar_id, image_id, cx, cy, w, rotation, slot, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,?)
     ON CONFLICT(garment_id, avatar_id) DO UPDATE SET image_id = excluded.image_id, cx = excluded.cx, cy = excluded.cy, w = excluded.w,
       rotation = excluded.rotation, slot = excluded.slot, version = doll_fit_templates.version + 1, updated_at = excluded.updated_at`,
  ).bind(garmentId, avatar, g.image_id, fit.cx, fit.cy, fit.w, fit.rotation, slot, now, now).run();
  await audit(env, actor, "doll.template.save", garmentId);
  const row = await env.DB.prepare("SELECT * FROM doll_fit_templates WHERE garment_id = ? AND avatar_id = ?").bind(garmentId, avatar).first<TemplateRow>();
  return templateOut(row!);
}

export async function deleteTemplate(env: Env, actor: Actor, garmentId: string, params: URLSearchParams) {
  const avatar = avatarOf(params.get("avatar"));
  const res = await env.DB.prepare("DELETE FROM doll_fit_templates WHERE garment_id = ? AND avatar_id = ?").bind(garmentId, avatar).run();
  if (res.meta.changes) await audit(env, actor, "doll.template.delete", garmentId);
  return { ok: true, deleted: res.meta.changes };
}

// ───── 造型 ─────
interface LookInput { name?: unknown; notes?: unknown; is_favorite?: unknown; avatar_id?: unknown; status?: unknown; items?: unknown; hair_style?: unknown; hair_color?: unknown; accent_color?: unknown; pose?: unknown }
const appearanceKeys = ["hair_style", "hair_color", "accent_color", "pose"] as const;
function appearanceValue(key: typeof appearanceKeys[number], v: unknown): string | null {
  if (v == null) return null;
  if (key === "pose") {
    const p = normalizePose(RIG_V2, v);
    if (!p) throw new HttpError(400, "bad_pose", "姿勢資料不正確");
    return JSON.stringify(p);
  }
  if (key === "hair_style" && typeof v === "string" && Object.prototype.hasOwnProperty.call(HAIR_STYLES, v)) return v;
  if (key === "accent_color" && v === "original") return v;
  if (key !== "hair_style") {
    const c = normalizeColorValue(v);
    if (c) return c;
  }
  throw new HttpError(400, "bad_appearance", "角色外觀資料不正確");
}
function lookOut(l: Record<string, unknown>) {
  let pose = {};
  try { pose = normalizePose(RIG_V2, typeof l.pose === "string" ? JSON.parse(l.pose) : l.pose) ?? {}; } catch { /* legacy or malformed data */ }
  return { ...l, pose, is_favorite: Number(l.is_favorite) === 1 };
}

async function itemsOf(env: Env, lookId: string) {
  const { results } = await env.DB.prepare(
    `SELECT i.garment_id, i.slot, i.z, i.ov_cx, i.ov_cy, i.ov_w, i.ov_rotation, g.name, g.category, g.subcategory,
       ${transparentImageSql()} AS image_id
     FROM doll_look_items i JOIN garments g ON g.id = i.garment_id WHERE i.look_id = ? ORDER BY i.z, i.rowid`,
  ).bind(lookId).all<Record<string, unknown>>();
  return results.map((r) => ({
    garment_id: r.garment_id, slot: r.slot, z: r.z, name: r.name, category: r.category, subcategory: r.subcategory, image_id: r.image_id,
    override: r.ov_cx === null || r.ov_cy === null || r.ov_w === null ? null : { cx: r.ov_cx, cy: r.ov_cy, w: r.ov_w, rotation: r.ov_rotation ?? 0 },
  }));
}

export async function listLooks(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT l.*, (SELECT COUNT(*) FROM doll_look_items i WHERE i.look_id = l.id) AS item_count
     FROM doll_looks l WHERE l.status != 'archived' ORDER BY l.updated_at DESC LIMIT 200`,
  ).all<Record<string, unknown>>();
  return results.map(lookOut);
}

export async function getLook(env: Env, id: string) {
  const l = await env.DB.prepare("SELECT * FROM doll_looks WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!l) throw new HttpError(404, "look_not_found", "找不到這個造型");
  return { ...lookOut(l), items: await itemsOf(env, id) };
}

/** 整批重寫造型單品（在同一個 D1 batch 內；個別位置修改由請求一併帶來，不會遺失） */
async function itemStatements(env: Env, lookId: string, items: unknown) {
  if (!Array.isArray(items) || items.length > 30) throw new HttpError(400, "bad_items", "items 格式錯誤（最多 30 件）");
  const ids = [...new Set(items.map((it) => String((it as { garment_id?: unknown })?.garment_id || "")).filter(Boolean))];
  const known = new Map<string, { category: string | null; subcategory: string | null }>();
  for (const gid of ids) {
    const g = await env.DB.prepare("SELECT category, subcategory FROM garments WHERE id = ?").bind(gid).first<{ category: string | null; subcategory: string | null }>();
    if (!g) throw new HttpError(400, "bad_garment", "有衣物不存在，未能儲存造型");
    known.set(gid, g);
  }
  const stmts = [env.DB.prepare("DELETE FROM doll_look_items WHERE look_id = ?").bind(lookId)];
  const seen = new Set<string>();
  items.forEach((raw, i) => {
    const it = raw as { garment_id?: unknown; slot?: unknown; override?: unknown };
    const gid = String(it.garment_id || "");
    if (!gid || seen.has(gid)) return;
    seen.add(gid);
    const g = known.get(gid)!;
    const slot = isSlot(it.slot) ? it.slot : slotFor(g.category, g.subcategory);
    const ov = it.override === undefined || it.override === null ? null : fitOrThrow(it.override);
    stmts.push(
      env.DB.prepare("INSERT INTO doll_look_items (look_id, garment_id, slot, z, ov_cx, ov_cy, ov_w, ov_rotation) VALUES (?,?,?,?,?,?,?,?)")
        .bind(lookId, gid, slot, SLOT_Z[slot] + i, ov ? ov.cx : null, ov ? ov.cy : null, ov ? ov.w : null, ov ? ov.rotation : null),
    );
  });
  return stmts;
}

export async function createLook(env: Env, actor: Actor, input: LookInput) {
  const id = newId("look");
  const now = nowIso();
  const stmts = await itemStatements(env, id, input.items ?? []);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO doll_looks (id, name, avatar_id, notes, is_favorite, status, created_at, updated_at, hair_style, hair_color, accent_color, pose) VALUES (?,?,?,?,?, 'active', ?, ?,?,?,?,?)")
      .bind(id, str(input.name, 120) || "新造型", avatarOf(input.avatar_id), str(input.notes, 2000), input.is_favorite ? 1 : 0, now, now, ...appearanceKeys.map((key) => appearanceValue(key, input[key]))),
    ...stmts,
  ]);
  await audit(env, actor, "doll.look.create", id);
  return getLook(env, id);
}

export async function updateLook(env: Env, actor: Actor, id: string, input: LookInput) {
  const cur = await env.DB.prepare("SELECT id, avatar_id FROM doll_looks WHERE id = ?").bind(id).first<{ id: string; avatar_id: string }>();
  if (!cur) throw new HttpError(404, "look_not_found", "找不到這個造型");
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (has("avatar_id")) {
    const nextAvatar = avatarOf(input.avatar_id);
    if (nextAvatar !== cur.avatar_id && !has("items")) throw new HttpError(400, "avatar_items_required", "切換角色時必須提供重新對位的衣物");
    sets.push("avatar_id = ?"); binds.push(nextAvatar);
  }
  for (const key of appearanceKeys) if (has(key)) {
    sets.push(key + " = ?"); binds.push(appearanceValue(key, input[key]));
  }
  if (has("name") && str(input.name, 120)) { sets.push("name = ?"); binds.push(str(input.name, 120)); }
  if (has("notes")) { sets.push("notes = ?"); binds.push(str(input.notes, 2000)); }
  if (has("is_favorite")) { sets.push("is_favorite = ?"); binds.push(input.is_favorite ? 1 : 0); }
  if (has("status")) {
    const s = str(input.status, 20);
    if (s !== "active" && s !== "archived") throw new HttpError(400, "bad_status", "status 不正確");
    sets.push("status = ?"); binds.push(s);
  }
  sets.push("updated_at = ?");
  binds.push(nowIso());
  const stmts = has("items") ? await itemStatements(env, id, input.items) : [];
  await env.DB.batch([env.DB.prepare(`UPDATE doll_looks SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id), ...stmts]);
  await audit(env, actor, "doll.look.update", id);
  return getLook(env, id);
}

export async function deleteLook(env: Env, actor: Actor, id: string) {
  const res = await env.DB.prepare("DELETE FROM doll_looks WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, "look_not_found", "找不到這個造型");
  await audit(env, actor, "doll.look.delete", id);
}
