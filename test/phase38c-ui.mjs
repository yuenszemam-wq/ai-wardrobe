// Phase 3.8C UI：完整離線操作（Outbox）。離線修改衣物並同步、版本衝突（覆寫）、離線加入相片、離線上傳新衣物（上傳中心）、
// 離線保存新造型（含離線素材，按次序先上傳素材再保存）、離線保存角色造型及衝突（另存副本）、捨棄、角色換裝離線包下載。
// 執行：node test/phase38c-ui.mjs（桌面 Chromium 模擬 iPhone，以 Playwright 離線模式模擬斷網；不等於 iPhone 實機）
import { join } from "node:path";
import { startApp, addGarment, checker, sharp, roomHelpers } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p38c");
const { env, page, ctx } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38c-${n}.png`) });
await addGarment(env, { id: "gar_jsk", name: "紫色 JSK", category: "連身裙", subcategory: "JSK", svg: '<rect x="200" y="300" width="500" height="800" fill="#5b2491"/>' });
await addGarment(env, { id: "gar_top", name: "白色上衣", category: "上衣", subcategory: "Blouse", svg: '<rect x="150" y="200" width="600" height="500" fill="#fafafa"/>' });
const api = (method, path, body) => page.evaluate(async ([method, path, body]) => { const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-requested-with": "ai-wardrobe" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, path, body]);
const bar = async () => (await page.locator('[data-testid="outbox-bar"]').count()) ? Number(await page.getAttribute('[data-testid="outbox-bar"]', "data-count")) : 0;
const waitBar = (n, t = 12000) => page.waitForFunction((n) => { const b = document.querySelector('[data-testid="outbox-bar"]'); return (b ? Number(b.dataset.count) : 0) === n; }, n, { timeout: t }).catch(() => undefined);
const offline = async (v) => { await ctx.setOffline(v); await page.waitForTimeout(150); };

try {
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="tab-add"]');
  await page.waitForTimeout(800); // 本機衣櫃同步

  console.log("離線修改衣物");
  await page.goto(A.base + "/g/gar_jsk");
  await page.waitForSelector('button[aria-label="收藏"]');
  await offline(true);
  await page.click('button[aria-label="收藏"]');
  await waitBar(1, 4000);
  check("離線修改：保存在這部手機（等待同步 1 項），畫面即時更新", (await bar()) === 1 && (await page.locator('button[aria-label="取消收藏"]').count()) === 1);
  check("伺服器未改動", (await env.DB.prepare("SELECT is_favorite FROM garments WHERE id = 'gar_jsk'").first()).is_favorite === 0);
  await shot("01-offline-edit");
  await offline(false);
  await waitBar(0);
  check("連線後自動同步，等待同步清空", (await bar()) === 0 && (await env.DB.prepare("SELECT is_favorite FROM garments WHERE id = 'gar_jsk'").first()).is_favorite === 1);

  console.log("版本衝突");
  await page.reload(); await page.waitForSelector('button[aria-label="取消收藏"]');
  await offline(true);
  await page.click('button[aria-label="取消收藏"]');
  await waitBar(1, 4000);
  await env.DB.prepare("UPDATE garments SET name = '另一處改名', version = version + 1 WHERE id = 'gar_jsk'").run();
  await offline(false);
  await page.waitForFunction(() => document.querySelector('[data-testid="outbox-bar"]')?.dataset.bad === "1", null, { timeout: 12000 }).catch(() => undefined);
  check("另一處已修改：標示衝突，不會覆蓋", (await page.getAttribute('[data-testid="outbox-bar"]', "data-bad")) === "1" && (await env.DB.prepare("SELECT is_favorite FROM garments WHERE id = 'gar_jsk'").first()).is_favorite === 1);
  await page.click('[data-testid="outbox-bar"]');
  await page.waitForSelector('[data-testid="outbox-sheet"] [data-op-state="conflict"]');
  await shot("02-conflict");
  await page.click('[data-op-action="overwrite"]');
  await waitBar(0);
  const g1 = await env.DB.prepare("SELECT is_favorite, name FROM garments WHERE id = 'gar_jsk'").first();
  check("選擇覆寫：只套用我的修改（收藏），另一處的改名保留", g1.is_favorite === 0 && g1.name === "另一處改名", g1);
  await page.keyboard.press("Escape").catch(() => undefined);

  console.log("離線加入相片");
  await page.goto(A.base + "/g/gar_top");
  await page.waitForSelector('button[aria-label="收藏"]');
  const photo = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#3a7" } }).jpeg().toBuffer();
  await offline(true);
  const fileInputs = page.locator('input[type="file"]');
  await fileInputs.first().setInputFiles({ name: "new.jpg", mimeType: "image/jpeg", buffer: photo });
  await waitBar(1, 6000);
  check("離線加入相片：放入等待同步", (await bar()) === 1);
  const before = (await env.DB.prepare("SELECT COUNT(*) AS n FROM garment_images WHERE garment_id = 'gar_top' AND image_type != 'thumbnail'").first()).n;
  await offline(false);
  await waitBar(0);
  check("連線後上傳相片", (await env.DB.prepare("SELECT COUNT(*) AS n FROM garment_images WHERE garment_id = 'gar_top' AND image_type != 'thumbnail'").first()).n === before + 1);

  console.log("離線上傳新衣物（上傳中心）");
  const gBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n;
  await page.goto(A.base + "/import");
  await page.waitForSelector('input[type="file"]', { state: "attached" });
  await offline(true);
  await page.locator('input[type="file"]').first().setInputFiles({ name: "dress.jpg", mimeType: "image/jpeg", buffer: await sharp({ create: { width: 600, height: 800, channels: 3, background: "#a35" } }).jpeg().toBuffer() });
  await waitBar(1, 8000);
  check("離線：相片顯示「等待連線」並放入等待同步", (await bar()) === 1 && (await page.textContent("main")).includes("等待連線"));
  await offline(false);
  await waitBar(0, 30000);
  check("連線後自動建立衣物（伺服器以 SHA-256 去重）", (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n === gBefore + 1);

  console.log("離線保存新造型（含離線素材）");
  await page.goto(A.base + "/outfits/new");
  await page.waitForSelector('[data-studio-garment="gar_jsk"]');
  await offline(true);
  await page.click('[data-studio-garment="gar_jsk"] button');
  await page.click('[data-tab="assets"]');
  const bow = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from('<svg width="200" height="200"><circle cx="100" cy="100" r="70" fill="#e0569a"/></svg>') }]).png().toBuffer();
  await page.setInputFiles('[data-testid="asset-file"]', { name: "蝴蝶結.png", mimeType: "image/png", buffer: bow });
  await page.waitForSelector('[data-testid="asset-confirm"]');
  await page.click('[data-testid="asset-confirm"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="outfit-studio"]')?.dataset.layers || "").split(",").filter(Boolean).length === 2, null, { timeout: 8000 }).catch(() => undefined);
  check("離線素材：先以本機圖片加入畫布", (await page.getAttribute('[data-testid="outfit-studio"]', "data-layers")).split(",").filter(Boolean).length === 2);
  await page.click('[data-testid="studio-save"]');
  await page.waitForTimeout(500);
  check("離線保存：素材及造型兩項等待同步，畫面當作已保存", (await bar()) === 2 && (await page.getAttribute('[data-testid="outfit-studio"]', "data-dirty")) === "0", await bar());
  const oBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM outfits").first()).n;
  await offline(false);
  await page.waitForURL(/\/outfits\/out_/, { timeout: 20000 }).catch(() => undefined);
  const oid = page.url().split("/outfits/")[1]?.split("?")[0];
  const saved = oid ? (await api("GET", `/api/outfits/${oid}`)).body : null;
  check("連線後按次序：先上傳素材、再以真正的素材 ID 保存造型，並轉到正式網址", !!saved && saved.layers.length === 2 && saved.layers.some((l) => l.layer_type === "studio_asset" && /^stv_/.test(l.asset_version_id)) && (await env.DB.prepare("SELECT COUNT(*) AS n FROM outfits").first()).n === oBefore + 1, saved?.layers);
  await shot("03-offline-outfit");

  console.log("離線保存角色造型及衝突");
  const H = roomHelpers(page);
  await page.goto(A.base + "/dressing");
  await H.ready();
  await page.fill('[data-testid="look-name"]', "離線角色");
  await page.click('[data-testid="save-look"]');
  await page.waitForFunction(() => /\/dressing\/dlk_/.test(location.pathname), null, { timeout: 15000 }).catch(() => undefined);
  const lid = page.url().split("/dressing/")[1].split("?")[0];
  await H.ready();
  await offline(true);
  await page.fill('[data-testid="look-name"]', "離線改名");
  await page.click('[data-testid="save-look"]');
  await waitBar(1, 4000);
  check("離線保存角色造型：等待同步", (await bar()) === 1);
  await env.DB.prepare("UPDATE doll_looks SET name = '另一部手機', updated_at = '2031-01-01T00:00:00.000Z' WHERE id = ?").bind(lid).run();
  await offline(false);
  await page.waitForFunction(() => document.querySelector('[data-testid="outbox-bar"]')?.dataset.bad === "1", null, { timeout: 12000 }).catch(() => undefined);
  check("角色造型版本衝突：不覆蓋", (await env.DB.prepare("SELECT name FROM doll_looks WHERE id = ?").bind(lid).first()).name === "另一部手機");
  await page.goto(A.base + "/outfits"); // 換裝頁是全螢幕：在其他頁面處理等待同步
  await page.click('[data-testid="outbox-bar"]');
  await page.click('[data-op-action="copy"]');
  await waitBar(0);
  check("選擇另存副本：新增一個角色造型，原造型保留另一部手機的修改", !!(await env.DB.prepare("SELECT id FROM doll_looks WHERE name LIKE '%離線副本%'").first()) && (await env.DB.prepare("SELECT name FROM doll_looks WHERE id = ?").bind(lid).first()).name === "另一部手機");
  await page.keyboard.press("Escape").catch(() => undefined);

  console.log("捨棄");
  await page.goto(A.base + "/g/gar_top");
  await page.waitForSelector('button[aria-label="收藏"]');
  await offline(true);
  await page.click('button[aria-label="收藏"]');
  await waitBar(1, 4000);
  await page.click('[data-testid="outbox-bar"]');
  await page.click('[data-op-action="discard"]');
  await waitBar(0, 4000);
  await offline(false);
  await page.waitForTimeout(800);
  check("捨棄後不會同步", (await env.DB.prepare("SELECT is_favorite FROM garments WHERE id = 'gar_top'").first()).is_favorite === 0);
  await page.keyboard.press("Escape").catch(() => undefined);

  console.log("角色換裝離線包");
  await page.goto(A.base + "/settings/offline-wardrobe");
  await page.waitForSelector('[data-dl="models"]');
  await page.click('[data-dl="models"]');
  await page.waitForSelector('[data-testid="dl-plan"]', { timeout: 15000 });
  const toDl = Number(await page.getAttribute('[data-testid="dl-plan"]', "data-download"));
  check("離線包計劃包括身體部件、透明衣物圖及素材", toDl > 10, toDl);
  await page.click('[data-testid="dl-start"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="dl-job"]')?.dataset.finished === "1", null, { timeout: 60000 }).catch(() => undefined);
  check("離線包下載完成，沒有失敗", (await page.getAttribute('[data-testid="dl-job"]', "data-failed")) === "0", [await page.getAttribute('[data-testid="dl-job"]', "data-done"), await page.getAttribute('[data-testid="dl-job"]', "data-failed")]);
  await shot("04-offline-pack");

  const errs = A.errors.filter((e) => !/net::ERR_|Failed to fetch|status of 409|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED/.test(e));
  check("沒有瀏覽器錯誤", errs.length === 0, errs);
} catch (e) {
  console.error(e);
  check("未預期錯誤", false, String(e?.stack || e));
  await shot("zz-error").catch(() => undefined);
}
await A.close();
done();
