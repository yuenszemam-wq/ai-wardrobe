import { acceptSmallThumbnail } from "./thumbnails";
import { Actor, Env, HttpError, audit, intVar, json, newId, nowIso, sha256Hex } from "./util";

export type ImageType = "original" | "processed" | "thumbnail";
export type Owner = "garment" | "outfit";

export interface ParsedImage {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/heic" | "image/heif";
  ext: "png" | "jpg" | "webp" | "heic" | "heif";
  width: number;
  height: number;
  hasAlpha: boolean;
}

const MAX_DIMENSION = 16384;
export const LOW_RES_PIXELS = 300 * 300;

/** HEIC／HEIF：從 ispe（image spatial extent）box 讀尺寸；可能有多個（縮圖、格狀子圖），取面積最大者 */
export function parseHeif(b: Uint8Array): ParsedImage | null {
  if (b.length < 16) return null;
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (ascii(4, 4) !== "ftyp") return null;
  const brand = ascii(8, 4);
  if (!/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|heif)$/.test(brand)) return null;
  const isHeic = /^(heic|heix|hevc|hevx|heim|heis)$/.test(brand) || ascii(8, Math.min(64, b.length - 8)).includes("heic");
  let width = 0;
  let height = 0;
  const end = Math.min(b.length - 20, 4 * 1024 * 1024); // meta box 一般在檔案開頭
  for (let i = 4; i < end; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) {
      // [size(4)][ispe][version+flags(4)][width(4)][height(4)]
      const o = i + 8;
      const w = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      const h = ((b[o + 4] << 24) | (b[o + 5] << 16) | (b[o + 6] << 8) | b[o + 7]) >>> 0;
      if (w > 0 && h > 0 && w <= 65535 && h <= 65535 && w * h > width * height) {
        width = w;
        height = h;
      }
    }
  }
  if (!width) throw new HttpError(415, "bad_image", "HEIC 檔案讀不到尺寸");
  return isHeic
    ? { mime: "image/heic", ext: "heic", width, height, hasAlpha: false }
    : { mime: "image/heif", ext: "heif", width, height, hasAlpha: false };
}

/** 根據實際檔案內容（magic bytes）判斷格式及尺寸，不信任副檔名或 Content-Type */
export function parseImage(buf: Uint8Array, opts: { allowHeif?: boolean } = {}): ParsedImage {
  const b = buf;
  const u32be = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

  let result: ParsedImage | null = null;

  // PNG
  if (b.length > 33 && b[0] === 0x89 && ascii(1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a) {
    if (ascii(12, 4) !== "IHDR") throw new HttpError(415, "bad_image", "PNG 檔案損壞");
    const width = u32be(16);
    const height = u32be(20);
    const colorType = b[25];
    let hasAlpha = colorType === 4 || colorType === 6;
    // 掃描到 IDAT 為止，看看有沒有 tRNS
    let off = 8;
    while (!hasAlpha && off + 8 <= b.length) {
      const len = u32be(off);
      const type = ascii(off + 4, 4);
      if (type === "tRNS") hasAlpha = true;
      if (type === "IDAT" || type === "IEND") break;
      off += 12 + len;
    }
    result = { mime: "image/png", ext: "png", width, height, hasAlpha };
  }
  // JPEG
  else if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = b[off + 1];
      if (marker === 0xff) {
        off++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      const segLen = (b[off + 2] << 8) | b[off + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = (b[off + 5] << 8) | b[off + 6];
        const width = (b[off + 7] << 8) | b[off + 8];
        result = { mime: "image/jpeg", ext: "jpg", width, height, hasAlpha: false };
        break;
      }
      if (marker === 0xda) break; // 已到圖像資料仍找不到 SOF
      off += 2 + segLen;
    }
    if (!result) throw new HttpError(415, "bad_image", "JPEG 檔案損壞，讀不到尺寸");
  }
  // WebP
  else if (b.length > 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8X") {
      const flags = b[20];
      const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      result = { mime: "image/webp", ext: "webp", width, height, hasAlpha: (flags & 0x10) !== 0 };
    } else if (chunk === "VP8L") {
      if (b[20] !== 0x2f) throw new HttpError(415, "bad_image", "WebP 檔案損壞");
      const v = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      result = {
        mime: "image/webp",
        ext: "webp",
        width: (v & 0x3fff) + 1,
        height: ((v >>> 14) & 0x3fff) + 1,
        hasAlpha: ((v >>> 28) & 1) === 1,
      };
    } else if (chunk === "VP8 ") {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) throw new HttpError(415, "bad_image", "WebP 檔案損壞");
      result = {
        mime: "image/webp",
        ext: "webp",
        width: (b[26] | (b[27] << 8)) & 0x3fff,
        height: (b[28] | (b[29] << 8)) & 0x3fff,
        hasAlpha: false,
      };
    } else throw new HttpError(415, "bad_image", "不支援的 WebP 格式");
  }
  // HEIC / HEIF
  else if (b.length > 12 && ascii(4, 4) === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|heif)/.test(ascii(8, 4))) {
    if (opts.allowHeif) {
      const h = parseHeif(b);
      if (h) return h;
    }
    throw new HttpError(415, "heic_not_supported", "HEIC 圖片請先轉為 JPEG、PNG 或 WebP（App 上傳會自動轉換）");
  }

  if (!result) throw new HttpError(415, "unsupported_type", "只接受 PNG、JPEG、WebP 圖片");
  if (!result.width || !result.height || result.width > MAX_DIMENSION || result.height > MAX_DIMENSION) {
    throw new HttpError(415, "bad_dimensions", `圖片尺寸不正確（${result.width}×${result.height}）`);
  }
  return result;
}

