// 角色換裝 Phase 3：瀏覽器端對端測試（iPhone 尺寸模擬；本機模擬 D1／R2，不接觸正式服務）
// 執行：node test/doll-ui.mjs   （需要 esbuild、tailwindcss、sharp、playwright）
// DOLL_SHOTS=資料夾 可輸出截圖；DOLL_SOURCE=資料夾 可用真實素材（頭髮／頭部 PNG）測試上傳。
// 注意：這是桌面 Chromium 模擬 iPhone 螢幕，不等於 iPhone Safari 實機驗收。
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { makeEnv } from "./harness.mjs";
import { ROOT, TMP, buildApp, buildWorker } from "./doll-build.mjs";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
const sharp = require(process.env.SHARP_PATH || "sharp");
const SHOTS = process.env.DOLL_SHOTS || TMP;
const SOURCE = process.env.DOLL_SOURCE || "";

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
  op: '<path d="M330 140 L570 140 L600 560 L780 1060 L120 1060 L300 560 Z" fill="#1f3a5f"/><path d="M300 150 L210 620 L120 600 L220 150 Z M600 150 L690 620 L780 600 L680 150 Z" fill="#2c4f7c"/><path d="M380 140 L520 140 L520 70 L380 70 Z" fill="#0c1a2e"/>',
  blouse: '<path d="M330 200 L570 200 L600 760 L300 760 Z" fill="#fffaf6" stroke="#c9b8c4" stroke-width="6"/><path d="M300 210 L190 800 L90 780 L215 210 Z M600 210 L710 800 L810 780 L685 210 Z" fill="#f3e9ee" stroke="#c9b8c4" stroke-width="6"/><path d="M390 200 L510 200 L510 130 L390 130 Z" fill="#d9c8d4"/>',
  sk: '<path d="M300 300 L600 300 L800 950 L100 950 Z" fill="#7a1f2b"/><rect x="300" y="300" width="300" height="50" fill="#3b0f15"/>',
  sk2: '<path d="M300 300 L600 300 L760 820 L140 820 Z" fill="#222"/><rect x="300" y="300" width="300" height="50" fill="#555"/>',
  pet: '<path d="M320 350 L580 350 L820 900 L80 900 Z" fill="#ffffff" stroke="#d8cfd6" stroke-width="6"/>',
  kc: '<path d="M200 520 Q450 300 700 520 L700 600 Q450 400 200 600 Z" fill="#b03060"/>',
  socks: '<rect x="290" y="250" width="110" height="700" fill="#222"/><rect x="500" y="250" width="110" height="700" fill="#222"/>',
  shoes: '<rect x="250" y="520" width="170" height="160" rx="40" fill="#4a1c2a"/><rect x="480" y="520" width="170" height="160" rx="40" fill="#4a1c2a"/>',
};
const GARMENTS = [
  ["gar_jsk", "測試 JSK", "連身裙", "JSK", "jsk"], ["gar_op", "測試 OP", "連身裙", "OP", "op"], ["gar_bl", "測試襯衫", "上衣", "Blouse", "blouse"],
  ["gar_sk", "測試 SK", "半身裙", "SK", "sk"], ["gar_sk2", "測試短裙", "半身裙", "SK", "sk2"], ["gar_pet", "測試裙撐", "內搭與裙撐", "裙撐", "pet"], ["gar_kc", "測試髮箍", "頭飾", "髮箍", "kc"],
  ["gar_socks", "測試襪", "襪", "過膝襪", "socks"], ["gar_shoes", "測試鞋", "鞋", "瑪莉珍鞋", "shoes"],
];
for (const [id, name, category, subcategory, shape] of GARMENTS) {
  const png = new Uint8Array(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">${SHAPES[shape]}</svg>`)).png().toBuffer());
  const thumb = new Uint8Array(await sharp(Buffer.from(png)).resize(225, 300).webp({ quality: 80 }).toBuffer());
  const sha = await hex(png);
  const iid = "img_" + shape.padEnd(8, "a").replace(/[^a-z2-7]/g, "a");
  await env.IMAGES.put(`garments/${id}/p.png`, png);
  await env.DB.prepare("INSERT INTO garments (id,name,category,subcategory,status,created_at,updated_at) VALUES (?,?,?,?, 'active', ?, ?)").bind(id, name, category, subcategory, now(), now()).run();
  await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)").bind(iid, id, "processed", `garments/${id}/p.png`, "image/png", 900, 1200, png.length, sha, now()).run();
  await env.DB.prepare("INSERT INTO garment_thumbnails (image_id,garment_id,data,mime_type,byte_size,width,height,has_alpha,source_sha256,version,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)").bind(iid, id, thumb, "image/webp", thumb.length, 225, 300, sha, sha.slice(0, 16), now()).run();
}
// 舊資料：一套衣服配搭、一個 Avatar V1 造型（連個別位置及 V1 穿著模板）
await env.DB.prepare("INSERT INTO outfits (id,name,status,is_favorite,created_at,updated_at) VALUES ('out_old','暗夜十字','active',1,'2026-11-10T00:00:00Z','2026-11-10T00:00:00Z')").run();
await env.DB.prepare("INSERT INTO outfit_items (outfit_id,garment_id,position,layer_order,x,y,w,h) VALUES ('out_old','gar_bl',0,0,20,5,60,45),('out_old','gar_sk',1,1,20,45,60,50)").run();
await env.DB.prepare("INSERT INTO doll_looks (id,name,avatar_id,status,created_at,updated_at) VALUES ('look_v1','黑白格紋人偶','base_v1','active','2026-11-11T00:00:00Z','2026-11-11T00:00:00Z')").run();
await env.DB.prepare("INSERT INTO doll_look_items (look_id,garment_id,slot,z,ov_cx,ov_cy,ov_w,ov_rotation) VALUES ('look_v1','gar_jsk','dress',500,600,900,640,0),('look_v1','gar_kc','headwear',900,NULL,NULL,NULL,NULL)").run();
await env.DB.prepare("INSERT INTO doll_fit_templates (garment_id,avatar_id,image_id,cx,cy,w,rotation,slot,created_at,updated_at) VALUES ('gar_kc','base_v1','img_kcaaaaaa',600,150,420,0,'headwear','t','t')").run();
const snapshot = async () => JSON.stringify([
  (await env.DB.prepare("SELECT * FROM garments ORDER BY id").all()).results,
  (await env.DB.prepare("SELECT id,garment_id,r2_key,sha256,is_primary FROM garment_images ORDER BY id").all()).results,
  (await env.DB.prepare("SELECT * FROM outfit_items").all()).results,
  [...env.IMAGES.objects.entries()].filter(([k]) => k.startsWith("garments/")).map(([k, o]) => [k, o.bytes.length]).sort(),
]);
const before = await snapshot();

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
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await worker.fetch(new Request("http://localhost" + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
    res.statusCode = r.status;
    r.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices["iPhone 13"], deviceScaleFactor: Number(process.env.DOLL_DPR || 1) });
