import { GARMENT_FIELDS, isColumnAttribute, joinMulti, LEGACY_COLOR, LEGACY_SEASON, LEGACY_SUBCATEGORY, splitMulti } from "../shared/taxonomy";
import { transparentImageSql } from "./transparent";
import { currentTaxonomy } from "./taxonomy";
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
  attributes?: unknown;
  price?: unknown;
  status?: unknown;
  is_favorite?: unknown;
  uncertain_fields?: unknown;
  needs_review?: unknown;
  ai_note?: unknown;
  confirm?: unknown;
  expected_version?: number;
}

export interface NormalizedGarment {
  values: Record<string, string | number | null>;
  uncertain: string[];
}

export const AI_STATUSES = ["pending_ai", "ai_processing", "pending_review", "done", "failed", "needs_rework"] as const;
export type AiStatus = (typeof AI_STATUSES)[number];

const ci = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * 正規化輸入（以 D1 分類字典為準，使用者新增的分類同樣有效）。
 * 未知的主類別／風格不會被強行改成其他值：該欄留空並加入 uncertain_fields，待人工確認。
 */
export function normalizeGarment(input: GarmentInput, partial: boolean): NormalizedGarment {
  const tax = currentTaxonomy();
  const values: Record<string, string | number | null> = {};
  const uncertain = new Set<string>(strArray(input.uncertain_fields, 12) ?? []);
  const notes: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const optionsOf = (attrId: string) => tax.attributes.find((a) => a.id === attrId)?.options.map((o) => o.name) ?? [];
  const maxOf = (attrId: string) => tax.attributes.find((a) => a.id === attrId)?.max_select ?? null;

  for (const field of GARMENT_FIELDS) {
    if (partial && !has(field)) continue;
    const raw = (input as Record<string, unknown>)[field];
    switch (field) {
      case "name":
        values.name = str(raw, 120);
        break;
      case "category": {
        const v = str(raw, 40);
        const match = v ? tax.categories.find((c) => ci(c.name, v)) : undefined;
        if (v && !match) {
          uncertain.add("category");
          notes.push(`AI 建議主類別：${v}`);
          values.category = null;
        } else values.category = match?.name ?? null;
        break;
      }
      case "subcategory": {
        const v = str(raw, 40);
        if (!v) {
          values.subcategory = null;
          break;
        }
        const legacy = Object.entries(LEGACY_SUBCATEGORY).find(([k]) => ci(k, v))?.[1];
        if (legacy) {
          values.subcategory = legacy.sub;
          if (!partial || has("category")) values.category = legacy.category;
          break;
        }
        const cat = (values.category as string | null | undefined) ?? str(input.category, 40);
        const inCat = cat ? tax.categories.find((c) => c.name === cat)?.subs.find((s) => ci(s.name, v)) : undefined;
        const all = tax.categories.flatMap((c) => c.subs.filter((s) => ci(s.name, v)).map((s) => ({ s, c })));
        values.subcategory = inCat?.name ?? all[0]?.s.name ?? v;
        // 只填了子分類而子分類名稱唯一時，補上主分類
        if (!inCat && all.length === 1 && (!partial || has("category")) && !values.category && !uncertain.has("category")) values.category = all[0].c.name;
        break;
      }
      case "style": {
        const opts = optionsOf("style");
        const out: string[] = [];
        for (const v of splitMulti(raw).slice(0, 8)) {
          const m = opts.find((o) => ci(o, v));
          if (m) out.push(m);
          else {
            uncertain.add("style");
            notes.push(`AI 建議風格：${v}`);
          }
        }
        values.style = joinMulti(out);
        break;
      }
      case "primary_color": {
        const list = splitMulti(raw).map((c) => optionsOf("primary_color").includes(c) ? c : LEGACY_COLOR[c] ?? c);
        values.primary_color = joinMulti(list.slice(0, maxOf("primary_color") ?? 2).map((c) => c.slice(0, 20)));
        break;
      }
      case "secondary_colors": {
        const arr = strArray(raw, 8)?.map((c) => optionsOf("secondary_colors").includes(c) ? c : LEGACY_COLOR[c] ?? c);
        values.secondary_colors = arr ? JSON.stringify([...new Set(arr)]) : null;
        break;
      }
      case "season":
        values.season = joinMulti(splitMulti(raw).flatMap((s) => LEGACY_SEASON[s] ?? [s]).slice(0, 8));
        break;
      case "attributes":
        values.attributes = normalizeAttributes(raw);
        break;
      case "notes":
        values.notes = str(raw, 2000);
        break;
      default:
        values[field] = str(raw, 80);
    }
  }

  if (!partial && !values.name) {
    // 名稱是唯一必填；AI 不確定時用暫時名稱並要求覆核
    values.name = [splitMulti(values.style)[0], values.subcategory || values.category].filter(Boolean).join(" ") || "未命名衣物";
    uncertain.add("name");
  }
  if (has("is_favorite")) values.is_favorite = input.is_favorite ? 1 : 0;
  if (has("price")) values.price = normalizePrice(input.price);
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

/** 價錢（港幣）：空白＝未填；必須是 0 至 9,999,999 的數字，保留兩位小數 */
export function normalizePrice(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === "string" ? raw.replace(/[,，$＄\s]|HK\$?/gi, "") : raw;
  if (text === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 9_999_999) throw new HttpError(400, "bad_price", "價錢必須是 0 或以上的數字");
  return Math.round(n * 100) / 100;
}

/** 屬性 JSON：鍵必須是分類字典內的屬性 ID；多選存陣列，單選存字串，空值移除 */
export function normalizeAttributes(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "bad_attributes", "attributes 必須是 JSON 物件");
    }
  } else if (typeof raw === "object" && !Array.isArray(raw)) obj = raw as Record<string, unknown>;
  else throw new HttpError(400, "bad_attributes", "attributes 必須是物件");
  const tax = currentTaxonomy();
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(obj).slice(0, 60)) {
    if (k === "original_name" || k === "source_url") {
      const value = str(v, k === "original_name" ? 300 : 2048);
      if (value && k === "source_url") {
        try { const url = new URL(value); if (!["https:", "http:"].includes(url.protocol)) throw new Error(); }
        catch { throw new HttpError(400, "bad_url", "連結必須是有效的 http 或 https 網址"); }
      }
      if (value) out[k] = value;
      continue;
    }
    if (isColumnAttribute(k)) continue; // 風格／顏色／季節用原有欄位
    const attr = tax.attributes.find((a) => a.id === k);
    if (!attr) continue;
    const list = (Array.isArray(v) ? v : [v]).map((x) => str(x, 40)).filter((x): x is string => Boolean(x));
    if (!list.length) continue;
    if (attr.multi) out[k] = [...new Set(list)].slice(0, attr.max_select ?? 20);
    else out[k] = list[0];
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

export function parseAttributes(v: unknown): Record<string, unknown> {
  if (typeof v !== "string" || !v) return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

export function garmentToJson(r: Record<string, unknown>): Record<string, unknown> & { secondary_colors:string[]; uncertain_fields:string[]; locked_fields:string[]; attributes:Record<string, unknown>; is_favorite:boolean; price:number|null; name_is_placeholder:boolean } {
  return {
    ...r,
    secondary_colors: parseJsonArray(r.secondary_colors),
    uncertain_fields: parseJsonArray(r.uncertain_fields),
    locked_fields: parseJsonArray(r.locked_fields),
    attributes: parseAttributes(r.attributes),
    is_favorite: Number(r.is_favorite) === 1,
    price: r.price === null || r.price === undefined ? null : Number(r.price),
    name_is_placeholder: Number(r.name_is_placeholder) === 1,
  };
}

const LIST_SELECT = `
  SELECT g.*,
    ${transparentImageSql()} AS transparent_image_id,
    (SELECT p.id FROM garment_images p WHERE p.garment_id = g.id AND p.is_primary = 1 LIMIT 1) AS primary_image_id,
    (SELECT t.id FROM garment_images t WHERE t.garment_id = g.id AND t.image_type = 'thumbnail' AND t.variant IS NULL
       ORDER BY CASE WHEN t.derived_from IN (SELECT p2.id FROM garment_images p2 WHERE p2.garment_id = g.id AND p2.is_primary = 1) THEN 0 ELSE 1 END,
                t.created_at DESC LIMIT 1) AS thumb_image_id,
    (SELECT COUNT(*) FROM garment_images c WHERE c.garment_id = g.id AND c.image_type != 'thumbnail' AND c.variant IS NULL) AS image_count,
    EXISTS (SELECT 1 FROM garment_images x WHERE x.garment_id = g.id AND x.image_type = 'processed') AS has_processed
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
       status, is_favorite, uncertain_fields, ai_note, source, client_key, created_at, updated_at, attributes, price)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id, values.name, values.category ?? null, values.subcategory ?? null, values.brand ?? null, values.style ?? null,
      values.primary_color ?? null, values.secondary_colors ?? null, values.pattern ?? null, values.season ?? null,
      values.notes ?? null, status, values.is_favorite ?? 0, uncertain.length ? JSON.stringify(uncertain) : null,
      values.ai_note ?? null, opts.source, opts.clientKey ?? null, now, now, values.attributes ?? null, values.price ?? null,
    )
    .run();
  await audit(env, actor, "garment.create", id, { source: opts.source, status });
  return { id, deduplicated: false };
}

/**
 * 更新衣物。
 * - App 使用者（session）修改的資料欄位會加入 locked_fields，之後 AI 不可覆寫。
 * - AI 權杖不可修改 locked_fields 內的欄位（會略過並回報）。
 * - 每次修改 version + 1。
 */
export async function updateGarment(env: Env, actor: Actor, id: string, input: GarmentInput): Promise<{ skipped_locked: string[] }> {
  const cur = await env.DB.prepare("SELECT * FROM garments WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!cur) throw new HttpError(404, "garment_not_found", "找不到這件衣物");
  if (input.expected_version !== undefined && input.expected_version !== Number(cur.version)) throw new HttpError(409, "version_conflict", "衣物已更新，請重新載入");
  const { values, uncertain } = normalizeGarment(input, true);
  const locked = new Set(parseJsonArray(cur.locked_fields));
  const skipped: string[] = [];
  if (actor.kind !== "session") {
    for (const k of Object.keys(values)) {
      if (locked.has(k)) {
        skipped.push(k);
        delete values[k];
      }
    }
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  const dataFields: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (k === "name" && !v) continue; // 不允許清空名稱
    sets.push(`${k} = ?`);
    binds.push(v);
    if ((GARMENT_FIELDS as readonly string[]).includes(k)) dataFields.push(k);
  }
  if (values.name) sets.push("name_is_placeholder = 0");
  if (actor.kind === "session" && dataFields.length) {
    const next = [...new Set([...locked, ...dataFields])];
    sets.push("locked_fields = ?");
    binds.push(JSON.stringify(next));
  }
  // 人工確認：清除不確定標記並轉為正式
  if (input.confirm) {
    sets.push("uncertain_fields = NULL");
    if (!("status" in values)) sets.push("status = 'active'");
    if (actor.kind === "session" && cur.ai_status) sets.push("ai_status = 'done'", "ai_claimed_at = NULL", "ai_claimed_by = NULL");
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
  if (!sets.length) return { skipped_locked: skipped };
  sets.push("updated_at = ?", "version = version + 1");
  binds.push(nowIso());
  const changed = await env.DB.prepare(`UPDATE garments SET ${sets.join(", ")} WHERE id = ? AND version = ?`).bind(...binds, id, cur.version).run();
  if (!changed.meta.changes) throw new HttpError(409, "version_conflict", "衣物已更新，請重新載入");
  await audit(env, actor, "garment.update", id, { fields: Object.keys(values), skipped_locked: skipped });
  return { skipped_locked: skipped };
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

  for (const f of ["category", "subcategory"] as const) {
    const v = params.get(f);
    if (v) {
      where.push(`g.${f} = ?`);
      binds.push(v);
    }
  }
  // 多選欄位以「、」分隔
  const style = params.get("style");
  if (style) {
    where.push("('、' || g.style || '、') LIKE ?");
    binds.push(`%、${style}、%`);
  }
  const color = params.get("color");
  if (color) {
    where.push("(('、' || g.primary_color || '、') LIKE ? OR g.secondary_colors LIKE ?)");
    binds.push(`%、${color}、%`, `%"${color}"%`);
  }
  const season = params.get("season");
  if (season) {
    where.push("('、' || g.season || '、') LIKE ?");
    binds.push(`%、${season}、%`);
  }
  // 屬性篩選：attr=屬性ID:值
  const attr = params.get("attr");
  const am = attr?.match(/^([\w-]{1,40}):(.{1,40})$/);
  if (am) {
    where.push("(json_extract(g.attributes, '$.' || ?) = ? OR EXISTS (SELECT 1 FROM json_each(g.attributes, '$.' || ?) j WHERE j.value = ?))");
    binds.push(am[1], am[2], am[1], am[2]);
  }
  const brand = params.get("brand");
  if (brand === "__none__") where.push("(g.brand IS NULL OR g.brand = '')");
  else if (brand) {
    where.push("g.brand = ?");
    binds.push(brand);
  }
  const aiStatus = params.get("ai_status");
  if (aiStatus) {
    const list = aiStatus.split(",").filter((x) => AI_STATUSES.includes(x as AiStatus));
    if (list.length) {
      where.push(`g.ai_status IN (${list.map(() => "?").join(",")})`);
      binds.push(...list);
    }
  }
  if (params.get("transparent") === "1") where.push(`${transparentImageSql()} IS NOT NULL`);
  const identified = params.get("identified");
  if (identified === "1") where.push("(g.ai_status IS NULL OR g.ai_status = 'done')");
  else if (identified === "0") where.push("g.ai_status IS NOT NULL AND g.ai_status != 'done'");
  if (params.get("favorite") === "1") where.push("g.is_favorite = 1");
  if (params.get("needs_image") === "1") where.push("NOT EXISTS (SELECT 1 FROM garment_images x WHERE x.garment_id = g.id)");
  const q = params.get("q")?.trim();
  if (q) {
    where.push("(g.name LIKE ? OR g.brand LIKE ? OR g.notes LIKE ? OR g.pattern LIKE ? OR g.subcategory LIKE ? OR g.attributes LIKE ?)");
    const like = `%${q.replace(/[%_]/g, "")}%`;
    binds.push(like, like, like, like, like, like);
  }
  const limit = Math.min(Math.max(Number(params.get("limit")) || 60, 1), 200);
  const offset = Math.max(Number(params.get("offset")) || 0, 0);
  const SORTS: Record<string, string> = {
    name: "g.name COLLATE NOCASE ASC",
    updated: "g.updated_at DESC",
    price_desc: "g.price IS NULL, g.price DESC, g.created_at DESC",
    price_asc: "g.price IS NULL, g.price ASC, g.created_at DESC",
    oldest: "g.created_at ASC",
  };
  const sort = SORTS[params.get("sort") || ""] ?? "g.created_at DESC";
  const priced = params.get("priced");
  if (priced === "1") where.push("g.price IS NOT NULL");
  else if (priced === "0") where.push("g.price IS NULL");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(`${LIST_SELECT} ${whereSql} ORDER BY ${sort}, g.id ASC LIMIT ? OFFSET ?`)
    .bind(...binds, limit + 1, offset)
    .all<Record<string, unknown>>();
  const hasMore = results.length > limit;
  return {
    garments: results.slice(0, limit).map(garmentToJson),
    next_offset: hasMore ? offset + limit : null,
  };
}

export async function deleteGarment(env: Env, actor: Actor, id: string) {
  if (await env.DB.prepare("SELECT look_id FROM doll_look_items WHERE garment_id = ? LIMIT 1").bind(id).first()) throw new HttpError(409, "garment_in_use", "已保存造型仍在使用這件衣物，請改為封存以保留歷史造型");
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
         SUM(CASE WHEN status != 'archived' AND NOT EXISTS (SELECT 1 FROM garment_images i WHERE i.garment_id = garments.id) THEN 1 ELSE 0 END) AS missing_image,
         SUM(CASE WHEN status != 'archived' AND price IS NOT NULL THEN price ELSE 0 END) AS total_value,
         SUM(CASE WHEN status != 'archived' AND price IS NOT NULL THEN 1 ELSE 0 END) AS priced_count
       FROM garments`,
    ),
    env.DB.prepare(`${LIST_SELECT} WHERE g.status != 'archived' ORDER BY g.created_at DESC LIMIT 12`),
    env.DB.prepare(`${LIST_SELECT} WHERE g.is_favorite = 1 AND g.status != 'archived' ORDER BY g.updated_at DESC LIMIT 12`),
    env.DB.prepare("SELECT COUNT(*) AS open_batches FROM import_batches WHERE status = 'open'"),
  ]);
  const { results: aiRows } = await env.DB.prepare(
    "SELECT ai_status, COUNT(*) AS n FROM garments WHERE ai_status IS NOT NULL AND status != 'archived' GROUP BY ai_status",
  ).all<{ ai_status: string; n: number }>();
  const ai: Record<string, number> = Object.fromEntries(AI_STATUSES.map((s) => [s, 0]));
  for (const r of aiRows) ai[r.ai_status] = r.n;
  const c = (counts.results[0] || {}) as Record<string, number>;
  const { results: byCat } = await env.DB.prepare(
    "SELECT COALESCE(category, '未分類') AS category, COUNT(*) AS n FROM garments WHERE status != 'archived' GROUP BY category ORDER BY n DESC",
  ).all();
  return json({
    total: c.total ?? 0,
    review: c.review ?? 0,
    favorites: c.favorites ?? 0,
    missing_image: c.missing_image ?? 0,
    total_value: Math.round((c.total_value ?? 0) * 100) / 100,
    priced_count: c.priced_count ?? 0,
    open_batches: ((batches.results[0] || {}) as Record<string, number>).open_batches ?? 0,
    ai,
    ai_todo: ai.pending_ai + ai.ai_processing + ai.needs_rework + ai.failed,
    ai_review: ai.pending_review,
    ai_done: ai.done,
    by_category: byCat,
    recent: (recent.results as Record<string, unknown>[]).map(garmentToJson),
    favorite_items: (favs.results as Record<string, unknown>[]).map(garmentToJson),
  });
}

