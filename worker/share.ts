/**
 * Phase 3.9B.1：衣櫃分享（可撤銷的唯讀連結）。
 *
 * 私隱原則：
 * - 預設私有。只有使用者建立的連結可以讀取，而且只讀取「公開投影」：衣物按 scope／清單篩選（封存衣物永不公開），
 *   欄位按白名單輸出（伺服器端），不會把私人 API 回應直接轉出。
 * - 連結權杖只保存 SHA-256；撤銷、到期或重新產生後立即失效（回覆 404，不透露連結曾經存在）。
 * - 圖片：只提供 D1 縮圖（重新編碼的 WebP）及去背透明圖（App 產生的 PNG／WebP），永不提供原始相片（可能有人像、EXIF／GPS）。
 *   公開圖片端點會再核對該衣物仍在分享範圍內。
 * - 公開分析只計算公開範圍內的衣物；價格／穿著次數只在使用者選擇公開該欄位時才計入。
 * - 公開回應 no-store；圖片短快取（private, 60 秒），撤銷後很快失效。每條連結每分鐘最多 120 次讀取（簡單限制）。
 * - 分享不等於允許匯入（衣物套件匯入見 Phase 3.9B.2）。
 */
import { hasTable } from "./schema";
import { transparentImageSql } from "./transparent";
import { Actor, Env, HttpError, audit, json, newId, nowIso, randomToken, sha256Hex, str } from "./util";

export const SHARE_FIELDS = ["name", "category", "subcategory", "brand", "colors", "style", "season", "pattern", "price", "notes", "attributes", "wear", "transparent_image"] as const;
export type ShareField = (typeof SHARE_FIELDS)[number];
export const DEFAULT_FIELDS: ShareField[] = ["name", "category", "subcategory", "brand", "colors", "style", "season", "transparent_image"];
export const SHARE_FIELD_LABEL: Record<ShareField, string> = { name: "名稱", category: "分類", subcategory: "子分類", brand: "品牌", colors: "顏色", style: "風格", season: "季節", pattern: "圖案", price: "價格", notes: "備註", attributes: "其他屬性", wear: "穿著次數", transparent_image: "去背高清圖" };
interface Options { analytics: boolean }
interface ShareRow { id: string; token_hash: string; title: string; message: string | null; scope: "selected" | "all"; fields: string; options: string; expires_at: string | null; revoked_at: string | null; view_count: number; last_viewed_at: string | null; created_at: string; updated_at: string }
const MAX_LINKS = 30, MAX_ITEMS = 2000, RATE = 120;

const parseFields = (v: unknown): ShareField[] => { try { const a = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(a) ? SHARE_FIELDS.filter((f) => a.includes(f)) : DEFAULT_FIELDS; } catch { return DEFAULT_FIELDS; } };
const parseOptions = (v: unknown): Options => { try { const o = typeof v === "string" ? JSON.parse(v) : v; return { analytics: !!(o as Options)?.analytics }; } catch { return { analytics: false }; } };
const ensure = async (env: Env) => { if (!(await hasTable(env, "share_links"))) throw new HttpError(503, "share_unavailable", "分享功能需要先套用資料庫遷移 0016"); };
const active = (r: ShareRow) => !r.revoked_at && (!r.expires_at || r.expires_at > nowIso());

function shape(r: ShareRow, items: number) {
  return { id: r.id, title: r.title, message: r.message, scope: r.scope, fields: parseFields(r.fields), options: parseOptions(r.options), expires_at: r.expires_at, revoked_at: r.revoked_at, active: active(r), item_count: items, view_count: r.view_count, last_viewed_at: r.last_viewed_at, created_at: r.created_at, updated_at: r.updated_at };
}
async function itemIds(env: Env, id: string) { return (await env.DB.prepare("SELECT garment_id FROM share_link_items WHERE share_id = ?").bind(id).all<{ garment_id: string }>()).results.map((r) => r.garment_id); }

