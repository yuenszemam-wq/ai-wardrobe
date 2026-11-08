// D1 暫存匯入測試：模擬 ChatGPT 經 Cloudflare D1 API 寫入 Base64，Worker 排程搬到 R2。
// 執行：node test/staging.mjs   （需要 esbuild 及 sharp）
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { makeEnv } from "./harness.mjs";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");
mkdirSync(new URL("./.tmp/", import.meta.url), { recursive: true });
const outfile = new URL("./.tmp/worker-staging.mjs", import.meta.url).pathname;
await build({ entryPoints: [new URL("../worker/index.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile, logLevel: "error" });
const worker = (await import(outfile + "?t=" + Date.now())).default;

const env = makeEnv();
let passed = 0;
const failures = [];
const check = (name, cond, info) => {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failures.push(name);
    console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 500) : "");
  }
};
const quiet = console.log;
const sha = async (u8) => Buffer.from(await crypto.subtle.digest("SHA-256", u8)).toString("hex");
const b64 = (u8) => Buffer.from(u8).toString("base64");

/** 執行一次排程（等同 Cloudflare cron） */
async function tick() {
  const waits = [];
  console.log = () => {};
  await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now() }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  console.log = quiet;
}
/** 模擬 ChatGPT：INSERT OR REPLACE（失敗後可重寫） */
async function stage(ref, key, data, { part = 1, parts = 1, hash, w, h, name, garment, type = "processed" } = {}) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO import_staging (client_ref, client_key, part_no, part_count, data, sha256, file_name, image_type, expected_width, expected_height, garment_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(ref, key, part, parts, data, hash ?? null, name ?? null, type, w ?? null, h ?? null, garment ? JSON.stringify(garment) : null)
    .run();
}
const row = (ref, key) => env.DB.prepare("SELECT status, error_message, garment_id, length(data) AS len FROM import_staging WHERE client_ref = ? AND client_key = ? ORDER BY part_no LIMIT 1").bind(ref, key).first();

