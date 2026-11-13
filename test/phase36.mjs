// Phase 3.6B/C：自訂身體模型、模型專屬衣物設定、造型版本及姿勢庫（本機模擬 D1／R2，不接觸正式服務）
// 執行：node test/phase36.mjs   （需要 esbuild、sharp）
import { createRequire } from "node:module";
import { FakeD1, makeEnv } from "./harness.mjs";
import { buildModule, buildWorker } from "./doll-build.mjs";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");
let passed = 0;
const failures = [];
const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"m"')) return; origLog(...a); };
function check(name, cond, info) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
const near = (a, b, e = 0.6) => Math.abs(a - b) <= e;
const M = await buildModule("shared/avatarModel.ts", "t36-model");
const F = await buildModule("shared/modelFit.ts", "t36-fit");
const V = await buildModule("shared/avatarV2.ts", "t36-v2");
const D = await buildModule("shared/doll.ts", "t36-doll");
const R = await buildModule("shared/avatarRig.ts", "t36-rig");
const rig = V.RIG_V2;

console.log("模型定義驗證");
{
  const empty = M.normalizeModelDef({});
  check("空定義＝V2 原樣", JSON.stringify(empty.parts) === "{}" && empty.head.s === 1);
  const throws = (v) => { try { M.normalizeModelDef(v); return false; } catch (e) { return e instanceof M.ModelError; } };
  check("拒絕不存在的部件", throws({ parts: { tail: { x: 0, y: 0, w: 10, h: 10 } } }));
  check("拒絕不存在的骨骼（不能自創父子關係，避免循環骨架）", throws({ bones: { extra: { pivot: [1, 1] } } }));
  check("拒絕頭髮骨骼（頭髮跟隨頭部對位）", throws({ bones: { hair_tail_r: { pivot: [1, 1] } } }));
  check("拒絕無效座標", throws({ bones: { elbow_r: { pivot: [NaN, 3] } } }) && throws({ parts: { hand_r: { x: 1e9, y: 0, w: 10, h: 10 } } }));
  check("拒絕外部網址", throws({ parts: { hand_r: { x: 1, y: 1, w: 10, h: 10, file: "https://evil.example/a.png" } } }) && throws({ parts: { hand_r: { x: 1, y: 1, w: 10, h: 10, file: "img:img_aaaaaaaa" } } }));
  check("拒絕錯誤活動範圍", throws({ bones: { elbow_r: { min: 20, max: 10 } } }));
  check("拒絕不完整的圖層次序", throws({ order: ["torso"] }));
  const ok = M.normalizeModelDef({ parts: { hand_r: { x: 1, y: 2, w: 30, h: 40, file: "file:dmf_abcdefgh", rot: 12, src: { w: 1200, h: 1800, crop: [10, 20, 40, 60] } } }, bones: { elbow_r: { pivot: [420, 660], min: -150, max: 70 } }, head: { dx: 3, dy: -4, s: 1.1 } });
  check("接受合法定義", ok.parts.hand_r.rot === 12 && ok.bones.elbow_r.max === 70 && ok.parts.hand_r.src.crop[3] === 60 && ok.head.s === 1.1);
}

console.log("由定義建立骨架");
{
  const def = M.normalizeModelDef({ bones: { shoulder_r: { min: -60, max: 130 } }, parts: { hand_r: { x: 200, y: 850, w: 140, h: 150, file: "file:dmf_abcdefgh" } }, head: { dx: 0, dy: -20, s: 1 } });
  const m = M.buildModel("dm_testtest", 3, def, "測試");
  const sh = m.rig.bones.find((b) => b.id === "shoulder_r");
  check("自訂活動範圍", sh.max_angle === 130 && sh.min_angle === -60);
  check("替換部件圖片及位置", m.rig.parts.hand_r.src === "file:dmf_abcdefgh" && M.partImage(m, m.rig.parts.hand_r) === "file:dmf_abcdefgh" && M.partImage(m, m.rig.parts.hand_l) === "/doll/avatar_v2/body/hand_l.png");
  check("頭髮骨骼跟隨頭部對位", near(m.rig.bones.find((b) => b.id === "hair_tail_r").pivot[1], rig.bones.find((b) => b.id === "hair_tail_r").pivot[1] - 20));
  check("不改動 V2 原骨架", rig.bones.find((b) => b.id === "shoulder_r").max_angle === 95 && rig.parts.hand_r.src === "body/hand_r.png");
  check("V2 模型 id 永遠回傳內置模型", M.buildModel("avatar_v2", 9, def) === M.DEFAULT_BODY_MODEL);
  const pose = R.clampPose(m.rig, { shoulder_r: 125 });
  check("姿勢按新身體的活動範圍限制", pose.shoulder_r === 125 && R.clampPose(rig, { shoulder_r: 125 }).shoulder_r === 95);
}

