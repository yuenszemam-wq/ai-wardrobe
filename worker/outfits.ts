/**
 * 衣服配搭（Phase 3.9A.2：獨立圖層、背景、完整縮圖、原子保存）。
 *
 * - 圖層存於 outfit_layers（每個畫布實例有自己的 layer_id）；舊造型沒有圖層資料時，由 outfit_items 生成穩定圖層（g:<衣物 ID>），畫面不變。
 * - 保存一律「先完整驗證，再一次以 D1 batch（交易）提交」：造型資料、圖層、衣物清單（outfit_items）及縮圖一起成功或一起失敗，
 *   不會出現名稱已更新但圖層失敗、或舊圖層已刪除但新圖層未寫入的情況。
 * - base_updated_at：若造型已在另一部裝置修改，回覆 409，前端保留草稿。
 * - 列表一次讀取所有造型的衣物及縮圖版本（不再逐套查詢）。
 */
import { BackgroundSpec, Layer, LegacyItem, MAX_LAYERS, garmentIdsOf, legacyLayers, normalizeBackground, normalizeLayer, slotFor } from "../shared/studioScene";
import { purgeUnusedAssets } from "./studio";
import { findOp, opStatements, validOpId } from "./ops";
import { hasColumn } from "./schema";
import { parseImage } from "./images";
import { transparentImageSql } from "./transparent";
import { Actor, Env, HttpError, audit, newId, nowIso, sha256Hex, str } from "./util";

interface OutfitInput {
  name?: unknown;
  notes?: unknown;
  style?: unknown;
  is_favorite?: unknown;
  status?: unknown;
  /** 舊版格式（只有衣物及位置）；仍然接受 */
  items?: { garment_id: string; position?: number; layer_order?: number; x?: number; y?: number; w?: number; h?: number }[];
  /** Phase 3.9A.2：由底至頂的圖層 */
  layers?: unknown;
  background?: unknown;
  /** 完整合成縮圖（base64 WebP／JPEG，最大 120 KB） */
  thumb?: unknown;
  base_updated_at?: unknown;
  /** Phase 3.9A.2.1：冪等操作識別（建立造型時重試不會重複建立） */
  op_id?: unknown;
}

const MAX_THUMB = 120 * 1024;

type LayerRow = { image_id?: string | null; outfit_id: string; layer_id: string; layer_type: Layer["layer_type"]; garment_id: string | null; garment_part_id: string | null; asset_id: string | null; asset_version_id: string | null; group_id: string | null; name: string | null; layer_order: number; x: number; y: number; w: number; h: number; rotation: number; flip_x: number; flip_y: number; opacity: number; hidden: number; locked: number; mask: string | null; variant: string | null };
const parseJson = (s: string | null) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
const rowToLayer = (r: LayerRow): Layer => ({ layer_id: r.layer_id, layer_type: r.layer_type, garment_id: r.garment_id, garment_part_id: r.garment_part_id, asset_id: r.asset_id, asset_version_id: r.asset_version_id, group_id: r.group_id, name: r.name ?? "", x: r.x, y: r.y, w: r.w, h: r.h, rotation: r.rotation, flip_x: !!r.flip_x, flip_y: !!r.flip_y, opacity: r.opacity, hidden: !!r.hidden, locked: !!r.locked, mask: parseJson(r.mask), variant: r.variant === "cutout" ? "cutout" : "original", image_id: r.image_id ?? null });

