import { ensureTaxonomy, invalidateTaxonomy } from "./taxonomy";
import { HomeLayout, normalizeHomeLayout } from "../shared/homeLayout";
import { ThemeSettings, normalizeThemeSettings } from "../shared/theme";
import { parseImage } from "./images";
import { Actor, Env, HttpError, audit, json, newId, nowIso, sha256Hex, str } from "./util";

/**
 * 使用者設定（存放在原有的 app_settings）：
 * - ai_command：「交給 AI 填寫」按鈕複製的指令，可在設定頁自行修改。
 * - home_bg：主頁頂部背景圖的版面（縮放、位置、高度）；圖片檔存 R2 的 settings/ 路徑。
 * - home_layout（Phase 3.8）：主頁元件布局，有版本；未設定時回傳 null（前端使用預設布局）。
 * - theme（Phase 3.8）：介面主題（目前主題及自訂主題），有版本；未設定時回傳 null（現有玫瑰桑紫）。
 */

export const DEFAULT_AI_COMMAND =
  "請整理電子衣櫃的待處理衣物：用 AI Wardrobe 的 list_pending_garments 取得清單，逐件用 get_garment_image 實際查看圖片後分析名稱、類別、子類別、風格、顏色、印花、裝飾細節及季節；不清楚就留空並列入 uncertain_fields，不要猜。" +
  "如果清單中有兩件其實是同一件衣服（例如一張是透明去背圖、一張是原相或官方圖），請在其中一件填 same_garment_as（另一件的 garment_id），並以透明圖那件為主。" +
  "品牌只有找到官方或可靠來源才標為 confirmed 並附連結，印花一致但版本未能區分標 likely，只是風格相似標 unconfirmed。每件用 submit_ai_suggestion 提交（附 base_version 及 idempotency_key）。完成後告訴我處理了幾件、哪些是同一件衣服、哪些辨認失敗。";

const BG_KEY_PREFIX = "settings/home-bg-";
const BG_MAX_BYTES = 6 * 1024 * 1024;

export interface HomeBg {
  key: string;
  mime: string;
  sha256: string;
  width: number;
  height: number;
  /** 顯示高度（佔螢幕寬度的百分比，40–140） */
  ratio: number;
  /** 放大倍數（1＝剛好填滿，最大 4） */
  zoom: number;
  /** 焦點位置（0–100，圖片的百分比） */
  x: number;
  y: number;
  updated_at: string;
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
async function putSetting(env: Env, key: string, value: string) {
  await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(key, value, nowIso())
    .run();
}

async function readBg(env: Env): Promise<HomeBg | null> {
  const raw = await getSetting(env, "home_bg");
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as HomeBg;
    return o && typeof o.key === "string" ? o : null;
  } catch {
    return null;
  }
}

const num = (v: unknown, min: number, max: number, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : def;
};

function publicBg(bg: HomeBg | null) {
  if (!bg) return null;
  return { url: `/api/settings/home-bg?v=${bg.sha256.slice(0, 12)}`, width: bg.width, height: bg.height, ratio: bg.ratio, zoom: bg.zoom, x: bg.x, y: bg.y };
}

async function readJson<T>(env: Env, key: string, norm: (v: unknown) => T): Promise<T | null> {
  const raw = await getSetting(env, key);
  if (!raw) return null;
  try { return norm(JSON.parse(raw)); } catch { return null; }
}
export async function getSettings(env: Env) {
  const [cmd, bg, layout, theme] = await Promise.all([getSetting(env, "ai_command"), readBg(env), readJson(env, "home_layout", normalizeHomeLayout), readJson(env, "theme", normalizeThemeSettings)]);
  return { ai_command: cmd || DEFAULT_AI_COMMAND, ai_command_is_default: !cmd, default_ai_command: DEFAULT_AI_COMMAND, home_bg: publicBg(bg), home_layout: layout, theme };
}

export async function updateSettings(env: Env, actor: Actor, body: Record<string, unknown>) {
  if (Object.prototype.hasOwnProperty.call(body, "ai_command")) {
    const text = str(body.ai_command, 4000);
    if (!text || text === DEFAULT_AI_COMMAND) await env.DB.prepare("DELETE FROM app_settings WHERE key = 'ai_command'").run();
    else await putSetting(env, "ai_command", text);
    await audit(env, actor, "settings.ai_command", undefined, { reset: !text });
  }
  // 主頁布局／主題：整份保存（經驗證），null＝還原預設。base_updated_at 防止另一部裝置的較新設定被舊畫面覆蓋。
  for (const [key, norm] of [["home_layout", normalizeHomeLayout], ["theme", normalizeThemeSettings]] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const base = (body as Record<string, unknown>)[key + "_base"];
    const baseRev = (body as Record<string, unknown>)[key + "_rev"];
    const cur = await readJson<HomeLayout | ThemeSettings>(env, key, norm as (v: unknown) => HomeLayout | ThemeSettings);
    // Phase 3.8A.1：主頁布局用編輯開始時凍結的版本號（rev）核對；舊用戶端仍可用 updated_at
    if (typeof baseRev === "number") {
      if (((cur as HomeLayout | null)?.rev ?? 0) !== baseRev) throw new HttpError(409, "settings_conflict", "主頁布局已在另一部裝置更新。你的草稿已保留，可以重新載入或明確選擇覆寫。", { current: cur });
    } else if (typeof base === "string") {
      if (cur?.updated_at && cur.updated_at !== base) throw new HttpError(409, "settings_conflict", "這項設定已在另一部裝置更新，請重新載入後再修改", { current: cur });
    }
    const v = (body as Record<string, unknown>)[key];
    if (v === null) await env.DB.prepare("DELETE FROM app_settings WHERE key = ?").bind(key).run();
    else {
      const rev = key === "home_layout" ? { rev: ((cur as HomeLayout | null)?.rev ?? 0) + 1 } : {};
      const raw = JSON.stringify({ ...norm(v), updated_at: nowIso(), ...rev });
      if (raw.length > 60000) throw new HttpError(413, "settings_too_large", "設定內容太大");
      await putSetting(env, key, raw);
    }
    await audit(env, actor, "settings." + key, undefined, { reset: v === null });
  }
  if (body.home_bg && typeof body.home_bg === "object") {
    const cur = await readBg(env);
    if (!cur) throw new HttpError(404, "no_background", "未有背景圖，請先上傳");
    const b = body.home_bg as Record<string, unknown>;
    const next: HomeBg = { ...cur, ratio: num(b.ratio, 40, 140, cur.ratio), zoom: num(b.zoom, 1, 4, cur.zoom), x: num(b.x, 0, 100, cur.x), y: num(b.y, 0, 100, cur.y), updated_at: nowIso() };
    await putSetting(env, "home_bg", JSON.stringify(next));
  }
  return getSettings(env);
}

