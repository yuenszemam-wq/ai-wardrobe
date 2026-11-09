// 端對端測試：在本機模擬 D1／R2 上執行真正的 Worker 程式碼。
// 執行：node test/e2e.mjs   （需要 esbuild 及 sharp，只供開發環境）
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { makeEnv } from "./harness.mjs";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");

mkdirSync(new URL("./.tmp/", import.meta.url), { recursive: true });
const outfile = new URL("./.tmp/worker.mjs", import.meta.url).pathname;
await build({ entryPoints: [new URL("../worker/index.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile, logLevel: "error" });
const worker = (await import(outfile + "?t=" + Date.now())).default;

const env = makeEnv();
const ORIGIN = "https://ai-wardrobe.example.workers.dev";
let passed = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failures.push(name);
    console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 400) : "");
  }
}

let cookie = "";
async function call(method, path, { body, headers = {}, raw } = {}) {
  const h = new Headers(headers);
  if (cookie && !h.has("authorization") && !h.has("x-no-cookie")) h.set("cookie", cookie);
  h.delete("x-no-cookie");
  let payload = raw;
  if (body !== undefined) {
    h.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  if (cookie && method !== "GET") h.set("x-requested-with", h.get("x-requested-with") ?? "ai-wardrobe");
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
async function mcp(token, method, params) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) }),
    env,
  );
  return { status: res.status, body: await j(res) };
}
async function tool(token, name, args) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  const result = r.body.result;
  return { isError: !!result?.isError, data: result?.structuredContent, text: result?.content?.[0]?.text, raw: r };
}

// 產生 10 張高解像度透明 PNG（模擬 AI 去背後的衣物圖）
const colors = ["#111111", "#f5c2d6", "#7b4fa0", "#ffffff", "#2b0f3a", "#c9184a", "#e0aaff", "#000000", "#ffd6e7", "#5a189a"];
async function garmentPng(i, w = 1600, h = 2000) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="M${w * 0.3} ${h * 0.05} L${w * 0.7} ${h * 0.05} L${w * 0.9} ${h * 0.95} L${w * 0.1} ${h * 0.95} Z" fill="${colors[i]}"/><circle cx="${w / 2}" cy="${h * 0.2}" r="${w * 0.08}" fill="#ffffff"/><text x="50" y="120" font-size="90">${i}</text></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}
const images = [];
for (let i = 0; i < 10; i++) images.push(await garmentPng(i));
const b64 = (u8) => Buffer.from(u8).toString("base64");

console.log("\n① 首次設定及登入");
const setupCode = "TEST-SETUP-CODE-1234";
const codeHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(setupCode))).toString("hex");
await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('setup_code_hash', ?, ?)").bind(codeHash, new Date().toISOString()).run();
let r = await call("GET", "/api/auth/status");
check("未設定時 setup_required=true", (await j(r)).setup_required === true);
r = await call("POST", "/api/auth/setup", { body: { code: "wrong", username: "sally", password: "password123" } });
check("錯誤設定碼被拒絕", r.status === 403);
r = await call("POST", "/api/auth/setup", { body: { code: setupCode, username: "sally", password: "password123" } });
check("首次設定成功並取得 session", r.status === 200 && cookie.startsWith("aw_session="), await j(r));
r = await call("POST", "/api/auth/setup", { body: { code: setupCode, username: "x", password: "password123" } });
check("不可重複設定", r.status === 409);

console.log("\n② 未授權存取");
const savedCookie = cookie;
cookie = "";
r = await call("GET", "/api/garments");
check("未登入讀衣物 → 401", r.status === 401);
r = await call("GET", "/api/images/img_x");
check("未登入讀圖片 → 401", r.status === 401);
cookie = savedCookie;
r = await worker.fetch(new Request(ORIGIN + "/api/garments", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }), env);
check("缺少 CSRF 標頭的修改請求 → 403", r.status === 403);
r = await mcp("aw_invalidtokeninvalidtokeninvalid", "initialize", {});
check("錯誤 MCP 權杖 → 401", r.status === 401);

