// Phase 3.8A.1：換裝快捷工具列＋一次保存全部衣物設定（6 個部件的套裝）瀏覽器測試。
// 執行：node test/phase38a1-ui.mjs   （iPhone 13 尺寸＋觸控模擬；桌面 Chromium，不等於 iPhone Safari／PWA 實機驗收）
import { join } from "node:path";
import { startApp, addGarment, roomHelpers, checker } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p38a1");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38a1-${n}.png`) });
const H = roomHelpers(page);
// 女僕套裝：主體、頭飾、左右腿部配件、左右袖套各自分開
const SET = '<path d="M330 330 L570 330 L700 1000 L200 1000 Z" fill="#9c9aa3"/><path d="M380 360 L520 360 L560 900 L340 900 Z" fill="#f4f1f4"/><rect x="40" y="420" width="90" height="380" rx="30" fill="#2b2b2b"/><rect x="770" y="420" width="90" height="380" rx="30" fill="#2b2b2b"/><path d="M300 40 Q450 -10 600 40 L600 120 Q450 80 300 120 Z" fill="#fafafa"/><rect x="230" y="1040" width="110" height="140" rx="20" fill="#3a3a3a"/><rect x="560" y="1040" width="110" height="140" rx="20" fill="#3a3a3a"/>';
await addGarment(env, { id: "gar_maid", name: "灰白格紋愛心圍裙女僕套裝", category: "套裝", subcategory: "多件套", svg: SET });
const img = (await env.DB.prepare("SELECT id FROM garment_images WHERE garment_id='gar_maid'").first()).id;
const P = (id, name, slot, box, extra = {}) => ({ id, name, slot, box, ...extra });
const PIECES = [
  P("pc_body", "主體", "dress", [0.21, 0.26, 0.79, 0.85], { fit: { cx: 600, cy: 980, w: 520, rotation: 0 } }),
  P("pc_head", "頭飾", "headwear", [0.32, 0, 0.68, 0.11], { fit: { cx: 600, cy: 250, w: 230, rotation: 0 }, opts: { follow: "none", neck: false, bone: "head", over_head: true } }),
  P("pc_legr", "右側腿部配件", "socks", [0.24, 0.86, 0.39, 0.99]),
  P("pc_legl", "左側腿部配件", "socks", [0.61, 0.86, 0.76, 0.99]),
  P("pc_slvr", "右袖套", "accessory", [0.03, 0.34, 0.16, 0.68], { fit: { cx: 395, cy: 900, w: 80, rotation: 0 }, opts: { follow: "none", neck: false, bone: "elbow_r", over_head: false } }),
  P("pc_slvl", "左袖套", "accessory", [0.84, 0.34, 0.97, 0.68], { fit: { cx: 805, cy: 900, w: 80, rotation: 0 }, opts: { follow: "none", neck: false, bone: "elbow_l", over_head: false } }),
];
const t = new Date().toISOString();
await env.DB.prepare("INSERT INTO doll_fit_templates (garment_id,avatar_id,image_id,cx,cy,w,rotation,slot,data,version,created_at,updated_at) VALUES ('gar_maid','avatar_v2',?,600,950,620,0,'set',?,1,?,?)").bind(img, JSON.stringify({ opts: { follow: "auto", neck: true, bone: null, over_head: false }, mask: null, pose: null, front: [], variants: {}, pieces: PIECES }), t, t).run();
const tpl = async () => { const r = await env.DB.prepare("SELECT version, data FROM doll_fit_templates WHERE garment_id='gar_maid' AND avatar_id='avatar_v2'").first(); return { version: r.version, data: JSON.parse(r.data) }; };
const fits = async () => Object.fromEntries(JSON.parse(await H.room("data-fits")).map((f) => [f[0], f.slice(1)]));
const unsaved = () => page.getAttribute('[data-testid="batch-bar"]', "data-unsaved");