// ───────────────────────── 衣櫥分析 ─────────────────────────

interface Bucket {
  name: string;
  n: number;
  value: number;
}
function bump(map: Map<string, Bucket>, name: string, price: number | null) {
  const b = map.get(name) ?? { name, n: 0, value: 0 };
  b.n++;
  if (price !== null) b.value += price;
  map.set(name, b);
}
const sorted = (map: Map<string, Bucket>, limit = 40) =>
  [...map.values()].sort((a, b) => b.n - a.n || b.value - a.value || a.name.localeCompare(b.name)).slice(0, limit).map((b) => ({ ...b, value: Math.round(b.value * 100) / 100 }));

const PRICE_BANDS: [string, number, number][] = [
  ["$500 以下", 0, 500],
  ["$500–999", 500, 1000],
  ["$1,000–1,999", 1000, 2000],
  ["$2,000–2,999", 2000, 3000],
  ["$3,000 或以上", 3000, Infinity],
];

/** 衣櫥分析：數量、價值、分類／顏色／風格／品牌／季節／圖案分佈、價錢分佈、最貴單品、每月新增、穿搭使用率（不含已封存） */
export async function analysis(env: Env) {
  const { results } = await env.DB.prepare(
    `${LIST_SELECT} WHERE g.status != 'archived' ORDER BY g.created_at DESC LIMIT 5000`,
  ).all<Record<string, unknown>>();
  const { results: used } = await env.DB.prepare(
    "SELECT oi.garment_id AS id, COUNT(*) AS n FROM outfit_items oi JOIN outfits o ON o.id = oi.outfit_id WHERE o.status != 'archived' GROUP BY oi.garment_id",
  ).all<{ id: string; n: number }>();
  const usage = new Map(used.map((u) => [u.id, Number(u.n)]));
  const tax = currentTaxonomy();
  const attrName = (id: string) => tax.attributes.find((a) => a.id === id)?.name ?? id;

  const cat = new Map<string, Bucket>();
  const sub = new Map<string, Bucket>();
  const color = new Map<string, Bucket>();
  const style = new Map<string, Bucket>();
  const brand = new Map<string, Bucket>();
  const season = new Map<string, Bucket>();
  const month = new Map<string, Bucket>();
  const extra = new Map<string, Map<string, Bucket>>(); // 其他屬性（圖案、材質、裝飾元素…）
  const bands = PRICE_BANDS.map(([label]) => ({ label, n: 0 }));
  const items = results.map(garmentToJson) as (ReturnType<typeof garmentToJson> & Record<string, unknown>)[];
  let totalValue = 0;
  let priced = 0;
  let favorites = 0;
  let inOutfits = 0;
  let identified = 0;

  for (const g of items) {
    const price = g.price;
    if (price !== null) {
      totalValue += price;
      priced++;
      const i = PRICE_BANDS.findIndex(([, lo, hi]) => price >= lo && price < hi);
      if (i >= 0) bands[i].n++;
    }
    if (g.is_favorite) favorites++;
    if (usage.has(String(g.id))) inOutfits++;
    if (!g.ai_status || g.ai_status === "done") identified++;
    bump(cat, (g.category as string) || "未分類", price);
    if (g.subcategory) bump(sub, String(g.subcategory), price);
    for (const c of splitMulti(g.primary_color)) bump(color, c, price);
    const styles = splitMulti(g.style);
    for (const s of styles.length ? styles : ["未填風格"]) bump(style, s, price);
    bump(brand, (g.brand as string) || "未有品牌", price);
    for (const s of splitMulti(g.season)) bump(season, s, price);
    bump(month, String(g.created_at).slice(0, 7), price);
    for (const [k, v] of Object.entries(g.attributes)) {
      if (["brand_confidence", "original_name", "source_url"].includes(k)) continue;
      const m = extra.get(k) ?? new Map<string, Bucket>();
      for (const x of Array.isArray(v) ? v : [v]) if (x) bump(m, String(x), price);
      extra.set(k, m);
    }
  }
  const brief = (g: Record<string, unknown>) => ({
    id: g.id, name: g.name, display_no: g.display_no ?? null, category: g.category, subcategory: g.subcategory, brand: g.brand, price: g.price,
    primary_image_id: g.primary_image_id ?? null, thumb_image_id: g.thumb_image_id ?? null,
  });
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    total: items.length,
    total_value: round(totalValue),
    priced_count: priced,
    unpriced_count: items.length - priced,
    avg_price: priced ? round(totalValue / priced) : null,
    favorites,
    identified,
    in_outfits: inOutfits,
    never_in_outfit: items.length - inOutfits,
    by_category: sorted(cat),
    by_subcategory: sorted(sub, 12),
    by_color: sorted(color),
    by_style: sorted(style),
    by_brand: sorted(brand, 12),
    by_season: sorted(season),
    by_month: [...month.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(-12).map((b) => ({ ...b, value: round(b.value) })),
    attributes: [...extra.entries()]
      .map(([id, m]) => ({ id, name: attrName(id), options: sorted(m, 10) }))
      .filter((a) => a.options.length)
      .sort((a, b) => b.options.reduce((s, o) => s + o.n, 0) - a.options.reduce((s, o) => s + o.n, 0))
      .slice(0, 6),
    price_bands: bands,
    top_priced: items.filter((g) => g.price !== null).sort((a, b) => (b.price as number) - (a.price as number)).slice(0, 5).map(brief),
    most_worn: items
      .filter((g) => usage.has(String(g.id)))
      .sort((a, b) => usage.get(String(b.id))! - usage.get(String(a.id))!)
      .slice(0, 5)
      .map((g) => ({ ...brief(g), outfits: usage.get(String(g.id)) })),
  };
}

