/**
 * Phase 3.9A.1：穿搭日誌（每日穿搭紀錄、日曆、穿著統計）。
 * - 日期一律使用手機傳來的本地日期字串（YYYY-MM-DD），伺服器不作 UTC 轉換，深夜紀錄不會移到錯誤日期。
 * - 只有 kind='worn'（已穿著）計入穿著統計；同一件衣物同一日只計一次；套裝部件不當作多件衣物。
 * - 歷史完整性：每筆紀錄保存衣物當時的名稱、分類及小縮圖快照（diary_snaps 去重共用，不複製高清圖）。
 * - 真人照片：手機已壓縮並移除 EXIF／GPS；檔案存 R2 diary/ 路徑，小縮圖存 D1；全部預設私人。
 */
import { parseImage } from "./images";
import { Actor, Env, HttpError, audit, newId, nowIso, sha256Hex, str } from "./util";

export type DiaryKind = "worn" | "planned" | "inspiration";
const KINDS: DiaryKind[] = ["worn", "planned", "inspiration"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 60, MAX_PHOTOS = 12, MAX_THUMB = 64 * 1024;
const isDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));

export interface DiaryItemIn { garment_id: string; part?: string | null }
export interface DiaryInput {
  title?: unknown; worn_date?: unknown; worn_time?: unknown; kind?: unknown; outfit_id?: unknown; look_id?: unknown;
  occasion?: unknown; location?: unknown; weather?: unknown; tags?: unknown; notes?: unknown; rating?: unknown; is_favorite?: unknown;
  tz?: unknown; items?: unknown; cover_photo_id?: unknown; photo_order?: unknown; base_updated_at?: unknown;
  /** 帶入已保存造型的衣物清單（不修改原造型） */
  import_items?: unknown;
}
interface EntryRow { id: string; title: string | null; worn_date: string; worn_time: string | null; kind: DiaryKind; outfit_id: string | null; look_id: string | null; source_name: string | null; occasion: string | null; location: string | null; weather: string | null; tags: string | null; notes: string | null; rating: number | null; is_favorite: number; cover_photo_id: string | null; tz: string | null; created_at: string; updated_at: string }
interface ItemRow { entry_id: string; garment_id: string; part: string; position: number; name: string; category: string | null; subcategory: string | null; style: string | null; snap_id: string | null }
interface PhotoRow { id: string; entry_id: string; width: number; height: number; position: number; file_size: number }