/** 圖層需要的圖片：衣物＝透明圖；套裝部件＝部件檔案；素材＝版本（使用去背圖或原圖） */
async function layerImages(env: Env, layers: Layer[]) {
  const gids = garmentIdsOf(layers), parts = [...new Set(layers.map((l) => l.garment_part_id).filter((x): x is string => !!x))], vers = [...new Set(layers.map((l) => l.asset_version_id).filter((x): x is string => !!x))];
  const g = new Map<string, { name: string; category: string | null; image_id: string | null }>();
  const p = new Map<string, { name: string; file_id: string | null }>();
  const v = new Map<string, { asset_id: string; name: string; has_cutout: number; width: number; height: number }>();
  // 已保存的衣物圖片版本（只接受仍屬於該衣物的圖片）
  const pinned = new Map<string, string>();
  const pins = [...new Set(layers.map((l) => (l.layer_type === "garment" ? l.image_id : null)).filter((x): x is string => !!x))];
  for (let i = 0; i < pins.length; i += 80) {
    const part = pins.slice(i, i + 80);
    const r = await env.DB.prepare(`SELECT id, garment_id FROM garment_images WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ id: string; garment_id: string }>();
    for (const x of r.results) pinned.set(x.id, x.garment_id);
  }
  for (let i = 0; i < gids.length; i += 80) {
    const part = gids.slice(i, i + 80);
    const r = await env.DB.prepare(`SELECT g.id, g.name, g.category, ${transparentImageSql()} AS image_id FROM garments g WHERE g.id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ id: string; name: string; category: string | null; image_id: string | null }>();
    for (const x of r.results) g.set(x.id, x);
  }
  for (let i = 0; i < parts.length; i += 80) {
    const part = parts.slice(i, i + 80);
    const r = await env.DB.prepare(`SELECT a.id, a.name, (SELECT f.id FROM doll_asset_files f WHERE f.asset_id = a.id ORDER BY f.created_at LIMIT 1) AS file_id FROM doll_assets a WHERE a.id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ id: string; name: string; file_id: string | null }>();
    for (const x of r.results) p.set(x.id, x);
  }
  for (let i = 0; i < vers.length; i += 80) {
    const part = vers.slice(i, i + 80);
    const r = await env.DB.prepare(`SELECT v.id, v.asset_id, a.name, (v.cutout_key IS NOT NULL) AS has_cutout, v.width, v.height FROM studio_asset_versions v JOIN studio_assets a ON a.id = v.asset_id WHERE v.id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ id: string; asset_id: string; name: string; has_cutout: number; width: number; height: number }>();
    for (const x of r.results) v.set(x.id, x);
  }
  return { g, p, v, pinned };
}
function decorate(layers: Layer[], im: Awaited<ReturnType<typeof layerImages>>) {
  return layers.map((l) => {
    if (l.layer_type === "studio_asset") {
      const v = im.v.get(l.asset_version_id!);
      return { ...l, name: l.name || v?.name || "素材", image_url: v ? `/api/studio/versions/${l.asset_version_id}${l.variant === "cutout" && v.has_cutout ? "?cutout=1" : ""}` : null, has_cutout: !!v?.has_cutout, missing: !v };
    }
    const g = im.g.get(l.garment_id!);
    if (l.layer_type === "garment_part") {
      const p = im.p.get(l.garment_part_id!);
      return { ...l, name: l.name || (g && p ? `${g.name}｜${p.name}` : p?.name ?? "部件"), category: g?.category ?? null, image_url: p?.file_id ? `/api/doll/files/${p.file_id}` : null, missing: !p };
    }
    // 圖片版本：保存時的版本仍存在＝使用該版本（衣櫃換圖不影響舊造型）；版本已不存在＝退回目前透明圖並標示
    const pin = l.image_id && im.pinned.get(l.image_id) === l.garment_id ? l.image_id : null;
    const use = pin ?? g?.image_id ?? null;
    return { ...l, name: l.name || g?.name || "已刪除的衣物", category: g?.category ?? null, image_id: use, image_url: use ? `/api/images/${use}` : null, missing: !g || !use,
      latest_image_id: g?.image_id ?? null, image_outdated: !!(pin && g?.image_id && pin !== g.image_id), image_fallback: !!(l.image_id && !pin) };
  });
}

