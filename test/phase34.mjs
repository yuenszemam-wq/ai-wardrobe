// Phase 3.4：對比、原圖遮罩對比、部件圖層、衣服選單部件、衣服設定工作室、髮色工作室（瀏覽器測試）。
// 執行：node test/phase34.mjs   DOLL_SHOTS=資料夾 可輸出截圖。
// 注意：桌面 Chromium 模擬 iPhone 螢幕及觸控，不等於 iPhone Safari 實機驗收。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { checker, startRoom, svgPng } from "./doll-room.mjs";

const { check, done } = checker();
const SHOTS = process.env.DOLL_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const SHIRT = '<path d="M300 120 L600 120 L640 220 L860 760 L760 800 L620 420 L620 1080 L280 1080 L280 420 L140 800 L40 760 L260 220 Z" fill="#f4f2f0" stroke="#c9c3c0" stroke-width="6"/><rect x="420" y="300" width="60" height="500" fill="#e2b8c4"/>';
const SET = '<path d="M330 330 L570 330 L700 1100 L200 1100 Z" fill="#8a1c2c"/><rect x="60" y="420" width="90" height="380" rx="30" fill="#1b1b1b"/><rect x="750" y="420" width="90" height="380" rx="30" fill="#1b1b1b"/><rect x="380" y="230" width="140" height="45" rx="20" fill="#2b2b2b"/><path d="M300 60 Q450 -10 600 60 L600 140 Q450 90 300 140 Z" fill="#3a3a3a"/>';
const R = await startRoom({ name: "p34", garments: [
  { id: "gar_shirt", name: "測試白色襯衫", category: "上衣", subcategory: "襯衫", png: await svgPng(SHIRT, 900, 1200) },
  { id: "gar_set", name: "測試女僕套裝", category: "套裝", subcategory: "多件套", png: await svgPng(SET, 900, 1200) },
] });
const { page, env, room, stage, ready, screen, tap } = R;
const shot = (n) => (SHOTS ? page.screenshot({ path: join(SHOTS, `p34-${n}.png`) }) : null);
const fitOf = async (k) => JSON.parse(await room("data-fits")).find((f) => f[0] === k);
const canvas = () => page.locator('[data-testid="doll-canvas"]').evaluate((c) => c.toDataURL());
const drag = async (from, to) => { await page.mouse.move(from[0], from[1]); await page.mouse.down(); for (let i = 1; i <= 6; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 6, from[1] + ((to[1] - from[1]) * i) / 6); await page.mouse.up(); };

