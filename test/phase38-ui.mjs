// Phase 3.8A：瀏覽器端對端測試（iPhone 13 尺寸及觸控模擬；桌面 Chromium，不等於 iPhone Safari／PWA 實機驗收）
// 執行：node test/phase38-ui.mjs   （需要 esbuild、tailwindcss、sharp、playwright）
import { join } from "node:path";
import { startApp, addGarment, roomHelpers, checker } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p38ui");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38-${n}.png`) });
const COLLAR = '<path d="M330 200 L570 200 L600 760 L300 760 Z" fill="#fffaf6"/><path d="M300 210 L190 800 L90 780 L215 210 Z M600 210 L710 800 L810 780 L685 210 Z" fill="#f3e9ee"/><rect x="40" y="20" width="820" height="160" fill="#10b020"/>';
await addGarment(env, { id: "gar_col", name: "白色黑蕾絲娃娃領上衣", category: "上衣", subcategory: "Blouse", svg: COLLAR });
await addGarment(env, { id: "gar_sk", name: "測試半裙", category: "半身裙", subcategory: "SK", svg: '<path d="M300 300 L600 300 L800 950 L100 950 Z" fill="#7a1f2b"/>' });
const H = roomHelpers(page);
const openQuick = async () => { if (!(await page.locator('[data-testid="quick-pop"]').count())) await page.click('[data-testid="quick-toggle"]'); };

