// Phase 3.8A：遮罩「隱藏／移到身後」實際像素測試（瀏覽器 Canvas，正式渲染器）
// 執行：node test/phase38.mjs   （需要 esbuild、sharp、playwright）。桌面 Chromium，不等於 iPhone Safari 實機。
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { ROOT, TMP } from "./doll-build.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require(process.env.SHARP_PATH || "sharp");
let passed = 0; const failures = [];
const check = (name, cond, info) => { if (cond) { passed++; console.log("  ✓", name); } else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); } };

const bundle = join(TMP, "p38-engine.js");
await build({ entryPoints: [join(ROOT, "test/fixtures/engine-entry.ts")], bundle: true, format: "esm", platform: "browser", outfile: bundle, logLevel: "error" });
// 測試衣物：白色衣身＋一條很闊的綠色「後領蕾絲」帶，橫跨頸部並伸出頸部及肩膊輪廓之外（避免選區完全在身體內而誤判成功）
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><path d="M330 200 L570 200 L600 760 L300 760 Z" fill="#fffaf6"/><path d="M300 210 L190 800 L90 780 L215 210 Z M600 210 L710 800 L810 780 L685 210 Z" fill="#f3e9ee"/><rect x="40" y="20" width="820" height="160" fill="#10b020"/></svg>`;
const png = await sharp(Buffer.from(svg)).png().toBuffer();
const srv = createServer((q, s) => {
  const u = q.url.split("?")[0];
  if (u === "/") { s.setHeader("content-type", "text/html"); return s.end(`<!doctype html><body><script type=module src="/e.js"></script>`); }
  if (u === "/e.js") { s.setHeader("content-type", "text/javascript"); return s.end(readFileSync(bundle)); }
  if (u === "/g.png") { s.setHeader("content-type", "image/png"); return s.end(png); }
  const f = join(ROOT, "public", u); if (u.startsWith("/doll/") && existsSync(f)) { s.setHeader("content-type", "image/png"); return s.end(readFileSync(f)); }
  s.statusCode = 404; s.end();
}).listen(0);
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`http://localhost:${srv.address().port}/`);
await page.waitForFunction(() => window.T);
await page.evaluate(async () => {
  const T = window.T;
  const an = await T.analyze("/g.png");
  const mkMask = (mode, rect = [40, 20, 820, 160]) => { const c = document.createElement("canvas"); c.width = 900; c.height = 1200; const x = c.getContext("2d"); x.fillStyle = "#000"; x.fillRect(0, 0, 900, 1200); if (mode) { x.fillStyle = mode === "hide" ? "#f00" : "#0f0"; x.fillRect(...rect); } return c.toDataURL("image/png"); };
  const scene = (o = {}) => ({ hair: null, head: T.BUILTIN_HEADS[0].config, main: null, accent: null, tip: null, pose: o.pose ?? {}, front: [], items: [{ key: "g", image: "/g.png", slot: "top", fit: { ...T.defaultFit("top", an.content), ...(o.fit ?? {}) }, content: an.content, grid: an.grid, opts: T.defaultOpts("top"), mask: o.mask ?? null, parts: null, hidden: false }] });
  const green = (d) => { let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 70 && d[i + 1] > 90 && d[i + 2] < 70 && d[i + 3] > 200) n++; return n; };
  const render = async (sc, model) => {
    const r = new T.DollRenderer(model);
    const c = document.createElement("canvas"); c.width = 600; c.height = 900; const ctx = c.getContext("2d");
    let ok = false;
    for (let i = 0; i < 120 && !ok; i++) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 600, 900); ok = r.paint(ctx, sc, [0.5, 0, 0, 0.5, 0, 0]); if (!ok) await new Promise((res) => setTimeout(res, 40)); }
    return { ok, d: ctx.getImageData(0, 0, 600, 900).data, r };
  };
  /** 兩個結果中都是綠色的像素比例（身後的綠色應該全部位於原本有綠色的位置＝對準） */
  const within = (a, b) => { let n = 0, m = 0; for (let i = 0; i < a.length; i += 4) { const ga = a[i] < 70 && a[i + 1] > 90 && a[i + 2] < 70 && a[i + 3] > 200; if (!ga) continue; n++; if (b[i] < 70 && b[i + 1] > 90 && b[i + 2] < 70) m++; } return n ? m / n : 1; };
  window.P38 = { an, mkMask, scene, green, render, within };
});

