// 角色換裝 Phase 3：純邏輯測試（骨架、姿勢、自由疊穿、預設位置、舊角色換算、分區遮罩、髮色）
// 執行：node test/doll-logic.mjs   （需要 esbuild）
import { buildModule } from "./doll-build.mjs";

const D = await buildModule("shared/doll.ts", "t-doll");
const R = await buildModule("shared/avatarRig.ts", "t-rig");
const V = await buildModule("shared/avatarV2.ts", "t-v2");
const S = await buildModule("shared/skin.ts", "t-skin");
let passed = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); }
}
const near = (a, b, e = 0.6) => Math.abs(a - b) <= e;
const rig = V.RIG_V2;

console.log("骨架");
{
  const ids = rig.bones.map((b) => b.id);
  check("新增上胸及側髮骨骼", ["chest", "hair_side_r", "hair_side_l"].every((b) => ids.includes(b)), ids);
  check("肩膊、頸跟隨上胸", ["neck", "shoulder_r", "shoulder_l"].every((b) => rig.bones.find((x) => x.id === b).parent === "chest"));
  check("每個部件的骨骼都存在", Object.values(rig.parts).every((p) => ids.includes(p.bone)));
  const rest = R.solve(rig, {});
  check("靜止姿勢全部是單位矩陣", Object.values(rest).every(R.isIdentity));
  const j0 = R.jointPositions(rig, {});
  check("靜止時關節在原位", near(j0.wrist_r[0], 314) && near(j0.wrist_r[1], 885));
  const p1 = R.clampPose(rig, { shoulder_r: 400, elbow_r: -500, bogus: 3, "root.x": 9999, "elbow_l.x": 5, "wrist_l.x": 5 });
  check("角度及平移都被限制在可動範圍", p1.shoulder_r === 95 && p1.elbow_r === -135 && p1["root.x"] === 260 && p1["elbow_l.x"] === 5, p1);
  check("不存在的骨骼及不可平移的節點被丟棄", !("bogus" in p1) && !("wrist_l.x" in p1), p1);
  check("normalizePose 拒絕非數字", R.normalizePose(rig, { head: "x" }) === null && R.normalizePose(rig, []) === null);
  check("normalizePose 略過未知髮束骨骼", JSON.stringify(R.normalizePose(rig, { hp_abc: 10, head: 5 })) === JSON.stringify({ head: 5 }));
  const moved = R.jointPositions(rig, { "root.x": 40, "root.y": -20 });
  check("整體重心平移帶動全身", near(moved.head[0], j0.head[0] + 40) && near(moved.ankle_l[1], j0.ankle_l[1] - 20));
  const chest = R.jointPositions(rig, { chest: 8 });
  check("上胸旋轉帶動肩膊及頭，不影響腿", !near(chest.shoulder_r[1], j0.shoulder_r[1], 2) && near(chest.knee_r[0], j0.knee_r[0]) && !near(chest.head[0], j0.head[0], 2));
  const target = [300, 560];
  const aimed = R.aimBone(rig, {}, "shoulder_r", rig.bones.find((b) => b.id === "elbow_r").pivot, target);
  const e = R.jointPositions(rig, aimed).elbow_r, s = j0.shoulder_r;
  check("FK 瞄準：手肘轉到指向目標", near(Math.atan2(e[1] - s[1], e[0] - s[0]), Math.atan2(target[1] - s[1], target[0] - s[0]), 0.02), { e, aimed });
  const ik = R.reachIK(rig, {}, "shoulder_r", "elbow_r", "wrist_r", [450, 780]);
  const w = R.jointPositions(rig, ik).wrist_r;
  check("IK：手腕到達叉腰位置", Math.hypot(w[0] - 450, w[1] - 780) < 12, { w, ik });
  const mv = R.moveBone(rig, {}, "shoulder_l", [j0.shoulder_l[0] + 10, j0.shoulder_l[1] - 12]);
  check("肩膊可小幅平移", mv["shoulder_l.x"] === 10 && mv["shoulder_l.y"] === -12, mv);
  check("samePose 計及平移", !R.samePose(rig, {}, { "root.x": 3 }) && R.samePose(rig, { head: 0 }, {}));
  const names = V.POSE_PRESETS.map((p) => p.id);
  check("姿勢預設包括叉腰、提裙、伸展、交叉、重心偏側", ["hand_on_hip", "lift_skirt", "reach_out", "legs_crossed", "weight_shift", "long_sleeve", "lolita"].every((n) => names.includes(n)), names);
  check("預設姿勢全部在可動範圍內", V.POSE_PRESETS.every((p) => R.samePose(rig, p.pose, R.clampPose(rig, p.pose))));
}

