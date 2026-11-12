// Avatar V2 測試頁：瀏覽器端測試（iPhone 尺寸模擬；本機模擬 D1／R2，不接觸正式服務）
// 執行：node test/avatar-ui.mjs   （需要 esbuild、tailwindcss、playwright）
// 注意：這是桌面 Chromium 模擬 iPhone 螢幕及觸控，不等於 iPhone Safari 實機驗收。
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { makeEnv } from "./harness.mjs";
import { ROOT, TMP, buildApp, buildWorker } from "./doll-build.mjs";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
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
const worker = await buildWorker("avatar-ui-worker");
const app = await buildApp();
const env = makeEnv();
await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-AVATAR-UI-1234")), new Date().toISOString()).run();
const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-AVATAR-UI-1234", username: "tester", password: "test-password-1234" }) }), env);
const [cookieName, cookieValue] = auth.headers.get("set-cookie").split(";")[0].split("=");
const counts = async () => JSON.stringify(await Promise.all(["garments", "doll_looks", "doll_look_items", "doll_fit_templates", "outfits"].map(async (t) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n)));
const before = await counts();

const server = createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/")) {
      if (url === "/assets/app.js") { res.setHeader("content-type", "application/javascript"); return res.end(app.js); }
      if (url === "/assets/app.css") { res.setHeader("content-type", "text/css"); return res.end(app.css); }
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
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 390, height: 763 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, userAgent: devices["iPhone 13"].userAgent });
await context.addCookies([{ name: cookieName, value: cookieValue, url: origin }]);
const page = await context.newPage();
const errors = [], external = [], apiWrites = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|manifest|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on("request", (r) => {
  if (!r.url().startsWith(origin) && !r.url().startsWith("blob:") && !r.url().startsWith("data:")) external.push(r.url());
  if (r.url().includes("/api/") && r.method() !== "GET") apiWrites.push(r.method() + " " + r.url());
});

/** 部件在邏輯畫布上的矩陣（由 CSS transform 讀回，位移除以顯示比例） */
const matrixOf = (part) => page.evaluate((part) => {
  const stage = document.querySelector('[data-testid="avatar-stage"]').getBoundingClientRect();
  const el = document.querySelector(`[data-part="${part}"]`);
  const m = new DOMMatrix(getComputedStyle(el).transform);
  const k = stage.width / 1200;
  return [m.a, m.b, m.c, m.d, m.e / k, m.f / k];
}, part);
const angleOf = async (part) => { const m = await matrixOf(part); return (Math.atan2(m[1], m[0]) * 180) / Math.PI; };
const near = (a, b, e = 0.05) => Math.abs(a - b) <= e;
const shot = (name) => page.locator('[data-testid="avatar-stage"]').screenshot({ path: join(SHOTS, name) });
/** 部件圖片的像素摘要（用來比較著色前後的顏色及 alpha） */
const pixelStats = (part) => page.evaluate(async (part) => {
  const img = document.querySelector(`[data-part="${part}"] img`);
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let r = 0, g = 0, b = 0, n = 0, alpha = 0;
  for (let i = 0; i < d.length; i += 4) { alpha = (alpha * 31 + d[i + 3]) % 1000000007; if (d[i + 3] > 200) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; } }
  return { r: r / n, g: g / n, b: b / n, n, alpha, w: c.width, h: c.height, src: img.src.slice(0, 5) };
}, part);

/** 揀髮色並等到頭髮圖片真的換成新顏色 */
async function pickColor(id) {
  const prev = await page.evaluate(() => document.querySelector('[data-part="hair_tail_l"] img').src);
  await page.click(`[data-color="${id}"]`);
  await page.waitForFunction((prev) => { const i = document.querySelector('[data-part="hair_tail_l"] img'); return i.src !== prev && i.complete && i.naturalWidth > 0; }, prev);
}

