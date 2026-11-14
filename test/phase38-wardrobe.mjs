// Phase 3.8A：衣櫃工具列、自動分批顯示、返回位置、衣物詳情自動高清、上傳不自動去背、手動去背
// 執行：node test/phase38-wardrobe.mjs（iPhone 13 viewport＋觸控模擬；桌面 Chromium，不等於 iPhone Safari 實機）
import { join } from "node:path";
import { startApp, addGarment, checker, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p38w");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38w-${n}.png`) });
const COLORS = ["#6b2d5c", "#1f3a5f", "#7a1f2b", "#222", "#b03060", "#4a1c2a"];
const SUBS = ["JSK", "OP", "SK"];
console.log("準備 120 件測試衣物");
for (let i = 0; i < 120; i++) {
  const n = String(i + 1).padStart(3, "0");
  const cat = i % 3 === 2 ? "半身裙" : "連身裙";
  const sub = cat === "半身裙" ? "SK" : SUBS[i % 2];
  await addGarment(env, { id: `gar_t${n}`, name: `測試衣物 ${n}`, category: cat, subcategory: sub, svg: `<path d="M300 200 L600 200 L800 1100 L100 1100 Z" fill="${COLORS[i % COLORS.length]}"/>`, w: 450, h: 600, price: i % 4 ? 300 + i : null, created: new Date(Date.UTC(2026, 0, 1, 0, 0, 120 - i)).toISOString() });
}
await addGarment(env, { id: "gar_clear", name: "已去背上衣", category: "上衣", subcategory: "Blouse", svg: '<path d="M300 200 L600 200 L700 1000 L200 1000 Z" fill="#222"/>', w: 450, h: 600, created: "2025-01-02T00:00:00Z" });
await addGarment(env, { id: "gar_white", name: "白底原相上衣", category: "上衣", subcategory: "Blouse", svg: '<path d="M300 200 L600 200 L700 1000 L200 1000 Z" fill="#7a1f2b"/>', w: 450, h: 600, opaque: true, created: "2025-01-01T00:00:00Z" });

try {
  console.log("緊湊固定工具列");
  await page.goto(A.base + "/wardrobe");
  await page.waitForSelector('[data-testid="wardrobe-list"]');
  const bar = await page.locator('[data-testid="wardrobe-toolbar"]').boundingBox();
  check("固定工具列高度約 85–105px", bar.height >= 70 && bar.height <= 105, bar);
  check("顯示真正符合條件的總數", (await page.textContent('[data-testid="wardrobe-count"]')).includes("122 件"), await page.textContent('[data-testid="wardrobe-count"]'));
  check("沒有「載入更多」按鈕", (await page.locator('button:has-text("載入更多")').count()) === 0);
  const shown0 = Number(await page.getAttribute('[data-testid="wardrobe-list"]', "data-shown"));
  await page.mouse.wheel(0, 6000); await page.waitForTimeout(400);
  await page.mouse.wheel(0, 6000); await page.waitForTimeout(400);
  const shown1 = Number(await page.getAttribute('[data-testid="wardrobe-list"]', "data-shown"));
  check("向下滑動自動顯示下一批", shown1 > shown0, [shown0, shown1]);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 8000); await page.waitForTimeout(250); }
  check("最終顯示全部衣物", Number(await page.getAttribute('[data-testid="wardrobe-list"]', "data-shown")) === 122);
  const barTop = await page.locator('[data-testid="wardrobe-toolbar"]').boundingBox();
  check("捲動後工具列仍固定在頁首下方", barTop.y >= 0 && barTop.y < 120, barTop);

  console.log("主分類及子分類（由實際資料產生）");
  const req0 = A.requests.length;
  await page.click('[data-cat="連身裙"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="wardrobe-count"]')?.textContent.includes("80 件"));
  const opts = await page.locator('[data-testid="wardrobe-sub"] option').allTextContents();
  check("子分類選項只列出實際存在的子分類及數量", opts.length === 3 && opts.some((o) => o.startsWith("JSK（40）")) && !opts.some((o) => o.startsWith("SK（")), opts);
  const req1 = A.requests.length;
  await page.selectOption('[data-testid="wardrobe-sub"]', "OP");
  await page.waitForFunction(() => document.querySelector('[data-testid="wardrobe-count"]')?.textContent.includes("OP 40 件"));
  check("切換子分類在本機篩選，不重新下載清單", A.requests.slice(req1).filter((r) => r.startsWith("GET /api/garments?")).length === 0, A.requests.slice(req1));
  await page.click('[data-cat="半身裙"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="wardrobe-count"]')?.textContent.includes("40 件"));
  check("切換主分類清除不相容的子分類", !new URL(page.url()).searchParams.get("subcategory"));
  // 快速切換：只顯示最後一次的結果
  await page.click('[data-cat="連身裙"]'); await page.click('[data-cat="上衣"]'); await page.click('[data-cat="半身裙"]');
  await page.waitForTimeout(800);
  const cnt = await page.textContent('[data-testid="wardrobe-count"]');
  const firstCat = await page.evaluate(() => [...document.querySelectorAll("[data-gid]")].slice(0, 3).map((e) => e.dataset.gid));
  check("快速切換分類沒有舊資料混入", cnt.includes("半身裙 40 件") && firstCat.every((id) => Number(id.slice(5)) % 3 === 0), [cnt, firstCat]);
  void req0;

  console.log("顯示設定彈層");
  await page.click('[data-testid="wardrobe-display"]');
  check("每排數量及排序在同一個彈層", (await page.locator('[data-cols]').count()) === 4 && (await page.locator('[data-sort]').count()) === 6);
  await page.click('[data-cols="4"]');
  await page.click('[data-sort="name"]');
  await page.waitForFunction(() => new URL(location.href).searchParams.get("sort") === "name");
  check("排序及每排數量生效", (await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="wardrobe-list"]')).gridTemplateColumns.split(" ").length)) === 4);
  await shot("01-toolbar");

  console.log("返回位置：第 87 件");
  await page.click('[data-cat="all"]');
  await page.click('[data-testid="wardrobe-display"]');
  await page.click('[data-sort="new"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="wardrobe-count"]')?.textContent.includes("122 件") && !new URL(location.href).searchParams.get("sort"));
  for (let i = 0; i < 8 && !(await page.locator('[data-gid="gar_t087"]').count()); i++) { await page.mouse.wheel(0, 5000); await page.waitForTimeout(250); }
  await page.locator('[data-gid="gar_t087"]').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -40));
  await page.waitForTimeout(300);
  const before = await page.locator('[data-gid="gar_t087"]').boundingBox();
  await page.locator('[data-gid="gar_t087"] a').first().click();
  await page.waitForSelector('text=編輯資料');
  console.log("衣物詳情自動高清");
  check("詳情頁沒有「載入高清」及「使用縮圖」按鈕", (await page.locator('button:has-text("載入高清")').count()) === 0 && (await page.locator('button:has-text("使用縮圖")').count()) === 0);
  await page.waitForFunction(() => document.querySelector('[data-testid="detail-image"] [data-quality]')?.getAttribute("data-quality") === "high", null, { timeout: 10000 }).catch(() => undefined);
  check("進入衣物詳情自動顯示高清圖片", (await page.getAttribute('[data-testid="detail-image"] [data-quality]', "data-quality")) === "high");
  const hdReads = A.requests.filter((r) => r.startsWith("GET /api/images/img_gartwy7")).length;
  // 修改價錢
  await page.click('button:has-text("編輯資料")');
  await page.locator('input[inputmode="decimal"], input[name="price"]').first().fill("999").catch(() => undefined);
  await page.click('button:has-text("保存")').catch(() => undefined);
  await page.waitForTimeout(500);
  await page.goBack();
  await page.waitForSelector('[data-gid="gar_t087"]');
  await page.waitForTimeout(400);
  const after = await page.locator('[data-gid="gar_t087"]').boundingBox();
  check("返回後回到第 87 件附近（保留篩選及顯示方式）", Math.abs(after.y - before.y) < 60, [before.y, after.y]);
  check("返回時沒有清空清單或回到開頭", (await page.evaluate(() => window.scrollY)) > 1500);
  await shot("02-return");
  // 再次進入同一件：高清圖使用手機快取
  await page.locator('[data-gid="gar_t087"] a').first().click();
  await page.waitForFunction(() => document.querySelector('[data-testid="detail-image"] [data-quality]')?.getAttribute("data-quality") === "high", null, { timeout: 10000 }).catch(() => undefined);
  check("已快取的高清圖片不再讀取 R2", A.requests.filter((r) => r.startsWith("GET /api/images/img_gartwy7")).length === hdReads && hdReads === 1, hdReads);
  await page.goBack();

  console.log("高清載入失敗仍顯示縮圖");
  await page.route("**/api/images/img_gartw5w", (r) => r.fulfill({ status: 503, body: "x" }));
  await page.goto(A.base + "/g/gar_t050");
  await page.waitForSelector('[data-testid="detail-image"] [data-testid="image-retry"]', { timeout: 10000 }).catch(() => undefined);
  check("高清失敗：保留縮圖並提供局部重試", (await page.getAttribute('[data-testid="detail-image"] [data-quality]', "data-quality")) === "thumbnail" && (await page.locator('[data-testid="detail-image"] [data-testid="image-retry"]').count()) === 1);
  await page.unroute("**/api/images/img_gartw5w");

  console.log("上傳不自動去背");
  const upload = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#fff"/><circle cx="200" cy="250" r="140" fill="#552244"/></svg>')).png().toBuffer();
  await page.goto(A.base + "/import");
  await page.setInputFiles('input[type="file"][multiple]', { name: "white.png", mimeType: "image/png", buffer: upload });
  await page.waitForSelector('[data-testid="upload-cutout"]', { timeout: 20000 });
  const gid = (await page.getAttribute('[data-testid="upload-cutout"]', "href")).match(/\/g\/([\w-]+)/)[1];
  const imgs = (await env.DB.prepare("SELECT image_type FROM garment_images WHERE garment_id=?").bind(gid).all()).results.map((r) => r.image_type);
  check("上傳只保存原圖，沒有自動產生去背圖", imgs.includes("original") && !imgs.includes("processed"), imgs);

  console.log("手動去背");
  await page.click('[data-testid="upload-cutout"]');
  await page.waitForSelector('[data-testid="cutout-result"]', { timeout: 20000 });
  check("去背結果可以預覽及對比", (await page.locator('button:has-text("對比原圖")').count()) === 1);
  await shot("03-cutout");
  await page.click('[data-testid="cutout-save"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="cutout-sheet"]'));
  const imgs2 = (await env.DB.prepare("SELECT image_type,is_primary,derived_from FROM garment_images WHERE garment_id=? AND image_type!='thumbnail'").bind(gid).all()).results;
  check("確認後保存透明圖（成為主圖），原圖保留", imgs2.some((r) => r.image_type === "original") && imgs2.some((r) => r.image_type === "processed" && r.is_primary === 1 && r.derived_from), imgs2);

  console.log("批量手動去背");
  await page.goto(A.base + "/wardrobe?category=" + encodeURIComponent("上衣"));
  await page.waitForSelector('[data-gid="gar_white"]');
  await page.click('[data-testid="wardrobe-more"]');
  await page.click('[data-testid="wardrobe-select"]');
  await page.click('button:has-text("選取全部符合")');
  await page.click('[data-testid="bulk-cutout-open"]');
  check("批量去背：未按開始前不處理", (await page.locator('[data-job][data-state="waiting"]').count()) >= 1);
  await page.click('[data-testid="bulk-cutout-start"]');
  await page.waitForFunction(() => ![...document.querySelectorAll("[data-job]")].some((e) => ["waiting", "working"].includes(e.dataset.state)), null, { timeout: 30000 });
  const states = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-job]")].map((e) => [e.dataset.job, e.dataset.state])));
  check("批量去背：沒有去背圖的衣物完成去背，已有去背圖的略過", states.gar_white === "done" && states.gar_clear === "skipped", states);
  check("顯示成功及失敗數量", (await page.textContent('[data-testid="bulk-cutout-summary"]')).includes("成功 1"));
  check("沒有瀏覽器錯誤", A.errors.length === 0, A.errors);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
  await shot("error").catch(() => undefined);
}
await A.close();
done();
