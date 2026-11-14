// Phase 3.8A.2：Widget 首頁（大小／展示方式／半寬、可視化元件庫、兩欄拖動、舊版升級）瀏覽器測試。
// 執行：node test/phase38a2-home.mjs（iPhone 13 viewport＋觸控模擬；桌面 Chromium，不等於 iPhone Safari 實機）
import { join } from "node:path";
import { startApp, addGarment, checker } from "./p38-setup.mjs";
import { buildModule } from "./doll-build.mjs";

const { check, done } = checker();
const L = await buildModule("shared/homeLayout.ts", "p38a2-layout");

console.log("資料模型及舊版升級");
const v1 = { v: 1, rev: 4, updated_at: "2026-11-13T00:00:00Z", widgets: [
  { id: "cover", type: "cover", visible: true, size: "standard", opts: { show_name: true } },
  { id: "overview", type: "overview", visible: true, size: "compact", opts: { items: ["total", "favorites"] } },
  { id: "analysis", type: "analysis", visible: true, size: "standard", opts: { chart: "bars", mode: "brand" } },
  { id: "recent", type: "recent", visible: false, size: "compact", opts: { count: 5 } },
] };
const up = L.normalizeHomeLayout(v1);
const by = (id) => up.widgets.find((w) => w.id === id);
check("舊版 compact／standard 升級為中型／大型，仍然全寬（外觀不變）", by("overview").size === "medium" && by("overview").span === 2 && by("cover").size === "large" && by("cover").span === 2);
check("舊版展示方式按原設定推斷（概覽 compact＝橫向數字列、分析 bars＝長條）", by("overview").display === "row" && by("analysis").display === "bars");
check("保留 ID、次序、設定、隱藏狀態及 rev", up.widgets.slice(0, 4).map((w) => w.id).join() === "cover,overview,analysis,recent" && by("overview").opts.items.join() === "total,favorites" && by("recent").visible === false && by("recent").opts.count === 5 && up.rev === 4);
check("版本號升級為 2", up.v === 2);
const half = L.normalizeHomeLayout({ widgets: [{ id: "a", type: "overview", size: "small", display: "single", span: 2, opts: {} }, { id: "b", type: "value", size: "medium", display: "amount", span: 1, opts: {} }, { id: "c", type: "cover", size: "small", display: "full" }] });
check("小型＝半寬；中型可選半寬；全幅封面只可全寬", half.widgets[0].span === 1 && half.widgets[1].span === 1 && half.widgets.find((w) => w.id === "c").span === 2);
check("未知展示方式回到預設", L.normalizeHomeLayout({ widgets: [{ id: "x", type: "recent", display: "bogus" }] }).widgets[0].display === "carousel");
check("同類型可重複加入（例如兩個衣櫃概覽）", L.normalizeHomeLayout({ widgets: [{ id: "o1", type: "overview" }, { id: "o2", type: "overview" }] }).widgets.filter((w) => w.type === "overview").length === 2);
check("每種元件至少有 4 種展示方式（待處理 3 種）", Object.entries(L.DISPLAYS).every(([t, l]) => l.length >= (t === "todo" ? 3 : 4)));