// ───── 擁有者管理 ─────
export async function listShares(env: Env) {
  await ensure(env);
  const rows = (await env.DB.prepare("SELECT * FROM share_links ORDER BY created_at DESC").all<ShareRow>()).results;
  const counts = new Map((await env.DB.prepare("SELECT share_id, COUNT(*) AS n FROM share_link_items GROUP BY share_id").all<{ share_id: string; n: number }>()).results.map((r) => [r.share_id, Number(r.n)]));
  return { shares: rows.map((r) => shape(r, counts.get(r.id) ?? 0)) };
}
export async function getShare(env: Env, id: string) {
  await ensure(env);
  const r = await env.DB.prepare("SELECT * FROM share_links WHERE id = ?").bind(id).first<ShareRow>();
  if (!r) throw new HttpError(404, "share_not_found", "找不到這條分享連結");
  const ids = await itemIds(env, id);
  return { ...shape(r, ids.length), garment_ids: ids };
}
async function validItems(env: Env, v: unknown): Promise<string[]> {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_ITEMS) throw new HttpError(400, "bad_items", `衣物清單格式錯誤（最多 ${MAX_ITEMS} 件）`);
  const ids = [...new Set(v.filter((x): x is string => typeof x === "string" && /^[\w-]{1,64}$/.test(x)))];
  const ok = new Set<string>();
  for (let i = 0; i < ids.length; i += 80) { const part = ids.slice(i, i + 80); for (const r of (await env.DB.prepare(`SELECT id FROM garments WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ id: string }>()).results) ok.add(r.id); }
  return ids.filter((x) => ok.has(x));
}
const expiry = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) throw new HttpError(400, "bad_expiry", "到期日不正確");
  if (t < Date.now()) throw new HttpError(400, "bad_expiry", "到期日已過");
  return new Date(Math.min(t, Date.now() + 366 * 86400_000)).toISOString();
};
export async function createShare(env: Env, actor: Actor, input: Record<string, unknown>, origin: string) {
  await ensure(env);
  if (((await env.DB.prepare("SELECT COUNT(*) AS n FROM share_links WHERE revoked_at IS NULL").first<{ n: number }>())?.n ?? 0) >= MAX_LINKS) throw new HttpError(400, "too_many_links", `最多 ${MAX_LINKS} 條有效分享連結，請先撤銷部分`);
  const scope = input.scope === "all" ? "all" : "selected";
  const items = await validItems(env, input.garment_ids);
  if (scope === "selected" && !items.length) throw new HttpError(400, "no_items", "請選擇最少一件要公開的衣物");
  const token = randomToken(24), id = newId("shr"), now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO share_links (id, token_hash, title, message, scope, fields, options, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(id, await sha256Hex(token), str(input.title, 60) || "我的衣櫃", str(input.message, 300), scope, JSON.stringify(input.fields === undefined ? DEFAULT_FIELDS : parseFields(input.fields)), JSON.stringify(parseOptions(input.options ?? {})), expiry(input.expires_at), now, now),
    ...items.map((g) => env.DB.prepare("INSERT INTO share_link_items (share_id, garment_id) VALUES (?,?)").bind(id, g)),
  ]);
  await audit(env, actor, "share.create", id, { scope, items: items.length });
  return { ...(await getShare(env, id)), token, url: `${origin}/s/${token}` };
}
export async function updateShare(env: Env, actor: Actor, id: string, input: Record<string, unknown>) {
  const cur = await getShare(env, id);
  const sets: string[] = [], binds: unknown[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  if (has("title")) { sets.push("title = ?"); binds.push(str(input.title, 60) || "我的衣櫃"); }
  if (has("message")) { sets.push("message = ?"); binds.push(str(input.message, 300)); }
  if (has("fields")) { sets.push("fields = ?"); binds.push(JSON.stringify(parseFields(input.fields))); }
  if (has("options")) { sets.push("options = ?"); binds.push(JSON.stringify(parseOptions(input.options))); }
  if (has("expires_at")) { sets.push("expires_at = ?"); binds.push(expiry(input.expires_at)); }
  const scope = has("scope") ? (input.scope === "all" ? "all" : "selected") : cur.scope;
  if (has("scope")) { sets.push("scope = ?"); binds.push(scope); }
  const stmts: D1PreparedStatement[] = [];
  if (has("garment_ids")) {
    const items = await validItems(env, input.garment_ids);
    if (scope === "selected" && !items.length) throw new HttpError(400, "no_items", "請選擇最少一件要公開的衣物");
    stmts.push(env.DB.prepare("DELETE FROM share_link_items WHERE share_id = ?").bind(id), ...items.map((g) => env.DB.prepare("INSERT INTO share_link_items (share_id, garment_id) VALUES (?,?)").bind(id, g)));
  } else if (has("scope") && scope === "selected" && cur.scope === "all") throw new HttpError(400, "no_items", "改為「只公開選擇的衣物」時請同時選擇衣物");
  sets.push("updated_at = ?"); binds.push(nowIso());
  await env.DB.batch([env.DB.prepare(`UPDATE share_links SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id), ...stmts]);
  await audit(env, actor, "share.update", id);
  return getShare(env, id);
}
export async function revokeShare(env: Env, actor: Actor, id: string) {
  await getShare(env, id);
  await env.DB.prepare("UPDATE share_links SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?").bind(nowIso(), nowIso(), id).run();
  await audit(env, actor, "share.revoke", id);
  return getShare(env, id);
}
/** 重新產生連結：舊連結即時失效；撤銷的連結重新產生＝重新啟用 */
export async function rotateShare(env: Env, actor: Actor, id: string, origin: string) {
  await getShare(env, id);
  const token = randomToken(24);
  await env.DB.prepare("UPDATE share_links SET token_hash = ?, revoked_at = NULL, updated_at = ? WHERE id = ?").bind(await sha256Hex(token), nowIso(), id).run();
  await audit(env, actor, "share.rotate", id);
  return { ...(await getShare(env, id)), token, url: `${origin}/s/${token}` };
}
export async function deleteShare(env: Env, actor: Actor, id: string) {
  await getShare(env, id);
  await env.DB.prepare("DELETE FROM share_links WHERE id = ?").bind(id).run();
  await audit(env, actor, "share.delete", id);
  return { deleted: true };
}