try {
  await page.goto(R.base + "/dressing");
  await page.waitForSelector('[data-garment="gar_shirt"]');
  await page.click('[data-garment="gar_shirt"]');
  await ready();
  const f = await fitOf("gar_shirt");
  await tap(await screen(f[1], f[2]));
  await page.waitForSelector('[data-testid="fit-panel"]');

  console.log("網格變形的對比：比較有／沒有手動網格的實際衣物像素");
  await page.click('[data-tool="mesh"]');
  const mp = page.locator('[data-mesh-point="5"]'), sb = await page.locator('[data-testid="doll-stage"]').boundingBox();
  const mx = sb.x + Number(await mp.getAttribute("data-x")), my = sb.y + Number(await mp.getAttribute("data-y"));
  await drag([mx, my], [mx + 30, my + 24]);
  await page.waitForTimeout(450);
  await ready();
  const edited = await canvas(), fits0 = await room("data-fits");
  await page.click('[data-testid="compare"]');
  await ready();
  const original = await canvas();
  check("對比開啟：畫面變回沒有手動網格的衣物", original !== edited);
  check("對比期間位置、大小及旋轉不變，衣物資料不被修改", (await room("data-fits")) === fits0);
  check("對比期間畫布只可縮放／移動（不會誤改網格）", (await stage("data-mode")) === "view");
  await shot("01-mesh-compare");
  await page.click('[data-testid="compare"]');
  await ready();
  check("關閉對比：立即返回目前編輯效果", (await canvas()) === edited);
  await page.click('[data-testid="mesh-reset"]');
  await page.waitForTimeout(450);

  console.log("遮罩：衣物原圖模式開啟對比不會切回人物");
  await page.click('[data-tool="mask"]');
  await drag(await screen(f[1] - 20, f[2] - 60), await screen(f[1] + 40, f[2] - 40));
  await page.waitForTimeout(500);
  await ready();
  check("遮罩已塗抹", (await room("data-masked")) === "1");
  await page.click('[data-gview="source"]');
  await ready();
  const srcMasked = await canvas();
  await shot("02-source-masked");
  await page.click('[data-testid="compare"]');
  await ready();
  check("原圖模式開啟對比：仍然是衣物原圖", (await room("data-gview")) === "source" && (await page.textContent('[data-testid="stage-badge"]')).includes("衣物原圖"), await page.textContent('[data-testid="stage-badge"]'));
  check("原圖模式的對比：顯示未套用遮罩的原圖（像素不同）", (await canvas()) !== srcMasked);
  await shot("03-source-compare");
  await page.click('[data-testid="compare"]');
  await ready();
  check("關閉對比：回到遮罩後的原圖效果", (await canvas()) === srcMasked);
  await page.click('[data-gview="worn"]');
  await page.click('[data-testid="mask-clear"]');
  await page.click('[data-testid="fit-done"]');

  console.log("套裝部件：圖層名稱及縮圖、衣服選單直接選擇");
  await page.click('[data-tab="clothes"]');
  await page.click('[data-garment="gar_set"]');
  await ready();
  const sf = await fitOf("gar_set");
  await tap(await screen(sf[1], sf[2] + 60));
  await page.click('[data-tool="wear"]');
  await page.click('[data-testid="open-split"]');
  await page.waitForSelector('[data-testid="split-editor"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="split-stage"]')?.dataset.k);
  await page.click('[data-testid="split-auto"]');
  await page.waitForTimeout(700);
  const cards = await page.locator('[data-testid="split-pieces"] [data-piece]').allTextContents();
  check("拆件編輯器：右袖套（畫面左）建議附接角色的右手肘", cards.some((t) => t.includes("右袖套") && t.includes("右手肘")) && cards.some((t) => t.includes("左袖套") && t.includes("左手肘")), cards);
  check("拆件編輯器：部件列表有縮圖", (await page.locator('[data-testid="split-pieces"] img').count()) >= 4);
  await page.click('[data-split-preview="piece"]');
  await page.waitForTimeout(200);
  await shot("04-split-piece-preview");
  await page.click('[data-split-preview="mark"]');
  await page.click('[data-testid="split-save"]');
  await page.waitForSelector('[data-testid="split-editor"]', { state: "detached" });
  await page.click('[data-testid="wear-all-pieces"]');
  await ready();
  await page.click('[data-testid="fit-done"]').catch(() => undefined);
  await page.click('[data-tab="layers"]');
  const names = await page.locator("[data-layer-name]").allTextContents();
  check("圖層：每個部件顯示自己的名稱（不再全部是套裝名稱）", names.length >= 5 && new Set(names).size === names.length && names.some((n) => n.includes("袖套")), names);
  check("圖層：部件使用自己的縮圖", (await page.locator("[data-piece-thumb]").count()) >= 4);
  check("圖層：同一套裝的部件可以群組管理", (await page.locator("[data-layer-group]").count()) === 1);
  await shot("05-layers-pieces");
  await page.click('[data-layer-group] [aria-expanded]');
  await page.waitForSelector('[data-layer^="grp:"]', { timeout: 3000 }).catch(() => undefined);
  check("收起群組：只佔一行，其他衣物仍在", (await page.locator('[data-layer^="grp:"]').count()) === 1 && (await page.locator('[data-layer="gar_shirt"]').count()) === 1);
  await page.click('[data-tab="clothes"]');
  await page.click('[data-cat="套裝部件"]');
  check("衣服選單：已拆出的部件可以直接選擇", (await page.locator("[data-piece-entry]").count()) >= 4);
  await page.click('[data-cat="上衣"]');
  check("子分類篩選列只在有多於一個子分類時出現", (await page.locator('[data-testid="doll-subcats"]').count()) === 0);
  const n0 = (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n;
  check("部件不是新衣物", n0 === 2);

  console.log("髮色工作室");
  await page.click('[data-tab="look"]');
  await page.click('[data-looktab="color"]');
  await ready();
  const hair0 = await canvas();
  await page.click('[data-target="main"]');
  await page.locator('[data-testid="color-hex"]').fill("#3a6bd1");
  await page.waitForTimeout(300);
  await ready();
  check("輸入 HEX：頭髮即時染色", (await canvas()) !== hair0 && (await room("data-hair-color")) === "#3a6bd1", await room("data-hair-color"));
  await page.locator('[data-testid="color-hue"]').fill("300");
  await page.waitForTimeout(300);
  await ready();
  check("滑動色相：主髮色改變", (await room("data-hair-color")) !== "#3a6bd1", await room("data-hair-color"));
  await page.evaluate(() => { window.prompt = () => "奶茶啡"; });
  await page.click('[data-testid="swatch-save"]');
  await page.waitForFunction(() => document.querySelectorAll("[data-swatch]").length === 1);
  const pal = JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='doll_hair_palette'").first()).value);
  check("自訂色票長期保存（伺服器）", pal.colors.length === 1 && pal.colors[0].name === "奶茶啡", pal);
  await shot("06-hair-studio");

  console.log("衣服設定工作室");
  await page.goto(R.base + "/outfits");
  await page.waitForSelector('[data-testid="entry-setup"]', { timeout: 8000 }).catch(() => undefined);
  check("穿搭工作室有三個入口", (await page.locator('[data-testid="entry-setup"]').count()) === 1);
  await page.goto(R.base + "/dressing/setup");
  await page.waitForSelector("[data-setup-garment]");
  check("列出可換裝的衣物及各項設定狀態", (await page.locator("[data-setup-garment]").count()) === 2 && (await page.locator('[data-setup-garment="gar_set"] [data-item]').count()) === 4);
  await shot("07-setup-list");
  await page.click('[data-setup-garment="gar_shirt"]');
  await page.waitForSelector('[data-testid="setup-header"]');
  await ready();
  check("編輯器只穿著目標衣物，並已選中", (await room("data-worn")) === "gar_shirt" && (await room("data-selected")) === "gar_shirt");
  await page.click('[data-testid="setup-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="dressing-room"]').dataset.dirty === "0");
  await page.waitForTimeout(500);
  const t = await env.DB.prepare("SELECT data FROM doll_fit_templates WHERE garment_id='gar_shirt' AND avatar_id='avatar_v2'").first();
  check("保存設定：更新衣物預設", !!t);
  const looks = (await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_looks").first()).n;
  check("衣服設定不會建立穿搭造型", looks === 0, looks);
  await page.click('[data-mark="mask"]');
  await page.waitForFunction(() => document.querySelector('[data-mark="mask"]')?.dataset.state === "done");
  check("可以手動標記設定狀態", JSON.parse((await env.DB.prepare("SELECT data FROM doll_fit_templates WHERE garment_id='gar_shirt'").first()).data).status?.mask === "done");
  await shot("08-setup-editor");
  await page.click('[aria-label="返回衣服設定列表"]');
  await page.waitForSelector('[data-setup-garment="gar_shirt"]');
  check("返回列表：狀態已更新", (await page.getAttribute('[data-setup-garment="gar_shirt"] [data-item="place"]', "data-state")) === "done");
  check("沒有頁面錯誤", R.errors.length === 0, R.errors);
} catch (e) {
  check("測試中斷 " + (e.message || e).toString().split("\n")[0], false);
  console.log(e.stack);
  await shot("zz-error");
} finally {
  await R.close();
  done();
}