export interface StoredImage {
  id: string;
  owner: Owner;
  owner_id: string;
  image_type: ImageType;
  r2_key: string;
  mime_type: string;
  width: number;
  height: number;
  file_size: number;
  sha256: string;
  has_alpha: boolean;
  is_primary: boolean;
  deduplicated: boolean;
  warnings: string[];
}

export interface StoreOptions {
  owner: Owner;
  ownerId: string;
  imageType: ImageType;
  bytes: Uint8Array;
  isPrimary?: boolean;
  derivedFrom?: string | null;
  actor: Actor;
  /** 只限 App 上傳的原檔：保留 HEIC／HEIF 原檔（另需 JPEG 預覽） */
  allowHeif?: boolean;
  /** 瀏覽器已檢查實際像素：全部不透明（即使檔案有 Alpha 通道） */
  opaque?: boolean;
  /** 'preview'＝HEIC 的 JPEG 預覽；'analysis'＝給 AI 辨認用的中尺寸圖（image_type 必須是 thumbnail） */
  variant?: "preview" | "analysis" | null;
}

function tableFor(owner: Owner) {
  return owner === "garment"
    ? { table: "garment_images", fk: "garment_id", parent: "garments" }
    : { table: "outfit_images", fk: "outfit_id", parent: "outfits" };
}

function r2KeyFor(owner: Owner, ownerId: string, type: ImageType, imageId: string, ext: string): string {
  if (owner === "outfit") return `outfits/${ownerId}/${type === "original" ? "" : type + "-"}${imageId}.${ext}`;
  const dir = type === "original" ? "originals" : type === "processed" ? "processed" : "thumbnails";
  return `${dir}/${ownerId}/${imageId}.${ext}`;
}

export function maxUploadBytes(env: Env): number {
  return intVar(env.MAX_UPLOAD_MB, 25) * 1024 * 1024;
}

/**
 * 寫入流程：驗證 → SHA-256 去重 → 寫 R2 → 寫 D1。
 * D1 寫入失敗時刪除剛寫入的 R2 物件（補償），避免孤兒檔案。
 */
