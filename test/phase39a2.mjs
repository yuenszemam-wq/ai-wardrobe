// Phase 3.9A.2：工作室 V2 API（獨立圖層、舊造型相容、原子保存、衝突、背景、素材版本、去背、引用檢查、縮圖、圖層上限）及場景純函數。
// 執行：node test/phase39a2.mjs   （本機模擬 D1／R2）
import { makeEnv } from "./harness.mjs";
import { buildWorker, buildModule } from "./doll-build.mjs";
import { addGarment, checker, hex, now, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const worker = await buildWorker("p39a2-worker");
const S = await buildModule("shared/studioScene.ts", "p39a2-scene");
const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P392-1234")), now()).run();
const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P392-1234", username: "tester", password: "test-password-1234" }) }), env);
const cookie = auth.headers.get("set-cookie").split(";")[0];
const call = async (method, path, body) => { const r = await worker.fetch(new Request("http://localhost" + path, { method, headers: { cookie, "x-requested-with": "ai-wardrobe", ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }), env); const ct = r.headers.get("content-type") || ""; return { status: r.status, body: ct.includes("json") ? await r.json().catch(() => null) : null, raw: r }; };
const SVG = '<rect x="200" y="200" width="500" height="800" fill="#7a3b5e"/>';
const L = (id, gid, extra = {}) => ({ layer_id: id, layer_type: "garment", garment_id: gid, x: 10, y: 10, w: 50, h: 60, ...extra });

try {
  console.log("場景純函數");
  const base = [L("a", "g1"), L("b", "g2"), L("c", "g3")].map((x) => S.normalizeLayer(x));
  check("列表（上＝最前）與內部（底→頂）只在一處轉換", S.toTopFirst(base).map((l) => l.layer_id).join("") === "cba" && S.fromTopFirst(S.toTopFirst(base)).map((l) => l.layer_id).join("") === "abc");
  check("拖動排序（列表次序）→ 內部次序", S.reorderByTopFirstIds(base, ["a", "c", "b"]).map((l) => l.layer_id).join("") === "bca");
  check("向前、向後、置頂、置底", S.moveLayer(base, "a", "forward").map((l) => l.layer_id).join("") === "bac" && S.moveLayer(base, "c", "backward").map((l) => l.layer_id).join("") === "acb" && S.moveLayer(base, "a", "front").map((l) => l.layer_id).join("") === "bca" && S.moveLayer(base, "c", "back").map((l) => l.layer_id).join("") === "cab");
  const masked = [S.normalizeLayer(L("m", "g1", { mask: { v: 1, strokes: [{ mode: "hide", size: 0.1, pts: [0.5, 0.5, 0.6, 0.6] }] } }))];
  const dup = S.duplicateLayer(masked, "m", "m2");
  dup[1].mask.strokes[0].pts[0] = 0.9;
  check("複製：新 ID、偏移位置、放在原圖層之上、遮罩獨立", dup.length === 2 && dup[1].layer_id === "m2" && dup[1].x === 13 && dup[0].mask.strokes[0].pts[0] === 0.5);
  const legacy = S.legacyLayers([{ garment_id: "g2", layer_order: 1, x: 5, y: 6, w: 7, h: 8 }, { garment_id: "g1", layer_order: 0, x: null, y: null, w: null, h: null, category: "鞋" }], (i) => S.slotFor(i.category));
  check("舊造型：穩定圖層 ID、保留次序及位置、缺少位置時按類別預設", legacy.map((l) => l.layer_id).join() === "g:g1,g:g2" && legacy[1].x === 5 && legacy[0].y === 84);
  const loc = S.toLayerLocal({ x: 0, y: 0, w: 50, h: 50, rotation: 0, flip_x: false, flip_y: false }, 25, 25, 0.75);
  check("命中座標：方框中心 → 圖片中心", Math.abs(loc.u - 0.5) < 1e-6 && Math.abs(loc.v - 0.5) < 1e-6, loc);
  const rot = S.toLayerLocal({ x: 0, y: 0, w: 50, h: 50, rotation: 90, flip_x: true, flip_y: false }, 25, 25, 1);
  check("旋轉及翻轉後中心點不變", Math.abs(rot.u - 0.5) < 1e-6 && Math.abs(rot.v - 0.5) < 1e-6);
  check("背景：不正確的類型＝null；圖片背景必須有素材", S.normalizeBackground({ type: "evil" }) === null && S.normalizeBackground({ type: "image" }) === null && S.normalizeBackground({ type: "solid", color: "#ABCDEF" }).color === "#abcdef");
  check("背景：漸層少於兩個色點時使用預設", S.normalizeBackground({ type: "gradient", stops: [{ color: "#000000", at: 0 }] }).stops.length === 2);
  check("圖層：不合法類型被拒絕", typeof S.normalizeLayer({ layer_id: "x", layer_type: "hack", garment_id: "g" }) === "string");

  console.log("舊造型相容");
  for (const [id, name, cat] of [["gar_jsk", "紫色 JSK", "連身裙"], ["gar_blouse", "白色蕾絲上衣", "上衣"], ["gar_set", "女僕套裝", "套裝"]]) await addGarment(env, { id, name, category: cat, subcategory: cat, svg: SVG });
  const t = now();
  await env.DB.prepare("INSERT INTO doll_assets (id, kind, name, garment_id, status, created_at, updated_at) VALUES ('ast_apron','garment_part','圍裙','gar_set','active',?,?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO outfits (id, name, notes, is_favorite, status, created_at, updated_at) VALUES ('out_old','舊造型','備註',1,'active',?,?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO outfit_items (outfit_id, garment_id, position, layer_order, x, y, w, h) VALUES ('out_old','gar_blouse',0,0,20,14,60,34), ('out_old','gar_jsk',1,1,12,16,76,60)").run();
  let r = await call("GET", "/api/outfits/out_old");
  check("舊造型載入：圖層由舊資料生成，次序、位置、名稱、收藏及備註不變", r.status === 200 && r.body.layers.map((l) => l.layer_id).join() === "g:gar_blouse,g:gar_jsk" && r.body.layers[1].x === 12 && r.body.name === "舊造型" && r.body.is_favorite === true && r.body.notes === "備註" && r.body.background === null, r.body);
  check("舊造型沒有背景＝null（維持原本預設）", r.body.background === null);
  const oldUpdated = r.body.updated_at;

  r = await call("POST", "/api/outfits", { name: "舊版格式", items: [{ garment_id: "gar_jsk", position: 0, layer_order: 1, x: 10.5, y: 20, w: 60, h: 70 }, { garment_id: "gar_blouse", position: 1, layer_order: 0 }] });
  check("舊版格式（AI 工具）：保存位置；沒有位置的單品仍為 null（App 用預設位置）", r.status === 201 && r.body.items.find((i) => i.garment_id === "gar_jsk").x === 10.5 && r.body.items.find((i) => i.garment_id === "gar_blouse").x === null && r.body.layers.find((l) => l.garment_id === "gar_blouse").y === 14, r.body.items);
  check("舊版格式：圖層次序按 layer_order", r.body.layers.map((l) => l.garment_id).join() === "gar_blouse,gar_jsk");
  console.log("獨立圖層");
  const layers = [
    L("ly_shirt_back", "gar_blouse", { x: 20, y: 14 }),
    L("ly_jsk", "gar_jsk", { x: 12, y: 16, w: 76, h: 60 }),
    L("ly_shirt_front", "gar_blouse", { x: 30, y: 20, rotation: 15, flip_x: true, opacity: 0.8, mask: { v: 1, strokes: [{ mode: "hide", size: 0.2, pts: [0.5, 0.7, 0.5, 0.9] }] } }),
    { layer_id: "ly_apron", layer_type: "garment_part", garment_id: "gar_set", garment_part_id: "ast_apron", group_id: "gar_set", x: 30, y: 40, w: 40, h: 30 },
  ];
  r = await call("PATCH", "/api/outfits/out_old", { name: "新名稱", layers, base_updated_at: oldUpdated });
  check("同一衣物兩個獨立圖層（複製）可以保存", r.status === 200 && r.body.layers.length === 4 && r.body.layers.filter((l) => l.garment_id === "gar_blouse").length === 2, r.body);
  check("保存後次序（底→頂）、旋轉、翻轉、透明度、遮罩一致", r.body.layers.map((l) => l.layer_id).join() === "ly_shirt_back,ly_jsk,ly_shirt_front,ly_apron" && r.body.layers[2].rotation === 15 && r.body.layers[2].flip_x === true && r.body.layers[2].opacity === 0.8 && r.body.layers[2].mask.strokes[0].mode === "hide");
  check("套裝部件圖層：名稱及部件圖片", r.body.layers[3].name === "女僕套裝｜圍裙" && r.body.layers[3].group_id === "gar_set");
  const items = (await env.DB.prepare("SELECT garment_id FROM outfit_items WHERE outfit_id = 'out_old' ORDER BY position").all()).results.map((x) => x.garment_id);
  check("outfit_items 同步為不重複衣物清單（日誌／分析沿用）", items.join() === "gar_blouse,gar_jsk,gar_set", items);
  const listed = (await call("GET", "/api/outfits")).body.outfits.find((o) => o.id === "out_old");
  check("列表：衣物數目按不重複衣物計算，圖層數另列", listed.item_count === 3 && listed.layer_count === 4, listed);

  console.log("原子保存及衝突");
  const before = (await call("GET", "/api/outfits/out_old")).body;
  r = await call("PATCH", "/api/outfits/out_old", { name: "不應保存", layers: [...layers, L("ly_bad", "gar_nope")] });
  const after = (await call("GET", "/api/outfits/out_old")).body;
  check("有衣物不存在：整個保存被拒絕，名稱及圖層都沒有改變", r.status === 400 && after.name === "新名稱" && after.layers.length === 4 && after.updated_at === before.updated_at, [r.status, after.name]);
  r = await call("PATCH", "/api/outfits/out_old", { name: "舊版本覆寫", base_updated_at: oldUpdated });
  check("在另一處已修改：回覆 409，不覆寫", r.status === 409 && (await call("GET", "/api/outfits/out_old")).body.name === "新名稱");
  env.DB.failNextBatch = true;
  r = await call("PATCH", "/api/outfits/out_old", { name: "批次失敗", layers: layers.slice(0, 1) });
  const afterFail = (await call("GET", "/api/outfits/out_old")).body;
  check("D1 批次失敗：名稱及圖層都保持原狀（沒有部分更新）", r.status >= 500 && afterFail.name === "新名稱" && afterFail.layers.length === 4, [r.status, afterFail.name, afterFail.layers.length]);
  const many = Array.from({ length: 61 }, (_, i) => L("ly" + i, "gar_jsk"));
  r = await call("PATCH", "/api/outfits/out_old", { layers: many });
  check("圖層上限：明確錯誤訊息，不會無聲截斷", r.status === 400 && r.body.error.message.includes("最多 60 個圖層"), r.body);
  r = await call("PATCH", "/api/outfits/out_old", { layers: [L("dup", "gar_jsk"), L("dup", "gar_jsk")] });
  check("重複的圖層識別被拒絕", r.status === 400);

  console.log("背景");
  r = await call("PATCH", "/api/outfits/out_old", { background: { type: "stripes", color: "#141014", color2: "#3a2f1c", size: 24, gap: 24, angle: 90 } });
  check("條紋背景只保存設定（沒有寫入 R2）", r.status === 200 && r.body.background.type === "stripes" && (await env.IMAGES.list()).objects.filter((o) => o.key.startsWith("studio/")).length === 0);
  r = await call("PATCH", "/api/outfits/out_old", { background: { type: "image", image: { asset_id: "sta_nope", version_id: "stv_nope" } } });
  check("圖片背景引用不存在的素材被拒絕", r.status === 400);
  r = await call("PATCH", "/api/outfits/out_old", { background: null });
  check("背景可以還原為預設（null）", r.status === 200 && r.body.background === null);

  console.log("素材");
  const png = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from('<svg width="200" height="200"><circle cx="100" cy="100" r="60" fill="#d4a"/></svg>'), top: 0, left: 0 }]).png().toBuffer();
  const jpg = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#ffffff" } }).composite([{ input: Buffer.from('<svg width="300" height="200"><rect x="100" y="50" width="100" height="100" fill="#a35"/></svg>'), top: 0, left: 0 }]).jpeg().toBuffer();
  const upload = (buf, mime, kind, extra = {}) => { const f = new FormData(); f.set("file", new Blob([buf], { type: mime }), "x"); f.set("kind", kind); f.set("name", extra.name || "蝴蝶結"); if (extra.lib) f.set("in_library", "1"); return call("POST", "/api/studio/assets", f); };
  r = await upload(png, "image/png", "decoration", { lib: true });
  check("上傳透明 PNG 素材（保存到素材庫）", r.status === 201 && r.body.version.has_alpha === true && r.body.in_library === true, r.body);
  const bow = r.body;
  r = await upload(jpg, "image/jpeg", "prop", { name: "手袋" });
  check("上傳普通 JPG（只用於目前造型，不在素材庫）", r.status === 201 && r.body.in_library === false && r.body.version.has_alpha === false);
  const bag = r.body;
  check("素材庫只列出已保存到素材庫的素材", (await call("GET", "/api/studio/assets")).body.assets.map((a) => a.id).join() === bow.id);
  check("素材不會成為衣物（衣櫃件數不變）", (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n === 3);
  r = await upload(Buffer.from("<html>"), "text/html", "decoration");
  check("非圖片檔案被拒絕", r.status === 415 || r.status === 400, r.status);
  // 去背
  const cut = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < cut.data.length; i += 4) if (cut.data[i] > 240 && cut.data[i + 1] > 240) cut.data[i + 3] = 0;
  const cutPng = await sharp(cut.data, { raw: cut.info }).png().toBuffer();
  const cf = new FormData(); cf.set("file", new Blob([cutPng], { type: "image/png" }), "c.png");
  r = await call("POST", `/api/studio/versions/${bag.version.id}/cutout`, cf);
  check("加入去背圖：同一版本保留原圖及去背圖", r.status === 201 && r.body.version_id === bag.version.id && r.body.version.has_cutout === true, r.body);
  const orig = await call("GET", `/api/studio/versions/${bag.version.id}`), cutRes = await call("GET", `/api/studio/versions/${bag.version.id}?cutout=1`);
  check("可分別讀取原圖及去背圖", orig.raw.headers.get("content-type") === "image/jpeg" && cutRes.raw.headers.get("content-type") === "image/png");
  const opaque = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#fff" } }).png().toBuffer();
  const of = new FormData(); of.set("file", new Blob([opaque], { type: "image/png" }), "o.png");
  r = await call("POST", `/api/studio/versions/${bag.version.id}/cutout`, of);
  check("沒有透明通道的去背圖不會被標記成功", r.status === 400 && r.body.error.code === "not_transparent");
  // 素材圖層＋使用去背圖
  r = await call("PATCH", "/api/outfits/out_old", { layers: [...layers, { layer_id: "ly_bag", layer_type: "studio_asset", asset_id: bag.id, asset_version_id: bag.version.id, variant: "cutout", x: 60, y: 50, w: 30, h: 20 }, { layer_id: "ly_bow", layer_type: "studio_asset", asset_id: bow.id, asset_version_id: bow.version.id, x: 40, y: 5, w: 20, h: 15 }, { layer_id: "ly_bow2", layer_type: "studio_asset", asset_id: bow.id, asset_version_id: bow.version.id, x: 45, y: 8, w: 20, h: 15 }] });
  check("素材圖層（去背圖、同素材複製）", r.status === 200 && r.body.layers.find((l) => l.layer_id === "ly_bag").image_url.endsWith("?cutout=1") && r.body.layers.filter((l) => l.asset_id === bow.id).length === 2, r.body);
  const savedVersion = bow.version.id;
  // 重新去背 → 新版本，舊造型不變
  const bf = new FormData(); bf.set("file", new Blob([cutPng], { type: "image/png" }), "c.png");
  const bagCut2 = await call("POST", `/api/studio/versions/${bag.version.id}/cutout`, bf);
  check("已有去背圖時重新去背：建立新版本，舊造型仍用原版本", bagCut2.status === 201 && bagCut2.body.version_id !== bag.version.id && (await call("GET", "/api/outfits/out_old")).body.layers.find((l) => l.layer_id === "ly_bag").asset_version_id === bag.version.id);
  // 刪除引用中的素材
  r = await call("DELETE", `/api/studio/assets/${bow.id}`);
  check("刪除仍被造型使用的素材：只移出素材庫，保留檔案", r.status === 200 && r.body.deleted === false && r.body.used_by.length === 1 && (await call("GET", `/api/studio/versions/${savedVersion}`)).status === 200);
  check("移出後素材庫不再列出", (await call("GET", "/api/studio/assets")).body.assets.length === 0);
  const unused = (await upload(png, "image/png", "other", { lib: true, name: "沒有使用" })).body;
  const r2Before = (await env.IMAGES.list()).objects.filter((o) => o.key.startsWith("studio/")).length;
  r = await call("DELETE", `/api/studio/assets/${unused.id}`);
  check("沒有引用的素材：刪除紀錄及 R2 檔案", r.body.deleted === true && (await env.IMAGES.list()).objects.filter((o) => o.key.startsWith("studio/")).length === r2Before - 1);
  // 縮圖
  const thumb = (await sharp({ create: { width: 300, height: 400, channels: 3, background: "#f3dcd8" } }).webp().toBuffer()).toString("base64");
  r = await call("PATCH", "/api/outfits/out_old", { thumb });
  check("保存完整合成縮圖（D1）並提供版本網址", r.status === 200 && /\/api\/outfits\/out_old\/thumb\?v=/.test(r.body.thumb_url), r.body.thumb_url);
  const th = await call("GET", r.body.thumb_url);
  check("讀取縮圖", th.status === 200 && th.raw.headers.get("content-type") === "image/webp");
  const big = Buffer.alloc(200 * 1024, 1).toString("base64");
  check("縮圖太大被拒絕（不會部分保存）", (await call("PATCH", "/api/outfits/out_old", { name: "x", thumb: big })).status === 413 && (await call("GET", "/api/outfits/out_old")).body.name === "新名稱");
  // 日誌使用造型縮圖
  const de = (await call("POST", "/api/diary", { worn_date: "2026-11-11", kind: "worn", outfit_id: "out_old" })).body;
  check("日誌：來自衣服配搭的紀錄使用完整造型縮圖", typeof de.source_thumb === "string" && de.source_thumb.startsWith("/api/outfits/out_old/thumb?v="), de.source_thumb);
  check("日誌：由造型帶入不重複衣物（套裝部件不重複）", de.garment_count === 3, de.garment_count);
  // 另存為衣物
  r = await call("POST", `/api/studio/versions/${bag.version.id}/to-garment`, { name: "工作室手袋", category: "手袋", variant: "cutout" });
  const ng = r.body?.garment_id ? (await call("GET", `/api/garments/${r.body.garment_id}`)).body : null;
  check("只有明確選擇才另存為衣櫃衣物（含去背圖）", r.status === 201 && ng?.name === "工作室手袋" && (await env.DB.prepare("SELECT COUNT(*) AS n FROM garment_images WHERE garment_id = ? AND image_type = 'processed'").bind(r.body.garment_id).first()).n === 1, [r.status, ng?.name]);
  // 刪除造型 → 只用於該造型的素材一併清理
  r = await call("DELETE", "/api/outfits/out_old");
  const bagLeft = await env.DB.prepare("SELECT COUNT(*) AS n FROM studio_assets WHERE id = ?").bind(bag.id).first();
  const bowLeft = await env.DB.prepare("SELECT COUNT(*) AS n FROM studio_assets WHERE id = ?").bind(bow.id).first();
  check("刪除造型：只用於該造型的素材清理；沒有其他引用的素材亦清理", r.status === 200 && bagLeft.n === 0 && bowLeft.n === 0, [bagLeft, bowLeft]);
  check("API 需要登入", (await worker.fetch(new Request("http://localhost/api/studio/assets"), env)).status === 401);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  done();
}
