// 價錢、衣櫥分析、使用者設定（AI 指令、主頁背景）、同一件衣物合併測試
// 執行：node test/v4.mjs   （需要 esbuild 及 sharp，只供開發環境）
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { makeEnv } from "./harness.mjs";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");

mkdirSync(new URL("./.tmp/", import.meta.url), { recursive: true });
const outfile = new URL("./.tmp/worker-v4.mjs", import.meta.url).pathname;
await build({ entryPoints: [new URL("../worker/index.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile, logLevel: "error" });
const worker = (await import(outfile + "?t=" + Date.now())).default;

const env = makeEnv();
// 模擬升級前的舊資料（migration 0005 前寫入，套用映射）
const ORIGIN = "https://ai-wardrobe.example.workers.dev";
let passed = 0;
const failures = [];
const origLog = console.log;
console.log = (...a) => {
  if (typeof a[0] === "string" && a[0].startsWith('{"m"')) return;
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
async function call(method, path, { body, form } = {}) {
  const h = new Headers();
  if (cookie) h.set("cookie", cookie);
  let payload;
  if (body !== undefined) {
    h.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  if (form) payload = form;
  if (cookie && method !== "GET") h.set("x-requested-with", "ai-wardrobe");
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: payload }), env);
  const sc = res.headers.get("set-cookie");
  if (sc && sc.startsWith("aw_session=") && !sc.includes("Max-Age=0")) cookie = sc.split(";")[0];
  return res;
}
const j = async (res) => {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
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
  const r = (await j(res)).result;
  return { isError: !!r?.isError, data: r?.structuredContent, text: r?.content?.find((c) => c.type === "text")?.text };
}


const png = (w, h, color, alpha = false) =>
  sharp({ create: { width: w, height: h, channels: alpha ? 4 : 3, background: alpha ? { ...color, alpha: 0 } : color } })
    .composite([{ input: { create: { width: Math.round(w / 2), height: Math.round(h / 2), channels: 4, background: { r: 200, g: 40, b: 90, alpha: 1 } } }, left: 10, top: 10 }])
    .png()
    .toBuffer()
    .then((b) => new Uint8Array(b));
const jpg = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer().then((b) => new Uint8Array(b));
function intakeForm(file, name, sha, type) {
  const f = new FormData();
  f.set("sha256", sha);
  f.set("file", new File([file], name, { type }));
  return f;
}
async function raw(method, path, bytes, type) {
  const h = new Headers({ cookie, "content-type": type, "x-requested-with": "ai-wardrobe" });
  return worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: bytes }), env);
}

console.log("\n① 登入");
const setupCode = "TEST-SETUP-CODE-1234";
await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('setup_code_hash', ?, ?)").bind(await hex(new TextEncoder().encode(setupCode)), new Date().toISOString()).run();
let r = await call("POST", "/api/auth/setup", { body: { code: setupCode, username: "sally", password: "password123" } });
check("登入", r.status === 200 && cookie);

