// Phase 3.9A.1.1：穿著排序規則、穿著摘要 API（只計已穿著、同日不重複、套裝部件）、照片上傳冪等（op）、造型完整縮圖、日誌封面解析、首頁日曆元件設定。
// 執行：node test/phase39a11.mjs   （本機模擬 D1／R2）
import { makeEnv } from "./harness.mjs";
import { buildWorker, buildModule } from "./doll-build.mjs";
import { addGarment, checker, hex, now, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const worker = await buildWorker("p39a11-worker");
const W = await buildModule("shared/wearSort.ts", "p39a11-wear");
const L = await buildModule("shared/homeLayout.ts", "p39a11-layout");
const C = await buildModule("src/diaryCover.ts", "p39a11-cover");
const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P3911-1234")), now()).run();
const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P3911-1234", username: "tester", password: "test-password-1234" }) }), env);
const cookie = auth.headers.get("set-cookie").split(";")[0];
const call = async (method, path, body) => { const r = await worker.fetch(new Request("http://localhost" + path, { method, headers: { cookie, "x-requested-with": "ai-wardrobe", ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }), env); return { status: r.status, body: await r.json().catch(() => null) }; };
const SVG = '<rect x="200" y="200" width="500" height="800" fill="#7a3b5e"/>';

try {
  console.log("穿著排序規則（純函數）");
  const G = (id, created, price = null, name = id) => ({ id, name, price, created_at: created, updated_at: created });
  const list = [G("a", "2026-01-01"), G("b", "2026-02-01"), G("c", "2026-03-01"), G("d", "2026-04-01"), G("e", "2026-05-01")];
  const wear = { a: [5, "2026-10-01"], b: [5, "2026-11-10"], c: [1, "2026-06-01"], d: [2, "2026-11-12"] }; // e 從未穿著
  const ids = (s) => W.sortByWear(list, s, wear).map((g) => g.id).join("");
  check("最常穿著：日數多 → 同日數按最近穿著 → 從未穿著最後", ids("most_worn") === "badce", ids("most_worn"));
  check("最近穿著：最近日期優先，從未穿著最後", ids("recent_worn") === "dbace", ids("recent_worn"));
  check("最久未穿：最舊日期優先，從未穿著最後", ids("least_recent") === "cabde", ids("least_recent"));
  check("從未穿著優先：從未穿著在最前，其餘按最久未穿", ids("never_first") === "ecabd", ids("never_first"));
  check("排序不改動原陣列", list.map((g) => g.id).join("") === "abcde");
  const twoNever = [G("x", "2026-01-01"), G("y", "2025-01-01"), G("z", "2026-01-01")];
  check("同分穩定：從未穿著按最早加入，再按 ID", W.sortByWear(twoNever, "never_first", {}).map((g) => g.id).join("") === "yxz");
  check("十種排序都有中文名稱", Object.keys(W.SORT_LABEL).length === 10 && W.SORT_LABEL.never_first === "從未穿著優先");

  console.log("穿著摘要 API");
  for (const [id, name, cat] of [["gar_jsk", "紫色 JSK", "連身裙"], ["gar_blouse", "白色襯衫", "上衣"], ["gar_set", "女僕套裝", "套裝"], ["gar_never", "未穿過", "半身裙"]]) await addGarment(env, { id, name, category: cat, subcategory: cat, svg: SVG });
  const t = now();
  await env.DB.prepare("INSERT INTO doll_assets (id, kind, name, garment_id, status, created_at, updated_at) VALUES ('ast_p1','garment_part','頭飾','gar_set','active',?,?)").bind(t, t).run();
  await call("POST", "/api/diary", { worn_date: "2026-11-01", kind: "worn", items: [{ garment_id: "gar_jsk" }, { garment_id: "gar_blouse" }] });
  await call("POST", "/api/diary", { worn_date: "2026-11-01", kind: "worn", items: [{ garment_id: "gar_jsk" }] }); // 同日第二套
  await call("POST", "/api/diary", { worn_date: "2026-11-05", kind: "worn", items: [{ garment_id: "gar_jsk" }, { garment_id: "gar_set" }, { garment_id: "gar_set", part: "ast_p1" }] });
  await call("POST", "/api/diary", { worn_date: "2026-11-06", kind: "planned", items: [{ garment_id: "gar_blouse" }] });
  await call("POST", "/api/diary", { worn_date: "2026-11-07", kind: "inspiration", items: [{ garment_id: "gar_never" }] });
  await call("POST", "/api/diary", { worn_date: "2026-12-01", kind: "worn", items: [{ garment_id: "gar_blouse" }] }); // 將來
  let r = await call("GET", "/api/diary/wear-summary?today=2026-11-15");
  const g = r.body.garments;
  check("同一衣物同一天多套只計一日", g.gar_jsk[0] === 2 && g.gar_jsk[1] === "2026-11-05", g.gar_jsk);
  check("計劃及靈感穿搭不計入", g.gar_blouse[0] === 1 && !g.gar_never, [g.gar_blouse, g.gar_never]);
  check("套裝部件不重複計算", g.gar_set[0] === 1, g.gar_set);
  check("將來日期不計", g.gar_blouse[1] === "2026-11-01");
  check("缺少今日日期被拒絕", (await call("GET", "/api/diary/wear-summary")).status === 400);
  const e = (await call("GET", "/api/diary?from=2026-11-05&to=2026-11-05")).body.entries[0];
  await call("DELETE", "/api/diary/" + e.id);
  r = await call("GET", "/api/diary/wear-summary?today=2026-11-15");
  check("刪除紀錄後統計立即更新", r.body.garments.gar_jsk[0] === 1 && !r.body.garments.gar_set, r.body.garments);

  console.log("照片上傳冪等（op）");
  const ent = (await call("POST", "/api/diary", { worn_date: "2026-11-10", kind: "worn", items: [] })).body;
  const img = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#884466" } }).jpeg().toBuffer();
  const img2 = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#448866" } }).jpeg({ quality: 70 }).toBuffer();
  const form = (buf, op) => { const f = new FormData(); f.set("file", new Blob([buf], { type: "image/jpeg" }), "p.jpg"); if (op) f.set("op", op); return f; };
  const op = "k3j9x0abcde12345fghi";
  r = await call("POST", `/api/diary/${ent.id}/photos`, form(img, op));
  check("帶 op 上傳：照片 ID 由 op 決定", r.status === 201 && r.body.photo.id === "dph_" + op, r.body);
  r = await call("POST", `/api/diary/${ent.id}/photos`, form(img2, op)); // 重試時重新壓縮，內容不同
  check("同一 op 重試（內容不同）：不重複建立", r.body.duplicate === true && r.body.photo.id === "dph_" + op);
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM diary_photos WHERE entry_id = ?").bind(ent.id).first()).n;
  check("資料庫只有一張照片", count === 1, count);
  r = await call("POST", `/api/diary/${ent.id}/photos`, form(img2, "BAD op!"));
  check("不合法的 op 被忽略（使用伺服器 ID）", r.status === 201 && r.body.photo.id !== "dph_BAD op!");

  console.log("日誌完整造型縮圖");
  const lookId = "look_p3911";
  await env.DB.prepare("INSERT INTO doll_looks (id, name, created_at, updated_at) VALUES (?, '女僕造型', ?, ?)").bind(lookId, t, t).run();
  const look = { body: lookId };
  if (lookId) {
    await env.DB.prepare("INSERT INTO doll_look_thumbs (look_id, data, mime_type, byte_size, updated_at) VALUES (?,?,?,?,?)").bind(lookId, new Uint8Array([1, 2, 3]), "image/jpeg", 3, "2026-11-14T00:00:00Z").run();
    const de = (await call("POST", "/api/diary", { worn_date: "2026-11-11", kind: "worn", look_id: lookId })).body;
    check("來自角色造型的紀錄帶有完整造型縮圖網址", typeof de.source_thumb === "string" && de.source_thumb.startsWith(`/api/doll/looks/${lookId}/thumb?v=`), de.source_thumb);
  } else check("建立測試角色造型", false, look);
  const plain = (await call("POST", "/api/diary", { worn_date: "2026-11-12", kind: "worn", items: [{ garment_id: "gar_jsk" }] })).body;
  check("沒有完整造型縮圖時 source_thumb＝null（不以第一件衣物冒充）", plain.source_thumb === null);

  console.log("封面解析");
  const base = { cover_photo_id: null, photos: [], items: [{ snap_id: "s1" }], source_thumb: null };
  check("只有衣物快照：衣物縮圖", C.resolveCover(base).kind === "garment");
  check("有造型縮圖：優先造型（高於衣物）", C.resolveCover({ ...base, source_thumb: "/look.jpg" }).src === "/look.jpg");
  check("有真人照片：自動模式優先照片", C.resolveCover({ ...base, source_thumb: "/look.jpg", photos: [{ id: "dph_1" }] }).kind === "photo");
  check("指定封面照片", C.resolveCover({ ...base, photos: [{ id: "dph_1" }, { id: "dph_2" }], cover_photo_id: "dph_2" }).src.includes("dph_2"));
  check("優先角色造型模式", C.resolveCover({ ...base, source_thumb: "/look.jpg", photos: [{ id: "dph_1" }] }, "look").kind === "look");
  check("只顯示衣物縮圖模式", C.resolveCover({ ...base, source_thumb: "/look.jpg", photos: [{ id: "dph_1" }] }, "garment").kind === "garment");
  check("沒有任何圖片：null", C.resolveCover({ cover_photo_id: null, photos: [], items: [] }) === null);

  console.log("首頁日曆元件設定");
  check("日曆元件新增照片月曆及照片週曆", L.DISPLAYS.diary_calendar.some(([k]) => k === "photo_month") && L.DISPLAYS.diary_calendar.some(([k]) => k === "photo_week"));
  check("新增的日曆元件預設照片月曆（大型全寬）", L.newWidget("diary_calendar", "x").display === "photo_month" && L.newWidget("diary_calendar", "x").span === 2);
  const old = L.normalizeHomeLayout({ v: 2, rev: 3, widgets: [{ id: "diary_calendar", type: "diary_calendar", visible: true, size: "medium", display: "dots", span: 1, opts: { title: false } }] });
  const ow = old.widgets.find((x) => x.id === "diary_calendar");
  check("舊元件保留 ID、展示方式、尺寸及設定", ow.display === "dots" && ow.size === "medium" && ow.opts.title === false && old.rev === 3, ow);
  const cw = L.normalizeHomeLayout({ v: 2, widgets: [{ id: "cal2", type: "diary_calendar", visible: true, size: "large", display: "photo_week", span: 2, opts: { cover: "look" } }, { id: "c3", type: "diary_calendar", visible: true, size: "large", display: "photo_month", span: 2, opts: { cover: "evil" } }] }).widgets;
  check("封面來源設定被保存；不合法值被忽略", cw.find((x) => x.id === "cal2")?.opts.cover === "look" && (cw.find((x) => x.id === "c3")?.opts.cover ?? null) === null, cw.map((x) => [x.id, x.opts]));
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  done();
}
