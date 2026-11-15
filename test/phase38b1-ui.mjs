// Phase 3.8B.1 UI：R2 視覺化儀表板、直接調色（底部調色面板、點擊預覽元素、撤銷、保存失敗／衝突）、衣櫃頁首完整／收合。
// 執行：node test/phase38b1-ui.mjs（桌面 Chromium 模擬 iPhone；不等於 iPhone Safari／PWA 實機驗收）
import { join } from "node:path";
import { startApp, addGarment, checker } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p38b1");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38b1-${n}.png`) });
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const dayStr = (d) => d.toISOString().slice(0, 10);

for (let i = 0; i < 60; i++) {
  const n = String(i + 1).padStart(3, "0");
  await addGarment(env, { id: `gar_h${n}`, name: `頁首測試 ${n}`, category: i % 2 ? "連身裙" : "上衣", subcategory: i % 2 ? (i % 4 === 1 ? "JSK" : "OP") : "Blouse", svg: `<path d="M300 200 L600 200 L800 1100 L100 1100 Z" fill="#6b2d5c"/>`, w: 450, h: 600, created: new Date(Date.UTC(2026, 0, 1, 0, 0, 60 - i)).toISOString() });
}

// 官方數據（直接放入新鮮快取，不連接 Cloudflare）：每日資料有缺失日期，Class A 很低（0.067%）
const days = [];
for (let i = 29; i >= 0; i--) {
  const d = dayStr(new Date(Date.now() - i * 864e5));
  const missing = i === 5 || i === 6;
  days.push({ date: d, class_a: missing ? null : 20 + (i % 5), class_b: missing ? null : 300 + i * 10, free: missing ? null : 0, unknown: missing ? null : 0, storage_bytes: missing ? null : 5.5e8 + i * 1e6, objects: missing ? null : 580, ...(i === 0 ? { partial: true } : {}) });
}
const off = { available: true, fetched_at: new Date().toISOString(), delay_note: "Cloudflare Analytics 數據可能延遲", account: { class_a: 667, class_b: 11526, free: 3, unknown: 0, unknown_actions: [], storage_bytes: 553.2e6, objects: 588, gb_month_est: 0.088, storage_days: 14, days: 15, days_in_month: 30, month },
  buckets: { "ai-wardrobe-images": { class_a: 600, class_b: 11000, free: 3, unknown: 0, storage_bytes: 5.2e8, objects: 560 }, "ai-wardrobe-preview-images": { class_a: 50, class_b: 400, free: 0, unknown: 0, storage_bytes: 2e7, objects: 20 }, "kitchen-stock-images": { class_a: 17, class_b: 126, free: 0, unknown: 0, storage_bytes: 1.32e7, objects: 8 } },
  daily: { available: true, start: days[0].date, end: today, days, truncated: false } };