console.log("\n② 價錢");
r = await call("POST", "/api/garments", { body: { name: "草莓 OP", category: "連身裙", subcategory: "OP", brand: "Angelic Pretty", style: "Sweet Lolita", primary_color: "黑、紅", season: "春、秋", price: "2,480" } });
let a = await j(r);
check("建立時可填價錢（接受千位分隔）", r.status === 201 && a.price === 2480, a.price);
r = await call("POST", "/api/garments", { body: { name: "格紋 JSK", category: "連身裙", subcategory: "JSK", style: "Classic Lolita", primary_color: "啡", price: 1299.5 } });
const b = await j(r);
r = await call("POST", "/api/garments", { body: { name: "蕾絲襯衫", category: "上衣", style: "Gothic Lolita", primary_color: "白" } });
const c = await j(r);
check("未填價錢為 null", c.price === null, c.price);
r = await call("PATCH", `/api/garments/${c.id}`, { body: { price: 380 } });
let cc = await j(r);
check("修改價錢，不會鎖定 AI 欄位", cc.price === 380 && !cc.locked_fields.includes("price"), cc.locked_fields);
r = await call("PATCH", `/api/garments/${c.id}`, { body: { price: "" } });
check("清空價錢", (await j(r)).price === null);
r = await call("PATCH", `/api/garments/${c.id}`, { body: { price: -5 } });
check("負數被拒絕", r.status === 400);
r = await call("PATCH", `/api/garments/${c.id}`, { body: { price: "abc" } });
check("非數字被拒絕", r.status === 400);
r = await call("GET", "/api/garments?sort=price_desc");
let list = (await j(r)).garments;
check("按價錢排序，未填價錢排最後", list[0].id === a.id && list[1].id === b.id && list[2].id === c.id, list.map((x) => x.price));
r = await call("GET", "/api/garments?priced=0");
check("篩選未填價錢", (await j(r)).garments.map((x) => x.id).join() === c.id);
r = await call("GET", "/api/stats");
let s = await j(r);
check("主頁統計：衣櫃總價及已填件數", s.total_value === 3779.5 && s.priced_count === 2 && s.total === 3, s);

console.log("\n③ 衣櫥分析");
await call("PATCH", `/api/garments/${c.id}`, { body: { status: "archived" } });
r = await call("POST", "/api/outfits", { body: { name: "茶會", items: [{ garment_id: a.id, position: 0, layer_order: 0 }] } });
check("建立穿搭", r.status === 201);
r = await call("GET", "/api/analysis");
let an = await j(r);
check("總數／總價不含已封存", an.total === 2 && an.total_value === 3779.5 && an.avg_price === 1889.75 && an.unpriced_count === 0, an);
check("分類分佈含數量及價值", an.by_category[0].name === "連身裙" && an.by_category[0].n === 2 && an.by_category[0].value === 3779.5, an.by_category);
check("顏色分佈（多選各計一次）", ["黑", "紅", "啡"].every((k) => an.by_color.find((x) => x.name === k)?.n === 1), an.by_color);
check("風格、品牌、季節分佈", an.by_style.length === 2 && an.by_brand.find((x) => x.name === "未有品牌")?.n === 1 && an.by_season.find((x) => x.name === "春")?.n === 1, [an.by_style, an.by_brand, an.by_season]);
check("價錢分佈", an.price_bands.find((x) => x.label === "$1,000–1,999").n === 1 && an.price_bands.find((x) => x.label === "$2,000–2,999").n === 1, an.price_bands);
check("最貴單品", an.top_priced[0].id === a.id && an.top_priced.length === 2);
check("穿搭使用率", an.in_outfits === 1 && an.never_in_outfit === 1 && an.most_worn[0].id === a.id && an.most_worn[0].outfits === 1, an.most_worn);
await call("PATCH", `/api/garments/${c.id}`, { body: { status: "active" } });

console.log("\n④ 使用者設定：AI 指令");
r = await call("GET", "/api/settings");
let st = await j(r);
check("預設指令", r.status === 200 && st.ai_command_is_default && st.ai_command.includes("list_pending_garments") && st.ai_command.includes("same_garment_as") && st.home_bg === null, st);
r = await call("PUT", "/api/settings", { body: { ai_command: "  我自己的指令：請整理衣櫃  " } });
st = await j(r);
check("自訂指令", st.ai_command === "我自己的指令：請整理衣櫃" && !st.ai_command_is_default, st);
r = await call("PUT", "/api/settings", { body: { ai_command: "" } });
st = await j(r);
check("清空即還原預設", st.ai_command_is_default && st.ai_command === st.default_ai_command);

