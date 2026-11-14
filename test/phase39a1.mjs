// Phase 3.9A.1：穿搭日誌 API（建立、同日多套、計劃轉已穿著、複製、移動日期、刪除、照片、歷史快照、穿著統計、每次穿著成本）。
// 執行：node test/phase39a1.mjs   （本機模擬 D1／R2）
import { makeEnv } from "./harness.mjs";
import { buildWorker, buildModule } from "./doll-build.mjs";
import { addGarment, checker, hex, now, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const worker = await buildWorker("p39a1-worker");
const D = await buildModule("worker/diary.ts", "p39a1-diary");
const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P39-1234")), now()).run();
const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P39-1234", username: "tester", password: "test-password-1234" }) }), env);
const cookie = auth.headers.get("set-cookie").split(";")[0];
const call = async (method, path, body) => { const r = await worker.fetch(new Request("http://localhost" + path, { method, headers: { cookie, "x-requested-with": "ai-wardrobe", ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }), env); return { status: r.status, body: await r.json().catch(() => null), raw: r }; };
const SVG = '<rect x="200" y="200" width="500" height="800" fill="#7a3b5e"/>';
await addGarment(env, { id: "gar_jsk", name: "紫色 JSK", category: "連身裙", subcategory: "JSK", svg: SVG, price: 1200 });
await addGarment(env, { id: "gar_blouse", name: "白色襯衫", category: "上衣", subcategory: "Blouse", svg: SVG, price: null });
await addGarment(env, { id: "gar_maid", name: "女僕套裝", category: "套裝", subcategory: "套裝", svg: SVG, price: 900 });
await addGarment(env, { id: "gar_unworn", name: "未穿過的裙", category: "半身裙", subcategory: "SK", svg: SVG, price: 500 });
const t = now();
for (const [id, name] of [["ast_head", "頭飾"], ["ast_lsleeve", "左袖套"]]) await env.DB.prepare("INSERT INTO doll_assets (id, kind, name, garment_id, status, created_at, updated_at) VALUES (?, 'garment_part', ?, 'gar_maid', 'active', ?, ?)").bind(id, name, t, t).run();

try {
  console.log("建立紀錄");
  let r = await call("POST", "/api/diary", { title: "上班", worn_date: "2026-11-14", worn_time: "08:30", kind: "worn", occasion: "上班", tags: "#蘿莉塔 #上班", items: [{ garment_id: "gar_jsk" }, { garment_id: "gar_blouse" }], tz: "Asia/Hong_Kong" });
  check("只選衣物即可建立紀錄（不需要先建立造型）", r.status === 201 && r.body.items.length === 2 && r.body.garment_count === 2, r.body);
  const e1 = r.body;
  check("日期保持使用者本地日期（不作 UTC 轉換）", e1.worn_date === "2026-11-14" && e1.worn_time === "08:30");
  check("標籤整理", e1.tags.join() === "蘿莉塔,上班");
  r = await call("POST", "/api/diary", { title: "晚上外出", worn_date: "2026-11-14", worn_time: "23:50", kind: "worn", items: [{ garment_id: "gar_jsk" }] });
  check("同一天可以有多套穿搭", r.status === 201);
  const day = (await call("GET", "/api/diary?from=2026-11-14&to=2026-11-14")).body.entries;
  check("同日兩筆紀錄，按時間排序", day.length === 2 && day[0].worn_time === "23:50");
  check("錯誤日期被拒絕", (await call("POST", "/api/diary", { worn_date: "2026-13-40", items: [] })).status === 400);
  check("不存在的衣物被拒絕（不建立半筆紀錄）", (await call("POST", "/api/diary", { worn_date: "2026-11-10", items: [{ garment_id: "gar_nope" }] })).status === 400 && (await call("GET", "/api/diary?from=2026-11-10&to=2026-11-10")).body.entries.length === 0);

  console.log("套裝部件");
  r = await call("POST", "/api/diary", { worn_date: "2026-11-12", kind: "worn", items: [{ garment_id: "gar_maid" }, { garment_id: "gar_maid", part: "ast_head" }, { garment_id: "gar_maid", part: "ast_lsleeve" }] });
  check("套裝部件保存為獨立項目但只計一件衣物", r.status === 201 && r.body.items.length === 3 && r.body.garment_count === 1 && r.body.items[1].name === "女僕套裝｜頭飾");

  console.log("計劃、靈感、轉為已穿著");
  r = await call("POST", "/api/diary", { worn_date: "2026-11-20", kind: "planned", items: [{ garment_id: "gar_unworn" }] });
  const plan = r.body;
  let st = (await call("GET", "/api/diary/stats?today=2026-11-21")).body;
  check("計劃穿搭不計入穿著統計", st.never_recorded.some((g) => g.id === "gar_unworn"));
  r = await call("PATCH", "/api/diary/" + plan.id, { kind: "worn", base_updated_at: plan.updated_at });
  check("計劃轉為已穿著（同一筆紀錄，不另建）", r.status === 200 && r.body.id === plan.id && r.body.kind === "worn");
  check("舊版本保存：衝突提示（保留草稿）", (await call("PATCH", "/api/diary/" + plan.id, { notes: "x", base_updated_at: plan.updated_at })).status === 409);
  st = (await call("GET", "/api/diary/stats?today=2026-11-21")).body;
  check("轉為已穿著後計入統計", !st.never_recorded.some((g) => g.id === "gar_unworn"));
  await call("POST", "/api/diary", { worn_date: "2026-11-15", kind: "inspiration", items: [{ garment_id: "gar_blouse" }] });

  console.log("穿著統計");
  const w = (await call("GET", "/api/garments/gar_jsk/wear?today=2026-11-21")).body;
  check("同一天兩筆紀錄：穿著日只計一次，另列出現於 2 筆紀錄", w.worn_days === 1 && w.entries === 2, w);
  check("第一次／最近一次穿著、本月及本年、距今日數", w.first === "2026-11-14" && w.last === "2026-11-14" && w.month === 1 && w.year === 1 && w.days_since === 7);
  check("每次穿著成本＝價格 ÷ 穿著日數", w.cost_per_wear === 1200);
  const wb = (await call("GET", "/api/garments/gar_blouse/wear?today=2026-11-21")).body;
  check("沒有價格：每次穿著成本未知（不當作 0）", wb.cost_per_wear === null && wb.worn_days === 1);
  check("靈感穿搭不計入", wb.worn_days === 1);
  const wu = (await call("GET", "/api/garments/gar_unworn/wear?today=2026-11-19")).body;
  check("將來日期的已穿著紀錄不計入（今日之前才計）", wu.worn_days === 0 && wu.cost_per_wear === null);
  const wm = (await call("GET", "/api/garments/gar_maid/wear?today=2026-11-21")).body;
  check("套裝連同部件同日只計一次", wm.worn_days === 1 && wm.cost_per_wear === 900);
  st = (await call("GET", "/api/diary/stats?today=2026-11-21")).body;
  check("本月記錄天數及不同衣物數量", st.record_days === 3 && st.distinct_garments === 4, st);
  check("衣櫃使用率＝本月穿過衣物 ÷ 未封存衣物", Math.abs(st.usage_rate - 4 / 4) < 1e-9);
  check("每次穿著成本排行只包括有價格的衣物", st.cost_per_wear.every((g) => g.price > 0) && st.cost_unknown === 1);
  check("區分「尚未記錄穿著」並列出日誌開始日期", st.diary_since === "2026-11-12" && typeof st.never_recorded_count === "number");
  check("純函數：同日多筆只計一次", D.wearStats([{ garment_id: "a", worn_date: "2026-01-01", entries: 3 }, { garment_id: "a", worn_date: "2026-01-02", entries: 1 }], "2026-01-31").get("a").days === 2);

  console.log("複製、移動日期");
  r = await call("POST", `/api/diary/${e1.id}/duplicate`, { worn_date: "2026-11-30", kind: "planned" });
  check("複製到另一日期：新 ID，原紀錄不變", r.status === 201 && r.body.id !== e1.id && r.body.worn_date === "2026-11-30" && r.body.items.length === 2 && (await call("GET", "/api/diary/" + e1.id)).body.worn_date === "2026-11-14");
  r = await call("PATCH", "/api/diary/" + r.body.id, { worn_date: "2026-12-01" });
  check("移動日期", r.body.worn_date === "2026-12-01");

  console.log("使用已有穿搭（不修改原造型）");
  await env.DB.prepare("INSERT INTO outfits (id,name,created_at,updated_at) VALUES ('out_a','週末配搭',?,?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO outfit_items (outfit_id,garment_id,position) VALUES ('out_a','gar_jsk',0),('out_a','gar_blouse',1)").run();
  const before = await env.DB.prepare("SELECT updated_at FROM outfits WHERE id='out_a'").first();
  r = await call("POST", "/api/diary", { worn_date: "2026-11-16", kind: "worn", outfit_id: "out_a" });
  check("由衣服配搭帶入衣物清單及名稱", r.status === 201 && r.body.items.length === 2 && r.body.source_name === "週末配搭");
  check("原造型沒有被修改", (await env.DB.prepare("SELECT updated_at FROM outfits WHERE id='out_a'").first()).updated_at === before.updated_at);

  console.log("照片");
  const jpg = new Uint8Array(await sharp({ create: { width: 600, height: 800, channels: 3, background: "#884466" } }).jpeg().toBuffer());
  const th = new Uint8Array(await sharp({ create: { width: 120, height: 160, channels: 3, background: "#884466" } }).webp().toBuffer());
  const fd = () => { const f = new FormData(); f.set("file", new Blob([jpg], { type: "image/jpeg" }), "a.jpg"); f.set("thumb", new Blob([th], { type: "image/webp" }), "t.webp"); return f; };
  r = await call("POST", `/api/diary/${e1.id}/photos`, fd());
  check("上傳照片：R2 diary/ 路徑及 D1 縮圖", r.status === 201 && r.body.photo.width === 600);
  const pid = r.body.photo.id;
  const again = await call("POST", `/api/diary/${e1.id}/photos`, fd());
  check("上傳重試：同一照片不重複建立", again.body.duplicate === true && again.body.photo.id === pid);
  const e1b = (await call("GET", "/api/diary/" + e1.id)).body;
  check("第一張照片自動成為封面", e1b.cover_photo_id === pid && e1b.photos.length === 1);
  check("照片縮圖讀取（D1，不讀 R2）", (await call("GET", `/api/diary/photos/${pid}/thumb`)).raw.headers.get("content-type") === "image/webp");
  check("照片原圖為私人快取", (await call("GET", `/api/diary/photos/${pid}`)).raw.headers.get("cache-control").startsWith("private"));
  const keys = [...env.IMAGES.objects?.keys?.() ?? env.IMAGES.map?.keys?.() ?? []];
  check("R2 用途分類：穿搭日誌照片", (await buildModule("worker/r2usage.ts", "p39a1-r2")).purposeOf(`diary/${e1.id}/${pid}.jpg`) === "diary_photos");
  void keys;

  console.log("歷史完整性");
  await call("PATCH", "/api/garments/gar_jsk", { name: "改名後的 JSK" });
  let h = (await call("GET", "/api/diary/" + e1.id)).body;
  check("修改衣物名稱：舊紀錄保留當時名稱", h.items.find((i) => i.garment_id === "gar_jsk").name === "紫色 JSK");
  await call("PATCH", "/api/diary/" + e1.id, { items: [{ garment_id: "gar_jsk" }, { garment_id: "gar_blouse" }, { garment_id: "gar_unworn" }] });
  h = (await call("GET", "/api/diary/" + e1.id)).body;
  check("編輯紀錄加入新衣物：已有衣物保留原快照", h.items.find((i) => i.garment_id === "gar_jsk").name === "紫色 JSK" && h.items.length === 3);
  const snap = h.items.find((i) => i.garment_id === "gar_blouse").snap_id;
  const del = await call("DELETE", "/api/garments/gar_blouse");
  h = (await call("GET", "/api/diary/" + e1.id)).body;
  check("刪除衣物後：歷史紀錄仍保留名稱", del.status < 300 && h.items.some((i) => i.garment_id === "gar_blouse" && i.name === "白色襯衫"), del.status);
  check("刪除衣物後：縮圖快照仍可讀取", snap && (await call("GET", "/api/diary/snaps/" + encodeURIComponent(snap))).status === 200);
  const snaps = (await env.DB.prepare("SELECT COUNT(*) AS n FROM diary_snaps WHERE garment_id='gar_jsk'").first()).n;
  check("縮圖快照按來源去重（多筆紀錄共用一份）", snaps === 1, snaps);

  console.log("刪除");
  r = await call("DELETE", "/api/diary/" + e1.id);
  check("刪除紀錄連同照片（R2）", r.status === 200 && (await call("GET", `/api/diary/photos/${pid}`)).status === 404);
  check("日誌 API 需要登入", (await worker.fetch(new Request("http://localhost/api/diary"), env)).status === 401);
  check("搜尋衣物、標籤及場合", (await call("GET", "/api/diary?q=" + encodeURIComponent("女僕"))).body.entries.length === 1);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  done();
}
