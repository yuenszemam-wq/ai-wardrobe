// Phase 3.9B.1 UI：設定 › 衣櫃分享（選擇衣物、欄位、分析、建立連結）→ 未登入的瀏覽器開啟公開頁（只見公開內容）→ 撤銷後停止分享。
// 執行：node test/phase39b1-ui.mjs（桌面 Chromium 模擬 iPhone；不等於 iPhone 實機）
import { join } from "node:path";
import { startApp, addGarment, checker, devices } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p39b1");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (p, n) => p.screenshot({ path: join(SHOTS, `p39b1-${n}.png`) });
for (const [id, name, cat, price] of [["gar_a", "紫色 JSK", "連身裙", 1200], ["gar_b", "白色上衣", "上衣", 300], ["gar_c", "私人裙", "半身裙", 500]]) await addGarment(env, { id, name, category: cat, subcategory: cat, svg: '<rect x="200" y="200" width="500" height="800" fill="#7a3b5e"/>', price });
await env.DB.prepare("UPDATE garments SET notes = '私人備註' WHERE id = 'gar_a'").run();
try {
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="tab-add"]');
  await page.waitForTimeout(600);
  await page.goto(A.base + "/settings/share");
  await page.waitForSelector('[data-testid="share-manager"]');
  await page.click('[data-testid="share-new"]');
  await page.waitForSelector('[data-testid="share-picker"] [data-pick="gar_a"]');
  await page.fill('[data-testid="share-title"]', "給朋友的衣櫃");
  await page.click('[data-pick="gar_a"]'); await page.click('[data-pick="gar_b"]');
  await page.click('[data-field="price"]');
  await shot(page, "01-editor");
  await page.click('[data-testid="share-save"]');
  await page.waitForSelector('[data-testid="share-url"]');
  const url = await page.inputValue('[data-testid="share-url"]');
  check("建立後顯示一次完整連結", /\/s\/[A-Za-z0-9_-]{20,}$/.test(url), url);
  await page.locator('[role="dialog"] button[aria-label="關閉"]').last().click().catch(() => undefined);
  await page.waitForTimeout(200);

  console.log("公開頁（另一個沒有登入的瀏覽器）");
  const other = await A.browser.newContext({ ...devices["iPhone 13"] });
  const pp = await other.newPage();
  const perr = []; pp.on("pageerror", (e) => perr.push(String(e))); pp.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) perr.push(m.text()); });
  await pp.goto(url.replace(/^https?:\/\/[^/]+/, A.base));
  await pp.waitForSelector('[data-testid="public-share"]');
  check("不需登入：只顯示公開的 2 件衣物", (await pp.getAttribute('[data-testid="public-share"]', "data-count")) === "2" && (await pp.locator('[data-share-garment="gar_c"]').count()) === 0);
  check("公開分析包括價格總值（只計公開衣物）", (await pp.textContent('[data-testid="share-price"]')).includes("1,500"));
  check("頁面不包含私人備註", !(await pp.content()).includes("私人備註"));
  await pp.click('[data-share-garment="gar_a"]');
  await pp.waitForSelector('[data-testid="share-detail"]');
  await pp.waitForFunction(() => document.querySelector('[data-testid="share-detail-img"]')?.complete && document.querySelector('[data-testid="share-detail-img"]').naturalWidth > 0, null, { timeout: 8000 }).catch(() => undefined);
  check("詳情顯示去背高清圖及公開欄位（價格）", (await pp.evaluate(() => document.querySelector('[data-testid="share-detail-img"]').naturalWidth)) > 0 && (await pp.textContent('[data-testid="share-fields"]')).includes("HK$1200"));
  await shot(pp, "02-public");

  console.log("撤銷");
  await page.click('[data-share-action="revoke"]');
  await page.waitForFunction(() => document.querySelector("[data-share]")?.dataset.active === "0", null, { timeout: 6000 }).catch(() => undefined);
  await pp.reload();
  await pp.waitForSelector('[data-testid="share-error"]');
  check("撤銷後公開頁顯示「已停止分享」", (await pp.textContent('[data-testid="share-error"]')).includes("已停止分享"));
  await shot(pp, "03-revoked");
  check("公開頁沒有瀏覽器錯誤（404 資源除外）", perr.filter((e) => !/404/.test(e)).length === 0, perr);
  await other.close();
  const errs = A.errors.filter((e) => !/net::ERR_FAILED|Failed to fetch/.test(e));
  check("沒有瀏覽器錯誤", errs.length === 0, errs);
} catch (e) { console.error(e); check("未預期錯誤", false, String(e?.stack || e)); }
await A.close();
done();