console.log("自由疊穿及預設位置");
{
  check("沒有互斥函數（衣物不會被自動脫下）", !("conflicts" in D) && !("wear" in D) && !("SLOT_LIMIT" in D));
  const worn = [{ slot: "socks" }, { slot: "top" }, { slot: "dress" }];
  check("新衣物按預設次序插入：襯衫在連身裙之下", D.insertIndex(worn, "top") === 2 && D.insertIndex(worn, "outer") === 3 && D.insertIndex(worn, "shoes") === 1);
  check("同類衣物可以再穿一件，排在同類之上", D.insertIndex([{ slot: "skirt" }, { slot: "skirt" }], "skirt") === 2);
  check("疊穿提示只是文字", D.layeringHints(["dress", "dress"]).length === 1 && D.layeringHints(["top", "skirt"]).length === 0);
  const c = { x0: 0.2, y0: 0.1, x1: 0.8, y1: 0.9, ar: 4 / 3 };
  const a = D.ANCHORS;
  const top = (f) => f.cy - (f.w * c.ar) / 2 + c.y0 * f.w * c.ar, bottom = (f) => f.cy - (f.w * c.ar) / 2 + c.y1 * f.w * c.ar;
  const dress = D.defaultFit("dress", c), skirt = D.defaultFit("skirt", c), shoes = D.defaultFit("shoes", c), hat = D.defaultFit("headwear", c);
  check("連身裙由肩線到膝", near(top(dress), a.shoulder_l.y - 28, 1) && near(bottom(dress), a.knee_l.y, 1), dress);
  check("半身裙由腰線開始", near(top(skirt), a.waist.y - 10, 1));
  check("鞋貼地、頭飾在頭頂", near(bottom(shoes), a.floor.y + 4, 1) && Math.abs(hat.cy - a.head_top.y) < 80);
  check("長裙比短裙長", bottom(D.defaultFit("skirt", c, null, "長裙")) > bottom(D.defaultFit("skirt", c, null, "迷你裙")) + 200);
  check("裙腰闊度對齊腰", near(D.defaultFit("skirt", { ...c, waistBand: { x0: 0.4, x1: 0.6 } }).cx, 600, 2));
  check("normalizeFit 拒絕離譜數值", D.normalizeFit({ cx: 1e6, cy: 0, w: 100 }) === null && D.normalizeFit({ cx: 600, cy: 900, w: 5 }) === null && D.normalizeFit({ cx: 600, cy: 900, w: 300, rotation: 370 }).rotation === 10);
  const v1 = { cx: 600, cy: 880, w: 620, rotation: 0 }; // V1 上的連身裙：內容約由 y=550 到 y=1210
  const conv = D.convertLegacyFit(v1, c);
  check("V1 → V2：肩線附近的上緣移到 V2 的肩線附近", top(conv) > a.shoulder_l.y - 60 && top(conv) < a.bust.y, { top: top(conv), conv });
  check("V1 → V2：下緣仍在膝附近，大小合理", Math.abs(bottom(conv) - a.knee_l.y) < 140 && conv.w > 465 && conv.w < 930, { bottom: bottom(conv) });
  check("hitTest 只計實際內容", D.hitTest(dress, c, 600, 800) && !D.hitTest(dress, c, dress.cx - dress.w / 2 + 5, dress.cy));
}

