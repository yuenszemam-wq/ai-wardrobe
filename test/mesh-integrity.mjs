// 衣物完整性測試：把純色的測試衣物穿在角色身上，逐個姿勢實際畫出來，
// （左右分開的襪、鞋在雙腿交叉時會互相遮住，所以面積下限較寬。）
// 然後數畫面上「衣物顏色」連成多少塊、面積有沒有大幅減少。
// 目的：不是「畫面有變化」就算成功，而是確認衣物沒有斷成碎片、沒有大面積消失、沒有漂浮的布料。
// 執行：node test/mesh-integrity.mjs   （需要 esbuild、sharp、playwright）
import { join } from "node:path";
import { OUT, addSvg, close, presets, sharp, shot } from "./mesh-lab.mjs";

let passed = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); }
}
const G = "#00c850";
// [名稱, 圖層, 分類, SVG, 預期連成多少塊]
const CASES = [
  ["g_blouse", "top", "上衣", `<path d="M330 200 L570 200 L600 760 L300 760 Z" fill="${G}"/><path d="M300 210 L190 800 L90 780 L215 210 Z M600 210 L710 800 L810 780 L685 210 Z" fill="${G}"/><path d="M215 200 L685 200 L685 260 L215 260 Z" fill="${G}"/>`, 1],
  ["g_puff", "top", "上衣", `<path d="M300 220 L600 220 L620 700 L680 860 L220 860 L280 700 Z" fill="${G}"/><path d="M300 300 L80 300 Q30 420 90 520 L300 520 Z M600 300 L820 300 Q870 420 810 520 L600 520 Z" fill="${G}"/>`, 1],
  ["g_op", "dress", "連身裙", `<path d="M330 140 L570 140 L600 560 L780 1060 L120 1060 L300 560 Z" fill="${G}"/><path d="M335 150 L150 190 L120 400 L300 420 Z M565 150 L750 190 L780 400 L600 420 Z" fill="${G}"/>`, 1],
  ["g_jsk", "dress", "連身裙", `<path d="M330 150 L390 150 L400 330 L500 330 L510 150 L570 150 L590 520 L760 1050 L140 1050 L310 520 Z" fill="${G}"/>`, 1],
  ["g_pants", "pants", "褲", `<path d="M300 200 L600 200 L640 1100 L480 1100 L450 520 L420 1100 L260 1100 Z" fill="${G}"/>`, 1],
  ["g_socks", "socks", "襪", `<rect x="290" y="250" width="110" height="700" fill="${G}"/><rect x="500" y="250" width="110" height="700" fill="${G}"/>`, 2],
  ["g_shoes", "shoes", "鞋", `<rect x="250" y="520" width="170" height="160" rx="40" fill="${G}"/><rect x="480" y="520" width="170" height="160" rx="40" fill="${G}"/>`, 2],
];
/** 數出衣物顏色連成多少塊（忽略很小的雜點），以及總面積 */
async function measure(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info, on = new Uint8Array(w * h);
  let area = 0;
  for (let i = 0; i < w * h; i++) { const r = data[i * c], g = data[i * c + 1], b = data[i * c + 2]; if (g > 140 && r < 110 && b < 150 && g - r > 70) { on[i] = 1; area++; } }
  const sizes = [];
  for (let k0 = 0; k0 < w * h; k0++) {
    if (on[k0] !== 1) continue;
    let n = 0;
    const stack = [k0];
    on[k0] = 2;
    while (stack.length) {
      const k = stack.pop(), x = k % w, y = (k - x) / w;
      n++;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const q = ny * w + nx; if (on[q] === 1) { on[q] = 2; stack.push(q); } }
    }
    sizes.push(n);
  }
  return { area, pieces: sizes.filter((n) => n > area * 0.004 && n > 25).length, stray: sizes.filter((n) => n <= area * 0.004 || n <= 25).reduce((a, b) => a + b, 0) };
}

try {
  for (const [name, , , svg] of CASES) await addSvg(name, svg);
  for (const [name, slot, category, , expected] of CASES) {
    console.log(name);
    let rest = null;
    const bad = [];
    for (const [pose, label] of presets) {
      await shot(`integrity-${name}-${pose}`, { garments: [{ name, slot, category }], poses: [pose], noHair: true });
      const m = await measure(join(OUT, `integrity-${name}-${pose}.png`));
      if (!rest) rest = m;
      if (m.pieces < 1 || m.pieces > expected || m.area < rest.area * (expected > 1 ? 0.5 : 0.72) || m.area > rest.area * 1.45 || m.stray > rest.area * 0.02) bad.push([label, m]);
    }
    check(`靜止時連成 ${expected} 塊`, rest.pieces === expected, rest);
    check(`全部 ${presets.length} 個姿勢：沒有斷成更多塊、沒有大面積消失、沒有漂浮布料`, bad.length === 0, bad);
  }
} finally {
  await close();
}
console.log(`\n${passed} 項通過，${failures.length} 項失敗`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
