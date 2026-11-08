import { CATEGORIES, GARMENT_FIELDS, LOLITA_SUBCATEGORIES, STYLES } from "../shared/taxonomy";
import { Actor, Env, HttpError, audit, json, newId, nowIso, parseJsonArray, str, strArray } from "./util";

export interface GarmentInput {
  name?: unknown;
  category?: unknown;
  subcategory?: unknown;
  brand?: unknown;
  style?: unknown;
  primary_color?: unknown;
  secondary_colors?: unknown;
  pattern?: unknown;
  season?: unknown;
  notes?: unknown;
  status?: unknown;
  is_favorite?: unknown;
  uncertain_fields?: unknown;
  needs_review?: unknown;
  ai_note?: unknown;
  confirm?: unknown;
}

export interface NormalizedGarment {
  values: Record<string, string | number | null>;
  uncertain: string[];
}

const LOLITA_SUBS = new Set<string>(LOLITA_SUBCATEGORIES);
const CATEGORY_SET = new Set<string>(CATEGORIES);
const STYLE_SET = new Set<string>(STYLES);

/**
 * 正規化輸入。未知的主類別／風格不會被強行改成其他值：
 * 該欄留空並加入 uncertain_fields，待人工確認。
 */
export function normalizeGarment(input: GarmentInput, partial: boolean): NormalizedGarment {
  const values: Record<string, string | number | null> = {};
  const uncertain = new Set<string>(strArray(input.uncertain_fields, 12) ?? []);
  const notes: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);

  for (const field of GARMENT_FIELDS) {
    if (partial && !has(field)) continue;
    const raw = (input as Record<string, unknown>)[field];
    switch (field) {
      case "name":
        values.name = str(raw, 120);
        break;
      case "category": {
        const v = str(raw, 40);
        if (v && !CATEGORY_SET.has(v)) {
          uncertain.add("category");
          notes.push(`AI 建議主類別：${v}`);
          values.category = null;
        } else values.category = v;
        break;
      }
      case "subcategory": {
        const v = str(raw, 40);
        const match = v ? LOLITA_SUBCATEGORIES.find((s) => s.toLowerCase() === v.toLowerCase()) : undefined;
        values.subcategory = match ?? v;
        break;
      }
      case "style": {
        const v = str(raw, 40);
        if (v && !STYLE_SET.has(v)) {
          const match = STYLES.find((s) => s.toLowerCase() === v.toLowerCase());
          if (match) values.style = match;
          else {
            uncertain.add("style");
            notes.push(`AI 建議風格：${v}`);
            values.style = null;
          }
        } else values.style = v;
        break;
      }
      case "secondary_colors": {
        const arr = strArray(raw, 8);
        values.secondary_colors = arr ? JSON.stringify(arr) : null;
        break;
      }
      case "notes":
        values.notes = str(raw, 2000);
        break;
      default:
        values[field] = str(raw, 80);
    }
  }

  if (!partial && !values.name) {
    // 名稱是唯一必填；AI 不確定時用暫時名稱並要求覆核
    values.name = [values.style, values.subcategory || values.category].filter(Boolean).join(" ") || "未命名衣物";
    uncertain.add("name");
  }
  if (has("is_favorite")) values.is_favorite = input.is_favorite ? 1 : 0;
  if (has("ai_note") || notes.length) {
    values.ai_note = [str(input.ai_note, 1000), ...notes].filter(Boolean).join("；") || null;
  }
  if (has("status")) {
    const s = str(input.status, 20);
    if (s && !["active", "review", "archived"].includes(s)) throw new HttpError(400, "bad_status", "status 只可以是 active、review、archived");
    values.status = s;
  }
  return { values, uncertain: [...uncertain] };
}

export function garmentToJson(r: Record<string, unknown>) {
  return {
    ...r,
    secondary_colors: parseJsonArray(r.secondary_colors),
    uncertain_fields: parseJsonArray(r.uncertain_fields),
    is_favorite: Number(r.is_favorite) === 1,
  };
}

