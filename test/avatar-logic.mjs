// Avatar V2：骨架引擎、髮色及拆件還原度測試（不需要瀏覽器）
// 執行：node test/avatar-logic.mjs   （需要 esbuild、sharp）
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, buildModule } from "./doll-build.mjs";
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_PATH || "sharp");
const R = await buildModule("shared/avatarRig.ts", "avatar-rig");
const V = await buildModule("shared/avatarV2.ts", "avatar-v2");
const D = await buildModule("shared/doll.ts", "avatar-doll");

let passed = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); }
}
const rig = V.RIG_V2;
const near = (a, b, e = 0.01) => Math.abs(a - b) <= e;
const BASE = join(ROOT, "public/doll/avatar_v2");

console.log("rig.json 結構");
const need = ["root", "pelvis", "torso", "neck", "head", "shoulder_l", "shoulder_r", "elbow_l", "elbow_r", "wrist_l", "wrist_r", "hip_l", "hip_r", "knee_l", "knee_r", "ankle_l", "ankle_r", "hair_tail_l", "hair_tail_r"];
check("全部骨骼齊備", need.every((b) => rig.bones.some((x) => x.id === b)));
check("每個骨骼有 parent／rest_position／pivot／角度範圍／attached_assets", rig.bones.every((b) => "parent" in b && b.rest_position.length === 2 && b.pivot.length === 2 && b.min_angle <= 0 && b.max_angle >= 0 && Array.isArray(b.attached_assets)));
check("父骨骼都存在，只有 root 沒有父骨骼", rig.bones.every((b) => (b.id === "root" ? b.parent === null : rig.bones.some((x) => x.id === b.parent))));
const bodyFiles = ["head", "neck", "torso", "pelvis", "upper_arm_l", "lower_arm_l", "hand_l", "upper_arm_r", "lower_arm_r", "hand_r", "upper_leg_l", "lower_leg_l", "foot_l", "upper_leg_r", "lower_leg_r", "foot_r"];
const hairFiles = ["hair_back_base", "hair_bangs", "hair_side_l", "hair_side_r", "hair_tail_l", "hair_tail_r"];
check("16 個身體部件及 6 個頭髮部件都有檔案", [...bodyFiles, ...hairFiles].every((n) => rig.parts[n] && existsSync(join(BASE, rig.parts[n].src))));
check("每個部件都掛在存在的骨骼上，並列在繪畫次序內", Object.entries(rig.parts).every(([n, p]) => rig.bones.some((b) => b.id === p.bone) && rig.draw_order.includes(n)));
check("部件位置在畫布範圍內", Object.values(rig.parts).every((p) => p.x >= 0 && p.y >= 0 && p.x + p.w <= 1200 && p.y + p.h <= 1800));
check("左右以角色本人為準：_r 在畫面左邊", rig.parts.hand_r.x + rig.parts.hand_r.w / 2 < 600 && rig.parts.hand_l.x + rig.parts.hand_l.w / 2 > 600 && rig.parts.foot_r.x < rig.parts.foot_l.x && rig.parts.hair_tail_r.x < rig.parts.hair_tail_l.x);
check("頭髮部件有挑染遮罩", hairFiles.every((n) => rig.parts[n].accent_mask && existsSync(join(BASE, rig.parts[n].accent_mask))));
check("後髮在身體之下、前髮在身體之上", rig.draw_order.indexOf("hair_tail_l") < rig.draw_order.indexOf("pelvis_under") && rig.draw_order.indexOf("hair_bangs") > rig.draw_order.indexOf("head"));