await ctx.addCookies([{ name: cookieName, value: cookieValue, url: base }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "收入裙內" : undefined));
const shot = (name) => page.screenshot({ path: join(SHOTS, `p3-${name}.png`) });
const room = (attr) => page.getAttribute('[data-testid="dressing-room"]', attr);
const ready = async () => { await page.waitForFunction(() => { const r = document.querySelector('[data-testid="dressing-room"]'); const c = document.querySelector('[data-testid="doll-canvas"]'); return r && c && c.dataset.ready === "1" && r.dataset.resolved === String((r.dataset.worn || "").split(",").filter(Boolean).length); }, null, { timeout: 20000 }); await page.waitForTimeout(120); };
/** 邏輯座標 → 螢幕座標 */
const screen = async (x, y) => page.evaluate(([x, y]) => { const s = document.querySelector('[data-testid="doll-stage"]'); const r = s.getBoundingClientRect(); return [r.left + x * Number(s.dataset.k) + Number(s.dataset.ox), r.top + y * Number(s.dataset.k) + Number(s.dataset.oy)]; }, [x, y]);
const drag = async (from, to) => { await page.mouse.move(from[0], from[1]); await page.mouse.down(); for (let i = 1; i <= 6; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 6, from[1] + ((to[1] - from[1]) * i) / 6); await page.mouse.up(); };
/** 畫布某範圍的像素摘要（用來確認畫面真的改變了） */
const pixels = (x, y, w = 60, h = 60) => page.evaluate(async ([x, y, w, h]) => { const s = document.querySelector('[data-testid="doll-stage"]'), c = document.querySelector('[data-testid="doll-canvas"]'); const k = Number(s.dataset.k), dpr = c.width / s.getBoundingClientRect().width; const d = c.getContext("2d").getImageData(Math.round((x * k + Number(s.dataset.ox)) * dpr), Math.round((y * k + Number(s.dataset.oy)) * dpr), Math.max(1, Math.round(w * k * dpr)), Math.max(1, Math.round(h * k * dpr))).data; let sum = 0, a = 0; for (let i = 0; i < d.length; i += 4) { sum += d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7; a += d[i + 3]; } return sum + ":" + a; }, [x, y, w, h]);