const tagsOf = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，#\s]+/) : []).map((x) => String(x).trim().slice(0, 20)).filter(Boolean).slice(0, 12);
const parseTags = (s: string | null): string[] => { try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

function shape(e: EntryRow, items: ItemRow[], photos: PhotoRow[]) {
  const ph = photos.filter((p) => p.entry_id === e.id).sort((a, b) => a.position - b.position);
  return {
    ...e, is_favorite: !!e.is_favorite, tags: parseTags(e.tags),
    items: items.filter((i) => i.entry_id === e.id).sort((a, b) => a.position - b.position).map(({ entry_id: _e, ...i }) => i),
    photos: ph.map(({ entry_id: _e, ...p }) => p),
    cover_photo_id: e.cover_photo_id && ph.some((p) => p.id === e.cover_photo_id) ? e.cover_photo_id : ph[0]?.id ?? null,
    garment_count: new Set(items.filter((i) => i.entry_id === e.id).map((i) => i.garment_id)).size,
  };
}
export type DiaryEntry = ReturnType<typeof shape>;

async function loadMany(env: Env, entries: EntryRow[]): Promise<DiaryEntry[]> {
  if (!entries.length) return [];
  const out: DiaryEntry[] = [];
  for (let i = 0; i < entries.length; i += 80) {
    const part = entries.slice(i, i + 80), ph = part.map(() => "?").join(","), ids = part.map((e) => e.id);
    const [items, photos] = await Promise.all([
      env.DB.prepare(`SELECT * FROM diary_items WHERE entry_id IN (${ph})`).bind(...ids).all<ItemRow>(),
      env.DB.prepare(`SELECT id, entry_id, width, height, position, file_size FROM diary_photos WHERE entry_id IN (${ph})`).bind(...ids).all<PhotoRow>(),
    ]);
    for (const e of part) out.push(shape(e, items.results, photos.results));
  }
  return out;
}

export async function listDiary(env: Env, p: URLSearchParams) {
  const where: string[] = [], args: unknown[] = [];
  const from = p.get("from"), to = p.get("to"), month = p.get("month"), kind = p.get("kind");
  if (month && /^\d{4}-\d{2}$/.test(month)) { where.push("worn_date LIKE ?"); args.push(month + "-%"); }
  if (isDate(from)) { where.push("worn_date >= ?"); args.push(from); }
  if (isDate(to)) { where.push("worn_date <= ?"); args.push(to); }
  if (kind && KINDS.includes(kind as DiaryKind)) { where.push("kind = ?"); args.push(kind); }
  if (p.get("favorite") === "1") where.push("is_favorite = 1");
  const gid = p.get("garment");
  if (gid) { where.push("id IN (SELECT entry_id FROM diary_items WHERE garment_id = ?)"); args.push(gid); }
  const q = p.get("q")?.trim();
  if (q) {
    const like = "%" + q.replace(/[%_]/g, "") + "%";
    where.push("(title LIKE ? OR occasion LIKE ? OR tags LIKE ? OR notes LIKE ? OR location LIKE ? OR id IN (SELECT entry_id FROM diary_items WHERE name LIKE ?))");
    args.push(like, like, like, like, like, like);
  }
  const limit = Math.min(500, Math.max(1, Number(p.get("limit")) || 200));
  const order = p.get("order") === "asc" ? "ASC" : "DESC";
  const rows = await env.DB.prepare(`SELECT * FROM diary_entries ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY worn_date ${order}, COALESCE(worn_time,'') ${order}, created_at ${order} LIMIT ?`).bind(...args, limit).all<EntryRow>();
  return { entries: await loadMany(env, rows.results) };
}

export async function getEntry(env: Env, id: string) {
  const e = await env.DB.prepare("SELECT * FROM diary_entries WHERE id = ?").bind(id).first<EntryRow>();
  if (!e) throw new HttpError(404, "diary_not_found", "找不到這筆穿搭紀錄");
  return (await loadMany(env, [e]))[0];
}

/** 衣物縮圖快照：由目前的 D1 小縮圖複製（按來源雜湊去重） */
async function snapFor(env: Env, garmentId: string): Promise<string | null> {
  const t = await env.DB.prepare("SELECT t.source_sha256 AS sha FROM garment_thumbnails t JOIN garment_images i ON i.id = t.image_id WHERE t.garment_id = ? ORDER BY i.is_primary DESC, (i.image_type = 'processed') DESC LIMIT 1").bind(garmentId).first<{ sha: string }>().catch(() => null);
  if (!t) return null;
  const id = garmentId + "-" + t.sha.slice(0, 16);
  await env.DB.prepare("INSERT OR IGNORE INTO diary_snaps (id, garment_id, data, mime_type, created_at) SELECT ?, t.garment_id, t.data, t.mime_type, ? FROM garment_thumbnails t WHERE t.garment_id = ? AND t.source_sha256 = ? LIMIT 1").bind(id, nowIso(), garmentId, t.sha).run();
  return id;
}

/** 由已保存造型取得衣物清單（只讀，不修改原造型） */
async function itemsFromSource(env: Env, outfitId: string | null, lookId: string | null): Promise<{ items: DiaryItemIn[]; name: string | null }> {
  if (outfitId) {
    const o = await env.DB.prepare("SELECT name FROM outfits WHERE id = ?").bind(outfitId).first<{ name: string }>();
    if (!o) throw new HttpError(404, "outfit_not_found", "找不到這套衣服配搭");
    const r = await env.DB.prepare("SELECT garment_id FROM outfit_items WHERE outfit_id = ? ORDER BY position").bind(outfitId).all<{ garment_id: string }>();
    return { items: r.results.map((x) => ({ garment_id: x.garment_id })), name: o.name };
  }
  if (lookId) {
    const l = await env.DB.prepare("SELECT name FROM doll_looks WHERE id = ?").bind(lookId).first<{ name: string }>();
    if (!l) throw new HttpError(404, "look_not_found", "找不到這個角色造型");
    const r = await env.DB.prepare("SELECT garment_id FROM doll_look_items WHERE look_id = ? ORDER BY z").bind(lookId).all<{ garment_id: string }>();
    return { items: r.results.map((x) => ({ garment_id: x.garment_id })), name: l.name };
  }
  return { items: [], name: null };
}

function fields(input: DiaryInput, cur?: EntryRow) {
  const has = (k: keyof DiaryInput) => Object.prototype.hasOwnProperty.call(input, k);
  const pick = <T>(k: keyof DiaryInput, fn: (v: unknown) => T, fallback: T) => (has(k) ? fn(input[k]) : fallback);
  const date = pick("worn_date", (v) => v, cur?.worn_date as unknown);
  if (!isDate(date)) throw new HttpError(400, "bad_date", "請選擇日期（YYYY-MM-DD）");
  const kind = pick("kind", (v) => v, (cur?.kind ?? "worn") as unknown);
  if (!KINDS.includes(kind as DiaryKind)) throw new HttpError(400, "bad_kind", "穿搭類型必須是已穿著、計劃穿搭或靈感穿搭");
  const time = pick("worn_time", (v) => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : null), cur?.worn_time ?? null);
  const rating = pick("rating", (v) => (v == null || v === "" ? null : Math.min(5, Math.max(0, Math.round(Number(v)) || 0))), cur?.rating ?? null);
  return {
    title: pick("title", (v) => str(v, 60), cur?.title ?? null), worn_date: date as string, worn_time: time, kind: kind as DiaryKind,
    occasion: pick("occasion", (v) => str(v, 40), cur?.occasion ?? null), location: pick("location", (v) => str(v, 80), cur?.location ?? null),
    weather: pick("weather", (v) => str(v, 40), cur?.weather ?? null), notes: pick("notes", (v) => str(v, 2000), cur?.notes ?? null),
    tags: pick("tags", (v) => JSON.stringify(tagsOf(v)), cur?.tags ?? "[]"), rating,
    is_favorite: pick("is_favorite", (v) => (v ? 1 : 0), cur?.is_favorite ?? 0), tz: pick("tz", (v) => str(v, 60), cur?.tz ?? null),
  };
}