try {
  console.log("換裝：快捷操作");
  await page.goto(A.base + "/dressing/new");
  await H.ready();
  await page.click('[data-garment="gar_col"]');
  await page.click('[data-garment="gar_sk"]');
  await H.ready();
  await page.click('[data-testid="quick-toggle"]');
  check("快捷操作收在可展開的按鈕內", (await page.locator('[data-testid="quick-pop"]').count()) === 1);
  check("沒有選中衣物時提示先選取", (await page.locator('[data-testid="quick-noselect"]').count()) === 1);
  await page.click('[data-quick-close]').catch(() => undefined);
  await page.mouse.click(...(await H.screen(80, 1700)));
  check("點選畫布其他位置會收起快捷操作", (await page.locator('[data-testid="quick-pop"]').count()) === 0);
  await page.click('[data-tab="pose"]');
  await page.click('[data-pose="reach_out"]');
  await H.ready();
  check("姿勢已改變", JSON.parse(await H.room("data-pose")).shoulder_l === -62);
  await page.click('[data-tab="layers"]');
  await page.click('[data-layer="gar_col"] button:nth-of-type(2)');
  await page.click('[data-tool="mask"]');
  await page.click('[data-mask="behind"]');
  await page.locator('[data-testid="mask-brush"]').fill("10");
  // 在後領位置塗抹（找出畫面上的綠色後領）
  const band = await page.evaluate(() => { const s = document.querySelector('[data-testid="doll-stage"]'), c = document.querySelector('[data-testid="doll-canvas"]'); const k = Number(s.dataset.k), dpr = c.width / s.getBoundingClientRect().width, ox = Number(s.dataset.ox), oy = Number(s.dataset.oy); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let x0 = 1e9, x1 = -1, ys = 0, n = 0; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] < 70 && d[i + 1] > 90 && d[i + 2] < 70) { n++; ys += y; if (x < x0) x0 = x; if (x > x1) x1 = x; } } const L = (px, py) => [(px / dpr - ox) / k, (py / dpr - oy) / k]; return n ? { a: L(x0, ys / n), b: L(x1, ys / n) } : null; });
  check("找到後領位置", !!band, band);
  for (const dy of [-14, -7, 0, 7, 14]) await H.drag(await H.screen(band.a[0] - 20, band.a[1] + dy), await H.screen(band.b[0] + 20, band.b[1] + dy), 18);
  await page.waitForTimeout(500);
  await H.ready();
  await page.waitForSelector('[data-testid="mask-behind-stats"]', { timeout: 8000 }).catch(() => undefined);
  const st = await page.locator('[data-testid="mask-behind-stats"]').count() ? { total: Number(await page.getAttribute('[data-testid="mask-behind-stats"]', "data-total")), visible: Number(await page.getAttribute('[data-testid="mask-behind-stats"]', "data-visible")) } : null;
  check("移到身後：面板顯示身後部分仍有輪廓外可見像素（不是刪除）", !!st && st.visible > 0 && st.visible < st.total, st);
  check("圖例：紅＝隱藏、藍＝移到身後", (await page.textContent('[data-testid="mask-legend"]')).includes("藍＝移到身後"));
  await shot("01-mask-behind");
  // 原圖視圖：按對比不會返回人物
  await page.click('[data-gview="source"]');
  check("切換到衣物原圖", (await H.room("data-gview")) === "source", await H.room("data-gview"));
  await page.click('[data-testid="compare"]');
  await page.waitForTimeout(200);
  check("原圖模式按對比：仍然停留在衣物原圖", (await H.room("data-gview")) === "source" && (await page.textContent('[data-testid="stage-badge"]')).includes("衣物原圖"), await page.textContent('[data-testid="stage-badge"]'));
  await shot("02-source-compare");
  await page.click('[data-testid="compare"]');
  await page.click('[data-gview="worn"]');
  await H.ready();

  // 快捷：目前衣物的跟隨模式（與骨架分頁同步）
  await page.click('[data-testid="quick-toggle"]');
  const fit0 = await H.room("data-worn");
  await page.click('[data-quick-mode="fixed"]');
  await H.ready();
  check("快捷切換：固定原圖", (await page.getAttribute('[data-testid="quick-mode"]', "data-mode")) === "fixed" && (await H.room("data-wear")) === "fixed");
  await page.click('[data-tool="follow"]');
  check("與骨架分頁同步", (await page.getAttribute('[data-wear-mode="fixed"]', "aria-pressed")) === "true");
  check("切換跟隨模式不清除遮罩", (await H.room("data-masked")) === "1");
  await openQuick();
  await page.click('[data-quick-mode="body"]');
  check("快捷切換：跟隨身體", (await H.room("data-wear")) === "body" && (await page.getAttribute('[data-wear-mode="body"]', "aria-pressed")) === "true");
  await openQuick();
  await page.click('[data-quick-mode="auto"]');
  check("快捷切換：跟隨手臂", (await H.room("data-wear")) === "auto");
  await page.click('[data-testid="undo"]');
  await H.ready();
  check("撤銷快捷切換", (await H.room("data-wear")) === "body", await H.room("data-wear"));

  // 還原姿勢：衣物設定、遮罩、鏡頭保留
  const cam0 = await page.getAttribute('[data-testid="doll-stage"]', "data-zoom");
  await openQuick();
  await page.click('[data-quick="pose-reset"]');
  await H.ready();
  check("還原姿勢：回到預設站姿", (await H.room("data-pose")) === "{}");
  check("還原姿勢：衣物、遮罩及跟隨模式保留", (await H.room("data-worn")) === fit0 && (await H.room("data-masked")) === "1" && (await H.room("data-wear")) === "body");
  check("還原姿勢：畫布縮放保留", (await page.getAttribute('[data-testid="doll-stage"]', "data-zoom")) === cam0);
  await page.click('[data-testid="undo"]');
  check("撤銷還原姿勢", JSON.parse(await H.room("data-pose")).shoulder_l === -62, await H.room("data-pose"));
  await shot("03-quick");

  // 半裙：不可使用跟隨手臂
  await page.click('[data-testid="fit-done"]');
  await page.click('[data-tab="layers"]');
  await page.click('[data-layer="gar_sk"] button:nth-of-type(2)');
  await openQuick();
  check("半裙不適用跟隨手臂", await page.locator('[data-quick-mode="auto"]').isDisabled());
  // 批量
  await page.click('[data-testid="quick-batch"] summary');
  const autoLabel = await page.textContent('[data-quick-all="auto"]');
  check("批量操作清楚顯示作用範圍（只計有袖衣物）", autoLabel.includes("1 件"), autoLabel);
  await page.click('[data-quick-all="body"]');
  await H.ready();
  check("批量跟隨身體", (await H.room("data-wear")) === "body");
  await openQuick();
  if (await page.locator('[data-testid="quick-batch"]:not([open])').count()) await page.click('[data-testid="quick-batch"] summary');
  await page.click('[data-quick-all="default"]');
  await H.ready();
  check("還原各自預設跟隨模式（沒有衣物預設＝固定原圖）", (await H.room("data-wear")) === "fixed", await H.room("data-wear"));

  // 保存造型 → 重新開啟：遮罩效果相同
  check("快捷操作未寫入衣物預設", !(await env.DB.prepare("SELECT 1 FROM doll_fit_templates WHERE garment_id='gar_col'").first()));
  await page.click('[data-testid="save-look"]');
  await page.waitForFunction(() => /\/dressing\/(?!new)/.test(location.pathname), null, { timeout: 10000 });
  const lookUrl = page.url();
  await page.goto(lookUrl);
  await H.ready();
  check("重新開啟造型：遮罩保留", (await H.room("data-masked")) === "1");
  check("沒有瀏覽器錯誤", A.errors.length === 0, A.errors);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
  await shot("error").catch(() => undefined);
}
await A.close();
done();