try {
  console.log("穿搭主頁");
  await page.goto(base + "/outfits");
  await page.waitForSelector('[data-card]');
  check("兩個獨立入口：衣服配搭、角色換裝", (await page.locator('[data-testid="entry-outfit"]').count()) === 1 && (await page.locator('[data-testid="entry-look"]').count()) === 1);
  check("同一頁列出衣服配搭及角色換裝造型", (await page.locator('[data-card="outfit"]').count()) === 1 && (await page.locator('[data-card="look"]').count()) === 1);
  await page.click('[data-filter="look"]');
  check("篩選：角色換裝", (await page.locator('[data-card]').count()) === 1 && (await page.textContent('[data-testid="count"]')).includes("1"));
  await page.click('[data-filter="outfit"]');
  check("篩選：衣服配搭", (await page.locator('[data-card="outfit"]').count()) === 1 && (await page.locator('[data-card="look"]').count()) === 0);
  await page.click('[data-filter="all"]');
  await page.click('[data-testid="filter-fav"]');
  check("收藏篩選", (await page.locator('[data-card]').count()) === 1);
  await page.click('[data-testid="filter-fav"]');
  await page.click('[data-card="look"] [data-testid="card-fav"]');
  await page.waitForTimeout(200);
  check("在卡片上收藏角色造型", (await env.DB.prepare("SELECT is_favorite FROM doll_looks WHERE id='look_v1'").first()).is_favorite === 1);
  await shot("01-home");

  console.log("換裝頁：自由疊穿");
  await page.click('[data-testid="entry-look"]');
  await ready();
  check("只有一個角色，沒有 V1／V2 切換及骨架測試按鈕", !(await page.content()).match(/Avatar V1|Avatar V2|骨架測試/));
  const stageBox = await page.locator('[data-testid="doll-stage"]').boundingBox();
  check("角色舞台佔畫面的主要部分，面板在下方", stageBox.height > 280 && (await page.locator('[data-testid="doll-panel"]').boundingBox()).y > stageBox.y + stageBox.height - 2, stageBox);
  for (const g of ["gar_bl", "gar_jsk", "gar_op", "gar_sk", "gar_sk2", "gar_socks", "gar_shoes", "gar_kc"]) await page.click(`[data-garment="${g}"]`);
  await ready();
  check("襯衫＋JSK＋OP＋兩條半身裙同時穿著，沒有被自動脫下", (await room("data-worn")).split(",").length === 8, await room("data-worn"));
  check("預設次序由內到外：襪→鞋→上衣→半裙→連身裙→頭飾", (await room("data-worn")) === "gar_socks,gar_shoes,gar_bl,gar_sk,gar_sk2,gar_jsk,gar_op,gar_kc", await room("data-worn"));
  await shot("02-layered");
  await page.click('[data-garment="gar_op"]');
  await page.click('[data-garment="gar_sk2"]');
  await ready();
  check("再按一次只脫下那一件", (await room("data-worn")).split(",").length === 6);

  console.log("圖層管理");
  await page.click('[data-tab="layers"]');
  check("列出全部已穿衣物", (await page.locator("[data-layer]").count()) === 6);
  await page.click('[data-layer="gar_sk"] [aria-label="暫時隱藏"]');
  check("暫時隱藏", (await room("data-worn")).includes("gar_sk:hidden"));
  await page.click('[data-layer="gar_sk"] [aria-label="顯示"]');
  await page.click('[data-layer="gar_bl"] button:nth-of-type(2)');
  check("選取衣物後顯示校正面板，角色仍然可見", (await room("data-selected")) === "gar_bl" && (await page.locator('[data-testid="fit-panel"]').count()) === 1 && (await page.locator('[data-testid="fit-frame"]').count()) === 1);
  await page.click('[data-order="top"]');
  check("移到最前", (await room("data-worn")).endsWith("gar_bl"), await room("data-worn"));
  await page.click('[data-order="bottom"]');
  check("移到最後", (await room("data-worn")).startsWith("gar_bl"));
  await page.click('[data-order="up"]');
  await page.click('[data-order="up"]');
  check("逐層調整", (await room("data-worn")).split(",")[2] === "gar_bl", await room("data-worn"));

  console.log("衣物校正：造型內調整 vs 衣物預設");
  const from0 = await page.textContent('[data-testid="fit-from"]');
  await drag(await screen(600, 560), await screen(640, 600));
  await ready();
  check("直接在角色上拖動衣物", (await page.textContent('[data-testid="fit-from"]')).includes("只用於這個造型") && from0.includes("自動"), from0);
  check("未存為預設前，資料庫沒有這件衣物的 V2 設定", !(await env.DB.prepare("SELECT 1 FROM doll_fit_templates WHERE garment_id='gar_bl' AND avatar_id='avatar_v2'").first()));
  await page.click('[data-testid="fit-save-default"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="fit-from"]')?.textContent.includes("衣物預設"));
  const tpl = await env.DB.prepare("SELECT cx, cy, data FROM doll_fit_templates WHERE garment_id='gar_bl' AND avatar_id='avatar_v2'").first();
  check("存為衣物預設：位置及穿法設定寫入", tpl && Math.abs(tpl.cx - 640) < 12 && JSON.parse(tpl.data).opts.follow === "none", tpl);
  check("選中衣物：清楚顯示正在編輯哪一件，預設是位置工具", (await page.textContent('[data-testid="fit-name"]')).includes("襯衫") && (await page.getAttribute('[data-testid="fit-panel"]', "data-active-tool")) === "place" && (await page.locator('[data-testid="fit-size"]').count()) === 1);
  await page.click('[data-tool="follow"]');
  await page.click('[data-wear-mode="body"]');
  check("只在這個造型改變骨架跟隨方式", (await page.textContent('[data-testid="fit-from"]')).includes("只用於這個造型"));
  await page.click('[data-testid="fit-restore"]');
  check("恢復衣物預設", (await page.textContent('[data-testid="fit-from"]')).includes("衣物預設"));
  await page.click('[data-tool="wear"]');
  await page.click('[data-testid="add-variant"]');
  await page.waitForSelector("[data-variant]");
  const tpl2 = JSON.parse((await env.DB.prepare("SELECT data FROM doll_fit_templates WHERE garment_id='gar_bl' AND avatar_id='avatar_v2'").first()).data);
  check("保存另一種穿法", Object.values(tpl2.variants)[0]?.name === "收入裙內", tpl2.variants);
  await page.click('[data-tool="mesh"]');
  const oldK=Number(await page.getAttribute('[data-testid="doll-stage"]',"data-k"));
  await page.click('[data-testid="zoom-in"]');
  check("放大人物畫布",Number(await page.getAttribute('[data-testid="doll-stage"]',"data-k"))>oldK);
  await page.click('[data-view="full"]');
  const mp=page.locator('[data-mesh-point="5"]'), mb=await page.locator('[data-testid="doll-stage"]').boundingBox();
  const mx=mb.x+Number(await mp.getAttribute("data-x")),my=mb.y+Number(await mp.getAttribute("data-y"));
  const canvasPixels=()=>page.locator('[data-testid="doll-canvas"]').evaluate(c=>c.toDataURL());
  await ready(); const beforeMesh=await canvasPixels();
  await drag([mx,my],[mx+8,my+7]); await page.waitForTimeout(450);
  check("手動網格控制點可以拖動",Math.abs(Number(await mp.getAttribute("data-x"))+mb.x-mx)>2);
  await ready(); check("手動網格改變實際衣物畫布像素",(await canvasPixels())!==beforeMesh);
  await page.click('[data-testid="mesh-reset"]');await page.waitForTimeout(450);
  await page.click('[data-tool="mask"]');
  await drag(await screen(580, 500), await screen(640, 520));
  await page.waitForTimeout(500);
  await ready();
  check("遮罩：在角色身上塗抹，保存在這個造型（原圖不變）", (await room("data-masked")) === "1" && (await page.getAttribute('[data-testid="doll-stage"]', "data-mode")) === "mask");
  await shot("03-fit");

  console.log("Phase 3.1：撤銷、部件、獨立闊高、變形後的點選及遮罩");
  /** 畫布上某一點的顏色 */
  const colorAt = (x, y) => page.evaluate(([x, y]) => { const s = document.querySelector('[data-testid="doll-stage"]'), c = document.querySelector('[data-testid="doll-canvas"]'); const k = Number(s.dataset.k), dpr = c.width / s.getBoundingClientRect().width; return [...c.getContext("2d").getImageData(Math.round((x * k + Number(s.dataset.ox)) * dpr), Math.round((y * k + Number(s.dataset.oy)) * dpr), 1, 1).data]; }, [x, y]);
  const isCloth = (c) => c[3] > 200 && c[0] > 225 && c[1] > 215 && c[2] > 215 && Math.abs(c[0] - c[2]) < 22; // 測試襯衫是接近白色
  await page.waitForTimeout(500);
  await page.click('[data-testid="undo"]');
  await ready();
  check("撤銷：還原上一筆遮罩", (await room("data-masked")) === "0", await room("data-masked"));
  await page.click('[data-testid="redo"]');
  await ready();
  check("重做", (await room("data-masked")) === "1");
  await page.click('[data-testid="mask-clear"]');
  await page.click('[data-tool="follow"]');
  /** Phase 3.4：袖子分區等設定收在「進階設定」內 */
  const openAdv = async () => { if (await page.locator('[data-testid="rig-advanced"][aria-expanded="false"]').count()) await page.click('[data-testid="rig-advanced"]'); };
  await page.click('[data-wear-mode="auto"]');
    await openAdv();
  const sum0 = await page.textContent('[data-testid="rig-summary"]');
  check("部件：自動分辨出左右袖，並說明衣身保持完整", sum0.includes("自動分辨") && sum0.includes("右袖") && sum0.includes("左袖"), sum0);
  await page.click('[data-testid="parts-whole"]');
  check("可以改為整件衣物（不拆袖）", (await page.textContent('[data-testid="rig-summary"]')).includes("整件衣物") && (await room("data-parts")) === "1");
  await page.click('[data-testid="parts-auto"]');
  await page.click('[data-part="0"]');
  await drag(await screen(545, 520), await screen(530, 600));
  await page.waitForTimeout(450);
  check("用筆刷修改部件範圍（保存在這個造型）", (await room("data-parts")) === "1" && (await page.textContent('[data-testid="rig-summary"]')).includes("人工標記"), await page.textContent('[data-testid="rig-summary"]'));
  await page.click('[data-testid="part-stop"]');
  await page.click('[data-testid="parts-auto"]');
  await page.locator('input[data-sleeve="sleeve_l"]').fill("-20");
  await ready();
  check("袖子角度可以調整", (await page.textContent('[data-testid="fit-from"]')).includes("只用於這個造型"));
  await page.click('[data-tool="place"]');
  await page.click('[data-stretch="tall"]');
  await page.click('[data-testid="fit-save-default"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="fit-from"]')?.textContent.includes("衣物預設"));
  const tpl3 = JSON.parse((await env.DB.prepare("SELECT data FROM doll_fit_templates WHERE garment_id='gar_bl' AND avatar_id='avatar_v2'").first()).data);
  check("闊度及高度可獨立微調，並連同部件及袖子角度存入這個穿法的預設", Object.values(tpl3.variants).some((v) => v.fit?.sy > 1.02 && v.opts.sleeve_l === -20 && v.parts === "auto"), tpl3.variants);
  await page.click('[data-testid="fit-done"]');
  // 舉起左手：衣物跟隨變形後，直接點在舉起的袖子上選取，並只隱藏袖子上的一小塊
  await page.click('[data-tab="pose"]');
  await page.click('[data-pose="reach_out"]');
  await page.click('[data-tab="clothes"]');
  await ready();
  const sleeve = await page.evaluate(() => { const s = document.querySelector('[data-testid="doll-stage"]'), c = document.querySelector('[data-testid="doll-canvas"]'); const k = Number(s.dataset.k), dpr = c.width / s.getBoundingClientRect().width, ox = Number(s.dataset.ox), oy = Number(s.dataset.oy); const d = c.getContext("2d"); let best = null; for (let y = 330; y < 470; y += 6) for (let x = 1010; x > 800; x -= 6) { const p = d.getImageData(Math.round((x * k + ox) * dpr), Math.round((y * k + oy) * dpr), 1, 1).data; if (p[3] > 200 && p[0] > 225 && p[1] > 215 && p[2] > 215 && Math.abs(p[0] - p[2]) < 22) { if (!best || x > best[0]) best = [x, y]; break; } } return best; });
  check("舉手後袖子跟隨手臂（原本沒有布料的位置出現袖子）", !!sleeve && sleeve[0] > 850, sleeve);
  const tapAt = [sleeve[0] - 22, sleeve[1] + 6];
  await page.mouse.click(...(await screen(...tapAt)));
  check("直接點變形後的袖子即可選取這件衣物", (await room("data-selected")) === "gar_bl", await room("data-selected"));
  await shot("03a-posed-selected");
  await page.click('[data-tool="mask"]');
  await page.click('[data-testid="mask-hint"]');
  await shot("03a-posed-mask");
  const chest = [600, 470];
  check("塗抹前：袖子及胸口都有布料", isCloth(await colorAt(...tapAt)) && isCloth(await colorAt(...chest)), [await colorAt(...tapAt), await colorAt(...chest)]);
  await drag(await screen(tapAt[0] - 6, tapAt[1]), await screen(tapAt[0] + 6, tapAt[1]));
  await page.waitForTimeout(500);
  await ready();
  check("非預設姿勢下塗抹：只隱藏手指位置的袖子，胸口不受影響", !isCloth(await colorAt(...tapAt)) && isCloth(await colorAt(...chest)), [await colorAt(...tapAt), await colorAt(...chest)]);
  await shot("03b-posed-mask");
  await page.click('[data-testid="undo"]');
  await ready();
  check("撤銷後袖子復原", isCloth(await colorAt(...tapAt)));
  await page.click('[data-testid="fit-done"]');
  await page.click('[data-tab="pose"]');
  await page.click('[data-testid="pose-reset"]');
  await page.click('[data-tab="clothes"]');

  console.log("姿勢：穿著衣服直接調整骨架");
  await page.click('[data-tab="pose"]');
  await page.click('[data-posetab="joints"]');
  await page.click('[data-skel="full"]');
  check("姿勢模式在同一頁，完整骨架顯示控制點", (await page.getAttribute('[data-testid="doll-stage"]', "data-mode")) === "pose" && (await page.locator("[data-handle]").count()) >= 10, await page.locator("[data-handle]").count());
  await page.click('[data-posetab="presets"]');
  const arm0 = await pixels(860, 300, 200, 200);
  await page.click('[data-pose="reach_out"]');
  await ready();
  const pose1 = JSON.parse(await room("data-pose"));
  check("切換姿勢預設", pose1.shoulder_l === -62, pose1);
  check("角色及衣物即時更新", (await pixels(860, 300, 200, 200)) !== arm0);
  await shot("04-pose");
  await page.click('[data-pose="hand_on_hip"]');
  check("叉腰姿勢連同「手在衣服前」", (await room("data-front")) === "hand_r");
  await page.click('[data-testid="pose-reset"]');
  check("重設全部姿勢", (await room("data-pose")) === "{}");
  const h = page.locator('[data-handle="wrist_l"]');
  const hx = Number(await h.getAttribute("data-x")), hy = Number(await h.getAttribute("data-y"));
  const sb = await page.locator('[data-testid="doll-stage"]').boundingBox();
  await drag([sb.x + hx, sb.y + hy], [sb.x + hx + 34, sb.y + hy - 46]);
  const pose2 = JSON.parse(await room("data-pose"));
  check("拖動手腕控制點（IK）", Math.abs(pose2.shoulder_l ?? 0) + Math.abs(pose2.elbow_l ?? 0) > 5, pose2);
  const hh = page.locator('[data-handle="rot_head"]');
  await drag([sb.x + Number(await hh.getAttribute("data-x")), sb.y + Number(await hh.getAttribute("data-y"))], [sb.x + Number(await hh.getAttribute("data-x")) + 14, sb.y + Number(await hh.getAttribute("data-y")) + 2]);
  check("拖動頭頂控制點轉動頭部", Math.abs(JSON.parse(await room("data-pose")).head ?? 0) > 2);
  await page.click('[data-posetab="joints"]');
  await page.click('[data-region="body"]');
  await page.click('[data-joint="chest"]');
  await page.locator('input[data-bone="chest"]').fill("6");
  check("新增節點：上胸", JSON.parse(await room("data-pose")).chest === 6);
  await page.click('[data-joint="root"]');
  await page.locator('input[data-bone="root.x"]').fill("30");
  check("新增節點：整體重心平移", JSON.parse(await room("data-pose"))["root.x"] === 30);
  await page.click('[data-testid="bone-reset"]');
  check("重設單個關節", !("root.x" in JSON.parse(await room("data-pose"))) && JSON.parse(await room("data-pose")).chest === 6);
  await page.click('[data-region="arm_l"]');
  await page.click('[data-testid="region-reset"]');
  check("重設某個身體區域", !("shoulder_l" in JSON.parse(await room("data-pose"))) && JSON.parse(await room("data-pose")).chest === 6);
  await page.click('[data-skel="clean"]');
  check("乾淨預覽：畫布上沒有骨架控制點", (await page.locator("[data-handle]").count()) === 0 && (await page.locator("[data-bone-line]").count()) === 0);
  await page.click('[data-skel="full"]');

  console.log("外貌：角色保持可見");
  await page.click('[data-tab="look"]');
  const sb2 = await page.locator('[data-testid="doll-stage"]').boundingBox();
  check("外貌面板不遮住角色，並自動放大上半身", sb2.height > 280 && (await page.locator('[data-view="upper"]').getAttribute("aria-pressed")) === "true");
  await page.click('[data-looktab="color"]');
  const hair0 = await pixels(560, 20, 80, 60);
  await page.click('[data-color="purple"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="dressing-room"]').dataset.hairColor === "purple");
  await ready();
  await page.waitForTimeout(400);
  check("換髮色即時更新角色", (await pixels(560, 20, 80, 60)) !== hair0);
  check("七種髮色＋主髮色／挑染／髮尾漸層", (await page.locator("[data-color]").count()) === 7 && (await page.locator('[data-target="main"], [data-target="accent"], [data-target="tip"]').count()) === 3);
  await shot("05-color");

  console.log("角色素材：不改程式碼新增髮型及頭部");
  await page.click('[data-looktab="hair"]');
  await page.click('[data-testid="add-hair"]');
  await page.waitForSelector('[data-testid="asset-panel"]');
  let hairFiles, headFile;
  if (SOURCE && existsSync(SOURCE)) {
    const pick = (n) => join(SOURCE, readdirSync(SOURCE).find((f) => f.startsWith(n)));
    hairFiles = [pick("01374898"), pick("89805C2C")];
    headFile = pick("0B7B05E7");
  } else {
    const mk = async (name, svg) => ({ name, mimeType: "image/png", buffer: await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536">${svg}</svg>`)).png().toBuffer() });
    hairFiles = [await mk("後髮.png", '<path d="M300 200 Q512 40 724 200 L780 1300 L244 1300 Z" fill="#644950"/><path d="M330 400 L360 1280 L390 400 Z" fill="#e0899f"/>'), await mk("瀏海.png", '<path d="M330 260 Q512 80 694 260 L680 520 Q512 420 344 520 Z" fill="#6a4e56"/>')];
    headFile = await mk("頭.png", '<ellipse cx="512" cy="520" rx="250" ry="300" fill="#f6d8cf"/><circle cx="420" cy="560" r="26" fill="#7a3d69"/><circle cx="604" cy="560" r="26" fill="#7a3d69"/>');
  }
  await page.setInputFiles('[data-testid="asset-file"]', hairFiles);
  await page.waitForFunction(() => document.querySelectorAll("[data-part]").length === 2, null, { timeout: 30000 });
  check("一次上傳多張透明圖成為髮型部件", (await page.locator("[data-part]").count()) === 2);
  await ready();
  await page.fill('[data-testid="asset-name"]', "長直髮");
  await page.locator("[data-part]").nth(0).click();
  await page.click('[data-testid="part-layer"] [data-layer="back"]');
  const box0 = await page.locator('[data-testid="fit-frame"]').boundingBox();
  await drag([box0.x + box0.width / 2, box0.y + box0.height / 2], [box0.x + box0.width / 2 + 12, box0.y + box0.height / 2 + 8]);
  const box1 = await page.locator('[data-testid="fit-frame"]').boundingBox();
  check("在角色身上拖動校正髮型位置", Math.abs(box1.x - box0.x - 12) < 4 && Math.abs(box1.y - box0.y - 8) < 4, [box0, box1]);
  await page.locator("[data-part]").nth(1).click();
  await page.click('[data-testid="part-layer"] [data-layer="front"]');
  await page.click('[data-testid="part-own-bone"]');
  await shot("06-hair-editor");
  await page.click('[data-testid="asset-save"]');
  await page.waitForSelector('[data-testid="asset-panel"]', { state: "detached", timeout: 20000 });
  const hairId = await room("data-hair");
  const asset = await env.DB.prepare("SELECT name, config, thumb IS NOT NULL AS t FROM doll_assets WHERE id = ?").bind(hairId).first();
  const cfg = JSON.parse(asset?.config || "{}");
  check("髮型存入資料庫並即時套用到角色", /^das_/.test(hairId) && asset.name === "長直髮" && cfg.parts.length === 2 && cfg.parts[0].layer === "back" && cfg.parts[1].layer === "front" && cfg.parts[1].bone === "own" && asset.t === 1, asset);
  check("圖片存入 R2 的 doll/ 路徑（已清理雜點及裁邊）", [...env.IMAGES.objects.keys()].filter((k) => k.startsWith(`doll/assets/${hairId}/`)).length === 2);
  await ready();
  check("髮型列表出現新髮型", (await page.locator(`[data-asset="${hairId}"]`).count()) === 1);
  check("上傳的髮件自動分類（後髮、瀏海），名稱不是檔案識別碼", cfg.parts[0].cat === "back" && cfg.parts[1].cat === "bangs", cfg.parts.map((p) => [p.cat, p.label]));
  // 像換裝遊戲：按分類揀選髮件，同一分類互相替換，其他髮件不變
  await page.click('[data-hair-cat="back"]');
  const builtinBack = page.locator('[data-hair-piece$="/hair_back_base"]');
  await builtinBack.click();
  const worn1 = await page.locator("[data-worn-hair]").count();
  const cfg1 = await page.evaluate(() => [...document.querySelectorAll("[data-worn-hair]")].map((e) => e.textContent));
  check("選擇另一件後髮：只替換後髮，瀏海保留（不會重複加入）", worn1 === 2 && cfg1.some((t) => t.includes("瀏海")), cfg1);
  await builtinBack.click();
  check("再按已穿的髮件＝選取編輯，不會再加入一件", (await page.locator("[data-worn-hair]").count()) === 2 && (await page.locator('[data-testid="hair-editor"]').count()) === 1);
  await page.click('[data-hair-cat="side_r"]');
  await page.locator('[data-hair-piece$="/hair_side_r"]').click();
  check("加入其他分類（右側髮）不影響已穿的髮件", (await page.locator("[data-worn-hair]").count()) === 3);
  await shot("06b-hair-picker");
  await page.click('[data-testid="hair-extra"]');
  await page.click('[data-hair-cat="back"]');
  await page.locator(`[data-hair-piece^="${hairId}/"]`).first().click();
  check("「加入額外髮件」可以同時穿兩件同分類髮件", (await page.locator("[data-worn-hair]").count()) === 4);
  await page.click('[data-testid="hair-extra"]');
  await page.locator('[aria-label="移除髮件"]').last().click();
  await page.locator("[data-worn-hair]").first().click();
  await page.click('[data-testid="hair-mesh"]');
  check("髮件可使用手動網格",(await page.locator("[data-mesh-point]").count())===16);
  await page.locator('[aria-label="移除髮件"]').last().click();
  await page.click('[data-tab="pose"]');
  check("獨立髮束出現在骨架控制點", (await page.locator('[data-handle^="hp_"]').count()) === 1);
  await page.click('[data-tab="look"]');
  await page.click('[data-looktab="color"]');
  const c0 = await pixels(560, 20, 80, 60);
  await page.click('[data-color="silver"]');
  await ready();
  await page.waitForTimeout(500);
  check("上傳的髮型共用染色功能", (await pixels(560, 20, 80, 60)) !== c0);
  await page.click('[data-looktab="head"]');
  await page.click('[data-testid="add-head"]');
  await page.waitForSelector('[data-testid="asset-panel"]');
  await page.setInputFiles('[data-testid="asset-file"]', headFile);
  await page.waitForFunction(() => document.querySelector('[data-testid="fit-frame"]'), null, { timeout: 30000 });
  await page.fill('[data-testid="asset-name"]', "淡妝");
  await ready();
  await shot("07-head-editor");
  await page.click('[data-testid="asset-save"]');
  await page.waitForSelector('[data-testid="asset-panel"]', { state: "detached", timeout: 20000 });
  check("頭部素材獨立保存並套用", /^das_/.test(await room("data-head")) && (await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_assets WHERE kind='head'").first()).n === 1);
  await ready();
  await page.click('[data-view="head"]');
  await page.waitForTimeout(300);
  await shot("08-head-view");
  await page.click('[data-view="full"]');

  console.log("預覽");
  await page.click('[data-testid="focus"]');
  check("專注預覽：隱藏操作面板", (await page.locator('[data-testid="doll-panel"]').count()) === 0 && (await page.locator('[data-testid="doll-stage"]').boundingBox()).height > 550);
  await shot("09-focus");
  await page.click('[data-testid="focus"]');

  console.log("保存及重新開啟");
  await page.fill('[data-testid="look-name"]', "月夜茶會");
  const wornBefore = await room("data-worn"), poseBefore = await room("data-pose");
  await page.click('[data-testid="save-look"]');
  await page.waitForURL(/\/dressing\/look_/, { timeout: 20000 });
  await ready();
  const lookId = page.url().split("/").pop();
  const saved = await env.DB.prepare("SELECT name, avatar_id, state FROM doll_looks WHERE id = ?").bind(lookId).first();
  const st = JSON.parse(saved.state);
  check("保存完整造型：衣物次序、姿勢、髮型、髮色、頭部", saved.name === "月夜茶會" && saved.avatar_id === "avatar_v2" && st.items.map((i) => i.garment_id).join(",") === wornBefore && JSON.stringify(st.pose) === poseBefore && st.hair === hairId && st.hair_color === "silver" && /^das_/.test(st.head), st);
  const thumb = await env.DB.prepare("SELECT byte_size, mime_type FROM doll_look_thumbs WHERE look_id = ?").bind(lookId).first();
  check("造型縮圖＝實際組裝完成的角色畫面", thumb && thumb.mime_type === "image/jpeg" && thumb.byte_size > 4000 && thumb.byte_size < 160000, thumb);
  await page.reload();
  await ready();
  check("重新開啟後完整恢復", (await room("data-worn")) === wornBefore && (await room("data-pose")) === poseBefore && (await room("data-hair")) === hairId && (await room("data-hair-color")) === "silver" && (await room("data-dirty")) === "0");
  await shot("10-reopened");

  console.log("舊造型（Avatar V1）");
  await page.goto(base + "/dressing/look_v1");
  await ready();
  check("V1 舊造型可以開啟，衣物仍在", (await room("data-worn")) === "gar_jsk,gar_kc" && (await page.content()).includes("舊角色"));
  await shot("11-legacy");
  const v1Row = await env.DB.prepare("SELECT avatar_id, state FROM doll_looks WHERE id='look_v1'").first();
  check("開啟不會改寫舊記錄", v1Row.avatar_id === "base_v1" && v1Row.state === null);
  await page.click('[data-testid="save-look"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="dressing-room"]').dataset.dirty === "0", null, { timeout: 20000 });
  const v1After = await env.DB.prepare("SELECT avatar_id, state FROM doll_looks WHERE id='look_v1'").first();
  const v1State = JSON.parse(v1After.state);
  check("保存後轉換到新角色，個別位置已換算", v1After.avatar_id === "avatar_v2" && v1State.items.length === 2 && v1State.items[0].fit && v1State.items[0].fit.cy < 900, v1State.items);
  check("V1 的穿著模板保留", (await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_fit_templates WHERE avatar_id='base_v1'").first()).n === 1);

  console.log("回到主頁");
  await page.click('[aria-label="返回我的穿搭"]');
  await page.waitForSelector('[data-card]');
  check("主頁顯示三套造型及角色縮圖", (await page.locator("[data-card]").count()) === 3 && (await page.locator('[data-card="look"] img[src*="/thumb"]').count()) === 2);
  await page.waitForTimeout(400);
  await shot("12-home-after");
  await page.click(`[data-card="look"][data-id="${lookId}"] a`);
  await ready();
  check("點擊角色造型卡片進入換裝頁並恢復", (await room("data-worn")) === wornBefore);
  await page.goto(base + "/outfits");
  await page.waitForSelector('[data-card="outfit"]');
  await page.click('[data-card="outfit"] a');
  await page.waitForTimeout(600);
  check("點擊衣服配搭卡片進入配搭編輯器", page.url().endsWith("/outfits/out_old") && !(await page.locator('[data-testid="dressing-room"]').count()));

  check("衣物、衣物圖片及原有穿搭完全沒有被改動", (await snapshot()) === before);
  check("沒有頁面錯誤", errors.length === 0, errors.slice(0, 5));
} catch (e) {
  failures.push("測試中斷：" + (e?.message || e));
  console.log("  ✗ 測試中斷", String(e?.stack || e).slice(0, 900));
  await shot("error").catch(() => undefined);
  if (errors.length) console.log("  頁面錯誤", errors.slice(0, 5));
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${passed} 項通過，${failures.length} 項失敗`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
