// AI 待整理流程端對端測試：批量上傳 → 待整理 → AI 讀圖 → 提交建議 → 人工確認
// 執行：node test/ai-intake.mjs   （需要 esbuild 及 sharp，只供開發環境）
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { makeEnv } from "./harness.mjs";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");

mkdirSync(new URL("./.tmp/", import.meta.url), { recursive: true });
const outfile = new URL("./.tmp/worker-ai.mjs", import.meta.url).pathname;
await build({ entryPoints: [new URL("../worker/index.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile, logLevel: "error" });
const worker = (await import(outfile + "?t=" + Date.now())).default;

const env = makeEnv();
const ORIGIN = "https://ai-wardrobe.example.workers.dev";
let passed = 0;
const failures = [];
const origLog = console.log;
console.log = (...a) => {
  if (typeof a[0] === "string" && a[0].startsWith('{"m"')) return; // 不顯示請求日誌
  origLog(...a);
};
function check(name, cond, info) {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failures.push(name);
    console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 500) : "");
  }
}
const hex = async (u8) => Buffer.from(await crypto.subtle.digest("SHA-256", u8)).toString("hex");

let cookie = "";
async function call(method, path, { body, headers = {}, raw, form } = {}) {
  const h = new Headers(headers);
  if (cookie && !h.has("authorization")) h.set("cookie", cookie);
  let payload = raw;
  if (body !== undefined) {
    h.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  if (form) payload = form;
  if (cookie && method !== "GET" && !h.has("authorization")) h.set("x-requested-with", "ai-wardrobe");
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: payload }), env);
  const sc = res.headers.get("set-cookie");
  if (sc && sc.startsWith("aw_session=") && !sc.includes("Max-Age=0")) cookie = sc.split(";")[0];
  return res;
}
async function j(res) {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
let rpcId = 0;
async function tool(token, name, args) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp/${token}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
  );
  const body = await j(res);
  const r = body.result;
  return { isError: !!r?.isError, data: r?.structuredContent, content: r?.content ?? [], text: r?.content?.find((c) => c.type === "text")?.text };
}
async function scheduled() {
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}

// ── 測試圖片 ──
async function photoJpeg(i, w = 3024, h = 4032) {
  // 有雜訊的大相，接近 iPhone 相片
  const noise = Buffer.alloc(64 * 64 * 3);
  for (let k = 0; k < noise.length; k++) noise[k] = (k * 31 + i * 97) % 256;
  const tile = await sharp(noise, { raw: { width: 64, height: 64, channels: 3 } }).resize(w, h, { kernel: "nearest" }).jpeg({ quality: 92 }).toBuffer();
  return new Uint8Array(tile);
}
const smaller = async (u8, max, fmt = "jpeg") => new Uint8Array(await sharp(Buffer.from(u8)).resize(max, max, { fit: "inside" })[fmt]({ quality: 85 }).toBuffer());

/** 模擬 iPhone HEIC：ftyp heic + meta 內的 ispe（4032×3024）；只供伺服器解析尺寸 */
function fakeHeic() {
  const box = (type, payload) => {
    const b = Buffer.alloc(8 + payload.length);
    b.writeUInt32BE(8 + payload.length, 0);
    b.write(type, 4, "ascii");
    payload.copy(b, 8);
    return b;
  };
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("heic"), Buffer.alloc(4), Buffer.from("mif1heic")]));
  const ispe = (w, h) => {
    const p = Buffer.alloc(12);
    p.writeUInt32BE(0, 0);
    p.writeUInt32BE(w, 4);
    p.writeUInt32BE(h, 8);
    return box("ispe", p);
  };
  const meta = box("meta", Buffer.concat([Buffer.alloc(4), box("iprp", box("ipco", Buffer.concat([ispe(512, 512), ispe(4032, 3024)])))]));
  const mdat = box("mdat", Buffer.from(Array.from({ length: 50000 }, (_, k) => (k * 7) % 256)));
  return new Uint8Array(Buffer.concat([ftyp, meta, mdat]));
}

