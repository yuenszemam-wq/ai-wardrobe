// 角色換裝：純邏輯測試（圖層、互斥、預設穿著位置、位置驗證、透明邊界框）
// 執行：node test/doll-logic.mjs   （需要 esbuild）
import { buildModule } from "./doll-build.mjs";
const d = await buildModule("shared/doll.ts", "doll-shared");
const c = await buildModule("src/doll/content.ts", "doll-content");

let passed = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); }
}
const ids = (a) => a.map((w) => w.garment_id).join(",");
const W = (garment_id, slot, subcategory = null) => ({ garment_id, slot, subcategory });

console.log("Avatar V2 positioning");
check("V2腰線與V1獨立", d.BASE_V2.anchors.waist.y === 690 && d.BASE_V1.anchors.waist.y === 745);
const full = d.FULL_CONTENT(1.4);
const sk2 = d.defaultFit("skirt", full, "半身裙", d.BASE_V2);
check("V2半裙對齊腰線", Math.abs(sk2.cy - sk2.w * full.ar / 2 - 680) < 0.2);
check("V2長裙比短裙長", d.defaultFit("skirt", full, "半身裙", d.BASE_V2, "長裙").w > d.defaultFit("skirt", full, "半身裙", d.BASE_V2, "短裙").w);
console.log("分類 → 圖層位置");
check("連身裙→dress", d.slotFor("連身裙", "JSK") === "dress");
check("上衣→top", d.slotFor("上衣", "Blouse") === "top");
check("半身裙→skirt", d.slotFor("半身裙", "SK") === "skirt");
check("裙撐→petticoat", d.slotFor("內搭與裙撐", "裙撐") === "petticoat");
check("內搭（非裙撐）→top", d.slotFor("內搭與裙撐", "打底衫") === "top");
check("頭飾／襪／鞋", d.slotFor("頭飾", "髮箍") === "headwear" && d.slotFor("襪", null) === "socks" && d.slotFor("鞋", null) === "shoes");
check("套裝及完整穿搭→set", d.slotFor("套裝", "多件套") === "set" && d.slotFor("完整穿搭", "Coordinate") === "set");
check("未知分類→accessory", d.slotFor(null) === "accessory" && d.slotFor("不存在") === "accessory");
check("每個位置都有圖層次序、名稱及上限", d.SLOTS.every((s) => Number.isFinite(d.SLOT_Z[s]) && d.SLOT_LABEL[s] && d.SLOT_LIMIT[s] >= 1));

console.log("圖層次序");
const z = d.SLOT_Z;
check("襪 < 鞋 < 裙撐 < 襯衫 < SK < JSK／OP < 外套", z.socks < z.shoes && z.shoes < z.petticoat && z.petticoat < z.top && z.top < z.skirt && z.skirt < z.dress && z.dress < z.outer);
check("頭（臉＋前髮）在全部衣物之上、頭飾之下", d.SLOTS.filter((s) => s !== "headwear").every((s) => z[s] < d.HEAD_Z) && z.headwear > d.HEAD_Z);
const order = d.drawOrder([W("jsk", "dress", "JSK"), W("kc", "headwear"), W("bl", "top"), W("pet", "petticoat"), W("shoe", "shoes"), W("sock", "socks")]);
check("繪畫次序穩定：襪→鞋→裙撐→襯衫→JSK→頭飾", ids(order) === "sock,shoe,pet,bl,jsk,kc", ids(order));
const acc = d.drawOrder([W("a1", "accessory"), W("a2", "accessory"), W("a3", "accessory")]);
check("同層按穿上的先後", ids(acc) === "a1,a2,a3");
const input = [W("b", "dress"), W("a", "top")];
d.drawOrder(input);
check("drawOrder 不改動原陣列", ids(input) === "b,a");