console.log("遮罩：隱藏與移到身後");
const r1 = await page.evaluate(async () => {
  const { mkMask, scene, green, render, within } = window.P38;
  const none = await render(scene()), hide = await render(scene({ mask: mkMask("hide") })), behind = await render(scene({ mask: mkMask("behind") }));
  const st = behind.r.behindStats(scene({ mask: mkMask("behind") }), "g");
  return { none: green(none.d), hide: green(hide.d), behind: green(behind.d), ok: none.ok && hide.ok && behind.ok, align: within(behind.d, none.d), st };
});
check("未遮罩時後領可見", r1.ok && r1.none > 2000, r1);
check("隱藏：全部選中像素消失", r1.hide === 0, r1);
check("移到身後：被頸部及身體遮住的部分消失，但輪廓外的後領仍然可見", r1.behind > 300 && r1.behind < r1.none * 0.9, r1);
check("隱藏與移到身後的像素結果可以明確區分", r1.behind - r1.hide > 300, r1);
check("身後部分的位置與原本布料對準（沒有錯位）", r1.align > 0.97, r1.align);
check("量度：身後像素總數及仍可見數目", r1.st && r1.st.total > r1.st.visible && r1.st.visible > 0, r1.st);

console.log("選區完全位於身體內部（不可當成功證據）");
const r2 = await page.evaluate(async () => {
  const { mkMask, scene, green, render } = window.P38;
  // 只選中頸部正中一小塊：身後結果與隱藏一樣看不到，量度應顯示 0% 可見
  const sc = scene({ mask: mkMask("behind", [430, 110, 40, 40]) });
  const b = await render(sc), n = await render(scene());
  return { st: b.r.behindStats(sc, "g"), diff: green(n.d) - green(b.d) };
});
check("身體內部的身後選區：量度顯示沒有可見像素（不是誤刪，是被身體遮住）", r2.st && r2.st.total > 0 && r2.st.visible <= r2.st.total * 0.05, r2);

console.log("衣物旋轉、網格變形、姿勢改變");
const r3 = await page.evaluate(async () => {
  const { mkMask, scene, green, render, within } = window.P38;
  const out = {};
  for (const [k, o] of [["rot", { fit: { rotation: 7 } }], ["mesh", { fit: { mesh: Array.from({ length: 32 }, (_, i) => (i === 10 ? 0.04 : i === 11 ? -0.03 : 0)) } }], ["pose", { pose: { head: 12, neck: -8, shoulder_l: -50, shoulder_r: 40 } }]]) {
    const n = await render(scene(o)), h = await render(scene({ ...o, mask: mkMask("hide") })), b = await render(scene({ ...o, mask: mkMask("behind") }));
    out[k] = { none: green(n.d), hide: green(h.d), behind: green(b.d), align: within(b.d, n.d) };
  }
  return out;
});
for (const [k, label] of [["rot", "衣物旋轉"], ["mesh", "手動網格變形"], ["pose", "轉動頭部及手臂"]]) {
  const v = r3[k];
  check(`${label}後：隱藏全部消失、身後仍有輪廓外部分，並與布料對準`, v.hide === 0 && v.behind > 200 && v.align > 0.95, v);
}

