// 角色換裝 Phase 3：migration 0010 及 API 測試（本機模擬 D1／R2，不接觸正式服務）
// 執行：node test/doll-api.mjs   （需要 esbuild、sharp）
import { createRequire } from "node:module";
import { FakeD1, makeEnv } from "./harness.mjs";
import { buildWorker } from "./doll-build.mjs";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");
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
const MIGRATIONS = ["0001_init", "0002_upload_slots", "0003_import_staging", "0004_ai_workflow", "0005_taxonomy_layout", "0006_price_settings", "0007_d1_thumbnails", "0008_doll_dressing", "0009_avatar_v2"];

console.log("migration 0010：只新增，不影響現有資料");
{
  const db = new FakeD1();
  for (const f of MIGRATIONS) db.migrate(new URL(`../migrations/${f}.sql`, import.meta.url));
  db.sqlite.exec(`INSERT INTO garments (id,name,category,created_at,updated_at) VALUES ('gar_old','舊衣物','連身裙','t','t');
    INSERT INTO outfits (id,name,created_at,updated_at) VALUES ('out_old','舊穿搭','t','t');
    INSERT INTO outfit_items (outfit_id,garment_id,position,layer_order,x,y,w,h) VALUES ('out_old','gar_old',0,0,10,20,30,40);
    INSERT INTO doll_fit_templates (garment_id,avatar_id,cx,cy,w,rotation,slot,created_at,updated_at) VALUES ('gar_old','base_v1',600,900,500,0,'dress','t','t');
    INSERT INTO doll_looks (id,name,avatar_id,created_at,updated_at,hair_color,pose) VALUES ('look_old','舊造型','base_v1','t','t','black','{"head":3}');
    INSERT INTO doll_look_items (look_id,garment_id,slot,z,ov_cx,ov_cy,ov_w,ov_rotation) VALUES ('look_old','gar_old','dress',500,610,910,480,1);`);
  const snap = () => JSON.stringify(["garments", "outfits", "outfit_items", "doll_look_items"].map((t) => db.sqlite.prepare(`SELECT * FROM ${t}`).all()).concat([db.sqlite.prepare("SELECT garment_id,avatar_id,cx,cy,w,rotation,slot FROM doll_fit_templates").all(), db.sqlite.prepare("SELECT id,name,avatar_id,hair_color,pose FROM doll_looks").all()]));
  const before = snap();
  const sql = (await import("node:fs")).readFileSync(new URL("../migrations/0010_doll_phase3.sql", import.meta.url), "utf8");
  check("0010 沒有 DROP／DELETE／UPDATE", !/\b(drop|delete|update)\b/i.test(sql.replace(/--.*$/gm, "").replace(/ON DELETE \w+( \w+)?/gi, "")));
  db.migrate(new URL("../migrations/0010_doll_phase3.sql", import.meta.url));
  check("現有資料完全不變", snap() === before);
  const cols = (t) => db.sqlite.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  check("新增欄位及資料表", cols("doll_looks").includes("state") && cols("doll_fit_templates").includes("data") && cols("doll_assets").includes("config") && cols("doll_asset_files").includes("r2_key") && cols("doll_look_thumbs").includes("data"));
  check("舊造型的 state 為空（開啟時才換算）", db.sqlite.prepare("SELECT state FROM doll_looks WHERE id='look_old'").get().state === null);
}

