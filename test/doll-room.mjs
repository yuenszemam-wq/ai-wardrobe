// 換裝頁瀏覽器測試的共用環境（Phase 3.2）：本機模擬 D1／R2、打包前端、開一個模擬 iPhone 的 Chromium。
// 提供觸控手勢（單指、雙指）及畫布座標換算。只供開發測試，不接觸正式服務。
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { makeEnv } from "./harness.mjs";
import { ROOT, TMP, buildApp, buildWorker } from "./doll-build.mjs";

const require = createRequire(import.meta.url);
const { chromium, devices } = require("playwright");
export const sharp = require(process.env.SHARP_PATH || "sharp");
const hex = async (u8) => Buffer.from(await crypto.subtle.digest("SHA-256", u8)).toString("hex");
const now = () => new Date().toISOString();
export const svgPng = async (svg, w = 900, h = 1200) => new Uint8Array(await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svg}</svg>`)).png().toBuffer());

/**
 * garments: [{ id, name, category, subcategory, png(Uint8Array) }]
 * device: Playwright 裝置名稱（預設 iPhone 13）；viewport 可覆寫螢幕大小
 */
export async function startRoom({ garments, device = "iPhone 13", viewport, name = "room" }) {
  const worker = await buildWorker(name + "-worker");
  const app = await buildApp();
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO app_settings (key,value,updated_at) VALUES ('setup_code_hash',?,?)").bind(await hex(new TextEncoder().encode("TEST-ROOM-1234")), now()).run();
  const auth = await worker.fetch(new Request("http://localhost/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TEST-ROOM-1234", username: "tester", password: "test-password-1234" }) }), env);
  const [cookieName, cookieValue] = auth.headers.get("set-cookie").split(";")[0].split("=");
  let n = 0;
  for (const g of garments) {
    const meta = await sharp(Buffer.from(g.png)).metadata();
    const thumb = new Uint8Array(await sharp(Buffer.from(g.png)).resize(225, 300, { fit: "inside" }).webp({ quality: 80 }).toBuffer());
    const sha = await hex(g.png), iid = "img_" + "abcdefghij"[n++ % 10].repeat(8);
    g.image_id = iid;
    await env.IMAGES.put(`garments/${g.id}/p.png`, g.png);
    await env.DB.prepare("INSERT INTO garments (id,name,category,subcategory,status,created_at,updated_at) VALUES (?,?,?,?, 'active', ?, ?)").bind(g.id, g.name, g.category, g.subcategory ?? null, now(), now()).run();
    await env.DB.prepare("INSERT INTO garment_images (id,garment_id,image_type,r2_key,mime_type,width,height,file_size,sha256,has_alpha,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,1,?)").bind(iid, g.id, "processed", `garments/${g.id}/p.png`, "image/png", meta.width, meta.height, g.png.length, sha, now()).run();
    await env.DB.prepare("INSERT INTO garment_thumbnails (image_id,garment_id,data,mime_type,byte_size,width,height,has_alpha,source_sha256,version,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?)").bind(iid, g.id, thumb, "image/webp", thumb.length, 225, 300, sha, sha.slice(0, 16), now()).run();
  }
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
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext({ ...devices[device], ...(viewport ? { viewport } : {}), deviceScaleFactor: Number(process.env.DOLL_DPR || 1) });
  await ctx.addCookies([{ name: cookieName, value: cookieValue, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "測試" : undefined));
  const cdp = await ctx.newCDPSession(page);

  const room = (attr) => page.getAttribute('[data-testid="dressing-room"]', attr);
  const stage = (attr) => page.getAttribute('[data-testid="doll-stage"]', attr);
  const ready = async () => {
    await page.waitForFunction(() => { const r = document.querySelector('[data-testid="dressing-room"]'); const c = document.querySelector('[data-testid="doll-canvas"]'); return r && c && c.dataset.ready === "1" && r.dataset.resolved === String((r.dataset.worn || "").split(",").filter(Boolean).length); }, null, { timeout: 20000 });
    await page.waitForTimeout(140);
  };
  /** 邏輯座標 → 螢幕座標（已計及目前的鏡頭） */
  const screen = (x, y) => page.evaluate(([x, y]) => { const s = document.querySelector('[data-testid="doll-stage"]'); const r = s.getBoundingClientRect(); return [r.left + x * Number(s.dataset.k) + Number(s.dataset.ox), r.top + y * Number(s.dataset.k) + Number(s.dataset.oy)]; }, [x, y]);
  /** 畫布某範圍（邏輯座標）的像素摘要 */
  const pixels = (x, y, w = 60, h = 60) => page.evaluate(([x, y, w, h]) => {
    const s = document.querySelector('[data-testid="doll-stage"]'), c = document.querySelector('[data-testid="doll-canvas"]');
    const k = Number(s.dataset.k), dpr = c.width / s.getBoundingClientRect().width;
    const d = c.getContext("2d").getImageData(Math.round((x * k + Number(s.dataset.ox)) * dpr), Math.round((y * k + Number(s.dataset.oy)) * dpr), Math.max(1, Math.round(w * k * dpr)), Math.max(1, Math.round(h * k * dpr))).data;
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; }
    const n = d.length / 4;
    return [r / n, g / n, b / n, a / n].map((v) => Math.round(v));
  }, [x, y, w, h]);
  // ───── 觸控（經 CDP 送出真正的 touch 事件，瀏覽器會轉成 pointer 事件） ─────
  const touch = (type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y], id) => ({ x: Math.round(x), y: Math.round(y), id })) });
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  /** 單指拖動 */
  const swipe = async (from, to, steps = 8) => { await touch("touchStart", [from]); for (let i = 1; i <= steps; i++) await touch("touchMove", [lerp(from, to, i / steps)]); await touch("touchEnd", []); await page.waitForTimeout(60); };
  /** 雙指：兩隻手指分別由 a0→a1、b0→b1（可同時表達縮放及平移）。stagger＝第二指較遲落下（模擬真實情況） */
  const twoFinger = async (a0, a1, b0, b1, { steps = 10, stagger = true, firstMoves = 0 } = {}) => {
    if (stagger) { await touch("touchStart", [a0]); for (let i = 1; i <= firstMoves; i++) await touch("touchMove", [[a0[0] + i, a0[1] + i]]); await touch("touchStart", [firstMoves ? [a0[0] + firstMoves, a0[1] + firstMoves] : a0, b0]); } else await touch("touchStart", [a0, b0]);
    for (let i = 1; i <= steps; i++) await touch("touchMove", [lerp(a0, a1, i / steps), lerp(b0, b1, i / steps)]);
    await touch("touchEnd", [a1]);
    await touch("touchEnd", []);
    await page.waitForTimeout(80);
  };
  const pinch = (center, d0, d1, opts) => twoFinger([center[0] - d0 / 2, center[1]], [center[0] - d1 / 2, center[1]], [center[0] + d0 / 2, center[1]], [center[0] + d1 / 2, center[1]], opts);
  const tap = async (p) => { await touch("touchStart", [p]); await touch("touchEnd", []); await page.waitForTimeout(80); };
  const close = async () => { await browser.close(); server.close(); };
  return { page, env, base, errors, room, stage, ready, screen, pixels, touch, swipe, twoFinger, pinch, tap, close, TMP };
}

export function checker() {
  let passed = 0;
  const failures = [];
  const origLog = console.log;
  console.log = (...a) => { if (typeof a[0] === "string" && a[0].startsWith('{"m"')) return; origLog(...a); };
  const check = (name, cond, info) => {
    if (cond) { passed++; console.log("  ✓", name); }
    else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
  };
  const done = () => { console.log(`\n${passed} 項通過，${failures.length} 項失敗`); if (failures.length) { console.log(failures.join("\n")); process.exitCode = 1; } };
  return { check, done };
}
