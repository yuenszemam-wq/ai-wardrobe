// 角色換裝 API：衣物預設穿著設定、造型、造型縮圖及角色素材（頭部／髮型／衣物額外部件）。
// 只讀寫 doll_* 資料表及 R2 的 doll/ 路徑；不修改 garments、garment_images、outfits 或衣物圖片。
import { DEFAULT_AVATAR, Fit, LEGACY_AVATAR, LookState, isSlot, normalizeFit, normalizeLookState, normalizeTemplateData, slotFor } from "../shared/doll";
import { normalizeHairConfig, normalizeHeadConfig, normalizePalette } from "../shared/avatarV2";
import { parseImage } from "./images";
import { transparentImageSql } from "./transparent";
import { Actor, Env, HttpError, audit, json, newId, nowIso, sha256Hex, str } from "./util";

const fitOrThrow = (v: unknown): Fit => {
  const f = normalizeFit(v);
  if (!f) throw new HttpError(400, "bad_fit", "位置資料不正確");
  return f;
};
const parse = (v: unknown): unknown => {
  if (typeof v !== "string" || !v) return null;
  try { return JSON.parse(v); } catch { return null; }
};

// ───── 衣物預設穿著設定 ─────
interface TemplateRow { garment_id: string; avatar_id: string; image_id: string | null; cx: number; cy: number; w: number; rotation: number; slot: string | null; data: string | null; version: number; updated_at: string }
const templateOut = (r: TemplateRow) => {
  const data = r.avatar_id === DEFAULT_AVATAR && isSlot(r.slot) ? normalizeTemplateData(parse(r.data), r.slot) : null;
  // 高度拉伸（Phase 3.1）存在 data.sy，資料表欄位不變
  return { garment_id: r.garment_id, avatar_id: r.avatar_id, image_id: r.image_id, fit: { cx: r.cx, cy: r.cy, w: r.w, rotation: r.rotation, ...(data?.sy ? { sy: data.sy } : {}), ...(data?.mesh ? { mesh: data.mesh } : {}) }, slot: r.slot, data, version: r.version, updated_at: r.updated_at };
};

/** 回傳目前角色的設定；另附舊角色（V1）的位置，前端只在該衣物未有 V2 設定時換算使用 */
export async function listTemplates(env: Env) {
  const { results } = await env.DB.prepare("SELECT * FROM doll_fit_templates WHERE avatar_id IN (?, ?) ORDER BY updated_at DESC LIMIT 4000").bind(DEFAULT_AVATAR, LEGACY_AVATAR).all<TemplateRow>();
  return results.map(templateOut);
}