export async function storeImage(env: Env, opt: StoreOptions): Promise<StoredImage> {
  const { owner, ownerId, imageType, bytes } = opt;
  if (!["original", "processed", "thumbnail"].includes(imageType)) {
    throw new HttpError(400, "bad_image_type", "image_type 必須是 original、processed 或 thumbnail");
  }
  if (bytes.byteLength === 0) throw new HttpError(400, "empty_file", "檔案是空的");
  if (bytes.byteLength > maxUploadBytes(env)) {
    throw new HttpError(413, "file_too_large", `檔案超過 ${intVar(env.MAX_UPLOAD_MB, 25)} MB 上限`);
  }
  const parsed = parseImage(bytes, { allowHeif: Boolean(opt.allowHeif) && imageType === "original" && owner === "garment" });
  // Phase 3.8：PNG／WebP 有 Alpha 通道但瀏覽器已檢查實際像素全部不透明（opaque）時，記錄為沒有透明，才可以手動去背
  const info = opt.opaque && parsed.hasAlpha ? { ...parsed, hasAlpha: false } : parsed;
  const { table, fk, parent } = tableFor(owner);
  const variant = owner === "garment" ? opt.variant ?? null : null;
  if (variant === "preview" && (imageType !== "original" || info.mime !== "image/jpeg")) {
    throw new HttpError(400, "bad_preview", "HEIC 預覽圖必須是 JPEG");
  }
  if (variant === "analysis" && imageType !== "thumbnail") throw new HttpError(400, "bad_variant", "analysis 圖必須以 thumbnail 類型儲存");

  const parentRow = await env.DB.prepare(`SELECT id FROM ${parent} WHERE id = ?`).bind(ownerId).first();
  if (!parentRow) throw new HttpError(404, "owner_not_found", owner === "garment" ? "找不到這件衣物" : "找不到這套穿搭");

  if (opt.derivedFrom) {
    if (owner !== "garment") throw new HttpError(400, "bad_derived", "derived_from 只適用於衣物圖片");
    const src = await env.DB.prepare("SELECT id FROM garment_images WHERE id = ? AND garment_id = ?").bind(opt.derivedFrom, ownerId).first();
    if (!src) throw new HttpError(400, "bad_derived", "derived_from 不屬於這件衣物");
  }

  const sha = await sha256Hex(bytes);
  const warnings: string[] = [];
  if (info.width * info.height < LOW_RES_PIXELS && imageType !== "thumbnail" && !variant) {
    warnings.push(`解像度偏低（${info.width}×${info.height}），建議上傳更清晰的原圖`);
  }
  if (imageType === "processed" && !info.hasAlpha) {
    warnings.push("此去背圖沒有透明通道，背景可能未去除");
  }

  const existing = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${fk} = ? AND image_type = ? AND sha256 = ?`)
    .bind(ownerId, imageType, sha)
    .first<Record<string, unknown>>();
  if (existing) {
    return rowToStored(owner, existing, true, warnings);
  }

  const imageId = newId("img");
  const key = r2KeyFor(owner, ownerId, imageType, imageId, info.ext);

  await env.IMAGES.put(key, bytes, {
    httpMetadata: { contentType: info.mime, cacheControl: "private, max-age=31536000, immutable" },
    customMetadata: { sha256: sha, owner, owner_id: ownerId, image_type: imageType },
    sha256: sha,
  });

  // 是否設為主圖：明確要求，或此衣物仍未有主圖（縮圖除外）
  let makePrimary = false;
  if (imageType !== "thumbnail") {
    if (opt.isPrimary) makePrimary = true;
    else {
      const prim = await env.DB.prepare(`SELECT id FROM ${table} WHERE ${fk} = ? AND is_primary = 1 LIMIT 1`)
        .bind(ownerId)
        .first();
      // 去背圖優先作主圖
      if (!prim) makePrimary = true;
      else if (imageType === "processed") {
        const primType = await env.DB.prepare(`SELECT image_type FROM ${table} WHERE ${fk} = ? AND is_primary = 1 LIMIT 1`)
          .bind(ownerId)
          .first<{ image_type: string }>();
        if (primType?.image_type === "original") makePrimary = true;
      }
    }
  }

  const createdAt = nowIso();
  try {
    const stmts: D1PreparedStatement[] = [];
    if (makePrimary) stmts.push(env.DB.prepare(`UPDATE ${table} SET is_primary = 0 WHERE ${fk} = ?`).bind(ownerId));
    if (owner === "garment") {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO garment_images (id, garment_id, image_type, r2_key, mime_type, width, height, file_size, sha256, has_alpha, is_primary, derived_from, created_at, variant)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          imageId, ownerId, imageType, key, info.mime, info.width, info.height, bytes.byteLength, sha,
          info.hasAlpha ? 1 : 0, makePrimary ? 1 : 0, opt.derivedFrom ?? null, createdAt, variant,
        ),
      );
      stmts.push(env.DB.prepare("UPDATE garments SET updated_at = ? WHERE id = ?").bind(createdAt, ownerId));
    } else {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO outfit_images (id, outfit_id, image_type, r2_key, mime_type, width, height, file_size, sha256, has_alpha, is_primary, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          imageId, ownerId, imageType, key, info.mime, info.width, info.height, bytes.byteLength, sha,
          info.hasAlpha ? 1 : 0, makePrimary ? 1 : 0, createdAt,
        ),
      );
    }
    await env.DB.batch(stmts);
  } catch (err) {
    // 補償：D1 失敗即刪除 R2 物件
    await env.IMAGES.delete(key).catch((e) => console.error("compensation delete failed", key, e));
    console.error("D1 insert failed after R2 put; rolled back", key, err);
    // 若是並發重複上傳造成的 UNIQUE 衝突，回傳已存在的記錄
    const dup = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${fk} = ? AND image_type = ? AND sha256 = ?`)
      .bind(ownerId, imageType, sha)
      .first<Record<string, unknown>>();
    if (dup) return rowToStored(owner, dup, true, warnings);
    throw new HttpError(500, "db_write_failed", "資料庫寫入失敗，圖片已回滾，請重試");
  }

  // 讀回驗證：R2 物件大小及 SHA-256 必須與上傳內容一致
  const head = await env.IMAGES.head(key);
  if (!head || head.size !== bytes.byteLength || (head.customMetadata?.sha256 && head.customMetadata.sha256 !== sha)) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(imageId).run().catch(() => undefined);
    await env.IMAGES.delete(key).catch(() => undefined);
    throw new HttpError(500, "readback_failed", "圖片寫入後讀回驗證失敗，已回滾，請重試");
  }

  await acceptSmallThumbnail(env,imageId,owner,sha,bytes,opt.derivedFrom);

  await audit(env, opt.actor, "image.upload", imageId, { owner, ownerId, imageType, variant, size: bytes.byteLength, w: info.width, h: info.height });

  return {
    id: imageId,
    owner,
    owner_id: ownerId,
    image_type: imageType,
    r2_key: key,
    mime_type: info.mime,
    width: info.width,
    height: info.height,
    file_size: bytes.byteLength,
    sha256: sha,
    has_alpha: info.hasAlpha,
    is_primary: makePrimary,
    deduplicated: false,
    warnings,
  };
}

