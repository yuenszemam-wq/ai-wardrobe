// 角色換裝 Phase 3：純邏輯測試（骨架、姿勢、自由疊穿、預設位置、舊角色換算、分區遮罩、髮色）
// 執行：node test/doll-logic.mjs   （需要 esbuild）
import { buildModule } from "./doll-build.mjs";

const D = await buildModule("shared/doll.ts", "t-doll");
const R = await buildModule("shared/avatarRig.ts", "t-rig");
const V = await buildModule("shared/avatarV2.ts", "t-v2");
const G = await buildModule("shared/garmentMesh.ts", "t-mesh");
const E = await buildModule("src/doll/engine.ts", "t-engine");
let passed = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failures.push(name); console.log("  ✗", name, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); }
}
const near = (a, b, e = 0.6) => Math.abs(a - b) <= e;
const rig = V.RIG_V2;
const M = await buildModule("shared/avatarModel.ts", "t-avatar-model");


console.log("Phase 3.6 model isolation");
{
  const shifted = JSON.parse(JSON.stringify(rig));
  shifted.avatar_id = "test_body";
  for (const b of shifted.bones) { b.pivot[0] += 30; b.rest_position[0] += 30; }
  for (const p of Object.values(shifted.anchors)) p[0] += 30;
  const c = D.FULL_CONTENT();
  const a = D.defaultFit("dress", c);
  const b = D.defaultFit("dress", c, null, null, null, shifted);
  check("自訂模型的衣物對位使用模型錨點", near(b.cx - a.cx, 30));
  check("預設模型保留 V2", M.DEFAULT_BODY_MODEL.id === V.AVATAR_V2_ID);
  const hair = { parts: [] };
  check("相同髮件不共用不同身體骨架快取", V.rigFor(hair, shifted) === shifted && V.rigFor(hair) === rig);
  const extra = { parts: [{ id:"custom", bone:"own", pivot:[650,200], range:20 }] };
  const r1 = V.rigFor(extra), r2 = V.rigFor(extra, shifted);
  check("自訂髮束骨架按身體分開", r1 !== r2 && r2.bones.some(b => b.id === "hp_custom") && r2.bones.find(b=>b.id==="head").pivot[0] === shifted.bones.find(b=>b.id==="head").pivot[0]);
}
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
  const manual = Array(32).fill(0); manual[2] = .04;
  check("手動網格可保存且改變對應控制點", !!D.normalizeManualMesh(manual) && Math.abs(D.manualUV(manual,1/3,0)[0] - (1/3+.04))<.001);
  const folded = [...manual]; folded[2]=-.7;
  check("拒絕翻面控制格", !D.normalizeManualMesh(folded));
  check("頭飾預設蓋在頭髮上，其他不會", D.defaultOpts("headwear").over_head && !D.defaultOpts("dress").over_head && D.defaultOpts("dress").neck && !D.defaultOpts("skirt").neck);
  check("遮罩只接受細小的 PNG data URL", !D.isMask("data:image/png;base64," + "A".repeat(90000)) && !D.isMask("javascript:alert(1)"));
}