const W = 1122;
const H = 1402;
async function cutout(color, fmt = "png", w = W, h = H) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="M${w * 0.3} ${h * 0.05} L${w * 0.7} ${h * 0.05} L${w * 0.92} ${h * 0.95} L${w * 0.08} ${h * 0.95} Z" fill="${color}"/></svg>`;
  const img = sharp(Buffer.from(svg));
  return new Uint8Array(await (fmt === "webp" ? img.webp({ lossless: true }) : img.png()).toBuffer());
}
// 大圖：加入雜訊令檔案變大，需要分段
async function bigCutout() {
  const raw = Buffer.alloc(W * H * 4);
  for (let i = 0; i < raw.length; i += 4) {
    const inside = (i / 4) % W > 100 && (i / 4) % W < W - 100;
    raw[i] = Math.random() * 255;
    raw[i + 1] = Math.random() * 255;
    raw[i + 2] = Math.random() * 255;
    raw[i + 3] = inside ? 255 : 0;
  }
  return new Uint8Array(await sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer());
}

console.log("\n① 單段：1122×1402 透明 PNG");
const a = await cutout("#111111");
await stage("chatgpt-1", "01", b64(a), { hash: await sha(a), w: W, h: H, name: "01_black.png", garment: { name: "黑色 JSK", category: "連身裙", subcategory: "JSK" } });
check("寫入前 R2 空、沒有衣物", env.IMAGES.objects.size === 0 && (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n === 0);
await tick();
let r = await row("chatgpt-1", "01");
check("排程後 status=done，有 garment_id", r.status === "done" && r.garment_id, r);
check("暫存 Base64 已清空", r.len === 0);
const img = await env.DB.prepare("SELECT r2_key, width, height, has_alpha, sha256 FROM garment_images WHERE garment_id = ?").bind(r.garment_id).first();
check("R2 內容與原檔 SHA-256 相同、1122×1402、透明", img && img.sha256 === (await sha(a)) && (await sha(env.IMAGES.objects.get(img.r2_key).bytes)) === (await sha(a)) && img.width === W && img.height === H && img.has_alpha === 1, img);
const g = await env.DB.prepare("SELECT name, category, subcategory, source FROM garments WHERE id = ?").bind(r.garment_id).first();
check("衣物資料來自 garment_json", g.name === "黑色 JSK" && g.category === "連身裙" && g.source === "chatgpt", g);

console.log("\n② 分段：大圖分 3 段");
const big = await bigCutout();
const s = b64(big);
const size = Math.ceil(s.length / 3);
check(`測試大圖 ${(big.byteLength / 1024 / 1024).toFixed(1)} MB、Base64 ${s.length} 字元`, s.length > 1_000_000);
await stage("chatgpt-1", "02", s.slice(0, size), { part: 1, parts: 3, hash: await sha(big), w: W, h: H, name: "02_big.png", garment: { name: "大圖" } });
await stage("chatgpt-1", "02", s.slice(size, size * 2), { part: 2, parts: 3 });
await tick();
r = await row("chatgpt-1", "02");
check("只收到 2/3 段時不處理", r.status === "pending");
await stage("chatgpt-1", "02", s.slice(size * 2), { part: 3, parts: 3 });
await tick();
r = await row("chatgpt-1", "02");
check("收齊 3 段後 done", r.status === "done", r);
const bigImg = await env.DB.prepare("SELECT sha256 FROM garment_images WHERE garment_id = ?").bind(r.garment_id).first();
check("接回後與原檔 SHA-256 相同", bigImg?.sha256 === (await sha(big)));
const left = await env.DB.prepare("SELECT SUM(length(data)) AS n FROM import_staging WHERE client_key = '02'").first();
check("所有分段的 Base64 已清空", left.n === 0);

console.log("\n③ 保護：截斷、雜湊錯誤、縮小、無透明");
const c = await cutout("#7b4fa0", "webp");
await stage("chatgpt-1", "03", b64(c).slice(0, -200), { hash: await sha(c), w: W, h: H, garment: { name: "截斷" } });
await tick();
r = await row("chatgpt-1", "03");
check("Base64 被截斷 → failed（SHA-256 不符或格式錯誤）", r.status === "failed" && /SHA-256|Base64/.test(r.error_message), r);
check("失敗不寫 R2 新檔", (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n === 2);
await stage("chatgpt-1", "03", b64(c), { hash: await sha(c), w: W, h: H, garment: { name: "重寫成功" } });
await tick();
r = await row("chatgpt-1", "03");
check("INSERT OR REPLACE 重寫後成功（WebP）", r.status === "done", r);
await stage("chatgpt-1", "04", b64(a), { hash: "0".repeat(64), garment: { name: "雜湊錯" } });
await tick();
check("提供錯誤 SHA-256 → failed", (await row("chatgpt-1", "04")).status === "failed");
await stage("chatgpt-1", "05", b64(a), { garment: { name: "沒有雜湊" } });
await tick();
check("沒有 SHA-256 → failed", /SHA-256/.test((await row("chatgpt-1", "05")).error_message));
const small = await cutout("#c9184a", "png", 561, 701);
await stage("chatgpt-1", "06", b64(small), { hash: await sha(small), w: W, h: H, garment: { name: "被縮小" } });
await tick();
check("尺寸與 expected 不符 → failed", /預期 1122×1402/.test((await row("chatgpt-1", "06")).error_message));
const jpg = new Uint8Array(await sharp(Buffer.from(a)).flatten({ background: "#fff" }).jpeg().toBuffer());
await stage("chatgpt-1", "07", b64(jpg), { hash: await sha(jpg), garment: { name: "JPEG" } });
await tick();
check("去背圖用 JPEG → failed", (await row("chatgpt-1", "07")).status === "failed");
const failedLeft = await env.DB.prepare("SELECT SUM(length(data)) AS n FROM import_staging WHERE status = 'failed'").first();
check("失敗項目的 Base64 亦已清空", failedLeft.n === 0);

console.log("\n④ 去重、批次、孤兒檔案");
await stage("chatgpt-2", "01", b64(a), { hash: await sha(a), garment: { name: "重複" } });
await tick();
r = await row("chatgpt-2", "01");
check("衣櫃已有同一張圖 → duplicate，不重複建立", r.status === "duplicate" && (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n === 3, r);
const b = await env.DB.prepare("SELECT * FROM import_batches WHERE client_ref = 'chatgpt-1'").first();
// 雜湊錯誤／沒有雜湊的項目在進入上傳流程前已被拒絕，只記錄在 import_staging；
// 尺寸不符、JPEG 會進入上傳槽並計入批次失敗數。
check("批次統計 chatgpt-1：3 成功、2 失敗（另 2 項在暫存階段被拒）", b && b.success_count + b.review_count === 3 && b.failed_count === 2, b);
const rejected = await env.DB.prepare("SELECT COUNT(DISTINCT client_key) AS n FROM import_staging WHERE client_ref = 'chatgpt-1' AND status = 'failed'").first();
check("暫存表記錄 4 項失敗及原因", rejected.n === 4);
check("R2 只有 3 個檔案（沒有孤兒）", env.IMAGES.objects.size === 3, [...env.IMAGES.objects.keys()]);

console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) {
  console.log("失敗項目：", failures);
  process.exit(1);
}
