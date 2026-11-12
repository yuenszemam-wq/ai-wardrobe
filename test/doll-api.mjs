// 角色換裝：migration 0008 及 API 測試（本機模擬 D1／R2，不接觸正式服務）
// 執行：node test/doll-api.mjs   （需要 esbuild）
import { FakeD1, makeEnv } from "./harness.mjs";
import { buildWorker, usedCodecStub } from "./doll-build.mjs";

const worker = await buildWorker("doll-api-worker");
const ORIGIN = "https://ai-wardrobe.example.workers.dev";
let passed = 0;
const failures = [];
const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"m"')) return; origLog(...a); };
function check(name, cond, info) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
const hex = async (u8) => Buffer.from(await crypto.subtle.digest("SHA-256", u8)).toString("hex");
const now = () => new Date().toISOString();

// ───── migration 0008：只新增，不影響現有資料 ─────
console.log("migration 0008");
{
  const db = new FakeD1();
  for (const f of ["0001_init", "0002_upload_slots", "0003_import_staging", "0004_ai_workflow", "0005_taxonomy_layout", "0006_price_settings", "0007_d1_thumbnails"]) db.migrate(new URL(`../migrations/${f}.sql`, import.meta.url));
  db.sqlite.exec(`INSERT INTO garments (id,name,category,created_at,updated_at) VALUES ('gar_old','舊衣物','連身裙','t','t');
    INSERT INTO outfits (id,name,created_at,updated_at) VALUES ('out_old','舊穿搭','t','t');
    INSERT INTO outfit_items (outfit_id,garment_id,position,layer_order,x,y,w,h) VALUES ('out_old','gar_old',0,0,10,20,30,40);`);
  const schema = () => JSON.stringify(db.sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'doll_%' AND name NOT LIKE 'idx_doll_%' AND name NOT LIKE 'sqlite_autoindex_doll_%' ORDER BY name").all());
  const data = () => JSON.stringify([db.sqlite.prepare("SELECT * FROM garments").all(), db.sqlite.prepare("SELECT * FROM outfits").all(), db.sqlite.prepare("SELECT * FROM outfit_items").all()]);
  const s0 = schema(), d0 = data();
  db.migrate(new URL("../migrations/0008_doll_dressing.sql", import.meta.url));
  check("現有資料表、索引、觸發器的定義完全不變", schema() === s0);
  check("現有衣物及穿搭資料完全不變", data() === d0);
  const added = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'doll_%' ORDER BY name").all().map((r) => r.name);
  check("只新增三個資料表", added.join(",") === "doll_fit_templates,doll_look_items,doll_looks", added);
  let again = true;
  try { db.migrate(new URL("../migrations/0008_doll_dressing.sql", import.meta.url)); } catch { again = false; }
  check("重複執行不會出錯（IF NOT EXISTS）", again);
  const sql = (await import("node:fs")).readFileSync(new URL("../migrations/0008_doll_dressing.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
  check("沒有 DROP／ALTER／UPDATE／DELETE／INSERT", !/\b(DROP|ALTER|UPDATE|DELETE|INSERT)\b/i.test(sql.replace(/ON DELETE (CASCADE|SET NULL)/gi, "")));
  db.sqlite.exec("DROP TABLE doll_look_items; DROP TABLE doll_looks; DROP TABLE doll_fit_templates;");
  check("復原（DROP 三個新表）後回到原狀", schema() === s0 && data() === d0);
}

// ───── API ─────
const env = makeEnv();
let cookie = "";
async function call(method, path, body, { auth = true } = {}) {
  const h = new Headers();
  if (auth && cookie) h.set("cookie", cookie);
  if (body !== undefined) h.set("content-type", "application/json");
  if (method !== "GET") h.set("x-requested-with", "ai-wardrobe");
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-DOLL-SETUP-1234")), now()).run();
{
  const res = await worker.fetch(new Request(ORIGIN + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-DOLL-SETUP-1234", username: "tester", password: "test-password-1234" }) }), env);
  cookie = res.headers.get("set-cookie").split(";")[0];
}
async function addGarment(id, name, category, subcategory, { alpha = true } = {}) {
  await env.DB.prepare("INSERT INTO garments (id,name,category,subcategory,status,created_at,updated_at) VALUES (?,?,?,?, 'active', ?, ?)").bind(id, name, category, subcategory, now(), now()).run();
  await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)")
    .bind("img_" + id, id, "processed", `garments/${id}/p.png`, "image/png", 900, 1200, 1000, "sha-" + id, alpha ? 1 : 0, now()).run();
  await env.IMAGES.put(`garments/${id}/p.png`, new Uint8Array([1, 2, 3]));
}
await addGarment("gar_jsk", "測試 JSK", "連身裙", "JSK");
await addGarment("gar_bl", "測試襯衫", "上衣", "Blouse");
await addGarment("gar_op", "測試 OP", "連身裙", "OP");
await env.DB.prepare("INSERT INTO outfits (id,name,created_at,updated_at) VALUES ('out_1','現有穿搭',?,?)").bind(now(), now()).run();
await env.DB.prepare("INSERT INTO outfit_items (outfit_id,garment_id,position,layer_order,x,y,w,h) VALUES ('out_1','gar_jsk',0,0,12,16,76,60)").run();
const snapshot = async () => JSON.stringify([
  (await env.DB.prepare("SELECT * FROM garments ORDER BY id").all()).results,
  (await env.DB.prepare("SELECT * FROM garment_images ORDER BY id").all()).results,
  (await env.DB.prepare("SELECT * FROM outfits ORDER BY id").all()).results,
  (await env.DB.prepare("SELECT * FROM outfit_items").all()).results,
  [...env.IMAGES.objects.keys()].sort(),
]);
const before = await snapshot();

console.log("權限");
check("未登入不能讀模板", (await call("GET", "/api/doll/templates", undefined, { auth: false })).status === 401);
check("未登入不能寫模板", (await call("PUT", "/api/doll/templates/gar_jsk", { fit: { cx: 1, cy: 1, w: 100 } }, { auth: false })).status === 401);
check("未登入不能建立造型", (await call("POST", "/api/doll/looks", { name: "x", items: [] }, { auth: false })).status === 401);

console.log("穿著模板");
let r = await call("GET", "/api/doll/templates");
check("初始沒有模板", r.status === 200 && r.data.templates.length === 0, r);
r = await call("PUT", "/api/doll/templates/gar_jsk", { avatar_id: "base_v1", fit: { cx: 600.123, cy: 905, w: 640, rotation: 2 } });
check("儲存模板", r.status === 200 && r.data.fit.cx === 600.1 && r.data.fit.w === 640 && r.data.fit.rotation === 2 && r.data.version === 1, r);
check("記錄校正時所用的透明圖", r.data.image_id === "img_gar_jsk", r.data);
r = await call("PUT", "/api/doll/templates/gar_jsk", { fit: { cx: 610, cy: 900, w: 650 } });
check("再次儲存＝更新同一個模板（version +1）", r.status === 200 && r.data.version === 2 && r.data.fit.cx === 610 && r.data.fit.rotation === 0, r);
r = await call("GET", "/api/doll/templates?avatar=base_v1");
check("每件衣物每個角色只有一個模板", r.data.templates.length === 1 && r.data.templates[0].garment_id === "gar_jsk", r.data);
check("拒絕不合法的位置", (await call("PUT", "/api/doll/templates/gar_bl", { fit: { cx: "a", cy: 1, w: 100 } })).status === 400);
check("拒絕過大的尺寸", (await call("PUT", "/api/doll/templates/gar_bl", { fit: { cx: 1, cy: 1, w: 999999 } })).status === 400);
check("拒絕不存在的衣物", (await call("PUT", "/api/doll/templates/gar_none", { fit: { cx: 1, cy: 1, w: 100 } })).status === 404);
check("拒絕不存在的角色", (await call("PUT", "/api/doll/templates/gar_bl", { avatar_id: "nope", fit: { cx: 1, cy: 1, w: 100 } })).status === 400);
check("拒絕不合法的圖層位置", (await call("PUT", "/api/doll/templates/gar_bl", { slot: "hat", fit: { cx: 1, cy: 1, w: 100 } })).status === 400);

console.log("造型");
r = await call("POST", "/api/doll/looks", { name: "月夜茶會", items: [{ garment_id: "gar_bl", override: { cx: 590, cy: 700, w: 500, rotation: -3 } }, { garment_id: "gar_jsk", override: null }] });
check("建立造型", r.status === 201 && r.data.id.startsWith("look_") && r.data.items.length === 2, r);
const lookId = r.data.id;
const item = (data, gid) => data.items.find((i) => i.garment_id === gid);
check("圖層位置由分類決定", item(r.data, "gar_bl").slot === "top" && item(r.data, "gar_jsk").slot === "dress", r.data.items);
check("按圖層排序（襯衫在 JSK 之下）", r.data.items[0].garment_id === "gar_bl" && r.data.items[1].garment_id === "gar_jsk");
check("個別修改只存在該造型", JSON.stringify(item(r.data, "gar_bl").override) === JSON.stringify({ cx: 590, cy: 700, w: 500, rotation: -3 }), item(r.data, "gar_bl"));
check("沒有個別修改＝null（跟隨模板）", item(r.data, "gar_jsk").override === null);
check("回傳現有透明圖 id（不複製圖片）", item(r.data, "gar_jsk").image_id === "img_gar_jsk");
r = await call("GET", "/api/doll/templates");
check("造型的個別修改不會寫入模板", r.data.templates.length === 1 && r.data.templates[0].fit.cx === 610, r.data);
await call("PUT", "/api/doll/templates/gar_jsk", { fit: { cx: 620, cy: 910, w: 660 } });
r = await call("GET", `/api/doll/looks/${lookId}`);
check("改模板不會改動造型內的個別修改", item(r.data, "gar_bl").override.cx === 590 && item(r.data, "gar_jsk").override === null, r.data.items);
r = await call("PATCH", `/api/doll/looks/${lookId}`, { name: "月夜茶會 2", items: [{ garment_id: "gar_op", override: null }] });
check("更新造型（換成 OP）", r.status === 200 && r.data.name === "月夜茶會 2" && r.data.items.length === 1 && r.data.items[0].slot === "dress", r);
r = await call("PATCH", `/api/doll/looks/${lookId}`, { name: "只改名" });
check("只改名稱不會清空單品", r.data.items.length === 1 && r.data.name === "只改名", r.data);
r = await call("GET", "/api/doll/looks");
check("造型清單", r.status === 200 && r.data.looks.length === 1 && r.data.looks[0].item_count === 1, r.data);
check("拒絕不存在的衣物", (await call("POST", "/api/doll/looks", { name: "x", items: [{ garment_id: "gar_none" }] })).status === 400);
check("失敗的建立不會留下半個造型", (await call("GET", "/api/doll/looks")).data.looks.length === 1);
check("拒絕不合法的個別修改", (await call("PATCH", `/api/doll/looks/${lookId}`, { items: [{ garment_id: "gar_op", override: { cx: 1 } }] })).status === 400);
check("失敗的更新保留原有單品", (await call("GET", `/api/doll/looks/${lookId}`)).data.items.length === 1);
check("拒絕超過 30 件", (await call("POST", "/api/doll/looks", { items: Array.from({ length: 31 }, () => ({ garment_id: "gar_op" })) })).status === 400);
check("找不到的造型 → 404", (await call("GET", "/api/doll/looks/look_none")).status === 404);

console.log("資料完整性");
check("衣物、圖片、穿搭、R2 物件全部沒有被改動", (await snapshot()) === before);
r = await call("DELETE", `/api/doll/looks/${lookId}`);
check("刪除造型", r.status === 200 && (await call("GET", `/api/doll/looks/${lookId}`)).status === 404);
check("刪除造型不影響模板及衣物", (await call("GET", "/api/doll/templates")).data.templates.length === 1 && (await snapshot()) === before);
r = await call("POST", "/api/doll/looks", { name: "連鎖測試", items: [{ garment_id: "gar_bl" }, { garment_id: "gar_jsk" }] });
const look2 = r.data.id;
await env.DB.prepare("DELETE FROM garments WHERE id = 'gar_jsk'").run();
r = await call("GET", `/api/doll/looks/${look2}`);
check("衣物被刪除時，造型內只移除該單品", r.status === 200 && r.data.items.length === 1 && r.data.items[0].garment_id === "gar_bl", r.data);
check("衣物被刪除時，其模板一併移除", (await call("GET", "/api/doll/templates")).data.templates.length === 0);
r = await call("DELETE", "/api/doll/templates/gar_bl");
check("刪除不存在的模板不會出錯", r.status === 200 && r.data.deleted === 0, r);
r = await call("GET", "/api/outfits");
check("原有穿搭 API 照常運作", r.status === 200 && r.data.outfits.length === 1);

console.log(`\n結果：${passed} 通過，${failures.length} 失敗${usedCodecStub() ? "（此環境未安裝 @jsquash，以替身打包；換裝 API 不使用該模組）" : ""}`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
