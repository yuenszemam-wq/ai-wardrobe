// Phase 3.7：蒙皮進階評估（實驗性雙四元數混合）。同一件外套網格、全部姿勢預設：如實輸出線性混合（LBS）與雙四元數的
// 收縮、拉長及面積偏差（作為評估數據，不假設哪一種較好）；並驗證正確性：靜止姿勢不變、單一骨骼結果相同、
// 有縮放的骨骼退回線性、沒有無效數值、沒有極端拉長；預設仍為線性（畫面與以前相同）。
// 執行：node test/phase37.mjs
import { buildModule } from "./doll-build.mjs";
import { checker } from "./p38-setup.mjs";

const { check, done } = checker();
const G = await buildModule("shared/garmentMesh.ts", "p37-g");
const R = await buildModule("shared/avatarRig.ts", "p37-r");
const V = await buildModule("shared/avatarV2.ts", "p37-v");
// 與 doll-logic 相同的外套（衣身＋兩袖）
const W = 90, Hh = 120, data = new Uint8Array(W * Hh);
for (let j = 8; j < 112; j++) for (let i = 0; i < W; i++) { const body = i >= 25 && i < 65 && j < 100, sleeveR = i < 25 && j < 70 && i > 25 - (j - 8) * 0.5, sleeveL = i >= 65 && j < 70 && i < 65 + (j - 8) * 0.5; if (body || sleeveR || sleeveL) data[j * W + i] = 255; }
const grid = { w: W, h: Hh, data };
const fit = { cx: 600, cy: 640, w: 640, rotation: 0 };
let rig;
try { rig = G.buildRig({ grid, fit, ar: Hh / W, kind: "upper", follow: "full" }); } catch (e) { rig = null; console.log("buildRig", String(e)); }
try {
  check("建立外套網格（衣身＋袖子）", !!rig && rig.layers.length >= 2, rig?.layers?.length);
  const measure = (pose, blend) => {
    const mats = R.solve(V.RIG_V2, pose);
    let worst = 0, squeeze = 0, area = 0;
    for (const l of rig.layers) {
      const p = G.skinMesh(l, mats, G.boneMatrices(l, mats), blend);
      for (const k of l.order) {
        const [a, b, c, d] = G.cellVerts(l, k);
        for (const [u, v] of [[a, b], [a, c], [b, d], [c, d]]) {
          const r0 = Math.hypot(l.rest[u * 2] - l.rest[v * 2], l.rest[u * 2 + 1] - l.rest[v * 2 + 1]), r1 = Math.hypot(p[u * 2] - p[v * 2], p[u * 2 + 1] - p[v * 2 + 1]);
          worst = Math.max(worst, r1 / r0); squeeze = Math.max(squeeze, r0 / Math.max(r1, 1e-6));
        }
        // 每格面積比例（偏離 1 的程度）
        const tri = (P, i, j, k2) => Math.abs((P[j * 2] - P[i * 2]) * (P[k2 * 2 + 1] - P[i * 2 + 1]) - (P[k2 * 2] - P[i * 2]) * (P[j * 2 + 1] - P[i * 2 + 1])) / 2;
        const a0 = tri(l.rest, a, b, c) + tri(l.rest, b, d, c), a1 = tri(p, a, b, c) + tri(p, b, d, c);
        if (a0 > 1e-6) area += Math.abs(Math.log(Math.max(a1, 1e-6) / a0));
      }
    }
    return { worst, squeeze, area };
  };
  const rows = V.POSE_PRESETS.map((p) => ({ id: p.id, lbs: measure(p.pose, "linear"), dq: measure(p.pose, "dq") }));
  console.log("  姿勢｜收縮 LBS→新｜拉長 LBS→新");
  for (const r of rows) console.log(`  ${r.id}｜${r.lbs.squeeze.toFixed(2)}→${r.dq.squeeze.toFixed(2)}｜${r.lbs.worst.toFixed(2)}→${r.dq.worst.toFixed(2)}`);
  const sumA = (k) => rows.reduce((s, r) => s + r[k].area, 0);
  console.log(`  面積偏差總和：LBS ${sumA("lbs").toFixed(1)}｜雙四元數 ${sumA("dq").toFixed(1)}`);
  check("雙四元數：所有數值有效、沒有極端拉長（< 3 倍）", rows.every((r) => Number.isFinite(r.dq.worst) && r.dq.worst < 3 && r.dq.squeeze < 20), rows.map((r) => [r.id, +r.dq.worst.toFixed(2)]));
  const rest = R.solve(V.RIG_V2, {});
  check("靜止姿勢：網格位置完全不變", rig.layers.every((l) => G.skinMesh(l, rest, G.boneMatrices(l, rest), "dq").every((v, i) => Math.abs(v - l.rest[i]) < 1e-3)));
  // 單一骨骼：兩種混合結果相同
  const one = { ...rig.layers[0], bones: [{ id: "chest", pre: null }], weights: new Float32Array(rig.layers[0].rest.length / 2).fill(1) };
  const mats = R.solve(V.RIG_V2, V.POSE_PRESETS.find((p) => p.id === "hand_on_hip").pose);
  const a1 = G.skinMesh(one, mats, G.boneMatrices(one, mats), "dq"), a2 = G.skinMesh(one, mats, G.boneMatrices(one, mats), "linear");
  check("只有一節骨骼時兩種方式結果相同", a1.every((v, i) => Math.abs(v - a2[i]) < 1e-3));
  // 有縮放的骨骼：退回線性
  const scaled = { chest: [1.3, 0, 0, 1.3, -10, 5], shoulder_r: [1.3, 0, 0, 1.3, -10, 5], elbow_r: [1.3, 0, 0, 1.3, -10, 5], root: [1, 0, 0, 1, 0, 0] };
  const sl = rig.layers[1];
  const b1 = G.skinMesh(sl, scaled, G.boneMatrices(sl, scaled), "dq"), b2 = G.skinMesh(sl, scaled, G.boneMatrices(sl, scaled), "linear");
  check("骨骼有縮放：自動退回線性結果（自訂身體不受影響）", b1.every((v, i) => Math.abs(v - b2[i]) < 1e-3));
  check("預設仍為線性混合（評估結果未有一致改善，畫面與以前相同）", G.skinBlend() === "linear");
} catch (e) { console.error(e); check("未預期錯誤", false, String(e)); }
done();