/** 舊造型（沒有圖層資料）的原始衣物清單：位置可能是 null（App 按類別使用預設位置） */
const legacyRaw = new WeakMap<Map<string, Layer[]>, Map<string, (LegacyItem & { outfit_id: string })[]>>();
async function loadLayers(env: Env, ids: string[]): Promise<Map<string, Layer[]>> {
  const out = new Map<string, Layer[]>();
  const raw = new Map<string, (LegacyItem & { outfit_id: string })[]>();
  legacyRaw.set(out, raw);
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80), ph = part.map(() => "?").join(",");
    const [layers, items] = await Promise.all([
      env.DB.prepare(`SELECT * FROM outfit_layers WHERE outfit_id IN (${ph}) ORDER BY outfit_id, layer_order`).bind(...part).all<LayerRow>().catch(() => ({ results: [] as LayerRow[] })),
      env.DB.prepare(`SELECT i.outfit_id, i.garment_id, i.position, i.layer_order, i.x, i.y, i.w, i.h, g.name, g.category FROM outfit_items i LEFT JOIN garments g ON g.id = i.garment_id WHERE i.outfit_id IN (${ph})`).bind(...part).all<LegacyItem & { outfit_id: string }>(),
    ]);
    for (const id of part) {
      const own = layers.results.filter((r) => r.outfit_id === id);
      // 有新版圖層＝使用圖層；否則由舊版衣物清單生成（位置及次序不變）
      if (own.length) out.set(id, own.map(rowToLayer));
      else { const li = items.results.filter((r) => r.outfit_id === id); raw.set(id, li); out.set(id, legacyLayers(li, (i) => slotFor(i.category))); }
    }
  }
  return out;
}

