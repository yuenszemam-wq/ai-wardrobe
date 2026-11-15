// Phase 3.9A.2.1：穩定性修復 API 測試（圖片版本凍結、引用保護、CAS 同時保存、縮圖失效、冪等、去背並行、
// R2 清理佇列及重試、引用計數、刪除造型清理背景素材、孤兒掃描、分頁、合併衣物、未套用 0015 時的相容）。
// 執行：node test/phase39a21.mjs   （本機模擬 D1／R2）
import { makeEnv } from "./harness.mjs";
import { buildWorker } from "./doll-build.mjs";
import { addGarment, checker, hex, now, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const worker = await buildWorker("p3921-worker");
async function boot(opts = {}) {
  const env = makeEnv(opts);
  await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P3921-1234")), now()).run();
  const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P3921-1234", username: "tester", password: "test-password-1234" }) }), env);
  const cookie = auth.headers.get("set-cookie").split(";")[0];
  const call = async (method, path, body) => { const r = await worker.fetch(new Request("http://localhost" + path, { method, headers: { cookie, "x-requested-with": "ai-wardrobe", ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }), env); const ct = r.headers.get("content-type") || ""; return { status: r.status, body: ct.includes("json") ? await r.json().catch(() => null) : null, raw: r }; };
  return { env, call };
}
const SVG = '<rect x="200" y="200" width="500" height="800" fill="#7a3b5e"/>';
const L = (id, gid, extra = {}) => ({ layer_id: id, layer_type: "garment", garment_id: gid, x: 10, y: 10, w: 50, h: 60, ...extra });
const png = (color = "#d4a") => sharp({ create: { width: 120, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from(`<svg width="120" height="120"><circle cx="60" cy="60" r="40" fill="${color}"/></svg>`), top: 0, left: 0 }]).png().toBuffer();
const upload = async (call, buf, extra = {}) => { const f = new FormData(); f.set("file", new Blob([buf], { type: "image/png" }), "x.png"); f.set("kind", extra.kind || "decoration"); f.set("name", extra.name || "素材"); if (extra.lib) f.set("in_library", "1"); if (extra.op) f.set("op_id", extra.op); return call("POST", "/api/studio/assets", f); };
const addImage = async (env, gid, iid, color, created) => {
  const b = new Uint8Array(await png(color));
  await env.IMAGES.put(`garments/${gid}/${iid}.png`, b);
  await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES (?,?,'processed',?,?,120,120,?,?,1,0,?)").bind(iid, gid, `garments/${gid}/${iid}.png`, "image/png", b.length, await hex(b), created).run();
};

try {
  const { env, call } = await boot();
  for (const [id, name, cat] of [["gar_jsk", "紫色 JSK", "連身裙"], ["gar_blouse", "白色上衣", "上衣"], ["gar_dup", "重複 JSK", "連身裙"]]) await addGarment(env, { id, name, category: cat, subcategory: cat, svg: SVG, created: "2026-01-01T00:00:00.000Z" });

  console.log("衣物圖片版本凍結");
  let r = await call("POST", "/api/outfits", { name: "凍結測試", layers: [L("a", "gar_jsk"), L("b", "gar_blouse")] });
  const out = r.body;
  const firstImg = out.layers[0].image_id;
  check("保存時記錄當時的衣物圖片版本", r.status === 201 && !!firstImg && (await env.DB.prepare("SELECT image_id FROM outfit_layers WHERE outfit_id = ? AND layer_id = 'a'").bind(out.id).first()).image_id === firstImg, out.layers[0]);
  // 衣櫃為這件衣物加入較新的透明圖（會成為「目前透明圖」）
  await addImage(env, "gar_jsk", "img_newjsk", "#123", "2026-02-01T00:00:00.000Z");
  await env.DB.prepare("UPDATE garment_images SET is_primary = 0 WHERE garment_id = 'gar_jsk'").run();
  await env.DB.prepare("UPDATE garment_images SET is_primary = 1 WHERE id = 'img_newjsk'").run();
  r = await call("GET", `/api/outfits/${out.id}`);
  const la = r.body.layers.find((l) => l.layer_id === "a");
  check("衣櫃換圖後舊造型仍使用保存時的版本", la.image_id === firstImg && la.image_url === `/api/images/${firstImg}`, la);
  check("並提示有新圖片（latest_image_id／image_outdated）", la.latest_image_id === "img_newjsk" && la.image_outdated === true);
  r = await call("DELETE", `/api/images/${firstImg}`);
  check("被造型使用的圖片版本不能刪除（409）", r.status === 409 && r.body.error.code === "image_in_use" && r.body.error.message.includes("凍結測試"), r.body);
  // 明確更新：用戶端送出新的 image_id
  const upd = r = await call("PATCH", `/api/outfits/${out.id}`, { layers: [L("a", "gar_jsk", { image_id: "img_newjsk" }), L("b", "gar_blouse", { image_id: out.layers[1].image_id })], base_updated_at: out.updated_at });
  check("明確更新為新圖片", upd.status === 200 && r.body.layers[0].image_id === "img_newjsk" && r.body.layers[0].image_outdated === false, r.body.layers?.[0]);
  r = await call("PATCH", `/api/outfits/${out.id}`, { layers: [L("a", "gar_jsk", { image_id: "img_gardup" }), L("b", "gar_blouse")], base_updated_at: upd.body.updated_at });
  check("指定不屬於該衣物的圖片版本：改用該衣物目前的透明圖（不會串用其他衣物的圖片）", r.status === 200 && r.body.layers[0].image_id === "img_newjsk", r.body.layers?.[0]);
  let cur = r.body;
  r = await call("DELETE", `/api/images/${firstImg}`);
  check("不再被使用後可以刪除舊版本", r.status === 200, r.body);

  console.log("CAS 同時保存");
  // 模擬「檢查之後、提交之前」另一部裝置已保存：直接改 updated_at
  const base = cur.updated_at;
  await env.DB.prepare("UPDATE outfits SET updated_at = '2030-01-01T00:00:00.000Z', name = '另一部裝置' WHERE id = ?").bind(cur.id).run();
  r = await call("PATCH", `/api/outfits/${cur.id}`, { name: "舊版本", layers: [L("z", "gar_blouse")], base_updated_at: base });
  let after = (await call("GET", `/api/outfits/${cur.id}`)).body;
  check("版本不符：409，名稱及圖層都不變", r.status === 409 && after.name === "另一部裝置" && after.layers.length === 2, [r.status, after.name, after.layers.length]);
  // 真正的競態：讓 prepare 期間另一個請求先提交（以覆寫 batch 模擬）
  const realBatch = env.DB.batch.bind(env.DB);
  let raced = false;
  env.DB.batch = async (stmts) => { if (!raced) { raced = true; env.DB.sqlite.exec("UPDATE outfits SET updated_at = '2031-01-01T00:00:00.000Z', name = '先保存' WHERE id = '" + cur.id + "'"); } return realBatch(stmts); };
  r = await call("PATCH", `/api/outfits/${cur.id}`, { name: "後保存", layers: [L("z", "gar_blouse")], base_updated_at: after.updated_at });
  env.DB.batch = realBatch;
  after = (await call("GET", `/api/outfits/${cur.id}`)).body;
  check("檢查後才被另一處保存（競態）：交易回滾並回覆 409，不會覆蓋", r.status === 409 && after.name === "先保存" && after.layers.length === 2 && (await env.DB.prepare("SELECT COUNT(*) AS n FROM outfit_layers WHERE outfit_id = ?").bind(cur.id).first()).n === 2, [r.status, after.name, after.layers.length]);
  r = await call("PATCH", `/api/outfits/${cur.id}`, { name: "強制覆寫", layers: [L("z", "gar_blouse")] });
  check("沒有 base_updated_at（使用者選擇覆寫）：可以保存", r.status === 200 && r.body.name === "強制覆寫" && r.body.layers.length === 1);
  check("回應不包含內部 save_token", !("save_token" in r.body) && !("save_token" in ((await call("GET", "/api/outfits")).body.outfits[0])));

  console.log("縮圖失效");
  const tinyThumb = (await sharp({ create: { width: 30, height: 40, channels: 3, background: "#fff" } }).webp().toBuffer()).toString("base64");
  r = await call("PATCH", `/api/outfits/${cur.id}`, { layers: [L("z", "gar_blouse")], thumb: tinyThumb });
  check("保存縮圖", !!r.body.thumb_url);
  r = await call("PATCH", `/api/outfits/${cur.id}`, { layers: [L("z", "gar_blouse", { x: 30 })] });
  check("畫面改變但沒有新縮圖：舊縮圖移除（不顯示過時畫面）", r.status === 200 && r.body.thumb_url === null);
  r = await call("PATCH", `/api/outfits/${cur.id}`, { thumb: tinyThumb });
  r = await call("PATCH", `/api/outfits/${cur.id}`, { name: "只改名稱" });
  check("只改名稱：縮圖保留", !!r.body.thumb_url);

  console.log("冪等");
  r = await call("POST", "/api/outfits", { name: "重試", layers: [L("a", "gar_jsk")], op_id: "op_outfit_retry_1" });
  const r2 = await call("POST", "/api/outfits", { name: "重試", layers: [L("a", "gar_jsk")], op_id: "op_outfit_retry_1" });
  check("同一 op_id 重試建立造型：取回同一套，不重複", r.status === 201 && r2.body.id === r.body.id && (await env.DB.prepare("SELECT COUNT(*) AS n FROM outfits WHERE name = '重試'").first()).n === 1);
  const pa = await upload(call, await png(), { op: "op_asset_retry_1", lib: true, name: "重試素材" });
  const pb = await upload(call, await png(), { op: "op_asset_retry_1", lib: true, name: "重試素材" });
  check("同一 op_id 重試上傳素材：同一個素材，R2 只有一份", pa.status === 201 && pb.body.id === pa.body.id && (await env.DB.prepare("SELECT COUNT(*) AS n FROM studio_assets WHERE name = '重試素材'").first()).n === 1 && (await env.IMAGES.list()).objects.filter((o) => o.key.includes(pa.body.id)).length === 1);

  console.log("去背並行");
  const asset = (await upload(call, await png("#a35"), { lib: true, name: "並行" })).body;
  const cutBuf = await png("#fff");
  const cf = () => { const f = new FormData(); f.set("file", new Blob([cutBuf], { type: "image/png" }), "c.png"); return f; };
  const [c1, c2] = await Promise.all([call("POST", `/api/studio/versions/${asset.version.id}/cutout`, cf()), call("POST", `/api/studio/versions/${asset.version.id}/cutout`, cf())]);
  const vers = (await env.DB.prepare("SELECT id, cutout_key FROM studio_asset_versions WHERE asset_id = ?").bind(asset.id).all()).results;
  check("兩個去背同時完成：兩個結果都保留，檔案名稱不同，沒有互相覆蓋", c1.status === 201 && c2.status === 201 && vers.length === 2 && vers[0].cutout_key !== vers[1].cutout_key && vers.every((v) => env.IMAGES.objects.has(v.cutout_key)), vers);

  console.log("引用計數及清理");
  const bgA = (await upload(call, await png("#333"), { kind: "background", name: "背景只此造型" })).body;
  const o2 = (await call("POST", "/api/outfits", { name: "有背景", layers: [L("a", "gar_jsk")], background: { type: "image", image: { asset_id: bgA.id, version_id: bgA.version.id } } })).body;
  await call("PATCH", `/api/studio/assets/${bgA.id}`, { in_library: true });
  let list = (await call("GET", "/api/studio/assets")).body;
  check("素材庫使用次數包括背景引用", list.assets.find((a) => a.id === bgA.id).used_by === 1, list.assets.find((a) => a.id === bgA.id));
  await env.DB.prepare("INSERT INTO doll_looks (id, name, state, created_at, updated_at) VALUES ('look_x','角色造型',?,?,?)").bind(JSON.stringify({ background: { image: { asset_id: asset.id } } }), now(), now()).run().catch((e) => console.log("look insert", String(e)));
  list = (await call("GET", "/api/studio/assets")).body;
  check("素材庫使用次數包括角色造型", list.assets.find((a) => a.id === asset.id).used_by === 1, list.assets.find((a) => a.id === asset.id));
  await call("PATCH", `/api/studio/assets/${bgA.id}`, { in_library: false });
  const bgKey = (await env.DB.prepare("SELECT r2_key FROM studio_asset_versions WHERE asset_id = ?").bind(bgA.id).first()).r2_key;
  r = await call("DELETE", `/api/outfits/${o2.id}`);
  check("刪除造型：只用於該造型的背景圖素材一併清理（D1 及 R2）", r.status === 200 && !(await env.DB.prepare("SELECT id FROM studio_assets WHERE id = ?").bind(bgA.id).first()) && !env.IMAGES.objects.has(bgKey));

  const gone = (await upload(call, await png("#0a0"), { lib: true, name: "R2 失敗" })).body;
  const goneKey = (await env.DB.prepare("SELECT r2_key FROM studio_asset_versions WHERE asset_id = ?").bind(gone.id).first()).r2_key;
  env.IMAGES.failNextDelete = true;
  r = await call("DELETE", `/api/studio/assets/${gone.id}`);
  check("R2 刪除失敗：紀錄已刪除，檔案留在清理佇列（不會成為無紀錄的孤兒）", r.status === 200 && env.IMAGES.objects.has(goneKey) && !!(await env.DB.prepare("SELECT attempts FROM r2_purge_queue WHERE r2_key = ?").bind(goneKey).first()), r.body);
  r = await call("GET", "/api/maintenance/r2-purge");
  check("dry-run 只列出，不刪除", r.status === 200 && r.body.dry_run === true && r.body.deleted === 1 && env.IMAGES.objects.has(goneKey), r.body);
  r = await call("POST", "/api/maintenance/r2-purge");
  check("重試清理：刪除檔案並移出佇列", r.body.deleted === 1 && !env.IMAGES.objects.has(goneKey) && !(await env.DB.prepare("SELECT 1 FROM r2_purge_queue WHERE r2_key = ?").bind(goneKey).first()), r.body);
  // 佇列中的檔案再次被引用：只移出佇列，不刪除
  const keep = (await upload(call, await png("#00a"), { lib: true, name: "保留" })).body;
  const keepKey = (await env.DB.prepare("SELECT r2_key FROM studio_asset_versions WHERE asset_id = ?").bind(keep.id).first()).r2_key;
  await env.DB.prepare("INSERT INTO r2_purge_queue (r2_key, reason, queued_at, attempts) VALUES (?, 'test', ?, 0)").bind(keepKey, now()).run();
  r = await call("POST", "/api/maintenance/r2-purge");
  check("清理前再次核對引用：仍被使用的檔案保留", r.body.kept === 1 && env.IMAGES.objects.has(keepKey), r.body);

  console.log("孤兒掃描");
  await env.IMAGES.put("diary/dry_x/ph_x.jpg", new Uint8Array([1, 2, 3]));
  await env.DB.prepare("INSERT INTO diary_entries (id, worn_date, created_at, updated_at) VALUES ('dry_x','2026-11-01',?,?)").bind(now(), now()).run().catch((e) => console.log("diary insert", String(e)));
  await env.DB.prepare("INSERT INTO diary_photos (id, entry_id, r2_key, mime_type, width, height, file_size, sha256, created_at) VALUES ('ph_x','dry_x','diary/dry_x/ph_x.jpg','image/jpeg',1,1,3,'abc',?)").bind(now()).run().catch((e) => console.log("diary photo insert", String(e)));
  await env.IMAGES.put("studio/orphan/old.png", new Uint8Array([1]));
  for (const o of env.IMAGES.objects.values()) o.uploaded = new Date(Date.now() - 2 * 3600_000);
  r = await call("POST", "/api/maintenance/orphans", { delete: true });
  check("維護清理：日誌照片及工作室素材不會被當作孤兒刪除", env.IMAGES.objects.has("diary/dry_x/ph_x.jpg") && env.IMAGES.objects.has(keepKey), r.body);
  check("真正沒有紀錄的工作室檔案仍可清理", !env.IMAGES.objects.has("studio/orphan/old.png"), r.body);

  console.log("分頁");
  for (let i = 0; i < 5; i++) await env.DB.prepare("INSERT INTO outfits (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)").bind("out_page" + "abcde"[i], "分頁" + i, `2025-01-0${i + 1}T00:00:00.000Z`, now()).run();
  const p1 = (await call("GET", "/api/outfits?limit=3")).body;
  const p2 = (await call("GET", `/api/outfits?limit=3&cursor=${encodeURIComponent(p1.next_cursor)}`)).body;
  const allIds = (await call("GET", "/api/outfits")).body.outfits.map((o) => o.id);
  check("造型列表分頁：total、next_cursor，兩頁不重複且次序一致", p1.outfits.length === 3 && typeof p1.total === "number" && p1.total === allIds.length && [...p1.outfits, ...p2.outfits].map((o) => o.id).join() === allIds.slice(0, 6).join(), [p1.total, p1.next_cursor]);
  const a1 = (await call("GET", "/api/studio/assets?limit=2")).body;
  const a2 = (await call("GET", `/api/studio/assets?limit=2&cursor=${encodeURIComponent(a1.next_cursor)}`)).body;
  check("素材列表分頁", a1.assets.length === 2 && a1.total >= 3 && !!a1.next_cursor && !a2.assets.some((x) => a1.assets.some((y) => y.id === x.id)), [a1.total]);

  console.log("合併衣物");
  const o3 = (await call("POST", "/api/outfits", { name: "合併前", layers: [L("m", "gar_dup")] })).body;
  r = await call("POST", "/api/garments/gar_jsk/merge", { source_id: "gar_dup" });
  if (r.status === 404) r = await call("POST", `/api/garments/gar_jsk/merge`, { source: "gar_dup" });
  const o3b = (await call("GET", `/api/outfits/${o3.id}`)).body;
  check("合併衣物後，工作室圖層改指向合併後的衣物（不會變成已刪除）", [200, 201].includes(r.status) && o3b.layers[0].garment_id === "gar_jsk" && o3b.layers[0].missing === false, [r.status, r.body, o3b.layers[0]]);

  console.log("未套用 0015（新程式先部署）");
  const old = await boot({ withoutStability: true });
  await addGarment(old.env, { id: "gar_old", name: "舊", category: "上衣", subcategory: "上衣", svg: SVG });
  r = await old.call("POST", "/api/outfits", { name: "舊資料庫", layers: [L("a", "gar_old")], op_id: "op_old_db_1" });
  const o4 = r.body;
  r = await old.call("PATCH", `/api/outfits/${o4.id}`, { name: "改名", layers: [L("a", "gar_old")], base_updated_at: o4.updated_at });
  check("沒有新欄位時造型照常建立及保存（退回舊行為）", o4.layers?.length === 1 && r.status === 200 && r.body.name === "改名", [o4, r.body]);
  const oa = await upload(old.call, await png(), { lib: true, op: "op_old_asset_1" });
  check("沒有 client_ops 時素材照常上傳", oa.status === 201);
  r = await old.call("DELETE", `/api/studio/assets/${oa.body.id}`);
  check("沒有清理佇列時照常刪除素材", r.status === 200 && r.body.deleted === true);
  r = await old.call("GET", "/api/maintenance/r2-purge");
  check("沒有清理佇列時維護端點不會出錯", r.status === 200, r.body);

} catch (e) {
  console.error(e);
  check("未預期錯誤", false, String(e));
}
done();