function rowToStored(owner: Owner, r: Record<string, unknown>, dedup: boolean, warnings: string[]): StoredImage {
  return {
    id: String(r.id),
    owner,
    owner_id: String(owner === "garment" ? r.garment_id : r.outfit_id),
    image_type: r.image_type as ImageType,
    r2_key: String(r.r2_key),
    mime_type: String(r.mime_type),
    width: Number(r.width),
    height: Number(r.height),
    file_size: Number(r.file_size),
    sha256: String(r.sha256),
    has_alpha: Number(r.has_alpha) === 1,
    is_primary: Number(r.is_primary) === 1,
    deduplicated: dedup,
    warnings,
  };
}

/** 從 multipart/form-data 或原始 binary（PUT / POST image/*）讀取檔案 */
export async function readUploadBody(
  req: Request,
  env: Env,
): Promise<{ bytes: Uint8Array; fields: Record<string, string> }> {
  const limit = maxUploadBytes(env);
  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > limit + 64 * 1024) throw new HttpError(413, "file_too_large", "檔案超過上傳上限");
  const ctype = req.headers.get("content-type") || "";
  const url = new URL(req.url);
  const fields: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (fields[k] = v));

  if (ctype.startsWith("multipart/form-data")) {
    const form = await req.formData();
    let file: File | null = null;
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") fields[k] = v;
      else if (!file && (k === "file" || k === "image")) file = v as unknown as File;
    }
    if (!file) throw new HttpError(400, "no_file", "找不到上傳檔案（欄位名稱應為 file）");
    return { bytes: new Uint8Array(await file.arrayBuffer()), fields };
  }
  if (ctype.startsWith("image/") || ctype === "application/octet-stream" || req.method === "PUT") {
    const ab = await req.arrayBuffer();
    return { bytes: new Uint8Array(ab), fields };
  }
  if (ctype.startsWith("application/json")) {
    throw new HttpError(415, "json_upload_not_allowed", "請以二進位或 multipart 上傳圖片，不接受 Base64 JSON");
  }
  throw new HttpError(415, "bad_content_type", "不支援的 Content-Type");
}