/** 分頁：cursor＝上一頁最後一套的「created_at|id」；回應另附 next_cursor 及 total（舊版 App 只讀 outfits，不受影響） */
export async function listOutfitsPage(env: Env, params: URLSearchParams) {
  const where = [params.get("status") ? "o.status = ?" : "o.status != 'archived'"];
  const binds: unknown[] = params.get("status") ? [params.get("status")] : [];
  if (params.get("favorite") === "1") where.push("o.is_favorite = 1");
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM outfits o WHERE ${where.join(" AND ")}`).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const cur = params.get("cursor")?.split("|");
  if (cur && cur.length === 2) { where.push("(o.created_at < ? OR (o.created_at = ? AND o.id < ?))"); binds.push(cur[0], cur[0], cur[1]); }
  const limit = Math.min(200, Math.max(1, Number(params.get("limit")) || 200));
  const { results } = await env.DB.prepare(
    `SELECT o.*,
       (SELECT oi.id FROM outfit_images oi WHERE oi.outfit_id = o.id AND oi.has_alpha = 1 AND oi.image_type = 'processed' ORDER BY oi.is_primary DESC LIMIT 1) AS image_id
     FROM outfits o WHERE ${where.join(" AND ")} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
  ).bind(...binds, limit + 1).all<Record<string, unknown>>();
  const more = results.length > limit;
  const page = results.slice(0, limit);
  const last = page[page.length - 1];
  return { outfits: await shapeList(env, page), total, next_cursor: more && last ? `${last.created_at}|${last.id}` : null };
}
export async function listOutfits(env: Env, params: URLSearchParams) { return (await listOutfitsPage(env, params)).outfits; }
async function shapeList(env: Env, results: Record<string, unknown>[]) {
  const ids = results.map((o) => String(o.id));
  const layers = await loadLayers(env, ids);
  const thumbs = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    const r = await env.DB.prepare(`SELECT outfit_id, version FROM outfit_thumbs WHERE outfit_id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ outfit_id: string; version: string }>().catch(() => ({ results: [] as { outfit_id: string; version: string }[] }));
    for (const t of r.results) thumbs.set(t.outfit_id, t.version);
  }
  const im = await layerImages(env, [...layers.values()].flat());
  return results.map((o) => {
    const ls = decorate(layers.get(String(o.id)) ?? [], im);
    const { background: bg, save_token: _t, ...rest } = o;
    return {
      ...rest, is_favorite: Number(o.is_favorite) === 1, background: normalizeBackground(parseJson(bg as string | null)),
      item_count: garmentIdsOf(ls).length, layer_count: ls.length,
      thumb_url: thumbs.has(String(o.id)) ? `/api/outfits/${o.id}/thumb?v=${encodeURIComponent(thumbs.get(String(o.id))!)}` : null,
      // 舊版預覽仍使用的衣物清單（由底至頂）
      items: ls.filter((l) => l.layer_type === "garment" && !l.hidden).map((l, i) => ({ garment_id: l.garment_id, name: l.name, image_id: (l as { image_id?: string | null }).image_id ?? null, layer_order: i, x: l.x, y: l.y, w: l.w, h: l.h })),
    };
  });
}

export async function getOutfit(env: Env, id: string) {
  const o = await env.DB.prepare("SELECT * FROM outfits WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!o) throw new HttpError(404, "outfit_not_found", "找不到這套穿搭");
  const all = await loadLayers(env, [id]);
  const layers = all.get(id) ?? [];
  const raw = legacyRaw.get(all)?.get(id);
  const decorated = decorate(layers, await layerImages(env, layers));
  const { results: images } = await env.DB.prepare(
    "SELECT id, image_type, width, height, has_alpha, is_primary FROM outfit_images WHERE outfit_id = ? AND has_alpha = 1 AND image_type = 'processed' ORDER BY is_primary DESC, created_at",
  ).bind(id).all();
  const thumb = await env.DB.prepare("SELECT version FROM outfit_thumbs WHERE outfit_id = ?").bind(id).first<{ version: string }>().catch(() => null);
  const { save_token: _t, ...head } = o;
  return {
    ...head, is_favorite: Number(o.is_favorite) === 1, background: normalizeBackground(parseJson(o.background as string | null)),
    layers: decorated,
    // 舊版欄位（衣物清單，由底至頂）
    items: decorated.filter((l) => l.layer_type === "garment").map((l, i) => {
      // 舊造型：保留原本 null 位置（舊版 App 及 AI 工具按類別使用預設位置）
      const r = raw?.find((x) => "g:" + x.garment_id === l.layer_id);
      return { garment_id: l.garment_id, name: l.name, category: (l as { category?: string | null }).category ?? null, image_id: (l as { image_id?: string | null }).image_id ?? null, thumb_image_id: (l as { image_id?: string | null }).image_id ?? null, position: i, layer_order: i, x: r ? r.x : l.x, y: r ? r.y : l.y, w: r ? r.w : l.w, h: r ? r.h : l.h };
    }),
    images, thumb_url: thumb ? `/api/outfits/${id}/thumb?v=${encodeURIComponent(thumb.version)}` : null,
  };
}

/** 畫布位置（佔畫布百分比） */
function pct(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

interface Prepared { legacyItems?: { garment_id: string; position: number; layer_order: number; x: number | null; y: number | null; w: number | null; h: number | null }[]; layers: Layer[] | null; background: BackgroundSpec | null | undefined; thumb: { bytes: Uint8Array; mime: string; version: string } | null }
/** 先完整驗證：圖層、引用存在性、背景、縮圖。任何錯誤都在寫入之前拋出 */
async function prepare(env: Env, input: OutfitInput): Promise<Prepared> {
  let layers: Layer[] | null = null;
  if (input.layers !== undefined) {
    if (!Array.isArray(input.layers)) throw new HttpError(400, "bad_layers", "圖層格式錯誤");
    if (input.layers.length > MAX_LAYERS) throw new HttpError(400, "too_many_layers", `每套造型最多 ${MAX_LAYERS} 個圖層（現有 ${input.layers.length} 個），請移除部分圖層後再保存`);
    const seen = new Set<string>();
    layers = [];
    for (const raw of input.layers) {
      const l = normalizeLayer(raw);
      if (typeof l === "string") throw new HttpError(400, "bad_layer", l);
      if (seen.has(l.layer_id)) throw new HttpError(400, "duplicate_layer", "圖層識別重複");
      seen.add(l.layer_id);
      layers.push(l);
    }
  } else if (Array.isArray(input.items)) {
    // 舊版格式（AI 工具、舊版 App）：只有衣物及位置，同一衣物只保留一次；照舊寫入 outfit_items（沒有位置＝null）
    if (input.items.length > 30) throw new HttpError(400, "bad_items", "items 格式錯誤（最多 30 件）");
    const seen = new Set<string>();
    const legacy = input.items.filter((it) => { const g = String(it?.garment_id || ""); if (!g || seen.has(g)) return false; seen.add(g); return true; })
      .map((it, i) => ({ garment_id: String(it.garment_id), position: Number.isFinite(it.position) ? Number(it.position) : i, layer_order: Number.isFinite(it.layer_order) ? Number(it.layer_order) : i, x: pct(it.x, -50, 150), y: pct(it.y, -50, 150), w: pct(it.w, 2, 300), h: pct(it.h, 2, 300) }));
    const gids = legacy.map((x) => x.garment_id);
    for (let i = 0; i < gids.length; i += 80) {
      const part = gids.slice(i, i + 80);
      const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM garments WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).first<{ n: number }>())?.n ?? 0;
      if (n !== part.length) throw new HttpError(400, "bad_garment", "有衣物不存在，未能儲存穿搭");
    }
    return { legacyItems: legacy, layers: null, background: undefined, thumb: null };
  }
  if (layers) {
    const gids = garmentIdsOf(layers);
    for (let i = 0; i < gids.length; i += 80) {
      const part = gids.slice(i, i + 80);
      const n = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM garments WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).first<{ n: number }>())?.n ?? 0;
      if (n !== part.length) throw new HttpError(400, "bad_garment", "有衣物不存在，未能儲存穿搭");
    }
    const parts = layers.filter((l) => l.layer_type === "garment_part");
    for (const l of parts) if (!(await env.DB.prepare("SELECT id FROM doll_assets WHERE id = ? AND garment_id = ?").bind(l.garment_part_id, l.garment_id).first())) throw new HttpError(400, "part_not_found", "找不到套裝部件");
    const vers = [...new Set(layers.map((l) => l.asset_version_id).filter((x): x is string => !!x))];
    for (const v of vers) if (!(await env.DB.prepare("SELECT id FROM studio_asset_versions WHERE id = ?").bind(v).first())) throw new HttpError(400, "asset_not_found", "找不到素材（可能已刪除）");
    // 衣物圖片版本：用戶端指定的版本必須屬於該衣物；沒有指定＝保存當時的透明圖（之後衣櫃換圖不會改變這套造型）
    if (await hasColumn(env, "outfit_layers", "image_id")) {
      const pins = [...new Set(layers.map((l) => (l.layer_type === "garment" ? l.image_id : null)).filter((x): x is string => !!x))];
      const owner = new Map<string, string>();
      for (let i = 0; i < pins.length; i += 80) {
        const part = pins.slice(i, i + 80);
        for (const r of (await env.DB.prepare(`SELECT id, garment_id FROM garment_images WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ id: string; garment_id: string }>()).results) owner.set(r.id, r.garment_id);
      }
      const need = [...new Set(layers.filter((l) => l.layer_type === "garment" && (!l.image_id || owner.get(l.image_id) !== l.garment_id)).map((l) => l.garment_id!))];
      const current = new Map<string, string | null>();
      for (let i = 0; i < need.length; i += 80) {
        const part = need.slice(i, i + 80);
        for (const r of (await env.DB.prepare(`SELECT g.id, ${transparentImageSql()} AS image_id FROM garments g WHERE g.id IN (${part.map(() => "?").join(",")})`).bind(...part).all<{ id: string; image_id: string | null }>()).results) current.set(r.id, r.image_id);
      }
      layers = layers.map((l) => {
        if (l.layer_type !== "garment") return { ...l, image_id: null };
        if (l.image_id && owner.get(l.image_id) === l.garment_id) return l;
        // 指定的版本已刪除或不屬於該衣物：改用目前的透明圖（不拒絕保存，畫面與載入時一致）
        return { ...l, image_id: current.get(l.garment_id!) ?? null };
      });
    }
    for (const l of layers) {
      if (l.layer_type !== "studio_asset") continue;
      const v = await env.DB.prepare("SELECT cutout_key FROM studio_asset_versions WHERE id = ? AND asset_id = ?").bind(l.asset_version_id, l.asset_id).first<{ cutout_key: string | null }>();
      if (!v) throw new HttpError(400, "asset_mismatch", "素材版本不正確");
      if (l.variant === "cutout" && !v.cutout_key) throw new HttpError(400, "no_cutout", "這個素材版本未有去背圖");
    }
  }
  let background: BackgroundSpec | null | undefined;
  if (input.background !== undefined) {
    background = input.background === null ? null : normalizeBackground(input.background);
    if (input.background !== null && !background) throw new HttpError(400, "bad_background", "背景設定不正確");
    if (background?.image && !(await env.DB.prepare("SELECT id FROM studio_asset_versions WHERE id = ? AND asset_id = ?").bind(background.image.version_id, background.image.asset_id).first())) throw new HttpError(400, "background_not_found", "找不到背景圖片");
  }
  let thumb: Prepared["thumb"] = null;
  if (typeof input.thumb === "string" && input.thumb) {
    const b64 = input.thumb.replace(/^data:[^,]+,/, "");
    if (b64.length > Math.ceil((MAX_THUMB * 4) / 3) + 8) throw new HttpError(413, "thumb_too_large", "縮圖太大");
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { throw new HttpError(400, "bad_thumb", "縮圖格式不正確"); }
    const info = parseImage(bytes);
    if (!["image/webp", "image/jpeg", "image/png"].includes(info.mime) || info.width > 900 || info.height > 1200) throw new HttpError(415, "bad_thumb", "縮圖格式或尺寸不正確");
    thumb = { bytes, mime: info.mime, version: (await sha256Hex(bytes)).slice(0, 16) };
  }
  return { layers, background, thumb };
}

