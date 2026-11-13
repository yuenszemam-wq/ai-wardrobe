// 衣物變形實驗室（開發工具）：用真實的衣物透明圖，在不同姿勢下把角色及衣物畫出來，輸出 PNG 供人眼檢查。
// 執行：MESH_SOURCE=放衣物 PNG 的資料夾 MESH_OUT=輸出資料夾 node test/mesh-lab.mjs
// 衣物圖片屬於使用者的私人衣櫃，不放進 repo；沒有 MESH_SOURCE 時用內置的 SVG 測試衣物。
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { build } from "esbuild";
import { ROOT, TMP } from "./doll-build.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require(process.env.SHARP_PATH || "sharp");
const SOURCE = process.env.MESH_SOURCE || "";
const OUT = process.env.MESH_OUT || join(TMP, "mesh-lab");
mkdirSync(OUT, { recursive: true });

export const SVG_GARMENTS = {
  blouse: ["top", "上衣", '<path d="M330 200 L570 200 L600 760 L300 760 Z" fill="#fffaf6" stroke="#c9b8c4" stroke-width="6"/><path d="M300 210 L190 800 L90 780 L215 210 Z M600 210 L710 800 L810 780 L685 210 Z" fill="#f3e9ee" stroke="#c9b8c4" stroke-width="6"/><path d="M390 200 L510 200 L510 130 L390 130 Z" fill="#d9c8d4"/>'],
  puff: ["top", "上衣", '<path d="M300 220 L600 220 L620 700 L680 860 L220 860 L280 700 Z" fill="#c9a0b4"/><path d="M300 300 L80 300 Q30 420 90 520 L300 520 Z M600 300 L820 300 Q870 420 810 520 L600 520 Z" fill="#b98aa2"/><path d="M90 520 L300 520 L300 560 L90 560 Z M600 520 L810 520 L810 560 L600 560 Z" fill="#333"/>'],
  socks: ["socks", "襪", '<rect x="290" y="250" width="110" height="700" fill="#222"/><rect x="500" y="250" width="110" height="700" fill="#222"/>'],
  shoes: ["shoes", "鞋", '<rect x="250" y="520" width="170" height="160" rx="40" fill="#4a1c2a"/><rect x="480" y="520" width="170" height="160" rx="40" fill="#4a1c2a"/>'],
  pants: ["pants", "褲", '<path d="M300 200 L600 200 L640 1100 L480 1100 L450 520 L420 1100 L260 1100 Z" fill="#33415c"/>'],
};
const SLOT_BY_NAME = [[/jsk|op|dress|連身/i, "dress", "連身裙"], [/skirt|sk|裙/i, "skirt", "半身裙"], [/jacket|coat|外套/i, "outer", "外套"], [/sock|襪/i, "socks", "襪"], [/shoe|鞋/i, "shoes", "鞋"], [/pant|褲/i, "pants", "褲"]];