/** 寫入衣物清單：已在紀錄內的衣物保留原本快照（不改寫歷史）；新加入的衣物取目前名稱、分類及縮圖 */
async function writeItems(env: Env, entryId: string, list: DiaryItemIn[]) {
  const want: DiaryItemIn[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    if (!it || typeof it.garment_id !== "string" || !/^[\w-]{1,64}$/.test(it.garment_id)) continue;
    const part = typeof it.part === "string" ? it.part.slice(0, 64) : "";
    const k = it.garment_id + "|" + part;
    if (seen.has(k)) continue;
    seen.add(k); want.push({ garment_id: it.garment_id, part });
  }
  if (want.length > MAX_ITEMS) throw new HttpError(400, "too_many_items", `每筆紀錄最多 ${MAX_ITEMS} 件衣物`);
  const old = (await env.DB.prepare("SELECT * FROM diary_items WHERE entry_id = ?").bind(entryId).all<ItemRow>()).results;
  const oldMap = new Map(old.map((r) => [r.garment_id + "|" + r.part, r]));
  const rows: ItemRow[] = [];
  for (const [i, it] of want.entries()) {
    const prev = oldMap.get(it.garment_id + "|" + (it.part ?? ""));
    if (prev) { rows.push({ ...prev, position: i }); continue; }
    const g = await env.DB.prepare("SELECT id, name, category, subcategory, style FROM garments WHERE id = ?").bind(it.garment_id).first<{ id: string; name: string; category: string | null; subcategory: string | null; style: string | null }>();
    if (!g) throw new HttpError(400, "garment_not_found", "找不到其中一件衣物（可能已刪除）");
    let name = g.name;
    if (it.part) {
      const a = await env.DB.prepare("SELECT name FROM doll_assets WHERE id = ? AND garment_id = ?").bind(it.part, g.id).first<{ name: string }>().catch(() => null);
      if (!a) throw new HttpError(400, "part_not_found", "找不到套裝部件");
      name = `${g.name}｜${a.name}`;
    }
    rows.push({ entry_id: entryId, garment_id: g.id, part: it.part ?? "", position: i, name, category: g.category, subcategory: g.subcategory, style: g.style, snap_id: await snapFor(env, g.id) });
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM diary_items WHERE entry_id = ?").bind(entryId),
    ...rows.map((r) => env.DB.prepare("INSERT INTO diary_items (entry_id, garment_id, part, position, name, category, subcategory, style, snap_id) VALUES (?,?,?,?,?,?,?,?,?)").bind(entryId, r.garment_id, r.part, r.position, r.name, r.category, r.subcategory, r.style, r.snap_id)),
  ]);
}

