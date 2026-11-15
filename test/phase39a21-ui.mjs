// Phase 3.9A.2.1 UI：IndexedDB 多份草稿（按帳戶、每份新造型獨立、重新整理恢復）、草稿列表、衝突草稿三個選擇、
// 縮圖準備好才產生及自動補建、衣物圖片版本凍結及「改用衣櫃最新圖片」、高清匯出（逐層釋放）、衣櫃一次大幅捲動收合。
// 執行：node test/phase39a21-ui.mjs（桌面 Chromium 模擬 iPhone；不等於 iPhone Safari／PWA 實機驗收）
import { join } from "node:path";
import { startApp, addGarment, checker, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p3921");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p3921-${n}.png`) });
await addGarment(env, { id: "gar_jsk", name: "紫色 JSK", category: "連身裙", subcategory: "JSK", svg: '<rect x="200" y="300" width="500" height="800" fill="#5b2491"/>' });
await addGarment(env, { id: "gar_top", name: "白色上衣", category: "上衣", subcategory: "Blouse", svg: '<rect x="150" y="200" width="600" height="500" fill="#fafafa"/>' });
for (let i = 0; i < 30; i++) await addGarment(env, { id: `gar_w${String(i).padStart(2, "0")}`, name: `衣物 ${i}`, category: "上衣", subcategory: "Blouse", svg: '<rect x="300" y="300" width="300" height="600" fill="#a35"/>', w: 300, h: 400 });
const api = (method, path, body) => page.evaluate(async ([method, path, body]) => { const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-requested-with": "ai-wardrobe" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, path, body]);
const ready = () => page.waitForFunction(() => document.querySelector('[data-testid="studio-canvas"]')?.dataset.ready === "1", null, { timeout: 15000 });
const status = () => page.textContent('[data-testid="studio-status"]');
const draftCount = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open("aw-studio-drafts", 1); r.onupgradeneeded = () => r.result.createObjectStore("drafts"); r.onsuccess = () => { const t = r.result.transaction("drafts", "readonly").objectStore("drafts").getAllKeys(); t.onsuccess = () => res(t.result); }; }));