async function writeStatements(env: Env, outfitId: string, p: Prepared) {
  const stmts: D1PreparedStatement[] = [];
  const pin = await hasColumn(env, "outfit_layers", "image_id");
  if (p.legacyItems) {
    stmts.push(env.DB.prepare("DELETE FROM outfit_layers WHERE outfit_id = ?").bind(outfitId), env.DB.prepare("DELETE FROM outfit_items WHERE outfit_id = ?").bind(outfitId));
    for (const it of p.legacyItems) stmts.push(env.DB.prepare("INSERT INTO outfit_items (outfit_id, garment_id, position, layer_order, x, y, w, h) VALUES (?,?,?,?,?,?,?,?)").bind(outfitId, it.garment_id, it.position, it.layer_order, it.x, it.y, it.w, it.h));
  }
  if (p.layers) {
    stmts.push(env.DB.prepare("DELETE FROM outfit_layers WHERE outfit_id = ?").bind(outfitId));
    p.layers.forEach((l, i) => stmts.push(env.DB.prepare(`INSERT INTO outfit_layers (layer_id, outfit_id, layer_type, garment_id, garment_part_id, asset_id, asset_version_id, group_id, name, layer_order, x, y, w, h, rotation, flip_x, flip_y, opacity, hidden, locked, mask, variant${pin ? ", image_id" : ""}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?${pin ? ",?" : ""})`)
      .bind(l.layer_id, outfitId, l.layer_type, l.garment_id, l.garment_part_id, l.asset_id, l.asset_version_id, l.group_id, l.name || null, i, l.x, l.y, l.w, l.h, l.rotation, l.flip_x ? 1 : 0, l.flip_y ? 1 : 0, l.opacity, l.hidden ? 1 : 0, l.locked ? 1 : 0, l.mask ? JSON.stringify(l.mask) : null, l.variant, ...(pin ? [l.image_id ?? null] : []))));
    // outfit_items：不重複的衣物清單（日誌、分析、衣物使用次數沿用）；位置取該衣物最上層的整件圖層
    stmts.push(env.DB.prepare("DELETE FROM outfit_items WHERE outfit_id = ?").bind(outfitId));
    garmentIdsOf(p.layers).forEach((gid, i) => {
      const top = [...p.layers!].reverse().find((l) => l.garment_id === gid && l.layer_type === "garment") ?? p.layers!.find((l) => l.garment_id === gid)!;
      stmts.push(env.DB.prepare("INSERT INTO outfit_items (outfit_id, garment_id, position, layer_order, x, y, w, h) VALUES (?,?,?,?,?,?,?,?)").bind(outfitId, gid, i, p.layers!.indexOf(top), top.x, top.y, top.w, top.h));
    });
  }
  if (p.background !== undefined) stmts.push(env.DB.prepare("UPDATE outfits SET background = ? WHERE id = ?").bind(p.background ? JSON.stringify(p.background) : null, outfitId));
  // 畫面已改變但沒有新縮圖（圖片未載入、舊版 App、AI 工具）：移除舊縮圖，避免列表顯示過時的畫面；App 之後會補建
  if (!p.thumb && (p.layers || p.legacyItems || p.background !== undefined)) stmts.push(env.DB.prepare("DELETE FROM outfit_thumbs WHERE outfit_id = ?").bind(outfitId));
  if (p.thumb) stmts.push(env.DB.prepare("INSERT INTO outfit_thumbs (outfit_id, data, mime_type, byte_size, version, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(outfit_id) DO UPDATE SET data=excluded.data, mime_type=excluded.mime_type, byte_size=excluded.byte_size, version=excluded.version, updated_at=excluded.updated_at").bind(outfitId, p.thumb.bytes, p.thumb.mime, p.thumb.bytes.byteLength, p.thumb.version, nowIso()));
  return stmts;
}