export async function createEntry(env: Env, actor: Actor, input: DiaryInput) {
  const f = fields(input);
  const outfitId = typeof input.outfit_id === "string" ? input.outfit_id : null, lookId = typeof input.look_id === "string" ? input.look_id : null;
  const src = await itemsFromSource(env, outfitId, lookId);
  const items = Array.isArray(input.items) ? (input.items as DiaryItemIn[]) : [];
  const merged = [...items, ...(input.import_items === false ? [] : src.items)];
  const id = newId("dia"), now = nowIso();
  await env.DB.prepare("INSERT INTO diary_entries (id, title, worn_date, worn_time, kind, outfit_id, look_id, source_name, occasion, location, weather, tags, notes, rating, is_favorite, tz, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, f.title, f.worn_date, f.worn_time, f.kind, outfitId, lookId, src.name, f.occasion, f.location, f.weather, f.tags, f.notes, f.rating, f.is_favorite, f.tz, now, now).run();
  try { await writeItems(env, id, merged); }
  catch (e) { await env.DB.prepare("DELETE FROM diary_entries WHERE id = ?").bind(id).run(); throw e; }
  await audit(env, actor, "diary.create", id);
  return getEntry(env, id);
}

export async function updateEntry(env: Env, actor: Actor, id: string, input: DiaryInput) {
  const cur = await env.DB.prepare("SELECT * FROM diary_entries WHERE id = ?").bind(id).first<EntryRow>();
  if (!cur) throw new HttpError(404, "diary_not_found", "找不到這筆穿搭紀錄");
  if (typeof input.base_updated_at === "string" && input.base_updated_at !== cur.updated_at) throw new HttpError(409, "diary_conflict", "這筆紀錄已在另一部裝置修改。你的修改仍保留在畫面，可以重新載入或再次保存覆寫。");
  const f = fields(input, cur);
  const photos = (await env.DB.prepare("SELECT id FROM diary_photos WHERE entry_id = ?").bind(id).all<{ id: string }>()).results.map((p) => p.id);
  const cover = Object.prototype.hasOwnProperty.call(input, "cover_photo_id") ? (typeof input.cover_photo_id === "string" && photos.includes(input.cover_photo_id) ? input.cover_photo_id : null) : cur.cover_photo_id;
  const stmts = [env.DB.prepare("UPDATE diary_entries SET title=?, worn_date=?, worn_time=?, kind=?, occasion=?, location=?, weather=?, tags=?, notes=?, rating=?, is_favorite=?, tz=?, cover_photo_id=?, updated_at=? WHERE id=?")
    .bind(f.title, f.worn_date, f.worn_time, f.kind, f.occasion, f.location, f.weather, f.tags, f.notes, f.rating, f.is_favorite, f.tz, cover, nowIso(), id)];
  if (Array.isArray(input.photo_order)) (input.photo_order as unknown[]).forEach((pid, i) => { if (typeof pid === "string" && photos.includes(pid)) stmts.push(env.DB.prepare("UPDATE diary_photos SET position = ? WHERE id = ? AND entry_id = ?").bind(i, pid, id)); });
  await env.DB.batch(stmts);
  if (Array.isArray(input.items)) await writeItems(env, id, input.items as DiaryItemIn[]);
  await audit(env, actor, "diary.update", id);
  return getEntry(env, id);
}

/** 複製紀錄到另一日期（新 ID；衣物及快照一併複製，照片不複製以免重複儲存） */
export async function duplicateEntry(env: Env, actor: Actor, id: string, input: { worn_date?: unknown; kind?: unknown }) {
  const cur = await env.DB.prepare("SELECT * FROM diary_entries WHERE id = ?").bind(id).first<EntryRow>();
  if (!cur) throw new HttpError(404, "diary_not_found", "找不到這筆穿搭紀錄");
  const date = isDate(input.worn_date) ? input.worn_date : cur.worn_date;
  const kind = KINDS.includes(input.kind as DiaryKind) ? (input.kind as DiaryKind) : cur.kind;
  const nid = newId("dia"), now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO diary_entries (id, title, worn_date, worn_time, kind, outfit_id, look_id, source_name, occasion, location, weather, tags, notes, rating, is_favorite, tz, created_at, updated_at) SELECT ?, title, ?, worn_time, ?, outfit_id, look_id, source_name, occasion, location, weather, tags, notes, rating, 0, tz, ?, ? FROM diary_entries WHERE id = ?").bind(nid, date, kind, now, now, id),
    env.DB.prepare("INSERT INTO diary_items (entry_id, garment_id, part, position, name, category, subcategory, style, snap_id) SELECT ?, garment_id, part, position, name, category, subcategory, style, snap_id FROM diary_items WHERE entry_id = ?").bind(nid, id),
  ]);
  await audit(env, actor, "diary.duplicate", nid, { from: id });
  return getEntry(env, nid);
}

