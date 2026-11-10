import { transparentImageSql } from "./transparent";
import { Actor, Env, HttpError, audit, newId, nowIso, str } from "./util";

interface OutfitInput {
  name?: unknown;
  notes?: unknown;
  style?: unknown;
  is_favorite?: unknown;
  status?: unknown;
  items?: { garment_id: string; position?: number; layer_order?: number; x?: number; y?: number; w?: number; h?: number }[];
}

export async function listOutfits(env: Env, params: URLSearchParams) {
  const where = params.get("status") ? "o.status = ?" : "o.status != 'archived'";
  const binds = params.get("status") ? [params.get("status")] : [];
  const fav = params.get("favorite") === "1" ? " AND o.is_favorite = 1" : "";
  const { results } = await env.DB.prepare(
    `SELECT o.*,
       (SELECT COUNT(*) FROM outfit_items i WHERE i.outfit_id = o.id) AS item_count,
       (SELECT oi.id FROM outfit_images oi WHERE oi.outfit_id = o.id AND oi.has_alpha = 1 AND oi.image_type = 'processed' ORDER BY oi.is_primary DESC LIMIT 1) AS image_id
     FROM outfits o WHERE ${where}${fav} ORDER BY o.created_at DESC LIMIT 200`,
  )
    .bind(...binds)
    .all<Record<string, unknown>>();
  const out = [];
  for (const o of results) {
    const { results: items } = await env.DB.prepare(
      `SELECT i.garment_id, i.position, i.layer_order, i.x, i.y, i.w, i.h, g.name, g.category,
         ${transparentImageSql()} AS image_id
       FROM outfit_items i JOIN garments g ON g.id = i.garment_id WHERE i.outfit_id = ? ORDER BY i.layer_order, i.position`,
    )
      .bind(o.id)
      .all();
    out.push({ ...o, is_favorite: Number(o.is_favorite) === 1, items });
  }
  return out;
}

export async function getOutfit(env: Env, id: string) {
  const o = await env.DB.prepare("SELECT * FROM outfits WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!o) throw new HttpError(404, "outfit_not_found", "找不到這套穿搭");
  const { results: items } = await env.DB.prepare(
    `SELECT i.garment_id, i.position, i.layer_order, i.x, i.y, i.w, i.h, g.name, g.category, g.subcategory, g.style,
       ${transparentImageSql()} AS image_id,
       ${transparentImageSql()} AS thumb_image_id
     FROM outfit_items i JOIN garments g ON g.id = i.garment_id WHERE i.outfit_id = ? ORDER BY i.layer_order, i.position`,
  )
    .bind(id)
    .all();
  const { results: images } = await env.DB.prepare(
    "SELECT id, image_type, width, height, has_alpha, is_primary FROM outfit_images WHERE outfit_id = ? AND has_alpha = 1 AND image_type = 'processed' ORDER BY is_primary DESC, created_at",
  )
    .bind(id)
    .all();
  return { ...o, is_favorite: Number(o.is_favorite) === 1, items, images };
}

/** 畫布位置（佔畫布百分比）；沒有提供時為 null，App 會按類別放在預設位置 */
function pct(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

async function writeItems(env: Env, outfitId: string, items: OutfitInput["items"]) {
  if (!items) return;
  if (!Array.isArray(items) || items.length > 30) throw new HttpError(400, "bad_items", "items 格式錯誤（最多 30 件）");
  const stmts = [env.DB.prepare("DELETE FROM outfit_items WHERE outfit_id = ?").bind(outfitId)];
  const seen = new Set<string>();
  items.forEach((it, i) => {
    const gid = String(it.garment_id || "");
    if (!gid || seen.has(gid)) return;
    seen.add(gid);
    stmts.push(
      env.DB.prepare("INSERT INTO outfit_items (outfit_id, garment_id, position, layer_order, x, y, w, h) VALUES (?,?,?,?,?,?,?,?)").bind(
        outfitId, gid, Number.isFinite(it.position) ? Number(it.position) : i, Number.isFinite(it.layer_order) ? Number(it.layer_order) : i,
        pct(it.x, -50, 150), pct(it.y, -50, 150), pct(it.w, 2, 300), pct(it.h, 2, 300),
      ),
    );
  });
  try {
    await env.DB.batch(stmts);
  } catch {
    throw new HttpError(400, "bad_garment", "有衣物不存在，未能儲存穿搭");
  }
}

export async function createOutfit(env: Env, actor: Actor, input: OutfitInput) {
  const id = newId("out");
  const now = nowIso();
  await env.DB.prepare(
    "INSERT INTO outfits (id, name, notes, style, is_favorite, status, source, created_at, updated_at) VALUES (?,?,?,?,?, 'active', ?, ?, ?)",
  )
    .bind(id, str(input.name, 120) || "新穿搭", str(input.notes, 2000), str(input.style, 40), input.is_favorite ? 1 : 0, actor.kind === "session" ? "manual" : actor.label, now, now)
    .run();
  try {
    await writeItems(env, id, input.items);
  } catch (e) {
    await env.DB.prepare("DELETE FROM outfits WHERE id = ?").bind(id).run();
    throw e;
  }
  await audit(env, actor, "outfit.create", id);
  return getOutfit(env, id);
}

export async function updateOutfit(env: Env, actor: Actor, id: string, input: OutfitInput) {
  const cur = await env.DB.prepare("SELECT id FROM outfits WHERE id = ?").bind(id).first();
  if (!cur) throw new HttpError(404, "outfit_not_found", "找不到這套穿搭");
  const sets: string[] = [];
  const binds: unknown[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  if (has("name") && str(input.name, 120)) { sets.push("name = ?"); binds.push(str(input.name, 120)); }
  if (has("notes")) { sets.push("notes = ?"); binds.push(str(input.notes, 2000)); }
  if (has("style")) { sets.push("style = ?"); binds.push(str(input.style, 40)); }
  if (has("is_favorite")) { sets.push("is_favorite = ?"); binds.push(input.is_favorite ? 1 : 0); }
  if (has("status")) {
    const s = str(input.status, 20);
    if (!s || !["active", "review", "archived"].includes(s)) throw new HttpError(400, "bad_status", "status 不正確");
    sets.push("status = ?"); binds.push(s);
  }
  sets.push("updated_at = ?");
  binds.push(nowIso());
  await env.DB.prepare(`UPDATE outfits SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  await writeItems(env, id, input.items);
  await audit(env, actor, "outfit.update", id);
  return getOutfit(env, id);
}

export async function deleteOutfit(env: Env, actor: Actor, id: string) {
  const { results } = await env.DB.prepare("SELECT r2_key FROM outfit_images WHERE outfit_id = ?").bind(id).all<{ r2_key: string }>();
  const res = await env.DB.prepare("DELETE FROM outfits WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, "outfit_not_found", "找不到這套穿搭");
  if (results.length) await env.IMAGES.delete(results.map((r) => r.r2_key));
  await audit(env, actor, "outfit.delete", id);
}