try {
  await page.goto(origin + "/dressing/avatar-lab");
  await page.waitForSelector('[data-part="head"] img');
  await page.waitForFunction(() => [...document.querySelectorAll("[data-part] img")].every((i) => i.complete && i.naturalWidth > 0));
  console.log("載入");
  const parts = await page.evaluate(() => [...document.querySelectorAll("[data-part]")].map((e) => e.dataset.part));
  check("23 個部件全部載入（16 身體＋褲下襯層＋6 頭髮）", parts.length === 23, parts.length);
  check("靜止姿勢：所有部件沒有位移或旋轉", (await Promise.all(parts.map(matrixOf))).every((m) => near(m[0], 1, 1e-4) && near(m[1], 0, 1e-4) && near(m[4], 0) && near(m[5], 0)));
  const box = await page.locator('[data-testid="avatar-stage"]').boundingBox();
  check("角色畫布在 iPhone 畫面內完整可見（2:3）", box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 763 && near(box.height / box.width, 1.5, 0.01), box);
  check("頭及前髮在身體之上、後髮在身體之下", await page.evaluate(() => { const z = (p) => Number(getComputedStyle(document.querySelector(`[data-part="${p}"]`)).zIndex); return z("hair_bangs") > z("head") && z("head") > z("torso") && z("hair_tail_l") < z("pelvis_under") && z("upper_arm_r") > z("torso"); }));
  await shot("avatar-01-rest.png");

  console.log("姿勢預設及關節");
  await page.click('[data-testid="open-editor"]');
  await page.waitForSelector('[data-testid="avatar-editor"]');
  check("角色設定以底部抽屜開啟，預設姿勢為 A 字站姿", (await page.locator('[data-pose="a_pose"]').getAttribute("class")).includes("chip-on"));
  await page.click('[data-pose="outerwear"]');
  check("適合外套：右上臂 +18°", near(await angleOf("upper_arm_r"), 18, 0.01));
  check("前臂跟隨上臂並加上手肘角度（18−12＝6°）", near(await angleOf("lower_arm_r"), 6, 0.01));
  check("手掌跟隨前臂", near(await angleOf("hand_r"), 6, 0.01));
  check("左右獨立：左上臂 −18°", near(await angleOf("upper_arm_l"), -18, 0.01));
  check("軀幹及雙腿不動", near(await angleOf("torso"), 0, 1e-4) && near(await angleOf("upper_leg_l"), 0, 1e-4));
  // 手掌圖片的位置真的跟著移動（不是只有矩陣）
  const handBefore = { x: 0, y: 0 };
  await page.click('[data-pose="a_pose"]');
  Object.assign(handBefore, await page.evaluate(() => { const r = document.querySelector('[data-part="hand_r"] img').getBoundingClientRect(); return { x: r.x, y: r.y }; }));
  await page.click('[data-pose="arms_in"]');
  const handAfter = await page.evaluate(() => { const r = document.querySelector('[data-part="hand_r"] img').getBoundingClientRect(); return { x: r.x, y: r.y }; });
  check("自然收手：右手掌在畫面上向身體靠近", handAfter.x > handBefore.x + 8, { handBefore, handAfter });
  await page.click('[data-pose="asymmetric"]');
  check("不對稱站姿：左大腿轉動，小腿及腳掌跟隨", near(await angleOf("upper_leg_l"), -7, 0.01) && near(await angleOf("lower_leg_l"), -2, 0.01) && near(await angleOf("foot_l"), 1, 0.01));
  check("頭部轉動時，瀏海、側髮及馬尾跟隨", near(await angleOf("head"), -2, 0.01) && near(await angleOf("hair_bangs"), -2, 0.01) && near(await angleOf("hair_tail_l"), 1, 0.01));
  await page.getByRole("button", { name: /^腿/ }).click();
  await page.locator('input[data-bone="knee_r"]').fill("6");
  check("逐個關節微調：右膝 +6°，右大腿不變", near(await angleOf("lower_leg_r"), 6, 0.01) && near(await angleOf("upper_leg_r"), 0, 1e-4));
  check("滑桿範圍＝rig.json 的關節限制", (await page.locator('input[data-bone="hip_r"]').getAttribute("max")) === "12" && (await page.locator('input[data-bone="hip_r"]').getAttribute("min")) === "-4");
  await page.getByRole("button", { name: "顯示骨架" }).click();
  check("可顯示骨架", (await page.locator('[data-testid="avatar-skeleton"] circle').count()) === 19);
  await page.getByRole("button", { name: "隱藏骨架" }).click();
  check("可隱藏骨架", (await page.locator('[data-testid="avatar-skeleton"]').count()) === 0);
  await page.click('[data-testid="pose-reset"]');
  check("重設全部關節", (await Promise.all(parts.map(angleOf))).every((a) => near(a, 0, 1e-4)));

  console.log("髮色");
  const orig = { bangs: await pixelStats("hair_bangs"), tail: await pixelStats("hair_tail_l") };
  const bodyBefore = await pixelStats("head");
  await page.click('[data-color="purple"]');
  await page.waitForFunction(() => document.querySelector('[data-part="hair_bangs"] img').src.startsWith("blob:"));
  const purple = { bangs: await pixelStats("hair_bangs"), tail: await pixelStats("hair_tail_l") };
  check("紫色：頭髮變成偏藍紫", purple.bangs.b > purple.bangs.r && purple.bangs.b > purple.bangs.g + 20, purple.bangs);
  check("換髮色不改變輪廓（alpha 完全相同）及尺寸", purple.bangs.alpha === orig.bangs.alpha && purple.tail.alpha === orig.tail.alpha && purple.bangs.w === orig.bangs.w);
  check("換髮色不影響臉及身體", JSON.stringify(await pixelStats("head")) === JSON.stringify(bodyBefore));
  check("換髮色不改變部件位置", (await matrixOf("hair_bangs")).every((v, i) => near(v, [1, 0, 0, 1, 0, 0][i], 1e-4)));
  await pickColor("black_pink");
  const bp = await pixelStats("hair_tail_l");
  check("黑粉挑染：整體比原本暗，但仍保留粉色（紅多於綠）", bp.r + bp.g + bp.b < orig.tail.r + orig.tail.g + orig.tail.b && bp.r > bp.g + 12, bp);
  await shot("avatar-02-black-pink.png");
  await pickColor("silver");
  await page.click('[data-pose="arms_out"]');
  await page.getByRole("button", { name: "關閉" }).click();
  await shot("avatar-03-silver-arms-out.png");

  console.log("拖動手掌（IK）");
  const before2 = await angleOf("upper_arm_l");
  const h = await page.locator('[data-handle="wrist_l"]').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 30, h.y + h.height / 2 + 4, { steps: 6 });
  await page.mouse.up();
  const after2 = await angleOf("upper_arm_l");
  check("拖動左手掌向身體：左上臂跟隨轉動", after2 > before2 + 2, { before2, after2 });
  const h2 = await page.locator('[data-handle="wrist_l"]').boundingBox();
  check("拖動後圓點跟隨手腕移動", h2.x < h.x - 10, { h, h2 });

  console.log("保存及恢復");
  const savedPose = await Promise.all(["upper_arm_l", "lower_arm_l", "upper_arm_r"].map(angleOf));
  await page.click('[data-testid="lab-save"]');
  await page.reload();
  await page.waitForSelector('[data-part="head"] img');
  await page.waitForFunction(() => document.querySelector('[data-part="hair_bangs"] img').src.startsWith("blob:"));
  const restored = await Promise.all(["upper_arm_l", "lower_arm_l", "upper_arm_r"].map(angleOf));
  check("重新整理後姿勢完整恢復", restored.every((v, i) => near(v, savedPose[i], 0.06)), { savedPose, restored });
  const silver = await pixelStats("hair_bangs");
  check("重新整理後髮色恢復（銀灰：三色接近）", Math.abs(silver.r - silver.b) < 30 && silver.r > orig.bangs.r + 30, silver);
  await page.click('[data-testid="toggle-hair"]');
  check("可隱藏頭髮檢視無髮素體", (await page.locator('[data-part^="hair_"]').count()) === 0 && (await page.locator('[data-part="head"]').count()) === 1);
  await shot("avatar-04-no-hair.png");
  await page.click('[data-testid="toggle-hair"]');
  await page.getByRole("button", { name: "對比原圖" }).click();
  check("可對比原圖", (await page.locator('[data-testid="avatar-original"]').count()) === 1);
  await page.getByRole("button", { name: "返回拆件角色" }).click();
  await page.click('[data-testid="lab-reset"]');
  check("全部還原", near(await angleOf("upper_arm_l"), 0, 1e-4) && !(await page.evaluate(() => localStorage.getItem("aw:avatar-lab:v2"))));

  console.log("不影響原有功能");
  check("測試頁沒有任何寫入 API 的請求", apiWrites.length === 0, apiWrites);
  check("沒有連到外部網站", external.length === 0, external);
  check("資料表筆數不變", (await counts()) === before);
  await page.goto(origin + "/dressing");
  await page.waitForSelector('[data-testid="doll-canvas"]');
  check("原有角色換裝（Avatar V1）照常開啟", (await page.locator('[data-testid="doll-canvas"] img').count()) === 3);
  check("沒有頁面錯誤", errors.length === 0, errors);
} catch (e) {
  failures.push("執行中斷：" + (e.stack || e));
  await page.screenshot({ path: join(SHOTS, "avatar-99-failure.png") }).catch(() => undefined);
} finally {
  await browser.close();
  server.close();
}
console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