try {
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="tab-add"]');

  console.log("新造型草稿（IndexedDB）");
  await page.goto(A.base + "/outfits/new");
  await page.waitForSelector('[data-testid="garments-tab"] [data-studio-garment="gar_jsk"]');
  await page.click('[data-studio-garment="gar_jsk"] button');
  await page.waitForFunction(() => /草稿/.test(document.querySelector('[data-testid="studio-status"]')?.textContent || ""), null, { timeout: 5000 }).catch(() => undefined);
  check("未保存修改寫入 IndexedDB 草稿，狀態列顯示「已存草稿」", (await status()).includes("已存草稿") && (await draftCount()).length === 1, [await status(), await draftCount()]);
  const url1 = page.url();
  check("新造型網址記錄自己的草稿 ID", /\/outfits\/new\?draft=n_/.test(url1), url1);
  const keys1 = await draftCount();
  check("草稿按帳戶分開（key＝帳戶｜草稿 ID）", keys1[0].includes("|n_"), keys1);
  await page.reload();
  await page.waitForSelector('[data-testid="outfit-studio"]');
  await page.waitForFunction(() => (document.querySelector('[data-testid="outfit-studio"]')?.dataset.layers || "") !== "", null, { timeout: 6000 }).catch(() => undefined);
  check("重新整理後恢復同一份草稿", (await page.getAttribute('[data-testid="outfit-studio"]', "data-layers")).split(",").filter(Boolean).length === 1);
  // 第二份新造型：不會覆蓋第一份
  await page.goto(A.base + "/outfits/new");
  await page.waitForSelector('[data-studio-garment="gar_top"]');
  await page.click('[data-studio-garment="gar_top"] button');
  await page.waitForTimeout(700);
  check("第二份新造型有自己的草稿（兩份同時存在）", (await draftCount()).length === 2, await draftCount());
  await page.goto(A.base + "/outfits");
  await page.waitForSelector('[data-testid="draft-strip"]');
  check("我的穿搭顯示未保存草稿列表", (await page.locator('[data-testid="draft-strip"] [data-draft-id]').count()) === 2);
  await shot("01-drafts");
  await page.click('[data-testid="draft-strip"] [data-draft-id] [data-draft-drop] >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="draft-strip"] [data-draft-id]').length === 1, null, { timeout: 4000 }).catch(() => undefined);
  check("可以捨棄單一草稿，其他草稿保留", (await draftCount()).length === 1);
  await page.click('[data-testid="draft-strip"] [data-draft-id] button >> nth=0');
  await page.waitForSelector('[data-testid="outfit-studio"]'); await ready();
  await page.click('[data-testid="studio-save"]');
  await page.waitForURL(/\/outfits\/out_/, { timeout: 8000 });
  await page.waitForTimeout(300);
  check("保存後草稿刪除，網址轉為造型", (await draftCount()).length === 0 && /\/outfits\/out_/.test(page.url()));
  const oid = page.url().split("/outfits/")[1].split("?")[0];
  const saved = (await api("GET", `/api/outfits/${oid}`)).body;
  check("保存包含完整縮圖及衣物圖片版本", !!saved.thumb_url && !!saved.layers[0].image_id, saved.layers[0]);
  check("建立造型只建立一套（op_id）", (await env.DB.prepare("SELECT COUNT(*) AS n FROM outfits").first()).n === 1);

  console.log("衝突草稿");
  await ready();
  await page.click('[data-tab="layers"]');
  await page.click('[data-testid="layer-list"] [data-action="hide"]');
  await page.waitForTimeout(600);
  // 另一部裝置修改了造型
  await api("PATCH", `/api/outfits/${oid}`, { name: "另一部裝置的名稱" });
  await page.reload();
  await page.waitForSelector('[data-testid="draft-conflict"]', { timeout: 8000 });
  check("版本不同：顯示衝突草稿選擇（載入／另存副本／捨棄），不自動覆蓋", (await page.locator('[data-testid="draft-conflict"] [data-conflict]').count()) === 3 && (await page.inputValue('[data-testid="studio-name"]')) === "另一部裝置的名稱");
  await shot("02-conflict");
  await page.click('[data-conflict="copy"]');
  await page.waitForURL((u) => !u.toString().includes(oid), { timeout: 8000 });
  const copyId = page.url().split("/outfits/")[1].split("?")[0];
  const copy = (await api("GET", `/api/outfits/${copyId}`)).body;
  check("另存副本：建立新造型（保留草稿的修改），原造型不變", copy.name.includes("草稿副本") && copy.layers[0].hidden === true && (await api("GET", `/api/outfits/${oid}`)).body.layers[0].hidden === false, copy.layers?.[0]);
  check("另存後草稿刪除", (await draftCount()).length === 0);

  console.log("縮圖自動補建");
  await api("PATCH", `/api/outfits/${oid}`, { layers: [{ layer_id: "a", layer_type: "garment", garment_id: "gar_jsk", x: 10, y: 10, w: 80, h: 80 }] });
  check("API 改圖層而沒有縮圖：舊縮圖已移除", (await api("GET", `/api/outfits/${oid}`)).body.thumb_url === null);
  await page.goto(A.base + `/outfits/${oid}`); await ready();
  for (let i = 0; i < 40 && !(await api("GET", `/api/outfits/${oid}`)).body.thumb_url; i++) await page.waitForTimeout(200);
  check("打開造型、圖片載入完成後自動補建縮圖", !!(await api("GET", `/api/outfits/${oid}`)).body.thumb_url);
  check("補建縮圖不會令造型變成未保存", (await page.getAttribute('[data-testid="outfit-studio"]', "data-dirty")) === "0");

  console.log("衣物圖片版本");
  const newPng = new Uint8Array(await sharp({ create: { width: 900, height: 1200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from('<svg width="900" height="1200"><rect x="100" y="100" width="700" height="1000" fill="#0a8"/></svg>') }]).png().toBuffer());
  await env.IMAGES.put("garments/gar_jsk/new.png", newPng);
  await env.DB.prepare("UPDATE garment_images SET is_primary = 0 WHERE garment_id = 'gar_jsk'").run();
  await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES ('img_jsknew','gar_jsk','processed','garments/gar_jsk/new.png','image/png',900,1200,?,?,1,1,?)").bind(newPng.length, "f".repeat(64), new Date(Date.now() + 1000).toISOString()).run();
  await page.reload(); await ready();
  const pix = () => page.evaluate(() => { const c = document.querySelector('[data-testid="studio-canvas"]'); return [...c.getContext("2d").getImageData(Math.round(c.width * 0.5), Math.round(c.height * 0.55), 1, 1).data]; });
  const before = await pix();
  check("衣櫃換圖後，已保存造型仍顯示原本的圖片（紫色）", before[2] > 110 && before[1] < 80, before);
  await page.click('[data-tab="layers"]');
  check("圖層列表提示「衣櫃有新圖片」", (await page.textContent('[data-testid="layer-list"]')).includes("衣櫃有新圖片"));
  await page.click('[data-testid="layer-list"] [data-action="more"]');
  await page.click('[data-testid="layer-menu"] [data-op="update-image"]');
  await ready(); await page.waitForTimeout(200);
  const after = await pix();
  check("選擇「改用衣櫃最新圖片」後畫布更新（綠色）並成為未保存修改", after[1] > 120 && after[0] < 60 && (await page.getAttribute('[data-testid="outfit-studio"]', "data-dirty")) === "1", after);
  await page.click('[data-testid="studio-save"]'); await page.waitForTimeout(800);
  check("保存後伺服器記錄新版本", (await api("GET", `/api/outfits/${oid}`)).body.layers[0].image_id === "img_jsknew");

  console.log("高清匯出");
  await page.evaluate(() => { navigator.canShare = () => false; });
  await page.click('[data-testid="studio-more"]');
  await page.click('[data-testid="studio-export-open"]');
  await page.click('text=高清 2400×3200');
  const dl = page.waitForEvent("download");
  await page.click('[data-testid="export-run"]');
  const file = await (await dl).path();
  const meta = await sharp(file).metadata();
  check("高清匯出 2400×3200（逐層處理）", meta.width === 2400 && meta.height === 3200, [meta.width, meta.height]);
  await page.keyboard.press("Escape");

  console.log("衣櫃一次大幅捲動");
  await page.goto(A.base + "/wardrobe");
  await page.waitForSelector('[data-testid="wardrobe-list"] [data-gid]');
  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(500);
  check("程式一次捲動 800px：頁首收合", (await page.getAttribute('[data-testid="wardrobe-toolbar"]', "data-collapsed")) === "1");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  check("回到頂部：頁首展開", (await page.getAttribute('[data-testid="wardrobe-toolbar"]', "data-collapsed")) === "0");

  const errs = A.errors.filter((e) => !/net::ERR_FAILED|Failed to fetch|status of 409/.test(e));
  check("沒有瀏覽器錯誤", errs.length === 0, errs);
} catch (e) {
  console.error(e);
  check("未預期錯誤", false, String(e));
  await shot("zz-error").catch(() => undefined);
}
await A.close();
done();