console.log("造型及衣物預設資料");
{
  const st = D.normalizeLookState({ head: "builtin:head_v2", hair: "das_abcdefgh", hair_color: "#AABBCC", tip_color: "#112233", pose: { head: 5, "root.x": 10, hp_p1: -8, bad: 0 }, front: ["hand_r", "x"],
    items: [{ garment_id: "gar_a", slot: "top", hidden: true, fit: { cx: 600, cy: 500, w: 400, rotation: 2 }, opts: { follow: "full", neck: false } }, { garment_id: "gar_a", slot: "top" }, { garment_id: "gar_b", slot: "nope", variant: "v1" }] });
  check("造型狀態通過驗證", st && st.v === 3 && st.items.length === 2 && st.items[0].hidden && st.items[1].slot === "accessory" && st.items[1].variant === "v1", st);
  check("顏色轉小寫、姿勢保留髮束骨骼、front 過濾", st.hair_color === "#aabbcc" && st.tip_color === "#112233" && st.pose.hp_p1 === -8 && !("bad" in st.pose) && st.front.join() === "hand_r");
  check("個別穿法設定被規範化", st.items[0].opts.follow === "full" && st.items[0].opts.neck === false && st.items[0].opts.over_head === false);
  check("壞資料被拒絕", D.normalizeLookState({ items: "x" }) === null && D.normalizeLookState({ items: [{ garment_id: "a b" }] }) === null && D.normalizeLookState({ items: [], pose: { head: "1" } }) === null && D.normalizeLookState({ items: [{ garment_id: "g", fit: { cx: "x" } }] }) === null);
  check("超過上限被拒絕", D.normalizeLookState({ items: Array.from({ length: 41 }, (_, i) => ({ garment_id: "g" + i })) }) === null);
  const td = D.normalizeTemplateData({ opts: { follow: "upper", bone: "evil" }, mask: "data:image/png;base64,AAAA", pose: { head: 99 }, front: ["hand_l"], variants: { open: { name: " 打開 ", image: "file:daf_abcdefgh", fit: { cx: 600, cy: 500, w: 500 } }, "BAD ID": {}, tucked: { name: "", image: "http://x" } } }, "outer");
  check("衣物預設：跟隨方式、遮罩、建議姿勢", td.opts.follow === "upper" && td.opts.bone === null && td.opts.neck === true && td.mask && td.pose.head === 22 && td.front[0] === "hand_l", td);
  check("穿法：名稱、另一張圖、位置", Object.keys(td.variants).join() === "open,tucked" && td.variants.open.name === "打開" && td.variants.open.image === "file:daf_abcdefgh" && td.variants.open.fit.w === 500 && td.variants.tucked.image === null && td.variants.tucked.name === "穿法");
  check("頭飾預設蓋在頭髮上，其他不會", D.defaultOpts("headwear").over_head && !D.defaultOpts("dress").over_head && D.defaultOpts("dress").neck && !D.defaultOpts("skirt").neck);
  check("遮罩只接受細小的 PNG data URL", !D.isMask("data:image/png;base64," + "A".repeat(90000)) && !D.isMask("javascript:alert(1)"));
}

console.log("衣物跟隨骨架的分區");
{
  const grid = { x0: 0, y0: 0, w: 240, h: 360, step: 5 };
  const at = (masks, bone, x, y) => masks.find((m) => m.bone === bone).alpha[Math.floor(y / 5) * grid.w + Math.floor(x / 5)];
  const up = S.skinMasks("upper", true, grid);
  check("上身分成骨盆、腰、上胸、左右上臂及前臂", up.map((m) => m.bone).join() === "pelvis,torso,chest,shoulder_r,shoulder_l,elbow_r,elbow_l");
  check("胸口屬於上胸、腰屬於腰、裙身屬於骨盆", at(up, "chest", 600, 450) === 255 && at(up, "torso", 600, 650) === 255 && at(up, "pelvis", 600, 900) === 255);
  check("上臂及前臂各自跟隨手臂", at(up, "shoulder_r", 430, 500) === 255 && at(up, "elbow_r", 370, 780) === 255 && at(up, "shoulder_l", 770, 500) === 255 && at(up, "chest", 430, 500) === 0);
  check("關節位置兩邊重疊（不會露出空隙）", at(up, "shoulder_r", 425, 650) === 255 && at(up, "elbow_r", 425, 650) === 255 && at(up, "chest", 477, 393) === 255 && at(up, "shoulder_r", 477, 393) === 255);
  let holes = 0;
  for (let i = 0; i < grid.w * grid.h; i++) if (Math.max(...up.map((m) => m.alpha[i])) < 250) holes++;
  check("靜止時每一點至少有一個區域完整覆蓋（與原圖一樣）", holes === 0, holes);
  const short = S.skinMasks("upper", false, grid);
  check("短袖模式：只有上臂，前臂位置留在身體", short.length === 5 && at(short, "shoulder_r", 360, 800) === 0 && at(short, "pelvis", 360, 800) === 255);
  const legs = S.skinMasks("legs", true, grid);
  check("腿：大腿、小腿、腳掌各自跟隨", at(legs, "hip_r", 530, 1050) === 255 && at(legs, "knee_r", 530, 1450) === 255 && at(legs, "ankle_r", 521, 1720) === 255 && at(legs, "hip_l", 670, 1050) === 255 && at(legs, "hip_r", 670, 1050) === 0);
  // 衣物輪廓：衣身 480–720、袖子 330–450（中間有空隙），袖口比衣襬長
  const jacket = (x, y) => y > 380 && ((x > 480 && x < 720 && y < 700) || (x > 330 && x < 450 && y < 860) || (x > 750 && x < 870 && y < 860));
  const g = S.findSleeveGap(jacket, "r", true), gl = S.findSleeveGap(jacket, "l", true);
  check("由輪廓找到袖子與衣身之間的空隙", g && near(g.at(600), 465, 6) && gl && near(gl.at(600), 465, 6), g && [g.top, g.bottom, g.at(600)]);
  check("衣襬以下沿用分界（袖口仍屬於袖子）", g && g.bottom === Infinity && near(g.at(840), 465, 6));
  const gm = S.skinMasks("upper", false, grid, { r: g, l: gl });
  check("按輪廓分區：整隻袖（連袖口）跟隨上臂，衣身不動", at(gm, "shoulder_r", 390, 820) === 255 && at(gm, "shoulder_r", 600, 500) === 0 && at(gm, "chest", 600, 500) === 255 && at(gm, "shoulder_l", 810, 820) === 255);
  check("沒有袖子的衣物找不到空隙", S.findSleeveGap((x, y) => x > 480 && x < 720 && y > 380 && y < 1200, "r") === null);
  const dressGap = S.findSleeveGap((x, y) => y > 380 && ((x > 480 && x < 720 && y < 700) || (x > 330 && x < 450 && y < 640) || (y >= 700 && y < 1200 && x > 300 && x < 900)), "r");
  check("連身裙：袖子只到空隙結束，裙身不算袖子", dressGap && Number.isFinite(dressGap.bottom) && dressGap.bottom < 700, dressGap && dressGap.bottom);
}