console.log("\n⑤ 主頁背景圖");
const bg1 = await jpg(1200, 900, { r: 60, g: 20, b: 60 });
r = await raw("POST", "/api/settings/home-bg?ratio=90&zoom=1.5&x=30&y=70", bg1, "image/jpeg");
let bg = (await j(r)).home_bg;
check("上傳背景圖並記錄版面", r.status === 201 && bg.width === 1200 && bg.height === 900 && bg.ratio === 90 && bg.zoom === 1.5 && bg.x === 30 && bg.y === 70, bg);
r = await call("GET", bg.url);
check("讀取背景圖", r.status === 200 && r.headers.get("content-type") === "image/jpeg" && (await r.arrayBuffer()).byteLength === bg1.byteLength);
r = await call("PUT", "/api/settings", { body: { home_bg: { zoom: 9, ratio: 10, x: 55, y: -3 } } });
bg = (await j(r)).home_bg;
check("調整版面（數值限制在範圍內）", bg.zoom === 4 && bg.ratio === 40 && bg.x === 55 && bg.y === 0, bg);
const bg2 = await jpg(800, 800, { r: 10, g: 10, b: 30 });
r = await raw("POST", "/api/settings/home-bg", bg2, "image/jpeg");
check("更換背景圖後舊檔從 R2 刪除", r.status === 201 && [...env.IMAGES.objects.keys()].filter((k) => k.startsWith("settings/")).length === 1);
for (const o of env.IMAGES.objects.values()) o.uploaded = new Date(Date.now() - 2 * 3600_000);
r = await call("POST", "/api/maintenance/orphans", { body: { delete: true } });
const orph = await j(r);
check("清理孤兒檔案不會刪除背景圖", orph.deleted === 0 && [...env.IMAGES.objects.keys()].some((k) => k.startsWith("settings/")), orph);
r = await raw("POST", "/api/settings/home-bg", new TextEncoder().encode("not an image at all........"), "image/jpeg");
check("不是圖片會被拒絕", r.status >= 400 && r.status < 500);
const saved = cookie;
cookie = "";
r = await call("GET", "/api/settings/home-bg");
check("未登入不能讀取背景圖", r.status === 401);
cookie = saved;
r = await call("DELETE", "/api/settings/home-bg");
check("移除背景圖", (await j(r)).home_bg === null && ![...env.IMAGES.objects.keys()].some((k) => k.startsWith("settings/")));

console.log("\n⑥ 同一件衣服：透明圖與原相合併");
const cut = await png(600, 800, { r: 0, g: 0, b: 0 }, true);
const photo = await jpg(900, 1200, { r: 230, g: 220, b: 210 });
r = await call("POST", "/api/intake", { form: intakeForm(cut, "dress.png", await hex(cut), "image/png") });
const g1 = await j(r);
r = await call("POST", "/api/intake", { form: intakeForm(photo, "IMG_0001.jpg", await hex(photo), "image/jpeg") });
const g2 = await j(r);
check("同時上傳透明圖和原相：各自成為待整理衣物", g1.image.image_type === "processed" && g2.image.image_type === "original" && g1.garment_id !== g2.garment_id, [g1.image, g2.image]);

r = await call("POST", "/api/tokens", { body: { name: "Claude" } });
const token = (await j(r)).token;
let q = await tool(token, "list_pending_garments", {});
const item = (id) => q.data.items.find((x) => x.garment_id === id);
check("AI 清單標示哪一件有透明圖", item(g1.garment_id).has_processed_image === true && item(g2.garment_id).has_processed_image === false, q.data?.items?.map((x) => x.has_processed_image));
let sub = await tool(token, "submit_ai_suggestion", {
  garment_id: g2.garment_id, base_version: item(g2.garment_id).version, idempotency_key: "g2-1", image_id: g2.image.id, vision_checked: true,
  name: "黑色蝴蝶結 OP", category: "連身裙", same_garment_as: g1.garment_id,
});
check("AI 提交「與另一件是同一件衣服」", !sub.isError && sub.data?.normalized?.same_garment_as === g1.garment_id, sub.data ?? sub.text);
sub = await tool(token, "submit_ai_suggestion", {
  garment_id: g1.garment_id, base_version: item(g1.garment_id).version, idempotency_key: "g1-1", image_id: g1.image.id, vision_checked: true,
  name: "黑色蝴蝶結 OP", category: "連身裙", subcategory: "OP", same_garment_as: "gar_doesnotexist",
});
check("不存在的對象會被忽略並警告", !sub.isError && sub.data?.normalized?.same_garment_as === null && JSON.stringify(sub.data).includes("same_garment_as"), sub.data ?? sub.text);
r = await call("GET", "/api/ai/review?ai_status=pending_review");
let rev = await j(r);
const rv = rev.items.find((x) => x.id === g2.garment_id);
check("App 確認清單顯示建議合併的對象", rv?.merge_target?.id === g1.garment_id && rv.merge_target.has_processed === true, rv?.merge_target);
r = await call("GET", `/api/garments/${g2.garment_id}`);
check("AI 建議不會自動合併", r.status === 200);