console.log("骨架編輯（靜止關節）");
{
  const base = M.buildModel("dm_testtest", 1, M.EMPTY_DEF);
  const elbow = rig.bones.find((b) => b.id === "elbow_r").pivot;
  const only = M.moveJoint(M.EMPTY_DEF, base.rig, "elbow_r", [elbow[0] - 10, elbow[1] + 20], false);
  check("只移動旋轉中心：部件不動", only.bones.elbow_r.pivot[1] === elbow[1] + 20 && !only.parts.lower_arm_r && !only.bones.wrist_r);
  const all = M.moveJoint(M.EMPTY_DEF, base.rig, "elbow_r", [elbow[0] - 10, elbow[1] + 20], true);
  check("連同下游：前臂、手掌、手腕及錨點一起移動", all.parts.lower_arm_r.y === rig.parts.lower_arm_r.y + 20 && all.parts.hand_r.y === rig.parts.hand_r.y + 20 && all.bones.wrist_r.pivot[1] === rig.bones.find((b) => b.id === "wrist_r").pivot[1] + 20 && all.anchors.elbow_r[1] === rig.anchors.elbow_r[1] + 20 && all.anchors.hand_r[1] === rig.anchors.hand_r[1] + 20);
  check("上一節（上臂）不動", !all.parts.upper_arm_r && !all.bones.shoulder_r);
  const built = M.buildModel("dm_testtest", 2, M.normalizeModelDef(all));
  const posed = R.solve(built.rig, { elbow_r: 30 });
  const w = R.applyMat(posed.wrist_r, ...built.rig.bones.find((b) => b.id === "wrist_r").pivot);
  check("新骨架下 FK 以新關節為中心轉動", Math.hypot(w[0] - (elbow[0] - 10), w[1] - (elbow[1] + 20)) > 100 && near(R.applyMat(posed.elbow_r, elbow[0] - 10, elbow[1] + 20)[0], elbow[0] - 10));
  const neck = M.moveJoint(M.EMPTY_DEF, base.rig, "neck", [600, 340], true);
  check("移動頸部連同下游：頭部對位一起平移", neck.head.dy === -12 && neck.anchors.head_top[1] === rig.anchors.head_top[1] - 12);
  const compact = M.compactDef(M.normalizeModelDef({ ...M.EMPTY_DEF, parts: { hand_r: { ...rig.parts.hand_r } }, bones: { elbow_r: { pivot: elbow } } }));
  check("與 V2 相同的設定不保存", !compact.parts.hand_r && !compact.bones.elbow_r);
}

console.log("頭部及頭髮對位");
{
  const f = { dx: 10, dy: -20, s: 1.2 };
  const head = M.adjustHead({ file: "/doll/x.png", x: 491, y: 36, w: 220, h: 272 }, f);
  check("頭部縮放及平移", near(head.w, 264) && near(head.x, 600 + (491 - 600) * 1.2 + 10));
  const hair = { parts: [{ id: "a", label: "a", file: "/doll/a.png", layer: "back", x: 500, y: 100, w: 100, h: 200, bone: "own", pivot: [550, 100], range: 20 }] };
  const adj = M.adjustHair(hair, f);
  check("頭髮跟隨（含自帶骨骼中心）", near(adj.parts[0].w, 120) && near(adj.parts[0].pivot[0], 600 + (550 - 600) * 1.2 + 10));
  const back = M.unadjustRect(adj.parts[0], f);
  check("畫面位置可換回原座標（保存時不會重複套用）", near(back.x, 500) && near(back.y, 100) && near(back.w, 100) && near(back.pivot[1], 100));
  check("沒有對位時原樣回傳", M.adjustHair(hair, M.NO_HEAD_FIT) === hair);
}