function intakeForm(file, name, { sha, thumb, analysis, preview, type = "image/jpeg" } = {}) {
  const fd = new FormData();
  fd.set("file", new Blob([file], { type }), name);
  if (sha) fd.set("sha256", sha);
  if (preview) fd.set("preview", new Blob([preview], { type: "image/jpeg" }), "preview.jpg");
  if (thumb) fd.set("thumbnail", new Blob([thumb], { type: "image/webp" }), "thumb.webp");
  if (analysis) fd.set("analysis", new Blob([analysis], { type: "image/jpeg" }), "analysis.jpg");
  return fd;
}

// ───────────────────────────────────────────────
console.log("\n① 登入及舊資料");
const setupCode = "TEST-SETUP-CODE-1234";
const codeHash = await hex(new TextEncoder().encode(setupCode));
await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('setup_code_hash', ?, ?)").bind(codeHash, new Date().toISOString()).run();
let r = await call("POST", "/api/auth/setup", { body: { code: setupCode, username: "sally", password: "password123" } });
check("登入", r.status === 200 && cookie);
r = await call("POST", "/api/garments", { body: { name: "已有高清衣物：黑色十字架 JSK", category: "連身裙", subcategory: "JSK", style: "Gothic Lolita" } });
const legacy = await j(r);
const legacyPng = new Uint8Array(await sharp({ create: { width: 1122, height: 1402, channels: 4, background: { r: 10, g: 0, b: 20, alpha: 0.6 } } }).png().toBuffer());
const lfd = new FormData();
lfd.set("garment_id", legacy.id);
lfd.set("image_type", "processed");
lfd.set("file", new Blob([legacyPng], { type: "image/png" }), "legacy.png");
r = await call("POST", "/api/images/upload", { form: lfd });
check("舊衣物及高清去背圖", r.status === 201);
const legacyBefore = await env.DB.prepare("SELECT name, category, subcategory, style, status, ai_status, updated_at FROM garments WHERE id = ?").bind(legacy.id).first();
const legacyKeysBefore = [...env.IMAGES.objects.keys()].sort();

console.log("\n② iPhone 一次上傳 10 張（同時 3 張）");
const photos = [];
for (let i = 0; i < 10; i++) photos.push(await photoJpeg(i));
const results = new Array(10);
let next = 0;
await Promise.all(
  [0, 1, 2].map(async () => {
    while (next < photos.length) {
      const i = next++;
      const p = photos[i];
      const form = intakeForm(p, `IMG_${1000 + i}.JPG`, { sha: await hex(p), thumb: await smaller(p, 480, "webp"), analysis: await smaller(p, 1600) });
      const res = await call("POST", "/api/intake", { form });
      results[i] = { status: res.status, body: await j(res) };
    }
  }),
);
check("10 張全部 201", results.every((x) => x.status === 201), results.map((x) => x.status));
const gids = results.map((x) => x.body.garment_id);
check("10 件衣物，garment_id 不重複", new Set(gids).size === 10);
const names = results.map((x) => x.body.name).sort();
check("名稱為「待整理衣物 001」至「010」，沒有 UUID", names[0] === "待整理衣物 001" && names[9] === "待整理衣物 010" && names.every((n) => /^待整理衣物 \d{3}$/.test(n)), names);
let allIntact = true;
for (let i = 0; i < 10; i++) {
  const img = results[i].body.image;
  const row = await env.DB.prepare("SELECT r2_key, sha256, width, height, file_size, mime_type FROM garment_images WHERE id = ?").bind(img.id).first();
  const obj = env.IMAGES.objects.get(row.r2_key);
  const same = obj && Buffer.compare(Buffer.from(obj.bytes), Buffer.from(photos[i])) === 0;
  if (!(same && row.sha256 === (await hex(photos[i])) && row.width === 3024 && row.height === 4032 && row.file_size === photos[i].byteLength && row.r2_key.startsWith(`originals/${gids[i]}/`))) {
    allIntact = false;
    console.log("    不符", i, row);
  }
}
check("R2 原圖逐位元相同、3024×4032、SHA-256／大小正確、路徑 originals/{garment_id}/", allIntact);
const thumbs = await env.DB.prepare("SELECT COUNT(*) AS n FROM garment_images WHERE image_type = 'thumbnail' AND variant IS NULL AND garment_id IN (" + gids.map(() => "?").join(",") + ")").bind(...gids).first();
const anal = await env.DB.prepare("SELECT COUNT(*) AS n, MAX(width) AS w FROM garment_images WHERE variant = 'analysis'").first();
check("每件有獨立縮圖及 1600px 辨認圖", thumbs.n === 10 && anal.n === 10 && anal.w === 1200, { thumbs, anal });
const d1rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM garments WHERE ai_status = 'pending_ai' AND status = 'review' AND name_is_placeholder = 1").first();
check("D1 建立 10 件待 AI 辨認記錄", d1rows.n === 10);
r = await call("GET", "/api/garments?status=review&limit=50");
const listed = await j(r);
check("待整理衣物在衣櫃列表找得到（有縮圖）", gids.every((id) => listed.garments.some((g) => g.id === id && g.thumb_image_id)), listed.garments.length);

