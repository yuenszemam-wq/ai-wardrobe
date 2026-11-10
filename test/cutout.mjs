// 自動去背測試：node test/cutout.mjs [假透明圖片路徑]
// 需要 sharp（只供開發環境）及 Node 22.18+（直接載入 .ts）。
// 沒有指定圖片時，用程式合成的「棋盤格＋衣服」測試。
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { autoCutout } from "../src/cutout.ts";

const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");
const OUT = new URL("./.tmp/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

let passed = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failures.push(name);
    console.log("  ✗", name, info !== undefined ? JSON.stringify(info) : "");
  }
}

async function load(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

/** 合成：棋盤格（非整數格子、帶雜訊）上放一件「裙子」：深色外框、內有純白玫瑰、一個被圍住的洞 */
function synth({ w = 600, h = 700, tile = 18.5, bg = "checker" } = {}) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const inShape = (x, y) => {
    const dx = (x - w / 2) / (w * 0.36), dy = (y - h * 0.55) / (h * 0.36);
    return dx * dx + dy * dy <= 1;
  };
  const inRose = (x, y) => (x - w / 2) ** 2 + (y - h * 0.55) ** 2 <= 60 ** 2; // 純白，在衣服裡面
  const inHole = (x, y) => (x - (w / 2 + 110)) ** 2 + (y - (h * 0.55 - 40)) ** 2 <= 40 ** 2; // 被圍住的棋盤格洞
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v;
      const checker = (Math.floor(x / tile) + Math.floor(y / tile)) % 2 === 0 ? 254 : 229;
      if (inShape(x, y)) {
        if (inHole(x, y)) v = [checker, checker, checker];
        else if (inRose(x, y)) v = [255, 255, 255];
        else v = [150 + (x % 7), 20, 40];
      } else {
        v = bg === "checker" ? [checker, checker, checker] : [250, 250, 250];
      }
      const n = Math.round(rnd() * 1.5);
      data[i] = v[0] + n; data[i + 1] = v[1] + n; data[i + 2] = v[2] + n; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h, inShape, inRose, inHole };
}

console.log("\n① 合成棋盤格");
{
  const img = synth();
  const r = autoCutout(img);
  check("偵測為棋盤格並已處理", r.kind === "checkerboard" && r.applied, r);
  const a = (x, y) => img.data[(y * img.width + x) * 4 + 3];
  let bgWrong = 0, fgWrong = 0, roseWrong = 0, holeCleared = 0, holeN = 0, nbg = 0, nfg = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const inside = img.inShape(x, y);
      if (!inside) {
        nbg++;
        // 離衣服邊緣 3px 以外的背景一定要透明
        const near = [[-3, 0], [3, 0], [0, -3], [0, 3]].some(([dx, dy]) => img.inShape(x + dx, y + dy));
        if (!near && a(x, y) !== 0) bgWrong++;
      } else if (img.inHole(x, y)) {
        holeN++;
        const deep = [[-3, 0], [3, 0], [0, -3], [0, 3]].every(([dx, dy]) => img.inHole(x + dx, y + dy));
        if (deep && a(x, y) === 0) holeCleared++;
      } else if (img.inRose(x, y)) {
        const deep = [[-4, 0], [4, 0], [0, -4], [0, 4]].every(([dx, dy]) => img.inRose(x + dx, y + dy));
        if (deep && a(x, y) !== 255) roseWrong++;
      } else {
        nfg++;
        // 離衣服外緣及洞邊緣 4px 以外的衣服，必須保持完全不透明
        const deep = [[-4, 0], [4, 0], [0, -4], [0, 4]].every(([dx, dy]) => img.inShape(x + dx, y + dy) && !img.inHole(x + dx, y + dy));
        if (deep && a(x, y) !== 255) fgWrong++;
      }
    }
  }
  check("背景（衣服 3px 以外）全部變透明", bgWrong === 0, { bgWrong, nbg });
  check("衣服本體沒有被誤刪", fgWrong === 0, { fgWrong, nfg });
  check("衣服裡面純白玫瑰沒有被誤刪", roseWrong === 0, { roseWrong });
  check("被圍住的棋盤格洞已清除", holeCleared > holeN * 0.5, { holeCleared, holeN });
}

console.log("\n② 純色背景");
{
  const img = synth({ bg: "solid" });
  const r = autoCutout(img);
  check("偵測為純色背景並已處理", r.kind === "solid" && r.applied, r);
  check("角落變透明、衣服中心不透明", img.data[3] === 0 && img.data[((img.height * 0.55 | 0) * img.width + (img.width / 2 | 0) + 100) * 4 + 3] === 255);
}

console.log("\n③ 不應處理的圖片");
{
  const already = synth();
  for (let i = 0; i < already.data.length; i += 4) if ((i / 4) % already.width < 40) already.data[i + 3] = 0;
  check("已有真透明 → 不處理", autoCutout(already).kind === "transparent");

  const w = 400, h = 500;
  const photo = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    photo.data[i] = (x * 255) / w; photo.data[i + 1] = (y * 255) / h; photo.data[i + 2] = ((x + y) * 255) / (w + h); photo.data[i + 3] = 255;
  }
  const r = autoCutout(photo);
  check("複雜漸層背景 → 不處理並說明原因", !r.applied && r.kind === "unknown" && !!r.reason, r);

  const white = { data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h };
  check("整張純白 → 放棄（不會把整張圖刪光）", !autoCutout(white).applied);
}

if (process.argv[2]) {
  console.log("\n④ 實際圖片", process.argv[2]);
  const img = await load(process.argv[2]);
  const t0 = performance.now();
  const r = autoCutout(img);
  console.log("   ", JSON.stringify(r), `${Math.round(performance.now() - t0)} ms`, `${img.width}×${img.height}`);
  check("實際圖片偵測為棋盤格並已去背", r.kind === "checkerboard" && r.applied, r);
  const png = await sharp(Buffer.from(img.data.buffer), { raw: { width: img.width, height: img.height, channels: 4 } }).png().toBuffer();
  writeFileSync(OUT + "cutout.png", png);
  for (const [name, bg] of [["pink", { r: 255, g: 192, b: 214 }], ["dark", { r: 40, g: 20, b: 60 }]]) {
    await sharp(png).flatten({ background: bg }).png().toFile(OUT + `cutout-on-${name}.png`);
  }
  console.log("    已輸出到", OUT);
}

console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) {
  console.log("失敗項目：\n - " + failures.join("\n - "));
  process.exit(1);
}
