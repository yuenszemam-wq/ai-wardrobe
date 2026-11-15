// Cutout Studio 遮罩引擎測試：node test/cutout-studio.mjs（Node 22.18+ 直接載入 .ts）
import { createHash } from "node:crypto";
import {
  BrushStroke, MaskHistory, alphaStats, applySelection, composite, defringeMask, diffRect, featherMask,
  invertSelection, magicWand, maskFromProcessed, morphMask, polygonSelection, rectSelection, rleDecode, rleEncode,
  smoothMask, solidMask, downscaleSize, STUDIO_SAFE_PIXELS,
} from "../src/cutoutStudio/maskEngine.ts";
import { autoCutout } from "../src/cutout.ts";

let passed = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info) : ""); }
}
const sha = (d) => createHash("sha256").update(d).digest("hex");

/** 合成：白底、中間一件黑色「裙子」（含白色蝴蝶結，與背景同色但不相連），左上角半透明薄紗 */
function makeImage(w = 200, h = 300, alphaCorner = false) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let c = [255, 255, 255, 255];
    if (x >= 50 && x < 150 && y >= 60 && y < 260) c = [20, 20, 25, 255];
    if (x >= 90 && x < 110 && y >= 100 && y < 120) c = [255, 255, 255, 255]; // 白色蝴蝶結
    if (alphaCorner && x < 20 && y < 20) c = [200, 100, 150, 100]; // 原圖本身半透明
    data.set(c, i);
  }
  return { data, width: w, height: h };
}

console.log("筆刷");
{
  const w = 100, h = 100;
  const m = solidMask(w, h);
  const s = new BrushStroke(m, w, h, { radius: 5, hardness: 1, opacity: 1, mode: "erase" });
  s.to(10, 50); s.to(90, 50); // 一次拖動很遠
  let gaps = 0;
  for (let x = 12; x < 88; x++) if (m[50 * w + x] !== 0) gaps++;
  check("快速拖動不出現斷點（插值連續）", gaps === 0, { gaps });
  check("筆刷範圍外不受影響", m[10 * w + 50] === 255);
  check("dirty 範圍覆蓋筆畫", s.dirty.x0 <= 5 && s.dirty.x1 >= 95);

  const m2 = solidMask(w, h);
  const s2 = new BrushStroke(m2, w, h, { radius: 6, hardness: 1, opacity: 0.5, mode: "erase" });
  for (let k = 0; k < 10; k++) { s2.to(50, 50); s2.to(52, 50); s2.to(50, 50); }
  check("同一筆重複經過不累積（50% 透明度保持約 50%）", Math.abs(m2[50 * w + 50] - 128) <= 2, m2[50 * w + 50]);

  const m3 = solidMask(w, h);
  const s3 = new BrushStroke(m3, w, h, { radius: 10, hardness: 0, opacity: 1, mode: "erase" });
  s3.to(50, 50);
  check("硬度 0 時邊緣柔化（產生半透明）", m3[50 * w + 57] > 0 && m3[50 * w + 57] < 255, m3[50 * w + 57]);

  const r = new BrushStroke(m, w, h, { radius: 5, hardness: 1, opacity: 1, mode: "restore" });
  r.to(10, 50); r.to(90, 50);
  check("還原筆刷恢復遮罩", m[50 * w + 50] === 255);
}

console.log("魔術棒");
{
  const img = makeImage();
  const contig = magicWand(img, 2, 2, 20, true);
  const glob = magicWand(img, 2, 2, 20, false);
  const bow = (100 * 0 + 110) * img.width + 100; // (100,110) 在蝴蝶結內
  check("相連選取：選中背景", contig[0] === 255 && contig[299 * 200 + 199] === 255);
  check("相連選取：不選中衣服內同色蝴蝶結", contig[bow] === 0);
  check("全圖相近顏色：選中蝴蝶結", glob[bow] === 255);
  check("不選中黑色衣服", contig[150 * 200 + 60] === 0);
  const low = magicWand(img, 60, 150, 0, true);
  check("容差 0 只選完全相同顏色", low[150 * 200 + 60] === 255 && low[0] === 0);
}

console.log("套索／多邊形／矩形");
{
  const w = 100, h = 100;
  const tri = polygonSelection(w, h, [10, 10, 90, 10, 50, 90]);
  check("多邊形內部選中", tri[30 * w + 50] === 255);
  check("多邊形外部不選", tri[80 * w + 10] === 0);
  let semi = 0; for (const v of tri) if (v > 0 && v < 255) semi++;
  check("多邊形邊緣抗鋸齒", semi > 0);
  const rect = rectSelection(w, h, 20, 20, 40, 60);
  let n = 0; for (const v of rect) if (v === 255) n++;
  check("矩形選取面積正確", n === 20 * 40, n);
  const inv = invertSelection(rect);
  check("反轉選取", inv[0] === 255 && inv[30 * w + 30] === 0);
  check("少於 3 點不選取", polygonSelection(w, h, [1, 1, 5, 5]).every((v) => v === 0));
}