export async function deleteEntry(env: Env, actor: Actor, id: string) {
  const photos = (await env.DB.prepare("SELECT r2_key FROM diary_photos WHERE entry_id = ?").bind(id).all<{ r2_key: string }>()).results;
  const r = await env.DB.prepare("DELETE FROM diary_entries WHERE id = ?").bind(id).run();
  if (!(r as { meta?: { changes?: number } }).meta?.changes) throw new HttpError(404, "diary_not_found", "找不到這筆穿搭紀錄");
  if (photos.length) await env.IMAGES.delete(photos.map((p) => p.r2_key)).catch((e) => console.warn("diary_photo_delete", String(e)));
  await audit(env, actor, "diary.delete", id);
  return { ok: true };
}

// ───── 照片 ─────
export async function uploadPhoto(env: Env, actor: Actor, req: Request, entryId: string) {
  const e = await env.DB.prepare("SELECT id FROM diary_entries WHERE id = ?").bind(entryId).first();
  if (!e) throw new HttpError(404, "diary_not_found", "找不到這筆穿搭紀錄");
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM diary_photos WHERE entry_id = ?").bind(entryId).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PHOTOS) throw new HttpError(400, "too_many_photos", `每筆紀錄最多 ${MAX_PHOTOS} 張照片`);
  const form = await req.formData().catch(() => null);
  const file = form?.get("file"), thumb = form?.get("thumb");
  if (!file || typeof file === "string") throw new HttpError(400, "no_file", "請選擇照片");
  const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
  if (bytes.byteLength > 12 * 1024 * 1024) throw new HttpError(413, "file_too_large", "照片太大（上限 12 MB）");
  const info = parseImage(bytes);
  if (!["image/jpeg", "image/webp", "image/png"].includes(info.mime)) throw new HttpError(415, "bad_type", "只接受 JPG、PNG 或 WebP");
  let tbytes: Uint8Array | null = null, tmime: string | null = null;
  if (thumb && typeof thumb !== "string") {
    tbytes = new Uint8Array(await (thumb as Blob).arrayBuffer());
    if (tbytes.byteLength > MAX_THUMB) throw new HttpError(413, "thumb_too_large", "縮圖太大");
    tmime = parseImage(tbytes).mime;
    if (!["image/jpeg", "image/webp"].includes(tmime)) throw new HttpError(415, "bad_thumb", "縮圖格式不正確");
  }
  const sha = await sha256Hex(bytes);
  const dup = await env.DB.prepare("SELECT id FROM diary_photos WHERE entry_id = ? AND sha256 = ?").bind(entryId, sha).first<{ id: string }>();
  if (dup) return { photo: { id: dup.id }, duplicate: true }; // 重試上傳：不重複建立
  const id = newId("dph"), ext = info.mime === "image/png" ? "png" : info.mime === "image/webp" ? "webp" : "jpg";
  const key = `diary/${entryId}/${id}.${ext}`;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: info.mime } });
  try {
    const pos = (count?.n ?? 0);
    await env.DB.prepare("INSERT INTO diary_photos (id, entry_id, r2_key, mime_type, width, height, file_size, sha256, position, thumb, thumb_mime, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, entryId, key, info.mime, info.width, info.height, bytes.byteLength, sha, pos, tbytes, tmime, nowIso()).run();
    await env.DB.prepare("UPDATE diary_entries SET cover_photo_id = COALESCE(cover_photo_id, ?), updated_at = ? WHERE id = ?").bind(id, nowIso(), entryId).run();
  } catch (err) {
    await env.IMAGES.delete(key).catch(() => undefined); // 補償：D1 失敗不留下孤立檔案
    throw err;
  }
  await audit(env, actor, "diary.photo", entryId, { photo: id });
  return { photo: { id, width: info.width, height: info.height, file_size: bytes.byteLength } };
}