export async function putTemplate(env: Env, actor: Actor, garmentId: string, input: Record<string, unknown>) {
  const fit = fitOrThrow(input.fit);
  const g = await env.DB.prepare(`SELECT g.id, g.category, g.subcategory, ${transparentImageSql()} AS image_id FROM garments g WHERE g.id = ?`).bind(garmentId).first<{ id: string; category: string | null; subcategory: string | null; image_id: string | null }>();
  if (!g) throw new HttpError(404, "garment_not_found", "找不到這件衣物");
  if (input.slot != null && !isSlot(input.slot)) throw new HttpError(400, "bad_slot", "圖層位置不正確");
  const slot = isSlot(input.slot) ? input.slot : slotFor(g.category, g.subcategory);
  if (Object.prototype.hasOwnProperty.call(input, "image_id") && input.image_id !== g.image_id) throw new HttpError(409, "image_changed", "衣物圖片已更新，請重新載入再校正");
  const data = JSON.stringify(normalizeTemplateData({ ...(input.data && typeof input.data === "object" ? input.data : {}), sy: fit.sy, mesh: fit.mesh }, slot));
  if (data.length > 600_000) throw new HttpError(413, "template_too_large", "穿著設定過大，請減少穿法或遮罩");
  const expected = input.expected_version;
  if (expected != null && (!Number.isSafeInteger(expected) || Number(expected) < 0)) throw new HttpError(400, "bad_version", "版本不正確");
  // Older clients may create a first preset, but must reload before updating an existing one.
  const version = expected == null ? 0 : Number(expected);
  const now = nowIso();
  const saved = await env.DB.prepare(
    `INSERT INTO doll_fit_templates (garment_id, avatar_id, image_id, cx, cy, w, rotation, slot, data, version, created_at, updated_at)
     SELECT ?,?,?,?,?,?,?,?,?,1,?,? WHERE ? = 0 OR EXISTS (SELECT 1 FROM doll_fit_templates WHERE garment_id = ? AND avatar_id = ? AND version = ?)
     ON CONFLICT(garment_id, avatar_id) DO UPDATE SET image_id = excluded.image_id, cx = excluded.cx, cy = excluded.cy, w = excluded.w,
       rotation = excluded.rotation, slot = excluded.slot, data = excluded.data, version = doll_fit_templates.version + 1, updated_at = excluded.updated_at WHERE doll_fit_templates.version = ?`,
  ).bind(garmentId, DEFAULT_AVATAR, g.image_id, fit.cx, fit.cy, fit.w, fit.rotation, slot, data, now, now, version, garmentId, DEFAULT_AVATAR, version, version).run();
  if (!saved.meta.changes) throw new HttpError(409, "template_conflict", "另一裝置已更新衣物設定。你的編輯仍保留；請重新載入最新預設後再保存，避免覆蓋其他部件。");
  await audit(env, actor, "doll.template.save", garmentId);
  const row = await env.DB.prepare("SELECT * FROM doll_fit_templates WHERE garment_id = ? AND avatar_id = ?").bind(garmentId, DEFAULT_AVATAR).first<TemplateRow>();
  return templateOut(row!);
}

/** 恢復分類預設：只刪除目前角色的設定；舊角色的記錄保留 */
export async function deleteTemplate(env: Env, actor: Actor, garmentId: string) {
  const res = await env.DB.prepare("DELETE FROM doll_fit_templates WHERE garment_id = ? AND avatar_id = ?").bind(garmentId, DEFAULT_AVATAR).run();
  if (res.meta.changes) await audit(env, actor, "doll.template.delete", garmentId);
  return { ok: true, deleted: res.meta.changes };
}

// ───── 造型 ─────
interface LookInput { name?: unknown; notes?: unknown; is_favorite?: unknown; status?: unknown; state?: unknown }
interface LookRow { id: string; name: string; avatar_id: string; notes: string | null; is_favorite: number; status: string; created_at: string; updated_at: string; state: string | null }

const summary = (l: LookRow & { item_count?: number; thumb_at?: string | null }) => ({
  id: l.id, name: l.name, notes: l.notes, is_favorite: Number(l.is_favorite) === 1, status: l.status, created_at: l.created_at, updated_at: l.updated_at,
  item_count: Number(l.item_count ?? 0), thumb_at: l.thumb_at ?? null, legacy: !l.state,
});