await call("PATCH", `/api/garments/${g2.garment_id}`, { body: { price: 1680, notes: "二手購入" } });
await call("POST", "/api/outfits", { body: { name: "含原相那件", items: [{ garment_id: g2.garment_id, position: 0, layer_order: 0 }] } });
const keysBefore = [...env.IMAGES.objects.keys()].length;
r = await call("POST", `/api/garments/${g1.garment_id}/merge`, { body: { source_id: g2.garment_id } });
let m = await j(r);
const types = m.images?.filter((i) => i.image_type !== "thumbnail").map((i) => `${i.image_type}:${i.is_primary}`).sort().join();
check("合併後同一件衣物有透明圖（主圖）及原相", r.status === 200 && types === "original:false,processed:true", types ?? m);
check("未填的價錢／備註由另一件補上", m.price === 1680 && m.notes === "二手購入", [m.price, m.notes]);
check("R2 檔案沒有被刪除或搬動", [...env.IMAGES.objects.keys()].length === keysBefore);
r = await call("GET", `/api/garments/${g2.garment_id}`);
check("被合併的那件已移除", r.status === 404);
check("穿搭改為指向合併後的衣物", m.outfits?.some((o) => o.name === "含原相那件"), m.outfits);
r = await call("GET", "/api/ai/review?ai_status=pending_review");
rev = await j(r);
check("合併後待確認清單只餘一件", rev.items.filter((x) => [g1.garment_id, g2.garment_id].includes(x.id)).length === 1 && !rev.items.find((x) => x.id === g1.garment_id).merge_target);
r = await call("POST", `/api/garments/${g1.garment_id}/merge`, { body: { source_id: g1.garment_id } });
check("不能與自己合併", r.status === 400);
r = await call("POST", `/api/garments/${g1.garment_id}/merge`, { body: { source_id: "gar_nope" } });
check("對象不存在回 404", r.status === 404);

// 兩件各有同一張相：保留一張
const same = await jpg(700, 700, { r: 100, g: 150, b: 200 });
r = await call("POST", "/api/garments", { body: { name: "甲" } });
const x1 = await j(r);
r = await call("POST", "/api/garments", { body: { name: "乙" } });
const x2 = await j(r);
for (const id of [x1.id, x2.id]) {
  const f = new FormData();
  f.set("garment_id", id);
  f.set("image_type", "original");
  f.set("file", new File([same], "same.jpg", { type: "image/jpeg" }));
  r = await call("POST", "/api/images/upload", { form: f });
}
r = await call("POST", `/api/garments/${x1.id}/merge`, { body: { source_id: x2.id } });
m = await j(r);
check("兩件有同一張相時只保留一張，仍有主圖", r.status === 200 && m.images.length === 1 && m.images[0].is_primary === true, m.images);
const token2 = await tool(token, "list_garments", {});
check("AI 權杖不能合併衣物（只限 App 登入）", !token2.isError && (await worker.fetch(new Request(`${ORIGIN}/api/garments/${x1.id}/merge`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ source_id: a.id }) }), env)).status >= 400);

console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) {
  console.log("失敗項目：", failures);
  process.exit(1);
}