console.log("跨身體衣物換算");
{
  const content = { x0: 0.1, y0: 0.05, x1: 0.9, y1: 0.95, ar: 1.4 };
  const fit = { cx: 600, cy: 760, w: 520, rotation: 0, mesh: [1, 2] };
  const same = M.buildModel("dm_samesame", 1, M.EMPTY_DEF);
  check("相同身體：原樣保留（V2 副本不會被改動）", F.transferFit(fit, content, rig, same.rig) === fit);
  // 較高、較闊的身體：腰以下拉長 60px，肩膀闊 20px
  const def = M.normalizeModelDef({ anchors: Object.fromEntries(Object.entries(rig.anchors).map(([k, [x, y]]) => [k, [600 + (x - 600) * 1.1, y > 690 ? y + (y - 690) * 0.08 : y]])) });
  const tall = M.buildModel("dm_talltall", 1, def);
  const out = F.transferFit(fit, content, rig, tall.rig);
  check("闊度按身體比例", out.w > fit.w * 1.05 && out.w < fit.w * 1.15, out);
  check("網格是圖片相對值，原樣沿用", out.mesh === fit.mesh);
  const h0 = fit.w * content.ar, h1 = out.w * content.ar * (out.sy ?? 1);
  const top0 = fit.cy - h0 / 2 + content.y0 * h0, top1 = out.cy - h1 / 2 + content.y0 * h1;
  check("衣物上緣對到同一身體部位", near(top1, top0, 1.5), { top0, top1 });
  const tpl = D.normalizeTemplateData({ opts: { follow: "auto" }, mask: null, status: { place: "done" }, variants: { open: { name: "打開", fit } }, pieces: [{ id: "pc_abc", name: "袖套", slot: "accessory", box: [0, 0, 0.2, 0.2], fit: { cx: 300, cy: 900, w: 80, rotation: 0 }, status: { place: "done" } }] }, "dress");
  const conv = F.transferTemplateData(tpl, rig, tall.rig, content, "avatar_v2");
  check("換算後標記為初始建議，不帶已校正狀態", conv.converted && conv.converted_from === "avatar_v2" && !conv.status && !conv.pieces[0].status);
  check("穿法及部件位置一併換算", conv.variants.open.fit.w !== fit.w && conv.pieces[0].fit.cx !== 300);
  const again = D.normalizeTemplateData(conv, "dress");
  check("換算來源可以保存及讀回", again.converted_from === "avatar_v2" && again.converted);
}

console.log("造型記錄模型版本");
{
  const s = D.normalizeLookState({ model: { id: "dm_abcdefgh", rev: 4 }, items: [] });
  check("保存模型及版本", s.model.id === "dm_abcdefgh" && s.model.rev === 4);
  check("舊造型沒有模型資料（＝V2）", !D.normalizeLookState({ items: [] }).model);
  check("忽略無效的模型資料", !D.normalizeLookState({ model: { id: "../x", rev: 1 }, items: [] }).model && !D.normalizeLookState({ model: { id: "dm_abcdefgh", rev: 0 }, items: [] }).model);
  check("寬鬆驗證：自訂身體的較大活動範圍不會在衣物預設內被截短", D.normalizeOpts({ bind: { shoulder_r: 120 } }, "dress", M.LOOSE_RIG).bind.shoulder_r === 120 && D.normalizeOpts({ bind: { shoulder_r: 120 } }, "dress").bind.shoulder_r === 95 && D.normalizeLookState({ model: { id: "dm_abcdefgh", rev: 1 }, items: [{ garment_id: "g", opts: { bind: { shoulder_r: 120 } } }] }).items[0].opts.bind.shoulder_r === 120);
}

// ───── API ─────
const worker = await buildWorker("phase36-worker");
const ORIGIN = "https://ai-wardrobe.example.workers.dev";
const hex = async (u8) => Buffer.from(await crypto.subtle.digest("SHA-256", u8)).toString("hex");
const now = () => new Date().toISOString();

