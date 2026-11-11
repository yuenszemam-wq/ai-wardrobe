// 批量二進位上傳槽測試：R2 先寫、D1 後寫；解像度／透明度保留；去重、重試、進度、ChatGPT fileParams。
// 執行：node test/upload-slots.mjs   （需要 esbuild 及 sharp，只供開發環境）
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { makeEnv } from "./harness.mjs";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");

mkdirSync(new URL("./.tmp/", import.meta.url), { recursive: true });
const outfile = new URL("./.tmp/worker-slots.mjs", import.meta.url).pathname;
await build({ target: "es2022", loader: { ".wasm": "binary" }, entryPoints: [new URL("../worker/index.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile, logLevel: "error" });
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
    console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 500) : "");
  }
}
const j = async (res) => {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const quiet = console.log;
console.log = (...a) => (typeof a[0] === "string" && a[0].startsWith('{"m"') ? undefined : quiet(...a));

let cookie = "";
async function call(method, path, { body, headers = {}, raw } = {}) {
  const h = new Headers(headers);
  if (cookie && !h.has("authorization")) h.set("cookie", cookie);
  let payload = raw;
  if (body !== undefined) {
    h.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  if (cookie && method !== "GET") h.set("x-requested-with", "ai-wardrobe");
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: payload }), env);
  const sc = res.headers.get("set-cookie");
  if (sc && sc.startsWith("aw_session=") && !sc.includes("Max-Age=0")) cookie = sc.split(";")[0];
  return res;
}
let rpcId = 0;
async function tool(token, name, args) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }) }),
    env,
  );
  const body = await j(res);
  const result = body.result;
  return { isError: !!result?.isError, data: result?.structuredContent, text: result?.content?.[0]?.text };
}
async function listTools(token) {
  const res = await worker.fetch(new Request(`${ORIGIN}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }) }), env);
  return (await j(res)).result.tools;
}
/** 以網址直接 PUT 原始二進位（模擬 curl --upload-file 或上傳頁） */
async function putUrl(url, bytes, type = "image/png", extra = {}) {
  return worker.fetch(new Request(url, { method: "PUT", headers: { "content-type": type, ...extra }, body: bytes }), env);
}
const sha = async (u8) => Buffer.from(await crypto.subtle.digest("SHA-256", u8)).toString("hex");
const count = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).first()).n;

// 1122×1402 透明去背圖（模擬 ChatGPT sandbox 產生的檔案）
const W = 1122;
const H = 1402;
const palette = ["#111111", "#f5c2d6", "#7b4fa0", "#ffffff", "#2b0f3a", "#c9184a", "#e0aaff", "#000000", "#ffd6e7", "#5a189a", "#334455", "#aa2244"];
async function cutout(i, fmt = "png", w = W, h = H) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="M${w * 0.3} ${h * 0.05} L${w * 0.7} ${h * 0.05} L${w * 0.92} ${h * 0.95} L${w * 0.08} ${h * 0.95} Z" fill="${palette[i]}"/><text x="40" y="100" font-size="80">${i}</text></svg>`;
  const img = sharp(Buffer.from(svg));
  return new Uint8Array(await (fmt === "webp" ? img.webp({ lossless: true }) : img.png()).toBuffer());
}
const files = [];
for (let i = 0; i < 10; i++) files.push(await cutout(i, i % 3 === 2 ? "webp" : "png"));
const fname = (i) => `${String(i + 1).padStart(2, "0")}_garment.${i % 3 === 2 ? "webp" : "png"}`;

console.log("\n① 準備：登入及權杖");
const setupCode = "TEST-SETUP-CODE-5678";
const codeHash = await sha(new TextEncoder().encode(setupCode));
await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('setup_code_hash', ?, ?)").bind(codeHash, new Date().toISOString()).run();
await call("POST", "/api/auth/setup", { body: { code: setupCode, username: "sally", password: "password123" } });
const TOKEN = (await j(await call("POST", "/api/tokens", { body: { name: "ChatGPT" } }))).token;
check("取得 MCP 權杖", typeof TOKEN === "string" && TOKEN.startsWith("aw_"));

console.log("\n② MCP 工具及 ChatGPT 檔案參數 schema");
const tools = await listTools(TOKEN);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
check("新增 import_garment_files／create_upload_session／get_upload_session", ["import_garment_files", "create_upload_session", "get_upload_session"].every((n) => byName[n]));
const igf = byName.import_garment_files;
check("import_garment_files 宣告 openai/fileParams=[files]", JSON.stringify(igf?._meta?.["openai/fileParams"]) === '["files"]');
const fItem = igf?.inputSchema?.properties?.files?.items;
check(
  "files 物件含 download_url／file_id／mime_type／file_name，且前兩者必填",
  ["download_url", "file_id", "mime_type", "file_name"].every((k) => fItem?.properties?.[k]) && JSON.stringify(fItem?.required) === '["download_url","file_id"]',
  fItem,
);
const ugi = byName.upload_garment_image?.inputSchema?.properties?.file;
check("舊工具 upload_garment_image 的 file schema 亦符合規格", ugi?.properties?.file_name && JSON.stringify(ugi?.required) === '["download_url","file_id"]', ugi);

console.log("\n③ 建立 10 件的上傳工作階段（此時不建立衣物記錄）");
const items = files.map((_, i) => ({
  client_key: String(i + 1).padStart(2, "0"),
  file_name: fname(i),
  expected_width: W,
  expected_height: H,
  garment: { name: `測試衣物 ${i + 1}`, category: "連身裙", subcategory: "JSK", primary_color: "黑", ...(i === 4 ? { style: "不知道的風格" } : {}) },
}));
let t = await tool(TOKEN, "create_upload_session", { client_ref: "slots-test-1", source: "chatgpt", items });
const S = t.data;
check("建立成功，有 upload_page_url 及到期時間", !t.isError && S.upload_page_url?.startsWith(`${ORIGIN}/u/`) && S.expires_at, t.text);
check("10 個槽，每個都有 put_url", S?.slots?.length === 10 && S.slots.every((s) => s.put_url?.startsWith(`${ORIGIN}/api/upload/`) && s.status === "pending"));
check("建立階段不寫入 garments", (await count("SELECT COUNT(*) AS n FROM garments")) === 0);
const batchId = S.batch_id;
let b = await env.DB.prepare("SELECT * FROM import_batches WHERE id = ?").bind(batchId).first();
check("批次進度：total=10、processed=0", b.total_images === 10 && b.processed_count === 0, b);
t = await tool(TOKEN, "create_upload_session", { items: Array.from({ length: 11 }, (_, i) => ({ client_key: `x${i}` })) });
check("一次超過 10 件 → 拒絕", t.isError && t.text.includes("too_many_items"));
t = await tool(TOKEN, "create_upload_session", { client_ref: "slots-test-1", items });
check("同一 client_ref + client_key 重複提交不會重複建槽", !t.isError && t.data.batch_id === batchId && (await count("SELECT COUNT(*) AS n FROM upload_slots")) === 10);
const slots = t.data.slots; // 用最新連結

console.log("\n④ 拒絕不合規格的上傳（不寫 R2、不寫 D1）");
let r = await putUrl(slots[0].put_url, JSON.stringify({ image_base64: Buffer.from(files[0]).toString("base64") }), "application/json");
check("Base64 JSON → 415", r.status === 415);
const small = await cutout(0, "png", 561, 701);
r = await putUrl(slots[0].put_url, small);
let body = await j(r);
check("被縮小的圖（561×701）→ 422 resolution_mismatch", r.status === 422 && body.error.code === "resolution_mismatch", body);
const jpeg = new Uint8Array(await sharp(Buffer.from(files[0])).flatten({ background: "#ffffff" }).jpeg().toBuffer());
r = await putUrl(slots[0].put_url, jpeg, "image/jpeg");
check("去背圖用 JPEG → 415", r.status === 415);
const opaque = new Uint8Array(await sharp(Buffer.from(files[0])).flatten({ background: "#ffffff" }).png().toBuffer());
r = await putUrl(slots[0].put_url, opaque);
body = await j(r);
check("沒有透明通道的 PNG → 422 no_alpha", r.status === 422 && body.error.code === "no_alpha", body);
check("驗證失敗不寫 R2", env.IMAGES.objects.size === 0);
check("驗證失敗不寫 garments", (await count("SELECT COUNT(*) AS n FROM garments")) === 0);
r = await worker.fetch(new Request(slots[0].put_url, { method: "POST", headers: { "content-type": "image/png" }, body: files[0] }), env);
check("POST 缺少 X-Requested-With → 403", r.status === 403);
r = await putUrl(`${ORIGIN}/api/upload/${"x".repeat(32)}/${slots[0].slot_id}`, files[0]);
check("錯誤權杖 → 404", r.status === 404);
t = await tool(TOKEN, "get_upload_session", { batch_id: batchId });
check("失敗項目顯示錯誤訊息", t.data.slots[0].status === "failed" && /透明/.test(t.data.slots[0].error), t.data.slots[0]);

console.log("\n⑤ R2 先寫、D1 後寫：模擬 D1 失敗");
env.DB.failNextBatch = true;
r = await putUrl(slots[0].put_url, files[0]);
check("D1 失敗 → 500 db_write_failed", r.status === 500 && (await j(r)).error.code === "db_write_failed");
check("R2 物件已回滾刪除", env.IMAGES.objects.size === 0);
check("沒有留下衣物記錄", (await count("SELECT COUNT(*) AS n FROM garments")) === 0);
// 監察 R2 → D1 次序
const order = [];
const origPut = env.IMAGES.put.bind(env.IMAGES);
const origBatch = env.DB.batch.bind(env.DB);
env.IMAGES.put = async (...a) => (order.push("r2"), origPut(...a));
env.DB.batch = async (stmts) => (order.push(`d1:${stmts.length}`), origBatch(stmts));
r = await putUrl(slots[0].put_url, files[0]);
body = await j(r);
env.IMAGES.put = origPut;
env.DB.batch = origBatch;
check("同一網址重試成功（201）", r.status === 201 && body.status === "done", body);
check("寫入次序：R2 先，D1（衣物+圖片+工作+槽，一個 transaction）後", order[0] === "r2" && order[1] === "d1:4", order);

console.log("\n⑥ 批量上傳 10 張，保留解像度及透明背景");
const results = [body];
for (let i = 1; i < 10; i++) {
  r = await putUrl(slots[i].put_url, files[i], i % 3 === 2 ? "image/webp" : "image/png");
  results.push(await j(r));
  if (r.status !== 201) console.log("     ", i, r.status, results[i]);
}
check("10 張全部 done", results.every((x) => x.status === "done"), results.map((x) => x.status ?? x.error));
check("每張都是 1122×1402", results.every((x) => x.width === W && x.height === H));
check("每張都有透明通道", results.every((x) => x.has_alpha === true));
let identical = true;
for (let i = 0; i < 10; i++) {
  const row = await env.DB.prepare("SELECT r2_key, sha256, width, height, mime_type FROM garment_images WHERE garment_id = ? AND image_type = 'processed'").bind(results[i].garment_id).first();
  const obj = env.IMAGES.objects.get(row.r2_key);
  if (!obj || (await sha(obj.bytes)) !== (await sha(files[i])) || row.sha256 !== (await sha(files[i]))) identical = false;
  if (i % 3 === 2 && row.mime_type !== "image/webp") identical = false;
}
check("R2 內容與原檔逐位元相同（SHA-256），WebP 保持 WebP", identical);
check("建立 10 件衣物", (await count("SELECT COUNT(*) AS n FROM garments")) === 10);
const g5 = await env.DB.prepare("SELECT status, uncertain_fields FROM garments WHERE id = ?").bind(results[4].garment_id).first();
check("不確定的風格 → 待覆核", g5.status === "review" && g5.uncertain_fields.includes("style"), g5);
r = await call("GET", `/api/images/${results[1].image_id}`);
const served = new Uint8Array(await r.arrayBuffer());
check("App 讀回的圖片與原檔相同", r.status === 200 && (await sha(served)) === (await sha(files[1])));

console.log("\n⑦ 去重、冪等、並發");
r = await putUrl(slots[3].put_url, files[3]);
body = await j(r);
check("同一槽重傳同一張 → 200 不重複建立", r.status === 200 && body.repeated === true);
r = await putUrl(slots[3].put_url, files[4]);
check("已完成的槽傳另一張 → 409", r.status === 409);
t = await tool(TOKEN, "create_upload_session", { batch_id: batchId, items: [{ client_key: "dup-1", file_name: "dup.png", garment: { name: "重複測試" } }, { client_key: "lock-1", garment: { name: "鎖測試" } }] });
const dupSlot = t.data.slots.find((s) => s.client_key === "dup-1");
r = await putUrl(dupSlot.put_url, files[2], "image/webp");
body = await j(r);
check("衣櫃已有同一張圖 → duplicate，不建立新衣物", r.status === 200 && body.status === "duplicate" && body.garment_id === results[2].garment_id && (await count("SELECT COUNT(*) AS n FROM garments")) === 10, body);
const lockSlot = t.data.slots.find((s) => s.client_key === "lock-1");
await env.DB.prepare("UPDATE upload_slots SET status = 'uploading', lock_until = ? WHERE id = ?").bind(new Date(Date.now() + 60000).toISOString(), lockSlot.slot_id).run();
r = await putUrl(lockSlot.put_url, await cutout(10));
check("同一槽正在上傳 → 409 slot_busy", r.status === 409 && (await j(r)).error.code === "slot_busy");
await env.DB.prepare("UPDATE upload_slots SET lock_until = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), lockSlot.slot_id).run();
r = await putUrl(lockSlot.put_url, await cutout(10));
check("鎖過期後可重試", r.status === 201);

console.log("\n⑧ 進度、縮圖、續期連結");
t = await tool(TOKEN, "get_upload_session", { batch_id: batchId });
check("進度：12 槽、11 done、1 duplicate、complete", t.data.summary.total === 12 && t.data.summary.done === 11 && t.data.summary.duplicate === 1 && t.data.summary.complete, t.data.summary);
const tokenPart = slots[0].put_url.split("/api/upload/")[1].split("/")[0];
r = await call("GET", `/api/upload/${tokenPart}`);
body = await j(r);
check("上傳頁 GET 狀態（不需登入）", r.status === 200 && body.slots.length === 10 && body.slots.every((s) => s.status === "done"));
const thumb = new Uint8Array(await sharp(Buffer.from(files[0])).resize(384).webp().toBuffer());
r = await putUrl(`${slots[0].put_url}/thumbnail`, thumb, "image/webp");
body = await j(r);
check("縮圖另存，不覆蓋原圖", r.status === 201 && body.image_type === "thumbnail" && (await count("SELECT COUNT(*) AS n FROM garment_images WHERE garment_id = ? AND image_type = 'processed'", results[0].garment_id)) === 1);
b = await env.DB.prepare("SELECT * FROM import_batches WHERE id = ?").bind(batchId).first();
check("批次統計：total 12、success 12、failed 0", b.total_images === 12 && b.success_count + b.review_count === 12 && b.failed_count === 0, b);

t = await tool(TOKEN, "create_upload_session", { client_ref: "slots-test-2", items: [{ client_key: "a", file_name: "a.png", expected_width: W, expected_height: H, garment: { name: "A" } }, { client_key: "b", file_name: "b.png", garment: { name: "B" } }] });
const s2 = t.data;
r = await putUrl(s2.slots[0].put_url, files[5]);
check("第二批：第一件完成", r.status === 201 || (await j(r)).status === "duplicate");
await env.DB.prepare("UPDATE upload_tickets SET expires_at = ? WHERE batch_id = ?").bind(new Date(Date.now() - 1000).toISOString(), s2.batch_id).run();
r = await putUrl(s2.slots[1].put_url, await cutout(11));
check("連結過期 → 410", r.status === 410);
t = await tool(TOKEN, "create_upload_session", { batch_id: s2.batch_id });
check("用 batch_id 續期：只為未完成項目產生新連結", !t.isError && t.data.slots.filter((s) => s.put_url).length === 1 && t.data.slots.find((s) => s.put_url).client_key === "b", t.data?.slots);
r = await putUrl(t.data.slots.find((s) => s.put_url).put_url, await cutout(11));
check("新連結上傳成功", r.status === 201);

console.log("\n⑨ ChatGPT openai/fileParams：import_garment_files");
const fakeFiles = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://files.oaiusercontent.test/")) {
    const f = fakeFiles.get(url);
    return f ? new Response(f, { headers: { "content-type": "image/png", "content-length": String(f.byteLength) } }) : new Response("gone", { status: 404 });
  }
  return realFetch(input, init);
};
const chatFiles = [];
for (let i = 0; i < 3; i++) {
  const bytes = await cutout(i, "png", W + 200, H + 300);
  const url = `https://files.oaiusercontent.test/file-${i}?sig=abc`;
  fakeFiles.set(url, bytes);
  chatFiles.push({ download_url: url, file_id: `file-${i}`, mime_type: "image/png", file_name: `chat_${i}.png`, bytes });
}
// files 次序與 items 不同，需按檔名配對
t = await tool(TOKEN, "import_garment_files", {
  client_ref: "chatgpt-files-1",
  items: [
    { client_key: "c0", file_name: "chat_0.png", expected_width: W + 200, expected_height: H + 300, garment: { name: "對話檔 0" } },
    { client_key: "c1", file_name: "chat_1.png", garment: { name: "對話檔 1" } },
    { client_key: "c2", file_name: "chat_2.png", garment: { name: "對話檔 2" } },
  ],
  files: [2, 0, 1].map((i) => ({ download_url: chatFiles[i].download_url, file_id: chatFiles[i].file_id, file_name: chatFiles[i].file_name })),
});
check("3 個對話檔全部匯入", !t.isError && t.data.results.every((x) => x.ok && x.status === "done"), t.text);
let matched = true;
for (const res of t.data?.results ?? []) {
  const i = Number(res.client_key.slice(1));
  const row = await env.DB.prepare("SELECT sha256, width FROM garment_images WHERE garment_id = ? AND image_type='processed'").bind(res.garment_id).first();
  if (row.sha256 !== (await sha(chatFiles[i].bytes)) || row.width !== W + 200) matched = false;
}
check("按檔名正確配對且保留原解像度", matched);
fakeFiles.delete(chatFiles[1].download_url);
const extra = await cutout(9, "png");
fakeFiles.set("https://files.oaiusercontent.test/ok", extra);
t = await tool(TOKEN, "import_garment_files", {
  client_ref: "chatgpt-files-2",
  items: [{ client_key: "gone", garment: { name: "下載失敗" } }, { client_key: "ok", garment: { name: "成功" } }],
  files: [{ download_url: chatFiles[1].download_url, file_id: "x" }, { download_url: "https://files.oaiusercontent.test/ok", file_id: "y" }],
});
check("部分失敗：成功的照入庫，失敗的回報並附補傳連結", !t.isError && t.data.results[0].ok === false && t.data.results[1].status === "duplicate" && t.data.retry_upload_page_url?.includes("/u/"), t.data);
t = await tool(TOKEN, "import_garment_files", { files: [] });
check("沒有檔案 → 清楚錯誤", t.isError && t.text.includes("no_files"));
t = await tool(TOKEN, "import_garment_files", { files: [{ download_url: "http://insecure.test/x.png", file_id: "z" }] });
check("非 https → 失敗", !t.isError && t.data.results[0].ok === false && /https/.test(t.data.results[0].error));
globalThis.fetch = realFetch;

console.log("\n⑩ 完成批次");
t = await tool(TOKEN, "create_upload_session", { client_ref: "never", items: [{ client_key: "n1", garment: { name: "從未上傳" } }] });
const neverBatch = t.data.batch_id;
t = await tool(TOKEN, "finalize_import_batch", { batch_id: neverBatch });
t = await tool(TOKEN, "get_upload_session", { batch_id: neverBatch });
check("完成批次時未上傳的槽標為 failed", t.data.slots[0].status === "failed" && /未收到/.test(t.data.slots[0].error));
t = await tool(TOKEN, "create_upload_session", { batch_id: neverBatch });
check("完成後仍可用 batch_id 重開並重試", !t.isError && t.data.slots[0].put_url && (await env.DB.prepare("SELECT status FROM import_batches WHERE id = ?").bind(neverBatch).first()).status === "open");
r = await call("GET", `/api/import/batches/${batchId}`);
body = await j(r);
check("App 批次詳情包含 slots", r.status === 200 && Array.isArray(body.slots) && body.slots.length === 12);
r = await call("POST", "/api/maintenance/orphans", { body: {} });
check("沒有孤兒 R2 檔案", (await j(r)).orphans === 0);

console.log = quiet;
console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) {
  console.log("失敗項目：", failures);
  process.exit(1);
}