export async function deletePhoto(env: Env, actor: Actor, entryId: string, photoId: string) {
  const p = await env.DB.prepare("SELECT r2_key FROM diary_photos WHERE id = ? AND entry_id = ?").bind(photoId, entryId).first<{ r2_key: string }>();
  if (!p) throw new HttpError(404, "photo_not_found", "找不到照片");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM diary_photos WHERE id = ?").bind(photoId),
    env.DB.prepare("UPDATE diary_entries SET cover_photo_id = CASE WHEN cover_photo_id = ? THEN NULL ELSE cover_photo_id END, updated_at = ? WHERE id = ?").bind(photoId, nowIso(), entryId),
  ]);
  await env.IMAGES.delete(p.r2_key).catch(() => undefined);
  await audit(env, actor, "diary.photo_delete", entryId, { photo: photoId });
  return { ok: true };
}

const privateHeaders = (mime: string, etag: string) => ({ "content-type": mime, "cache-control": "private, max-age=31536000, immutable", etag, "x-content-type-options": "nosniff" });
export async function servePhoto(req: Request, env: Env, photoId: string, thumb: boolean): Promise<Response> {
  const p = await env.DB.prepare(`SELECT r2_key, mime_type, sha256${thumb ? ", thumb, thumb_mime" : ""} FROM diary_photos WHERE id = ?`).bind(photoId).first<{ r2_key: string; mime_type: string; sha256: string; thumb?: ArrayBuffer | null; thumb_mime?: string | null }>();
  if (!p) throw new HttpError(404, "photo_not_found", "找不到照片");
  const etag = `"${p.sha256}${thumb ? "-t" : ""}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: privateHeaders(p.mime_type, etag) });
  if (thumb && p.thumb) return new Response(new Uint8Array(p.thumb as ArrayBuffer), { headers: privateHeaders(p.thumb_mime || "image/webp", etag) });
  const obj = await env.IMAGES.get(p.r2_key);
  if (!obj) throw new HttpError(404, "object_missing", "R2 找不到照片檔案");
  return new Response(obj.body, { headers: privateHeaders(p.mime_type, etag) });
}
export async function serveSnap(req: Request, env: Env, snapId: string): Promise<Response> {
  const s = await env.DB.prepare("SELECT data, mime_type FROM diary_snaps WHERE id = ?").bind(snapId).first<{ data: ArrayBuffer; mime_type: string }>();
  if (!s) throw new HttpError(404, "snap_not_found", "找不到縮圖快照");
  const etag = `"${snapId}"`;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: privateHeaders(s.mime_type, etag) });
  return new Response(new Uint8Array(s.data), { headers: privateHeaders(s.mime_type, etag) });
}

// ───── 穿著統計 ─────
interface WearDay { garment_id: string; worn_date: string; entries: number }
/** 計算規則（純函數，方便測試）：每件衣物每日最多一次；只計已穿著；price 未填＝每次成本未知 */
export function wearStats(days: WearDay[], today: string) {
  const map = new Map<string, { days: number; entries: number; first: string; last: string; month: number; year: number }>();
  const m = today.slice(0, 7), y = today.slice(0, 4);
  for (const d of days) {
    const s = map.get(d.garment_id) ?? { days: 0, entries: 0, first: d.worn_date, last: d.worn_date, month: 0, year: 0 };
    s.days++; s.entries += d.entries;
    if (d.worn_date < s.first) s.first = d.worn_date;
    if (d.worn_date > s.last) s.last = d.worn_date;
    if (d.worn_date.startsWith(m)) s.month++;
    if (d.worn_date.startsWith(y)) s.year++;
    map.set(d.garment_id, s);
  }
  return map;
}
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
export const costPerWear = (price: number | null | undefined, days: number) => (price == null || !(price > 0) || days <= 0 ? null : Math.round((price / days) * 100) / 100);

async function wearDays(env: Env, today: string, garmentId?: string): Promise<WearDay[]> {
  // 只計算今天（使用者本地日期）或之前的「已穿著」紀錄；將來日期不計
  const sql = `SELECT i.garment_id AS garment_id, e.worn_date AS worn_date, COUNT(DISTINCT e.id) AS entries FROM diary_items i JOIN diary_entries e ON e.id = i.entry_id WHERE e.kind = 'worn' AND e.worn_date <= ?${garmentId ? " AND i.garment_id = ?" : ""} GROUP BY i.garment_id, e.worn_date`;
  const r = garmentId ? await env.DB.prepare(sql).bind(today, garmentId).all<WearDay>() : await env.DB.prepare(sql).bind(today).all<WearDay>();
  return r.results;
}

export async function garmentWear(env: Env, garmentId: string, today: string) {
  if (!isDate(today)) throw new HttpError(400, "bad_date", "缺少今日日期");
  const g = await env.DB.prepare("SELECT price FROM garments WHERE id = ?").bind(garmentId).first<{ price: number | null }>();
  const s = wearStats(await wearDays(env, today, garmentId), today).get(garmentId);
  const since = await env.DB.prepare("SELECT MIN(worn_date) AS d FROM diary_entries").first<{ d: string | null }>();
  const related = await listDiary(env, new URLSearchParams({ garment: garmentId, limit: "30" }));
  return {
    worn_days: s?.days ?? 0, entries: s?.entries ?? 0, first: s?.first ?? null, last: s?.last ?? null, month: s?.month ?? 0, year: s?.year ?? 0,
    days_since: s?.last ? daysBetween(s.last, today) : null,
    cost_per_wear: costPerWear(g?.price, s?.days ?? 0), price: g?.price ?? null,
    diary_since: since?.d ?? null, related: related.entries,
  };
}

export async function diaryStats(env: Env, today: string, month?: string | null) {
  if (!isDate(today)) throw new HttpError(400, "bad_date", "缺少今日日期");
  const mm = month && /^\d{4}-\d{2}$/.test(month) ? month : today.slice(0, 7);
  const all = await wearDays(env, today);
  const stats = wearStats(all, today);
  const garments = (await env.DB.prepare("SELECT id, name, category, subcategory, style, price, created_at, (SELECT id FROM garment_images WHERE garment_id = garments.id AND is_primary = 1 LIMIT 1) AS primary_image_id FROM garments WHERE status != 'archived'").all<{ id: string; name: string; category: string | null; subcategory: string | null; style: string | null; price: number | null; created_at: string; primary_image_id: string | null }>()).results;
  const monthRows = all.filter((d) => d.worn_date.startsWith(mm));
  const monthGarments = new Set(monthRows.map((d) => d.garment_id));
  const monthCount = new Map<string, number>();
  for (const d of monthRows) monthCount.set(d.garment_id, (monthCount.get(d.garment_id) ?? 0) + 1);
  const recordDays = (await env.DB.prepare("SELECT COUNT(DISTINCT worn_date) AS n FROM diary_entries WHERE kind = 'worn' AND worn_date LIKE ? AND worn_date <= ?").bind(mm + "-%", today).first<{ n: number }>())?.n ?? 0;
  const since = (await env.DB.prepare("SELECT MIN(worn_date) AS d FROM diary_entries").first<{ d: string | null }>())?.d ?? null;
  const per = garments.map((g) => {
    const s = stats.get(g.id);
    return { id: g.id, name: g.name, category: g.category, subcategory: g.subcategory, style: g.style, primary_image_id: g.primary_image_id, price: g.price, worn_days: s?.days ?? 0, month: monthCount.get(g.id) ?? 0, last: s?.last ?? null, days_since: s?.last ? daysBetween(s.last, today) : null, cost_per_wear: costPerWear(g.price, s?.days ?? 0) };
  });
  const count = (key: "category" | "style") => {
    const m = new Map<string, number>();
    for (const d of monthRows) { const g = garments.find((x) => x.id === d.garment_id); const k = (g?.[key] ?? "未分類") || "未分類"; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  };
  const worn = per.filter((p) => p.worn_days > 0);
  return {
    month: mm, today, diary_since: since,
    record_days: recordDays, distinct_garments: monthGarments.size, active_garments: garments.length,
    usage_rate: garments.length ? monthGarments.size / garments.length : null,
    most_worn: [...worn].sort((a, b) => b.worn_days - a.worn_days || (b.last ?? "").localeCompare(a.last ?? "")).slice(0, 10),
    least_recent: [...worn].sort((a, b) => (a.last ?? "").localeCompare(b.last ?? "")).slice(0, 10),
    never_recorded: per.filter((p) => p.worn_days === 0).slice(0, 50), never_recorded_count: per.filter((p) => p.worn_days === 0).length,
    by_category: count("category"), by_style: count("style"),
    cost_per_wear: worn.filter((p) => p.cost_per_wear != null).sort((a, b) => (a.cost_per_wear ?? 0) - (b.cost_per_wear ?? 0)).slice(0, 10),
    cost_unknown: worn.filter((p) => p.cost_per_wear == null).length,
  };
}