export async function listLooks(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.name, l.avatar_id, l.notes, l.is_favorite, l.status, l.created_at, l.updated_at, CASE WHEN l.state IS NULL THEN NULL ELSE '1' END AS state,
       (SELECT COUNT(*) FROM doll_look_items i WHERE i.look_id = l.id) AS item_count,
       (SELECT t.updated_at FROM doll_look_thumbs t WHERE t.look_id = l.id) AS thumb_at
     FROM doll_looks l WHERE l.status != 'archived' ORDER BY l.updated_at DESC LIMIT 300`,
  ).all<LookRow & { item_count: number; thumb_at: string | null }>();
  return results.map(summary);
}

export async function getLook(env: Env, id: string) {
  const l = await env.DB.prepare("SELECT * FROM doll_looks WHERE id = ?").bind(id).first<LookRow & Record<string, unknown>>();
  if (!l) throw new HttpError(404, "look_not_found", "找不到這個造型");
  const { results: rows } = await env.DB.prepare(
    `SELECT i.garment_id, i.slot, i.z, i.ov_cx, i.ov_cy, i.ov_w, i.ov_rotation, g.name, g.display_no, g.category, g.subcategory,
       ${transparentImageSql()} AS image_id
     FROM doll_look_items i JOIN garments g ON g.id = i.garment_id WHERE i.look_id = ? ORDER BY i.z, i.rowid`,
  ).bind(id).all<Record<string, unknown>>();
  const garments = rows.map((r) => ({ id: r.garment_id, name: r.name, display_no: r.display_no, category: r.category, subcategory: r.subcategory, transparent_image_id: r.image_id }));
  const have = new Set(rows.map((r) => r.garment_id));
  let state = normalizeLookState(parse(l.state));
  let legacy: unknown = null;
  if (state) state = { ...state, items: state.items.filter((it) => have.has(it.garment_id)) }; // 已刪除的衣物自動略過
  else {
    // 舊造型（Phase 3 之前）：由資料表欄位讀出，交由前端換算成新格式；保存前不會改寫原記錄
    legacy = {
      avatar_id: l.avatar_id, hair_color: l.hair_color ?? null, accent_color: l.accent_color ?? null, pose: parse(l.pose) ?? {},
      items: rows.map((r) => ({
        garment_id: r.garment_id, slot: r.slot,
        override: r.ov_cx === null || r.ov_cy === null || r.ov_w === null ? null : { cx: r.ov_cx, cy: r.ov_cy, w: r.ov_w, rotation: r.ov_rotation ?? 0 },
      })),
    };
  }
  const thumb = await env.DB.prepare("SELECT updated_at FROM doll_look_thumbs WHERE look_id = ?").bind(id).first<{ updated_at: string }>();
  return { ...summary({ ...l, item_count: rows.length, thumb_at: thumb?.updated_at ?? null }), state, legacy, garments };
}

async function stateStatements(env: Env, lookId: string, raw: unknown): Promise<{ state: LookState; stmts: D1PreparedStatement[] }> {
  const state = normalizeLookState(raw);
  if (!state) throw new HttpError(400, "bad_state", "造型資料不正確");
  // 混搭造型引用既有髮件檔案；不允許儲存不存在的上傳圖片。
  const hairRefs=[...new Set((state.hair_config?.parts??[]).flatMap(p=>[p.file,p.mask]).filter((x):x is string=>typeof x==="string"&&x.startsWith("file:")))];
  for(const ref of hairRefs){if(!await env.DB.prepare("SELECT id FROM doll_asset_files WHERE id = ?").bind(ref.slice(5)).first())throw new HttpError(400,"bad_hair","有髮件圖片不存在，請重新選擇");}
  const text = JSON.stringify(state);
  if (text.length > 900_000) throw new HttpError(413, "state_too_large", "造型資料過大，請減少個別遮罩");
  for (const gid of new Set(state.items.map((it) => it.garment_id))) {
    const g = await env.DB.prepare("SELECT id FROM garments WHERE id = ?").bind(gid).first();
    if (!g) throw new HttpError(400, "bad_garment", "有衣物不存在，未能儲存造型");
  }
  const stmts = [env.DB.prepare("DELETE FROM doll_look_items WHERE look_id = ?").bind(lookId)];
  // doll_look_items 只是索引（每件衣物一行）：同一套裝穿了多個部件時只記一次；完整內容在 state
  const indexed = new Set<string>();
  state.items.forEach((it, i) => {
    if (indexed.has(it.garment_id)) return;
    indexed.add(it.garment_id);
    const f = it.piece ? null : it.fit;
    stmts.push(env.DB.prepare("INSERT INTO doll_look_items (look_id, garment_id, slot, z, ov_cx, ov_cy, ov_w, ov_rotation) VALUES (?,?,?,?,?,?,?,?)")
      .bind(lookId, it.garment_id, it.slot, i, f ? f.cx : null, f ? f.cy : null, f ? f.w : null, f ? f.rotation : null));
  });
  return { state, stmts };
}
/** 同步寫入 0009 的舊欄位，方便其他工具閱讀（內置髮型才有 hair_style） */
const legacyColumns = (s: LookState) => [s.hair?.startsWith("builtin:") ? s.hair.slice(8) : null, s.hair_color, s.accent_color, JSON.stringify(s.pose), JSON.stringify(s)];

export async function createLook(env: Env, actor: Actor, input: LookInput) {
  const id = newId("look");
  const now = nowIso();
  const { state, stmts } = await stateStatements(env, id, input.state ?? { items: [] });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO doll_looks (id, name, avatar_id, notes, is_favorite, status, created_at, updated_at, hair_style, hair_color, accent_color, pose, state) VALUES (?,?,?,?,?, 'active', ?, ?,?,?,?,?,?)")
      .bind(id, str(input.name, 120) || "新造型", DEFAULT_AVATAR, str(input.notes, 2000), input.is_favorite ? 1 : 0, now, now, ...legacyColumns(state)),
    ...stmts,
  ]);
  await audit(env, actor, "doll.look.create", id);
  return getLook(env, id);
}

export async function updateLook(env: Env, actor: Actor, id: string, input: LookInput) {
  const cur = await env.DB.prepare("SELECT id FROM doll_looks WHERE id = ?").bind(id).first<{ id: string }>();
  if (!cur) throw new HttpError(404, "look_not_found", "找不到這個造型");
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const sets: string[] = [];
  const binds: unknown[] = [];
  let stmts: D1PreparedStatement[] = [];
  if (has("state")) {
    const r = await stateStatements(env, id, input.state);
    stmts = r.stmts;
    sets.push("avatar_id = ?", "hair_style = ?", "hair_color = ?", "accent_color = ?", "pose = ?", "state = ?");
    binds.push(DEFAULT_AVATAR, ...legacyColumns(r.state));
  }
  if (has("name") && str(input.name, 120)) { sets.push("name = ?"); binds.push(str(input.name, 120)); }
  if (has("notes")) { sets.push("notes = ?"); binds.push(str(input.notes, 2000)); }
  if (has("is_favorite")) { sets.push("is_favorite = ?"); binds.push(input.is_favorite ? 1 : 0); }
  if (has("status")) {
    const s = str(input.status, 20);
    if (s !== "active" && s !== "archived") throw new HttpError(400, "bad_status", "status 不正確");
    sets.push("status = ?"); binds.push(s);
  }
  // 只改收藏不算「更新造型」，列表次序不變
  if (sets.some((s) => !s.startsWith("is_favorite"))) { sets.push("updated_at = ?"); binds.push(nowIso()); }
  if (!sets.length) return getLook(env, id);
  await env.DB.batch([env.DB.prepare(`UPDATE doll_looks SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id), ...stmts]);
  await audit(env, actor, "doll.look.update", id);
  return getLook(env, id);
}