console.log("角色素材及髮色");
{
  const cfg = V.normalizeHairConfig({ parts: [{ id: "p1", label: "後髮", file: "file:daf_abcdefgh", layer: "back", x: 300, y: 0, w: 600, h: 900 }, { id: "p2", file: "/doll/x.png", layer: "weird", x: 500, y: 30, w: 200, h: 200, bone: "own", range: 999 }] });
  check("髮型設定：單張或多張部件都可以", cfg && cfg.parts.length === 2 && cfg.parts[1].layer === "back" && cfg.parts[1].bone === "own" && cfg.parts[1].range === 20 && cfg.parts[1].pivot.length === 2, cfg);
  check("拒絕外部網址及重複 id", V.normalizeHairConfig({ parts: [{ id: "a", file: "https://evil/x.png", x: 0, y: 0, w: 10, h: 10 }] }) === null && V.normalizeHairConfig({ parts: [{ id: "a", file: "/doll/a.png", x: 0, y: 0, w: 10, h: 10 }, { id: "a", file: "/doll/a.png", x: 0, y: 0, w: 10, h: 10 }] }) === null && !V.isImageRef("/doll/../secret"));
  const r2 = V.rigFor(cfg);
  check("獨立髮束自動加入骨架", r2.bones.some((b) => b.id === "hp_p2" && b.parent === "head" && b.max_angle === 20) && V.rigFor(cfg) === r2 && V.rigFor(null) === rig);
  check("頭部設定", V.normalizeHeadConfig({ file: "file:daf_abcdefgh", x: 490, y: 36, w: 220, h: 272 }) && V.normalizeHeadConfig({ file: "x", x: 0, y: 0, w: 1, h: 1 }) === null);
  check("內置髮型用同一種設定格式", V.BUILTIN_HAIRS[0].config.parts.length === 6 && V.BUILTIN_HAIRS[0].config.parts.every((p) => rig.bones.some((b) => b.id === p.bone)));
  check("保留七種髮色", V.HAIR_COLORS.length === 7 && V.normalizeColorValue("#ABCDEF") === "#abcdef" && V.normalizeColorValue("red") === null);
  // 啡色頭髮＋粉紅挑染（沒有遮罩）：自動分辨
  const px = new Uint8ClampedArray(4 * 6000);
  for (let i = 0; i < 6000; i++) { const pink = i % 10 === 0; px.set(pink ? [224, 137, 159, 255] : [100 + (i % 7), 73, 79, 255], i * 4); }
  const stats = V.analyzeHair([px]);
  check("自動找出主髮色及挑染", stats.hasAccent && stats.main < stats.accent, stats);
  const out = px.slice();
  V.recolorHair(out, null, { main: [44, 40, 50], accent: [126, 84, 170], ref: { main: stats.main, accent: stats.accent }, stats });
  check("沒有遮罩也能分開染主髮色及挑染", out[4] < 70 && out[6] < 80 && out[2] > out[1] && out[0] > 90 && out[3] === 255, [...out.slice(0, 8)]);
  const tip = px.slice();
  V.recolorHair(tip, null, { main: null, accent: null, ref: { main: stats.main, accent: stats.accent }, stats, tip: { color: [240, 240, 255], row0: 100, row1: 500 }, width: 10 });
  check("髮尾漸層：上面不變、下面變色", tip[4] === px[4] && tip[4 * 5995] > px[4 * 5995] + 40);
  const same = px.slice();
  V.recolorHair(same, null, { main: null, accent: null, ref: { main: 0.3, accent: 0.6 } });
  check("原色＝像素不變", same.every((v, i) => v === px[i]));
}

console.log(`\n${passed} 項通過，${failures.length} 項失敗`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