console.log("migration 0011：只新增，不影響現有資料");
{
  const db = new FakeD1();
  for (const f of ["0001_init", "0002_upload_slots", "0003_import_staging", "0004_ai_workflow", "0005_taxonomy_layout", "0006_price_settings", "0007_d1_thumbnails", "0008_doll_dressing", "0009_avatar_v2", "0010_doll_phase3"]) db.migrate(new URL(`../migrations/${f}.sql`, import.meta.url));
  db.sqlite.exec(`INSERT INTO garments (id,name,category,created_at,updated_at) VALUES ('gar_old','舊衣物','連身裙','t','t');
    INSERT INTO doll_fit_templates (garment_id,avatar_id,cx,cy,w,rotation,slot,data,created_at,updated_at) VALUES ('gar_old','avatar_v2',600,900,500,0,'dress','{"x":1}','t','t');
    INSERT INTO doll_looks (id,name,avatar_id,state,created_at,updated_at) VALUES ('look_old','舊造型','avatar_v2','{"v":3,"items":[]}','t','t');`);
  const before = JSON.stringify([db.sqlite.prepare("SELECT * FROM doll_fit_templates").all(), db.sqlite.prepare("SELECT * FROM doll_looks").all()]);
  db.migrate(new URL("../migrations/0011_doll_models.sql", import.meta.url));
  db.migrate(new URL("../migrations/0011_doll_models.sql", import.meta.url));
  const after = JSON.stringify([db.sqlite.prepare("SELECT * FROM doll_fit_templates").all(), db.sqlite.prepare("SELECT * FROM doll_looks").all()]);
  check("舊衣物設定及造型完全不變；可重複執行", before === after);
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  check("新增模型、版本、圖片及姿勢資料表", ["doll_models", "doll_model_revisions", "doll_model_files", "doll_poses"].every((t) => tables.includes(t)));
}