console.log("套用選取");
{
  const w = 10, h = 10;
  const sel = rectSelection(w, h, 2, 2, 5, 5);
  const keep = solidMask(w, h); applySelection(keep, sel, "keep");
  check("保留：範圍外移除、範圍內保留", keep[0] === 0 && keep[3 * w + 3] === 255);
  const rem = solidMask(w, h); applySelection(rem, sel, "remove");
  check("移除：範圍內移除", rem[3 * w + 3] === 0 && rem[0] === 255);
  const res = new Uint8Array(w * h); applySelection(res, sel, "restore");
  check("還原：範圍內恢復", res[3 * w + 3] === 255 && res[0] === 0);
}

console.log("合成（非破壞性）");
{
  const img = makeImage(200, 300, true);
  const before = sha(img.data);
  const mask = solidMask(200, 300);
  const sel = magicWand(img, 199, 299, 20, true);
  applySelection(mask, sel, "remove");
  const out = new Uint8ClampedArray(img.data.length);
  composite(img, mask, out);
  check("原圖 SHA-256 不變", sha(img.data) === before);
  check("輸出背景透明", out[(299 * 200 + 199) * 4 + 3] === 0);
  check("輸出衣服不透明", out[(150 * 200 + 60) * 4 + 3] === 255);
  check("RGB 與原圖相同（不改顏色）", out[(150 * 200 + 60) * 4] === img.data[(150 * 200 + 60) * 4]);
  // 原圖本身半透明（alpha 100）：遮罩 255 時輸出仍然是 100，不會因還原變成不透明
  const full = solidMask(200, 300);
  composite(img, full, out);
  check("原圖半透明部分保持原 alpha", out[(5 * 200 + 5) * 4 + 3] === 100, out[(5 * 200 + 5) * 4 + 3]);
  const st = alphaStats(out);
  check("alphaStats 計算半透明", st.semi === 400, st);
  // 背景預覽不寫入：composite 不接受背景參數，輸出 RGB 只來自原圖
  check("背景預覽不寫入輸出（透明像素 RGB 來自原圖）", out[(299 * 200 + 199) * 4] === 255);
}

console.log("由既有去背圖重新編輯");
{
  const img = makeImage(200, 300, true);
  const processed = { data: new Uint8ClampedArray(img.data), width: 200, height: 300 };
  // 模擬之前錯誤刪除了衣服一部分
  for (let y = 100; y < 110; y++) for (let x = 60; x < 70; x++) processed.data[(y * 200 + x) * 4 + 3] = 0;
  processed.data[(5 * 200 + 5) * 4 + 3] = 50; // 原圖 alpha 100 → processed 50 → 遮罩約 128
  const m = maskFromProcessed(img, processed);
  check("被刪區域遮罩為 0", m[105 * 200 + 65] === 0);
  check("半透明原圖：遮罩＝processed÷原圖 alpha", Math.abs(m[5 * 200 + 5] - 128) <= 1, m[5 * 200 + 5]);
  const s = new BrushStroke(m, 200, 300, { radius: 20, hardness: 1, opacity: 1, mode: "restore" });
  s.to(65, 105);
  const out = new Uint8ClampedArray(img.data.length);
  composite(img, m, out);
  check("還原筆刷從原圖還原誤刪部分", out[(105 * 200 + 65) * 4 + 3] === 255);
}

console.log("自動去背轉換成可編輯遮罩");
{
  const img = makeImage();
  const copy = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  const r = autoCutout(copy);
  check("自動去背成功", r.applied, r);
  const m = maskFromProcessed(img, copy);
  check("自動去背遮罩：背景 0、衣服 255", m[0] === 0 && m[150 * 200 + 60] === 255);
  check("自動去背遮罩：白色蝴蝶結保留", m[110 * 200 + 100] === 255);
}