console.log("衣物變形：連續網格（Phase 3.1）");
{
  // 測試用的衣物輪廓：直接畫在 1200×1800 畫布上（圖片＝整個畫布），每格 6.25 px
  const FIT = { cx: 600, cy: 900, w: 1200, rotation: 0 }, AR = 1.5, GW = 192, GH = 288;
  const gridOf = (fn) => { const data = new Uint8Array(GW * GH); for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) data[j * GW + i] = fn((i + 0.5) * 6.25, (j + 0.5) * 6.25) ? 255 : 0; return { w: GW, h: GH, data }; };
  const labelAt = (lab, x, y) => lab[Math.floor(y / 6.25) * GW + Math.floor(x / 6.25)];
  // 外套：衣身 480–720，袖子在外面（中間有空隙），袖口比衣襬長
  const jacket = gridOf((x, y) => y > 380 && ((x > 480 && x < 720 && y < 700) || (x > 330 && x < 450 && y < 860) || (x > 750 && x < 870 && y < 860) || (y < 470 && x > 330 && x < 870)));
  const dj = G.detectSleeves(jacket, FIT, AR, true);
  check("找到左右袖子（袖子與衣身之間有空隙）", dj.sleeve_r && dj.sleeve_l && !dj.unsure && labelAt(dj.labels, 390, 600) === 1 && labelAt(dj.labels, 810, 600) === 2 && labelAt(dj.labels, 600, 600) === 0, [labelAt(dj.labels, 390, 600), labelAt(dj.labels, 810, 600)]);
  check("袖口比衣襬長：仍然屬於袖子，衣身不會被算進去", labelAt(dj.labels, 390, 840) === 1 && labelAt(dj.labels, 600, 690) === 0 && labelAt(dj.labels, 500, 600) === 0);
  // 泡袖上衣：袖子向外平伸，與衣身完全相連（沒有空隙），下面有比衣身闊的荷葉衣襬
  const puff = gridOf((x, y) => (y > 380 && y < 800 && Math.abs(x - 600) < 150) || (y > 400 && y < 560 && Math.abs(x - 600) < 330) || (y >= 800 && y < 880 && Math.abs(x - 600) < 150 + (y - 800) * 1.2));
  const dp = G.detectSleeves(puff, FIT, AR, true);
  check("平伸的泡袖（沒有空隙）也能分辨", dp.sleeve_r && dp.sleeve_l && labelAt(dp.labels, 330, 480) === 1 && labelAt(dp.labels, 870, 480) === 2 && labelAt(dp.labels, 600, 480) === 0);
  check("比衣身闊的衣襬不會被當成袖子", labelAt(dp.labels, 380, 870) === 0 && labelAt(dp.labels, 820, 870) === 0);
  // JSK：沒有袖子，裙身很闊
  const jsk = gridOf((x, y) => (y > 380 && y < 700 && Math.abs(x - 600) < 130) || (y >= 700 && y < 1250 && Math.abs(x - 600) < 130 + (y - 700) * 0.6));
  const dk = G.detectSleeves(jsk, FIT, AR, false);
  check("沒有袖子的連身裙：不會把裙身當成袖子", !dk.sleeve_r && !dk.sleeve_l && dk.labels.every((v) => v === 0));
  // 長袖垂在裙身上連成一片：沒有把握 → 保持整件
  const merged = gridOf((x, y) => (y > 380 && y < 700 && Math.abs(x - 600) < 300) || (y >= 700 && y < 1250 && Math.abs(x - 600) < 300 + (y - 700) * 0.3));
  const dm = G.detectSleeves(merged, FIT, AR, false);
  check("分不清袖子與裙身時不強行拆件", !dm.sleeve_r && !dm.sleeve_l && dm.labels.every((v) => v === 0), dm.unsure);

  const input = (grid, extra = {}) => ({ grid, fit: FIT, ar: AR, kind: "upper", follow: "auto", bone: "chest", pinned: false, parts: null, loose: true, ...extra });
  // Regression: manual controls must move actual render vertices, not merely the overlay.
  const offsets=Array(32).fill(0); offsets[10]=.12; offsets[11]=.08;
  const manualInput=input(jacket,{follow:"none",bone:"world"});
  const warped=G.buildRig({...manualInput,fit:{...manualInput.fit,mesh:offsets}}).layers[0];
  check("手動變形確實改變渲染頂點",warped.rest.some((v,i)=>Math.abs(v-D.fromImage(manualInput.fit,manualInput.ar,warped.uv[i-i%2],warped.uv[i-i%2+1])[i%2])>10));
  check("手動網格每個頂點與控制格映射一致",warped.rest.every((v,i)=>Math.abs(v-D.manualPoint({...manualInput.fit,mesh:offsets},manualInput.ar,warped.uv[i-i%2],warped.uv[i-i%2+1])[i%2])<.001));
  const rig = G.buildRig(input(jacket));
  check("部件：衣身一層＋左右袖各一層（衣身先畫）", rig.layers.map((l) => l.part).join() === "0,1,2" && rig.info.mode === "parts" && rig.info.forearm, rig.info);
  const sums = rig.layers.every((l) => { const nb = l.bones.length; for (let k = 0; k < l.rest.length / 2; k++) { let t = 0; for (let b = 0; b < nb; b++) t += l.weights[k * nb + b]; if (Math.abs(t - 1) > 1e-4) return false; } return true; });
  check("每個頂點的骨骼權重總和＝1", sums);
  const rest = R.solve(V.RIG_V2, {});
  const same = rig.layers.every((l) => { const p = G.skinMesh(l, rest); return p.every((v, i) => Math.abs(v - l.rest[i]) < 1e-3); });
  check("靜止姿勢：網格與原圖位置完全一樣", same);
  // 衣物完整性：每一格布料至少屬於一個部件（沒有布料消失）；衣身伸入袖根底下
  const body = rig.layers[0], sr = rig.layers[1];
  let lost = 0, overlap = 0;
  for (let k = 0; k < jacket.data.length; k++) if (jacket.data[k] > 48) { const m = Math.max(...rig.layers.map((l) => l.matte[k])); if (m < 250) lost++; if (body.matte[k] > 200 && sr.matte[k] > 200) overlap++; }
  check("所有布料都有部件負責（靜止時與原圖一樣）", lost === 0, lost);
  check("衣身伸入袖根底下（袖子移開不會露出空洞）", overlap > 20, overlap);
  // 連續性：同一部件內相鄰的格共用頂點，所以任何姿勢下都不會斷開；另外檢查沒有被扯得過長
  const stretch = (pose) => {
    const mats = R.solve(V.RIG_V2, pose);
    let worst = 0, squeeze = 0;
    for (const l of rig.layers) {
      const p = G.skinMesh(l, mats);
      for (const k of l.order) {
        const [a, b, c, d] = G.cellVerts(l, k);
        for (const [u, v] of [[a, b], [a, c], [b, d], [c, d]]) {
          const r0 = Math.hypot(l.rest[u * 2] - l.rest[v * 2], l.rest[u * 2 + 1] - l.rest[v * 2 + 1]), r1 = Math.hypot(p[u * 2] - p[v * 2], p[u * 2 + 1] - p[v * 2 + 1]);
          if (!Number.isFinite(r1)) return [Infinity, Infinity];
          worst = Math.max(worst, r1 / r0); squeeze = Math.max(squeeze, r0 / Math.max(r1, 1e-6));
        }
      }
    }
    return [worst, squeeze];
  };
  const all = V.POSE_PRESETS.map((p) => stretch(p.pose));
  const worst = Math.max(...all.map((a) => a[0])), squeeze = Math.max(...all.map((a) => a[1]));
  check("全部姿勢預設下，布料最多只被拉長到 2 倍以內（不會扯成尖刺）", worst < 2, [worst, squeeze]);
  check("彎曲內側的布料摺疊在合理範圍內", squeeze < 15, squeeze);
  check("手臂舉到極限也不會出現無效座標", Number.isFinite(stretch({ shoulder_r: 95, elbow_r: -135, shoulder_l: -95, elbow_l: 135, torso: 12, chest: -10 })[0]));
  // 袖子確實跟隨手臂：袖口頂點在舉手後大幅移動，衣身不動
  const lift = R.solve(V.RIG_V2, { shoulder_l: -80 });
  const sl = rig.layers[2], pl = G.skinMesh(sl, lift), pb = G.skinMesh(body, lift);
  let cuff = 0;
  for (let k = 0; k < sl.rest.length / 2; k++) if (sl.rest[k * 2 + 1] > 800) cuff = Math.max(cuff, Math.hypot(pl[k * 2] - sl.rest[k * 2], pl[k * 2 + 1] - sl.rest[k * 2 + 1]));
  check("舉手時袖口跟隨手臂、衣身保持原位", cuff > 250 && pb.every((v, i) => Math.abs(v - body.rest[i]) < 0.01), cuff);
  // 逆向映射：變形後的畫面位置 → 圖片位置（遮罩筆刷、點選用）
  const posed = rig.layers.map((l) => G.skinMesh(l, lift));
  const vi = [...Array(sl.rest.length / 2).keys()].find((k) => sl.rest[k * 2 + 1] > 760 && sl.rest[k * 2] > 790 && sl.rest[k * 2] < 840);
  const hit = G.locate(rig, posed, pl[vi * 2] + 0.5, pl[vi * 2 + 1] + 0.5);
  check("舉手後點在袖口上 → 對應圖片上的袖口（不是胸口）", hit && Math.abs(hit[0] - sl.uv[vi * 2]) < 0.02 && Math.abs(hit[1] - sl.uv[vi * 2 + 1]) < 0.02, hit);
  check("袖子原本的位置（已移開）不再點到袖子", (() => { const h2 = G.locate(rig, posed, 810, 820); return !h2 || jacket.data[Math.floor(h2[1] * GH) * GW + Math.floor(h2[0] * GW)] === 0 || Math.abs(h2[0] * 1200 - 810) > 30; })());
  const b0 = G.posedBounds(rig, rig.layers.map((l) => l.rest)), b1 = G.posedBounds(rig, posed);
  check("選取範圍跟隨變形後的衣物", b1[2] > b0[2] + 100, [b0, b1]);
  // 完整衣物模式及人工部件
  const whole = G.buildRig(input(jacket, { parts: "whole" }));
  check("「整件衣物」：只有一層，跟隨軀幹，不拆袖", whole.layers.length === 1 && whole.info.mode === "body" && whole.info.source === "whole" && whole.layers[0].bones.map((b) => b.id).join() === "pelvis,torso,chest");
  const rigid = G.buildRig(input(jacket, { follow: "none" }));
  check("「整件不變形」：單一骨骼", rigid.layers.length === 1 && rigid.info.mode === "rigid" && rigid.layers[0].bones.length === 1);
  const manual = new Uint8Array(96 * 144);
  for (let j = 0; j < 144; j++) for (let i = 0; i < 96; i++) if (i * 12.5 < 460) manual[j * 96 + i] = 1;
  const mr = G.buildRig(input(jacket, { parts: { w: 96, h: 144, data: manual } }));
  check("人工標記的部件優先於自動分辨", mr.info.source === "manual" && mr.info.sleeve_r && !mr.info.sleeve_l && mr.layers.length === 2);
  const rot = G.buildRig(input(jacket, { sleeveRot: [20, -20] }));
  const r0 = rot.layers[1], pr = G.skinMesh(r0, rest);
  check("袖子靜止角度：袖口轉動、袖根保持連接", (() => { let far = 0, near = Infinity; for (let k = 0; k < r0.rest.length / 2; k++) { const d = Math.hypot(pr[k * 2] - r0.rest[k * 2], pr[k * 2 + 1] - r0.rest[k * 2 + 1]), fromS = Math.hypot(r0.rest[k * 2] - 477, r0.rest[k * 2 + 1] - 393); if (fromS < 28) near = Math.min(near, d); far = Math.max(far, d); } return far > 60 && near < 4; })());
  // 腿
  const socks = gridOf((x, y) => y > 1150 && y < 1700 && (Math.abs(x - 530) < 55 || Math.abs(x - 660) < 55));
  const lr = G.buildRig(input(socks, { kind: "legs", bone: "pelvis", loose: false }));
  check("襪：左右各自一塊，分別跟隨兩條腿", lr.layers.map((l) => l.part).join() === "3,4" && lr.info.legs, lr.layers.map((l) => l.part));
  const kick = R.solve(V.RIG_V2, { hip_l: -25 });
  const moved = lr.layers.map((l) => { const p = G.skinMesh(l, kick); let d = 0; for (let i = 0; i < p.length; i++) d = Math.max(d, Math.abs(p[i] - l.rest[i])); return d; });
  check("提起左腿：左襪跟隨，右襪不動", moved[0] < 0.01 && moved[1] > 80, moved);
  check("姿勢距離（提示姿勢校正用）", G.poseDistance({ shoulder_r: 40 }, { shoulder_r: 46 }) === 6 && G.poseDistance({}, { hp_x: 90 }) === 0);
  // 資料格式
  const f = D.normalizeFit({ cx: 600, cy: 500, w: 400, rotation: 0, sy: 1.25 });
  check("位置：高度可獨立拉伸，超出範圍被拒絕", f.sy === 1.25 && D.fitHeight(f, 1.5) === 750 && D.normalizeFit({ cx: 600, cy: 500, w: 400, sy: 5 }) === null && !("sy" in D.normalizeFit({ cx: 600, cy: 500, w: 400, sy: 1 })));
  const [iu, iv] = D.toImage(f, 1.5, ...D.fromImage(f, 1.5, 0.3, 0.8));
  check("圖片位置與畫布位置互相換算", Math.abs(iu - 0.3) < 1e-9 && Math.abs(iv - 0.8) < 1e-9);
  const o2 = D.normalizeOpts({ sleeve_r: 200, sleeve_l: "x" }, "top");
  check("袖子角度限制在 ±80°", o2.sleeve_r === 80 && !("sleeve_l" in o2));
  const t2 = D.normalizeTemplateData({ parts: "whole", sy: 1.2, variants: { p1: { name: "叉腰校正", parts: "data:image/png;base64,AAAA", pose: { shoulder_r: 30 } }, p2: { name: "x", parts: "javascript:1" } } }, "top");
  check("衣物預設保存部件圖、高度拉伸及姿勢校正", t2.parts === "whole" && t2.sy === 1.2 && t2.variants.p1.parts.startsWith("data:image/png") && t2.variants.p1.pose.shoulder_r === 30 && !("parts" in t2.variants.p2));
  const st2 = D.normalizeLookState({ items: [{ garment_id: "g1", slot: "top", parts: "auto" }, { garment_id: "g2", slot: "top", parts: "x" }] });
  check("造型內的個別部件設定", st2.items[0].parts === "auto" && !("parts" in st2.items[1]));
  // 遮罩快取識別碼：長度及結尾相同的不同遮罩不會被誤認
  const m1 = "data:image/png;base64," + "A".repeat(500) + "B" + "C".repeat(100), m2 = "data:image/png;base64," + "A".repeat(499) + "DB".slice(0, 2) + "C".repeat(100);
  check("不同遮罩有不同的快取識別碼", m1.length === m2.length && m1.slice(-32) === m2.slice(-32) && E.hashOf(m1) !== E.hashOf(m2) && E.hashOf(m1) === E.hashOf(m1.slice()));
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
