// 角色換裝：瀏覽器端對端測試（iPhone 尺寸模擬；本機模擬 D1／R2，不接觸正式服務）
// 執行：node test/doll-ui.mjs   （需要 esbuild、tailwindcss、sharp、playwright）
// 注意：這是桌面 Chromium 模擬 iPhone 螢幕及觸控，不等於 iPhone Safari 實機驗收。
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { makeEnv } from "./harness.mjs";
import { ROOT, TMP, buildApp, buildWorker } from "./doll-build.mjs";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
const sharp = require(process.env.SHARP_PATH || "sharp");
const SHOTS = process.env.DOLL_SHOTS || TMP;

let passed = 0;
const failures = [];
const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"m"')) return; origLog(...a); };
function check(name, cond, info) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
const hex = async (u8) => Buffer.from(await crypto.subtle.digest("SHA-256", u8)).toString("hex");
const now = () => new Date().toISOString();

const worker = await buildWorker("doll-ui-worker");
const app = await buildApp();
const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-DOLL-UI-1234")), now()).run();
const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-DOLL-UI-1234", username: "tester", password: "test-password-1234" }) }), env);
const [cookieName, cookieValue] = auth.headers.get("set-cookie").split(";")[0].split("=");

// ───── 測試衣物：用 SVG 畫的透明 PNG（四周留白，模擬真實去背圖） ─────
const SHAPES = {
  jsk: '<path d="M330 150 L390 150 L400 330 L500 330 L510 150 L570 150 L590 520 L760 1050 L140 1050 L310 520 Z" fill="#6b2d5c"/><path d="M140 1010 L760 1010 L760 1050 L140 1050 Z" fill="#f6e7df"/>',
  op: '<path d="M300 140 L600 140 L860 520 L770 580 L610 400 L620 560 L780 1060 L120 1060 L280 560 L290 400 L130 580 L40 520 Z" fill="#1f3a5f"/>',
  blouse: '<path d="M300 200 L600 200 L870 560 L780 620 L620 430 L630 760 L270 760 L280 430 L120 620 L30 560 Z" fill="#fffaf6" stroke="#c9b8c4" stroke-width="6"/>',
  sk: '<path d="M300 300 L600 300 L800 950 L100 950 Z" fill="#7a1f2b"/><rect x="300" y="300" width="300" height="50" fill="#3b0f15"/>',
  pet: '<path d="M320 350 L580 350 L820 900 L80 900 Z" fill="#ffffff" stroke="#d8cfd6" stroke-width="6"/>',
  kc: '<path d="M200 520 Q450 300 700 520 L700 600 Q450 400 200 600 Z" fill="#b03060"/>',
  socks: '<rect x="290" y="250" width="110" height="700" fill="#222"/><rect x="500" y="250" width="110" height="700" fill="#222"/>',
  shoes: '<rect x="250" y="520" width="170" height="160" rx="40" fill="#4a1c2a"/><rect x="480" y="520" width="170" height="160" rx="40" fill="#4a1c2a"/>',
};
const GARMENTS = [
  ["gar_jsk", "測試 JSK", "連身裙", "JSK", "jsk"], ["gar_op", "測試 OP", "連身裙", "OP", "op"], ["gar_bl", "測試襯衫", "上衣", "Blouse", "blouse"],
  ["gar_sk", "測試 SK", "半身裙", "SK", "sk"], ["gar_pet", "測試裙撐", "內搭與裙撐", "裙撐", "pet"], ["gar_kc", "測試髮箍", "頭飾", "髮箍", "kc"],
  ["gar_socks", "測試襪", "襪", "過膝襪", "socks"], ["gar_shoes", "測試鞋", "鞋", "瑪莉珍鞋", "shoes"],
];
for (const [id, name, category, subcategory, shape] of GARMENTS) {
  const png = new Uint8Array(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">${SHAPES[shape]}</svg>`)).png().toBuffer());
  const thumb = new Uint8Array(await sharp(Buffer.from(png)).resize(225, 300).webp({ quality: 80 }).toBuffer());
  const sha = await hex(png);
  await env.IMAGES.put(`garments/${id}/p.png`, png);
  await env.DB.prepare("INSERT INTO garments (id,name,category,subcategory,status,created_at,updated_at) VALUES (?,?,?,?, 'active', ?, ?)").bind(id, name, category, subcategory, now(), now()).run();
  await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)")
    .bind("img_" + shape.padEnd(8, "a").replace(/[^a-z2-7]/g, "a"), id, "processed", `garments/${id}/p.png`, "image/png", 900, 1200, png.length, sha, now()).run();
  await env.DB.prepare("INSERT INTO garment_thumbnails (image_id,garment_id,data,mime_type,byte_size,width,height,has_alpha,source_sha256,version,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)")
    .bind("img_" + shape.padEnd(8, "a").replace(/[^a-z2-7]/g, "a"), id, thumb, "image/webp", thumb.length, 225, 300, sha, sha.slice(0, 16), now()).run();
}
const snapshot = async () => JSON.stringify([
  (await env.DB.prepare("SELECT * FROM garments ORDER BY id").all()).results,
  (await env.DB.prepare("SELECT id,garment_id,r2_key,sha256,is_primary FROM garment_images ORDER BY id").all()).results,
  (await env.DB.prepare("SELECT * FROM outfit_items").all()).results,
  [...env.IMAGES.objects.entries()].map(([k, o]) => [k, o.bytes.length]).sort(),
]);
const before = await snapshot();