console.log("部件檔案");
for (const n of [...bodyFiles, ...hairFiles]) {
  const meta = await sharp(join(BASE, rig.parts[n].src)).metadata();
  if (!(meta.width === rig.parts[n].w && meta.height === rig.parts[n].h && meta.hasAlpha)) check(`${n} 尺寸與 rig.json 一致並有透明通道`, false, meta);
}
check("部件尺寸與 rig.json 一致並有透明通道", true);
const baseMeta = await sharp(join(BASE, "avatar_base_v2.png")).metadata();
check("avatar_base_v2.png 為 1200×1800 RGBA", baseMeta.width === 1200 && baseMeta.height === 1800 && baseMeta.hasAlpha && baseMeta.channels === 4);
const baseRaw = await sharp(join(BASE, "avatar_base_v2.png")).ensureAlpha().raw().toBuffer();
let clear = 0, opaque = 0;
for (let i = 3; i < baseRaw.length; i += 4) { if (baseRaw[i] === 0) clear++; else if (baseRaw[i] === 255) opaque++; }
check("基準圖是真正的透明背景（四角及大部分背景 alpha＝0）", baseRaw[3] === 0 && baseRaw[(1199) * 4 + 3] === 0 && clear > 1200 * 1800 * 0.6, { clear });
check("人物主體完全不透明", opaque > 400000, { opaque });

console.log("拆件重新組裝");
const layers = rig.draw_order.map((n) => ({ input: join(BASE, rig.parts[n].src), left: rig.parts[n].x, top: rig.parts[n].y }));
const blank = { create: { width: 1200, height: 1800, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } };
const asm = await sharp(blank).composite(layers).png().toBuffer();
const flat = async (buf) => sharp(buf).flatten({ background: "#ede6f2" }).removeAlpha().raw().toBuffer();
const [fa, fb] = [await flat(asm), await flat(join(BASE, "avatar_base_v2.png"))];
let sum = 0, over16 = 0, over48 = 0;
for (let i = 0; i < fa.length; i += 3) {
  const d = Math.max(Math.abs(fa[i] - fb[i]), Math.abs(fa[i + 1] - fb[i + 1]), Math.abs(fa[i + 2] - fb[i + 2]));
  sum += d; if (d > 16) over16++; if (d > 48) over48++;
}
const figure = opaque;
console.log(`    平均差 ${(sum / (fa.length / 3)).toFixed(3)}／255；差異 >16 的像素 ${over16}（佔人物 ${(over16 / figure * 100).toFixed(2)}%）；>48：${over48}`);
check("全部部件疊加後與原圖高度一致（平均差 < 0.5／255）", sum / (fa.length / 3) < 0.5);
check("明顯差異（>16）的像素少於人物的 1.5%", over16 / figure < 0.015, { over16 });
check("嚴重差異（>48）的像素少於人物的 0.2%", over48 / figure < 0.002, { over48 });
const asmRaw = await sharp(asm).raw().toBuffer();
let holes = 0;
for (let i = 3; i < asmRaw.length; i += 4) if (baseRaw[i] === 255 && asmRaw[i] < 200) holes++;
check("靜止姿勢沒有透明裂縫（原圖不透明處，組裝後亦不透明）", holes < 400, { holes });