// ───── 公開讀取 ─────
async function byToken(env: Env, token: string): Promise<ShareRow> {
  if (!(await hasTable(env, "share_links")) || !/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw new HttpError(404, "share_not_found", "連結無效或已停止分享");
  const r = await env.DB.prepare("SELECT * FROM share_links WHERE token_hash = ?").bind(await sha256Hex(token)).first<ShareRow>();
  if (!r || !active(r)) throw new HttpError(404, "share_not_found", "連結無效或已停止分享");
  return r;
}
/** 公開範圍內的衣物 ID（封存除外） */
async function publicIds(env: Env, r: ShareRow): Promise<string[]> {
  const sql = r.scope === "selected"
    ? "SELECT g.id FROM share_link_items i JOIN garments g ON g.id = i.garment_id WHERE i.share_id = ? AND g.status != 'archived' ORDER BY g.created_at DESC"
    : "SELECT g.id FROM garments g WHERE g.status != 'archived' AND g.id NOT IN (SELECT garment_id FROM share_link_items WHERE share_id = ?) ORDER BY g.created_at DESC";
  return (await env.DB.prepare(sql).bind(r.id).all<{ id: string }>()).results.map((x) => x.id);
}
const split = (v: unknown) => (typeof v === "string" && v ? v.split(/[,，、|]/).map((s) => s.trim()).filter(Boolean) : []);
type G = Record<string, unknown>;
/** 按白名單投影一件衣物（只輸出選擇公開的欄位） */
export function project(g: G, fields: ShareField[], wear: number | null, thumb: boolean, hd: boolean) {
  const f = new Set(fields);
  const out: Record<string, unknown> = { id: g.id };
  if (f.has("name")) out.name = g.name;
  if (f.has("category")) out.category = g.category ?? null;
  if (f.has("subcategory")) out.subcategory = g.subcategory ?? null;
  if (f.has("brand")) out.brand = g.brand ?? null;
  if (f.has("colors")) out.colors = [...split(g.primary_color), ...split(g.secondary_colors)];
  if (f.has("style")) out.style = g.style ?? null;
  if (f.has("season")) out.season = g.season ?? null;
  if (f.has("pattern")) out.pattern = g.pattern ?? null;
  if (f.has("price")) out.price = g.price ?? null;
  if (f.has("notes")) out.notes = g.notes ?? null;
  if (f.has("attributes")) { try { out.attributes = g.attributes ? JSON.parse(String(g.attributes)) : {}; } catch { out.attributes = {}; } }
  if (f.has("wear")) out.wear_count = wear ?? 0;
  out.has_thumb = thumb;
  out.has_image = f.has("transparent_image") && hd;
  return out;
}
async function rateCheck(env: Env, r: ShareRow) {
  const minute = new Date().toISOString().slice(0, 16);
  const k = `share_rate:${r.id}:${minute}`;
  const row = await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value").bind(k, nowIso()).first<{ value: string }>().catch(() => null);
  if (row && Number(row.value) > RATE) throw new HttpError(429, "rate_limited", "瀏覽次數太多，請稍後再試");
  // 清理舊的計數（同一連結其他分鐘）
  if (row && Number(row.value) === 1) await env.DB.prepare("DELETE FROM app_settings WHERE key LIKE ? AND key != ?").bind(`share_rate:${r.id}:%`, k).run().catch(() => undefined);
}
export async function publicShare(env: Env, token: string) {
  const r = await byToken(env, token);
  await rateCheck(env, r);
  const fields = parseFields(r.fields), opts = parseOptions(r.options);
  const ids = await publicIds(env, r);
  const rows: G[] = [], thumbs = new Set<string>(), hds = new Set<string>(), wear = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80), ph = part.map(() => "?").join(",");
    rows.push(...(await env.DB.prepare(`SELECT g.*, ${transparentImageSql()} AS t_img FROM garments g WHERE g.id IN (${ph})`).bind(...part).all<G>()).results);
    for (const t of (await env.DB.prepare(`SELECT DISTINCT garment_id FROM garment_thumbnails WHERE garment_id IN (${ph})`).bind(...part).all<{ garment_id: string }>()).results) thumbs.add(t.garment_id);
    if (fields.includes("wear") && (await hasTable(env, "diary_items"))) for (const w of (await env.DB.prepare(`SELECT garment_id, COUNT(DISTINCT entry_id) AS n FROM diary_items i JOIN diary_entries e ON e.id = i.entry_id WHERE e.kind = 'worn' AND i.garment_id IN (${ph}) GROUP BY garment_id`).bind(...part).all<{ garment_id: string; n: number }>().catch(() => ({ results: [] as { garment_id: string; n: number }[] }))).results) wear.set(w.garment_id, Number(w.n));
  }
  for (const g of rows) if (g.t_img) hds.add(String(g.id));
  const order = new Map(ids.map((x, i) => [x, i]));
  rows.sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
  const garments = rows.map((g) => project(g, fields, fields.includes("wear") ? wear.get(String(g.id)) ?? 0 : null, thumbs.has(String(g.id)), hds.has(String(g.id))));
  await env.DB.prepare("UPDATE share_links SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?").bind(nowIso(), r.id).run();
  return { title: r.title, message: r.message, fields, expires_at: r.expires_at, garments, analytics: opts.analytics ? analytics(rows, fields, wear) : null };
}
/** 公開分析：只計算公開範圍內的衣物；價格／穿著次數只在對應欄位公開時才計算 */
export function analytics(rows: G[], fields: ShareField[], wear: Map<string, number>) {
  const f = new Set(fields);
  const count = (key: (g: G) => string[]) => { const m = new Map<string, number>(); for (const g of rows) for (const k of key(g)) m.set(k, (m.get(k) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, n]) => ({ label, n })); };
  const out: Record<string, unknown> = { total: rows.length };
  if (f.has("category")) out.by_category = count((g) => (g.category ? [String(g.category)] : []));
  if (f.has("colors")) out.by_color = count((g) => split(g.primary_color).slice(0, 1));
  if (f.has("brand")) out.by_brand = count((g) => (g.brand ? [String(g.brand)] : []));
  if (f.has("style")) out.by_style = count((g) => split(g.style));
  if (f.has("price")) { const ps = rows.map((g) => Number(g.price)).filter((n) => Number.isFinite(n) && n > 0); out.price = { priced: ps.length, total: Math.round(ps.reduce((a, b) => a + b, 0)), average: ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : null }; }
  if (f.has("wear")) out.most_worn = [...wear.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, n]) => ({ id, n }));
  return out;
}
/** 公開圖片：thumb＝D1 縮圖（重新編碼 WebP）；image＝去背透明圖（只在公開該欄位時）。永不提供原始相片 */
export async function publicImage(req: Request, env: Env, token: string, garmentId: string, kind: "thumb" | "image"): Promise<Response> {
  const r = await byToken(env, token);
  if (!(await publicIds(env, r)).includes(garmentId)) throw new HttpError(404, "not_shared", "這件衣物沒有公開");
  const headers = (mime: string, etag: string) => ({ "content-type": mime, "cache-control": "private, max-age=60", etag, "x-content-type-options": "nosniff" });
  if (kind === "thumb") {
    const t = await env.DB.prepare("SELECT data, mime_type, version FROM garment_thumbnails WHERE garment_id = ? ORDER BY has_alpha DESC, updated_at DESC LIMIT 1").bind(garmentId).first<{ data: ArrayBuffer; mime_type: string; version: string }>();
    if (!t) throw new HttpError(404, "no_thumb", "未有縮圖");
    const etag = `"s-${t.version}"`;
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: headers(t.mime_type, etag) });
    return new Response(new Uint8Array(t.data), { headers: headers(t.mime_type, etag) });
  }
  if (!parseFields(r.fields).includes("transparent_image")) throw new HttpError(404, "not_shared", "沒有公開高清圖");
  const img = await env.DB.prepare(`SELECT r2_key, mime_type, sha256 FROM garment_images WHERE id = ${transparentImageSql("?")}`).bind(garmentId).first<{ r2_key: string; mime_type: string; sha256: string }>();
  if (!img) throw new HttpError(404, "no_image", "未有去背圖");
  const etag = `"s-${img.sha256.slice(0, 24)}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: headers(img.mime_type, etag) });
  const obj = await env.IMAGES.get(img.r2_key);
  if (!obj) throw new HttpError(404, "object_missing", "圖片暫時未能讀取");
  return new Response(obj.body, { headers: headers(img.mime_type, etag) });
}
export const publicJson = (data: unknown) => json(data, 200, { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
