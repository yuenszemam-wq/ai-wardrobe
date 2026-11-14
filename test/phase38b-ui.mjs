// Phase 3.8B：本機優先衣櫃、增量同步、離線冷啟動（Service Worker）、離線下載、快取修復、帳戶隔離、R2 用量頁。
// 執行：node test/phase38b-ui.mjs   （桌面 Chromium 模擬 iPhone 13；不等於 iPhone Safari／PWA 實機）
import { join } from "node:path";
import { startApp, addGarment, checker } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p38b");
const { env, page, requests, ctx } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38b-${n}.png`) });
const SVG = (c) => `<path d="M300 200 L600 200 L700 1100 L200 1100 Z" fill="${c}"/>`;
for (let i = 0; i < 8; i++) await addGarment(env, { id: `gar_l${"abcdefgh"[i]}`, name: `本機衣物 ${i + 1}`, category: i % 2 ? "半身裙" : "連身裙", subcategory: i % 2 ? "SK" : "JSK", favorite: i < 3 ? 1 : 0, svg: SVG(["#8a2b4a", "#3a3a8a", "#2a6a4a", "#6a5a2a", "#5a2a6a", "#2a5a6a", "#7a4a2a", "#4a2a7a"][i]), created: new Date(Date.now() - (8 - i) * 60000).toISOString() });
const count = (re) => requests.filter((r) => re.test(r)).length;
const ids = () => page.locator("[data-gid]").evaluateAll((els) => els.map((e) => e.dataset.gid));
const idb = (fn) => page.evaluate(fn);

try {
  console.log("首次同步");
  await page.goto(A.base + "/wardrobe");
  await page.waitForSelector("[data-gid]");
  check("首次開啟：同步後顯示全部衣物", (await ids()).length === 8);
  check("首次同步：讀取同步清單＋衣物資料（不使用 offset 分頁）", count(/^GET \/api\/sync\/garments\/manifest/) >= 1 && count(/^POST \/api\/sync\/garments$/) >= 1 && count(/^GET \/api\/garments\?.*offset=/) === 0, requests.filter((r) => /garments/.test(r)));
  const dbs = await idb(async () => (await indexedDB.databases()).map((d) => d.name));
  check("本機資料庫按帳戶隔離（aw-local-tester）", dbs.includes("aw-local-tester"), dbs);

  console.log("第二次開啟：先顯示本機資料");
  requests.length = 0;
  // 伺服器同步很慢：仍然立即顯示本機衣櫃
  await page.route("**/api/sync/**", async (r) => { await new Promise((res) => setTimeout(res, 3000)); await r.continue().catch(() => undefined); });
  const t0 = Date.now();
  await page.goto(A.base + "/wardrobe");
  await page.waitForSelector("[data-gid]");
  const ms = Date.now() - t0;
  check("第二次開啟：不等伺服器，先顯示本機資料", ms < 2500 && (await ids()).length === 8, ms);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // 等待被延遲的背景同步完成，之後才修改伺服器資料
  await page.waitForTimeout(3500);
  check("沒有重新下載完整衣櫃", count(/^POST \/api\/sync\/garments$/) === 0 && count(/^GET \/api\/garments\?/) === 0, requests);

  console.log("增量同步");
  await env.DB.prepare("UPDATE garments SET name='已在另一部手機改名', version=version+1, updated_at=? WHERE id='gar_lc'").bind(new Date().toISOString()).run();
  await env.DB.prepare("DELETE FROM garments WHERE id='gar_lh'").run();
  await addGarment(env, { id: "gar_lnew", name: "新加入衣物", category: "連身裙", subcategory: "JSK", svg: SVG("#aa3366") });
  requests.length = 0;
  const posted = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/sync/garments") && r.method() === "POST") posted.push(...JSON.parse(r.postData()).ids); });
  await page.goto(A.base + "/wardrobe");
  await page.waitForFunction(() => document.querySelectorAll("[data-gid]").length === 8 && document.body.textContent.includes("新加入衣物"), null, { timeout: 8000 }).catch(() => undefined);
  const got = await ids();
  check("增量同步：只下載有改動的衣物（改名＋新增＝2 件）", [...new Set(posted)].sort().join() === "gar_lc,gar_lnew", posted);
  check("新增衣物出現、刪除的衣物移除、沒有重複", got.includes("gar_lnew") && !got.includes("gar_lh") && new Set(got).size === got.length && got.length === 8, got);
  check("改名立即更新", (await page.textContent("body")).includes("已在另一部手機改名"));
  check("同步後不清空列表、不重新初始化", count(/^GET \/api\/garments\?/) === 0);

  console.log("網絡中斷：保留最後成功資料");
  await page.route("**/api/**", (r) => r.abort("internetdisconnected"));
  await page.goto(A.base + "/wardrobe");
  await page.waitForSelector("[data-gid]", { timeout: 8000 }).catch(() => undefined);
  check("API 全部失敗時衣櫃仍然顯示（不會變成空列表）", (await ids()).length === 8);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  console.log("清除圖片快取不影響本機資料");
  await page.goto(A.base + "/settings/offline");
  await page.click('[data-clear="all"]');
  await page.click('[data-testid="clear-run"]');
  await page.waitForSelector('[data-testid="clear-result"]');
  const left = await idb(() => new Promise((res) => { const r = indexedDB.open("aw-local-tester"); r.onsuccess = () => { const t = r.result.transaction("garments").objectStore("garments").count(); t.onsuccess = () => { res(t.result); r.result.close(); }; }; }));
  check("清除全部圖片快取：本機衣物資料仍在（8 件）", left === 8, left);
  check("清除結果如實回報", (await page.getAttribute('[data-testid="clear-result"]', "data-errors")) === "0");

  console.log("檢查及修復快取");
  await page.goto(A.base + "/wardrobe");
  await page.waitForSelector("[data-gid] img");
  await page.waitForTimeout(1200);
  // 損壞一張縮圖
  await page.evaluate(async () => { const c = await caches.open("aw-private-thumbs-v1"); const k = (await c.keys())[0]; await c.put(k, new Response(new Blob([new Uint8Array([1, 2, 3])]), { headers: { "content-type": "image/webp", "x-aw-cached-at": String(Date.now()), "x-thumbnail-version": "x" } })); });
  await page.goto(A.base + "/settings/offline");
  await page.click('[data-testid="repair-scan"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="cache-repair"]')?.dataset.phase === "done", null, { timeout: 15000 });
  const issues = Number(await page.getAttribute('[data-testid="cache-repair"]', "data-issues"));
  check("找出損壞／缺失的縮圖", issues >= 1, issues);
  await page.click('[data-testid="repair-run"]');
  await page.waitForFunction(() => { const r = document.querySelector('[data-testid="cache-repair"]'); return r?.dataset.phase === "done" && Number(r.dataset.fixed) > 0; }, null, { timeout: 15000 });
  check("只修復需要修復的項目，並回報結果", Number(await page.getAttribute('[data-testid="cache-repair"]', "data-failed")) === 0 && Number(await page.getAttribute('[data-testid="cache-repair"]', "data-fixed")) >= 1);
  await shot("01-cache");

  console.log("離線衣櫃頁及下載");
  await page.goto(A.base + "/settings/offline-wardrobe");
  await page.waitForSelector('[data-testid="offline-status"]');
  check("顯示已同步衣物數量", (await page.getAttribute('[data-testid="offline-status"]', "data-count")) === "8");
  await page.click('[data-dl="fav"]');
  await page.waitForSelector('[data-testid="dl-plan"]');
  check("下載高清圖前顯示容量及 R2 讀取估算", (await page.textContent('[data-testid="dl-plan"]')).includes("Class B") && Number(await page.getAttribute('[data-testid="dl-plan"]', "data-download")) === 3);
  const hd0 = count(/^GET \/api\/images\//);
  await page.click('[data-testid="dl-start"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="dl-job"]')?.dataset.finished === "1", null, { timeout: 15000 });
  check("下載收藏衣物高清圖：3 張，沒有失敗", (await page.getAttribute('[data-testid="dl-job"]', "data-done")) === "3" && (await page.getAttribute('[data-testid="dl-job"]', "data-failed")) === "0" && count(/^GET \/api\/images\//) - hd0 === 3);
  const pinned = await page.evaluate(async () => { const c = await caches.open("aw-private-hd-v1"); let n = 0; for (const k of await c.keys()) if ((await c.match(k)).headers.get("x-aw-pinned") === "1") n++; return n; });
  check("離線下載的高清圖標記為保留", pinned === 3, pinned);
  await page.click('[data-dl="fav"]');
  await page.waitForSelector('[data-testid="dl-plan"]');
  check("已下載的不會重複下載", (await page.getAttribute('[data-testid="dl-plan"]', "data-download")) === "0");
  await page.click('[role="dialog"] [aria-label="關閉"]');
  // 暫停／取消
  await page.route("**/api/images/**", async (r) => { await new Promise((res) => setTimeout(res, 400)); await r.continue().catch(() => undefined); });
  await page.click('[data-dl="all"]');
  await page.waitForSelector('[data-testid="dl-plan"]');
  await page.click('[data-testid="dl-start"]');
  await page.click('[data-testid="dl-cancel"]');
  await page.waitForTimeout(900);
  const jd = Number(await page.getAttribute('[data-testid="dl-job"]', "data-done"));
  check("取消：未開始的項目不會下載", (await page.getAttribute('[data-testid="dl-job"]', "data-finished")) === "1" && jd < 5, jd);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await shot("02-offline-wardrobe");

  console.log("R2 用量頁");
  await page.goto(A.base + "/settings/r2");
  await page.waitForSelector('[data-testid="r2-usage"]');
  check("未設定官方 Token：清楚列出設定方法，不顯示虛構數字", (await page.getAttribute('[data-testid="r2-usage"]', "data-official")) === "0" && (await page.textContent('[data-testid="r2-official-missing"]')).includes("CF_API_TOKEN") && (await page.locator('[data-testid="r2-cost"]').count()) === 0);
  check("App 自身用量按用途顯示", (await page.locator('[data-testid="r2-app"] [data-purpose]').count()) === 8);
  check("舊有縮圖狀態移到進階技術資訊", (await page.locator('[data-testid="r2-advanced"]').count()) === 1);
  await shot("03-r2");

  console.log("離線冷啟動（Service Worker）");
  await page.evaluate(() => localStorage.setItem("aw:sw-test", "1"));
  await page.goto(A.base + "/");
  await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 }).catch(() => undefined);
  if (!(await page.evaluate(() => !!navigator.serviceWorker?.controller))) { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 15000 }).catch(() => undefined); }
  const shellOk = await page.evaluate(async () => { const c = await caches.open("aw-shell-v4"); const keys = (await c.keys()).map((k) => new URL(k.url).pathname); return keys; });
  check("Service Worker 預先保存 App Shell 及 JS／CSS", shellOk.includes("/") && shellOk.includes("/assets/app.js") && shellOk.includes("/assets/app.css"), shellOk);
  await page.goto(A.base + "/wardrobe");
  await page.waitForSelector("[data-gid]");
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector("[data-gid]", { timeout: 10000 }).catch(() => undefined);
  check("沒有網絡時由主畫面開啟：顯示已同步的衣櫃", (await ids()).length === 8, await page.textContent("body").catch(() => ""));
  check("清楚顯示目前離線、本機衣物數量及最後同步時間", (await page.locator('[data-testid="offline-banner"]').count()) === 1 && (await page.textContent('[data-testid="offline-banner"]')).includes("本機 8 件"));
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="home-grid"]', { timeout: 10000 }).catch(() => undefined);
  check("離線首頁：主頁布局及統計可以顯示（不會整頁失敗）", (await page.locator('[data-testid="w-overview"], [data-testid="w-cover"]').count()) > 0 && (await page.locator('[data-testid="w-error-stats"]').count()) === 0);
  await shot("04-offline-home");
  await ctx.setOffline(false);

  console.log("本機衣櫃故障：改用伺服器清單（不會顯示 0 件）");
  {
    const p2 = await ctx.newPage();
    await p2.addInitScript(() => { indexedDB.open = () => { const r = {}; setTimeout(() => { r.error = new DOMException("模擬故障", "UnknownError"); r.onerror?.(); }, 10); return r; }; });
    await p2.goto(A.base + "/wardrobe");
    await p2.waitForSelector("[data-gid]", { timeout: 10000 }).catch(() => undefined);
    check("IndexedDB 無法開啟：仍然由伺服器顯示全部衣物", (await p2.locator("[data-gid]").count()) === 8, await p2.textContent("body"));
    await p2.close();
    const p3 = await ctx.newPage();
    await p3.goto(A.base + "/");
    await p3.evaluate(async () => { for (const d of await indexedDB.databases()) indexedDB.deleteDatabase(d.name); });
    await p3.route("**/api/sync/**", (r) => r.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"x","message":"模擬錯誤"}}' }));
    await p3.goto(A.base + "/wardrobe");
    await p3.waitForSelector("[data-gid]", { timeout: 10000 }).catch(() => undefined);
    check("同步 API 失敗（本機未有資料）：改用伺服器清單顯示全部衣物", (await p3.locator("[data-gid]").count()) === 8, await p3.textContent("body"));
    await p3.unrouteAll({ behavior: "ignoreErrors" });
    await p3.close();
  }

  console.log("登出：刪除本機資料");
  await page.goto(A.base + "/settings/account");
  await page.click('[data-testid="logout"]');
  await page.waitForTimeout(800);
  const after = await idb(async () => (await indexedDB.databases()).map((d) => d.name));
  check("登出後刪除該帳戶的本機衣櫃資料庫", !after.includes("aw-local-tester"), after);
  check("沒有瀏覽器錯誤", A.errors.filter((e) => !/internetdisconnected|Failed to fetch|ERR_INTERNET/.test(e)).length === 0, A.errors);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
} finally {
  await A.close();
  done();
}