export async function createOutfit(env: Env, actor: Actor, input: OutfitInput) {
  const opId = validOpId(input.op_id);
  const done = await findOp(env, opId, "outfit.create");
  if (done) return getOutfit(env, done); // 重試：取回第一次建立的造型
  const p = await prepare(env, input);
  const id = newId("out");
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO outfits (id, name, notes, style, is_favorite, status, source, created_at, updated_at) VALUES (?,?,?,?,?, 'active', ?, ?, ?)")
      .bind(id, str(input.name, 120) || "新穿搭", str(input.notes, 2000), str(input.style, 40), input.is_favorite ? 1 : 0, actor.kind === "session" ? "manual" : actor.label, now, now),
    ...(await writeStatements(env, id, p)),
    ...(await opStatements(env, opId, "outfit.create", id)),
  ]);
  await audit(env, actor, "outfit.create", id);
  return getOutfit(env, id);
}

export async function updateOutfit(env: Env, actor: Actor, id: string, input: OutfitInput) {
  const cur = await env.DB.prepare("SELECT id, updated_at FROM outfits WHERE id = ?").bind(id).first<{ id: string; updated_at: string }>();
  if (!cur) throw new HttpError(404, "outfit_not_found", "找不到這套穿搭");
  const base = typeof input.base_updated_at === "string" ? input.base_updated_at : null;
  if (base && base !== cur.updated_at) throw conflict();
  const p = await prepare(env, input);
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
  // 同一毫秒內連續保存：updated_at 仍需改變，衝突偵測才可靠
  const now = nowIso();
  binds.push(now === cur.updated_at ? new Date(Date.parse(now) + 1).toISOString() : now);
  // 原子提交：造型資料、圖層、衣物清單、背景及縮圖一起成功或一起失敗。
  // CAS：在同一個交易內以 base_updated_at 更新並寫入隨機標記，下一句核對標記；
  // 另一部裝置在「檢查」與「提交」之間保存了＝更新 0 行、標記不符，整個交易回滾（不會互相覆蓋）。
  const cas = await hasColumn(env, "outfits", "save_token");
  const token = cas ? crypto.randomUUID() : null;
  if (token) { sets.push("save_token = ?"); binds.push(token); }
  const head = [env.DB.prepare(`UPDATE outfits SET ${sets.join(", ")} WHERE id = ?${base ? " AND updated_at = ?" : ""}`).bind(...binds, id, ...(base ? [base] : []))];
  if (token) head.push(env.DB.prepare("SELECT CASE WHEN (SELECT save_token FROM outfits WHERE id = ?) = ? THEN 1 ELSE json('outfit_conflict') END AS ok").bind(id, token));
  try { await env.DB.batch([...head, ...(await writeStatements(env, id, p))]); }
  catch (e) { if (token && /malformed JSON|outfit_conflict/i.test(String((e as Error)?.message ?? e))) throw conflict(); throw e; }
  await audit(env, actor, "outfit.update", id);
  return getOutfit(env, id);
}