console.log("Forward Kinematics");
const J = Object.fromEntries(rig.bones.map((b) => [b.id, b.pivot]));
const rest = R.jointPositions(rig, {});
check("靜止姿勢：關節位置＝量度位置", rig.bones.every((b) => near(rest[b.id][0], b.pivot[0]) && near(rest[b.id][1], b.pivot[1])));
check("靜止姿勢：所有矩陣為單位矩陣", Object.values(R.solve(rig, {})).every((m) => R.isIdentity(m)));
const p1 = R.jointPositions(rig, { shoulder_r: 20 });
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
check("轉動肩膊：肩關節不動", near(p1.shoulder_r[0], J.shoulder_r[0]) && near(p1.shoulder_r[1], J.shoulder_r[1]));
check("轉動肩膊：手肘及手腕跟隨移動", dist(p1.elbow_r, J.elbow_r) > 50 && dist(p1.wrist_r, J.wrist_r) > 120);
check("轉動肩膊：上臂及前臂長度不變", near(dist(p1.shoulder_r, p1.elbow_r), dist(J.shoulder_r, J.elbow_r), 0.01) && near(dist(p1.elbow_r, p1.wrist_r), dist(J.elbow_r, J.wrist_r), 0.01));
check("轉動肩膊：另一邊手臂及雙腿不受影響", near(p1.wrist_l[0], J.wrist_l[0]) && near(p1.ankle_r[1], J.ankle_r[1]));
check("右肩正角度＝手臂向外張（畫面向左）", p1.wrist_r[0] < J.wrist_r[0]);
const m1 = R.solve(rig, { shoulder_r: 20 });
check("前臂及手掌的矩陣與上臂相同（未自行轉動時）", m1.elbow_r.every((v, i) => near(v, m1.shoulder_r[i], 1e-9)) && m1.wrist_r.every((v, i) => near(v, m1.shoulder_r[i], 1e-9)));
const m2 = R.solve(rig, { shoulder_r: 20, elbow_r: -10 });
check("父子角度累加：前臂角度＝肩＋肘", near(R.matAngle(m2.elbow_r), 10, 1e-6) && near(R.matAngle(m2.wrist_r), 10, 1e-6));
const p2 = R.jointPositions(rig, { hip_l: -8 });
check("轉動大腿：膝及腳踝跟隨，髖關節不動", near(p2.hip_l[0], J.hip_l[0]) && dist(p2.knee_l, J.knee_l) > 30 && dist(p2.ankle_l, J.ankle_l) > 80 && near(dist(p2.knee_l, p2.ankle_l), dist(J.knee_l, J.ankle_l), 0.01));
const p3 = R.jointPositions(rig, { head: 8 });
check("轉動頭部：雙馬尾的關節跟隨，身體不動", dist(p3.hair_tail_l, J.hair_tail_l) > 10 && near(p3.shoulder_l[0], J.shoulder_l[0]));
const p4 = R.jointPositions(rig, { torso: 4 });
check("轉動上身：頭、手臂跟隨，雙腿不動", dist(p4.head, J.head) > 10 && dist(p4.wrist_r, J.wrist_r) > 5 && near(p4.knee_r[0], J.knee_r[0]));
check("超出範圍的角度會被限制", near(R.matAngle(R.solve(rig, { shoulder_r: 999 }).shoulder_r), rig.bones.find((b) => b.id === "shoulder_r").max_angle, 1e-6));
check("clampPose 去掉未知骨骼、0 及非數字", JSON.stringify(R.clampPose(rig, { shoulder_r: 5.04, nope: 3, elbow_r: 0, head: NaN })) === '{"shoulder_r":5}');
check("normalizePose：未知骨骼／非數字／非物件 → null", R.normalizePose(rig, { nope: 1 }) === null && R.normalizePose(rig, { head: "3" }) === null && R.normalizePose(rig, [1]) === null && R.normalizePose(rig, "x") === null);
check("normalizePose：null＝預設姿勢", JSON.stringify(R.normalizePose(rig, null)) === "{}");
check("rotateAbout：旋轉中心不動", (() => { const m = R.rotateAbout(37, 100, 200); const [x, y] = R.applyMat(m, 100, 200); return near(x, 100, 1e-9) && near(y, 200, 1e-9); })());
check("matToCss 按顯示比例縮放位移", /^matrix\(1\.000000,0\.000000,-?0\.000000,1\.000000,5\.000,10\.000\)$/.test(R.matToCss([1, 0, 0, 1, 10, 20], 0.5)));
check("descendants：肩之下有肘及腕", R.descendants(rig, "shoulder_r").join() === "elbow_r,wrist_r");