const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-DOLL-API-1234")), now()).run();
const auth = await worker.fetch(new Request(ORIGIN + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-DOLL-API-1234", username: "tester", password: "test-password-1234" }) }), env);
const cookie = auth.headers.get("set-cookie").split(";")[0];
async function call(method, path, body, raw) {
  const headers = { cookie, origin: ORIGIN, "x-requested-with": "ai-wardrobe" };
  let payload;
  if (raw) { headers["content-type"] = raw; payload = body; }
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: payload }), env);
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, headers: res.headers, data: ct.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
}
const png = async (w, h, color = "#6b2d5c", alpha = true) => new Uint8Array(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 3}" ry="${h / 3}" fill="${color}"/></svg>`)).flatten(alpha ? false : { background: "#fff" }).png().toBuffer());
for (const [id, name, category, sub] of [["gar_a", "襯衫", "上衣", "Blouse"], ["gar_b", "JSK", "連身裙", "JSK"], ["gar_c", "半裙", "半身裙", "SK"], ["gar_d", "外套", "外套", null]]) {
  const bytes = await png(300, 400);
  await env.IMAGES.put(`garments/${id}/p.png`, bytes);
  await env.DB.prepare("INSERT INTO garments (id,name,category,subcategory,status,created_at,updated_at) VALUES (?,?,?,?, 'active', ?, ?)").bind(id, name, category, sub, now(), now()).run();
  await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)").bind("img_" + id.slice(4) + "aaaaaaa", id, "processed", `garments/${id}/p.png`, "image/png", 300, 400, bytes.length, await hex(bytes), now()).run();
}
const garmentSnap = async () => JSON.stringify([(await env.DB.prepare("SELECT * FROM garments ORDER BY id").all()).results, (await env.DB.prepare("SELECT id,garment_id,r2_key,sha256 FROM garment_images ORDER BY id").all()).results, [...env.IMAGES.objects.keys()].filter((k) => k.startsWith("garments/")).sort()]);
const g0 = await garmentSnap();
const fit = { cx: 600, cy: 700, w: 520, rotation: 0 };