export async function deleteLook(env: Env, actor: Actor, id: string) {
  const res = await env.DB.prepare("DELETE FROM doll_looks WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, "look_not_found", "找不到這個造型");
  await env.DB.prepare("DELETE FROM doll_look_thumbs WHERE look_id = ?").bind(id).run();
  await audit(env, actor, "doll.look.delete", id);
}

// ───── 造型縮圖（實際組裝完成的角色畫面） ─────
const THUMB_MAX = 160_000;
function sniffSmall(bytes: Uint8Array, max: number) {
  if (!bytes.byteLength) throw new HttpError(400, "empty_file", "檔案是空的");
  if (bytes.byteLength > max) throw new HttpError(413, "file_too_large", "縮圖過大");
  const info = parseImage(bytes);
  if (info.mime !== "image/jpeg" && info.mime !== "image/png" && info.mime !== "image/webp") throw new HttpError(415, "bad_image", "縮圖格式不支援");
  if (info.width > 1024 || info.height > 1536) throw new HttpError(400, "bad_image", "縮圖尺寸過大");
  return info;
}
export async function putLookThumb(req: Request, env: Env, id: string) {
  const look = await env.DB.prepare("SELECT id FROM doll_looks WHERE id = ?").bind(id).first();
  if (!look) throw new HttpError(404, "look_not_found", "找不到這個造型");
  const bytes = new Uint8Array(await req.arrayBuffer());
  const info = sniffSmall(bytes, THUMB_MAX);
  const now = nowIso();
  await env.DB.prepare(
    `INSERT INTO doll_look_thumbs (look_id, data, mime_type, byte_size, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(look_id) DO UPDATE SET data = excluded.data, mime_type = excluded.mime_type, byte_size = excluded.byte_size, updated_at = excluded.updated_at`,
  ).bind(id, bytes, info.mime, bytes.byteLength, now).run();
  return json({ ok: true, thumb_at: now });
}
const blobResponse = (data: unknown, mime: string) => new Response(data instanceof ArrayBuffer ? data : new Uint8Array(data as ArrayLike<number>), { headers: { "content-type": mime, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
export async function getLookThumb(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT data, mime_type FROM doll_look_thumbs WHERE look_id = ?").bind(id).first<{ data: ArrayBuffer; mime_type: string }>();
  if (!row) throw new HttpError(404, "thumb_not_found", "未有縮圖");
  return blobResponse(row.data, row.mime_type);
}

// ───── 角色素材 ─────
const KINDS = ["head", "hair", "garment_part"] as const;
type Kind = (typeof KINDS)[number];
interface AssetRow { id: string; kind: Kind; name: string; category: string | null; garment_id: string | null; config: string | null; status: string; created_at: string; updated_at: string; has_thumb?: number }
const FILE_MAX = 12 * 1024 * 1024;

function configFor(kind: Kind, v: unknown): string | null {
  if (v == null) return null;
  const c = kind === "hair" ? normalizeHairConfig(v) : kind === "head" ? normalizeHeadConfig(v) : {};
  if (!c) throw new HttpError(400, "bad_config", "素材設定不正確");
  return JSON.stringify(c);
}
async function assetOut(env: Env, a: AssetRow) {
  const { results: files } = await env.DB.prepare("SELECT id, mime_type, width, height, file_size, created_at FROM doll_asset_files WHERE asset_id = ? ORDER BY created_at, id").bind(a.id).all();
  return { id: a.id, kind: a.kind, name: a.name, category: a.category, garment_id: a.garment_id, config: parse(a.config), status: a.status, created_at: a.created_at, updated_at: a.updated_at,
    thumb: a.has_thumb ? `/api/doll/assets/${a.id}/thumb?v=${encodeURIComponent(a.updated_at)}` : null, files };
}
const ASSET_COLS = "id, kind, name, category, garment_id, config, status, created_at, updated_at, (thumb IS NOT NULL) AS has_thumb";

export async function listAssets(env: Env, params: URLSearchParams) {
  const kind = params.get("kind");
  const garment = params.get("garment_id");
  const where = ["status = 'active'"];
  const binds: unknown[] = [];
  if (kind) { where.push("kind = ?"); binds.push(kind); }
  if (garment) { where.push("garment_id = ?"); binds.push(garment); }
  const { results } = await env.DB.prepare(`SELECT ${ASSET_COLS} FROM doll_assets WHERE ${where.join(" AND ")} ORDER BY created_at LIMIT 500`).bind(...binds).all<AssetRow>();
  const out = [];
  for (const a of results) out.push(await assetOut(env, a));
  return out;
}
async function assetRow(env: Env, id: string) {
  const a = await env.DB.prepare(`SELECT ${ASSET_COLS} FROM doll_assets WHERE id = ?`).bind(id).first<AssetRow>();
  if (!a) throw new HttpError(404, "asset_not_found", "找不到這個素材");
  return a;
}
export async function createAsset(env: Env, actor: Actor, input: Record<string, unknown>) {
  const kind = KINDS.find((k) => k === input.kind);
  if (!kind) throw new HttpError(400, "bad_kind", "素材類型不正確");
  let garmentId: string | null = null;
  if (kind === "garment_part") {
    garmentId = str(input.garment_id, 64);
    const g = garmentId && (await env.DB.prepare("SELECT id FROM garments WHERE id = ?").bind(garmentId).first());
    if (!g) throw new HttpError(400, "bad_garment", "找不到所屬的衣物");
  }
  const id = newId("das");
  const now = nowIso();
  await env.DB.prepare("INSERT INTO doll_assets (id, kind, name, category, garment_id, config, status, created_at, updated_at) VALUES (?,?,?,?,?,?, 'active', ?, ?)")
    .bind(id, kind, str(input.name, 60) || (kind === "hair" ? "新髮型" : kind === "head" ? "新頭部" : "衣物部件"), str(input.category, 30), garmentId, configFor(kind, input.config), now, now).run();
  await audit(env, actor, "doll.asset.create", id);
  return assetOut(env, await assetRow(env, id));
}
export async function updateAsset(env: Env, actor: Actor, id: string, input: Record<string, unknown>) {
  const a = await assetRow(env, id);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(input, k);
  const sets = ["updated_at = ?"];
  const binds: unknown[] = [nowIso()];
  if (has("name") && str(input.name, 60)) { sets.push("name = ?"); binds.push(str(input.name, 60)); }
  if (has("category")) { sets.push("category = ?"); binds.push(str(input.category, 30)); }
  if (has("config")) {
    const config = configFor(a.kind, input.config);
    // 設定只可以引用這個素材自己的檔案（或內置檔案）
    const refs = [...(config ?? "").matchAll(/file:(daf_[a-z2-7]+)/g)].map((m) => m[1]);
    for (const ref of new Set(refs)) {
      const f = await env.DB.prepare("SELECT id FROM doll_asset_files WHERE id = ? AND asset_id = ?").bind(ref, id).first();
      if (!f) throw new HttpError(400, "bad_config", "素材設定引用了不屬於這個素材的圖片");
    }
    sets.push("config = ?"); binds.push(config);
  }
  await env.DB.prepare(`UPDATE doll_assets SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
  await audit(env, actor, "doll.asset.update", id);
  return assetOut(env, await assetRow(env, id));
}
/** 刪除素材：連同它在 R2 doll/ 路徑下的檔案一併刪除（不涉及衣物圖片）。使用中的造型會改用預設頭部／髮型。 */
export async function deleteAsset(env: Env, actor: Actor, id: string) {
  await assetRow(env, id);
  if (await env.DB.prepare("SELECT id FROM doll_looks WHERE state LIKE ? LIMIT 1").bind('%' + id + '%').first()) throw new HttpError(409, "asset_in_use", "已保存造型仍在使用這個素材，請保留");
  const files = await env.DB.prepare("SELECT id FROM doll_asset_files WHERE asset_id = ?").bind(id).all<{id:string}>();
  for (const f of files.results) await checkFileReferences(env, f.id);
  const { results } = await env.DB.prepare("SELECT r2_key FROM doll_asset_files WHERE asset_id = ?").bind(id).all<{ r2_key: string }>();
  await env.DB.batch([env.DB.prepare("DELETE FROM doll_asset_files WHERE asset_id = ?").bind(id), env.DB.prepare("DELETE FROM doll_assets WHERE id = ?").bind(id)]);
  const keys = results.map((r) => r.r2_key).filter((k) => k.startsWith("doll/"));
  if (keys.length) await env.IMAGES.delete(keys).catch(() => undefined);
  await audit(env, actor, "doll.asset.delete", id);
  return { ok: true };
}
/** 上傳素材圖片（原始二進位 PNG／WebP，必須有透明通道）。R2 先寫，D1 失敗即刪除。 */
export async function addAssetFile(req: Request, env: Env, actor: Actor, id: string) {
  await assetRow(env, id);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_asset_files WHERE asset_id = ?").bind(id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 40) throw new HttpError(400, "too_many_files", "這個素材的圖片已達上限");
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.byteLength) throw new HttpError(400, "empty_file", "檔案是空的");
  if (bytes.byteLength > FILE_MAX) throw new HttpError(413, "file_too_large", "圖片超過 12 MB 上限");
  const info = parseImage(bytes);
  if (info.mime !== "image/png" && info.mime !== "image/webp") throw new HttpError(415, "bad_image", "請上傳透明背景的 PNG 或 WebP");
  if (!info.hasAlpha) throw new HttpError(400, "no_alpha", "這張圖片沒有透明背景");
  const sha = await sha256Hex(bytes);
  const fileId = newId("daf");
  const key = `doll/assets/${id}/${fileId}.${info.ext}`;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: info.mime, cacheControl: "private, max-age=31536000, immutable" }, customMetadata: { sha256: sha, owner: "doll_asset" } });
  const now = nowIso();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO doll_asset_files (id, asset_id, r2_key, mime_type, width, height, file_size, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(fileId, id, key, info.mime, info.width, info.height, bytes.byteLength, sha, now),
      env.DB.prepare("UPDATE doll_assets SET updated_at = ? WHERE id = ?").bind(now, id),
    ]);
  } catch (e) {
    await env.IMAGES.delete(key).catch(() => undefined);
    throw e;
  }
  await audit(env, actor, "doll.asset.file", id, { file: fileId });
  return json({ id: fileId, ref: "file:" + fileId, width: info.width, height: info.height, file_size: bytes.byteLength }, 201);
}
async function checkFileReferences(env: Env, fileId: string) {
  const ref = '%file:' + fileId + '%';
  const used = await env.DB.prepare("SELECT id FROM doll_looks WHERE state LIKE ? LIMIT 1").bind(ref).first();
  const template = await env.DB.prepare("SELECT garment_id FROM doll_fit_templates WHERE data LIKE ? LIMIT 1").bind(ref).first();
  if (used || template) throw new HttpError(409, "file_in_use", "已保存造型或衣物預設仍在使用這張圖片，請保留此版本");
}
export async function deleteAssetFile(env: Env, actor: Actor, fileId: string) {
  await checkFileReferences(env, fileId);
  const f = await env.DB.prepare("SELECT asset_id, r2_key FROM doll_asset_files WHERE id = ?").bind(fileId).first<{ asset_id: string; r2_key: string }>();
  if (!f) throw new HttpError(404, "file_not_found", "找不到這張圖片");
  await env.DB.prepare("DELETE FROM doll_asset_files WHERE id = ?").bind(fileId).run();
  if (f.r2_key.startsWith("doll/")) await env.IMAGES.delete(f.r2_key).catch(() => undefined);
  await audit(env, actor, "doll.asset.file_delete", f.asset_id, { file: fileId });
  return { ok: true };
}
export async function serveAssetFile(req: Request, env: Env, fileId: string) {
  const row = await env.DB.prepare("SELECT r2_key, mime_type, sha256 FROM doll_asset_files WHERE id = ?").bind(fileId).first<{ r2_key: string; mime_type: string; sha256: string }>();
  if (!row) throw new HttpError(404, "file_not_found", "找不到這張圖片");
  const etag = `"${row.sha256}"`;
  const headers = { "content-type": row.mime_type, "cache-control": "private, max-age=31536000, immutable", etag, "x-content-type-options": "nosniff" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const obj = await env.IMAGES.get(row.r2_key);
  if (!obj) throw new HttpError(404, "object_missing", "R2 找不到素材檔案");
  return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
}
export async function putAssetThumb(req: Request, env: Env, id: string) {
  await assetRow(env, id);
  const bytes = new Uint8Array(await req.arrayBuffer());
  const info = sniffSmall(bytes, THUMB_MAX);
  await env.DB.prepare("UPDATE doll_assets SET thumb = ?, thumb_mime = ?, updated_at = ? WHERE id = ?").bind(bytes, info.mime, nowIso(), id).run();
  return json({ ok: true });
}
export async function getAssetThumb(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT thumb, thumb_mime FROM doll_assets WHERE id = ?").bind(id).first<{ thumb: ArrayBuffer | null; thumb_mime: string | null }>();
  if (!row?.thumb) throw new HttpError(404, "thumb_not_found", "未有縮圖");
  return blobResponse(row.thumb, row.thumb_mime || "image/png");
}

// ───── 自訂髮色色票（存於 app_settings，不需要新資料表） ─────
const PALETTE_KEY = "doll_hair_palette";
export async function getPalette(env: Env) {
  const r = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(PALETTE_KEY).first<{ value: string }>();
  return normalizePalette(parse(r?.value));
}
export async function putPalette(env: Env, actor: Actor, input: unknown) {
  const p = normalizePalette(input);
  const value = JSON.stringify(p);
  if (value.length > 40_000) throw new HttpError(413, "palette_too_large", "色票過多");
  await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(PALETTE_KEY, value, nowIso()).run();
  await audit(env, actor, "doll.palette.save", undefined);
  return p;
}
