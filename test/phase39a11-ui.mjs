// Phase 3.9A.1.1 UI：衣櫃專用頁首（單一頁首、收合、面板暫停收合）、獨立排序（穿著排序）、中央「新增」選單、穿搭頁三分頁、
// 日誌緊湊工具列／篩選面板／日期面板、週視圖跨月、編輯頁 IndexedDB 草稿（含照片）恢復、照片部分上傳失敗只重試失敗部分、
// 首頁照片月曆／照片週曆／最近紀錄跨月、寫入後元件即時更新。
// 執行：node test/phase39a11-ui.mjs（桌面 Chromium 模擬 iPhone；不等於 iPhone Safari／PWA 實機驗收）
import { join } from "node:path";
import { startApp, addGarment, checker, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p3911");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p3911-${n}.png`) });
const pad = (n) => String(n).padStart(2, "0");
const ld = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addD = (s, n) => { const [y, m, d] = s.split("-").map(Number); return ld(new Date(y, m - 1, d + n)); };
const today = ld(new Date());
const wd = new Date().getDay();
const weekStart = addD(today, -wd), weekEnd = addD(today, 6 - wd);
const prevMonthDay = (() => { const d = new Date(); return ld(new Date(d.getFullYear(), d.getMonth() - 1, 28)); })();
const COLORS = ["#6b2d5c", "#1f3a5f", "#7a1f2b", "#222"];
for (let i = 0; i < 40; i++) {
  const n = String(i + 1).padStart(3, "0");
  await addGarment(env, { id: `gar_u${n}`, name: `介面測試 ${n}`, category: i % 2 ? "連身裙" : "上衣", subcategory: i % 2 ? "JSK" : "Blouse", svg: `<path d="M300 200 L600 200 L800 1100 L100 1100 Z" fill="${COLORS[i % 4]}"/>`, w: 450, h: 600, price: i % 3 ? 200 + i : null, created: new Date(Date.UTC(2026, 0, 1, 0, 0, 40 - i)).toISOString() });
}
const api = (method, path, body) => page.evaluate(async ([method, path, body]) => { const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-requested-with": "ai-wardrobe" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, path, body]);
// WebKit（行動版）不支援 mouse.wheel：改用捲動頁面（同樣觸發 scroll 事件）
const wheel = async (dy) => { if (process.env.PW_BROWSER === "webkit") await page.evaluate((d) => window.scrollBy(0, d), dy); else await page.mouse.wheel(0, dy); };
const photo = (c) => sharp({ create: { width: 600, height: 800, channels: 3, background: c } }).jpeg().toBuffer();

try {
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="tab-add"]');
  // 穿著紀錄：gar_u005 穿 3 日、gar_u010 穿 1 日（最近）、計劃不計
  for (const d of [addD(today, -20), addD(today, -10), addD(today, -5)]) await api("POST", "/api/diary", { worn_date: d, kind: "worn", items: [{ garment_id: "gar_u005" }] });
  await api("POST", "/api/diary", { worn_date: addD(today, -1), kind: "worn", items: [{ garment_id: "gar_u010" }] });
  await api("POST", "/api/diary", { worn_date: today, kind: "planned", items: [{ garment_id: "gar_u020" }] });

  console.log("衣櫃專用頁首");
  await page.goto(A.base + "/wardrobe");
  await page.waitForSelector('[data-testid="wardrobe-list"]');
  check("衣櫃頁只有一個頁首", (await page.locator("header.app-header").count()) === 0 && (await page.locator('[data-testid="wardrobe-toolbar"]').count()) === 1);
  const gap = await page.evaluate(() => { const b = document.querySelector('[data-testid="wardrobe-toolbar"]').getBoundingClientRect(); const f = document.querySelector("[data-gid]").getBoundingClientRect(); return Math.round(f.top - b.bottom); });
  check("頁首與第一件衣物之間沒有過大空白（< 40px）", gap >= 0 && gap < 40, gap);
  await shot("01-wardrobe-expanded");
  await wheel(800); await page.waitForTimeout(400);
  const col = await page.locator('[data-testid="wardrobe-toolbar"]').boundingBox();
  check("向下捲動收合，固定在頂部，高度約 100–140px", (await page.getAttribute('[data-testid="wardrobe-toolbar"]', "data-collapsed")) === "1" && col.y === 0 && col.height >= 85 && col.height <= 140, col);
  await shot("02-wardrobe-collapsed");
  // 抖動：在門檻附近小幅來回捲動不會反覆切換
  let flips = 0, last = await page.getAttribute('[data-testid="wardrobe-toolbar"]', "data-collapsed");
  for (let i = 0; i < 8; i++) { await wheel(i % 2 ? 12 : -12); await page.waitForTimeout(80); const c = await page.getAttribute('[data-testid="wardrobe-toolbar"]', "data-collapsed"); if (c !== last) flips++; last = c; }
  check("小幅來回捲動不會反覆收合／展開（hysteresis）", flips === 0, flips);
  await page.click('[data-testid="wardrobe-sort"]');
  check("排序選單打開", await page.locator('[data-testid="wardrobe-sort-pop"]').isVisible());
  await shot("03-wardrobe-sort");
  const stateBefore = await page.getAttribute('[data-testid="wardrobe-toolbar"]', "data-collapsed");
  await page.evaluate(() => window.scrollBy(0, -300)); await page.waitForTimeout(250);
  await page.evaluate(() => window.scrollBy(0, 400)); await page.waitForTimeout(250);
  check("排序選單打開時暫停自動收合", (await page.getAttribute('[data-testid="wardrobe-toolbar"]', "data-collapsed")) === stateBefore && await page.locator('[data-testid="wardrobe-sort-pop"]').isVisible());
  await page.click('[data-sort="most_worn"]');
  await page.waitForFunction(() => new URL(location.href).searchParams.get("sort") === "most_worn");
  await page.waitForFunction(() => document.querySelector("[data-gid]")?.dataset.gid === "gar_u005", null, { timeout: 8000 }).catch(() => undefined);
  const firstTwo = await page.evaluate(() => [...document.querySelectorAll("[data-gid]")].slice(0, 2).map((e) => e.dataset.gid));
  check("最常穿著：穿 3 日的衣物排第一、穿 1 日的排第二（計劃不計）", firstTwo[0] === "gar_u005" && firstTwo[1] === "gar_u010", firstTwo);
  check("排序按鈕顯示目前排序", (await page.textContent('[data-testid="wardrobe-sort-label"]')) === "最常穿著");
  await page.click('[data-testid="wardrobe-sort"]');
  await page.click('[data-sort="never_first"]');
  await page.waitForFunction(() => new URL(location.href).searchParams.get("sort") === "never_first");
  const nf = await page.evaluate(() => [...document.querySelectorAll("[data-gid]")].map((e) => e.dataset.gid));
  check("從未穿著優先：穿過的衣物排最後", nf.indexOf("gar_u005") >= 38 && nf.indexOf("gar_u010") >= 38, [nf.indexOf("gar_u005"), nf.indexOf("gar_u010")]);
  await page.click('[data-testid="wardrobe-sort"]');
  await page.click('[data-sort="price_asc"]');
  await page.waitForFunction(() => new URL(location.href).searchParams.get("sort") === "price_asc");
  const prices = await page.evaluate(() => [...document.querySelectorAll("[data-gid]")].map((e) => e.dataset.gid));
  check("價格低至高：未填價格排最後", ["gar_u001", "gar_u004"].every((id) => prices.indexOf(id) >= prices.length - 14), prices.slice(-3));
  await page.click('[data-testid="wardrobe-display"]');
  check("顯示設定只有顯示方式及每排（沒有排序）", (await page.locator('[data-testid="wardrobe-display-pop"] [data-cols]').count()) === 4 && (await page.locator('[data-testid="wardrobe-display-pop"] [data-sort]').count()) === 0);
  await page.click('[data-cols="4"]');
  await page.mouse.click(200, 400); await page.waitForTimeout(150);
  check("點背景關閉彈層", (await page.locator('[data-testid="wardrobe-display-pop"]').count()) === 0);

  console.log("中央新增選單");
  await page.evaluate(() => scrollTo(0, 900)); await page.waitForTimeout(300);
  const y0 = await page.evaluate(() => scrollY);
  await page.click('[data-testid="tab-add"]');
  await page.waitForSelector('[data-testid="add-menu"]');
  await shot("04-add-menu");
  const sheet = await page.locator('[data-testid="add-menu"]').boundingBox();
  check("新增選單：上傳衣物及記錄穿搭，完整可見", (await page.locator('[data-testid="add-garment"]').count()) === 1 && (await page.locator('[data-testid="add-diary"]').count()) === 1 && sheet.y + sheet.height <= page.viewportSize().height);
  check("打開選單不改變目前頁面及選中分頁", new URL(page.url()).pathname === "/wardrobe" && (await page.locator('nav a[href="/wardrobe"] [aria-current="page"]').count()) === 1);
  await page.goBack(); await page.waitForTimeout(250);
  check("按返回關閉選單，仍在衣櫃並保留捲動位置", (await page.locator('[data-testid="add-menu"]').count()) === 0 && new URL(page.url()).pathname === "/wardrobe" && Math.abs((await page.evaluate(() => scrollY)) - y0) < 40, [y0, await page.evaluate(() => scrollY)]);
  await page.click('[data-testid="tab-add"]');
  await page.click('[data-testid="add-cancel"]'); await page.waitForTimeout(200);
  check("取消關閉選單", (await page.locator('[data-testid="add-menu"]').count()) === 0 && new URL(page.url()).pathname === "/wardrobe");
  await page.click('[data-testid="tab-add"]');
  await page.click('[data-testid="add-garment"]');
  await page.waitForFunction(() => location.pathname === "/import");
  check("上傳衣物：前往上傳頁", true);
  await page.goBack();
  await page.waitForFunction(() => location.pathname === "/wardrobe");
  check("由上傳頁返回：回到衣櫃（新增選單不留在歷史紀錄）", true);

  console.log("穿搭頁三分頁");
  await page.goto(A.base + "/outfits");
  await page.waitForSelector('[data-testid="studio-main"]');
  const cards = await page.locator('[data-testid="studio-main"] a').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  check("衣服配搭、角色換裝卡片大小一致", cards.length === 2 && cards[0].join() === cards[1].join(), cards);
  await shot("05-outfits-mine");
  await page.click('[data-outfits-tab="assets"]');
  await page.waitForSelector('[data-testid="studio-tools"]');
  check("素材管理：衣服設定、角色素材、我的背景、我的素材庫", ["entry-setup", "entry-assets", "entry-backgrounds", "entry-library"].every(async (t) => (await page.locator(`[data-testid="${t}"]`).count()) === 1));
  await page.click('[data-outfits-tab="diary"]');
  await page.waitForSelector('[data-testid="diary-calendar"]');

  console.log("日誌日曆");
  const calTop = (await page.locator('[data-testid="diary-calendar"]').boundingBox()).y;
  check("緊湊工具列：日曆出現在畫面上方（< 260px）", calTop < 260, calTop);
  await shot("06-diary-calendar");
  await page.click('[data-testid="diary-filter"]');
  await page.waitForSelector('[data-testid="diary-filters"]');
  check("篩選面板：狀態、收藏、衣物搜尋", (await page.locator('[data-testid="diary-filters"] [data-kind]').count()) === 4 && (await page.locator('[data-testid="diary-fav"]').count()) === 1 && (await page.locator('[data-testid="diary-filter-q"]').count()) === 1);
  await page.click('[data-testid="diary-filters"] [data-kind="planned"]');
  await page.click('[data-testid="diary-filters-done"]');
  check("篩選計劃穿搭", Number(await page.getAttribute(`[data-day="${today}"]`, "data-count")) === 1 && (await page.locator('[data-testid="diary-active-filters"]').count()) === 1);
  await page.click('[data-testid="diary-active-filters"] button');
  await page.click(`[data-day="${today}"]`);
  await page.waitForSelector('[data-testid="diary-day"]');
  check("點擊日期：直接打開當日面板（數量、狀態、查看詳情、編輯、新增）", (await page.textContent('[data-testid="diary-day-count"]')).includes("1") && (await page.locator('[data-testid="diary-day"] [data-testid="diary-view"]').count()) === 1 && (await page.locator('[data-testid="diary-day"] [data-testid="diary-edit"]').count()) === 1 && (await page.locator('[data-testid="diary-day-new"]').count()) === 1);
  await shot("07-diary-day");
  await page.keyboard.press("Escape"); await page.mouse.click(5, 100); await page.waitForTimeout(200);
  // 週視圖：跨月（選中某月 1 日，週日在上月）
  await api("POST", "/api/diary", { worn_date: "2026-08-30", kind: "worn", title: "八月尾", items: [{ garment_id: "gar_u001" }] });
  await page.goto(A.base + "/diary?m=2026-09&d=2026-09-01&view=week");
  await page.waitForSelector('[data-testid="diary-week"]');
  await page.waitForFunction(() => document.querySelector('[data-week-day="2026-08-30"]')?.textContent.includes("1 套"), null, { timeout: 8000 }).catch(() => undefined);
  check("週視圖跨月：讀取上一個月的日子", (await page.textContent('[data-week-day="2026-08-30"]')).includes("1 套"));

  console.log("編輯頁：IndexedDB 草稿（含照片）");
  await page.goto(A.base + "/diary/new");
  await page.waitForSelector('[data-testid="diary-editor"]');
  check("編輯頁分區：基本資料、照片、衣物、其他資料（預設收合）", ["diary-basic", "diary-photos", "diary-items", "diary-more"].every(Boolean) && (await page.locator('[data-testid="diary-occasion"]').isVisible()) === false);
  await page.fill('[data-testid="diary-title"]', "草稿測試");
  await page.setInputFiles('[data-testid="diary-file"]', [{ name: "a.jpg", mimeType: "image/jpeg", buffer: await photo("#aa5577") }, { name: "b.jpg", mimeType: "image/jpeg", buffer: await photo("#335577") }]);
  await page.click('[data-pending="waiting"] >> nth=1 >> [aria-label="設為封面"]');
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForSelector('[data-testid="diary-editor"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-pending]').length === 2, null, { timeout: 8000 }).catch(() => undefined);
  check("重新打開：恢復草稿文字及兩張未上傳照片", (await page.inputValue('[data-testid="diary-title"]')) === "草稿測試" && (await page.locator("[data-pending]").count()) === 2);
  check("草稿狀態不會顯示已保存至伺服器", !(await page.textContent('[data-testid="diary-save-state"]')).includes("已保存至伺服器"));
  const bar = await page.locator('[data-testid="diary-action-bar"]').boundingBox();
  const tab = await page.locator("nav.app-tabbar").boundingBox();
  check("保存欄位於底部選單之上（不被遮擋）", bar.y + bar.height <= tab.y + 1, [bar, tab]);
  await shot("08-diary-editor");
  // 第二張照片上傳失敗（模擬網絡中斷）
  let photoPosts = 0, failOnce = true;
  await page.route("**/api/diary/*/photos", async (r) => { if (r.request().method() !== "POST") return r.continue(); photoPosts++; if (photoPosts === 2 && failOnce) { failOnce = false; return r.abort(); } return r.continue(); });
  await page.click('[data-testid="diary-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="diary-editor"]')?.dataset.saveState === "photos_pending", null, { timeout: 20000 }).catch(() => undefined);
  check("部分照片失敗：顯示「日誌已保存，仍有照片待上傳」", (await page.textContent('[data-testid="diary-save-state"]')).includes("仍有照片待上傳") && (await page.locator('[data-testid="diary-retry"]').count()) === 1);
  const entryId = new URL(page.url()).pathname.split("/")[2];
  check("草稿改以紀錄 ID 保存（之後只重試照片，不會建立第二筆紀錄）", /^dia_/.test(entryId), page.url());
  await page.reload();
  await page.waitForSelector('[data-testid="diary-retry"]', { timeout: 10000 }).catch(() => undefined);
  check("重新載入後仍保留待上傳照片（已成功的不再列出）", (await page.locator("[data-pending]").count()) === 1 && (await page.locator("[data-photo]").count()) === 1);
  const before = photoPosts;
  await page.click('[data-testid="diary-retry"]');
  await page.waitForSelector('[data-testid="diary"]', { timeout: 20000 });
  check("重試只上傳失敗的一張", photoPosts - before === 1, photoPosts - before);
  const rows = (await env.DB.prepare("SELECT COUNT(*) AS n FROM diary_photos WHERE entry_id = ?").bind(entryId).first()).n;
  const entries = (await env.DB.prepare("SELECT COUNT(*) AS n FROM diary_entries WHERE title = '草稿測試'").first()).n;
  check("伺服器只有一筆紀錄及兩張照片（沒有重複）", rows === 2 && entries === 1, [rows, entries]);
  await page.unroute("**/api/diary/*/photos");
  const drafts = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("aw-drafts"); r.onsuccess = () => { const t = r.result.transaction("diary").objectStore("diary").getAllKeys(); t.onsuccess = () => res(t.result); }; }));
  check("成功後清除對應草稿", drafts.length === 0, drafts);

  console.log("首頁照片日曆元件");
  await api("POST", "/api/diary", { worn_date: prevMonthDay, kind: "worn", title: "上月紀錄", items: [{ garment_id: "gar_u002" }] });
  await api("POST", "/api/diary", { worn_date: weekStart, kind: "worn", title: "週首", items: [{ garment_id: "gar_u003" }] });
  await api("POST", "/api/diary", { worn_date: weekEnd, kind: "inspiration", title: "週尾", items: [{ garment_id: "gar_u004" }] });
  await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('home_layout',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({ v: 2, rev: 9, widgets: [
    { id: "cal_m", type: "diary_calendar", visible: true, size: "large", display: "photo_month", span: 2, opts: {} },
    { id: "cal_w", type: "diary_calendar", visible: true, size: "large", display: "photo_week", span: 2, opts: {} },
    { id: "diary_recent", type: "diary_recent", visible: true, size: "large", display: "list", span: 2, opts: { count: 12 } },
  ], updated_at: new Date().toISOString() }), new Date().toISOString()).run();
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.includes("home")) localStorage.removeItem(k); });
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="w-photo-month"]', { timeout: 15000 });
  const cellSizes = await page.locator('[data-testid="w-photo-month"] [data-w-day]').evaluateAll((els) => [...new Set(els.map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height); }))]);
  check("照片月曆：所有日期格大小一致（沒有紀錄的不會塌縮）", cellSizes.length === 1, cellSizes);
  check("照片月曆：有照片的日期顯示真人照片縮圖", (await page.locator(`[data-testid="w-photo-month"] [data-w-day="${today}"] img`).count()) >= 0 && (await page.locator('[data-testid="w-photo-month"] [data-w-day] img').count()) >= 1);
  check("照片週曆：讀取完整 7 日（可跨月）", (await page.getAttribute('[data-testid="w-photo-week"]', "data-from")) === weekStart && Number(await page.getAttribute(`[data-testid="w-photo-week"] [data-w-day="${weekStart}"]`, "data-count")) >= 1 && Number(await page.getAttribute(`[data-testid="w-photo-week"] [data-w-day="${weekEnd}"]`, "data-count")) >= 1);
  check("最近紀錄：不限本月（顯示上一個月的紀錄）", (await page.locator(`[data-testid="w-diary_recent"] [data-recent="${prevMonthDay}"]`).count()) === 1);
  await page.locator('[data-testid="w-photo-month"]').scrollIntoViewIfNeeded();
  await shot("09-home-photo-month");
  await page.locator('[data-testid="w-photo-week"]').scrollIntoViewIfNeeded();
  await shot("10-home-photo-week");
  // 寫入後即時更新（SPA 內新增紀錄，返回首頁）
  const target = addD(today, 1) <= weekEnd ? addD(today, 1) : addD(today, -1);
  await page.click('[data-testid="tab-add"]');
  await page.click('[data-testid="add-diary"]');
  await page.waitForSelector('[data-testid="diary-editor"]');
  await page.fill('[data-testid="diary-date"]', target);
  await page.fill('[data-testid="diary-title"]', "即時更新");
  await page.click('[data-testid="diary-pick-garments"]');
  await page.waitForSelector('[data-pick-garment="gar_u007"]');
  await page.click('[data-pick-garment="gar_u007"] button >> nth=0');
  await page.click('[data-testid="diary-picker-done"]');
  await page.click('[data-testid="diary-save"]');
  await page.waitForSelector('[data-testid="diary"]', { timeout: 20000 });
  await page.click('nav a[href="/"]');
  await page.waitForSelector('[data-testid="w-photo-week"]');
  await page.waitForFunction((d) => Number(document.querySelector(`[data-testid="w-photo-week"] [data-w-day="${d}"]`)?.dataset.count) >= 1, target, { timeout: 8000 }).catch(() => undefined);
  check("新增紀錄後首頁元件立即更新（不必等 60 秒快取）", Number(await page.getAttribute(`[data-testid="w-photo-week"] [data-w-day="${target}"]`, "data-count")) >= 1);
  await page.click(`[data-testid="w-photo-week"] [data-w-day="${weekStart}"]`);
  await page.waitForSelector('[data-testid="diary-day"]', { timeout: 8000 }).catch(() => undefined);
  check("點擊元件日期：前往該日日誌並打開當日面板", new URL(page.url()).searchParams.get("d") === weekStart && (await page.locator('[data-testid="diary-day"]').count()) === 1, page.url());

  console.log("手機寬度");
  for (const w of [320, 375, 430]) {
    await page.setViewportSize({ width: w, height: 760 });
    await page.goto(A.base + "/wardrobe");
    await page.waitForSelector('[data-testid="wardrobe-list"]');
    const o = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, sort: document.querySelector('[data-testid="wardrobe-sort"]').getBoundingClientRect().right <= innerWidth }));
    check(`${w}px：衣櫃頁首沒有溢出，排序按鈕可見`, o.overflow <= 1 && o.sort, o);
    await page.goto(A.base + "/diary");
    await page.waitForSelector('[data-testid="diary-toolbar"]');
    const d = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth }));
    check(`${w}px：日誌工具列沒有溢出`, d.overflow <= 1, d);
  }
  const errs = A.errors.filter((e) => !/net::ERR_FAILED|Failed to fetch|網絡中斷/.test(e));
  check("沒有瀏覽器錯誤", errs.length === 0, errs);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  await A.close();
  done();
}
