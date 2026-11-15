// Phase 3.9A.3 UI：角色換裝素材圖層（共用素材面板、骨骼附接、換姿勢跟隨、附接不跳位、前後、遮罩、保存及重新載入、匯出包含素材）、
// 背景撤銷、背景預設庫、多份角色草稿及草稿列表。
// 執行：node test/phase39a3-ui.mjs（桌面 Chromium 模擬 iPhone；不等於 iPhone Safari／PWA 實機驗收）
import { join } from "node:path";
import { startApp, roomHelpers, checker, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p393");
const { page } = A;
const H = roomHelpers(page);
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p393-${n}.png`) });
const props = async () => ((await H.room("data-props")) || "").split(",").filter(Boolean).map((s) => { const [id, bone, z, cx, cy] = s.split(":"); return { id, bone, z, cx: Number(cx), cy: Number(cy) }; });
const isMag = (c) => c[0] > 180 && c[1] < 90 && c[2] > 150 && c[3] > 200;
const magCount = () => H.count(0, 0, 1200, 1800, "x").then(() => page.evaluate(() => { const c = document.querySelector('[data-testid="doll-canvas"]'); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] > 150 && d[i + 3] > 200) n++; return n; }));
const openMenu = async () => { await page.click('[data-testid="dressing-room"] button[aria-label="更多"]'); };
const pick = async (id) => { if (!(await page.locator(`[data-testid="prop-controls"][data-sel="${id}"]`).count())) await page.click(`[data-prop="${id}"] button >> nth=0`); await page.waitForSelector('[data-testid="prop-controls"]'); };
const closeSheet = async () => { await page.locator('[role="dialog"] button[aria-label="關閉"]').last().click().catch(() => page.keyboard.press("Escape")); await page.waitForTimeout(200); };

try {
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="tab-add"]');
  // 素材庫道具：洋紅色長方形
  const buf = await sharp({ create: { width: 100, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from('<svg width="100" height="160"><rect x="0" y="0" width="100" height="160" fill="#e01ad0"/></svg>') }]).png().toBuffer();
  const asset = await page.evaluate(async (b64) => { const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const f = new FormData(); f.set("file", new Blob([bytes], { type: "image/png" }), "wand.png"); f.set("kind", "prop"); f.set("name", "魔法棒"); f.set("in_library", "1"); const r = await fetch("/api/studio/assets", { method: "POST", body: f, headers: { "x-requested-with": "ai-wardrobe" } }); return r.json(); }, buf.toString("base64"));

  console.log("加入素材圖層");
  await page.goto(A.base + "/dressing");
  await H.ready();
  await openMenu();
  await page.click('[data-testid="menu-props"]');
  await page.click('[data-testid="prop-add"]');
  await page.waitForSelector(`[data-lib-asset="${asset.id}"]`);
  await page.click(`[data-lib-asset="${asset.id}"]`);
  await page.waitForFunction(() => (document.querySelector('[data-testid="dressing-room"]')?.dataset.props || "") !== "");
  let ps = await props();
  check("共用素材面板加入素材圖層：預設固定畫面、最前", ps.length === 1 && ps[0].bone === "world" && ps[0].z === "front", ps);
  await closeSheet(); await H.ready();
  check("素材畫在角色最前（畫面中間是洋紅色）", isMag(await H.colorAt(600, 760)), await H.colorAt(600, 760));
  await shot("01-prop-added");

  console.log("骨骼附接");
  await openMenu(); await page.click('[data-testid="menu-props"]');
  await pick(ps[0].id);
  await page.selectOption('[data-testid="prop-bone"]', "wrist_r");
  ps = await props();
  await closeSheet(); await H.ready();
  check("改為附接右手：畫面位置不跳動（基準姿勢下骨骼座標＝畫面座標）", ps[0].bone === "wrist_r" && isMag(await H.colorAt(600, 760)), [ps, await H.colorAt(600, 760)]);
  const before = await magCount();
  await page.click('[data-tab="pose"]');
  await page.click('[data-pose="hand_on_hip"]');
  await H.ready();
  const after = await magCount();
  check("換姿勢後素材跟隨右手移動（原位置不再是素材，素材仍完整可見）", !isMag(await H.colorAt(600, 760)) && after > before * 0.6, [await H.colorAt(600, 760), before, after]);
  await shot("02-prop-follows-hand");
  await page.click('[data-tab="pose"]');
  await page.click('[data-pose="a_pose"]');
  await H.ready();

  console.log("前後及遮罩");
  await openMenu(); await page.click('[data-testid="menu-props"]');
  await pick(ps[0].id);
  await page.selectOption('[data-testid="prop-bone"]', "world");
  await page.click('[data-prop-z="back"]');
  ps = await props();
  await closeSheet(); await H.ready();
  check("移到角色後面：被身體及衣物遮住（中間不是洋紅色）", ps[0].z === "back" && !isMag(await H.colorAt(600, 760)), [ps, await H.colorAt(600, 760)]);
  await openMenu(); await page.click('[data-testid="menu-props"]');
  await pick(ps[0].id);
  await page.click('[data-prop-z="front"]');
  await page.click('[data-testid="prop-mask"]');
  await page.waitForSelector('[data-testid="mask-canvas"]');
  const mc = await page.locator('[data-testid="mask-canvas"]').boundingBox();
  await page.mouse.move(mc.x + mc.width * 0.5, mc.y + 4); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(mc.x + mc.width * 0.5, mc.y + (mc.height * 0.9 * i) / 10);
  await page.mouse.up();
  await page.click('[data-testid="mask-done"]');
  await closeSheet(); await H.ready();
  check("遮罩：中間一條被隱藏（只影響這個圖層）", !isMag(await H.colorAt(600, 760)) && (await magCount()) > 100, [await H.colorAt(600, 760)]);

  console.log("畫布移動及姿勢中改附接");
  await page.click('[data-tab="pose"]'); await page.click('[data-pose="hand_on_hip"]'); await H.ready();
  await openMenu(); await page.click('[data-testid="menu-props"]'); await pick(ps[0].id);
  const c0 = await H.colorAt(600, 760);
  await page.selectOption('[data-testid="prop-bone"]', "elbow_r");
  const moved = await props();
  await closeSheet(); await H.ready();
  check("已換姿勢時改附接右前臂：保存座標換算，但畫面位置不跳動", moved[0].bone === "elbow_r" && (moved[0].cx !== 600 || moved[0].cy !== 760) && JSON.stringify(await H.colorAt(600, 760)) === JSON.stringify(c0), [moved, c0, await H.colorAt(600, 760)]);
  await page.click('[data-tab="pose"]'); await page.click('[data-pose="a_pose"]'); await H.ready();
  await openMenu(); await page.click('[data-testid="menu-props"]'); await pick(ps[0].id);
  await page.selectOption('[data-testid="prop-bone"]', "world");
  await page.click('[data-testid="prop-move"]');
  await page.waitForSelector('[data-testid="prop-move-layer"]');
  const k = Number(await page.getAttribute('[data-testid="doll-stage"]', "data-k"));
  const p0 = (await props())[0];
  const [sx, sy] = await H.screen(p0.cx, p0.cy);
  await H.drag([sx, sy], [sx + 60, sy + 30]);
  const p1 = (await props())[0];
  check("在畫布拖動素材：按畫面縮放換算移動距離", Math.abs(p1.cx - p0.cx - 60 / k) < 3 && Math.abs(p1.cy - p0.cy - 30 / k) < 3, [p0, p1, k]);
  await page.click('[data-testid="prop-move-done"]');
  await closeSheet(); await H.ready();

  console.log("背景撤銷");
  await openMenu(); await page.click('[data-testid="menu-background"]');
  await page.click('[data-testid="look-bg-panel"] [data-bg="solid"]');
  await closeSheet();
  await page.waitForTimeout(600);
  check("背景改為純色", (await H.room("data-bg-type")) === "solid");
  await page.click('[data-testid="undo"]');
  await page.waitForTimeout(300);
  check("撤銷可還原背景", (await H.room("data-bg-type")) === "legacy");
  await page.click('[data-testid="redo"]').catch(() => undefined);
  await page.waitForTimeout(300);
  check("重做再套用背景", (await H.room("data-bg-type")) === "solid");

  console.log("背景預設庫");
  await openMenu(); await page.click('[data-testid="menu-background"]');
  await page.click('[data-testid="bg-preset-save"]');
  await page.waitForSelector('[data-testid="bg-presets"] [data-bg-preset]');
  check("保存目前背景為預設（純色亦可保存）", (await page.locator('[data-testid="bg-presets"] [data-bg-preset]').count()) === 1);
  await page.click('[data-testid="look-bg-panel"] [data-bg="legacy"]');
  await page.click('[data-testid="bg-presets"] [data-bg-preset] button >> nth=0');
  check("套用預設", (await H.room("data-bg-type")) === "solid");
  await closeSheet();

  console.log("多份角色草稿");
  await page.waitForTimeout(1200);
  const url = page.url();
  check("新角色造型網址記錄自己的草稿", /\/dressing\?draft=l_/.test(url), url);
  await page.goto(A.base + "/outfits");
  await page.waitForSelector('[data-testid="draft-strip"] [data-draft-id]');
  check("我的穿搭草稿列表包括角色換裝草稿", (await page.textContent('[data-testid="draft-strip"]')).includes("角色換裝"));
  await page.click('[data-testid="draft-strip"] [data-draft-id] button >> nth=0');
  await H.ready(); await page.waitForTimeout(500);
  check("由草稿列表打開：恢復素材圖層、遮罩及背景", (await props()).length === 1 && (await H.room("data-bg-type")) === "solid");

  console.log("保存及匯出");
  await page.fill('[data-testid="look-name"]', "道具造型");
  await page.click('[data-testid="save-look"]');
  await page.waitForFunction(() => /\/dressing\/dlk_/.test(location.pathname), null, { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  const lk = await A.env.DB.prepare("SELECT id, state FROM doll_looks WHERE name = '道具造型'").first();
  const st = lk ? JSON.parse(lk.state) : null;
  check("造型保存素材圖層（附接、遮罩）", st?.props?.length === 1 && st.props[0].mask?.strokes.length === 1 && st.background?.type === "solid", st?.props);
  await page.reload(); await H.ready();
  check("重新載入後畫面一致", (await props()).length === 1 && (await magCount()) > 100);
  await page.evaluate(() => { navigator.canShare = () => false; });
  await openMenu();
  const dl = page.waitForEvent("download");
  await page.click('[data-testid="export-png"]');
  const file = await (await dl).path();
  const raw = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let mag = 0; for (let i = 0; i < raw.data.length; i += 4) if (raw.data[i] > 180 && raw.data[i + 1] < 90 && raw.data[i + 2] > 150 && raw.data[i + 3] > 200) mag++;
  check("匯出 PNG 包含素材圖層", mag > 500, mag);
  await shot("03-saved");
  check("保存後草稿列表不再顯示", await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("aw-studio-drafts", 1); r.onsuccess = () => { const t = r.result.transaction("drafts", "readonly").objectStore("drafts").getAllKeys(); t.onsuccess = () => res(t.result.length === 0); }; r.onerror = () => res(false); })));

  const errs = A.errors.filter((e) => !/net::ERR_FAILED|Failed to fetch/.test(e));
  check("沒有瀏覽器錯誤", errs.length === 0, errs);
} catch (e) {
  console.error(e);
  check("未預期錯誤", false, String(e?.stack || e));
  await shot("zz-error").catch(() => undefined);
}
await A.close();
done();
