// Phase 3.8 瀏覽器測試共用環境：本機模擬 D1／R2，esbuild 打包前端，iPhone 13 尺寸（桌面 Chromium 模擬，不等於 iPhone Safari 實機）。
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { makeEnv } from "./harness.mjs";
import { ROOT, TMP, buildApp, buildWorker } from "./doll-build.mjs";

const require = createRequire(import.meta.url);
export const { chromium, devices } = require("playwright");
export const sharp = require(process.env.SHARP_PATH || "sharp");
export const hex = async (u8) => Buffer.from(await crypto.subtle.digest("SHA-256", u8)).toString("hex");
export const now = () => new Date().toISOString();

export function checker() {
  let passed = 0; const failures = [];
  const check = (name, cond, info) => {
    if (cond) { passed++; console.log("  ✓", name); }
    else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
  };
  const done = () => { console.log(`\n${passed} 項通過，${failures.length} 項失敗`); if (failures.length) { console.log("失敗：", failures.join("、")); process.exitCode = 1; } };
  return { check, done };
}

/** 加入一件測試衣物（SVG → 透明 PNG），回傳 garment id */
export async function addGarment(env, { id, name, category, subcategory, svg, w = 900, h = 1200, price = null, favorite = 0, created = now(), opaque = false }) {
  // opaque：白色背景的原相（未去背），用來測試手動去背
  // 圖形以 900×1200 座標繪畫，按 w×h 輸出
  const body = opaque ? `<rect width="900" height="1200" fill="#ffffff"/>${svg}` : svg;
  const png = new Uint8Array(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 900 1200" preserveAspectRatio="none">${body}</svg>`)).png().toBuffer());
  const thumb = new Uint8Array(await sharp(Buffer.from(png)).resize(Math.round(w / 4), Math.round(h / 4)).webp({ quality: 80 }).toBuffer());
  const sha = await hex(png);
  // 圖片 id 必須是 base32（a–z、2–7）：數字 0、1、8、9 改為字母
  const iid = "img_" + id.replace(/[^a-z0-9]/g, "").replace(/[0189]/g, (d) => "wxyz"["0189".indexOf(d)]).slice(0, 20);
  await env.IMAGES.put(`garments/${id}/p.png`, png);
  await env.DB.prepare("INSERT INTO garments (id,name,category,subcategory,status,price,is_favorite,created_at,updated_at) VALUES (?,?,?,?, 'active', ?, ?, ?, ?)").bind(id, name, category, subcategory, price, favorite, created, created).run();
  await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)").bind(iid, id, opaque ? "original" : "processed", `garments/${id}/p.png`, "image/png", w, h, png.length, sha, opaque ? 0 : 1, created).run();
  await env.DB.prepare("INSERT INTO garment_thumbnails (image_id,garment_id,data,mime_type,byte_size,width,height,has_alpha,source_sha256,version,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(iid, id, thumb, "image/webp", thumb.length, Math.round(w / 4), Math.round(h / 4), opaque ? 0 : 1, sha, sha.slice(0, 16), created).run();
  return id;
}

export async function startApp(name = "p38") {
  const worker = await buildWorker(name + "-worker");
  const app = await buildApp();
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-P38-UI-1234")), now()).run();
  const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-P38-UI-1234", username: "tester", password: "test-password-1234" }) }), env);
  const [cookieName, cookieValue] = auth.headers.get("set-cookie").split(";")[0].split("=");
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const url = req.url.split("?")[0];
      if (!url.startsWith("/api/")) {
        if (url === "/assets/app.js") { res.setHeader("content-type", "application/javascript"); return res.end(app.js); }
        if (url === "/assets/app.css") { res.setHeader("content-type", "text/css"); return res.end(app.css); }
        const file = join(ROOT, "public", url);
        if (url.startsWith("/doll/") && existsSync(file)) { res.setHeader("content-type", "image/png"); return res.end(readFileSync(file)); }
        if (url === "/sw.js") { res.statusCode = 404; return res.end(); }
        res.setHeader("content-type", "text/html");
        return res.end(app.html);
      }
      requests.push(req.method + " " + req.url);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const r = await worker.fetch(new Request("http://localhost" + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.statusCode = 500; res.end(String(e)); }
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
  page.on("dialog", (d) => d.accept());
  const close = async () => { await browser.close(); server.close(); };
  return { env, base, page, ctx, browser, errors, requests, close, TMP };
}

/** 換裝頁輔助 */
export function roomHelpers(page) {
  const room = (attr) => page.getAttribute('[data-testid="dressing-room"]', attr);
  const ready = async () => { await page.waitForFunction(() => { const r = document.querySelector('[data-testid="dressing-room"]'); const c = document.querySelector('[data-testid="doll-canvas"]'); return r && c && c.dataset.ready === "1" && r.dataset.resolved === String((r.dataset.worn || "").split(",").filter(Boolean).length); }, null, { timeout: 20000 }); await page.waitForTimeout(150); };
  const screen = async (x, y) => page.evaluate(([x, y]) => { const s = document.querySelector('[data-testid="doll-stage"]'); const r = s.getBoundingClientRect(); return [r.left + x * Number(s.dataset.k) + Number(s.dataset.ox), r.top + y * Number(s.dataset.k) + Number(s.dataset.oy)]; }, [x, y]);
  const drag = async (from, to, steps = 8) => { await page.mouse.move(from[0], from[1]); await page.mouse.down(); for (let i = 1; i <= steps; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps); await page.mouse.up(); };
  /** 邏輯座標範圍內符合條件的像素數目 */
  const count = (x, y, w, h, kind) => page.evaluate(([x, y, w, h, kind]) => { const s = document.querySelector('[data-testid="doll-stage"]'), c = document.querySelector('[data-testid="doll-canvas"]'); const k = Number(s.dataset.k), dpr = c.width / s.getBoundingClientRect().width; const X = Math.round((x * k + Number(s.dataset.ox)) * dpr), Y = Math.round((y * k + Number(s.dataset.oy)) * dpr), W = Math.max(1, Math.round(w * k * dpr)), H = Math.max(1, Math.round(h * k * dpr)); const d = c.getContext("2d").getImageData(X, Y, W, H).data; let n = 0; for (let i = 0; i < d.length; i += 4) { const g = kind === "lace" ? d[i] < 70 && d[i + 1] > 90 && d[i + 2] < 70 : d[i + 3] > 0; if (g) n++; } return n; }, [x, y, w, h, kind]);
  const colorAt = (x, y) => page.evaluate(([x, y]) => { const s = document.querySelector('[data-testid="doll-stage"]'), c = document.querySelector('[data-testid="doll-canvas"]'); const k = Number(s.dataset.k), dpr = c.width / s.getBoundingClientRect().width; return [...c.getContext("2d").getImageData(Math.round((x * k + Number(s.dataset.ox)) * dpr), Math.round((y * k + Number(s.dataset.oy)) * dpr), 1, 1).data]; }, [x, y]);
  return { room, ready, screen, drag, count, colorAt };
}