console.log("自訂身體模型按新輪廓遮擋");
const r4 = await page.evaluate(async () => {
  const { mkMask, scene, green, render } = window.P38, T = window.T;
  const p = T.RIG_V2.parts.neck, t = T.RIG_V2.parts.torso, ch = T.RIG_V2.parts.chest;
  // 頸部及上身加闊加高：同一個身後選區，可見部分應該減少（按新身體實際輪廓遮擋）
  const big = (q) => ({ x: q.x - 110, y: q.y - 50, w: q.w + 220, h: q.h + 50 });
  const wide = T.buildModel("dm_testwideneck", 2, { ...T.EMPTY_DEF, parts: { neck: { x: p.x - 60, y: p.y - 20, w: p.w + 120, h: p.h + 20 }, torso: big(t), chest: big(ch) } });
  const sc = scene({ mask: mkMask("behind") });
  const v2 = await render(sc), cu = await render(sc, wide);
  // 頸部旋轉：渲染完成、沒有錯誤
  const rot = T.buildModel("dm_testrotneck", 2, { ...T.EMPTY_DEF, parts: { neck: { x: p.x, y: p.y, w: p.w, h: p.h, rot: 10 } } });
  const ro = await render(scene(), rot);
  return { v2: green(v2.d), custom: green(cu.d), rotOk: ro.ok };
});
check("自訂身體（較闊頸部及上身）：身後部分按新輪廓被遮住較多", r4.custom < r4.v2 && r4.custom > 0, r4);
check("自訂身體旋轉頸部部件：後領重畫正常完成", r4.rotOk, r4);

console.log("遮罩讀取中不算完整畫面（縮圖及匯出會等待遮罩）");
const r5 = await page.evaluate(async () => {
  const { mkMask, scene } = window.P38, T = window.T;
  const r = new T.DollRenderer();
  const c = document.createElement("canvas"); c.width = 600; c.height = 900;
  // 先讓衣物圖片讀好，再換一個未讀取的遮罩
  for (let i = 0; i < 100 && !r.paint(c.getContext("2d"), scene(), [0.5, 0, 0, 0.5, 0, 0]); i++) await new Promise((res) => setTimeout(res, 40));
  return r.paint(c.getContext("2d"), scene({ mask: mkMask("behind", [100, 30, 500, 100]) }), [0.5, 0, 0, 0.5, 0, 0]);
});
check("遮罩未讀取完成時 paint() 回傳未完成", r5 === false, r5);

console.log("衣物原圖視圖：三種狀態分開顯示");
const r6 = await page.evaluate(async () => {
  const { mkMask, an } = window.P38, T = window.T;
  const c = document.createElement("canvas");
  const mask = (() => { const m = document.createElement("canvas"); m.width = 900; m.height = 1200; const x = m.getContext("2d"); x.fillStyle = "#000"; x.fillRect(0, 0, 900, 1200); x.fillStyle = "#f00"; x.fillRect(40, 20, 400, 160); x.fillStyle = "#0f0"; x.fillRect(460, 20, 400, 160); return m.toDataURL(); })();
  const sc = (overlay) => ({ hair: null, head: T.BUILTIN_HEADS[0].config, main: null, accent: null, tip: null, pose: {}, front: [], flat: "g", overlay: overlay ? { key: "g", mode: "mask" } : null, items: [{ key: "g", image: "/g.png", slot: "top", fit: T.defaultFit("top", an.content), content: an.content, grid: an.grid, opts: T.defaultOpts("top"), mask, parts: null, hidden: false }] });
  const r = new T.DollRenderer(); c.width = 600; c.height = 900; const ctx = c.getContext("2d");
  for (let i = 0; i < 100; i++) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 600, 900); if (r.paint(ctx, sc(true), [0.5, 0, 0, 0.5, 0, 0])) break; await new Promise((res) => setTimeout(res, 40)); }
  const fr = T.flatRect(an.content.ar);
  const at = (u, v) => [...ctx.getImageData(Math.round((fr.x + u * fr.w) * 0.5), Math.round((fr.y + v * fr.h) * 0.5), 1, 1).data];
  return { hidden: at(240 / 900, 100 / 1200), behind: at(660 / 900, 100 / 1200), normal: at(450 / 900, 500 / 1200) };
});
const reddish = (c) => c[0] > c[2] + 40, bluish = (c) => c[2] > c[0] + 40;
check("原圖：隱藏位置以紅色提示、身後位置以藍色提示、其他正常", reddish(r6.hidden) && bluish(r6.behind) && !reddish(r6.normal) && !bluish(r6.normal), r6);

check("沒有瀏覽器錯誤", errors.length === 0, errors);
await browser.close(); srv.close();
console.log(`\n${passed} 項通過，${failures.length} 項失敗`);
if (failures.length) { console.log("失敗：", failures.join("、")); process.exitCode = 1; }