const TYPES = { ".png": "image/png", ".js": "application/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/")) {
      if (url === "/assets/app.js") { res.setHeader("content-type", TYPES[".js"]); return res.end(app.js); }
      if (url === "/assets/app.css") { res.setHeader("content-type", TYPES[".css"]); return res.end(app.css); }
      const file = join(ROOT, "public", url);
      if (url.startsWith("/doll/") && existsSync(file)) { res.setHeader("content-type", "image/png"); return res.end(readFileSync(file)); }
      res.setHeader("content-type", "text/html");
      return res.end(app.html);
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bytes = Buffer.concat(chunks);
    const r = await worker.fetch(new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers, body: bytes.length ? bytes : undefined }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const iphone = devices["iPhone 13"];
const context = await browser.newContext({ viewport: { width: 390, height: Number(process.env.DOLL_VIEWPORT_H || 763) }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, userAgent: iphone.userAgent });
await context.addCookies([{ name: cookieName, value: cookieValue, url: origin }]);
const page = await context.newPage();
const errors = [], external = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|manifest|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on("request", (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith("blob:") && !r.url().startsWith("data:")) external.push(r.url()); });
page.on("dialog", (d) => d.accept());

/** 已穿衣物在邏輯畫布（1200×1800）上的外框 */
const logical = (gid) => page.evaluate((gid) => {
  const c = document.querySelector('[data-testid="doll-canvas"]').getBoundingClientRect();
  const el = document.querySelector(`[data-testid="worn-${gid}"]`);
  if (!el) return null;
  const k = 1200 / c.width, cs = getComputedStyle(el);
  return { cx: Math.round(parseFloat(el.style.left) * k), cy: Math.round(parseFloat(el.style.top) * k), w: Math.round(parseFloat(el.style.width) * k), z: Number(cs.zIndex), transform: el.style.transform };
}, gid);
const wornIds = () => page.$$eval('[data-testid^="worn-"]', (els) => els.map((e) => e.dataset.testid.slice(5)).sort().join(","));
const tile = (name) => page.getByTestId("doll-picker").getByText(name, { exact: true });
const wearTap = async (name) => { await tile(name).click(); await page.waitForTimeout(250); };
const chip = (name) => page.locator('[aria-label="已穿上"] button', { hasText: name });
/** 進入某件衣物的校正；done() 返回揀選衣物 */
const done = async () => { const b = page.getByTestId("fit-tools").getByText("完成", { exact: true }); if (await b.count()) await b.click(); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

try {
  console.log("入口及素體");
  await page.goto(origin + "/outfits");
  await page.getByText("角色換裝", { exact: true }).first().click();
  await page.waitForSelector('[data-testid="doll-canvas"]');
  check("由穿搭頁進入 /dressing", new URL(page.url()).pathname === "/dressing");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="doll-canvas"] > img')].every((i) => i.complete && i.naturalWidth > 0));
  const base = await page.$$eval('[data-testid="doll-canvas"] > img', (imgs) => imgs.map((i) => [i.naturalWidth, i.naturalHeight, Number(getComputedStyle(i).zIndex)]));
  check("三個素體圖層都是 1200×1800", base.length === 3 && base.every((b) => b[0] === 1200 && b[1] === 1800), base);
  const ratio = await page.$eval('[data-testid="doll-canvas"]', (c) => { const r = c.getBoundingClientRect(); return r.width / r.height; });
  check("畫布比例 2:3", near(ratio, 2 / 3, 0.005), ratio);
  const fits = await page.$eval('[data-testid="doll-canvas"]', (c) => { const r = c.getBoundingClientRect(); return r.width <= innerWidth && r.height <= innerHeight * 0.7; });
  check("畫布在 iPhone 螢幕內完整顯示", fits);
  await page.waitForSelector('[data-testid="doll-picker"]');

  console.log("一鍵換裝及互斥");
  await wearTap("測試 JSK");
  let jsk = await logical("gar_jsk");
  check("點一下即穿上 JSK", !!jsk, jsk);
  check("JSK 預設位置：水平置中、在肩至膝之間", jsk && near(jsk.cx, 600, 40) && jsk.cy > 700 && jsk.cy < 1100, jsk);
  await page.waitForFunction(() => { const i = document.querySelector('[data-testid="worn-gar_jsk"] img'); return i && i.naturalWidth === 900; }, null, { timeout: 8000 }).catch(() => undefined);
  check("畫布顯示的是原有高清透明圖（900×1200）", await page.$eval('[data-testid="worn-gar_jsk"] img', (i) => i.naturalWidth === 900 && i.naturalHeight === 1200).catch(() => false));
  await wearTap("測試襯衫");
  await wearTap("測試裙撐");
  await wearTap("測試髮箍");
  await wearTap("測試襪");
  await wearTap("測試鞋");
  check("JSK＋襯衫＋裙撐＋頭飾＋襪＋鞋並存", (await wornIds()) === "gar_bl,gar_jsk,gar_kc,gar_pet,gar_shoes,gar_socks", await wornIds());
  const z = Object.fromEntries(await Promise.all(["gar_socks", "gar_shoes", "gar_pet", "gar_bl", "gar_jsk", "gar_kc"].map(async (g) => [g, (await logical(g)).z])));
  const headZ = base.map((b) => b[2]).sort((a, b) => b - a)[0];
  check("圖層：襪 < 鞋 < 裙撐 < 襯衫 < JSK < 頭 < 頭飾", z.gar_socks < z.gar_shoes && z.gar_shoes < z.gar_pet && z.gar_pet < z.gar_bl && z.gar_bl < z.gar_jsk && z.gar_jsk < headZ && headZ < z.gar_kc, { z, headZ });
  check("素體的身體及後髮在全部衣物之下", base.filter((b) => b[2] < 100).length === 2 && z.gar_socks > 2, base);
  await page.screenshot({ path: join(SHOTS, "doll-01-jsk-coord.png") });
  await wearTap("測試 OP");
  check("穿 OP：自動脫下 JSK 及襯衫", (await wornIds()) === "gar_kc,gar_op,gar_pet,gar_shoes,gar_socks", await wornIds());
  await wearTap("測試 SK");
  check("穿 SK：自動脫下 OP", !(await wornIds()).includes("gar_op") && (await wornIds()).includes("gar_sk"));
  await wearTap("測試襯衫");
  check("SK＋襯衫並存", (await wornIds()).includes("gar_sk") && (await wornIds()).includes("gar_bl"));
  const sk = await logical("gar_sk"), bl = await logical("gar_bl");
  check("SK 在襯衫之上（收腰）", sk.z > bl.z, { sk: sk.z, bl: bl.z });
  await page.screenshot({ path: join(SHOTS, "doll-02-sk-blouse.png") });
  await wearTap("測試 SK");
  check("再點一下＝脫下", !(await wornIds()).includes("gar_sk"));
  await wearTap("測試 JSK");
  check("穿回 JSK：保留襯衫", (await wornIds()).includes("gar_jsk") && (await wornIds()).includes("gar_bl"));

  console.log("人工校正及穿著模板");
  jsk = await logical("gar_jsk");
  // 直接點角色身上：髮箍的圖片留白蓋住全身，但點裙身應選中 JSK；點頭頂選中髮箍
  const cv = await page.getByTestId("doll-canvas").boundingBox();
  const at = (x, y) => [cv.x + (x / 1200) * cv.width, cv.y + (y / 1800) * cv.height];
  await page.mouse.click(...at(600, 1150));
  await page.waitForSelector('[data-testid="fit-tools"]');
  check("點裙身：選中 JSK（不被上層圖片的透明留白擋住）", (await chip("測試 JSK").getAttribute("class")).includes("chip-on"));
  await page.mouse.click(...at(600, 150));
  check("點頭頂：改為選中髮箍", (await chip("測試髮箍").getAttribute("class")).includes("chip-on"));
  await page.mouse.click(...at(1150, 1700));
  check("點空白處：取消選取", (await page.getByTestId("fit-tools").count()) === 0);
  await chip("測試 JSK").click();
  await page.waitForSelector('[data-testid="fit-tools"]');
  check("未校正：顯示「分類預設位置」", (await page.getByTestId("fit-from").textContent()) === "分類預設位置");
  check("未改動時不能存模板", await page.getByLabel("存為這件衣物的穿著位置").isDisabled());
  await page.getByLabel("放大", { exact: true }).click();
  await page.getByLabel("放大", { exact: true }).click();
  let a = await logical("gar_jsk");
  check("放大按鈕", a.w > jsk.w * 1.07 && a.w < jsk.w * 1.09, { before: jsk.w, after: a.w });
  // 拖動：在衣物中心按下，向右下移 40×20 螢幕像素
  const boxEl = await page.getByTestId("fit-frame").boundingBox();
  const k = (await page.getByTestId("doll-canvas").boundingBox()).width / 1200;
  const mx = boxEl.x + boxEl.width / 2, my = boxEl.y + boxEl.height * 0.7;
  await page.mouse.move(mx, my); await page.mouse.down(); await page.mouse.move(mx + 20, my + 10, { steps: 3 }); await page.mouse.move(mx + 40, my + 20, { steps: 3 }); await page.mouse.up();
  let b = await logical("gar_jsk");
  check("拖動：位置按畫布比例換算", near(b.cx - a.cx, 40 / k, 3) && near(b.cy - a.cy, 20 / k, 3), { dx: b.cx - a.cx, dy: b.cy - a.cy, expect: [40 / k, 20 / k] });
  await page.getByLabel("向右轉", { exact: true }).click();
  await page.getByLabel("向右轉", { exact: true }).click();
  check("旋轉按鈕", /rotate\(2deg\)/.test((await logical("gar_jsk")).transform), (await logical("gar_jsk")).transform);
  // 旋轉把手：由把手位置繞中心拖動
  const hb = await page.getByLabel("拖拉旋轉").boundingBox();
  const cnow = await logical("gar_jsk");
  const [ccx, ccy] = at(cnow.cx, cnow.cy), hx = hb.x + hb.width / 2, hy = hb.y + hb.height / 2;
  const rot = (deg) => { const t = (deg * Math.PI) / 180, dx = hx - ccx, dy = hy - ccy; return [ccx + dx * Math.cos(t) - dy * Math.sin(t), ccy + dx * Math.sin(t) + dy * Math.cos(t)]; };
  await page.mouse.move(hx, hy); await page.mouse.down(); await page.mouse.move(...rot(4), { steps: 2 }); await page.mouse.move(...rot(8), { steps: 2 }); await page.mouse.up();
  const rotated = Number(/rotate\(([-\d.]+)deg\)/.exec((await logical("gar_jsk")).transform)?.[1]);
  check("旋轉把手：約 +8°", near(rotated, 10, 1.5), rotated);
  await page.getByLabel("向左轉", { exact: true }).click();
  const calib = await page.evaluate(() => { const c = document.querySelector('[data-testid="doll-canvas"]').getBoundingClientRect(), t = document.querySelector('[data-testid="fit-tools"]').getBoundingClientRect(), bar = document.querySelector("nav.app-tabbar").getBoundingClientRect(), head = document.querySelector("header").getBoundingClientRect(); return { scroll: scrollY, canvasTop: c.top, canvasBottom: c.bottom, toolsBottom: t.bottom, head: head.bottom, bar: bar.top }; });
  check("校正時，整個角色及全部工具同時在畫面內", calib.scroll === 0 && calib.canvasTop >= calib.head - 12 && calib.canvasBottom <= calib.bar && calib.toolsBottom <= calib.bar, calib);
  check("已調整：顯示「只用於這個造型」", (await page.getByTestId("fit-from").textContent()) === "只用於這個造型");
  check("模板尚未寫入資料庫", (await env.DB.prepare("SELECT COUNT(*) n FROM doll_fit_templates").first()).n === 0);
  await page.screenshot({ path: join(SHOTS, "doll-03-adjusting.png") });
  await page.getByLabel("存為這件衣物的穿著位置").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="fit-from"]')?.textContent === "已儲存的穿著位置");
  const saved = await logical("gar_jsk");
  const tpl = await env.DB.prepare("SELECT * FROM doll_fit_templates WHERE garment_id='gar_jsk'").first();
  check("模板已寫入（每件衣物一個）", tpl && near(tpl.cx, saved.cx, 1) && near(tpl.cy, saved.cy, 1) && near(tpl.w, saved.w, 1) && tpl.avatar_id === "base_v1", tpl);
  await page.getByLabel("脫下", { exact: true }).click();
  check("脫下後自動返回揀選衣物", !(await wornIds()).includes("gar_jsk") && (await page.getByTestId("doll-picker").count()) === 1);
  await wearTap("測試 JSK");
  const again = await logical("gar_jsk");
  check("再次穿上：自動使用已儲存的位置", again.cx === saved.cx && again.cy === saved.cy && again.w === saved.w && again.transform === saved.transform, { again, saved });

  console.log("個別修改、保存及重新打開");
  await chip("測試襯衫").click();
  await page.getByLabel("縮小", { exact: true }).click();
  const blAdj = await logical("gar_bl");
  check("襯衫只調整、不存模板", (await page.getByTestId("fit-from").textContent()) === "只用於這個造型");
  await page.getByLabel("還原位置").click();
  check("還原：回到未調整的位置", (await page.getByTestId("fit-from").textContent()) === "分類預設位置" && (await logical("gar_bl")).w !== blAdj.w);
  await page.getByLabel("縮小", { exact: true }).click();
  await done();
  const inView = await page.evaluate(() => { const c = document.querySelector('[data-testid="doll-canvas"]').getBoundingClientRect(), p = document.querySelector('[data-testid="doll-picker"]').getBoundingClientRect(), bar = document.querySelector("nav.app-tabbar").getBoundingClientRect(); return { canvasBottom: c.bottom, pickerTop: p.top, bar: bar.top, scroll: scrollY, canvasH: c.height }; });
  check("揀選衣物時，角色與衣物清單同時在畫面內（不用捲動）", inView.scroll === 0 && inView.canvasBottom <= inView.bar && inView.pickerTop < inView.bar && inView.canvasH >= 330, inView);
  await page.getByLabel("造型名稱").fill("月夜茶會");
  const wornBefore = await wornIds();
  const posBefore = Object.fromEntries(await Promise.all(wornBefore.split(",").map(async (g) => [g, await logical(g)])));
  await page.getByText("保存造型").click();
  await page.waitForURL(/\/dressing\/look_/);
  const lookId = new URL(page.url()).pathname.split("/").pop();
  const rows = (await env.DB.prepare("SELECT garment_id, slot, ov_cx, ov_w FROM doll_look_items WHERE look_id = ? ORDER BY garment_id").bind(lookId).all()).results;
  check("造型已寫入資料庫", rows.length === wornBefore.split(",").length, rows);
  check("只有襯衫帶個別修改；其他＝跟隨模板／預設", rows.every((r) => (r.garment_id === "gar_bl") === (r.ov_cx !== null)), rows);
  check("個別修改沒有變成模板", (await env.DB.prepare("SELECT COUNT(*) n FROM doll_fit_templates").first()).n === 1);
  await page.reload();
  await page.waitForSelector('[data-testid^="worn-"]');
  await page.waitForTimeout(400);
  check("重新打開：衣物相同", (await wornIds()) === wornBefore, await wornIds());
  const posAfter = Object.fromEntries(await Promise.all(wornBefore.split(",").map(async (g) => [g, await logical(g)])));
  check("重新打開：位置、大小、旋轉、圖層完全相同", JSON.stringify(posAfter) === JSON.stringify(posBefore), { posBefore, posAfter });
  check("造型名稱保留", (await page.getByLabel("造型名稱").inputValue()) === "月夜茶會");
  await chip("測試襯衫").click();
  check("重新打開後仍標示襯衫為個別修改", (await page.getByTestId("fit-from").textContent()) === "只用於這個造型");
  await chip("測試 JSK").click();
  check("重新打開後 JSK 來自模板", (await page.getByTestId("fit-from").textContent()) === "已儲存的穿著位置");
  await done();
  await page.screenshot({ path: join(SHOTS, "doll-04-reopened.png"), fullPage: true });
  await page.goto(origin + "/dressing");
  await page.waitForSelector('[data-testid="doll-picker"]');
  check("新造型由空白開始，已保存的造型在清單內", (await wornIds()) === "" && (await page.getByText("月夜茶會（").count()) === 1);
  await page.getByText("月夜茶會（").click();
  await page.waitForSelector('[data-testid^="worn-"]');
  check("由清單打開造型", (await wornIds()) === wornBefore);
  await page.getByText("刪除造型").click();
  await page.waitForURL((u) => u.pathname === "/dressing");
  check("刪除造型後，模板及衣物仍在", (await env.DB.prepare("SELECT COUNT(*) n FROM doll_looks").first()).n === 0 && (await env.DB.prepare("SELECT COUNT(*) n FROM doll_fit_templates").first()).n === 1);

  console.log("Avatar V2 integrated dressing");
  await page.goto(origin + "/dressing");
  await page.waitForSelector('[data-testid="doll-picker"]');
  await page.getByRole("button", { name: "Avatar V2", exact: true }).click();
  await page.waitForSelector('[data-part="head"]');
  check("V2 已接入換裝畫布", (await page.locator('[data-testid="doll-canvas"] [data-part]').count()) >= 16);
  await wearTap("測試 SK");
  await wearTap("測試襯衫");
  check("V2 半裙及襯衫可以一起穿", (await wornIds()) === "gar_bl,gar_sk");
  await page.getByRole("button", { name: "角色設定", exact: true }).click();
  await page.locator('[data-color="black"]').click();
  await page.locator('[data-pose="arms_out"]').click();
  await page.getByLabel("關閉", { exact: true }).click();
  check("單張襯衫在不兼容姿勢時有提示", await page.getByText("目前姿勢未完全支援", { exact: false }).count() === 1);
  await page.getByLabel("造型名稱").fill("V2 測試");
  await page.getByText("保存造型").click();
  await page.waitForURL(/\/dressing\/look_/);
  const v2Id = new URL(page.url()).pathname.split("/").pop();
  const v2Row = await env.DB.prepare("SELECT avatar_id,hair_color,pose FROM doll_looks WHERE id=?").bind(v2Id).first();
  check("V2 造型保存角色及髮色姿勢", v2Row?.avatar_id === "avatar_v2" && v2Row?.hair_color === "black" && JSON.parse(v2Row.pose).shoulder_r === 12, v2Row);
  await page.reload();
  await page.waitForSelector('[data-part="head"]');
  await page.waitForSelector('[data-testid="worn-gar_sk"]');
  check("重開 V2 造型仍為新版角色及衣物", (await wornIds()) === "gar_bl,gar_sk");
  await page.getByRole("button", { name: "角色設定", exact: true }).click();
  check("重開造型後仍保留髮色及姿勢", (await page.locator('[data-color="black"]').getAttribute("class")).includes("chip-on") && (await page.locator('[data-pose="arms_out"]').getAttribute("class")).includes("chip-on"));
  await page.getByLabel("關閉", { exact: true }).click();
  await page.getByText("刪除造型").click();
  await page.waitForURL((u) => u.pathname === "/dressing");

  console.log("資料完整性及回歸");
  check("衣物、圖片記錄、穿搭、R2 物件沒有任何改動", (await snapshot()) === before);
  check("沒有呼叫任何外部服務", external.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u)).length === 0, external);
  await page.goto(origin + "/outfits/new");
  await page.waitForSelector("text=穿搭工作室");
  check("原有穿搭工作室照常開啟", (await page.getByText("保存穿搭").count()) === 1);
  check("沒有頁面錯誤", errors.length === 0, errors);
} catch (e) {
  failures.push("執行中斷：" + (e.stack || e));
  await page.screenshot({ path: join(SHOTS, "doll-99-failure.png") }).catch(() => undefined);
} finally {
  await browser.close();
  server.close();
}
console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
