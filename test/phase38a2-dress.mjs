// Phase 3.8A.2：畫布浮動快捷（還原衣物姿勢、保存衣服設定、跟隨手臂）瀏覽器測試。
// 執行：node test/phase38a2-dress.mjs   （iPhone 13 尺寸＋觸控模擬；桌面 Chromium，不等於 iPhone Safari／PWA 實機驗收）
import { join } from "node:path";
import { startApp, addGarment, roomHelpers, checker } from "./p38-setup.mjs";
import { buildModule } from "./doll-build.mjs";

const { check, done } = checker();
const B = await buildModule("src/doll/batchSave.ts", "p38a2-batch");

console.log("純邏輯：跟隨手臂適用判斷、保存姿勢來源");
const base = { worn: { slot: "top", variant: null }, piece: null, opts: { follow: "none", bone: "world" } };
check("長袖／泡袖上衣：適用（袖子變形）", B.armInfo({ ...base, garment: { name: "藕粉泡袖上衣", subcategory: "襯衫" } }).kind === "sleeve");
check("JSK（連身裙圖層）：無袖，不適用並說明原因", !B.armInfo({ ...base, worn: { slot: "dress" }, garment: { name: "紫色菱格人偶 JSK", subcategory: "JSK" } }).ok && /無袖/.test(B.armInfo({ ...base, worn: { slot: "dress" }, garment: { name: "紫色菱格人偶 JSK", subcategory: "JSK" } }).reason));
check("背心：不適用", !B.armInfo({ ...base, garment: { name: "白色背心" } }).ok);
check("半裙：不適用", !B.armInfo({ ...base, worn: { slot: "skirt" }, garment: { name: "格紋半裙" } }).ok);
check("已手動校正（有基準姿勢）的 JSK：保留適用", B.armInfo({ ...base, worn: { slot: "dress" }, opts: { follow: "auto", bone: null, bind: { shoulder_r: 10 } }, garment: { name: "JSK" } }).ok);
check("舊預設自動跟隨的 JSK：仍然判斷為無袖", !B.armInfo({ ...base, worn: { slot: "dress" }, opts: { follow: "auto", bone: null }, garment: { name: "紫色菱格人偶 JSK" } }).ok);
const sleevePiece = (name, opts = {}, box) => ({ worn: { slot: "set" }, opts: { follow: "none", bone: "world", ...opts }, piece: { id: "p", name, slot: "accessory", box } });
check("袖套部件：附接相應手臂（右袖套→右前臂）", B.armInfo(sleevePiece("右袖套")).kind === "arm-piece" && B.armInfo(sleevePiece("右袖套")).bone === "elbow_r");
check("手套：附接手腕；沒有左右字眼時按位置判斷（畫面右＝左手）", B.armInfo(sleevePiece("蕾絲手套", {}, [0.8, 0.4, 0.95, 0.6])).bone === "wrist_l");
check("已附接手肘的部件：沿用原骨骼", B.armInfo(sleevePiece("裝飾", { bone: "elbow_l" })).bone === "elbow_l");
check("頭飾部件：不適用", !B.armInfo({ ...sleevePiece("頭飾"), piece: { id: "h", name: "頭飾", slot: "headwear" } }).ok);
const P1 = { shoulder_r: 30 }, P2 = { shoulder_l: -20 }, P3 = { elbow_r: -40 }, P4 = { head: 4 };
const tpl = { data: { pose: P1, front: ["hand_r"], variants: { v1: { pose: P2 } }, pieces: [{ id: "pc", pose: P3 }], set_layout: { order: [], worn: [], pose: P4 } } };
check("保存姿勢來源：單件衣物＝template.data.pose（含手部前後）", B.savedPoseFor({ worn: { variant: null }, piece: null, template: tpl }).pose === P1 && B.savedPoseFor({ worn: {}, piece: null, template: tpl }).front[0] === "hand_r");
check("穿法版本＝variant.pose", B.savedPoseFor({ worn: { variant: "v1" }, piece: null, template: tpl }).pose === P2);
check("套裝部件＝piece.pose", B.savedPoseFor({ worn: {}, piece: { id: "pc" }, template: tpl }).pose === P3);
check("部件沒有姿勢＝整套 set_layout.pose", B.savedPoseFor({ worn: {}, piece: { id: "other" }, template: tpl }).pose === P4);
check("沒有保存姿勢＝null（提示尚未設定）", B.savedPoseFor({ worn: {}, piece: null, template: { data: { pose: null, variants: {} } } }) === null);