console.log("IK（拖動手掌／腳掌）");
const target = [J.wrist_r[0] + 60, J.wrist_r[1] - 10];
const ik = R.reachIK(rig, {}, "shoulder_r", "elbow_r", "wrist_r", target);
const reached = R.jointPositions(rig, ik).wrist_r;
check("手腕移近目標", dist(reached, target) < dist(J.wrist_r, target) * 0.5, { reached, target });
check("IK 結果不超出關節範圍", rig.bones.every((b) => (ik[b.id] ?? 0) >= b.min_angle && (ik[b.id] ?? 0) <= b.max_angle));
check("IK 只改動該肢體", Object.keys(ik).every((k) => ["shoulder_r", "elbow_r"].includes(k)));
const far = R.reachIK(rig, {}, "hip_l", "knee_l", "ankle_l", [2000, 0]);
check("目標太遠時停在可動範圍邊界，不會出錯", rig.bones.every((b) => (far[b.id] ?? 0) >= b.min_angle && (far[b.id] ?? 0) <= b.max_angle));

console.log("姿勢預設");
const ids = V.POSE_PRESETS.map((p) => p.id);
check("六個姿勢預設", ["a_pose", "arms_in", "arms_out", "long_sleeve", "outerwear", "asymmetric"].every((i) => ids.includes(i)));
check("預設全部在關節範圍內", V.POSE_PRESETS.every((p) => R.samePose(rig, p.pose, R.clampPose(rig, p.pose))));
check("預設 A 字站姿＝全部關節為 0", Object.keys(V.POSE_PRESETS.find((p) => p.id === "a_pose").pose).length === 0);
check("自然收手：雙手比預設更貼近身體", (() => { const p = R.jointPositions(rig, V.POSE_PRESETS.find((x) => x.id === "arms_in").pose); return p.wrist_r[0] > J.wrist_r[0] + 40 && p.wrist_l[0] < J.wrist_l[0] - 40; })());
check("外張：雙手更遠離身體", (() => { const p = R.jointPositions(rig, V.POSE_PRESETS.find((x) => x.id === "arms_out").pose); return p.wrist_r[0] < J.wrist_r[0] - 40 && p.wrist_l[0] > J.wrist_l[0] + 40; })());

console.log("錨點跟隨姿勢");
const a0 = R.posedAnchors(rig, {}), a1 = R.posedAnchors(rig, { shoulder_r: 15, head: 6 });
check("靜止姿勢的錨點＝量度值", Object.entries(rig.anchors).every(([k, v]) => near(a0[k].x, v[0], 0.06) && near(a0[k].y, v[1], 0.06)));
check("手腕錨點跟隨手臂，腰及膝不動", Math.abs(a1.wrist_r.x - a0.wrist_r.x) > 30 && a1.waist.x === a0.waist.x && a1.knee_l.y === a0.knee_l.y);
check("頭頂錨點跟隨頭部", Math.abs(a1.head_top.x - a0.head_top.x) > 10);
check("腰側在腰的兩邊、肩在頸的兩邊", a0.waist_side_r.x < a0.waist.x - 60 && a0.waist_side_l.x > a0.waist.x + 60 && a0.shoulder_r.x < a0.neck.x && a0.shoulder_l.x > a0.neck.x);
check("V2 錨點並非照搬 V1", JSON.stringify(rig.anchors.shoulder_r) !== JSON.stringify([D.BASE_V1.anchors.shoulder_l.x, D.BASE_V1.anchors.shoulder_l.y]) && rig.anchors.waist[1] !== D.BASE_V1.anchors.waist.y);