const conflict = () => new HttpError(409, "outfit_conflict", "這套造型已在另一處修改。你的修改仍保留在畫面，可以重新載入或再次保存覆寫。");

export async function serveOutfitThumb(req: Request, env: Env, id: string): Promise<Response> {
  const t = await env.DB.prepare("SELECT data, mime_type, version FROM outfit_thumbs WHERE outfit_id = ?").bind(id).first<{ data: ArrayBuffer; mime_type: string; version: string }>();
  if (!t) throw new HttpError(404, "thumb_not_found", "未有造型縮圖");
  const etag = `"${t.version}"`;
  const headers = { "content-type": t.mime_type, "cache-control": "private, max-age=31536000, immutable", etag, "x-content-type-options": "nosniff" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(t.data), { headers });
}

export async function deleteOutfit(env: Env, actor: Actor, id: string) {
  const { results } = await env.DB.prepare("SELECT r2_key FROM outfit_images WHERE outfit_id = ?").bind(id).all<{ r2_key: string }>();
  // 只用於這套造型的素材（不在素材庫，也沒有其他造型使用）：一併清理
  const own = (await env.DB.prepare("SELECT DISTINCT asset_id FROM outfit_layers WHERE outfit_id = ? AND asset_id IS NOT NULL").bind(id).all<{ asset_id: string }>()).results.map((r) => r.asset_id);
  // 背景圖片素材亦需檢查（以前只檢查圖層，造型刪除後「只用於這套造型」的背景圖會一直留在 R2）
  const bg = normalizeBackground(parseJson((await env.DB.prepare("SELECT background FROM outfits WHERE id = ?").bind(id).first<{ background: string | null }>())?.background ?? null));
  if (bg?.image?.asset_id && !own.includes(bg.image.asset_id)) own.push(bg.image.asset_id);
  const res = await env.DB.prepare("DELETE FROM outfits WHERE id = ?").bind(id).run();
  if (!res.meta.changes) throw new HttpError(404, "outfit_not_found", "找不到這套穿搭");
  if (results.length) await env.IMAGES.delete(results.map((r) => r.r2_key));
  // 素材清理失敗不影響刪除造型：未刪除的檔案留在 r2_purge_queue，之後再重試
  if (own.length) await purgeUnusedAssets(env, own).catch((e) => console.warn("studio_purge", String(e)));
  await audit(env, actor, "outfit.delete", id);
}