const A = await startApp("p38a2d");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38a2-dress-${n}.png`) });
const H = roomHelpers(page);
// 泡袖上衣：衣身＋左右泡袖（畫面座標 900×1200）
const BLOUSE = '<path d="M330 200 L570 200 L600 1150 L300 1150 Z" fill="#f6f2f2"/><ellipse cx="200" cy="330" rx="150" ry="130" fill="#e9d9df"/><ellipse cx="700" cy="330" rx="150" ry="130" fill="#e9d9df"/><rect x="380" y="200" width="140" height="70" fill="#1d1d1d"/>';
const JSK = '<path d="M360 80 L540 80 L740 1180 L160 1180 Z" fill="#7b5c9e"/><rect x="380" y="60" width="30" height="120" fill="#5a3d7a"/><rect x="490" y="60" width="30" height="120" fill="#5a3d7a"/>';
const SET = '<path d="M330 330 L570 330 L700 1000 L200 1000 Z" fill="#9c9aa3"/><rect x="40" y="420" width="90" height="380" rx="30" fill="#2b2b2b"/><rect x="770" y="420" width="90" height="380" rx="30" fill="#2b2b2b"/>';
await addGarment(env, { id: "gar_blouse", name: "白色黑蕾絲娃娃領泡袖上衣", category: "上衣", subcategory: "襯衫", svg: BLOUSE });
await addGarment(env, { id: "gar_jsk", name: "紫色菱格人偶 JSK", category: "連身裙", subcategory: "JSK", svg: JSK });
await addGarment(env, { id: "gar_maid", name: "黑紅格紋珍珠蝴蝶結女僕套裝", category: "套裝", subcategory: "多件套", svg: SET });
const img = async (g) => (await env.DB.prepare("SELECT id FROM garment_images WHERE garment_id=?").bind(g).first()).id;
const t0 = new Date().toISOString();
const PIECES = [
  { id: "pc_body", name: "主體", slot: "dress", box: [0.21, 0.26, 0.79, 0.85], fit: { cx: 600, cy: 980, w: 520, rotation: 0 } },
  { id: "pc_slvr", name: "右袖套", slot: "accessory", box: [0.03, 0.34, 0.16, 0.68], fit: { cx: 395, cy: 900, w: 80, rotation: 0 }, opts: { follow: "none", neck: false, bone: "world", over_head: false } },
];
await env.DB.prepare("INSERT INTO doll_fit_templates (garment_id,avatar_id,image_id,cx,cy,w,rotation,slot,data,version,created_at,updated_at) VALUES ('gar_maid','avatar_v2',?,600,950,620,0,'set',?,1,?,?)").bind(await img("gar_maid"), JSON.stringify({ opts: { follow: "none", neck: true, bone: "world", over_head: false }, mask: null, pose: null, front: [], variants: {}, pieces: PIECES }), t0, t0).run();
const template = async (g) => { const r = await env.DB.prepare("SELECT version, data FROM doll_fit_templates WHERE garment_id=? AND avatar_id='avatar_v2'").bind(g).first(); return r && { version: r.version, data: JSON.parse(r.data) }; };
const fits = async () => Object.fromEntries(JSON.parse(await H.room("data-fits")).map((f) => [f[0], f.slice(1)]));
const pose = async () => JSON.parse(await H.room("data-pose"));
const toasts = () => page.evaluate(() => window.__toasts.splice(0));
/** 整個畫布的像素差異（不同的像素比例） */
const snapCanvas = () => page.evaluate(() => { const c = document.querySelector('[data-testid="doll-canvas"]'); return Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data); });
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 60) n++; return n / (a.length / 4); };
const MESH = Array(32).fill(0); MESH[10] = 0.03; MESH[11] = 0.02;
const POSE0 = { shoulder_r: 36, elbow_r: -50, shoulder_l: -28 };

try {
  await page.goto(A.base + "/");
  const mk = async (name, items, p = POSE0) => (await page.evaluate(async ([name, items, p]) => (await (await fetch("/api/doll/looks", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ai-wardrobe" }, body: JSON.stringify({ name, state: { v: 3, head: "builtin:head_v2", hair: "builtin:twin_tails_long", hair_color: "brown_pink", accent_color: null, tip_color: null, pose: p, front: [], items } }) })).json()).id, [name, items, p]));
  const item = (gid, slot, extra = {}) => ({ garment_id: gid, slot, hidden: false, variant: null, fit: null, opts: null, mask: null, ...extra });
  const FIXED = { follow: "none", neck: true, bone: "world", over_head: false };
  const lookA = await mk("上衣", [item("gar_blouse", "top", { opts: FIXED }), item("gar_jsk", "dress")]);
  await page.goto(A.base + "/dressing/" + lookA);
  await H.ready();
  await page.evaluate(() => { window.__toasts = []; window.addEventListener("aw:toast", (e) => window.__toasts.push(e.detail)); });

  console.log("位置及大小");
  const bar = await page.locator('[data-testid="quick-bar"]').boundingBox(), stage = await page.locator('[data-testid="doll-stage"]').boundingBox();
  check("快捷是畫布角落的小型浮動按鈕（不另佔一行、不遮住人物中央）", bar.x > stage.x + stage.width * 0.4 && bar.y > stage.y + stage.height * 0.6 && bar.y + bar.height <= stage.y + stage.height + 1, { bar, stage });
  const btns = await page.locator('[data-testid="quick-bar"] [role="toolbar"] button').evaluateAll((els) => els.map((e) => e.getAttribute("data-quick") ?? e.getAttribute("data-testid")));
  check("日常只有三個主要快捷（還原衣物姿勢、保存、跟隨手臂）＋更多", btns.join() === "pose-restore,save,arm,quick-more", btns);
  const pose0 = await pose();
  await page.click('[data-quick="pose-restore"]');
  await page.click('[data-quick="arm"]');
  const ts0 = await toasts();
  check("未選衣物：不會修改任何衣物或姿勢，並提示先點選", JSON.stringify(await pose()) === JSON.stringify(pose0) && ts0.length === 2 && ts0.every((t) => t.tone === "err" && /點選/.test(t.text)), ts0);
  await shot("01-floating");

  console.log("保存衣服設定（單件）");
  await page.click('[data-tab="layers"]');
  await page.click('[data-layer="gar_blouse"] button:nth-of-type(2)');
  check("顯示目前操作對象", (await page.textContent('[data-testid="quick-target"]')).includes("泡袖上衣"));
  await page.click('[data-quick="save"]');
  await page.waitForFunction(() => window.__toasts.length > 0);
  let ts = await toasts();
  const t1 = await template("gar_blouse");
  check("保存圖示＝存為這件衣物的完整預設（目前身體），包含目前姿勢", !!t1 && t1.data.pose && Math.round(t1.data.pose.shoulder_r) === 36 && t1.data.pose.elbow_r === -50 && ts[0].tone === "ok", { t1, ts });
  check("保存不影響造型記錄", (await H.room("data-dirty")) !== null);

  console.log("還原衣物姿勢");
  const fitsA = await fits(), zoomA = await page.getAttribute('[data-testid="doll-stage"]', "data-zoom");
  await page.click('[data-tab="pose"]');
  await page.click('[data-pose="reach_out"]');
  await H.ready();
  check("人物改成其他姿勢", (await pose()).shoulder_l === -62, await pose());
  await page.waitForTimeout(500);
  const undoB = Number(await H.room("data-undo"));
  await page.click('[data-quick="pose-restore"]');
  await H.ready();
  const pr = await pose();
  check("還原為保存這件衣服時的姿勢（不是身體預設 A 字站姿）", Math.round(pr.shoulder_r) === 36 && pr.elbow_r === -50 && Math.round(pr.shoulder_l) === -28 && Object.keys(pr).length > 0, pr);
  const fitsB = await fits();
  check("還原姿勢：衣物位置、網格、遮罩保留；畫布縮放保留", JSON.stringify(fitsA) === JSON.stringify(fitsB) && (await page.getAttribute('[data-testid="doll-stage"]', "data-zoom")) === zoomA);
  await page.waitForTimeout(450);
  check("還原衣物姿勢＝一個撤銷步驟", Number(await H.room("data-undo")) === undoB + 1, [undoB, await H.room("data-undo")]);
  await page.click('[data-testid="undo"]');
  check("可以撤銷", (await pose()).shoulder_l === -62);
  await page.click('[data-testid="redo"]');
  check("可以重做", Math.round((await pose()).shoulder_r) === 36);
  // 姿勢分頁仍保留「還原身體預設站姿」（在更多選單）
  await page.click('[data-testid="quick-more"]');
  check("更多選單保留「還原身體預設站姿」", (await page.locator('[data-quick="pose-reset"]').count()) === 1);
  await page.click('[data-testid="quick-more"]');

  console.log("無袖 JSK：不適用跟隨手臂");
  await page.click('[data-tab="layers"]');
  await page.click('[data-layer="gar_jsk"] button:nth-of-type(2)');
  check("JSK 標示為不適用", (await page.getAttribute('[data-quick="arm"]', "data-applicable")) === "0");
  await page.click('[data-quick="arm"]');
  ts = await toasts();
  check("清楚提示不適用的原因，不改變衣物", ts.some((t) => /無袖/.test(t.text)) && (await H.room("data-selected")) === "gar_jsk", ts);
  await page.click('[data-quick="pose-restore"]');
  ts = await toasts();
  check("沒有保存姿勢的衣物：提示尚未設定衣物姿勢", ts.some((t) => /尚未設定衣物姿勢/.test(t.text)), ts);

  console.log("跟隨手臂（有袖上衣）");
  await page.click('[data-layer="gar_blouse"] button:nth-of-type(2)').catch(async () => { await page.click('[data-tab="layers"]'); await page.click('[data-layer="gar_blouse"] button:nth-of-type(2)'); });
  await H.ready();
  check("上衣目前固定於畫布、適用跟隨手臂", (await H.room("data-wear")) === "fixed" && (await page.getAttribute('[data-quick="arm"]', "data-applicable")) === "1");
  const px0 = await snapCanvas();
  await page.click('[data-quick="arm"]');
  await H.ready();
  await page.waitForTimeout(300);
  const px1 = await snapCanvas();
  check("開啟跟隨手臂：模式＝跟隨手臂，以目前姿勢建立基準", (await H.room("data-wear")) === "auto" && (await H.room("data-bind")) === "1" && (await page.getAttribute('[data-quick="arm"]', "aria-pressed")) === "true");
  check("開啟時衣物不會跳位（畫面差異 < 3%）", diff(px0, px1) < 0.03, diff(px0, px1));
  check("真正以骨架變形（不是剛性整件）", ["body", "parts"].includes(await H.room("data-rig")), await H.room("data-rig"));
  await shot("02-arm-on");
  // 移動手臂：袖子跟隨
  await page.click('[data-tab="pose"]');
  await page.click('[data-pose="reach_out"]');
  await H.ready(); await page.waitForTimeout(300);
  const px2 = await snapCanvas();
  check("改變姿勢後衣物跟隨變形（畫面改變）", diff(px1, px2) > 0.005, diff(px1, px2));
  await page.click('[data-tab="layers"]');
  await page.click('[data-layer="gar_blouse"] button:nth-of-type(2)');
  await page.click('[data-quick="arm"]');
  await H.ready();
  check("關閉跟隨手臂：恢復先前模式（固定於畫布），基準姿勢保留", (await H.room("data-wear")) === "fixed" && (await H.room("data-bind")) === "1", [await H.room("data-wear"), await H.room("data-bind")]);
  await page.click('[data-quick="arm"]');
  await H.ready();
  check("重新開啟：使用已保存的基準姿勢", (await H.room("data-wear")) === "auto" && (await H.room("data-bind")) === "1");

  console.log("手動網格＋基準姿勢");
  const lookM = await mk("網格上衣", [item("gar_blouse", "top", { fit: { cx: 600, cy: 760, w: 560, rotation: 0, mesh: MESH }, opts: { follow: "none", neck: true, bone: "world", over_head: false } })]);
  await page.goto(A.base + "/dressing/" + lookM);
  await H.ready();
  await page.evaluate(() => { window.__toasts = []; window.addEventListener("aw:toast", (e) => window.__toasts.push(e.detail)); });
  await page.click('[data-tab="layers"]');
  await page.click('[data-layer="gar_blouse"] button:nth-of-type(2)');
  await H.ready();
  const m0 = await snapCanvas();
  await page.click('[data-quick="arm"]');
  await H.ready(); await page.waitForTimeout(300);
  const m1 = await snapCanvas();
  check("有手動網格：開啟跟隨手臂後仍然骨架變形（不是剛性）", ["body", "parts"].includes(await H.room("data-rig")) && (await H.room("data-bind")) === "1", await H.room("data-rig"));
  check("基準姿勢下與手動校正結果一致（畫面差異 < 3%）", diff(m0, m1) < 0.03, diff(m0, m1));
  check("網格保留", JSON.parse(await H.room("data-fits")).length === 1);

  console.log("套裝部件：袖套跟隨手臂、只保存該部件");
  const lookS = await mk("套裝", [item("gar_maid", "dress", { piece: "pc_body" }), item("gar_maid", "accessory", { piece: "pc_slvr" })]);
  await page.goto(A.base + "/dressing/" + lookS);
  await H.ready();
  await page.evaluate(() => { window.__toasts = []; window.addEventListener("aw:toast", (e) => window.__toasts.push(e.detail)); });
  await page.click('[data-tab="layers"]');
  await page.click('[data-layer="gar_maid#pc_slvr"] button:nth-of-type(2)');
  await H.ready();
  check("袖套適用跟隨手臂", (await page.getAttribute('[data-quick="arm"]', "data-applicable")) === "1");
  const s0 = await snapCanvas();
  await page.click('[data-quick="arm"]');
  await H.ready(); await page.waitForTimeout(250);
  const s1 = await snapCanvas();
  check("右袖套附接右前臂（elbow_r），位置不跳", (await H.room("data-bone")) === "elbow_r" && diff(s0, s1) < 0.02, [await H.room("data-bone"), diff(s0, s1)]);
  const before = await template("gar_maid");
  await page.click('[data-quick="save"]');
  await page.waitForFunction(() => window.__toasts.some((t) => /部件/.test(t.text)));
  const after = await template("gar_maid");
  const pc = (t, id) => t.data.pieces.find((p) => p.id === id);
  check("選中套裝部件：只保存該部件（主體不變）", pc(after, "pc_slvr").opts.bone === "elbow_r" && JSON.stringify(pc(after, "pc_body")) === JSON.stringify(pc(before, "pc_body")) && after.version === before.version + 1);
  check("部件保存當時的姿勢", Math.round(pc(after, "pc_slvr").pose.shoulder_r) === 36);
  // 版本衝突：不假稱成功
  await env.DB.prepare("UPDATE doll_fit_templates SET version = 9 WHERE garment_id='gar_maid'").run();
  await page.click('[data-quick="save"]');
  await page.waitForFunction(() => window.__toasts.some((t) => t.tone === "err"));
  check("版本衝突：保存失敗如實回報，沒有覆寫", (await template("gar_maid")).version === 9);
  await shot("03-set-piece");
  check("沒有瀏覽器錯誤", A.errors.length === 0, A.errors);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  await A.close();
  done();
}