const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-PHASE36-1234")), now()).run();
const auth = await worker.fetch(new Request(ORIGIN + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-PHASE36-1234", username: "tester", password: "test-password-1234" }) }), env);
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
const png = async (w, h, alpha = true) => new Uint8Array(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 3}" ry="${h / 3}" fill="#e8b8a0"/></svg>`)).flatten(alpha ? false : { background: "#fff" }).png().toBuffer());
const bytes = await png(300, 400);
await env.IMAGES.put("garments/gar_a/p.png", bytes);
await env.DB.prepare("INSERT INTO garments (id,name,category,status,created_at,updated_at) VALUES ('gar_a','JSK','連身裙','active',?,?)").bind(now(), now()).run();
await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES ('img_aaaaaaaa','gar_a','processed','garments/gar_a/p.png','image/png',300,400,?,?,1,1,?)").bind(bytes.length, await hex(bytes), now()).run();
const fit = { cx: 600, cy: 760, w: 520, rotation: 0 };

console.log("身體模型 API");
let model;
{
  const v2 = await call("PUT", "/api/doll/templates/gar_a", { fit, slot: "dress", image_id: "img_aaaaaaaa", data: { opts: { follow: "auto" } } });
  check("V2 衣物設定照常保存", v2.status === 200 && v2.data.avatar_id === "avatar_v2");
  const created = await call("POST", "/api/doll/models", { name: "測試身體", from: "avatar_v2" });
  model = created.data;
  check("複製 Avatar V2 建立新身體（獨立 id，版本 1）", created.status === 201 && /^dm_/.test(model.id) && model.revision === 1 && JSON.stringify(model.def.parts) === "{}");
  const list = await call("GET", "/api/doll/models");
  check("列表列出新身體，預設仍是 V2", list.data.models.some((m) => m.id === model.id) && list.data.default_model === "avatar_v2");
  const up = await call("POST", `/api/doll/models/${model.id}/files?src_w=1200&src_h=1800&x0=200&y0=850&x1=340&y1=1000`, bytes, "image/png");
  check("上傳部件圖片（保存原始畫布尺寸及裁剪範圍）", up.status === 201 && up.data.ref.startsWith("file:dmf_"));
  const meta = JSON.parse((await env.DB.prepare("SELECT meta FROM doll_model_files WHERE id = ?").bind(up.data.id).first()).meta);
  check("裁剪資料已記錄", meta.src_w === 1200 && meta.crop[2] === 340);
  const noAlpha = await call("POST", `/api/doll/models/${model.id}/files`, await png(50, 50, false), "image/png");
  check("拒絕沒有透明背景的部件圖片", noAlpha.status === 400);
  const served = await call("GET", `/api/doll/files/${up.data.id}`);
  check("讀取部件圖片", served.status === 200 && served.data.byteLength === bytes.length);
  const def = { parts: { hand_r: { x: 200, y: 850, w: 140, h: 150, file: up.data.ref } }, bones: { shoulder_r: { min: -40, max: 120 } } };
  const saved = await call("PUT", `/api/doll/models/${model.id}/def`, { def, expected_revision: 1 });
  check("保存產生新版本", saved.status === 200 && saved.data.revision === 2 && saved.data.def.parts.hand_r.file === up.data.ref);
  const stale = await call("PUT", `/api/doll/models/${model.id}/def`, { def: {}, expected_revision: 1 });
  check("舊版本保存被拒絕（不覆蓋另一裝置的修改）", stale.status === 409);
  const r1 = await call("GET", `/api/doll/models/${model.id}/revisions/1`), r2 = await call("GET", `/api/doll/models/${model.id}/revisions/2`);
  check("舊版本不可變、仍可讀取", JSON.stringify(r1.data.def.parts) === "{}" && r2.data.def.parts.hand_r && (r1.headers.get("cache-control") || "").includes("immutable"));
  const badRef = await call("PUT", `/api/doll/models/${model.id}/def`, { def: { parts: { hand_r: { x: 1, y: 1, w: 9, h: 9, file: "file:dmf_zzzzzzzz" } } }, expected_revision: 2 });
  check("拒絕引用不存在的圖片", badRef.status === 400);
  const badBone = await call("PUT", `/api/doll/models/${model.id}/def`, { def: { bones: { tail: { pivot: [1, 2] } } }, expected_revision: 2 });
  check("拒絕不認識的骨骼", badBone.status === 400 && /骨骼/.test(badBone.data.error?.message ?? JSON.stringify(badBone.data)));
  const copy = await call("POST", "/api/doll/models", { from: model.id });
  check("複製自訂身體沿用其最新版本", copy.status === 201 && copy.data.def.parts.hand_r?.file === up.data.ref && copy.data.name.includes("副本"));
  const def2 = await call("PUT", "/api/doll/models/default", { id: model.id });
  check("設定預設模型", def2.status === 200 && (await call("GET", "/api/doll/models")).data.default_model === model.id);
  const thumb = await call("PUT", `/api/doll/models/${model.id}/thumb`, await png(60, 90), "image/png");
  check("模型縮圖存於 D1", thumb.status === 200 && (await call("GET", `/api/doll/models/${model.id}/thumb`)).status === 200);
}

console.log("模型專屬衣物設定");
{
  const none = await call("GET", `/api/doll/templates?avatar=${model.id}`);
  check("新身體未有自己的設定，只附 V2 設定作換算來源", none.data.templates.filter((t) => t.avatar_id === model.id).length === 0 && none.data.templates.some((t) => t.avatar_id === "avatar_v2"));
  const mine = await call("PUT", "/api/doll/templates/gar_a", { avatar_id: model.id, fit: { ...fit, w: 560 }, slot: "dress", image_id: "img_aaaaaaaa", data: { opts: { follow: "none", bone: "world" }, status: { place: "done" } } });
  check("為新身體保存獨立設定", mine.status === 200 && mine.data.avatar_id === model.id && mine.data.fit.w === 560);
  const v2 = await call("GET", "/api/doll/templates");
  const v2row = v2.data.templates.find((t) => t.garment_id === "gar_a" && t.avatar_id === "avatar_v2");
  check("Avatar V2 的設定沒有被覆蓋或搬走", v2row.fit.w === 520 && v2row.version === 1 && !v2.data.templates.some((t) => t.avatar_id === model.id));
  const conflict = await call("PUT", "/api/doll/templates/gar_a", { avatar_id: model.id, expected_version: 5, fit, slot: "dress", data: {} });
  check("模型設定同樣有版本衝突保護", conflict.status === 409);
  const bad = await call("PUT", "/api/doll/templates/gar_a", { avatar_id: "dm_notexist", fit, slot: "dress", data: {} });
  check("拒絕不存在的身體", bad.status === 400);
  const del = await call("DELETE", `/api/doll/templates/gar_a?avatar=${model.id}`);
  const after = await call("GET", "/api/doll/templates");
  check("恢復預設只刪除該身體的設定", del.data.deleted === 1 && after.data.templates.some((t) => t.garment_id === "gar_a" && t.avatar_id === "avatar_v2"));
}

console.log("造型保存模型版本");
{
  const look = await call("POST", "/api/doll/looks", { name: "新身體造型", state: { model: { id: model.id, rev: 2 }, items: [{ garment_id: "gar_a", slot: "dress", hidden: false, variant: null, fit: null, opts: null, mask: null }] } });
  check("造型記錄身體及版本", look.status === 201 && look.data.state.model.id === model.id && look.data.state.model.rev === 2);
  check("avatar_id 欄位＝模型 id", (await env.DB.prepare("SELECT avatar_id FROM doll_looks WHERE id = ?").bind(look.data.id).first()).avatar_id === model.id);
  const badRev = await call("POST", "/api/doll/looks", { name: "x", state: { model: { id: model.id, rev: 99 }, items: [] } });
  check("拒絕不存在的模型版本", badRev.status === 400);
  await call("PUT", `/api/doll/models/${model.id}/def`, { def: { bones: { shoulder_r: { min: -30, max: 100 } } }, expected_revision: 2 });
  const reread = await call("GET", `/api/doll/looks/${look.data.id}`);
  check("修改身體後，舊造型仍指向保存時的版本", reread.data.state.model.rev === 2);
  const v2look = await call("POST", "/api/doll/looks", { name: "V2", state: { items: [] } });
  check("沒有模型資料的造型＝Avatar V2", (await env.DB.prepare("SELECT avatar_id FROM doll_looks WHERE id = ?").bind(v2look.data.id).first()).avatar_id === "avatar_v2");
  const delUsed = await call("DELETE", `/api/doll/models/${model.id}`);
  check("有造型引用的身體不能刪除（請封存）", delUsed.status === 409);
  const arch = await call("PATCH", `/api/doll/models/${model.id}`, { status: "archived" });
  const list = await call("GET", "/api/doll/models");
  check("封存後不在一般列表，預設改回 V2；歷史版本仍可讀取", arch.data.status === "archived" && !list.data.models.some((m) => m.id === model.id) && list.data.default_model === "avatar_v2" && (await call("GET", `/api/doll/models/${model.id}/revisions/2`)).status === 200);
}

console.log("我的姿勢庫");
{
  const p = await call("POST", "/api/doll/poses", { name: "揮手", model_id: null, pose: { shoulder_r: 80, elbow_r: -40 }, front: ["hand_r"] });
  check("保存姿勢", p.status === 201 && p.data.pose.shoulder_r === 80 && p.data.front[0] === "hand_r");
  const u = await call("PATCH", `/api/doll/poses/${p.data.id}`, { name: "大力揮手" });
  check("重新命名", u.data.name === "大力揮手" && u.data.pose.elbow_r === -40);
  const bad = await call("POST", "/api/doll/poses", { name: "x", pose: { shoulder_r: "a" } });
  check("拒絕無效姿勢", bad.status === 400);
  const list = await call("GET", "/api/doll/poses");
  check("列出姿勢", list.data.poses.length === 1);
  check("刪除姿勢", (await call("DELETE", `/api/doll/poses/${p.data.id}`)).status === 200 && (await call("GET", "/api/doll/poses")).data.poses.length === 0);
}

console.log("未使用的身體可以刪除");
{
  const tmp = await call("POST", "/api/doll/models", { name: "臨時" });
  const up = await call("POST", `/api/doll/models/${tmp.data.id}/files`, bytes, "image/png");
  const keys = () => [...env.IMAGES.objects.keys()].filter((k) => k.startsWith(`doll/models/${tmp.data.id}/`));
  check("圖片已寫入 R2", up.status === 201 && keys().length === 1);
  const del = await call("DELETE", `/api/doll/models/${tmp.data.id}`);
  check("刪除身體連同圖片", del.status === 200 && keys().length === 0 && (await call("GET", `/api/doll/models/${tmp.data.id}`)).status === 404);
}

console.log(`\n${passed} 項通過，${failures.length} 項失敗`);
if (failures.length) process.exit(1);
