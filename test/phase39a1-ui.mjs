// Phase 3.9A.1 UI：記錄穿搭（相簿照片、選擇衣物）、穿搭日曆（月份切換、照片月曆、日期清單）、複製、標記已穿著、衣物穿著統計、首頁元件、離線唯讀。
// 執行：node test/phase39a1-ui.mjs（桌面 Chromium 模擬 iPhone；不等於 iPhone Safari／PWA 實機驗收）
import { join } from "node:path";
import { startApp, addGarment, checker, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p39a1");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p39a1-${n}.png`) });
const SVG = '<path d="M300 200 L600 200 L800 1100 L100 1100 Z" fill="#6b2d5c"/>';
await addGarment(env, { id: "gar_d1", name: "日誌 JSK", category: "連身裙", subcategory: "JSK", svg: SVG, price: 1000 });
await addGarment(env, { id: "gar_d2", name: "日誌襯衫", category: "上衣", subcategory: "Blouse", svg: SVG });
const pad = (n) => String(n).padStart(2, "0");
const ld = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = ld(new Date());
const photo = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#aa5577" } }).jpeg().withMetadata({ exif: { IFD0: { Make: "TestCam" } } }).toBuffer();
const photo2 = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#335577" } }).jpeg().toBuffer();

try {
  console.log("記錄今日穿搭");
  await page.goto(A.base + "/outfits");
  await page.waitForSelector('[data-testid="studio-daily"]');
  check("穿搭主頁有日誌、日曆及記錄今日入口", (await page.locator('[data-testid="studio-daily"] a').count()) === 3, await page.locator('[data-testid="studio-daily"]').innerHTML());
  await page.click('[data-testid="entry-record-today"]');
  await page.waitForSelector('[data-testid="diary-editor"]');
  check("預設今天（本地日期）及已穿著", (await page.inputValue('[data-testid="diary-date"]')) === today && (await page.getAttribute('[data-kind="worn"]', "aria-pressed")) === "true");
  await page.fill('[data-testid="diary-title"]', "茶會");
  await page.setInputFiles('[data-testid="diary-file"]', [{ name: "a.jpg", mimeType: "image/jpeg", buffer: photo }, { name: "b.jpg", mimeType: "image/jpeg", buffer: photo2 }]);
  check("相簿選擇多張照片並預覽", (await page.locator('[data-pending="waiting"]').count()) === 2);
  await page.click('[data-testid="diary-pick-garments"]');
  await page.waitForSelector('[data-pick-garment="gar_d1"]');
  await page.click('[data-pick-garment="gar_d1"] a, [data-pick-garment="gar_d1"] button >> nth=0');
  await page.click('[data-testid="diary-picker-done"]');
  check("選擇衣物", (await page.locator('[data-testid="diary-item-list"] [data-item="gar_d1"]').count()) === 1);
  await page.fill('[data-testid="diary-occasion"]', "下午茶");
  await page.fill('[data-testid="diary-tags"]', "#茶會 #甜美");
  await shot("01-editor");
  await page.click('[data-testid="diary-save"]');
  await page.waitForSelector('[data-testid="diary"]', { timeout: 30000 });
  const rows = (await env.DB.prepare("SELECT e.id, e.worn_date, e.title, (SELECT COUNT(*) FROM diary_photos p WHERE p.entry_id=e.id) AS photos, (SELECT COUNT(*) FROM diary_items i WHERE i.entry_id=e.id) AS items FROM diary_entries e").all()).results;
  check("保存紀錄、兩張照片及衣物", rows.length === 1 && rows[0].photos === 2 && rows[0].items === 1 && rows[0].worn_date === today, rows);
  const key = (await env.DB.prepare("SELECT r2_key FROM diary_photos LIMIT 1").first()).r2_key;
  const stored = await env.IMAGES.get(key);
  const bytes = Buffer.from(await new Response(stored.body).arrayBuffer());
  check("上傳的照片已移除 EXIF（相機資料）", !bytes.includes(Buffer.from("TestCam")) && bytes.length < photo.length * 3);
  check("草稿在成功保存後清除", (await page.evaluate(() => localStorage.getItem("aw:diary-draft:new"))) === null);

  console.log("穿搭日曆");
  await page.waitForSelector(`[data-day="${today}"]`);
  check("有紀錄的日期顯示標示", Number(await page.getAttribute(`[data-day="${today}"]`, "data-count")) === 1 && (await page.locator(`[data-day="${today}"] [data-kind-dot="worn"]`).count()) === 1);
  await page.click('[data-view-tab="photo"]');
  check("照片月曆使用縮圖（不是高清照片）", (await page.locator(`[data-day="${today}"] img`).getAttribute("src")).endsWith("/thumb"));
  await shot("02-calendar-photo");
  await page.click('[data-testid="diary-next"]');
  check("切換下一個月", (await page.getAttribute('[data-testid="diary"]', "data-month")) !== today.slice(0, 7));
  await page.click('[data-testid="diary-today"]');
  check("快速返回今天", (await page.getAttribute('[data-testid="diary"]', "data-month")) === today.slice(0, 7));
  await page.click(`[data-day="${today}"]`);
  await page.waitForSelector('[data-testid="diary-day"]');
  check("點擊日期顯示當天穿搭", (await page.locator('[data-testid="diary-day"] [data-entry]').count()) === 1);
  // 複製到明天（計劃）
  await page.click('[data-testid="diary-copy"]');
  const tomorrow = ld(new Date(Date.now() + 864e5));
  await page.fill('[data-testid="diary-copy-date"]', tomorrow);
  await page.click('[data-testid="diary-copy-go"]');
  await page.waitForFunction(() => document.querySelectorAll("[data-day][data-count='1']").length >= 1);
  const copied = await env.DB.prepare("SELECT kind, (SELECT COUNT(*) FROM diary_photos p WHERE p.entry_id=e.id) AS photos FROM diary_entries e WHERE worn_date = ?").bind(tomorrow).first();
  check("複製到將來日期＝計劃穿搭，照片不重複複製", copied && copied.kind === "planned" && copied.photos === 0, copied);
  await page.keyboard.press("Escape").catch(() => undefined);

  console.log("衣物穿著統計");
  await page.goto(A.base + "/g/gar_d1");
  await page.waitForSelector('[data-testid="wear-stats"]');
  check("衣物詳情：累計穿著 1 次、每次穿著成本", (await page.getAttribute('[data-testid="wear-stats"]', "data-worn")) === "1" && (await page.textContent('[data-testid="wear-cpw"]')).includes("HK$1000"));
  await page.goto(A.base + "/g/gar_d2");
  await page.waitForSelector('[data-testid="wear-stats"]');
  check("未穿過及未填價格：尚未有足夠資料（不當作 0）", (await page.textContent('[data-testid="wear-cpw"]')).includes("尚未有足夠資料"));
  await page.goto(A.base + "/diary/stats");
  await page.waitForSelector('[data-testid="diary-stats"]');
  check("穿著分析頁：本月記錄天數及使用率", (await page.textContent('[data-testid="stat-days"]')) === "1" && (await page.textContent('[data-testid="stat-usage"]')) === "50%");
  await shot("03-stats");

  console.log("首頁元件");
  await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('home_layout',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify({ v: 2, rev: 5, widgets: [{ id: "diary_today", type: "diary_today", visible: true, size: "large", display: "card", span: 2, opts: {} }, { id: "diary_calendar", type: "diary_calendar", visible: true, size: "large", display: "month", span: 2, opts: {} }, { id: "most_worn", type: "most_worn", visible: true, size: "large", display: "list", span: 2, opts: {} }, { id: "diary_usage", type: "diary_usage", visible: true, size: "small", display: "ratio", span: 1, opts: {} }], updated_at: new Date().toISOString() }), new Date().toISOString()).run();
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.includes("home")) localStorage.removeItem(k); });
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="w-diary_today"] a', { timeout: 15000 });
  check("今日穿搭元件", (await page.textContent('[data-testid="w-diary_today"]')).includes("茶會"));
  check("本月日曆、最常穿、使用率元件", (await page.locator('[data-testid="w-diary_calendar"]').count()) === 1 && (await page.textContent('[data-testid="w-most_worn"]')).includes("日誌 JSK") && (await page.textContent('[data-testid="w-diary_usage"]')).includes("50%"));
  await shot("04-home-widgets");

  console.log("離線唯讀");
  await page.goto(A.base + "/diary");
  await page.waitForSelector(`[data-day="${today}"]`);
  await page.route("**/api/diary**", (r) => r.abort());
  await page.reload();
  await page.waitForSelector('[data-testid="diary-offline"]', { timeout: 15000 }).catch(() => undefined);
  check("離線：顯示已同步的紀錄（唯讀）", (await page.locator('[data-testid="diary-offline"]').count()) === 1 && Number(await page.getAttribute(`[data-day="${today}"]`, "data-count")) === 1);
  await page.unroute("**/api/diary**");
  const errs = A.errors.filter((e) => !/net::ERR_FAILED|Failed to fetch/.test(e));
  check("沒有瀏覽器錯誤", errs.length === 0, errs);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  await A.close();
  done();
}