const LIST_SELECT = `
  SELECT g.*,
    (SELECT p.id FROM garment_images p WHERE p.garment_id = g.id AND p.is_primary = 1 LIMIT 1) AS primary_image_id,
    (SELECT t.id FROM garment_images t WHERE t.garment_id = g.id AND t.image_type = 'thumbnail'
       ORDER BY CASE WHEN t.derived_from IN (SELECT p2.id FROM garment_images p2 WHERE p2.garment_id = g.id AND p2.is_primary = 1) THEN 0 ELSE 1 END,
                t.created_at DESC LIMIT 1) AS thumb_image_id,
    (SELECT COUNT(*) FROM garment_images c WHERE c.garment_id = g.id AND c.image_type != 'thumbnail') AS image_count
  FROM garments g`;

export async function createGarment(env: Env, actor: Actor, input: GarmentInput, opts: { source: string; clientKey?: string | null }) {
  const { values, uncertain } = normalizeGarment(input, false);
  const needsReview = Boolean(input.needs_review) || uncertain.length > 0;
  const status = (values.status as string) || (needsReview ? "review" : "active");
  const id = newId("gar");
  const now = nowIso();

  if (opts.clientKey) {
    const existing = await env.DB.prepare("SELECT id FROM garments WHERE client_key = ?").bind(opts.clientKey).first<{ id: string }>();
    if (existing) return { id: existing.id, deduplicated: true };
  }

  await env.DB.prepare(
    `INSERT INTO garments (id, name, category, subcategory, brand, style, primary_color, secondary_colors, pattern, season, notes,
       status, is_favorite, uncertain_fields, ai_note, source, client_key, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id, values.name, values.category ?? null, values.subcategory ?? null, values.brand ?? null, values.style ?? null,
      values.primary_color ?? null, values.secondary_colors ?? null, values.pattern ?? null, values.season ?? null,
      values.notes ?? null, status, values.is_favorite ?? 0, uncertain.length ? JSON.stringify(uncertain) : null,
      values.ai_note ?? null, opts.source, opts.clientKey ?? null, now, now,
    )
    .run();
  await audit(env, actor, "garment.create", id, { source: opts.source, status });
  return { id, deduplicated: false };
}

export async function updateGarment(env: Env, actor: Actor, id: string, input: GarmentInput) {
  const cur = await env.DB.prepare("SELECT * FROM garments WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!cur) throw new HttpError(404, "garment_not_found", "找不到這件衣物");
  const { values, uncertain } = normalizeGarment(input, true);
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (k === "name" && !v) continue; // 不允許清空名稱
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  // 人工確認：清除不確定標記並轉為正式
  if (input.confirm) {
    sets.push("uncertain_fields = NULL");
    if (!("status" in values)) sets.push("status = 'active'");
  } else {
    const explicit = Object.prototype.hasOwnProperty.call(input, "uncertain_fields");
    const prev = parseJsonArray(cur.uncertain_fields);
    // 已手動填寫的欄位從不確定清單移除；新出現的無效值則加入
    const base = explicit ? uncertain : prev.filter((f) => !(f in values) || values[f] === null);
    const merged = [...new Set([...base, ...uncertain])].filter((f) => explicit || uncertain.includes(f) || !(f in values) || values[f] === null);
    if (explicit || merged.join() !== prev.join()) {
      sets.push("uncertain_fields = ?");
      binds.push(merged.length ? JSON.stringify(merged) : null);
    }
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  binds.push(nowIso());
  await env.DB.prepare(`UPDATE garments SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  await audit(env, actor, "garment.update", id, Object.keys(values));
}

export async function getGarment(env: Env, id: string) {
  const row = await env.DB.prepare(`${LIST_SELECT} WHERE g.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, "garment_not_found", "找不到這件衣物");
  const { results: images } = await env.DB.prepare(
    `SELECT id, image_type, r2_key, mime_type, width, height, file_size, sha256, has_alpha, is_primary, derived_from, created_at
     FROM garment_images WHERE garment_id = ? ORDER BY is_primary DESC, CASE image_type WHEN 'processed' THEN 0 WHEN 'original' THEN 1 ELSE 2 END, created_at`,
  )
    .bind(id)
    .all<Record<string, unknown>>();
  const { results: outfits } = await env.DB.prepare(
    "SELECT o.id, o.name FROM outfit_items oi JOIN outfits o ON o.id = oi.outfit_id WHERE oi.garment_id = ? AND o.status != 'archived'",
  )
    .bind(id)
    .all();
  return {
    ...garmentToJson(row),
    images: images.map((i) => ({ ...i, has_alpha: Number(i.has_alpha) === 1, is_primary: Number(i.is_primary) === 1, url: `/api/images/${i.id}` })),
    outfits,
  };
}

export async function listGarments(env: Env, params: URLSearchParams) {
  const where: string[] = [];
  const binds: unknown[] = [];
  const status = params.get("status");
  if (status === "all") {
    /* 不篩選 */
  } else if (status) {
    where.push("g.status = ?");
    binds.push(status);
  } else where.push("g.status != 'archived'");

  for (const f of ["category", "subcategory", "style"] as const) {
    const v = params.get(f);
    if (v) {
      where.push(`g.${f} = ?`);
      binds.push(v);
    }
  }
  const color = params.get("color");
  if (color) {
    where.push("(g.primary_color = ? OR g.secondary_colors LIKE ?)");
    binds.push(color, `%"${color}"%`);
  }
  if (params.get("favorite") === "1") where.push("g.is_favorite = 1");
  if (params.get("needs_image") === "1") where.push("NOT EXISTS (SELECT 1 FROM garment_images x WHERE x.garment_id = g.id)");
  const q = params.get("q")?.trim();
  if (q) {
    where.push("(g.name LIKE ? OR g.brand LIKE ? OR g.notes LIKE ? OR g.pattern LIKE ? OR g.subcategory LIKE ?)");
    const like = `%${q.replace(/[%_]/g, "")}%`;
    binds.push(like, like, like, like, like);
  }
  const limit = Math.min(Math.max(Number(params.get("limit")) || 60, 1), 200);
  const offset = Math.max(Number(params.get("offset")) || 0, 0);
  const sort = params.get("sort") === "name" ? "g.name COLLATE NOCASE ASC" : params.get("sort") === "updated" ? "g.updated_at DESC" : "g.created_at DESC";
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(`${LIST_SELECT} ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`)
    .bind(...binds, limit + 1, offset)
    .all<Record<string, unknown>>();
  const hasMore = results.length > limit;
  return {
    garments: results.slice(0, limit).map(garmentToJson),
    next_offset: hasMore ? offset + limit : null,
  };
}

export async function deleteGarment(env: Env, actor: Actor, id: string) {
  const { results } = await env.DB.prepare("SELECT r2_key FROM garment_images WHERE garment_id = ?").bind(id).all<{ r2_key: string }>();
  const res = await env.DB.prepare("DELETE FROM garments WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, "garment_not_found", "找不到這件衣物");
  if (results.length) await env.IMAGES.delete(results.map((r) => r.r2_key));
  await audit(env, actor, "garment.delete", id, { images: results.length });
}

export async function stats(env: Env) {
  const [counts, recent, favs, batches] = await env.DB.batch([
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status != 'archived' THEN 1 ELSE 0 END) AS total,
         SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) AS review,
         SUM(CASE WHEN is_favorite = 1 AND status != 'archived' THEN 1 ELSE 0 END) AS favorites,
         SUM(CASE WHEN status != 'archived' AND NOT EXISTS (SELECT 1 FROM garment_images i WHERE i.garment_id = garments.id) THEN 1 ELSE 0 END) AS missing_image
       FROM garments`,
    ),
    env.DB.prepare(`${LIST_SELECT} WHERE g.status != 'archived' ORDER BY g.created_at DESC LIMIT 12`),
    env.DB.prepare(`${LIST_SELECT} WHERE g.is_favorite = 1 AND g.status != 'archived' ORDER BY g.updated_at DESC LIMIT 12`),
    env.DB.prepare("SELECT COUNT(*) AS open_batches FROM import_batches WHERE status = 'open'"),
  ]);
  const c = (counts.results[0] || {}) as Record<string, number>;
  const { results: byCat } = await env.DB.prepare(
    "SELECT COALESCE(category, '未分類') AS category, COUNT(*) AS n FROM garments WHERE status != 'archived' GROUP BY category ORDER BY n DESC",
  ).all();
  return json({
    total: c.total ?? 0,
    review: c.review ?? 0,
    favorites: c.favorites ?? 0,
    missing_image: c.missing_image ?? 0,
    open_batches: ((batches.results[0] || {}) as Record<string, number>).open_batches ?? 0,
    by_category: byCat,
    recent: (recent.results as Record<string, unknown>[]).map(garmentToJson),
    favorite_items: (favs.results as Record<string, unknown>[]).map(garmentToJson),
  });
}
