// Phase 3.8A.1：一次保存全部衣物設定（批量 API＋前端合併邏輯）及快捷工具作用範圍。
// 執行：node test/phase38a1.mjs   （需要 esbuild；本機模擬 D1／R2，不接觸正式服務）
import { makeEnv } from "./harness.mjs";
import { buildModule, buildWorker } from "./doll-build.mjs";

const worker = await buildWorker("p38a1-worker");
const B = await buildModule("src/doll/batchSave.ts", "p38a1-batch");
const ORIGIN = "https://ai-wardrobe.example.workers.dev";
let passed = 0;
const failures = [];
const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"m"')) return; origLog(...a); };
function check(name, cond, info) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 600) : ""); }
}
const hex = async (u8) => Buffer.from(await crypto.subtle.digest("SHA-256", u8)).toString("hex");
const now = () => new Date().toISOString();

const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P38A1-1234")), now()).run();
const auth = await worker.fetch(new Request(ORIGIN + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P38A1-1234", username: "tester", password: "test-password-1234" }) }), env);
const cookie = auth.headers.get("set-cookie").split(";")[0];
async function call(method, path, body) {
  const r = await worker.fetch(new Request(ORIGIN + path, { method, headers: { cookie, origin: ORIGIN, "x-requested-with": "ai-wardrobe", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: r.status, body: await r.json().catch(() => null) };
}
const t = now();
async function garment(id, name, category, imageId) {
  await env.DB.prepare("INSERT INTO garments (id,name,category,status,created_at,updated_at) VALUES (?,?,?, 'active', ?, ?)").bind(id, name, category, t, t).run();
  await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)").bind(imageId, id, "processed", `garments/${id}/p.png`, "image/png", 900, 1200, 10, "x".repeat(64), t).run();
}
await garment("gar_maid", "灰白格紋愛心圍裙女僕套裝", "套裝", "img_maidaaaa");
await garment("gar_blouse", "白色襯衫", "上衣", "img_blouseaa");
await garment("gar_old", "圖片已更新的衣物", "上衣", "img_oldnewaa");
const P = (id, name, slot, box, extra = {}) => ({ id, name, slot, box, ...extra });
const PIECES = [
  P("pc_body", "主體", "dress", [0.2, 0.25, 0.8, 0.95], { fit: { cx: 600, cy: 1000, w: 500, rotation: 0 } }),
  P("pc_head", "頭飾", "headwear", [0.3, 0, 0.7, 0.12], { fit: { cx: 600, cy: 260, w: 220, rotation: 0 } }),
  P("pc_legr", "右側腿部配件", "accessory", [0.05, 0.8, 0.2, 1]),
  P("pc_legl", "左側腿部配件", "accessory", [0.8, 0.8, 0.95, 1]),
  P("pc_slvr", "右袖套", "accessory", [0, 0.35, 0.12, 0.7], { fit: { cx: 380, cy: 900, w: 90, rotation: 0 }, opts: { follow: "none", neck: false, bone: "elbow_r", over_head: false } }),
  P("pc_slvl", "左袖套", "accessory", [0.88, 0.35, 1, 0.7], { fit: { cx: 820, cy: 900, w: 90, rotation: 0 }, opts: { follow: "none", neck: false, bone: "elbow_l", over_head: false } }),
];
const maidData = { opts: { follow: "auto", neck: true, bone: null, over_head: false }, mask: null, pose: null, front: [], variants: {}, pieces: PIECES };
await env.DB.prepare("INSERT INTO doll_fit_templates (garment_id,avatar_id,image_id,cx,cy,w,rotation,slot,data,version,created_at,updated_at) VALUES ('gar_maid','avatar_v2','img_maidaaaa',600,950,600,0,'set',?,1,?,?)").bind(JSON.stringify(maidData), t, t).run();
// 另一個身體模型的設定（不能被改動）及舊造型快照
await env.DB.prepare("INSERT INTO doll_fit_templates (garment_id,avatar_id,image_id,cx,cy,w,rotation,slot,data,version,created_at,updated_at) VALUES ('gar_maid','base_v1','img_maidaaaa',111,222,333,0,'set',NULL,4,?,?)").bind(t, t).run();
await env.DB.prepare("INSERT INTO doll_looks (id,name,avatar_id,created_at,updated_at,hair_color,pose,state) VALUES ('look_keep','舊造型','avatar_v2',?,?,'black','{}',?)").bind(t, t, JSON.stringify({ v: 3, items: [{ garment_id: "gar_maid", piece: "pc_head", snapshot: true, fit: { cx: 1, cy: 2, w: 300, rotation: 0 } }] })).run();
const lookBefore = (await env.DB.prepare("SELECT state FROM doll_looks WHERE id='look_keep'").first()).state;
const v1Before = JSON.stringify(await env.DB.prepare("SELECT * FROM doll_fit_templates WHERE avatar_id='base_v1'").first());
const tpl = async (gid, avatar = "avatar_v2") => { const r = await env.DB.prepare("SELECT * FROM doll_fit_templates WHERE garment_id=? AND avatar_id=?").bind(gid, avatar).first(); return r ? { ...r, data: JSON.parse(r.data) } : null; };

console.log("前端合併：同一套裝的 6 個部件合併成一筆，不會互相覆蓋");
const template = { garment_id: "gar_maid", avatar_id: "avatar_v2", image_id: "img_maidaaaa", fit: { cx: 600, cy: 950, w: 600, rotation: 0 }, slot: "set", data: maidData, version: 1 };
const G = { id: "gar_maid", name: "灰白格紋愛心圍裙女僕套裝", category: "套裝", subcategory: null, transparent_image_id: "img_maidaaaa" };
const content = { approximate: false, ar: 0.75 };
const optsBody = { follow: "none", neck: false, bone: "head", over_head: false };
const R = (pc, fit, opts, extra = {}) => ({ key: "gar_maid#" + pc.id, worn: { garment_id: "gar_maid", piece: pc.id, slot: pc.slot, hidden: false, variant: null, fit: null, opts: null, mask: null, ...extra.worn }, garment: G, piece: pc, image: "piece:" + pc.id, base: pc.fit ?? fit, fit, opts, mask: extra.mask ?? null, parts: null, analysis: { content }, from: "override", template });
const rs = [
  R(PIECES[0], { cx: 610, cy: 1000, w: 500, rotation: 0 }, { follow: "auto", neck: true, bone: null, over_head: false }),
  R(PIECES[1], { cx: 600, cy: 240, w: 230, rotation: 4 }, optsBody, { mask: "data:image/png;base64,AAAA" }),
  R(PIECES[2], { cx: 400, cy: 1650, w: 120, rotation: 0 }, { follow: "none", neck: false, bone: "ankle_r", over_head: false }),
  R(PIECES[3], { cx: 800, cy: 1650, w: 120, rotation: 0 }, { follow: "none", neck: false, bone: "ankle_l", over_head: false }),
  R(PIECES[4], PIECES[4].fit, PIECES[4].opts),
  R(PIECES[5], PIECES[5].fit, PIECES[5].opts),
];
const worn = rs.map((r) => r.worn);
const entries = B.entriesFor(rs, worn, { imageOf: () => "img_maidaaaa" });
const st = Object.fromEntries(entries.map((e) => [e.pieceId, e.state]));
check("狀態：主體／頭飾已修改、左右腿部配件未校正、袖套已保存", st.pc_body === "modified" && st.pc_head === "modified" && st.pc_legr === "uncalibrated" && st.pc_legl === "uncalibrated" && st.pc_slvr === "saved" && st.pc_slvl === "saved", st);
check("預設勾選：有修改或未校正（4 項）", entries.filter((e) => e.defaultOn).length === 4);
check("已有預設的項目標示會覆寫", entries.find((e) => e.pieceId === "pc_body").overwrite && !entries.find((e) => e.pieceId === "pc_legr").overwrite);
const sum = B.summarize(entries);
check("圖層摘要數字", sum.worn === 6 && sum.modified === 2 && sum.uncalibrated === 2 && sum.saved === 2, sum);
const ctx = (layouts = new Set()) => ({ avatarId: "avatar_v2", pose: { shoulder_l: -20 }, front: [], versionOf: (gid, r) => r.template?.version ?? 0, statusOf: (p) => ({ ...p, place: "done" }), layouts, worn, now: "2026-11-14T00:00:00.000Z" });
const payloads = B.buildPayloads(entries, ctx(new Set(["gar_maid"])));
check("6 個部件合併為一筆（同一 garment_id）", payloads.length === 1 && payloads[0].keys.length === 6 && payloads[0].expected_version === 1, payloads.map((p) => [p.garment_id, p.keys.length]));
const pd = payloads[0].data.pieces;
check("每個部件各自的位置／遮罩／骨架", pd.find((p) => p.id === "pc_head").fit.rotation === 4 && pd.find((p) => p.id === "pc_head").wear_mask === "data:image/png;base64,AAAA" && pd.find((p) => p.id === "pc_legr").opts.bone === "ankle_r" && pd.find((p) => p.id === "pc_legl").opts.bone === "ankle_l" && pd.find((p) => p.id === "pc_slvr").opts.bone === "elbow_r");
check("整套配置：只記錄套裝內部件的相對次序", JSON.stringify(payloads[0].data.set_layout.order) === JSON.stringify(PIECES.map((p) => p.id)) && payloads[0].data.set_layout.avatar === "avatar_v2");
check("只保存部件時，整件套裝的位置不變", JSON.stringify(payloads[0].fit) === JSON.stringify(template.fit));
const partial = B.buildPayloads(entries.filter((e) => e.pieceId === "pc_head"), ctx());
check("只勾選頭飾：其他部件保持原本預設", partial[0].data.pieces.find((p) => p.id === "pc_body").fit.cx === 600 && partial[0].data.pieces.find((p) => p.id === "pc_head").fit.cx === 600 && partial[0].data.pieces.find((p) => p.id === "pc_head").fit.cy === 240 && !partial[0].data.set_layout);
// 兩個相同部件實例、隱藏、舊圖片、部件已刪除
const dup = B.entriesFor([rs[1], { ...rs[1] }], [rs[1].worn, rs[1].worn], { imageOf: () => "img_maidaaaa" });
check("同一部件多個實例：不能默默保存，需要選擇", dup.every((e) => e.state === "blocked" && /多個/.test(e.reason)));
const hidden = B.entriesFor([{ ...rs[2], worn: { ...rs[2].worn, hidden: true } }], [], { imageOf: () => "img_maidaaaa" });
check("隱藏的部件標示，預設不勾選", hidden[0].state === "hidden" && !hidden[0].defaultOn);
const stale = B.entriesFor([{ ...rs[0], worn: { ...rs[0].worn, snapshot: true, image: "img:img_older" } }], [], { imageOf: () => "img_maidaaaa" });
check("使用舊圖片的快照不能存為預設", stale[0].state === "blocked");
const gone = B.entriesFor([{ ...rs[0], piece: { ...PIECES[0], id: "pc_gone" }, key: "gar_maid#pc_gone" }], [], { imageOf: () => "img_maidaaaa" });
check("部件已變更或刪除：不能保存", gone[0].state === "blocked" && /部件/.test(gone[0].reason));
check("整套配置排序：layoutOrder 按配置次序", JSON.stringify(B.layoutOrder(PIECES, { order: ["pc_head", "pc_body"], worn: ["pc_head", "pc_body"] })) === '["pc_head","pc_body"]' && B.layoutOrder(PIECES, undefined).length === 6);

console.log("快捷工具：作用範圍及混合狀態");
const blouse = { key: "gar_blouse", worn: { garment_id: "gar_blouse", slot: "top", hidden: false }, garment: { id: "gar_blouse" }, piece: null, image: "x", opts: { follow: "auto", bone: null } };
const skirt = { key: "gar_sk", worn: { garment_id: "gar_sk", slot: "skirt", hidden: false }, garment: { id: "gar_sk" }, piece: null, image: "x", opts: { follow: "none", bone: "world" } };
const all = [...rs, blouse, skirt];
check("目前衣物：只有選中的一件", B.scopeTargets(all, "item", rs[1]).length === 1);
check("目前套裝：同一套裝 6 個部件", B.scopeTargets(all, "set", rs[1]).length === 6 && B.unitOf(B.scopeTargets(all, "set", rs[1])) === "個部件");
check("沒有選中時「目前衣物」不會作用於任何衣物", B.scopeTargets(all, "item", null).length === 0);
check("各件設定不同：顯示混合設定", B.scopeMode(B.scopeTargets(all, "set", rs[1])) === "mixed" && B.scopeMode([rs[4], rs[5]]) === "body");
// Phase 3.8A.2：袖套等附接手臂骨骼的部件也適用「跟隨手臂」（按手臂骨骼移動）；半裙、頭飾、腿部配件仍然不計
check("跟隨手臂：有袖衣物＋袖套；半裙、頭飾、腿部配件不計", B.scopeTargets(all, "all", null, "auto").map((r) => r.key).sort().join() === ["gar_blouse", "gar_maid#pc_body", "gar_maid#pc_slvr", "gar_maid#pc_slvl"].sort().join(), B.scopeTargets(all, "all", null, "auto").map((r) => r.key));
check("袖套切換為跟隨身體時保留附接骨骼", B.bodyBoneFor({ ...rs[4], opts: { ...rs[4].opts, bone: "world" } }, () => "world") === "elbow_r" && B.bodyBoneFor(rs[2], () => "world") === "ankle_r" && B.bodyBoneFor(blouse, () => "x") === null);

console.log("批量 API：驗證後以單一交易寫入");
const items = payloads.map(({ keys, ...p }) => p);
const blousePayload = { garment_id: "gar_blouse", avatar_id: "avatar_v2", fit: { cx: 600, cy: 800, w: 520, rotation: 0 }, slot: "top", image_id: "img_blouseaa", expected_version: 0, data: { opts: { follow: "auto", neck: true, bone: null, over_head: false }, mask: null, pose: null, front: [], variants: {} } };
let res = await call("POST", "/api/doll/templates/batch", { avatar_id: "avatar_v2", items: [...items, blousePayload] });
check("一次保存套裝及另一件衣物", res.status === 200 && res.body.saved.length === 2 && res.body.failed.length === 0, res.body);
const m1 = await tpl("gar_maid");
check("套裝版本＋1，6 個部件全部保存", m1.version === 2 && m1.data.pieces.length === 6 && m1.data.pieces.find((p) => p.id === "pc_legr").fit.cy === 1650 && m1.data.pieces.find((p) => p.id === "pc_head").wear_mask === "data:image/png;base64,AAAA");
check("整套穿著配置已保存", m1.data.set_layout?.order.length === 6 && m1.data.set_layout.worn.length === 6, m1.data.set_layout);
check("其他身體模型的設定不變", JSON.stringify(await env.DB.prepare("SELECT * FROM doll_fit_templates WHERE avatar_id='base_v1'").first()) === v1Before);
check("舊造型快照不變", (await env.DB.prepare("SELECT state FROM doll_looks WHERE id='look_keep'").first()).state === lookBefore);
check("衣物圖片及衣物記錄不變", (await env.DB.prepare("SELECT COUNT(*) AS n FROM garment_images").first()).n === 3);

// 版本衝突：使用開始編輯時的版本（1），伺服器已是 2 → 不覆寫；另一件照常保存（部分成功）
res = await call("POST", "/api/doll/templates/batch", { avatar_id: "avatar_v2", items: [{ ...items[0], data: { ...items[0].data, pieces: PIECES } }, { ...blousePayload, expected_version: 1, fit: { ...blousePayload.fit, cx: 640 } }] });
check("版本衝突的項目逐件回報，其他照常保存", res.status === 200 && res.body.saved.length === 1 && res.body.failed.length === 1 && res.body.failed[0].garment_id === "gar_maid" && res.body.failed[0].code === "template_conflict", res.body);
check("衝突時沒有覆寫套裝", (await tpl("gar_maid")).version === 2 && (await tpl("gar_maid")).data.pieces.find((p) => p.id === "pc_legr").fit.cy === 1650);
check("另一件已保存（版本 2）", (await tpl("gar_blouse")).version === 2 && (await tpl("gar_blouse")).cx === 640);

// 衣物已刪除、圖片已更新、同一衣物重複
res = await call("POST", "/api/doll/templates/batch", { avatar_id: "avatar_v2", items: [{ ...blousePayload, garment_id: "gar_missing" }, { ...blousePayload, garment_id: "gar_old", image_id: "img_previous", expected_version: 0 }, { ...blousePayload, expected_version: 2 }, { ...blousePayload, expected_version: 2 }] });
const codes = Object.fromEntries(res.body.failed.map((f) => [f.garment_id + ":" + f.code, 1]));
check("衣物已刪除／圖片已更新／重複項目各自回報", codes["gar_missing:garment_not_found"] && codes["gar_old:image_changed"] && codes["gar_blouse:duplicate_item"] && res.body.saved.length === 1, res.body.failed);

// 交易失敗（例如期間另一裝置保存）：整批還原，沒有任何一件被寫入，全部可以重試
const v0 = (await tpl("gar_blouse")).version;
env.DB.failNextBatch = true;
res = await call("POST", "/api/doll/templates/batch", { avatar_id: "avatar_v2", items: [{ ...blousePayload, expected_version: v0 }] });
check("交易失敗：全部回報為可重試，不會假稱成功", res.status === 200 && res.body.saved.length === 0 && res.body.failed.length === 1 && (await tpl("gar_blouse")).version === v0, res.body);
res = await call("POST", "/api/doll/templates/batch", { avatar_id: "avatar_v2", items: [{ ...blousePayload, expected_version: v0 }] });
check("只重試失敗項目：成功", res.body.saved.length === 1 && (await tpl("gar_blouse")).version === v0 + 1);

// 交易內版本保護（模擬預先核對之後、寫入之前另一裝置保存）
{
  const realBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (stmts) => { await env.DB.prepare("UPDATE doll_fit_templates SET version = version + 1 WHERE garment_id='gar_blouse' AND avatar_id='avatar_v2'").run(); env.DB.batch = realBatch; return realBatch(stmts); };
  const v = (await tpl("gar_blouse")).version;
  res = await call("POST", "/api/doll/templates/batch", { avatar_id: "avatar_v2", items: [{ ...blousePayload, expected_version: v, fit: { ...blousePayload.fit, cx: 700 } }] });
  check("交易內再次核對版本：期間被更新時整批還原，不覆寫", res.body.saved.length === 0 && res.body.failed[0]?.code === "template_conflict" && (await tpl("gar_blouse")).cx !== 700, res.body);
}
// 未登入不能批量保存；舊式單件保存仍然可用
const anon = await worker.fetch(new Request(ORIGIN + "/api/doll/templates/batch", { method: "POST", headers: { origin: ORIGIN, "x-requested-with": "ai-wardrobe", "content-type": "application/json" }, body: JSON.stringify({ items: [] }) }), env);
check("未登入不能批量保存", anon.status === 401 || anon.status === 403, anon.status);
const single = await call("PUT", "/api/doll/templates/gar_old", { avatar_id: "avatar_v2", fit: { cx: 600, cy: 800, w: 500, rotation: 0 }, slot: "top", image_id: "img_oldnewaa", expected_version: 0, data: {} });
check("單件「存為衣物預設」照常使用", single.status === 200 && single.body.version === 1);
check("沒有項目時回報錯誤", (await call("POST", "/api/doll/templates/batch", { avatar_id: "avatar_v2", items: [] })).status === 400);

console.log(`\n${passed} 項通過，${failures.length} 項失敗`);
if (failures.length) { console.log("失敗：", failures.join("、")); process.exitCode = 1; }