console.log("邊緣修正");
{
  const w = 60, h = 60;
  const m = new Uint8Array(w * h);
  for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) m[y * w + x] = 255;
  m[30 * w + 30] = 120; // 內部薄紗（半透明）
  const ex = morphMask(m, w, h, 3);
  check("擴張", ex[30 * w + 17] === 255 && ex[30 * w + 16] === 0);
  const ct = morphMask(m, w, h, -3);
  check("收縮", ct[30 * w + 22] === 0 && ct[30 * w + 23] === 255 || ct[30 * w + 23] === 120 || ct[30 * w + 23] === 255);
  const fe = featherMask(m, w, h, 3);
  check("柔化產生半透明邊", fe[30 * w + 20] > 0 && fe[30 * w + 20] < 255, fe[30 * w + 20]);
  check("柔化不抹平遠離邊緣的內部薄紗", fe[30 * w + 30] === 120, fe[30 * w + 30]);
  const sm = smoothMask(m, w, h, 2);
  check("平滑後內部仍保留", sm[25 * w + 25] === 255);

  const img = makeImage(100, 100);
  // 灰白邊：衣服旁邊一圈淺灰
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const i = (y * 100 + x) * 4;
    if (x >= 30 && x < 70 && y >= 30 && y < 70) img.data.set([20, 20, 25, 255], i);
    else if (x >= 28 && x < 72 && y >= 28 && y < 72) img.data.set([230, 230, 230, 255], i);
    else img.data.set([255, 255, 255, 255], i);
  }
  const mm = new Uint8Array(100 * 100);
  for (let y = 28; y < 72; y++) for (let x = 28; x < 72; x++) mm[y * 100 + x] = 255;
  const before = sha(img.data);
  const df = defringeMask(img, mm, 3, "white");
  check("白邊清理降低灰白邊遮罩", df[50 * 100 + 28] < 128, df[50 * 100 + 28]);
  check("白邊清理不影響深色衣服", df[50 * 100 + 31] === 255);
  check("白邊清理不改原圖", sha(img.data) === before);
  const dc = defringeMask(img, mm, 3, "color");
  check("色邊清理（取透明區顏色）降低邊緣", dc[50 * 100 + 28] < 255);
}

console.log("歷史");
{
  const w = 200, h = 200;
  const m = solidMask(w, h);
  const hist = new MaskHistory(w, 25);
  for (let k = 0; k < 30; k++) {
    const before = m.slice();
    const s = new BrushStroke(m, w, h, { radius: 4, hardness: 1, opacity: 1, mode: "erase" });
    s.to(5 + k * 6, 20); s.to(5 + k * 6, 180);
    hist.record("擦除", s.dirty, before, m);
  }
  check("步數上限 25", hist.size === 25, hist.size);
  check("歷史以壓縮區塊保存（< 200 KB）", hist.bytes() < 200_000, hist.bytes());
  const snapshot = m.slice();
  for (let k = 0; k < 25; k++) hist.undo(m);
  check("Undo 25 步後前 5 筆仍在（被丟棄的步驟不損壞遮罩）", m[100 * w + 5] === 0 && m[100 * w + 5 + 6 * 10] === 255);
  for (let k = 0; k < 25; k++) hist.redo(m);
  check("Redo 全部後回到原狀", sha(m) === sha(snapshot));
  const small = new MaskHistory(w, 100, 1000);
  for (let k = 0; k < 10; k++) { const b = m.slice(); for (let i = 0; i < m.length; i += 7) m[i] = (m[i] + 37 * k) & 255; small.record("x", { x0: 0, y0: 0, x1: w, y1: h }, b, m); }
  check("記憶體預算限制歷史大小", small.size < 10 && small.size >= 1, small.size);
  const a = new Uint8Array(1000).fill(255); a.fill(0, 100, 300); a[999] = 7;
  check("RLE 壓縮可還原", sha(rleDecode(rleEncode(a), 1000)) === sha(a));
  const d = diffRect(solidMask(10, 10), (() => { const x = solidMask(10, 10); x[33] = 0; return x; })(), 10, 10);
  check("diffRect 找到改動範圍", d.x0 === 3 && d.y0 === 3 && d.x1 === 4 && d.y1 === 4, d);
}

console.log("尺寸");
{
  check("2000×3000 不需降解析度", downscaleSize(2000, 3000).scale === 1);
  const big = downscaleSize(4000, 6000);
  check("超過安全尺寸提供降解析度尺寸", big.scale < 1 && big.w * big.h <= STUDIO_SAFE_PIXELS, big);
}

console.log("效能（2000×3000）");
{
  const w = 2000, h = 3000;
  const img = makeImage(w, h);
  let t = performance.now();
  const sel = magicWand(img, 1, 1, 20, true);
  const tWand = performance.now() - t;
  const m = solidMask(w, h);
  t = performance.now(); applySelection(m, sel, "remove"); const tApply = performance.now() - t;
  t = performance.now(); featherMask(m, w, h, 4); const tFeather = performance.now() - t;
  t = performance.now(); const out = new Uint8ClampedArray(w * h * 4); composite(img, m, out); const tComp = performance.now() - t;
  console.log(`    魔術棒 ${tWand.toFixed(0)} ms、套用 ${tApply.toFixed(0)} ms、柔化 ${tFeather.toFixed(0)} ms、合成 ${tComp.toFixed(0)} ms（Node，非手機）`);
  check("2000×3000 魔術棒＋柔化在 Node 3 秒內完成", tWand + tFeather < 3000);
}

console.log(`\n${passed} 項通過，${failures.length} 項失敗`);
if (failures.length) process.exit(1);