console.log("互斥");
let cur = d.wear([], W("bl", "top", "Blouse"));
cur = d.wear(cur, W("jsk", "dress", "JSK"));
check("JSK 可配襯衫", ids(cur) === "bl,jsk", ids(cur));
cur = d.wear(cur, W("pet", "petticoat", "裙撐"));
check("JSK＋襯衫＋裙撐並存", cur.length === 3);
cur = d.wear(cur, W("op", "dress", "OP"));
check("穿 OP：脫下 JSK 及襯衫，保留裙撐", ids(cur) === "pet,op", ids(cur));
cur = d.wear(cur, W("bl", "top", "Blouse"));
check("穿襯衫：脫下 OP", ids(cur) === "pet,bl", ids(cur));
cur = d.wear(cur, W("sk", "skirt", "SK"));
check("襯衫＋SK 並存", ids(cur) === "pet,bl,sk", ids(cur));
cur = d.wear(cur, W("jsk", "dress", "JSK"));
check("穿 JSK：脫下 SK，保留襯衫", ids(cur) === "pet,bl,jsk", ids(cur));
cur = d.wear(cur, W("sk", "skirt", "SK"));
check("穿 SK：脫下連身裙", ids(cur) === "pet,bl,sk", ids(cur));
cur = d.wear(cur, W("set", "set", "多件套"));
check("穿整套：脫下上衣及半身裙", ids(cur) === "pet,set", ids(cur));
cur = d.wear(cur, W("jsk2", "dress", "JSK"));
check("穿連身裙：脫下整套", ids(cur) === "pet,jsk2", ids(cur));
cur = d.wear(cur, W("pants", "pants"));
check("穿褲：脫下連身裙", ids(cur) === "pet,pants", ids(cur));
cur = d.wear(cur, W("sk", "skirt"));
check("裙與褲互斥", ids(cur) === "pet,sk", ids(cur));
cur = d.wear(cur, W("pet2", "petticoat"));
check("裙撐只穿一件（換上新的）", ids(cur) === "sk,pet2", ids(cur));
check("重複穿同一件不變", d.wear(cur, W("sk", "skirt")) === cur);
let hw = [];
for (const i of [1, 2, 3]) hw = d.wear(hw, W("h" + i, "headwear"));
check("頭飾最多兩件，脫下最早的", ids(hw) === "h2,h3", ids(hw));
let shoes = d.wear(d.wear([], W("s1", "shoes")), W("s2", "shoes"));
check("鞋只穿一對", ids(shoes) === "s2");
check("襪與鞋、外套不互相影響", d.conflicts([W("s", "socks"), W("sh", "shoes"), W("o", "outer")], W("jsk", "dress", "JSK")).length === 0);

console.log("預設穿著位置");
const A = d.BASE_V1.anchors;
// 圖片 900×1200，衣物佔 x 20–80%、y 10–90%
const content = { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9, ar: 1200 / 900 };
const box = (fit, ct) => {
  const h = fit.w * ct.ar, left = fit.cx - fit.w / 2, top = fit.cy - h / 2;
  return { l: left + ct.x0 * fit.w, r: left + ct.x1 * fit.w, t: top + ct.y0 * h, b: top + ct.y1 * h };
};
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
let f = d.defaultFit("dress", content);
let b = box(f, content);
check("連身裙：內容頂部在肩線附近", b.t > A.shoulder_l.y - 60 && b.t < A.shoulder_l.y, b);
check("連身裙：下襬在膝蓋附近", near(b.b, A.knee_l.y, 60), b);
check("連身裙：水平置中", near((b.l + b.r) / 2, 600), b);
f = d.defaultFit("skirt", content); b = box(f, content);
check("半身裙：由腰線開始", near(b.t, A.waist.y, 20), b);
f = d.defaultFit("top", content); b = box(f, content);
check("上衣：由肩線到臀線之間", b.t < A.shoulder_l.y && b.b > A.waist.y && b.b < A.hip.y + 40, b);
f = d.defaultFit("shoes", content); b = box(f, content);
check("鞋：貼近地面", near(b.b, A.floor.y, 10), b);
f = d.defaultFit("socks", content); b = box(f, content);
check("襪：在膝蓋與地面之間", b.t > A.knee_l.y - 40 && b.b < A.floor.y, b);
f = d.defaultFit("headwear", content); b = box(f, content);
check("頭飾：在頭頂、寬度合理", near((b.t + b.b) / 2, A.head_top.y + 40, 3) && near(b.r - b.l, 340, 3), b);
f = d.defaultFit("petticoat", content); b = box(f, content);
check("裙撐：比 SK 稍低稍短", b.t > A.waist.y && b.b < box(d.defaultFit("skirt", content), content).b, b);
f = d.defaultFit("set", content, "完整穿搭"); b = box(f, content);
check("完整穿搭：由頭到腳", b.t < A.head_top.y && near(b.b, A.floor.y, 3), b);
// 同一件衣服留白不同，內容位置應一樣
const tight = { x0: 0, y0: 0, x1: 1, y1: 1, ar: 960 / 540 };
const loose = { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9, ar: 1200 / 900 };
const b1 = box(d.defaultFit("dress", tight), tight), b2 = box(d.defaultFit("dress", loose), loose);
check("留白多少不影響衣物實際位置及大小", near(b1.t, b2.t) && near(b1.b, b2.b) && near(b1.l, b2.l) && near(b1.r, b2.r), { b1, b2 });
check("預設位置全部通過驗證", d.SLOTS.every((s) => d.normalizeFit(d.defaultFit(s, content)) !== null));
check("極端內容（幾乎空白）不會產生無效數值", d.normalizeFit(d.defaultFit("dress", { x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5, ar: 0 })) !== null);

