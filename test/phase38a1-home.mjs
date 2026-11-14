// Phase 3.8A.1：主頁原位編輯（拖動真實元件）、元件設定、版本衝突、按需讀取及局部錯誤。
// 執行：node test/phase38a1-home.mjs（iPhone 13 viewport＋觸控模擬；桌面 Chromium，不等於 iPhone Safari 實機）
import { join } from "node:path";
import { startApp, addGarment, checker } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p38a1h");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38a1h-${n}.png`), fullPage: false });
for (let i = 0; i < 8; i++) await addGarment(env, { id: `gar_k${"abcdefgh"[i]}`, name: `主頁衣物 ${i + 1}`, category: i % 2 ? "半身裙" : "連身裙", subcategory: i % 2 ? "SK" : "JSK", svg: `<path d="M300 200 L600 200 L800 1100 L100 1100 Z" fill="#7a1f2b"/>`, w: 450, h: 600, price: 100 + i, favorite: i % 3 === 0 ? 1 : 0, created: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
const layoutOf = () => page.getAttribute('[data-testid="home"]', "data-layout");
const handle = (id) => page.locator(`[data-drag-handle="${id}"]`);
const center = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const waitLayout = (fn) => page.waitForFunction(fn, null, { timeout: 5000 }).catch(() => undefined);
const serverLayout = async () => JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='home_layout'").first())?.value ?? "null");

try {
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="w-recent"]');
  console.log("原位編輯");
  await page.click('[data-testid="home-edit"]');
  await page.waitForSelector('[data-testid="home-editor"]');
  check("不再打開佔據畫面的大型名稱列表", (await page.locator('[aria-label="主頁佈局編輯器"]').count()) === 0);
  check("元件留在原位並顯示真實內容（最近加入衣物縮圖）", (await page.locator('[data-widget="recent"] [data-testid="w-recent"] img, [data-widget="recent"] [data-testid="w-recent"] a').count()) > 0);
  check("每個元件有拖動把手、設定、隱藏、上下移", (await page.locator('[data-widget="value"] [data-drag-handle]').count()) === 1 && (await page.locator('[data-widget="value"] [data-settings]').count()) === 1 && (await page.locator('[data-widget="value"] [data-toggle]').count()) === 1 && (await page.locator('[data-widget="value"] [data-move="up"]').count()) === 1);
  check("底部緊湊工具列：新增元件｜取消｜完成", (await page.textContent('[data-testid="home-edit-bar"]')).replace(/\s/g, "").includes("新增小工具取消完成"));
  // 點擊元件內容不會進入衣物詳情
  await page.locator('[data-widget="recent"]').scrollIntoViewIfNeeded();
  { const b = await page.locator('[data-widget="recent"] [data-testid="w-recent"]').boundingBox(); await page.mouse.click(b.x + 50, Math.min(b.y + b.height - 30, b.y + 60)); }
  await page.waitForTimeout(300);
  check("編輯時點擊元件不會誤觸連結", new URL(page.url()).pathname === "/");
  await shot("01-edit-mode");

  console.log("拖動真實元件");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(100);
  const l0 = await layoutOf();
  const [hx, hy] = await center(handle("value"));
  const quickBox = await page.locator('[data-widget="quick"]').boundingBox(), valueBox = await page.locator('[data-widget="value"]').boundingBox();
  // 拖到「總價」中心剛好越過「快捷操作」中心（遠離畫面邊緣，不觸發自動捲動）
  const dy = quickBox.y + quickBox.height / 2 - (valueBox.y + valueBox.height / 2) + 12;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(hx, hy + (dy * i) / 10);
  check("拖動中：元件跟隨手指並浮起", (await page.getAttribute('[data-testid="home-editor"]', "data-dragging")) === "value" && /translate\(/.test(await page.locator('[data-widget="value"]').evaluate((e) => e.style.transform)));
  await page.waitForTimeout(150);
  const domOrder = await page.locator("[data-widget]").evaluateAll((els) => els.map((e) => [e.dataset.widget, Number(getComputedStyle(e).order)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]));
  check("拖動中：其他元件即時讓位（快捷操作移到總價之前）", domOrder.indexOf("quick") < domOrder.indexOf("value"), domOrder);
  check("拖動中：顯示放置位置", await page.locator('[data-testid="home-insert-line"]').isVisible());
  check("拖動期間主頁次序未改變（放手才更新）", (await layoutOf()) === l0);
  await shot("02-dragging");
  await page.mouse.up();
  await page.waitForTimeout(150);
  const l1 = (await layoutOf()).split(",");
  check("放手後：總價移到快捷操作之後", l1.indexOf("value") === l1.indexOf("quick") + 1, l1);
  check("放手後清除拖動樣式", (await page.locator('[data-widget="value"]').evaluate((e) => e.style.transform)) === "");

  // pointercancel：還原拖動前狀態，不保存
  const l2 = await layoutOf();
  const [cx, cy] = await center(handle("cover"));
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(cx, cy + 40 * i);
  await handle("cover").dispatchEvent("pointercancel", { pointerId: 1, bubbles: true });
  await page.mouse.up();
  await page.waitForTimeout(150);
  check("pointercancel：還原拖動前次序", (await layoutOf()) === l2 && (await page.getAttribute('[data-testid="home-editor"]', "data-dragging")) === "", await layoutOf());

  // 邊緣自動捲動：手指停在畫面底部
  await page.evaluate(() => window.scrollTo(0, 0));
  const y0 = await page.evaluate(() => window.scrollY);
  const [ex, ey] = await center(handle("cover"));
  await page.mouse.move(ex, ey);
  await page.mouse.down();
  const vh = page.viewportSize().height;
  for (let i = 1; i <= 8; i++) await page.mouse.move(ex, ey + ((vh - 40 - ey) * i) / 8);
  await page.waitForTimeout(900);
  const y1 = await page.evaluate(() => window.scrollY);
  check("手指停留在畫面邊緣時持續自動捲動", y1 > y0 + 60, [y0, y1]);
  await handle("cover").dispatchEvent("pointercancel", { pointerId: 1, bubbles: true });
  await page.mouse.up();
  check("自動捲動後取消：次序不變", (await layoutOf()) === l2);
  await page.evaluate(() => window.scrollTo(0, 0));

  console.log("元件設定");
  await page.click('[data-widget="overview"] [data-settings="overview"]');
  await page.waitForSelector('[data-widget-settings="overview"]');
  await page.click('[data-testid="overview-items"] [data-item="ai_done"] input');
  await page.click('[data-testid="overview-items"] [data-item="unpriced"] input');
  await page.click('[data-testid="overview-items"] [data-item="unpriced"] [data-item-move="up"]');
  await page.click('[role="dialog"] [aria-label="關閉"]');
  const ov = await page.getAttribute('[data-testid="w-overview"] [data-items]', "data-items");
  check("衣櫃概覽：自選統計項目及次序", ov === "total,favorites,ai_todo,unpriced,ai_review", ov);
  await page.click('[data-widget="quick"] [data-settings="quick"]');
  for (const k of ["upload", "setup", "analysis"]) await page.click(`[data-testid="quick-items"] [data-item="${k}"] input`);
  await page.click('[role="dialog"] [aria-label="關閉"]');
  check("快捷操作：只保留衣服配搭、角色換裝", (await page.getAttribute('[data-testid="w-quick"] [data-items]', "data-items")) === "outfit,dressing");
  await page.click('[data-widget="analysis"] [data-settings="analysis"]');
  await page.click('[data-chart="bars"]');
  await page.click('[role="dialog"] [aria-label="關閉"]');
  check("分析摘要：圖表形式可選", (await page.getAttribute('[data-testid="w-analysis"]', "data-chart")) === "bars");
  // 隱藏及重新加入
  await page.click('[data-toggle="value"]');
  await waitLayout(() => !document.querySelector('[data-testid="home"]').dataset.layout.split(",").includes("value"));
  check("隱藏元件", !(await layoutOf()).split(",").includes("value"));
  await page.click('[data-testid="home-add"]');
  check("元件庫：已隱藏的元件可重新加入", (await page.textContent('[data-add="value"]')).includes("重新加入"));
  await page.click('[data-add="value"]');
  await page.click('[data-testid="gallery-readd"]');
  await waitLayout(() => document.querySelector('[data-testid="home"]').dataset.layout.split(",").includes("value"));
  check("重新加入", (await layoutOf()).split(",").includes("value"));
  await page.click('[data-testid="home-add"]');
  await page.click('[data-add="recent"]');
  await page.click('[data-testid="gallery-add"]');
  const ids = await page.locator("[data-widget]").evaluateAll((els) => els.map((e) => e.dataset.widget));
  check("同類多個元件：各自獨立 ID", ids.includes("recent") && ids.includes("recent_2"), ids);
  await shot("03-settings");
  const draftLayout = await layoutOf();
  await page.click('[data-testid="home-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="home"]').dataset.editing === "0");
  const s1 = await serverLayout();
  check("完成：保存布局及各元件設定（rev 遞增）", s1.rev === 1 && s1.widgets.find((w) => w.type === "quick").opts.items.join() === "outfit,dressing" && s1.widgets.find((w) => w.type === "overview").opts.items.length === 5, s1.rev);
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="home"]');
  check("重新開啟 App：布局不變", (await layoutOf()) === draftLayout, [await layoutOf(), draftLayout]);

  console.log("取消");
  await page.click('[data-testid="home-edit"]');
  await page.click('[data-toggle="cover"]');
  await page.click('[data-widget="recent"] [data-move="up"]');
  await page.click('[data-testid="home-cancel"]');
  check("取消：還原開始編輯前的完整布局", (await layoutOf()) === draftLayout);

  console.log("跨裝置版本衝突");
  await page.click('[data-testid="home-edit"]');
  await page.click('[data-toggle="analysis"]');
  await waitLayout(() => !document.querySelector('[data-testid="home"]').dataset.layout.split(",").includes("analysis"));
  const mine = await layoutOf();
  // 另一部裝置在編輯期間保存
  const other = { ...s1, widgets: s1.widgets.map((w) => (w.type === "todo" ? { ...w, visible: false } : w)) };
  await page.evaluate(async (l) => { await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json", "x-requested-with": "ai-wardrobe" }, body: JSON.stringify({ home_layout: l, home_layout_rev: 1 }) }); }, other);
  await page.click('[data-testid="home-save"]');
  await page.waitForSelector('[data-testid="home-conflict"]');
  check("不可靜默覆蓋：顯示版本衝突", (await serverLayout()).rev === 2 && (await serverLayout()).widgets.find((w) => w.type === "analysis").visible === true);
  check("衝突時保留本機草稿", (await layoutOf()) === mine && (await page.getAttribute('[data-testid="home"]', "data-editing")) === "1");
  await shot("04-conflict");
  await page.click('[data-testid="home-conflict-overwrite"]');
  await page.click('[data-testid="home-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="home"]').dataset.editing === "0");
  check("明確選擇覆寫後才保存", (await serverLayout()).rev === 3 && (await serverLayout()).widgets.find((w) => w.type === "analysis").visible === false);
  // 伺服器較舊的版本不會取代本機較新的版本
  check("同步判斷實際新舊（rev）", await page.evaluate(() => JSON.parse(localStorage.getItem("aw:home-layout")).rev === 3));

  console.log("按需讀取及局部錯誤");
  await page.evaluate(async () => { await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json", "x-requested-with": "ai-wardrobe" }, body: JSON.stringify({ home_layout: { v: 1, widgets: [{ id: "value", type: "value", visible: true, size: "standard", opts: {} }] }, home_layout_rev: 3 }) }); });
  // 第一次開啟：伺服器較新的布局寫入本機快取；之後開啟 App 直接按本機布局按需讀取
  await page.goto(A.base + "/");
  await page.waitForTimeout(600);
  A.requests.length = 0;
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="w-value"] a');
  await page.waitForTimeout(500);
  const req = A.requests.join(" ");
  check("只顯示總價：不讀取分析、衣櫃清單或穿搭", !/\/api\/analysis|\/api\/doll\/looks|\/api\/outfits|\/api\/garments/.test(req), A.requests);
  await page.evaluate(async () => { await fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json", "x-requested-with": "ai-wardrobe" }, body: JSON.stringify({ home_layout: { v: 1, widgets: [{ id: "value", type: "value", visible: true }, { id: "analysis", type: "analysis", visible: true }, { id: "recent", type: "recent", visible: true }] }, home_layout_rev: 4 }) }); });
  await page.route("**/api/analysis", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "x", message: "伺服器暫時故障" } }) }));
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="w-error-analysis"]');
  check("分析讀取失敗只影響分析元件", (await page.locator('[data-testid="w-value"] a').count()) === 1 && (await page.locator('[data-testid="w-recent"]').count()) === 1);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.click('[data-retry="analysis"]');
  await page.waitForSelector('[data-testid="w-analysis"]');
  check("局部重試成功", (await page.locator('[data-testid="w-error-analysis"]').count()) === 0);
  await shot("05-on-demand");
  console.log("列表返回位置（衣服設定）");
  for (let i = 0; i < 30; i++) await addGarment(env, { id: `gar_s${String(i).padStart(2, "0").replace(/[0189]/g, (d) => "wxyz"["0189".indexOf(d)])}`, name: `設定衣物 ${String(i + 1).padStart(2, "0")}`, category: "上衣", subcategory: "Blouse", svg: `<rect x="250" y="200" width="400" height="700" fill="#6b2d5c"/>`, w: 300, h: 400, created: new Date(Date.UTC(2026, 1, 1 + i)).toISOString() });
  await page.goto(A.base + "/dressing/setup");
  await page.waitForSelector('[data-testid="setup-list"] li');
  await page.click('[data-testid="setup-sort"]');
  await page.click('[data-testid="setup-sort"]');
  check("排序：名稱", (await page.textContent('[data-testid="setup-sort"]')).includes("名稱"));
  const target = page.locator('[data-setup-garment]').nth(24);
  const tid = await target.getAttribute("data-setup-garment");
  await target.scrollIntoViewIfNeeded();
  await page.evaluate((id) => { const el = document.querySelector(`[data-setup-garment="${id}"]`); window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 160 }); }, tid);
  await page.waitForTimeout(400);
  const before = await page.evaluate((id) => document.querySelector(`[data-setup-garment="${id}"]`).getBoundingClientRect().top, tid);
  await page.click(`[data-setup-garment="${tid}"]`);
  await page.waitForSelector('[data-testid="dressing-room"]');
  await page.goBack();
  await page.waitForSelector(`[data-setup-garment="${tid}"]`);
  await page.waitForTimeout(500);
  const after = await page.evaluate((id) => document.querySelector(`[data-setup-garment="${id}"]`).getBoundingClientRect().top, tid);
  check("返回後停在同一件衣物（不需重新捲動）", Math.abs(after - before) < 30 && (await page.evaluate(() => window.scrollY)) > 300, { before, after });
  check("返回後保留排序", (await page.textContent('[data-testid="setup-sort"]')).includes("名稱"));
  check("沒有瀏覽器錯誤", A.errors.filter((e) => !/500/.test(e)).length === 0, A.errors);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
  await shot("error").catch(() => undefined);
}
await A.close();
done();