const files = new Map();
if (SOURCE && existsSync(SOURCE)) for (const f of readdirSync(SOURCE)) if (/\.(png|webp)$/i.test(f)) files.set(f.replace(/\.[^.]+$/, ""), readFileSync(join(SOURCE, f)));
const garments = [];
for (const [name, buf] of files) { const m = SLOT_BY_NAME.find(([re]) => re.test(name)); garments.push({ name, slot: m ? m[1] : "top", category: m ? m[2] : "上衣" }); void buf; }
for (const [name, [slot, category, svg]] of Object.entries(SVG_GARMENTS)) if (!files.has(name) && (!SOURCE || /socks|shoes|pants/.test(name))) { files.set(name, await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">${svg}</svg>`)).png().toBuffer()); garments.push({ name, slot, category }); }

const entry = join(TMP, "mesh-lab-entry.ts");
writeFileSync(entry, `
import { DollRenderer } from "${ROOT}/src/doll/engine";
import { analyze } from "${ROOT}/src/doll/content";
import { defaultFit, defaultOpts } from "${ROOT}/shared/doll";
import { POSE_PRESETS, BUILTIN_HAIRS, BUILTIN_HEADS, RIG_V2 } from "${ROOT}/shared/avatarV2";
import { solve } from "${ROOT}/shared/avatarRig";
const R = new DollRenderer();
(window as any).presets = POSE_PRESETS.map((p) => [p.id, p.label]);
(window as any).lab = async (o: any) => {
  const canvas = document.getElementById("c") as HTMLCanvasElement;
  canvas.width = 600 * (o.cols ?? 1); canvas.height = 900;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#efe6f0"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const items = [];
  for (const g of o.garments) {
    const a = await analyze("/g/" + g.name + ".png");
    const fit = { ...defaultFit(g.slot, a.content, g.category, null, g.name), ...(g.fit ?? {}) };
    if (g.scale) fit.w *= g.scale;
    items.push({ key: g.name, image: "/g/" + g.name + ".png", slot: g.slot, fit, content: a.content, grid: a.grid, opts: { ...defaultOpts(g.slot), ...(g.opts ?? {}) }, mask: g.mask ?? null, parts: g.parts ?? null, hidden: false });
  }
  const info: any = {};
  let col = 0;
  for (const poseId of o.poses) {
    const pose = typeof poseId === "string" ? POSE_PRESETS.find((p) => p.id === poseId)!.pose : poseId;
    const scene = { hair: o.noHair ? null : BUILTIN_HAIRS[0].config, head: BUILTIN_HEADS[0].config, main: null, accent: null, tip: null, pose, front: [], items, overlay: o.overlay ?? null } as any;
    for (let i = 0; i < 200; i++) { ctx.save(); ctx.beginPath(); ctx.rect(col * 600, 0, 600, 900); ctx.clip(); ctx.fillStyle = "#efe6f0"; ctx.fillRect(col * 600, 0, 600, 900); const z = o.view?.k ?? 0.5; const ok = R.paint(ctx, scene, [z, 0, 0, z, col * 600 - z * (o.view?.x ?? 0), -z * (o.view?.y ?? 0)]); ctx.restore(); if (ok) break; await new Promise((r) => setTimeout(r, 50)); }
    col++;
  }
  for (const it of items) { const m = R.geometry(it as any); info[it.key] = { ...m.info, layers: m.layers.map((l) => [l.part, l.cols + 'x' + l.rows, l.order.length, [...l.cell].filter((c) => c === -1).length].join(':')).join(' '), fit: it.fit }; }
  return info;
};
`);
await build({ target: "es2022", entryPoints: [entry], bundle: true, format: "esm", platform: "browser", outfile: join(TMP, "mesh-lab.js"), logLevel: "error", loader: { ".json": "json" } });
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/") return res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><canvas id="c"></canvas><script type="module" src="/lab.js"></script>');
  if (url === "/lab.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(join(TMP, "mesh-lab.js")));
  if (url.startsWith("/g/")) { const b = files.get(url.slice(3).replace(/\.png$/, "")); return b ? res.writeHead(200, { "content-type": "image/png" }).end(b) : res.writeHead(404).end(); }
  const p = join(ROOT, "public", url);
  return existsSync(p) ? res.writeHead(200, { "content-type": url.endsWith(".json") ? "application/json" : "image/png" }).end(readFileSync(p)) : res.writeHead(404).end();
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined) });
const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.lab);
const presets = await page.evaluate(() => window.presets);
console.log("poses:", presets.map((p) => p.join("=")).join(" "));
export async function shot(name, opts) {
  const info = await page.evaluate((o) => window.lab(o), opts);
  await (await page.$("#c")).screenshot({ path: join(OUT, name + ".png") });
  return info;
}
export { garments, presets, OUT, sharp };
/** 登記一件用 SVG 畫的測試衣物 */
export async function addSvg(name, svg) { files.set(name, await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">${svg}</svg>`)).png().toBuffer()); }
export const close = async () => { await browser.close(); server.close(); };
if (process.argv[1] && process.argv[1].endsWith("mesh-lab.mjs")) {
  const want = (process.env.MESH_POSES || "a_pose,arms_down,hand_on_hip,arms_out").split(",");
  const poses = want.filter((p) => presets.some(([id]) => id === p));
  for (const g of garments) { const info = await shot(g.name, { garments: [{ ...g, scale: Number(process.env.MESH_SCALE || 1) }], poses, cols: poses.length, overlay: process.env.MESH_PARTS ? { key: g.name, mode: "parts" } : null, view: process.env.MESH_VIEW ? JSON.parse(process.env.MESH_VIEW) : undefined }); console.log(g.name, JSON.stringify(info[g.name])); }
  await close();
}
