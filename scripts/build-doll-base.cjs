// 開發工具：把素體原圖（各自獨立畫布）清理雜點、對位並輸出成同一個 1200×1800 畫布的圖層。
// 用法：node scripts/build-doll-base.cjs <head.png> <hair_back.png> <body.png> [輸出資料夾] [預覽.png]
// 只在開發環境執行（需要 sharp）；不會讀寫 R2 或 D1。
const sharp = require(process.env.SHARP_PATH || "sharp");
const path = require("node:path");
const W = 1200, H = 1800;
// 每層：scale＝原圖放大倍數；x／y＝原圖左上角在 1200×1800 畫布的位置
const LAYOUT = JSON.parse(process.env.DOLL_LAYOUT || "null") || {
  body: { scale: 1.06, x: 57, y: 172 },
  head: { scale: 0.6, x: 293, y: 68 },
  hair_back: { scale: 0.74, x: 222, y: 108 },
};

async function clean(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, n = w * h;
  // 1) 只保留最大的一塊（alpha ≥ 40 視為實心），其餘零碎雜點清除
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || data[s * 4 + 3] < 40) continue;
    let top = 0, size = 0;
    const id = sizes.length;
    stack[top++] = s; label[s] = id;
    while (top) {
      const p = stack[--top]; size++;
      const x = p % w, y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && label[q] === -1 && data[q * 4 + 3] >= 40) { label[q] = id; stack[top++] = q; }
      }
    }
    sizes.push(size);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  let removed = 0, fringe = 0;
  const near = (p) => { const x = p % w, y = (p - x) / w; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && label[yy * w + xx] === main) return true; } return false; };
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (!data[i + 3]) continue;
    if (label[p] !== main && !(label[p] === -1 && near(p))) { data[i + 3] = 0; removed++; continue; }
    // 2) 去背殘留的純紅／純黃邊緣雜色
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if ((r > 190 && g < 90 && b < 90) || (r > 215 && g > 190 && b < 90)) { data[i + 3] = 0; fringe++; }
  }
  return { buf: await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), w, h, removed, fringe, parts: sizes.length };
}

async function place(c, L) {
  const sw = Math.round(c.w * L.scale), sh = Math.round(c.h * L.scale);
  const scaled = await sharp(c.buf).resize(sw, sh, { kernel: "lanczos3" }).png().toBuffer();
  // 超出畫布的部分裁走
  const left = Math.max(0, -L.x), top = Math.max(0, -L.y);
  const cw = Math.min(sw - left, W - Math.max(0, L.x)), ch = Math.min(sh - top, H - Math.max(0, L.y));
  const part = await sharp(scaled).extract({ left, top, width: cw, height: ch }).toBuffer();
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: part, left: Math.max(0, L.x), top: Math.max(0, L.y) }]).png({ compressionLevel: 9 }).toBuffer();
}

(async () => {
  const [head, hairBack, body, outDir = "public/doll/base_v1", preview] = process.argv.slice(2);
  const src = { hair_back: hairBack, body, head };
  const out = {};
  for (const k of ["hair_back", "body", "head"]) {
    const c = await clean(src[k]);
    out[k] = await place(c, LAYOUT[k]);
    await sharp(out[k]).toFile(path.join(outDir, `${k}.png`));
    console.log(k, `來源 ${c.w}×${c.h}`, `獨立區塊 ${c.parts}`, `清除雜點 ${c.removed}px`, `清除紅黃邊 ${c.fringe}px`, `輸出 ${out[k].length} bytes`);
  }
  if (preview) {
    await sharp({ create: { width: W, height: H, channels: 4, background: "#d9cfe0" } })
      .composite(["hair_back", "body", "head"].map((k) => ({ input: out[k] }))).png().toFile(preview);
  }
})();