console.log("\n③ 防重複、完整性、並發");
r = await call("POST", "/api/intake", { form: intakeForm(photos[0], "again.jpg", { sha: await hex(photos[0]) }) });
let b = await j(r);
check("同一張相再上傳 → 200 duplicate，同一件衣物", r.status === 200 && b.duplicate && b.garment_id === gids[0], b);
const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n;
r = await call("POST", "/api/intake", { form: intakeForm(await photoJpeg(50), "bad.jpg", { sha: "0".repeat(64) }) });
b = await j(r);
check("SHA-256 不符 → 422，沒有建立衣物", r.status === 422 && b.error.code === "integrity_mismatch" && (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n === before, b);
const twin = await photoJpeg(77);
const [a1, a2] = await Promise.all([1, 2].map(async () => call("POST", "/api/intake", { form: intakeForm(twin, "twin.jpg", { sha: await hex(twin) }) })));
const [b1, b2] = [await j(a1), await j(a2)];
check("同一張相同時送出兩次 → 只有一件衣物", b1.garment_id === b2.garment_id, [b1.garment_id, b2.garment_id]);
r = await call("POST", "/api/intake", { form: intakeForm(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]), "x.txt") });
check("非圖片 → 415，沒有建立衣物", r.status === 415 && (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n === before + 1);

console.log("\n④ 透明 PNG 及 HEIC 原檔");
const cut = new Uint8Array(await sharp({ create: { width: 1500, height: 2000, channels: 4, background: { r: 120, g: 60, b: 160, alpha: 0 } } }).composite([{ input: Buffer.from('<svg width="1500" height="2000"><rect x="300" y="200" width="900" height="1600" fill="#222"/></svg>') }]).png().toBuffer());
r = await call("POST", "/api/intake", { form: intakeForm(cut, "cutout.png", { sha: await hex(cut), type: "image/png" }) });
b = await j(r);
check("已去背透明 PNG → 存為 processed（不需再去背）", r.status === 201 && b.image.image_type === "processed" && b.image.has_alpha, b.image);
const heic = fakeHeic();
const heicPreview = await photoJpeg(9, 4032, 3024);
r = await call("POST", "/api/intake", { form: intakeForm(heic, "IMG_2000.HEIC", { sha: await hex(heic), preview: heicPreview, type: "image/heic", thumb: await smaller(heicPreview, 480, "webp") }) });
b = await j(r);
const heicRow = await env.DB.prepare("SELECT * FROM garment_images WHERE id = ?").bind(b.image?.id ?? "").first();
check("HEIC 原檔原樣保存（image/heic、4032×3024、.heic）", r.status === 201 && heicRow?.mime_type === "image/heic" && heicRow.width === 4032 && heicRow.r2_key.endsWith(".heic") && Buffer.compare(Buffer.from(env.IMAGES.objects.get(heicRow.r2_key).bytes), Buffer.from(heic)) === 0, b);
const prev = await env.DB.prepare("SELECT * FROM garment_images WHERE id = ?").bind(b.preview_id ?? "").first();
check("另存 JPEG 預覽，並設為主圖", prev?.variant === "preview" && prev.mime_type === "image/jpeg" && prev.is_primary === 1 && prev.derived_from === heicRow.id);
const heicGid = b.garment_id;

console.log("\n⑤ 首頁統計");
r = await call("GET", "/api/stats");
let st = await j(r);
check("待整理 13、待確認 0", st.ai_todo === 13 && st.ai_review === 0 && st.total === 14, { ai: st.ai, total: st.total });

console.log("\n⑥ AI 取得待整理清單及圖片");
r = await call("POST", "/api/tokens", { body: { name: "Claude" } });
const TOKEN = (await j(r)).token;
r = await worker.fetch(new Request(`${ORIGIN}/api/ai/queue?limit=30`, { headers: { authorization: `Bearer ${TOKEN}` } }), env);
const q = await j(r);
check("REST 待整理清單：13 件，舊衣物不在內", q.count === 13 && !q.items.some((i) => i.garment_id === legacy.id), q.count);
const item0 = q.items.find((i) => i.garment_id === gids[0]);
check("清單含 version、目前資料、圖片尺寸、短效網址", item0.version === 1 && item0.current.name === null && item0.images.some((i) => i.width === 3024) && item0.analysis_image.url.includes("/api/ai-image/"));
let res = await worker.fetch(new Request(item0.analysis_image.url), env);
const served = new Uint8Array(await res.arrayBuffer());
const analysisRow = await env.DB.prepare("SELECT r2_key FROM garment_images WHERE id = ?").bind(item0.analysis_image.image_id).first();
check("簽名網址不需登入即可取得真實圖片內容", res.status === 200 && Buffer.compare(Buffer.from(served), Buffer.from(env.IMAGES.objects.get(analysisRow.r2_key).bytes)) === 0);
res = await worker.fetch(new Request(item0.analysis_image.url.replace(/sig=.{4}/, "sig=AAAA")), env);
check("改動簽名 → 403", res.status === 403);
res = await worker.fetch(new Request(item0.analysis_image.url.replace(/exp=\d+/, "exp=1700000000")), env);
check("過期網址 → 403", res.status === 403);
const heicItem = q.items.find((i) => i.garment_id === heicGid);
check("HEIC 衣物的 original_image 給 JPEG 預覽（AI 可開啟）", heicItem.original_image.mime_type === "image/jpeg");

let t = await tool(TOKEN, "list_pending_garments", { limit: 5 });
check("MCP list_pending_garments", !t.isError && t.data.count === 5 && t.data.items[0].version >= 1, t.text);
t = await tool(TOKEN, "get_garment_image", { garment_id: gids[0] });
const imgContent = t.content.find((c) => c.type === "image");
check("MCP get_garment_image 回傳真正圖片像素（image content）", imgContent && imgContent.mimeType === "image/jpeg" && Buffer.compare(Buffer.from(imgContent.data, "base64"), Buffer.from(env.IMAGES.objects.get(analysisRow.r2_key).bytes)) === 0);
const meta = await sharp(Buffer.from(imgContent.data, "base64")).metadata();
check("圖片可解碼（1200×1600）", meta.width === 1200 && meta.height === 1600, meta);

console.log("\n⑦ AI 提交建議");
t = await tool(TOKEN, "claim_garments", { garment_ids: [gids[0], gids[1]] });
check("標記 AI 整理中", t.data.claimed.length === 2);
r = await call("GET", "/api/ai/queue?limit=30");
check("整理中的衣物暫時不再出現在清單", !(await j(r)).items.some((i) => i.garment_id === gids[0]));
t = await tool(TOKEN, "submit_ai_suggestion", { garment_id: gids[0], base_version: 1, idempotency_key: "k0", vision_checked: false, name: "x" });
check("未查看圖片（vision_checked=false）→ 拒絕", t.isError && /vision_required/.test(t.text), t.text);
t = await tool(TOKEN, "submit_ai_suggestion", { garment_id: gids[0], base_version: 9, idempotency_key: "k0", vision_checked: true, name: "x" });
check("版本不符 → 拒絕", t.isError && /stale_version/.test(t.text), t.text);
const sugg0 = {
  garment_id: gids[0], base_version: 1, idempotency_key: `${gids[0]}-20261109-1`, image_id: item0.analysis_image.image_id, vision_checked: true,
  name: "黑色十字架印花 JSK", category: "連身裙", subcategory: "jsk", style: "Gothic Lolita", primary_color: "黑", secondary_colors: ["白"],
  pattern: "十字架", details: "蕾絲邊、蝴蝶結", season: "四季", is_full_outfit: false, has_multiple_items: false,
  brand: "Angelic Pretty", brand_confidence: "confirmed", source_urls: [],
};
t = await tool(TOKEN, "submit_ai_suggestion", sugg0);
check("提交成功 → 待人工確認", !t.isError && t.data.status === "valid" && t.data.garment.ai_status === "pending_review", t.text);
check("「已確認」但沒有來源 → 降為高度可能，brand 留空", t.data.normalized.brand === null && t.data.normalized.brand_confidence === "likely" && t.data.normalized.brand_candidate === "Angelic Pretty", t.data.normalized);
check("子類 jsk 正規化為 JSK", t.data.normalized.subcategory === "JSK");
const s0 = t.data.suggestion_id;
t = await tool(TOKEN, "submit_ai_suggestion", sugg0);
check("同一 idempotency_key 重試 → 不重複建立", t.data.idempotent_replay === true && t.data.suggestion_id === s0 && (await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_suggestions WHERE garment_id = ?").bind(gids[0]).first()).n === 1);
t = await tool(TOKEN, "submit_ai_suggestion", { ...sugg0, idempotency_key: "k-bad", category: "裙子", style: "Punk" });
check("無效分類／風格 → 留空並列入不確定", t.data.normalized.category === null && t.data.normalized.style === null && t.data.normalized.uncertain_fields.includes("category"), t.data.normalized);
check("新建議取代舊建議", (await env.DB.prepare("SELECT status FROM ai_suggestions WHERE id = ?").bind(s0).first()).status === "superseded");
t = await tool(TOKEN, "submit_ai_suggestion", { ...sugg0, idempotency_key: `${gids[0]}-20261109-3`, category: "連身裙", style: "Gothic Lolita", source_urls: ["https://lolibrary.org/items/example"] });
check("有來源連結的已確認品牌 → brand 保留", t.data.normalized.brand === "Angelic Pretty" && t.data.normalized.brand_confidence === "confirmed");
const sFinal0 = t.data.suggestion_id;
t = await tool(TOKEN, "submit_ai_suggestion", { garment_id: gids[2], base_version: 1, idempotency_key: "fail-2", vision_checked: false, outcome: "failed", failure_reason: "相片太模糊" });
check("無法辨認 → 辨認失敗狀態", !t.isError && (await env.DB.prepare("SELECT ai_status, ai_error FROM garments WHERE id = ?").bind(gids[2]).first()).ai_status === "failed");

console.log("\n⑧ ChatGPT 經 Cloudflare D1 連接器提交");
const chatgptPayload = { name: "粉紅草莓 OP", category: "連身裙", subcategory: "OP", style: "Sweet Lolita", primary_color: "粉紅", pattern: "草莓", brand: "Angelic Pretty", brand_confidence: "likely", source_urls: ["https://lolibrary.org/x"], ai_note: "印花系列一致但年份未能區分" };
await env.DB.prepare(
  "INSERT INTO ai_suggestions (garment_id, idempotency_key, base_version, source, image_id, vision_checked, payload) VALUES (?, ?, 1, 'chatgpt', ?, 1, ?)",
)
  .bind(gids[3], `${gids[3]}-chatgpt-1`, q.items.find((i) => i.garment_id === gids[3]).analysis_image.image_id, JSON.stringify(chatgptPayload))
  .run();
await env.DB.prepare("INSERT INTO ai_suggestions (garment_id, idempotency_key, base_version, source, vision_checked, payload) VALUES (?, ?, 1, 'chatgpt', 0, ?)")
  .bind(gids[4], `${gids[4]}-chatgpt-1`, JSON.stringify({ name: "只看 metadata" }))
  .run();
await scheduled();
const cg = await env.DB.prepare("SELECT status, normalized, error_message FROM ai_suggestions WHERE idempotency_key = ?").bind(`${gids[3]}-chatgpt-1`).first();
check("每分鐘 cron 驗證 D1 直接提交的建議", cg.status === "valid" && JSON.parse(cg.normalized).subcategory === "OP", cg);
check("高度可能的品牌不寫入 brand", JSON.parse(cg.normalized).brand === null && JSON.parse(cg.normalized).brand_candidate === "Angelic Pretty");
const cg2 = await env.DB.prepare("SELECT status, error_message FROM ai_suggestions WHERE idempotency_key = ?").bind(`${gids[4]}-chatgpt-1`).first();
check("vision_checked=0 的 D1 提交 → invalid", cg2.status === "invalid" && /vision_required/.test(cg2.error_message), cg2);
check("D1 提交後衣物轉為待人工確認", (await env.DB.prepare("SELECT ai_status FROM garments WHERE id = ?").bind(gids[3]).first()).ai_status === "pending_review");

console.log("\n⑨ 短效網址寫入 D1（給 ChatGPT）");
const links = await env.DB.prepare("SELECT * FROM ai_image_links WHERE garment_id = ?").bind(gids[5]).all();
check("cron 為待整理衣物寫入 analysis／original／thumbnail 網址", links.results.length === 3 && links.results.every((l) => l.url.startsWith(ORIGIN + "/api/ai-image/")), links.results.map((l) => l.purpose));
res = await worker.fetch(new Request(links.results.find((l) => l.purpose === "original").url), env);
check("D1 內的網址可取得高清原圖", res.status === 200 && Number(res.headers.get("content-length")) === photos[5].byteLength);
check("待確認衣物的網址已移除", (await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_image_links WHERE garment_id = ?").bind(gids[0]).first()).n === 0);

console.log("\n⑩ 人工修正鎖定，AI 不可覆寫");
r = await call("PATCH", `/api/garments/${gids[1]}`, { body: { name: "我自己改的名", style: "Classic Lolita" } });
b = await j(r);
check("App 修改後欄位鎖定、version +1、名稱不再是暫時名稱", b.locked_fields.includes("name") && b.locked_fields.includes("style") && b.version === 2 && b.name_is_placeholder === false, b);
t = await tool(TOKEN, "submit_ai_suggestion", { garment_id: gids[1], base_version: 1, idempotency_key: "g1-old", vision_checked: true, name: "AI 名" });
check("用舊 version 提交 → 拒絕", t.isError && /stale_version/.test(t.text));
t = await tool(TOKEN, "submit_ai_suggestion", { garment_id: gids[1], base_version: 2, idempotency_key: "g1-new", vision_checked: true, name: "AI 名", style: "Gothic Lolita", category: "連身裙", subcategory: "SK" });
check("用新 version 提交成功", !t.isError && t.data.locked_fields.includes("name"));
t = await tool(TOKEN, "update_garment", { garment_id: gids[1], name: "AI 直接改名", category: "半身裙" });
check("AI 經 update_garment 改鎖定欄位 → 略過", t.data.name === "我自己改的名" && t.data.skipped_locked.includes("name") && t.data.category === "半身裙", t.data);

console.log("\n⑪ App 確認中心");
r = await call("GET", "/api/ai/review");
let rv = await j(r);
check("確認中心列出全部 AI 流程衣物及建議", rv.items.length === 13 && rv.counts.pending_review === 3 && rv.items.find((i) => i.id === gids[0]).suggestion.suggestion_id === sFinal0, rv.counts);
const g1v = (await env.DB.prepare("SELECT version FROM garments WHERE id = ?").bind(gids[1]).first()).version;
r = await call("POST", `/api/ai/garments/${gids[1]}/decide`, { body: { action: "accept_all", version: g1v } });
b = await j(r);
let g1 = await env.DB.prepare("SELECT * FROM garments WHERE id = ?").bind(gids[1]).first();
check("接受全部不覆寫人工鎖定的欄位（name、style）", r.status === 200 && g1.name === "我自己改的名" && g1.style === "Classic Lolita" && g1.subcategory === "SK" && g1.ai_status === "done" && g1.status === "active", { b, g1 });
r = await call("POST", `/api/ai/garments/${gids[3]}/decide`, { body: { action: "accept_all" } });
let g3 = await env.DB.prepare("SELECT * FROM garments WHERE id = ?").bind(gids[3]).first();
check("接受全部：品牌只屬「高度可能」→ 不寫入 brand，記錄於 ai_note", g3.brand === null && g3.name === "粉紅草莓 OP" && /高度可能/.test(g3.ai_note) && g3.name_is_placeholder === 0, g3);
r = await call("POST", `/api/ai/garments/${gids[0]}/decide`, { body: { action: "accept_fields", fields: ["name", "category", "subcategory", "details"], edits: { primary_color: "紫" } } });
let g0 = await env.DB.prepare("SELECT * FROM garments WHERE id = ?").bind(gids[0]).first();
check("只接受部分欄位＋手動修改", g0.name === "黑色十字架印花 JSK" && g0.subcategory === "JSK" && g0.style === null && g0.brand === null && g0.primary_color === "紫" && /裝飾細節/.test(g0.notes) && JSON.parse(g0.locked_fields).includes("primary_color"), g0);
check("建議標記為部分接受", (await env.DB.prepare("SELECT status FROM ai_suggestions WHERE id = ?").bind(sFinal0).first()).status === "partially_accepted");

// 批量接受
for (const i of [6, 7, 8]) {
  await tool(TOKEN, "submit_ai_suggestion", { garment_id: gids[i], base_version: 1, idempotency_key: `bulk-${i}`, vision_checked: true, name: `批量 ${i}`, category: "頭飾", subcategory: "KC" });
}
r = await call("POST", "/api/ai/decide-bulk", { body: { action: "accept_all", items: [6, 7, 8].map((i) => ({ garment_id: gids[i] })) } });
b = await j(r);
check("多選批量接受", b.results.every((x) => x.ok) && (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments WHERE ai_status = 'done' AND subcategory = '髮箍'").first()).n === 3, b);
await tool(TOKEN, "submit_ai_suggestion", { garment_id: gids[9], base_version: 1, idempotency_key: "k9", vision_checked: true, name: "AI 名 9" });
r = await call("POST", `/api/ai/garments/${gids[9]}/decide`, { body: { action: "keep_original" } });
check("保留原資料", (await env.DB.prepare("SELECT name, ai_status FROM garments WHERE id = ?").bind(gids[9]).first()).name === "待整理衣物 010");
r = await call("POST", `/api/ai/garments/${gids[2]}/decide`, { body: { action: "rework" } });
check("標記需要重新處理 → 回到 AI 清單", (await j(await call("GET", "/api/ai/queue?limit=30"))).items.some((i) => i.garment_id === gids[2] && i.ai_status === "needs_rework"));
r = await worker.fetch(new Request(`${ORIGIN}/api/ai/garments/${gids[5]}/decide`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{}" }), env);
check("AI 權杖不能代替使用者確認 → 403", r.status === 403);

console.log("\n⑫ 重新整理後資料仍在、舊衣物不受影響");
r = await call("GET", `/api/garments/${gids[0]}`);
b = await j(r);
check("重新讀取衣物資料正確", b.name === "黑色十字架印花 JSK" && b.images.some((i) => i.width === 3024));
const legacyAfter = await env.DB.prepare("SELECT name, category, subcategory, style, status, ai_status, updated_at FROM garments WHERE id = ?").bind(legacy.id).first();
check("舊衣物資料完全沒變", JSON.stringify(legacyAfter) === JSON.stringify(legacyBefore), { legacyBefore, legacyAfter });
check("舊 R2 圖片全部仍在且未被改動", legacyKeysBefore.every((k) => env.IMAGES.objects.has(k)));
r = await call("GET", "/api/stats");
st = await j(r);
check("首頁統計更新", st.ai_done === 7 && st.ai_review === 0, st.ai);
r = await call("GET", "/api/garments?identified=0&limit=50");
check("衣櫃可篩選「未辨認」", (await j(r)).garments.length === 6);

console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) {
  console.log("失敗項目：\n - " + failures.join("\n - "));
  process.exit(1);
}