try {
  console.log("R2 儀表板");
  env.CF_API_TOKEN = "test"; env.CF_ACCOUNT_ID = "acc";
  for (const k of ["r2_official_cache", "r2_official_last_ok"]) await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").bind(k, JSON.stringify(off), new Date().toISOString()).run();
  await page.goto(A.base + "/settings/r2");
  await page.waitForSelector('[data-testid="r2-summary"]');
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid="r2-usage"] > section, [data-testid="r2-usage"] > details')].map((e) => e.dataset.testid));
  check("由上至下：費用總覽 → 免費額度 → 每日趨勢 → Bucket → …→ 提醒 → 進階", order.indexOf("r2-summary") < order.indexOf("r2-quota") && order.indexOf("r2-quota") < order.indexOf("r2-trend") && order.indexOf("r2-trend") < order.indexOf("r2-buckets") && order.indexOf("r2-app") < order.indexOf("r2-local") && order.indexOf("r2-local") < order.indexOf("r2-alerts") && order.at(-1) === "r2-advanced", order);
  check("仍在免費額度內、官方數據、最後更新時間", (await page.getAttribute('[data-testid="r2-free-status"]', "data-free")) === "yes" && (await page.textContent('[data-testid="r2-source"]')) === "官方數據" && (await page.textContent('[data-testid="r2-cost-total"]')) === "US$0");
  check("Class A 0.067%（不是 0%）", (await page.textContent('[data-testid="r2-q-a-pct"]')) === "0.067%", await page.textContent('[data-testid="r2-q-a-pct"]'));
  check("三條獨立進度條：GB-month、Class A、Class B，顯示用量、上限及剩餘", (await page.locator('[data-testid^="r2-q-"][data-level]').count()) === 3 && (await page.textContent('[data-testid="r2-q-b"]')).includes("剩餘") && (await page.textContent('[data-testid="r2-q-storage"]')).includes("10 GB-month"));
  check("Class A 進度條極低用量仍可見", Number(await page.getAttribute('[data-testid="r2-q-a"]', "data-bar")) > 0);
  check("每日趨勢預設最近 30 日，缺失日期標示為缺口（不是 0）", Number(await page.getAttribute('[data-testid="r2-chart"]', "data-points")) === 30 && Number(await page.getAttribute('[data-testid="r2-chart"]', "data-missing")) === 2);
  await page.click('[data-testid="r2-range"] [data-seg="7d"]');
  check("時間篩選：最近 7 日", Number(await page.getAttribute('[data-testid="r2-chart"]', "data-points")) === 7);
  await page.click('[data-testid="r2-metric"] [data-seg="class_a"]');
  const svg = await page.locator('[data-testid="r2-chart"] svg').boundingBox();
  await page.mouse.click(svg.x + svg.width * 0.5, svg.y + svg.height * 0.5);
  check("點擊圖表顯示日期、數值及資料來源", /Class A/.test(await page.textContent('[data-testid="r2-chart-tip"]')) && /來源：Cloudflare 官方/.test(await page.textContent('[data-testid="r2-chart-tip"]')));
  await page.click('[data-testid="r2-range"] [data-seg="30d"]');
  await page.click('[data-testid="r2-metric"] [data-seg="cum"]');
  check("本月累計 Class A／B 可獨立切換", (await page.locator('[data-testid="r2-cum"] [data-seg]').count()) === 2);
  await page.click('[data-testid="r2-metric"] [data-seg="storage"]');
  check("儲存容量折線圖", (await page.locator('[data-testid="r2-chart"] path').count()) >= 1);
  check("Bucket 分布：正式、預覽、其他專案", (await page.locator('[data-testid="r2-buckets"] [data-env="正式環境"]').count()) === 1 && (await page.locator('[data-testid="r2-buckets"] [data-env="預覽環境"]').count()) === 1 && (await page.locator('[data-testid="r2-buckets"] [data-env="其他 Cloudflare 專案"]').count()) === 1);
  check("App 用途技術表格預設收起", !(await page.locator('[data-testid="r2-app-table"]').evaluate((e) => e.open)));
  await page.click('[data-testid="r2-forecast-toggle"]');
  check("月底估算：清楚標示估算及日期範圍（或暫未有足夠資料）", /估算|暫未有足夠資料/.test(await page.textContent('[data-testid="r2-forecast"]')));
  for (const w of [320, 375, 390, 430]) {
    await page.setViewportSize({ width: w, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`R2 儀表板 ${w}px 沒有橫向溢出`, overflow <= 1, overflow);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await shot("01-r2-dashboard");
  await page.locator('[data-testid="r2-trend"]').scrollIntoViewIfNeeded();
  await shot("02-r2-trend");
  // 冷卻：重新整理後按鈕暫時停用
  await page.click('[data-testid="r2-refresh"]');
  await page.waitForTimeout(400);
  check("手動重新整理後有冷卻時間", await page.locator('[data-testid="r2-refresh"]').isDisabled());
  // 過時數據
  await env.DB.prepare("UPDATE app_settings SET value=?, updated_at=? WHERE key='r2_official_cache'").bind(JSON.stringify({ available: false, reason: "api_error", message: "Cloudflare API 暫時失敗（503）" }), new Date().toISOString()).run();
  await page.reload();
  await page.waitForSelector('[data-testid="r2-summary"]');
  check("官方請求失敗：顯示最後成功數據並標明可能已過時", (await page.getAttribute('[data-testid="r2-usage"]', "data-stale")) === "1" && (await page.locator('[data-testid="r2-stale"]').count()) === 1);

  console.log("直接調色");
  await page.goto(A.base + "/settings/theme");
  await page.click('[data-testid="theme-add"]');
  await page.click('[data-add-from="rose_mulberry"]');
  await page.waitForSelector('[data-testid="theme-editor"]');
  await page.locator('[data-token="card"]').scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => scrollY);
  await page.click('[data-token="card"]');
  const panel = await page.locator('[data-testid="theme-color-panel"]').boundingBox();
  const vh = page.viewportSize().height;
  check("點擊色票立即打開底部調色面板（不需要捲動）", panel && panel.y + panel.height <= vh + 1 && panel.y > vh * 0.3, panel);
  check("面板顯示色票名稱", (await page.textContent('[data-testid="theme-sheet-title"]')) === "卡片背景");
  const nav = await page.evaluate(() => { const p = document.querySelector('[data-testid="theme-color-panel"]').getBoundingClientRect(); const n = document.querySelector("nav.app-tabbar").getBoundingClientRect(); const z = (e) => Number(getComputedStyle(e).zIndex) || 0; return { panelBottom: p.bottom, navTop: n.top, panelZ: z(document.querySelector('[data-testid="theme-color-panel"]')), navZ: z(document.querySelector("nav.app-tabbar")) }; });
  check("調色面板在底部選單之上（不互相遮擋）", nav.panelZ > nav.navZ, nav);
  const prev = await page.locator('[data-testid="theme-preview-panel"]').boundingBox();
  check("上方保留即時預覽", prev && prev.y < panel.y && prev.y + 40 > 0, prev);
  // 單次拖動只產生一筆撤銷
  const hue = await page.locator('[data-testid="theme-hue"]').boundingBox();
  await page.mouse.move(hue.x + 5, hue.y + hue.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(hue.x + 5 + i * (hue.width - 10) / 10, hue.y + hue.height / 2);
  await page.mouse.up();
  const after = await page.inputValue('[data-testid="theme-hex"]');
  check("滑桿拖動即時改變顏色", after !== "#4a2742", after);
  await page.click('[data-testid="theme-sheet-done"]');
  check("完成後返回原本色票位置", Math.abs((await page.evaluate(() => scrollY)) - scrollBefore) < 30);
  await page.click('[data-testid="theme-undo"]');
  const swatch = await page.locator('[data-token="card"] [data-color-swatch]').evaluate((e) => getComputedStyle(e).backgroundColor);
  check("一次完整拖動只需撤銷一次就回到原色", swatch.replace(/\s/g, "") === "rgb(74,39,66)", swatch);
  await page.click('[data-testid="theme-redo"]');
  const swatch2 = await page.locator('[data-token="card"] [data-color-swatch]').evaluate((e) => getComputedStyle(e).backgroundColor);
  check("重做恢復拖動結果", swatch2.replace(/\s/g, "") !== "rgb(74,39,66)", swatch2);
  // 點擊預覽元素
  await page.locator('[data-testid="theme-preview"]').scrollIntoViewIfNeeded();
  await page.click('[data-testid="theme-preview"] .ribbon');
  await page.waitForSelector('[data-testid="theme-pick-choice"]');
  await page.click('[data-pick-token="ribbon"]');
  check("點擊緞帶：選擇面板 → 緞帶背景（進階色票自動切換進階並展開群組）", (await page.getAttribute('[data-testid="theme-color-panel"]', "data-token-edit")) === "ribbon" && (await page.getAttribute('[data-testid="theme-advanced"]', "aria-pressed")) === "true" && (await page.getAttribute('[data-group="decor"]', "data-open")) === "1");
  await shot("03-theme-sheet");
  await page.click('[data-testid="theme-preview"] [data-preview-tab="settings"]').catch(() => page.click('[data-preview-tab="settings"]'));
  await page.click('[data-testid="theme-preview"] a[data-pick="link"]');
  check("點擊預覽連結：直接打開「連結文字」，沒有觸發導航", (await page.getAttribute('[data-testid="theme-color-panel"]', "data-token-edit")) === "link" && page.url().endsWith("/settings/theme"));
  // HEX 輸入、上一項／下一項
  await page.fill('[data-testid="theme-hex"]', "#123456"); await page.locator('[data-testid="theme-hex"]').blur();
  await page.waitForFunction(() => document.querySelector('[data-token="link"] [data-color-swatch]') && getComputedStyle(document.querySelector('[data-token="link"] [data-color-swatch]')).backgroundColor.replace(/\s/g, "") === "rgb(18,52,86)", null, { timeout: 3000 }).catch(() => undefined);
  check("HEX 輸入", (await page.inputValue('[data-testid="theme-hex"]')) === "#123456", [await page.inputValue('[data-testid="theme-hex"]'), await page.getAttribute('[data-testid="theme-color-panel"]', 'data-token-edit')]);
  await page.click('[data-testid="theme-next"]');
  check("下一項", (await page.getAttribute('[data-testid="theme-color-panel"]', "data-token-edit")) !== "link");
  await page.click('[data-testid="theme-sheet-done"]');
  // 基本／進階一致
  await page.click('[data-token="ribbon"]');
  await page.click('[data-testid="theme-sheet-done"]');
  await page.click('[data-testid="theme-basic"]');
  check("切換回基本：不會繼續修改看不見的進階色票", (await page.getAttribute('[data-testid="theme-editor"]', "data-sheet")) === "0" && (await page.locator('[data-token="ribbon"]').count()) === 0);
  // 保存失敗保留草稿
  await page.route("**/api/settings", (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "busy", message: "伺服器忙碌" } }) }) : r.continue());
  await page.fill('[data-testid="theme-name"]', "失敗測試");
  await page.click('[data-testid="theme-save"]');
  await page.waitForSelector('[data-testid="theme-save-error"]');
  check("保存失敗：保留草稿及錯誤提示，可重試", (await page.locator('[data-testid="theme-editor"]').count()) === 1 && (await page.textContent('[data-testid="theme-save"]')).includes("重試"));
  check("保存失敗：不會在本機顯示為已保存", !(await page.evaluate(() => localStorage.getItem("aw:theme") || "")).includes("失敗測試"));
  // 版本衝突
  await page.unroute("**/api/settings");
  await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('theme',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({ v: 2, active: "gothic_violet", custom: [], updated_at: "2099-01-01T00:00:00.000Z" }), new Date().toISOString()).run();
  await page.click('[data-testid="theme-save"]');
  await page.waitForSelector('[data-testid="theme-overwrite"]');
  check("另一部裝置已修改：提示衝突，草稿保留", (await page.locator('[data-testid="theme-editor"]').count()) === 1);
  await page.click('[data-testid="theme-overwrite"]');
  await page.waitForSelector('[data-testid="theme-list"]');
  const st = JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='theme'").first()).value);
  check("明確覆寫後保存（新主題只建立一次）", st.custom.length === 1 && st.custom[0].name === "失敗測試");
  // 手機布局
  for (const w of [320, 375, 430]) {
    await page.setViewportSize({ width: w, height: w === 320 ? 568 : 800 });
    await page.click(`[data-custom-card="${st.custom[0].id}"] [data-testid="theme-edit"]`);
    await page.click('[data-token="bg"]');
    const box = await page.evaluate(() => { const p = document.querySelector('[data-testid="theme-color-panel"]').getBoundingClientRect(); const d = document.querySelector('[data-testid="theme-sheet-done"]').getBoundingClientRect(); return { w: innerWidth, h: innerHeight, pr: p.right, pb: p.bottom, db: d.bottom, dr: d.right }; });
    check(`${w}px：調色面板及完成按鈕完整可見`, box.pr <= box.w + 1 && box.pb <= box.h + 1 && box.db <= box.h && box.dr <= box.w, box);
    if (w === 320) await shot("04-theme-320");
    await page.click('[data-testid="theme-sheet-done"]');
    await page.click('[data-testid="theme-cancel"]');
    await page.waitForSelector('[data-testid="theme-list"]');
  }

  console.log("衣櫃頁首");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(A.base + "/wardrobe");
  await page.waitForSelector('[data-testid="wardrobe-list"]');
  const full = await page.locator('[data-testid="wardrobe-toolbar"]').boundingBox();
  check("頂部完整頁首：有蕾絲，只有衣櫃專用頁首（不顯示全站頁首）", (await page.getAttribute('[data-testid="wardrobe-toolbar"]', "data-collapsed")) === "0" && (await page.getAttribute('[data-testid="wardrobe-toolbar"]', "class")).includes("lace-b") && (await page.locator("header.app-header").count()) === 0);
  await shot("05-wardrobe-full");
  const firstTop0 = await page.locator('[data-gid="gar_h010"]').evaluate((e) => e.getBoundingClientRect().top + scrollY);
  await page.mouse.wheel(0, 900); await page.waitForTimeout(400);
  const small = await page.locator('[data-testid="wardrobe-toolbar"]').boundingBox();
  check("向下滑動：收合（100–125px）", (await page.getAttribute('[data-testid="wardrobe-toolbar"]', "data-collapsed")) === "1" && small.height >= 85 && small.height <= 125 && small.y < 2, small);
  const firstTop1 = await page.locator('[data-gid="gar_h010"]').evaluate((e) => e.getBoundingClientRect().top + scrollY);
  check("收合時衣物清單不跳位（文件位置不變）", Math.abs(firstTop0 - firstTop1) < 1, [firstTop0, firstTop1]);
  check("收合時保留搜尋、篩選、更多及主分類", await page.locator('[data-testid="wardrobe-search"]').isVisible() && await page.locator('[data-testid="wardrobe-filter"]').isVisible() && await page.locator('[data-testid="wardrobe-more"]').isVisible() && await page.locator('[data-cat="連身裙"]').isVisible());
  await shot("06-wardrobe-collapsed");
  await page.mouse.wheel(0, -200); await page.waitForTimeout(400);
  check("向上滑動：展開", (await page.getAttribute('[data-testid="wardrobe-toolbar"]', "data-collapsed")) === "0");
  await page.mouse.wheel(0, 900); await page.waitForTimeout(300);
  // 彈層不受頁首裁切
  await page.click('[data-testid="wardrobe-display"]');
  const pop = await page.locator('[data-testid="wardrobe-display-pop"]').boundingBox();
  check("顯示設定彈層完整可見（不受固定頁首裁切）", pop && pop.y + pop.height <= page.viewportSize().height && (await page.locator('[data-testid="wardrobe-display-pop"] [data-cols="5"]').isVisible()), pop);
  await page.click('[data-cols="2"]');
  await page.click('[data-testid="wardrobe-display"]');
  await page.click('[data-testid="wardrobe-filter"]');
  check("篩選以底部面板顯示（不受固定頁首裁切）", await page.locator('[data-testid="wardrobe-filters"]').isVisible());
  await page.click('[data-testid="wardrobe-filters-done"]');
  // 子分類
  await page.click('[data-cat="連身裙"]');
  await page.waitForSelector('[data-testid="wardrobe-subs"]');
  check("選擇主分類後才顯示子分類", (await page.locator('[data-testid="wardrobe-subs"] [data-sub]').count()) === 3);
  await page.click('[data-sub="JSK"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="wardrobe-count"]')?.textContent.includes("JSK 15 件"));
  check("子分類篩選", true);
  for (const w of [320, 375, 390, 430]) {
    await page.setViewportSize({ width: w, height: 700 });
    await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(150);
    const h = await page.evaluate(() => { const b = document.querySelector('[data-testid="wardrobe-toolbar"]'); const r = b.getBoundingClientRect(); return { right: r.right, w: innerWidth, overflow: document.documentElement.scrollWidth - innerWidth, h: r.height }; });
    check(`${w}px：頁首沒有溢出`, h.right <= h.w + 1 && h.overflow <= 1, h);
  }

  console.log("本機同步狀態");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(A.base + "/wardrobe");
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="wardrobe-list"]')?.dataset.total) === 60);
  // 模擬 iOS 只清除了本機衣物資料（同步紀錄仍在）：不可一直顯示 0 件
  await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("aw-local-tester"); r.onsuccess = () => { const t = r.result.transaction("garments", "readwrite"); t.objectStore("garments").clear(); t.oncomplete = () => { r.result.close(); res(); }; }; }));
  await page.reload();
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="wardrobe-list"]')?.dataset.total) === 60, null, { timeout: 15000 }).catch(() => undefined);
  check("本機衣物資料被清空但同步紀錄仍在：重新同步，不顯示 0 件", Number(await page.getAttribute('[data-testid="wardrobe-list"]', "data-total")) === 60);
  // 第一次載入（沒有本機資料）＋網絡失敗：顯示讀取失敗及重試，不顯示成空衣櫃
  await page.evaluate(async () => { for (const d of await indexedDB.databases()) indexedDB.deleteDatabase(d.name); });
  await page.route("**/api/sync/**", (r) => r.abort());
  await page.route("**/api/garments?**", (r) => r.abort());
  await page.reload();
  await page.waitForSelector('[data-testid="wardrobe-load-error"]', { timeout: 15000 }).catch(() => undefined);
  check("讀取失敗與真正沒有衣服分開顯示", (await page.locator('[data-testid="wardrobe-load-error"]').count()) === 1 && (await page.locator("text=沒有符合的衣物").count()) === 0);
  await page.unroute("**/api/sync/**"); await page.unroute("**/api/garments?**");
  await page.click('[data-testid="wardrobe-load-error"] button');
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="wardrobe-list"]')?.dataset.total) === 60, null, { timeout: 15000 }).catch(() => undefined);
  check("網絡恢復後按重試：正常顯示全部衣物", Number(await page.getAttribute('[data-testid="wardrobe-list"]', "data-total")) === 60);
  const errs = A.errors.filter((e) => !/net::ERR_FAILED|Failed to fetch|讀取失敗|本機衣櫃失敗/.test(e));
  check("沒有瀏覽器錯誤", errs.length === 0, errs);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  await A.close();
  done();
}