/** 上傳主頁背景圖（原始二進位 JPEG／PNG／WebP）；版面參數放在 query：ratio、zoom、x、y */
export async function uploadHomeBg(req: Request, env: Env, actor: Actor, url: URL) {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.byteLength) throw new HttpError(400, "empty_file", "檔案是空的");
  if (bytes.byteLength > BG_MAX_BYTES) throw new HttpError(413, "file_too_large", "背景圖超過 6 MB 上限");
  const info = parseImage(bytes);
  const sha = await sha256Hex(bytes);
  const key = `${BG_KEY_PREFIX}${sha.slice(0, 16)}.${info.ext}`;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: info.mime, cacheControl: "private, max-age=31536000, immutable" }, customMetadata: { sha256: sha, owner: "settings" } });
  const prev = await readBg(env);
  const p = url.searchParams;
  const bg: HomeBg = {
    key, mime: info.mime, sha256: sha, width: info.width, height: info.height,
    ratio: num(p.get("ratio"), 40, 140, 78), zoom: num(p.get("zoom"), 1, 4, 1), x: num(p.get("x"), 0, 100, 50), y: num(p.get("y"), 0, 100, 50),
    updated_at: nowIso(),
  };
  try {
    await putSetting(env, "home_bg", JSON.stringify(bg));
  } catch (e) {
    if (prev?.key !== key) await env.IMAGES.delete(key).catch(() => undefined);
    throw e;
  }
  if (prev && prev.key !== key) await env.IMAGES.delete(prev.key).catch(() => undefined);
  await audit(env, actor, "settings.home_bg", undefined, { size: bytes.byteLength, w: info.width, h: info.height });
  return json({ home_bg: publicBg(bg) }, 201);
}

export async function serveHomeBg(req: Request, env: Env) {
  const bg = await readBg(env);
  if (!bg) throw new HttpError(404, "no_background", "未有背景圖");
  const etag = `"${bg.sha256}"`;
  const headers = { "content-type": bg.mime, "cache-control": "private, max-age=31536000, immutable", etag };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const obj = await env.IMAGES.get(bg.key);
  if (!obj) throw new HttpError(404, "object_missing", "R2 找不到背景圖");
  return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
}

export async function deleteHomeBg(env: Env, actor: Actor) {
  const bg = await readBg(env);
  if (bg) {
    await env.DB.prepare("DELETE FROM app_settings WHERE key = 'home_bg'").run();
    await env.IMAGES.delete(bg.key).catch(() => undefined);
    await audit(env, actor, "settings.home_bg_removed");
  }
  return json({ home_bg: null });
}


export async function getCustomColors(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'custom_color:%'").all<{key:string;value:string}>();
  return Object.fromEntries(results.map(r=>[r.key.slice(13),r.value]));
}
export async function addCustomColor(env: Env, actor: Actor, body: Record<string, unknown>) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const hex = typeof body.hex === 'string' ? body.hex : '';
  if (!name || name.length > 20 || /[、,，|]/.test(name) || !/^#[0-9a-f]{6}$/i.test(hex)) throw new HttpError(400, 'bad_color', '請填寫20字內的顏色名稱及有效色碼');
  const tax = await ensureTaxonomy(env);
  if (tax.attributes.some(a=>['primary_color','secondary_colors'].includes(a.id)&&a.options.some(o=>o.name===name))) throw new HttpError(409,'duplicate_color','這個顏色名稱已存在');
  const now = nowIso();
  const stmts = ['primary_color','secondary_colors'].map(parent=>env.DB.prepare("INSERT INTO taxonomy (id,kind,parent_id,name,sort_order,multi,max_select,show_for,created_at,updated_at) VALUES (?,'option',?,?,?,0,NULL,NULL,?,?)").bind(newId('opt'),parent,name,1000,now,now));
  stmts.push(env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?)").bind('custom_color:'+name,hex.toLowerCase(),now));
  await env.DB.batch(stmts);
  invalidateTaxonomy();
  await audit(env,actor,'settings.add_color',undefined,{name,hex});
  return getCustomColors(env);
}