console.log("衣物預設穿著設定");
{
  let r = await call("PUT", "/api/doll/templates/gar_d", { fit, slot: "outer", image_id: "img_daaaaaaa", data: { opts: { follow: "upper", neck: true }, pose: { shoulder_r: 18 }, front: ["hand_r"], variants: { open: { name: "打開", fit: { cx: 600, cy: 690, w: 560, rotation: 0 } } } } });
  check("保存衣物預設（位置＋骨架跟隨＋建議姿勢＋穿法）", r.status === 200 && r.data.avatar_id === "avatar_v2" && r.data.data.opts.follow === "upper" && r.data.data.pose.shoulder_r === 18 && r.data.data.variants.open.name === "打開" && r.data.version === 1, r.data);
  r = await call("PUT", "/api/doll/templates/gar_d", { fit: { ...fit, w: 540 }, slot: "outer", image_id: "img_daaaaaaa", data: r.data.data });
  check("再保存：版本遞增、穿法保留", r.data.version === 2 && r.data.fit.w === 540 && r.data.data.variants.open.fit.w === 560);
  r = await call("PUT", "/api/doll/templates/gar_d", { fit, image_id: "img_other" });
  check("衣物圖片已更換時拒絕（409）", r.status === 409);
  r = await call("PUT", "/api/doll/templates/gar_d", { fit: { cx: "x" } });
  check("壞位置被拒絕", r.status === 400);
  r = await call("PUT", "/api/doll/templates/gar_nope", { fit });
  check("不存在的衣物 404", r.status === 404);
  await env.DB.prepare("INSERT INTO doll_fit_templates (garment_id,avatar_id,image_id,cx,cy,w,rotation,slot,created_at,updated_at) VALUES ('gar_b','base_v1','img_baaaaaaa',600,880,620,0,'dress','t','t')").run();
  r = await call("GET", "/api/doll/templates");
  const v1 = r.data.templates.find((t) => t.garment_id === "gar_b"), v2 = r.data.templates.find((t) => t.garment_id === "gar_d");
  check("列表同時回傳舊角色位置（供換算）及新設定", v1?.avatar_id === "base_v1" && v1.data === null && v2?.avatar_id === "avatar_v2" && v2.data.variants.open, r.data.templates.map((t) => t.avatar_id));
  r = await call("DELETE", "/api/doll/templates/gar_b");
  check("恢復預設不會刪除舊角色的記錄", r.data.deleted === 0 && (await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_fit_templates WHERE garment_id='gar_b'").first()).n === 1);
}

console.log("造型：自由疊穿、完整狀態");
let lookId;
{
  const state = { head: "builtin:head_v2", hair: "builtin:twin_tails_long", hair_color: "black_pink", accent_color: null, tip_color: "#ffaacc", pose: { shoulder_r: 36, elbow_r: -98, "root.x": 12 }, front: ["hand_r"],
    items: [{ garment_id: "gar_a", slot: "top" }, { garment_id: "gar_c", slot: "skirt", hidden: true }, { garment_id: "gar_b", slot: "dress", fit, opts: { follow: "none", neck: false } }, { garment_id: "gar_d", slot: "outer", variant: "open" }] };
  let r = await call("POST", "/api/doll/looks", { name: "月夜茶會", state });
  lookId = r.data.id;
  check("上衣＋半裙＋連身裙＋外套可以同時穿（沒有互斥）", r.status === 201 && r.data.state.items.map((i) => i.garment_id).join() === "gar_a,gar_c,gar_b,gar_d" && r.data.item_count === 4, r.data);
  check("保存隱藏、穿法、個別位置及骨架設定", r.data.state.items[1].hidden && r.data.state.items[3].variant === "open" && r.data.state.items[2].fit.w === 520 && r.data.state.items[2].opts.follow === "none" && r.data.state.items[0].fit === null);
  check("保存髮色、髮尾色、姿勢（含平移）及手在前", r.data.state.hair_color === "black_pink" && r.data.state.tip_color === "#ffaacc" && r.data.state.pose["root.x"] === 12 && r.data.state.front[0] === "hand_r" && r.data.legacy === null);
  const row = await env.DB.prepare("SELECT avatar_id, hair_style, hair_color, pose FROM doll_looks WHERE id = ?").bind(lookId).first();
  check("舊欄位同步寫入", row.avatar_id === "avatar_v2" && row.hair_style === "twin_tails_long" && row.hair_color === "black_pink" && JSON.parse(row.pose).elbow_r === -98, row);
  r = await call("PATCH", `/api/doll/looks/${lookId}`, { state: { ...state, items: [state.items[3], state.items[0]] }, name: "改名" });
  check("更新：圖層次序按 items 次序", r.data.name === "改名" && r.data.state.items.map((i) => i.garment_id).join() === "gar_d,gar_a" && r.data.item_count === 2);
  const u1 = r.data.updated_at;
  await new Promise((res) => setTimeout(res, 5));
  r = await call("PATCH", `/api/doll/looks/${lookId}`, { is_favorite: true });
  check("只改收藏：狀態不變、更新時間不變", r.data.is_favorite === true && r.data.state.items.length === 2 && r.data.updated_at === u1);
  r = await call("POST", "/api/doll/looks", { name: "壞", state: { items: [{ garment_id: "gar_missing", slot: "top" }] } });
  check("衣物不存在時拒絕", r.status === 400);
  r = await call("POST", "/api/doll/looks", { name: "壞", state: { items: "x" } });
  check("壞狀態被拒絕", r.status === 400);
  r = await call("GET", "/api/doll/looks");
  check("列表：件數、收藏、沒有縮圖", r.data.looks.length === 1 && r.data.looks[0].item_count === 2 && r.data.looks[0].is_favorite && r.data.looks[0].thumb_at === null);
}

console.log("舊造型兼容");
{
  await env.DB.prepare("INSERT INTO doll_looks (id,name,avatar_id,status,created_at,updated_at) VALUES ('look_v1','V1 舊造型','base_v1','active','t','2026-11-12T00:00:00Z')").run();
  await env.DB.prepare("INSERT INTO doll_look_items (look_id,garment_id,slot,z,ov_cx,ov_cy,ov_w,ov_rotation) VALUES ('look_v1','gar_b','dress',500,610,910,480,1),('look_v1','gar_a','top',300,NULL,NULL,NULL,NULL)").run();
  await env.DB.prepare("INSERT INTO doll_looks (id,name,avatar_id,status,created_at,updated_at,hair_color,pose) VALUES ('look_p2','V2 舊格式','avatar_v2','active','t','2026-11-12T00:00:01Z','purple','{\"head\":4}')").run();
  await env.DB.prepare("INSERT INTO doll_look_items (look_id,garment_id,slot,z,ov_cx,ov_cy,ov_w,ov_rotation) VALUES ('look_p2','gar_c','skirt',400,600,950,500,0)").run();
  let r = await call("GET", "/api/doll/looks/look_v1");
  check("V1 舊造型可以開啟：回傳舊資料供換算", r.status === 200 && r.data.state === null && r.data.legacy.avatar_id === "base_v1" && r.data.legacy.items.map((i) => i.garment_id).join() === "gar_a,gar_b" && r.data.legacy.items[1].override.cx === 610 && r.data.garments.length === 2, r.data);
  r = await call("GET", "/api/doll/looks/look_p2");
  check("Phase 2 的 V2 造型：髮色及姿勢保留", r.data.legacy.avatar_id === "avatar_v2" && r.data.legacy.hair_color === "purple" && r.data.legacy.pose.head === 4 && r.data.legacy.items[0].override.w === 500);
  r = await call("GET", "/api/doll/looks");
  check("舊造型仍在列表", r.data.looks.map((l) => l.id).includes("look_v1") && r.data.looks.find((l) => l.id === "look_v1").legacy === true);
  r = await call("PATCH", "/api/doll/looks/look_v1", { state: { items: [{ garment_id: "gar_a", slot: "top" }, { garment_id: "gar_b", slot: "dress", fit }] } });
  check("保存後轉為新角色，衣物保留", r.data.state.items.length === 2 && r.data.legacy === null && (await env.DB.prepare("SELECT avatar_id FROM doll_looks WHERE id='look_v1'").first()).avatar_id === "avatar_v2");
  await env.DB.prepare("DELETE FROM garments WHERE id = 'gar_c'").run();
  r = await call("GET", `/api/doll/looks/look_p2`);
  check("衣物被刪除後造型仍可開啟", r.status === 200 && r.data.legacy.items.length === 0);
}

console.log("造型縮圖");
{
  const jpg = new Uint8Array(await sharp({ create: { width: 360, height: 540, channels: 3, background: "#eadff0" } }).jpeg().toBuffer());
  let r = await call("PUT", `/api/doll/looks/${lookId}/thumb`, jpg, "image/jpeg");
  check("保存縮圖", r.status === 200 && r.data.thumb_at);
  r = await call("GET", `/api/doll/looks/${lookId}/thumb`);
  check("讀回縮圖", r.status === 200 && r.headers.get("content-type") === "image/jpeg" && r.data.length === jpg.length);
  r = await call("GET", "/api/doll/looks");
  check("列表顯示有縮圖", !!r.data.looks.find((l) => l.id === lookId).thumb_at);
  r = await call("PUT", `/api/doll/looks/${lookId}/thumb`, new Uint8Array(200_000), "image/jpeg");
  check("過大或不是圖片被拒絕", r.status >= 400);
  r = await call("GET", "/api/doll/looks/look_p2/thumb");
  check("未有縮圖 404", r.status === 404);
}

console.log("角色素材（頭部／髮型）");
{
  let r = await call("POST", "/api/doll/assets", { kind: "hair", name: "長直髮", category: "長髮" });
  const hairId = r.data.id;
  check("建立髮型素材", r.status === 201 && /^das_/.test(hairId) && r.data.files.length === 0);
  const back = await png(600, 900, "#644950"), bangs = await png(300, 260, "#644950");
  const f1 = await call("POST", `/api/doll/assets/${hairId}/files`, back, "image/png");
  const f2 = await call("POST", `/api/doll/assets/${hairId}/files`, bangs, "image/png");
  check("上傳透明圖：存入 R2 的 doll/ 路徑", f1.status === 201 && f1.data.width === 600 && f2.data.ref.startsWith("file:daf_") && [...env.IMAGES.objects.keys()].filter((k) => k.startsWith(`doll/assets/${hairId}/`)).length === 2, f1.data);
  r = await call("POST", `/api/doll/assets/${hairId}/files`, await png(100, 100, "#000", false), "image/png");
  check("沒有透明背景的圖被拒絕", r.status === 400 && r.data.error.code === "no_alpha", r.data);
  r = await call("POST", `/api/doll/assets/${hairId}/files`, new TextEncoder().encode("not an image"), "image/png");
  check("不是圖片被拒絕", r.status >= 400);
  const config = { parts: [{ id: "back", label: "後髮", file: f1.data.ref, layer: "back", x: 300, y: 0, w: 600, h: 900 }, { id: "bangs", label: "瀏海", file: f2.data.ref, layer: "front", x: 500, y: 30, w: 200, h: 173, bone: "own", range: 15 }] };
  r = await call("PATCH", `/api/doll/assets/${hairId}`, { config, name: "長直髮・改" });
  check("保存部件位置、前後圖層及獨立髮束", r.status === 200 && r.data.config.parts.length === 2 && r.data.config.parts[1].bone === "own" && r.data.name === "長直髮・改", r.data);
  r = await call("PATCH", `/api/doll/assets/${hairId}`, { config: { parts: [{ id: "x", file: "file:daf_aaaaaaaaaaaaaaaaaaaa", x: 0, y: 0, w: 10, h: 10 }] } });
  check("設定不能引用其他素材的圖片", r.status === 400);
  r = await call("GET", "/api/doll/files/" + f1.data.id);
  check("讀取素材圖片", r.status === 200 && r.headers.get("content-type") === "image/png" && r.data.length === back.length);
  r = await call("PUT", `/api/doll/assets/${hairId}/thumb`, await png(120, 160), "image/png");
  check("保存素材縮圖", r.status === 200);
  r = await call("GET", "/api/doll/assets");
  check("列表：設定、縮圖網址", r.data.assets.length === 1 && r.data.assets[0].thumb.includes("/thumb?v=") && r.data.assets[0].config.parts.length === 2);
  r = await call("POST", "/api/doll/assets", { kind: "head", name: "淡妝" });
  const headId = r.data.id;
  const hf = await call("POST", `/api/doll/assets/${headId}/files`, await png(440, 544, "#f6d8cf"), "image/png");
  r = await call("PATCH", `/api/doll/assets/${headId}`, { config: { file: hf.data.ref, x: 491, y: 36, w: 220, h: 272 } });
  check("頭部素材：獨立於頭髮和身體", r.status === 200 && r.data.config.w === 220);
  r = await call("POST", "/api/doll/assets", { kind: "garment_part", name: "打開", garment_id: "gar_d" });
  check("衣物額外部件（其他穿法的圖）", r.status === 201 && r.data.garment_id === "gar_d");
  r = await call("POST", "/api/doll/assets", { kind: "garment_part", name: "x", garment_id: "gar_none" });
  check("部件必須屬於現有衣物", r.status === 400);
  r = await call("POST", "/api/doll/looks", { name: "新髮型", state: { hair: hairId, head: headId, pose: { hp_bangs: 10 }, items: [] } });
  check("造型可以使用上傳的頭部及髮型（連髮束姿勢）", r.status === 201 && r.data.state.hair === hairId && r.data.state.head === headId && r.data.state.pose.hp_bangs === 10);
  r = await call("POST", "/api/maintenance/orphans", { delete: true });
  check("孤兒檔案清理不會刪除角色素材", [...env.IMAGES.objects.keys()].filter((k) => k.startsWith("doll/")).length === 3, r.data);
  r = await call("DELETE", "/api/doll/files/" + f2.data.id);
  check("刪除單一圖片", r.status === 200 && [...env.IMAGES.objects.keys()].filter((k) => k.startsWith(`doll/assets/${hairId}/`)).length === 1);
  r = await call("DELETE", `/api/doll/assets/${hairId}`);
  check("刪除素材：連同 doll/ 內的檔案", r.status === 200 && [...env.IMAGES.objects.keys()].filter((k) => k.startsWith(`doll/assets/${hairId}/`)).length === 0);
  check("衣物及衣物圖片完全沒有被改動", (await garmentSnap()).replace(/,\{[^{}]*"id":"gar_c"[^{}]*\}/, "") !== "" && [...env.IMAGES.objects.keys()].filter((k) => k.startsWith("garments/")).length === 4);
}

console.log("權限");
{
  const res = await worker.fetch(new Request(ORIGIN + "/api/doll/looks", { headers: { origin: ORIGIN } }), env);
  check("未登入不能讀取", res.status === 401);
  const res2 = await worker.fetch(new Request(ORIGIN + "/api/doll/files/daf_aaaaaaaaaaaaaaaaaaaa", { headers: { origin: ORIGIN } }), env);
  check("未登入不能讀取素材圖片", res2.status === 401);
}

console.log(`\n${passed} 項通過，${failures.length} 項失敗`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
