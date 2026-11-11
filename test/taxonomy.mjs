// 分類字典、衣物屬性、批量入庫及穿搭排版測試
// 執行：node test/taxonomy.mjs   （需要 esbuild 及 sharp，只供開發環境）
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { makeEnv } from "./harness.mjs";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");

mkdirSync(new URL("./.tmp/", import.meta.url), { recursive: true });
const outfile = new URL("./.tmp/worker-tax.mjs", import.meta.url).pathname;
await build({ target: "es2022", loader: { ".wasm": "binary" }, entryPoints: [new URL("../worker/index.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "neutral", outfile, logLevel: "error" });
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

console.log("\n① 舊資料映射（migration 0005）");
{
  // 在新的空資料庫重做：先套 0001–0004，寫入舊資料，再套 0005
  const { FakeD1 } = await import("./harness.mjs");
  const db = new FakeD1();
  for (const f of ["0001_init", "0002_upload_slots", "0003_import_staging", "0004_ai_workflow"]) db.migrate(new URL(`../migrations/${f}.sql`, import.meta.url));
  const now = new Date().toISOString();
  const ins = (id, cat, sub, color, sec, season) =>
    db.sqlite.prepare("INSERT INTO garments (id, name, category, subcategory, primary_color, secondary_colors, season, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, id, cat, sub, color, sec, season, now, now);
  ins("g1", "半身裙", "Petticoat", "酒紅", '["米白","黑"]', "四季");
  ins("g2", "頭飾", "KC", "黑", null, "冬");
  ins("g3", "外套", "Cape", "淺藍", null, null);
  ins("g4", "連身裙", "JSK", "黑", null, null);
  db.migrate(new URL("../migrations/0005_taxonomy_layout.sql", import.meta.url));
  const rows = Object.fromEntries(db.sqlite.prepare("SELECT id, category, subcategory, primary_color, secondary_colors, season FROM garments").all().map((r) => [r.id, { ...r }]));
  check("Petticoat → 內搭與裙撐／裙撐；酒紅 → 紅；米白 → 米色；四季 → 春夏秋冬", rows.g1.category === "內搭與裙撐" && rows.g1.subcategory === "裙撐" && rows.g1.primary_color === "紅" && rows.g1.secondary_colors === '["米色","黑"]' && rows.g1.season === "春、夏、秋、冬", rows.g1);
  check("KC → 頭飾／髮箍；Cape → 外套／斗篷／披肩；淺藍 → 藍", rows.g2.subcategory === "髮箍" && rows.g3.category === "外套" && rows.g3.subcategory === "斗篷／披肩" && rows.g3.primary_color === "藍", [rows.g2, rows.g3]);
  check("其他舊資料不變", rows.g4.category === "連身裙" && rows.g4.subcategory === "JSK" && rows.g4.primary_color === "黑", rows.g4);
}

console.log("\n② 登入及預設分類字典");
const setupCode = "TEST-SETUP-CODE-1234";
await env.DB.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('setup_code_hash', ?, ?)").bind(await hex(new TextEncoder().encode(setupCode)), new Date().toISOString()).run();
let r = await call("POST", "/api/auth/setup", { body: { code: setupCode, username: "sally", password: "password123" } });
check("登入", r.status === 200 && cookie);
r = await call("GET", "/api/taxonomy?usage=1");
let tax = await j(r);
check("14 個主分類，次序與文字檔相同", tax.categories.length === 14 && tax.categories[0].name === "連身裙" && tax.categories[5].name === "內搭與裙撐" && tax.categories[13].name === "完整穿搭", tax.categories?.map((c) => c.name));
check("頭飾有 9 個子分類（含髮圈）", tax.categories.find((c) => c.id === "c_head").subs.map((s) => s.name).join() === "髮箍,蝴蝶結,Bonnet,Headdress,髮夾,髮圈,帽子,頭紗,假髮");
const attr = (id) => tax.attributes.find((a) => a.id === id);
check("19 個屬性；主要顏色多選上限 2", tax.attributes.length === 19 && attr("primary_color").multi && attr("primary_color").max_select === 2);
check("裙長只適用於連身裙及半身裙", JSON.stringify(attr("skirt_length").show_for) === '["c_dress","c_skirt"]');
const seededCount = (await env.DB.prepare("SELECT COUNT(*) AS n FROM taxonomy").first()).n;
await call("GET", "/api/taxonomy");
check("重複讀取不會重複寫入預設值", (await env.DB.prepare("SELECT COUNT(*) AS n FROM taxonomy").first()).n === seededCount);

console.log("\n③ 衣物屬性及多選");
r = await call("POST", "/api/garments", {
  body: {
    name: "黑色十字架 JSK", category: "連身裙", subcategory: "JSK", style: ["Gothic Lolita", "Punk Lolita"], primary_color: ["黑", "白", "紅"],
    season: ["秋", "冬"], attributes: { sleeve_length: "無袖", skirt_length: "及膝", material: ["棉", "蕾絲"], pattern_tags: ["十字架"], bogus: "x", style: "忽略" },
  },
});
let g = await j(r);
check("建立：風格多選、主要顏色最多 2 個、季節多選", r.status === 201 && g.style === "Gothic Lolita、Punk Lolita" && g.primary_color === "黑、白" && g.season === "秋、冬", g);
check("屬性只保留字典內的屬性 ID", JSON.stringify(g.attributes) === JSON.stringify({ sleeve_length: "無袖", skirt_length: "及膝", material: ["棉", "蕾絲"], pattern_tags: ["十字架"] }), g.attributes);
const gid = g.id;
r = await call("GET", "/api/garments?style=Punk%20Lolita");
check("篩選：多選風格", (await j(r)).garments.some((x) => x.id === gid));
r = await call("GET", "/api/garments?color=%E7%99%BD");
check("篩選：第二個主要顏色", (await j(r)).garments.some((x) => x.id === gid));
r = await call("GET", `/api/garments?attr=${encodeURIComponent("material:蕾絲")}`);
check("篩選：多選屬性", (await j(r)).garments.some((x) => x.id === gid));
r = await call("GET", `/api/garments?attr=${encodeURIComponent("skirt_length:及膝")}`);
check("篩選：單選屬性", (await j(r)).garments.some((x) => x.id === gid));
r = await call("PATCH", `/api/garments/${gid}`, { body: { attributes: { sleeve_length: "長袖" } } });
g = await j(r);
check("修改屬性（整組取代）並鎖定，AI 之後不會改", g.attributes.sleeve_length === "長袖" && !g.attributes.material && g.locked_fields.includes("attributes"), g);
r = await call("POST", "/api/garments", { body: { name: "只填子分類", subcategory: "Bonnet" } });
check("只填唯一子分類 → 自動補上主分類", (await j(r)).category === "頭飾");
r = await call("POST", "/api/garments", { body: { name: "舊名稱", category: "半身裙", subcategory: "Petticoat" } });
g = await j(r);
check("舊子類名稱（Petticoat）自動映射", g.category === "內搭與裙撐" && g.subcategory === "裙撐", g);

console.log("\n④ 自由增加、改名、刪除、排序");
r = await call("POST", "/api/taxonomy", { body: { kind: "category", name: "和服" } });
const kimono = await j(r);
check("新增主分類", r.status === 201 && kimono.id.startsWith("cat_"));
r = await call("POST", "/api/taxonomy", { body: { kind: "category", name: "和服" } });
check("同名主分類 → 409", r.status === 409);
r = await call("POST", "/api/taxonomy", { body: { kind: "subcategory", parent_id: kimono.id, name: "浴衣" } });
const yukata = await j(r);
check("新增子分類", r.status === 201 && yukata.parent_id === kimono.id);
r = await call("POST", "/api/garments", { body: { name: "金魚浴衣", category: "和服", subcategory: "浴衣" } });
const yg = await j(r);
check("新分類即時可用（不會被當成未知分類）", yg.category === "和服" && yg.subcategory === "浴衣" && yg.status === "active" && !yg.uncertain_fields.length, yg);
r = await call("PATCH", `/api/taxonomy/${kimono.id}`, { body: { name: "和風" } });
let b = await j(r);
check("主分類改名 → 衣物一併更新", b.garments_updated === 1 && (await env.DB.prepare("SELECT category FROM garments WHERE id = ?").bind(yg.id).first()).category === "和風", b);
r = await call("PATCH", `/api/taxonomy/${yukata.id}`, { body: { name: "夏季浴衣" } });
check("子分類改名 → 衣物一併更新", (await env.DB.prepare("SELECT subcategory FROM garments WHERE id = ?").bind(yg.id).first()).subcategory === "夏季浴衣");
const punk = attr("style").options.find((o) => o.name === "Punk Lolita");
r = await call("PATCH", `/api/taxonomy/${punk.id}`, { body: { name: "Punk" } });
check("風格選項改名 → 多選欄位逐項更新", (await env.DB.prepare("SELECT style FROM garments WHERE id = ?").bind(gid).first()).style === "Gothic Lolita、Punk");
const longSleeve = attr("sleeve_length").options.find((o) => o.name === "長袖");
r = await call("PATCH", `/api/taxonomy/${longSleeve.id}`, { body: { name: "長袖（可拆）" } });
check("屬性選項改名 → attributes 一併更新", JSON.parse((await env.DB.prepare("SELECT attributes FROM garments WHERE id = ?").bind(gid).first()).attributes).sleeve_length === "長袖（可拆）");
r = await call("POST", "/api/taxonomy", { body: { kind: "attribute", name: "肩寬", multi: false, show_for: ["c_top", "c_outer"] } });
const shoulder = await j(r);
r = await call("POST", "/api/taxonomy", { body: { kind: "option", parent_id: shoulder.id, name: "窄肩" } });
check("新增屬性及選項", r.status === 201);
r = await call("PATCH", `/api/garments/${gid}`, { body: { attributes: { sleeve_length: "長袖（可拆）", [shoulder.id]: "窄肩" } } });
check("新屬性即時可用", (await j(r)).attributes[shoulder.id] === "窄肩");
// 子分類搬到另一個主分類
r = await call("PATCH", `/api/taxonomy/${yukata.id}`, { body: { parent_id: "c_set" } });
check("子分類搬到另一主分類 → 衣物主分類一併更新", (await env.DB.prepare("SELECT category, subcategory FROM garments WHERE id = ?").bind(yg.id).first()).category === "套裝");
r = await call("POST", "/api/taxonomy/reorder", { body: { ids: ["c_top", "c_dress"] } });
tax = await j(await call("GET", "/api/taxonomy"));
check("排序", tax.categories[0].id === "c_top" && tax.categories[1].id === "c_dress", tax.categories.slice(0, 3).map((c) => c.id));
r = await call("DELETE", `/api/taxonomy/${kimono.id}`);
tax = await j(await call("GET", "/api/taxonomy"));
check("刪除主分類（連同子分類）", r.status === 200 && !tax.categories.some((c) => c.id === kimono.id) && !(await env.DB.prepare("SELECT 1 FROM taxonomy WHERE parent_id = ?").bind(kimono.id).first()));
check("刪除分類不會刪除或改動衣物", (await env.DB.prepare("SELECT name FROM garments WHERE id = ?").bind(yg.id).first()).name === "金魚浴衣");
await env.DB.prepare("DELETE FROM taxonomy").run();
tax = await j(await call("GET", "/api/taxonomy"));
check("使用者刪光分類後不會自動重新寫入預設值", tax.categories.length === 0);
// 還原預設，供後續測試
await env.DB.prepare("DELETE FROM app_settings WHERE key = 'taxonomy_seeded'").run();
tax = await j(await call("GET", "/api/taxonomy"));

console.log("\n⑤ MCP 分類字典");
r = await call("POST", "/api/tokens", { body: { name: "Claude" } });
const TOKEN = (await j(r)).token;
let t = await tool(TOKEN, "list_taxonomy", {});
check("list_taxonomy 回傳主分類、子分類及屬性適用範圍", !t.isError && t.data.categories.length === 14 && t.data.attributes.find((a) => a.id === "skirt_length").only_for_categories.join() === "連身裙,半身裙", t.text);

console.log("\n⑥ 批量入庫");
const photo = async (i) => new Uint8Array(await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: i * 20, g: 10, b: 30 } } }).jpeg().toBuffer());
const ids = [];
for (let i = 0; i < 4; i++) {
  const p = await photo(i);
  const fd = new FormData();
  fd.set("file", new Blob([p], { type: "image/jpeg" }), `IMG_${i}.JPG`);
  fd.set("sha256", await hex(p));
  r = await call("POST", "/api/intake", { form: fd });
  ids.push((await j(r)).garment_id);
}
check("4 件待整理", ids.every(Boolean));
t = await tool(TOKEN, "submit_ai_suggestion", { garment_id: ids[0], base_version: 1, idempotency_key: "bulk-0", vision_checked: true, name: "粉紅 OP", category: "連身裙", subcategory: "OP", style: "Sweet Lolita" });
check("第 1 件有 AI 建議", !t.isError && t.data.status === "valid", t.text);
r = await call("POST", "/api/garments/bulk-intake", { body: { garment_ids: [ids[0], ids[1]] } });
b = await j(r);
let rows = await Promise.all([ids[0], ids[1]].map((id) => env.DB.prepare("SELECT name, category, status, ai_status FROM garments WHERE id = ?").bind(id).first()));
check("有建議的接受 AI 建議；沒有的保留原資料入庫", b.results.every((x) => x.ok) && b.results[0].mode === "ai" && b.results[1].mode === "as_is" && rows[0].name === "粉紅 OP" && rows.every((x) => x.status === "active" && x.ai_status === "done"), { b, rows });
r = await call("POST", "/api/garments/bulk-intake", { body: { garment_ids: [ids[2], ids[3]], set: { category: "鞋", subcategory: "瑪麗珍鞋" } } });
b = await j(r);
rows = await Promise.all([ids[2], ids[3]].map((id) => env.DB.prepare("SELECT category, subcategory, status, ai_status, locked_fields FROM garments WHERE id = ?").bind(id).first()));
check("批量入庫時一併設定分類（並鎖定）", rows.every((x) => x.category === "鞋" && x.subcategory === "瑪麗珍鞋" && x.status === "active" && x.ai_status === "done" && JSON.parse(x.locked_fields).includes("category")), rows);
r = await call("POST", "/api/garments/bulk-intake", { body: { garment_ids: [] } });
check("沒有選取 → 400", r.status === 400);
r = await worker.fetch(new Request(`${ORIGIN}/api/garments/bulk-intake`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ garment_ids: ids }) }), env);
check("AI 權杖不可批量入庫", r.status === 403, r.status);

console.log("\n⑦ 穿搭自由排版");
r = await call("POST", "/api/outfits", { body: { name: "茶會", items: [{ garment_id: gid, position: 0, layer_order: 1, x: 10.5, y: 20, w: 60, h: 70 }, { garment_id: ids[2], position: 1, layer_order: 0 }] } });
let o = await j(r);
const it = o.items.find((i) => i.garment_id === gid);
check("保存位置及大小", r.status === 201 && it.x === 10.5 && it.y === 20 && it.w === 60 && it.h === 70, o.items);
check("沒有位置的單品為 null（App 用預設位置）", o.items.find((i) => i.garment_id === ids[2]).x === null);
check("按圖層排序", o.items[0].garment_id === ids[2]);
r = await call("PATCH", `/api/outfits/${o.id}`, { body: { items: [{ garment_id: gid, layer_order: 0, x: 999, y: -999, w: 0, h: 50 }] } });
o = await j(r);
check("超出範圍的數值會被限制", o.items.length === 1 && o.items[0].x === 150 && o.items[0].y === -50 && o.items[0].w === 2, o.items);

console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) process.exit(1);