console.log("髮色");
const ref = rig.hair.ref_luma;
const px = (arr) => new Uint8ClampedArray(arr);
const brown = [100, 74, 80, 255], pinkPx = [222, 134, 157, 255], hi = [250, 235, 238, 255];
let img = px([...brown, ...pinkPx, ...hi, 0, 0, 0, 0]);
const mask = px([0, 255, 0, 255, 255, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255]);
V.recolorHair(img, mask, null, null, ref);
check("原色預設：像素完全不變", [...img].join() === [...brown, ...pinkPx, ...hi, 0, 0, 0, 0].join());
img = px([...brown, ...pinkPx, ...hi, 0, 0, 0, 0]);
V.recolorHair(img, mask, [126, 84, 170], [126, 84, 170], ref);
check("重新著色不改變 alpha（輪廓不變）", img[3] === 255 && img[7] === 255 && img[11] === 255 && img[15] === 0);
check("紫色：主髮變成偏藍紫", img[2] > img[0] && img[2] > img[1]);
check("保留明暗：高光仍然比主髮亮", img[8] + img[9] + img[10] > img[0] + img[1] + img[2] + 150);
img = px([...brown, ...pinkPx]);
V.recolorHair(img, px([0, 255, 0, 255, 255, 255, 0, 255]), [44, 40, 50], [232, 120, 158], ref);
check("黑粉挑染：主髮變黑、挑染仍是粉色", img[0] < 70 && img[4] > 180 && img[4] > img[5] + 60);
img = px([...brown, ...pinkPx]);
V.recolorHair(img, px([0, 255, 0, 255, 255, 255, 0, 255]), null, [100, 73, 79], ref);
check("深啡色：主髮不變、挑染變成啡色", img[0] === 100 && img[1] === 74 && img[4] < 140 && Math.abs(img[4] - img[5]) < 60);
img = px([...brown]);
V.recolorHair(img, px([0, 0, 0, 255]), [176, 180, 196], [176, 180, 196], ref);
check("遮罩標明不是頭髮（瀏海陰影）的像素不著色", img[0] === 100 && img[1] === 74 && img[2] === 80);
check("七款髮色齊備", ["black", "dark_brown", "black_pink", "brown_pink", "silver", "purple", "pink"].every((id) => V.HAIR_COLORS.some((c) => c.id === id)));
check("normalizeColorValue：預設 id 或 #rrggbb", V.normalizeColorValue("purple") === "purple" && V.normalizeColorValue("#AABBCC") === "#aabbcc" && V.normalizeColorValue("red") === null && V.normalizeColorValue(5) === null);
const rc = V.resolveHairColors("black", "#ff0000");
check("主髮色及挑染色可分開設定", rc.main.join() === "44,40,50" && rc.accent.join() === "255,0,0");
check("髮型以資料登記，預設為長雙馬尾", V.HAIR_STYLES[V.DEFAULT_HAIR_STYLE].label === "長雙馬尾" && Object.keys(V.HAIR_STYLES[V.DEFAULT_HAIR_STYLE].parts).length === 6);

console.log("衣物附接及單圖衣物的姿勢限制");
check("附接骨骼：衣身→torso、半裙→pelvis、袖→上臂、袖套→前臂、手套→wrist、鞋→ankle、頭飾→head", V.ATTACH_BONE.torso === "torso" && V.ATTACH_BONE.skirt === "pelvis" && V.ATTACH_BONE.sleeve_left === "shoulder_l" && V.ATTACH_BONE.cuff_right === "elbow_r" && V.ATTACH_BONE.glove_left === "wrist_l" && V.ATTACH_BONE.shoe_right === "ankle_r" && V.ATTACH_BONE.head_accessory === "head");
check("附接的骨骼全部存在", Object.values(V.ATTACH_BONE).every((b) => rig.bones.some((x) => x.id === b)));
check("預設姿勢：單圖衣物全部可用", ["top", "outer", "dress", "set", "skirt", "socks"].every((s) => V.singleImagePoseIssues(s, {}).length === 0));
check("手臂大幅移動：單圖上衣標示未支援", V.singleImagePoseIssues("top", { shoulder_r: 18 }).join() === "shoulder_r");
check("半身裙不受手臂姿勢影響", V.singleImagePoseIssues("skirt", { shoulder_r: 18, elbow_l: 20 }).length === 0);

console.log(`\n結果：${passed} 通過，${failures.length} 失敗`);
if (failures.length) { console.log(failures.join("\n")); process.exit(1); }