// ───────────────────────── 合併衣物（同一件衣服的透明圖與原相） ─────────────────────────

/**
 * 把 source 的圖片併入 target，然後刪除 source。
 * - 圖片檔案不動（R2 key 不變），只改 D1 的 garment_id；兩邊有同一張相（同類型、SHA-256 相同）時保留 target 那張。
 * - 有透明圖時以透明圖作主圖；target 未填的資料欄位由 source 補上（已填的不覆寫）。
 * - source 出現過的穿搭改為指向 target。
 */
export async function mergeGarments(env: Env, actor: Actor, targetId: string, sourceId: string) {
  if (!sourceId || targetId === sourceId) throw new HttpError(400, "bad_merge", "請選擇另一件衣物");
  const [t, s] = await Promise.all(
    [targetId, sourceId].map((id) => env.DB.prepare("SELECT * FROM garments WHERE id = ?").bind(id).first<Record<string, unknown>>()),
  );
  if (!t || !s) throw new HttpError(404, "garment_not_found", "找不到這件衣物");
  if (await env.DB.prepare("SELECT look_id FROM doll_look_items WHERE garment_id = ? LIMIT 1").bind(sourceId).first()) throw new HttpError(409, "garment_in_use", "來源衣物仍被已保存造型引用，請保留此衣物及圖片版本");
  if (t.status === "archived" || s.status === "archived") throw new HttpError(409, "garment_archived", "已封存的衣物不能合併");

  const { results: tImgs } = await env.DB.prepare("SELECT id, image_type, sha256 FROM garment_images WHERE garment_id = ?").bind(targetId).all<{ id: string; image_type: string; sha256: string }>();
  const { results: sImgs } = await env.DB.prepare("SELECT id, image_type, sha256, r2_key, derived_from FROM garment_images WHERE garment_id = ?")
    .bind(sourceId)
    .all<{ id: string; image_type: string; sha256: string; r2_key: string; derived_from: string | null }>();
  const have = new Set(tImgs.map((i) => `${i.image_type}:${i.sha256}`));
  const dupIds = new Set(sImgs.filter((i) => have.has(`${i.image_type}:${i.sha256}`)).map((i) => i.id));
  // 重複圖片連同它的縮圖一併捨棄
  const drop = sImgs.filter((i) => dupIds.has(i.id) || (i.derived_from && dupIds.has(i.derived_from)));
  const dropIds = new Set(drop.map((i) => i.id));
  const move = sImgs.filter((i) => !dropIds.has(i.id));

  // target 未填的欄位由 source 補上
  const sets: string[] = [];
  const binds: unknown[] = [];
  const empty = (v: unknown) => v === null || v === undefined || v === "" || v === "[]";
  for (const f of ["category", "subcategory", "brand", "style", "primary_color", "secondary_colors", "pattern", "season", "notes", "price"]) {
    if (empty(t[f]) && !empty(s[f])) {
      sets.push(`${f} = ?`);
      binds.push(s[f]);
    }
  }
  if (Number(t.name_is_placeholder) === 1 && Number(s.name_is_placeholder) !== 1 && s.name) {
    sets.push("name = ?", "name_is_placeholder = 0");
    binds.push(s.name);
  }
  const attrs = { ...parseAttributes(s.attributes), ...parseAttributes(t.attributes) };
  if (Object.keys(attrs).length && JSON.stringify(attrs) !== JSON.stringify(parseAttributes(t.attributes))) {
    sets.push("attributes = ?");
    binds.push(JSON.stringify(attrs));
  }
  if (Number(s.is_favorite) === 1) sets.push("is_favorite = 1");
  // Merging photos is not identification. Either unfinished record keeps the result in the AI queue.
  const needsAi = [t, s].some((g) => g.ai_status && g.ai_status !== "done");
  if (needsAi) sets.push("ai_status = 'pending_ai'", "ai_claimed_at = NULL", "ai_claimed_by = NULL", "ai_error = NULL");
  const locks = [...new Set([...parseJsonArray(t.locked_fields), ...parseJsonArray(s.locked_fields)])];
  sets.push("locked_fields = ?");
  binds.push(JSON.stringify(locks));
  const now = nowIso();
  sets.push("updated_at = ?", "version = version + 1");
  binds.push(now);

  const stmts: D1PreparedStatement[] = [];
  for (const i of drop) stmts.push(env.DB.prepare("DELETE FROM garment_images WHERE id = ?").bind(i.id));
  if (move.length) stmts.push(env.DB.prepare("UPDATE garment_images SET garment_id = ?, is_primary = 0 WHERE garment_id = ?").bind(targetId, sourceId));
  // 主圖：透明圖優先，其次沿用 target 原本的主圖
  stmts.push(env.DB.prepare("UPDATE garment_images SET is_primary = 0 WHERE garment_id = ?").bind(targetId));
  stmts.push(
    env.DB.prepare(
      `UPDATE garment_images SET is_primary = 1 WHERE id = (
         SELECT id FROM garment_images WHERE garment_id = ? AND image_type != 'thumbnail' AND mime_type NOT IN ('image/heic','image/heif')
         ORDER BY CASE WHEN image_type = 'processed' AND has_alpha = 1 THEN 0 WHEN image_type = 'processed' THEN 1 ELSE 2 END,
                  CASE WHEN id IN (${tImgs.map(() => "?").join(",") || "''"}) THEN 0 ELSE 1 END, created_at LIMIT 1)`,
    ).bind(targetId, ...tImgs.map((i) => i.id)),
  );
  stmts.push(env.DB.prepare("UPDATE OR IGNORE outfit_items SET garment_id = ? WHERE garment_id = ?").bind(targetId, sourceId));
  stmts.push(env.DB.prepare("UPDATE import_jobs SET garment_id = ? WHERE garment_id = ?").bind(targetId, sourceId));
  stmts.push(env.DB.prepare(`UPDATE garments SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, targetId));
  // Retain links for moved images; refresh stale AI suggestions after the image set changes.
  stmts.push(env.DB.prepare("DELETE FROM ai_image_links WHERE garment_id IN (?, ?) AND image_id NOT IN (SELECT id FROM garment_images)").bind(targetId, sourceId));
  stmts.push(env.DB.prepare("UPDATE ai_image_links SET garment_id = ? WHERE garment_id = ?").bind(targetId, sourceId));
  stmts.push(env.DB.prepare("UPDATE ai_suggestions SET status = 'superseded' WHERE garment_id = ? AND status IN ('submitted','valid')").bind(targetId));
  stmts.push(env.DB.prepare("DELETE FROM garments WHERE id = ?").bind(sourceId));
  await env.DB.batch(stmts);
  if (drop.length) await env.IMAGES.delete(drop.map((d) => d.r2_key)).catch((e) => console.error("merge: R2 delete failed", e));
  await audit(env, actor, "garment.merge", targetId, { source: sourceId, moved: move.length, dropped: drop.length });
  return { garment_id: targetId, merged_from: sourceId, images_moved: move.length, duplicates_dropped: drop.length };
}

// ───── Phase 3.8B 增量同步 ─────
/** 穩定的 JSON（鍵按字母排序），用來計算每件衣物的指紋 */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + stableJson((v as Record<string, unknown>)[k])).join(",") + "}";
  return JSON.stringify(v ?? null);
}
/** FNV-1a 64 位元（兩個 32 位元）→ 16 位十六進位，足夠分辨同一件衣物的不同版本 */
function fnv(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822519); }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}
const SYNC_SELECT = LIST_SELECT.replace("FROM garments g", `,
    (SELECT group_concat(th.image_id || ':' || th.version, ',') FROM garment_thumbnails th WHERE th.garment_id = g.id) AS thumb_version,
    (SELECT p.file_size FROM garment_images p WHERE p.garment_id = g.id AND p.is_primary = 1 LIMIT 1) AS primary_bytes
  FROM garments g`);
/**
 * 同步清單（manifest）：所有未封存衣物的 [id, 指紋]。指紋由整行資料（包括圖片 ID、縮圖版本）計算，
 * 任何欄位、收藏、圖片或縮圖改動都會改變指紋。刪除／封存的衣物不在清單內＝本機刪除（等同 tombstone，不需要新資料表）。
 * digest 不變時只回傳 { same: true }，不傳送清單。
 */
export async function syncManifest(env: Env, since?: string | null) {
  const { results } = await env.DB.prepare(`${SYNC_SELECT} WHERE g.status != 'archived' ORDER BY g.id`).all<Record<string, unknown>>();
  const items: [string, string][] = results.map((r) => [String(r.id), fnv(stableJson(garmentToJson(r)))]);
  const digest = fnv(items.map((x) => x.join(":")).join("|")) + "-" + items.length;
  const at = nowIso();
  if (since && since === digest) return { same: true, digest, count: items.length, at };
  return { same: false, digest, count: items.length, at, items };
}
/** 只讀取指定衣物的完整資料（最多 200 件）；已刪除或封存的不會回傳 */
export async function syncRows(env: Env, ids: unknown) {
  const list = (Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === "string" && /^[\w-]{1,60}$/.test(x)).slice(0, 200);
  if (!list.length) return { garments: [] };
  const { results } = await env.DB.prepare(`${SYNC_SELECT} WHERE g.status != 'archived' AND g.id IN (${list.map(() => "?").join(",")})`).bind(...list).all<Record<string, unknown>>();
  return { garments: results.map((r) => { const g = garmentToJson(r); return { ...g, _fp: fnv(stableJson(garmentToJson(r))) }; }) };
}