console.log("位置驗證及優先次序");
check("合法位置", JSON.stringify(d.normalizeFit({ cx: 600.04, cy: 900, w: 500, rotation: 370 })) === JSON.stringify({ cx: 600, cy: 900, w: 500, rotation: 10 }));
check("rotation 可省略", d.normalizeFit({ cx: 1, cy: 2, w: 100 })?.rotation === 0);
check("負角度規範化到 -180～180", d.normalizeFit({ cx: 1, cy: 2, w: 100, rotation: -190 })?.rotation === 170);
check("拒絕 NaN／字串／缺欄位", [{ cx: NaN, cy: 1, w: 100 }, { cx: "1", cy: 1, w: 100 }, { cx: 1, cy: 1 }, null, "x", { cx: 1, cy: 1, w: Infinity }].every((v) => d.normalizeFit(v) === null));
check("拒絕過大／過小／離畫布太遠", [{ cx: 1, cy: 1, w: 5 }, { cx: 1, cy: 1, w: 99999 }, { cx: 99999, cy: 1, w: 100 }, { cx: 1, cy: -5000, w: 100 }].every((v) => d.normalizeFit(v) === null));
const T = { cx: 1, cy: 1, w: 100, rotation: 0 }, O = { cx: 2, cy: 2, w: 200, rotation: 5 }, D = { cx: 3, cy: 3, w: 300, rotation: 0 };
check("個別修改優先", d.resolveFit(O, T, D).from === "override" && d.resolveFit(O, T, D).fit === O);
check("其次模板", d.resolveFit(null, T, D).from === "template");
check("最後分類預設", d.resolveFit(null, undefined, D).from === "default" && d.resolveFit(null, null, D).fit === D);
check("sameFit", d.sameFit(T, { ...T }) && !d.sameFit(T, { ...T, rotation: 1 }));

console.log("點選（只計實際內容）");
{
  const fit = { cx: 600, cy: 900, w: 600, rotation: 0 };          // 圖片 600×800，內容 → 畫布 x 450–750、y 700–1100
  const ct = { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75, ar: 800 / 600 };
  check("內容範圍內命中", d.hitTest(fit, ct, 600, 900) && d.hitTest(fit, ct, 460, 710));
  check("透明留白不命中", !d.hitTest(fit, ct, 330, 900) && !d.hitTest(fit, ct, 600, 560));
  check("圖片範圍外不命中", !d.hitTest(fit, ct, 100, 100));
  const r90 = { ...fit, rotation: 90 };                             // 旋轉 90° 後內容變成 x 400–800、y 750–1050
  check("旋轉後按旋轉後的範圍判斷", d.hitTest(r90, ct, 780, 900) && !d.hitTest(r90, ct, 600, 1090) && d.hitTest(fit, ct, 600, 1090));
}

console.log("透明邊界框");
const w = 20, h = 30, px = new Uint8Array(w * h * 4);
for (let y = 6; y < 24; y++) for (let x = 5; x < 15; x++) px[(y * w + x) * 4 + 3] = 255;
px[3] = 10; // 低於門檻的雜點不算
const ct = c.contentFromPixels(px, w, h);
check("邊界框正確", ct.x0 === 0.25 && ct.x1 === 0.75 && ct.y0 === 0.2 && ct.y1 === 0.8 && near(ct.ar, 1.5, 0.001), ct);
const empty = c.contentFromPixels(new Uint8Array(w * h * 4), w, h);
check("全透明 → 當作整張圖", empty.x0 === 0 && empty.x1 === 1 && empty.y0 === 0 && empty.y1 === 1);

console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