export async function serveImage(req: Request, env: Env, imageId: string): Promise<Response> {
  let row = await env.DB.prepare("SELECT r2_key, mime_type, sha256 FROM garment_images WHERE id = ?")
    .bind(imageId)
    .first<{ r2_key: string; mime_type: string; sha256: string }>();
  if (!row) {
    row = await env.DB.prepare("SELECT r2_key, mime_type, sha256 FROM outfit_images WHERE id = ?")
      .bind(imageId)
      .first<{ r2_key: string; mime_type: string; sha256: string }>();
  }
  if (!row) throw new HttpError(404, "image_not_found", "找不到圖片");
  const etag = `"${row.sha256}"`;
  const headers = {
    "content-type": row.mime_type,
    "cache-control": "private, max-age=31536000, immutable",
    etag,
    "x-content-type-options": "nosniff",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  let obj;
  try { obj = await env.IMAGES.get(row.r2_key); }
  catch { throw new HttpError(503, "r2_read_failed", "高清圖片暫時未能讀取，請稍後重試"); }
  if (!obj) throw new HttpError(404, "object_missing", "R2 找不到圖片檔案");
  return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
}

export async function deleteImage(env: Env, actor: Actor, imageId: string): Promise<Response> {
  if (await env.DB.prepare("SELECT id FROM doll_looks WHERE state LIKE ? LIMIT 1").bind('%img:' + imageId + '%').first()) throw new HttpError(409, "image_in_use", "這張圖片仍被已保存造型引用，請保留此版本");
  for (const { table, fk } of [tableFor("garment"), tableFor("outfit")]) {
    const row = await env.DB.prepare(`SELECT id, r2_key, ${fk} AS owner_id, is_primary FROM ${table} WHERE id = ?`)
      .bind(imageId)
      .first<{ id: string; r2_key: string; owner_id: string; is_primary: number }>();
    if (!row) continue;
    // 連同由此圖產生的縮圖一併刪除
    const derived =
      table === "garment_images"
        ? (await env.DB.prepare("SELECT id, r2_key FROM garment_images WHERE derived_from = ?").bind(imageId).all<{ id: string; r2_key: string }>()).results
        : [];
    const keys = [row.r2_key, ...derived.map((d) => d.r2_key)];
    const stmts = [env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(imageId)];
    for (const d of derived) stmts.push(env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(d.id));
    await env.DB.batch(stmts);
    await env.IMAGES.delete(keys);
    if (row.is_primary) {
      await env.DB.prepare(
        `UPDATE ${table} SET is_primary = 1 WHERE id = (SELECT id FROM ${table} WHERE ${fk} = ? AND image_type != 'thumbnail'
         ORDER BY CASE image_type WHEN 'processed' THEN 0 ELSE 1 END, created_at LIMIT 1)`,
      )
        .bind(row.owner_id)
        .run();
    }
    await audit(env, actor, "image.delete", imageId);
    return json({ ok: true, deleted_keys: keys.length });
  }
  throw new HttpError(404, "image_not_found", "找不到圖片");
}

export async function setPrimary(env: Env, imageId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT garment_id, image_type FROM garment_images WHERE id = ?")
    .bind(imageId)
    .first<{ garment_id: string; image_type: string }>();
  if (!row) throw new HttpError(404, "image_not_found", "找不到圖片");
  if (row.image_type === "thumbnail") throw new HttpError(400, "bad_primary", "縮圖不能設為主圖");
  await env.DB.batch([
    env.DB.prepare("UPDATE garment_images SET is_primary = 0 WHERE garment_id = ?").bind(row.garment_id),
    env.DB.prepare("UPDATE garment_images SET is_primary = 1 WHERE id = ?").bind(imageId),
  ]);
  return json({ ok: true });
}

/** 列出 R2 中沒有 D1 記錄的孤兒檔案，可選擇刪除（手動維護用） */
export async function cleanupOrphans(env: Env, actor: Actor, doDelete: boolean): Promise<Response> {
  const orphans: string[] = [];
  let cursor: string | undefined;
  let scanned = 0;
  do {
    const list = await env.IMAGES.list({ cursor, limit: 500 });
    scanned += list.objects.length;
    const keys = list.objects.map((o) => o.key);
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const ph = chunk.map(() => "?").join(",");
      const found = new Set<string>();
      for (const t of ["garment_images", "outfit_images"]) {
        const { results } = await env.DB.prepare(`SELECT r2_key FROM ${t} WHERE r2_key IN (${ph})`).bind(...chunk).all<{ r2_key: string }>();
        results.forEach((r) => found.add(r.r2_key));
      }
      // 只當作孤兒處理超過 1 小時的檔案，避免誤刪正在寫入中的上傳
      for (const o of list.objects.slice(i, i + 50)) {
        // settings/ 是主頁背景圖等設定檔案；doll/ 是角色素材（由 doll_asset_files 管理），都不屬於孤兒
        if (!found.has(o.key) && !o.key.startsWith("settings/") && !o.key.startsWith("doll/") && Date.now() - o.uploaded.getTime() > 3600_000) orphans.push(o.key);
      }
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor && scanned < 20000);
  if (doDelete && orphans.length) {
    for (let i = 0; i < orphans.length; i += 1000) await env.IMAGES.delete(orphans.slice(i, i + 1000));
    await audit(env, actor, "maintenance.orphans_deleted", undefined, { count: orphans.length });
  }
  return json({ scanned, orphans: orphans.length, deleted: doDelete ? orphans.length : 0, sample: orphans.slice(0, 20) });
}