const A = await startApp("p38a2h");
const { env, page, requests } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38a2-home-${n}.png`), fullPage: false });
for (let i = 0; i < 6; i++) await addGarment(env, { id: `gar_h${"abcdef"[i]}`, name: `首頁衣物 ${i + 1}`, category: "連身裙", subcategory: "JSK", favorite: i < 2 ? 1 : 0, price: i < 3 ? 500 + i * 100 : null, svg: `<path d="M300 200 L600 200 L700 1100 L200 1100 Z" fill="#${["8a2b4a", "3a3a8a", "2a6a4a", "6a5a2a", "5a2a6a", "2a5a6a"][i]}"/>` });
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('home_layout',?,?)").bind(JSON.stringify(v1), v1.updated_at).run();
const layoutOf = () => page.getAttribute('[data-testid="home"]', "data-layout");
const serverLayout = async () => JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='home_layout'").first()).value);

try {
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="home-grid"]');
  check("舊版布局正常顯示（次序不變）", (await layoutOf()) === "cover,overview,analysis", await layoutOf());
  check("首頁為兩欄 Grid", (await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="home-grid"]')).gridTemplateColumns.split(" ").length)) === 2);

  console.log("可視化元件庫");
  await page.click('[data-testid="home-edit"]');
  await page.waitForSelector('[data-testid="home-editor"]');
  const g0 = requests.filter((r) => r.startsWith("GET /api/garments")).length;
  await page.click('[data-testid="home-add"]');
  await page.waitForSelector('[data-testid="home-add-list"]');
  await page.waitForTimeout(800);
  check("每個元件都有真實預覽（與正式首頁同一個渲染器）", (await page.locator('[data-add="overview"] [data-testid="w-overview"]').count()) === 1 && (await page.locator('[data-add="value"] [data-testid="w-value"]').count()) === 1 && (await page.locator('[data-add="recent"] [data-testid="w-recent"] a[href^="/g/"]').count()) > 0);
  check("預覽使用目前衣櫃的真實資料（衣物縮圖）", (await page.locator('[data-add="recent"] img').count()) > 0);
  const g1 = requests.filter((r) => r.startsWith("GET /api/garments")).length;
  check("預覽不會重複下載完整衣櫃（最多讀取一次衣物清單）", g1 - g0 <= 1, [g0, g1]);
  await shot("01-gallery");
  await page.click('[data-add="overview"]');
  await page.waitForSelector('[data-testid="gallery-detail"]');
  check("可左右滑動切換展示方式（每頁都是真實預覽）", (await page.locator("[data-gallery-slide]").count()) === 5 && (await page.locator('[data-gallery-slide="single"] [data-testid="w-overview"]').count()) === 1);
  await page.click('[data-gallery-display="single"]');
  check("選擇展示方式：顯示目前展示方式及大小", (await page.getAttribute('[data-testid="gallery-detail"]', "data-display")) === "single" && (await page.textContent('[data-testid="gallery-current"]')).includes("單一數字") && (await page.textContent('[data-testid="gallery-current"]')).includes("小型"));
  await shot("02-gallery-detail");
  await page.click('[data-testid="gallery-add"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-widget^="overview"]').length === 2);
  const ids = await page.locator("[data-widget]").evaluateAll((els) => els.map((e) => e.dataset.widget));
  const o2 = ids.find((x) => x.startsWith("overview_"));
  check("加入後立即顯示真實元件（不需重新載入）＋獨立 ID", !!o2 && (await page.getAttribute(`[data-widget="${o2}"]`, "data-span")) === "1" && (await page.locator(`[data-widget="${o2}"] [data-testid="w-overview"] [data-stat]`).count()) === 1, ids);
  // 第二個單一數字：收藏
  await page.click('[data-testid="home-add"]');
  await page.click('[data-add="overview"]');
  await page.click('[data-gallery-display="single"]');
  await page.click('[data-testid="gallery-detail"] details summary');
  await page.waitForFunction(() => { const d = document.querySelector('[data-testid="gallery-detail"]'); return d?.dataset.display === "single" && d?.dataset.size === "small"; });
  for (const k of ["total", "ai_todo", "ai_review", "ai_done"]) await page.click(`[data-testid="gallery-detail"] [data-testid="overview-items"] [data-item="${k}"] input`);
  await page.waitForTimeout(400);
  check("加入前仍然是單一數字＋小型", (await page.getAttribute('[data-testid="gallery-detail"]', "data-display")) === "single" && (await page.getAttribute('[data-testid="gallery-detail"]', "data-size")) === "small");
  await page.click('[data-testid="gallery-add"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-widget^="overview"]').length === 3);
  const o3 = (await page.locator("[data-widget]").evaluateAll((els) => els.map((e) => e.dataset.widget))).find((x) => x.startsWith("overview_") && x !== o2);
  check("新增時可直接選擇基本內容（只顯示收藏數量）", (await page.getAttribute(`[data-widget="${o3}"] [data-stat]`, "data-stat")) === "收藏");
  const b2 = await page.locator(`[data-widget="${o2}"]`).boundingBox(), b3 = await page.locator(`[data-widget="${o3}"]`).boundingBox();
  check("兩個小型元件並排在同一行（左：衣物總數，右：收藏）", Math.abs(b2.y - b3.y) < 2 && b3.x > b2.x + b2.width - 1, { b2, b3 });
  await page.locator(`[data-widget="${o2}"]`).scrollIntoViewIfNeeded();
  await shot("03-half-width");

  console.log("兩欄拖動");
  const order = () => page.locator("[data-widget]").evaluateAll((els) => els.map((e) => [e.dataset.widget, Number(getComputedStyle(e).order)]).sort((a, b) => a[1] - b[1]).map((x) => x[0]));
  const hb = await page.locator(`[data-drag-handle="${o2}"]`).boundingBox();
  const target = await page.locator(`[data-widget="${o3}"]`).boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  const tx = target.x + target.width / 2, ty = target.y + target.height / 2;
  for (let i = 1; i <= 10; i++) await page.mouse.move(hb.x + hb.width / 2 + ((tx - hb.x - hb.width / 2) * i) / 10, hb.y + hb.height / 2 + ((ty - hb.y - hb.height / 2) * i) / 10);
  await page.waitForTimeout(150);
  const o = await order();
  check("拖動半寬元件：左右交換時其他元件即時讓位", o.indexOf(o3) < o.indexOf(o2), o);
  check("拖動時顯示放置位置", await page.locator('[data-testid="home-insert-line"]').isVisible());
  await page.mouse.up();
  await page.waitForTimeout(150);
  const l1 = (await layoutOf()).split(",");
  const visibleIds = async () => page.locator("[data-widget]").evaluateAll((els) => els.map((e) => e.dataset.widget));
  const after = await visibleIds();
  check("放手後：左右交換完成", after.indexOf(o3) < after.indexOf(o2), after);
  // 跨行：把「分析」拖到第一行（封面之後）
  await page.evaluate(() => scrollTo(0, 0));
  const ha = await page.locator('[data-drag-handle="analysis"]').boundingBox();
  const ov = await page.locator('[data-widget="overview"]').boundingBox();
  await page.mouse.move(ha.x + ha.width / 2, ha.y + ha.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(ha.x + ha.width / 2 + 10, ha.y + ha.height / 2 + ((ov.y + ov.height / 2 - ha.y - ha.height / 2) * i) / 12);
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after2 = await visibleIds();
  check("跨行移動：分析移到概覽之前", after2.indexOf("analysis") < after2.indexOf("overview"), after2);

  console.log("重新設定已有元件");
  await page.click('[data-settings="analysis"]');
  await page.waitForSelector('[data-widget-settings="analysis"]');
  check("設定頁頂部顯示真實預覽", (await page.locator('[data-testid="widget-settings-preview"] [data-testid="w-analysis"]').count()) === 1);
  await page.click('[data-widget-settings="analysis"] [data-display="ratio"]');
  await page.click('[data-widget-settings="analysis"] [data-size="small"]');
  await page.click('[role="dialog"] [aria-label="關閉"]');
  check("改為單一比例＋小型：半寬", (await page.getAttribute('[data-widget="analysis"]', "data-span")) === "1" && (await page.getAttribute('[data-widget="analysis"] [data-testid="w-analysis"]', "data-chart")) === "ratio");
  // 總價：完成度進度條，未填價格不當作零元
  await page.click('[data-testid="home-add"]');
  await page.click('[data-add="value"]');
  await page.click('[data-gallery-display="full"]');
  await page.click('[data-testid="gallery-add"]');
  await page.waitForTimeout(200);
  const vfull = await page.locator('[data-value-display="full"]').last().textContent();
  check("完整價格統計：平均只計已填價格（未填不當作零元）", vfull.includes("$600") && vfull.includes("未填價格3"), vfull);
  // 隨機推薦：重新渲染不改變；按「重新推薦」才更換
  await page.click('[data-testid="home-add"]');
  await page.click('[data-add="random_garment"]');
  await page.click('[data-testid="gallery-add"]');
  await page.waitForTimeout(300);
  const rnd = () => page.locator('[data-widget^="random_garment"] a[href^="/g/"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")).join());
  const r0 = await rnd();
  await page.click('[data-toggle="cover"]');
  await page.waitForTimeout(150);
  check("隨機推薦：其他改動導致重新渲染時內容不變", (await rnd()) === r0 && r0.length > 0, r0);
  check("提供明確的「重新推薦」按鈕", (await page.locator('[data-widget^="random_garment"] [data-reroll]').count()) === 1);
  await shot("04-edit-grid");

  console.log("保存及重新開啟");
  await page.click('[data-testid="home-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="home"]').dataset.editing === "0");
  const s1 = await serverLayout();
  const sv = (id) => s1.widgets.find((w) => w.id === id);
  check("保存大小、展示方式及欄數（rev 遞增）", s1.v === 2 && s1.rev === 5 && sv(o2).display === "single" && sv(o2).span === 1 && sv("analysis").display === "ratio" && sv("analysis").span === 1, { rev: s1.rev });
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="home-grid"]');
  check("重新開啟：半寬元件仍然並排", (await page.getAttribute(`[data-w="${o2}"]`, "data-span")) === "1");
  await page.evaluate(() => scrollTo(0, 0));
  await shot("05-home");
  check("沒有瀏覽器錯誤", A.errors.length === 0, A.errors);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  await A.close();
  done();
}