console.log("\n③ 建立 MCP 權杖");
r = await call("POST", "/api/tokens", { body: { name: "ChatGPT" } });
const tokenRes = await j(r);
const TOKEN = tokenRes.token;
check("產生權杖", r.status === 200 && TOKEN?.startsWith("aw_"), tokenRes);
const tokRow = await env.DB.prepare("SELECT token_hash FROM api_tokens").first();
check("D1 只存權杖雜湊，不存原文", tokRow.token_hash !== TOKEN && tokRow.token_hash.length === 64);

console.log("\n④ MCP 協定");
r = await mcp(TOKEN, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
check("initialize", r.body.result?.serverInfo?.name === "ai-wardrobe" && r.body.result.protocolVersion === "2025-06-18", r.body);
const notif = await worker.fetch(new Request(`${ORIGIN}/mcp/${TOKEN}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), env);
check("notification → 202", notif.status === 202);
r = await mcp(TOKEN, "tools/list", {});
const toolNames = r.body.result.tools.map((t) => t.name);
const required = ["list_garments", "get_garment", "create_import_batch", "upload_garment_image", "add_garments", "update_garment", "finalize_import_batch", "get_import_status", "create_upload_link"];
check("tools/list 包含全部必要工具", required.every((n) => toolNames.includes(n)), toolNames);
check("upload 工具標記 openai/fileParams", r.body.result.tools.find((t) => t.name === "upload_garment_image")._meta?.["openai/fileParams"]?.[0] === "file");

console.log("\n⑤ 批量匯入 10 件（MCP）");
let t = await tool(TOKEN, "create_import_batch", { source: "chatgpt", client_ref: "test-batch-1" });
const batchId = t.data.batch.id;
check("建立批次", !t.isError && batchId);
t = await tool(TOKEN, "create_import_batch", { source: "chatgpt", client_ref: "test-batch-1" });
check("相同 client_ref 續用同一批次（跨對話）", t.data.batch.id === batchId && t.data.resumed === true);

const items = [];
for (let i = 0; i < 9; i++) {
  items.push({
    client_key: `photo-${i + 1}`,
    label: `第${i + 1}張相`,
    garment: {
      name: `測試衣物 ${i + 1}`,
      category: i % 3 === 0 ? "連身裙" : i % 3 === 1 ? "頭飾" : "上衣",
      subcategory: i % 3 === 0 ? "jsk" : i % 3 === 1 ? "KC" : "Blouse",
      style: i === 4 ? "Visual Kei" : "Gothic Lolita",
      primary_color: "黑",
      secondary_colors: ["白", "紫"],
      uncertain_fields: i === 2 ? ["brand"] : undefined,
    },
  });
}
items.push({ client_key: "photo-10", kind: "outfit", label: "第10張相（真人穿搭）", outfit: { name: "黑色哥德整套" } });
t = await tool(TOKEN, "add_garments", { batch_id: batchId, items });
const results = t.data.results;
check("10 項全部建立", results.length === 10 && results.every((x) => x.ok), results);
check("JSK 子類大小寫正規化", (await env.DB.prepare("SELECT subcategory FROM garments WHERE client_key = ?").bind(`${batchId}:photo-1`).first()).subcategory === "JSK");
const g5 = await env.DB.prepare("SELECT style, status, uncertain_fields FROM garments WHERE client_key = ?").bind(`${batchId}:photo-5`).first();
check("未知風格不強行歸類，標記待覆核", g5.style === null && g5.status === "review" && g5.uncertain_fields.includes("style"), g5);
check("真人穿搭照保存為 outfit 而非單品", !!results[9].outfit_id && !results[9].garment_id);

t = await tool(TOKEN, "add_garments", { batch_id: batchId, items });
const gCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n;
const jCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM import_jobs").first()).n;
check("重複提交同一批次不產生重複記錄", t.data.results.every((x) => x.deduplicated) && gCount === 9 && jCount === 10, { gCount, jCount });

// 上傳：1–7 用 base64；8 用 file.download_url (data URL 模擬)；9 故意損壞；10 穿搭照
for (let i = 0; i < 7; i++) {
  t = await tool(TOKEN, "upload_garment_image", { job_id: results[i].job_id, image_type: "processed", image_base64: b64(images[i]) });
  if (t.isError) console.log("    upload error", i, t.text);
}
t = await tool(TOKEN, "upload_garment_image", { garment_id: results[7].garment_id, image_type: "processed", file: { download_url: `data:image/png;base64,${b64(images[7])}`, file_id: "file_8" } });
check("透過 file 參數（ChatGPT 檔案）上傳", !t.isError, t.text);
t = await tool(TOKEN, "upload_garment_image", { job_id: results[8].job_id, image_type: "processed", image_base64: b64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])) });
check("損壞檔案被拒絕", t.isError && /只接受|損壞/.test(t.text), t.text);
const job9 = await env.DB.prepare("SELECT status, error_message FROM import_jobs WHERE id = ?").bind(results[8].job_id).first();
check("單張失敗只影響該項", job9.status === "failed");
const doneSoFar = (await env.DB.prepare("SELECT COUNT(*) AS n FROM import_jobs WHERE batch_id = ? AND status IN ('done','review')").bind(batchId).first()).n;
check("其他 8 項不受影響", doneSoFar === 8, doneSoFar);

// 重試第 9 張
t = await tool(TOKEN, "upload_garment_image", { job_id: results[8].job_id, image_type: "processed", image_base64: b64(images[8]) });
check("失敗項目重新上傳成功", !t.isError, t.text);
const outfitPhoto = new Uint8Array(await sharp({ create: { width: 1200, height: 1800, channels: 3, background: "#332244" } }).jpeg({ quality: 92 }).toBuffer());
t = await tool(TOKEN, "upload_garment_image", { job_id: results[9].job_id, image_type: "original", image_base64: b64(outfitPhoto) });
check("穿搭照上傳至 outfits/ 路徑", !t.isError && t.data.r2_key.startsWith(`outfits/${results[9].outfit_id}/`), t.data ?? t.text);

// 重複上傳同一圖片
const before = env.IMAGES.objects.size;
t = await tool(TOKEN, "upload_garment_image", { job_id: results[0].job_id, image_type: "processed", image_base64: b64(images[0]) });
check("相同圖片重複上傳不會重複儲存", t.data.deduplicated === true && env.IMAGES.objects.size === before);

console.log("\n⑥ R2 與 D1 一致性");
const { results: imgs } = await env.DB.prepare("SELECT * FROM garment_images WHERE image_type = 'processed'").all();
check("9 件衣物各有一張去背圖記錄", imgs.length === 9, imgs.length);
check("每個 D1 r2_key 在 R2 真正存在", imgs.every((x) => env.IMAGES.objects.has(x.r2_key)));
check("R2 key 結構 processed/{garment_id}/{image_id}.png", imgs.every((x) => x.r2_key === `processed/${x.garment_id}/${x.id}.png`), imgs.map((x) => x.r2_key));
check("保留原始解像度 1600×2000（沒有縮成 64×80）", imgs.every((x) => x.width === 1600 && x.height === 2000));
check("透明通道正確偵測", imgs.every((x) => x.has_alpha === 1));
check("SHA-256 與檔案大小已記錄", imgs.every((x) => x.sha256.length === 64 && x.file_size > 1000));
check("R2 實際檔案與原上傳完全相同（無失真）", Buffer.from(env.IMAGES.objects.get(imgs[0].r2_key).bytes).equals(Buffer.from(images[0])));
const d1Json = JSON.stringify((await env.DB.prepare("SELECT * FROM garment_images").all()).results);
check("D1 沒有 Base64 圖片資料", !d1Json.includes(b64(images[0]).slice(0, 40)) && d1Json.length < 20000);

console.log("\n⑦ App 讀取高清圖");
r = await call("GET", `/api/images/${imgs[0].id}`);
const served = new Uint8Array(await r.arrayBuffer());
check("登入後可讀取高清透明圖", r.status === 200 && r.headers.get("content-type") === "image/png" && served.byteLength === images[0].byteLength);
const meta = await sharp(Buffer.from(served)).metadata();
check("讀回的圖片仍為 1600×2000 含透明", meta.width === 1600 && meta.height === 2000 && meta.hasAlpha === true, meta);
check("圖片為私人快取", r.headers.get("cache-control").startsWith("private"));
r = await call("GET", `/api/images/${imgs[0].id}`, { headers: { "if-none-match": `"${imgs[0].sha256}"` } });
check("ETag 304", r.status === 304);
r = await worker.fetch(new Request(`${ORIGIN}/api/images/${imgs[0].id}`, { headers: { authorization: `Bearer ${TOKEN}` } }), env);
check("權杖亦可讀圖（read 權限）", r.status === 200);

console.log("\n⑧ 縮圖與高清圖分開");
const thumb = new Uint8Array(await sharp(Buffer.from(images[0])).resize(480).webp({ quality: 82 }).toBuffer());
const fd = new FormData();
fd.set("file", new Blob([thumb], { type: "image/webp" }), "thumb.webp");
fd.set("garment_id", imgs[0].garment_id);
fd.set("image_type", "thumbnail");
fd.set("derived_from", imgs[0].id);
r = await call("POST", "/api/images/upload", { raw: fd });
const thumbRes = await j(r);
check("multipart 上傳縮圖", r.status === 201 && thumbRes.r2_key.startsWith("thumbnails/"), thumbRes);
check("縮圖不覆蓋主圖", thumbRes.is_primary === false && env.IMAGES.objects.has(imgs[0].r2_key));
r = await call("GET", "/api/garments?limit=50");
const list = await j(r);
const listed = list.garments.find((g) => g.id === imgs[0].garment_id);
check("列表回傳 thumb_image_id 及 primary_image_id", listed.thumb_image_id === thumbRes.id && listed.primary_image_id === imgs[0].id, listed);

console.log("\n⑨ 低解像度、JSON Base64、補償回滾");
const tiny = new Uint8Array(await sharp({ create: { width: 64, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer());
r = await call("PUT", `/api/images/upload?garment_id=${results[1].garment_id}&image_type=original`, { raw: tiny, headers: { "content-type": "image/png" } });
const tinyRes = await j(r);
check("64×80 圖片會被標示警告（不會被當作高清）", r.status === 201 && tinyRes.warnings.length > 0 && tinyRes.width === 64, tinyRes);
check("低解像度原圖不會搶走去背主圖", tinyRes.is_primary === false);
r = await call("POST", "/api/images/upload", { body: { garment_id: results[1].garment_id, data: "AAAA" } });
check("拒絕 Base64 JSON 上傳", r.status === 415);
const r2Before = env.IMAGES.objects.size;
env.DB.failNextBatch = true;
const another = await garmentPng(3, 900, 1000);
r = await call("PUT", `/api/images/upload?garment_id=${results[2].garment_id}&image_type=original`, { raw: another, headers: { "content-type": "image/png" } });
check("D1 失敗 → 500 並回滾 R2", r.status === 500 && env.IMAGES.objects.size === r2Before, { status: r.status, r2: env.IMAGES.objects.size, r2Before });
r = await call("PUT", `/api/images/upload?garment_id=${results[2].garment_id}&image_type=original`, { raw: another, headers: { "content-type": "image/png" } });
check("重試成功", r.status === 201);

console.log("\n⑩ 短效上傳連結（Claude 相容流程）");
const gNew = await call("POST", "/api/garments", { body: { name: "需要上傳的頭飾", category: "頭飾", subcategory: "Headbow" } });
const gNewId = (await j(gNew)).id;
t = await tool(TOKEN, "create_upload_link", { garment_ids: [gNewId], minutes: 30 });
check("產生上傳連結", !t.isError && t.data.url.startsWith(`${ORIGIN}/u/`), t.text);
const linkToken = t.data.url.split("/u/")[1];
r = await worker.fetch(new Request(`${ORIGIN}/api/public/upload/${linkToken}`), env);
const info = await j(r);
check("連結頁面讀取目標", r.status === 200 && info.targets[0].label === "需要上傳的頭飾", info);
r = await worker.fetch(new Request(`${ORIGIN}/api/public/upload/${linkToken}/0`, { method: "PUT", headers: { "content-type": "image/png", "x-requested-with": "ai-wardrobe" }, body: images[5] }), env);
check("透過連結上傳成功", r.status === 201 || r.status === 200, await j(r));
r = await worker.fetch(new Request(`${ORIGIN}/api/public/upload/bogusbogusbogusbogusbogus/0`, { method: "PUT", headers: { "x-requested-with": "ai-wardrobe" }, body: images[5] }), env);
check("無效連結被拒", r.status === 404);
await env.DB.prepare("UPDATE upload_tickets SET expires_at = '2000-01-01T00:00:00Z'").run();
r = await worker.fetch(new Request(`${ORIGIN}/api/public/upload/${linkToken}`), env);
check("過期連結被拒", r.status === 410);

console.log("\n⑪ 完成批次與狀態");
t = await tool(TOKEN, "finalize_import_batch", { batch_id: batchId });
const b = t.data.batch;
check("批次完成並統計", b.status === "finalized" && b.total_images === 10 && b.failed_count === 0 && b.success_count + b.review_count === 10, b);
t = await tool(TOKEN, "get_import_status", { batch_id: batchId });
check("get_import_status 回傳每項狀態", t.data.jobs.length === 10 && t.data.jobs.every((x) => x.preview_image_id), t.data.jobs.map((x) => [x.status, x.preview_image_id]));

console.log("\n⑫ 覆核與修改");
t = await tool(TOKEN, "update_garment", { garment_id: results[4].garment_id, style: "其他", brand: "Moi-meme-Moitie" });
check("MCP 修改衣物，手動填寫後移除該不確定欄位", !t.isError && !t.data.uncertain_fields.includes("style"), t.data?.uncertain_fields);
r = await call("POST", `/api/import/jobs/${results[4].job_id}`, { body: { action: "approve" } });
check("人工確認入庫", r.status === 200 && (await env.DB.prepare("SELECT status FROM garments WHERE id = ?").bind(results[4].garment_id).first()).status === "active");
r = await worker.fetch(new Request(`${ORIGIN}/api/garments/${results[0].garment_id}`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } }), env);
check("權杖不能刪除衣物（最小權限）", r.status === 403);

console.log("\n⑬ 穿搭");
r = await call("POST", "/api/outfits", { body: { name: "週末茶會", items: [{ garment_id: results[0].garment_id }, { garment_id: results[1].garment_id, layer_order: 2 }] } });
const outfit = await j(r);
check("建立穿搭", r.status === 201 && outfit.items.length === 2, outfit);
r = await call("GET", "/api/outfits");
check("列出穿搭", (await j(r)).outfits.length >= 2);

console.log("\n⑭ 統計、刪除、權杖撤銷");
r = await call("GET", "/api/stats");
const st = await j(r);
check("統計數字", st.total === 10 && Array.isArray(st.recent), { total: st.total, review: st.review });
const delKeys = (await env.DB.prepare("SELECT r2_key FROM garment_images WHERE garment_id = ?").bind(results[6].garment_id).all()).results.map((x) => x.r2_key);
r = await call("DELETE", `/api/garments/${results[6].garment_id}`);
check("刪除衣物同時刪除 R2 檔案", r.status === 200 && delKeys.every((k) => !env.IMAGES.objects.has(k)));
r = await call("POST", "/api/maintenance/orphans", { body: {} });
check("孤兒檔案檢查", (await j(r)).orphans === 0);
r = await call("DELETE", `/api/tokens/${tokenRes.id}`);
r = await mcp(TOKEN, "tools/list", {});
check("撤銷後權杖失效", r.status === 401);
r = await call("POST", "/api/auth/logout", { body: {} });
cookie = "";
r = await call("POST", "/api/auth/login", { body: { username: "sally", password: "wrongpass" } });
check("錯誤密碼 → 401", r.status === 401);
r = await call("POST", "/api/auth/login", { body: { username: "sally", password: "password123" } });
check("正確密碼登入", r.status === 200 && cookie);
r = await worker.fetch(new Request(`${ORIGIN}/wardrobe`), env);
check("非 API 路徑交給靜態資源（SPA）", (await r.text()).includes("asset"));

console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) {
  console.log("失敗項目：", failures);
  process.exit(1);
}