try {
  // 造型：穿著 6 個部件（不使用整套配置）
  await page.goto(A.base + "/");
  const look = await page.evaluate(async (ids) => (await (await fetch("/api/doll/looks", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ai-wardrobe" }, body: JSON.stringify({ name: "女僕套裝", state: { v: 3, head: "builtin:head_v2", hair: "builtin:twin_tails_long", hair_color: "brown_pink", accent_color: null, tip_color: null, pose: {}, front: [], items: ids.map(([id, slot]) => ({ garment_id: "gar_maid", piece: id, slot, hidden: false, variant: null, fit: null, opts: null, mask: null })) } }) })).json()), PIECES.map((p) => [p.id, p.slot]));
  check("建立 6 個部件的造型", !!look.id, look);
  const lookState0 = (await env.DB.prepare("SELECT state FROM doll_looks WHERE id=?").bind(look.id).first()).state;
  await page.goto(A.base + "/dressing/" + look.id);
  await H.ready();
  check("6 個部件全部穿著", (await H.room("data-worn")).split(",").length === 6, await H.room("data-worn"));

  console.log("快捷工具列");
  const bar = await page.locator('[data-testid="quick-bar"]').boundingBox(), stage = await page.locator('[data-testid="doll-stage"]').boundingBox();
  check("快捷工具是畫布右下角的小型浮動按鈕（不另佔一行）", bar.y + bar.height <= stage.y + stage.height + 1 && bar.width < stage.width * 0.75 && bar.height <= 90, { bar, stage });
  const btns = await page.locator('[data-testid="quick-bar"] [role="toolbar"] button').evaluateAll((els) => els.map((e) => ({ h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width, a: e.getAttribute("aria-label") })));
  check("三個主要快捷＋更多，觸控範圍足夠", btns.length === 4 && btns.slice(0, 3).every((b) => b.h >= 40 && b.w >= 40), btns);
  await page.click('[data-testid="quick-more"]');
  check("沒有選中時不會默默修改全部", (await page.getAttribute('[data-testid="quick-state"]', "data-count")) === "0");
  await page.click('[data-tab="layers"]');
  check("圖層頁顯示已穿部件及未保存數目（左右腿部配件未校正）", (await page.textContent('[data-testid="batch-bar"]')).includes("已穿 6 個部件") && (await unsaved()) === "2", await page.textContent('[data-testid="batch-bar"]'));
  await page.click('[data-testid="quick-more"]');
  await page.click('[data-layer="gar_maid#pc_head"] button:nth-of-type(2)');
  await page.click('[data-testid="quick-more"]');
  check("選中頭飾：作用範圍＝目前衣物（1 個部件）", (await page.getAttribute('[data-testid="quick-state"]', "data-count")) === "1" && (await page.getAttribute('[data-testid="quick-state"]', "data-mode")) === "body");
  check("頭飾不適用跟隨手臂", await page.locator('[data-quick-mode="auto"]').isDisabled());
  await page.selectOption('[data-testid="quick-scope"]', "set");
  check("目前套裝：6 個部件、各部件設定不同＝混合設定", (await page.getAttribute('[data-testid="quick-state"]', "data-count")) === "6" && (await page.getAttribute('[data-testid="quick-state"]', "data-mode")) === "mixed", await page.textContent('[data-testid="quick-state"]'));
  check("跟隨手臂計套裝主體及左右袖套（3 個）", (await page.getAttribute('[data-testid="quick-state"]', "data-auto")) === "3");
  await shot("01-quick-bar");
  const zoom0 = await page.getAttribute('[data-testid="doll-stage"]', "data-zoom"), f0 = await fits();
  const undo0 = Number(await H.room("data-undo"));
  await page.click('[data-quick-mode="body"]');
  await H.ready();
  check("一次切換整套為附接骨骼", (await page.getAttribute('[data-testid="quick-state"]', "data-mode")) === "body");
  const f1 = await fits();
  check("切換時部件沒有跳位或改變大小", Object.keys(f0).every((k) => Math.abs(f0[k][0] - f1[k][0]) < 1.5 && Math.abs(f0[k][1] - f1[k][1]) < 1.5 && Math.abs(f0[k][2] - f1[k][2]) < 0.2), { f0, f1 });
  await page.waitForTimeout(500);
  check("一次批量切換＝一個撤銷步驟", Number(await H.room("data-undo")) === undo0 + 1, [undo0, await H.room("data-undo")]);
  await page.click('[data-testid="undo"]');
  await H.ready();
  check("撤銷後回到混合設定", (await page.getAttribute('[data-testid="quick-state"]', "data-mode")) === "mixed");
  await page.selectOption('[data-testid="quick-scope"]', "item");
  await page.click('[data-testid="quick-more"]');

  console.log("一次保存全部衣物設定");
  // 調整頭飾 → 已修改
  await page.click('[data-tool="place"]').catch(() => undefined);
  await page.click('[data-testid="fit-panel"] [aria-label="向上微調"]');
  await page.click('[data-testid="fit-panel"] [aria-label="向上微調"]');
  const headFit = (await fits())["gar_maid#pc_head"];
  await page.click('[data-testid="fit-done"]');
  await page.click('[data-tab="layers"]');
  check("調整頭飾後：3 項設定尚未保存", (await unsaved()) === "3");
  await page.click('[data-testid="batch-open"]');
  await page.waitForSelector('[data-testid="batch-sheet"]');
  const states = await page.locator("[data-batch-item]").evaluateAll((els) => Object.fromEntries(els.map((e) => [e.dataset.batchItem.split("#")[1], e.dataset.state])));
  check("確認清單：頭飾已修改、左右腿部配件未校正、其他已設定", states.pc_head === "modified" && states.pc_legr === "uncalibrated" && states.pc_legl === "uncalibrated" && states.pc_body === "saved" && Object.keys(states).length === 6, states);
  check("顯示目前身體", (await page.textContent('[data-testid="batch-body"]')).includes("V2"));
  check("預設勾選有修改或未校正的 3 項", (await page.textContent('[data-testid="batch-count"]')).includes("將保存 3 項"));
  check("會覆寫現有預設時清楚標示", (await page.textContent('[data-batch-item="gar_maid#pc_head"]')).includes("覆寫"));
  await page.click('[data-batch-scope="all"]');
  check("可選擇全部已穿部件（6 項）", (await page.textContent('[data-testid="batch-count"]')).includes("將保存 6 項"));
  await page.click('[data-batch-scope="changed"]');
  await shot("02-batch-sheet");
  await page.click('[data-testid="batch-confirm"]');
  await page.waitForSelector('[data-testid="batch-result"]');
  check("顯示實際保存結果", (await page.getAttribute('[data-testid="batch-result"]', "data-saved")) === "3" && (await page.getAttribute('[data-testid="batch-result"]', "data-failed")) === "0");
  const s1 = await tpl();
  const pc = (id) => s1.data.pieces.find((p) => p.id === id);
  check("一次寫入（版本 1→2），各部件獨立保存", s1.version === 2 && Math.abs(pc("pc_head").fit.cy - headFit[1]) < 0.2 && !!pc("pc_legr").fit && !!pc("pc_legl").fit && pc("pc_legr").fit.cx !== pc("pc_legl").fit.cx);
  check("未勾選的部件保持原本預設（主體、袖套）", pc("pc_body").fit.cx === 600 && pc("pc_slvr").opts.bone === "elbow_r" && pc("pc_slvl").opts.bone === "elbow_l");
  check("整套穿著配置：6 個部件的相對次序", s1.data.set_layout?.order.length === 6, s1.data.set_layout);
  await page.click('[aria-label="關閉"]');
  check("保存後圖層頁：設定已全部保存", (await unsaved()) === "0", await page.textContent('[data-testid="batch-bar"]'));
  check("保存衣物設定不等於保存造型：造型記錄不變", (await env.DB.prepare("SELECT state FROM doll_looks WHERE id=?").bind(look.id).first()).state === lookState0);
  check("造型仍顯示未保存", (await H.room("data-dirty")) === "1");
  check("畫面縮放、部件位置不變（沒有重設為自動對位）", (await page.getAttribute('[data-testid="doll-stage"]', "data-zoom")) === zoom0 && Math.abs((await fits())["gar_maid#pc_head"][1] - headFit[1]) < 0.2);
  await shot("03-after-save");

  console.log("版本衝突");
  await env.DB.prepare("UPDATE doll_fit_templates SET version = 5 WHERE garment_id='gar_maid' AND avatar_id='avatar_v2'").run();
  await page.click('[data-layer="gar_maid#pc_legr"] button:nth-of-type(2)');
  await page.click('[data-testid="fit-panel"] [aria-label="向左微調"]');
  await page.click('[data-testid="fit-done"]');
  await page.click('[data-tab="layers"]');
  await page.click('[data-testid="batch-open"]');
  await page.click('[data-testid="batch-confirm"]');
  await page.waitForSelector('[data-testid="batch-result"]');
  check("版本衝突：不覆寫，並如實回報未保存", (await page.getAttribute('[data-testid="batch-result"]', "data-failed")) === "1" && (await page.textContent('[data-testid="batch-result"]')).includes("未保存") && (await tpl()).version === 5);
  check("可以只重試失敗項目", (await page.locator('[data-testid="batch-retry"]').count()) === 1);
  await page.click('[aria-label="關閉"]');
  check("失敗後保留未保存的編輯", (await unsaved()) === "1");

  console.log("下次穿上整套");
  await env.DB.prepare("UPDATE doll_fit_templates SET version = 2 WHERE garment_id='gar_maid' AND avatar_id='avatar_v2'").run();
  await page.goto(A.base + "/dressing/new");
  await page.waitForSelector('[data-garment="gar_maid"]');
  await page.click('[data-garment="gar_maid"]');
  await H.ready();
  const worn2 = (await H.room("data-worn")).split(",");
  check("按整套配置穿上 6 個部件（不是整張原圖）", worn2.length === 6 && worn2.every((w) => w.startsWith("gar_maid#pc_")), worn2);
  const f2 = await fits();
  check("恢復已校正效果（頭飾及腿部配件位置）", Math.abs(f2["gar_maid#pc_head"][1] - headFit[1]) < 0.2 && Math.abs(f2["gar_maid#pc_legr"][0] - pc("pc_legr").fit.cx) < 0.2, { f2, head: headFit });
  check("新造型直接使用預設：圖層頁沒有未保存設定", await (async () => { await page.click('[data-tab="layers"]'); return (await unsaved()) === "0"; })());
  // 單獨穿上頭飾
  await page.goto(A.base + "/dressing/new");
  await page.waitForSelector('[data-cat="套裝部件"]');
  await page.click('[data-cat="套裝部件"]');
  await page.waitForSelector('[data-piece-entry="gar_maid#pc_head"]');
  await page.click('[data-piece-entry="gar_maid#pc_head"]');
  await H.ready();
  check("單獨穿上頭飾：使用頭飾自己的預設", (await H.room("data-worn")) === "gar_maid#pc_head" && Math.abs((await fits())["gar_maid#pc_head"][1] - headFit[1]) < 0.2);
  check("沒有瀏覽器錯誤", A.errors.length === 0, A.errors);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
  await shot("error").catch(() => undefined);
}
await A.close();
done();
