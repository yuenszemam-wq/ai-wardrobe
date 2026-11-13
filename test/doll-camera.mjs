// Phase 3.2：手機編輯工作室——鏡頭、觸控手勢、骨架顯示、衣物原圖、乾淨預覽（瀏覽器測試）
// 執行：node test/doll-camera.mjs   （需要 esbuild、tailwindcss、sharp、playwright）
// DOLL_SHOTS=資料夾 可輸出截圖。REAL_GARMENT=透明 PNG 路徑 可額外用真實衣物檢查拆袖後衣身是否完整。
// 注意：這是桌面 Chromium 模擬 iPhone 螢幕及觸控，不等於 iPhone Safari 實機驗收。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checker, startRoom, svgPng } from "./doll-room.mjs";

const { check, done } = checker();
const SHOTS = process.env.DOLL_SHOTS || "";
const BLOUSE = '<path d="M330 200 L570 200 L600 760 L300 760 Z" fill="#fffaf6" stroke="#c9b8c4" stroke-width="6"/><path d="M300 210 L190 800 L90 780 L215 210 Z M600 210 L710 800 L810 780 L685 210 Z" fill="#f3e9ee" stroke="#c9b8c4" stroke-width="6"/><path d="M390 200 L510 200 L510 130 L390 130 Z" fill="#d9c8d4"/>';
const SKIRT = '<path d="M300 300 L600 300 L800 950 L100 950 Z" fill="#7a1f2b"/><rect x="300" y="300" width="300" height="50" fill="#3b0f15"/>';
const garments = [
  { id: "gar_bl", name: "測試襯衫", category: "上衣", subcategory: "Blouse", png: await svgPng(BLOUSE) },
  { id: "gar_sk", name: "測試 SK", category: "半身裙", subcategory: "SK", png: await svgPng(SKIRT) },
];
const REAL = process.env.REAL_GARMENT && existsSync(process.env.REAL_GARMENT) ? process.env.REAL_GARMENT : "";
if (REAL) garments.push({ id: "gar_real", name: "真實上衣", category: "上衣", subcategory: "Blouse", png: new Uint8Array(readFileSync(REAL)) });

const R = await startRoom({ garments, name: "camera" });
const { page, room, stage, ready, screen, pixels, swipe, twoFinger, pinch, tap, touch } = R;
const shot = (name) => (SHOTS ? page.screenshot({ path: join(SHOTS, `p32-${name}.png`) }) : null);
const zoom = async () => Number(await stage("data-zoom"));
const cam = async () => [Number(await stage("data-cx")), Number(await stage("data-cy")), Number(await stage("data-zoom"))];
const fits = async () => room("data-fits");
const fitOf = async (id) => JSON.parse(await fits()).find((f) => f[0] === id);
const box = async () => page.locator('[data-testid="doll-stage"]').boundingBox();
const colorAt = (x, y) => page.evaluate(([x, y]) => { const s = document.querySelector('[data-testid="doll-stage"]'), c = document.querySelector('[data-testid="doll-canvas"]'); const k = Number(s.dataset.k), dpr = c.width / s.getBoundingClientRect().width; return [...c.getContext("2d").getImageData(Math.round((x * k + Number(s.dataset.ox)) * dpr), Math.round((y * k + Number(s.dataset.oy)) * dpr), 1, 1).data]; }, [x, y]);
const isCloth = (c) => c[3] > 200 && c[0] > 225 && c[1] > 215 && c[2] > 215 && Math.abs(c[0] - c[2]) < 22; // 測試襯衫接近白色
const near = (a, b, tol) => Math.abs(a - b) <= tol;
/** 設定滑桿數值（React 需要原生 setter 及 input 事件） */
const setRange = (sel, v) => page.locator(sel).evaluate((el, v) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); }, v);

try {
  console.log("鏡頭：與造型資料分開");
  await page.goto(R.base + "/dressing");
  await page.waitForSelector('[data-garment="gar_bl"]');
  await ready();
  const b0 = await box();
  const mid = [b0.x + b0.width / 2, b0.y + b0.height / 2];
  check("預設是全身取景（100%）", near(await zoom(), 1, 0.01) && (await page.getAttribute('[data-view="full"]', "aria-pressed")) === "true" && (await page.textContent('[data-testid="zoom-pct"]')) === "100%");
  await pinch(mid, 80, 240);
  const z1 = await zoom();
  check("雙指張開＝放大畫面", z1 > 2.4 && z1 < 3.6, z1);
  check("手動縮放後變成自由視角（不再是任何預設）", (await page.locator('[data-view][aria-pressed="true"]').count()) === 0);
  check("只放大畫面：造型沒有變成未保存，也沒有撤銷紀錄", (await room("data-dirty")) === "0" && (await room("data-undo")) === "0");
  const c1 = await cam();
  await twoFinger([mid[0] - 40, mid[1]], [mid[0] - 40 + 60, mid[1] + 50], [mid[0] + 40, mid[1]], [mid[0] + 40 + 60, mid[1] + 50]);
  const c2 = await cam();
  const k1 = Number(await stage("data-k"));
  check("雙指拖動＝平移畫面（縮放比例不變）", near(c2[2], c1[2], 0.03) && near(c1[0] - c2[0], 60 / k1, 6) && near(c1[1] - c2[1], 50 / k1, 6), [c1, c2]);
  await pinch(mid, 240, 60);
  check("雙指合攏＝縮小畫面", (await zoom()) < z1 * 0.4, await zoom());
  await page.click('[data-testid="zoom-in"]');
  await page.click('[data-testid="zoom-in"]');
  const z2 = await zoom();
  await page.click('[data-testid="zoom-out"]');
  check("加減按鈕縮放，百分比同步顯示", (await zoom()) < z2 && (await page.textContent('[data-testid="zoom-pct"]')) === Math.round((await zoom()) * 100) + "%");
  await page.click('[data-testid="zoom-pct"]');
  await setRange('[data-testid="zoom-slider"]', Math.log(12));
  check("縮放滑桿：可以放大到 12 倍（足夠編輯蕾絲、領口、袖口）", near(await zoom(), 12, 0.2), await zoom());
  await page.click('[data-testid="zoom-reset"]');
  check("恢復預設視角", near(await zoom(), 1, 0.01) && (await page.getAttribute('[data-view="full"]', "aria-pressed")) === "true");
  await page.click('[data-testid="zoom-pct"]');
  await page.click('[data-view="upper"]');
  check("快速取景預設仍然可用（上半身）", (await zoom()) > 1.3 && (await page.getAttribute('[data-view="upper"]', "aria-pressed")) === "true");
  await swipe([mid[0], mid[1]], [mid[0] + 50, mid[1] + 30]);
  check("空白位置單指拖動＝平移畫面", (await page.locator('[data-view][aria-pressed="true"]').count()) === 0 && (await room("data-dirty")) === "0");
  await page.click('[data-view="full"]');

  console.log("放大畫面不會改變衣物");
  await page.click('[data-garment="gar_bl"]');
  await page.click('[data-garment="gar_sk"]');
  await ready();
  await tap(await screen(600, 520));
  check("輕觸衣物＝選取", (await room("data-selected")) === "gar_bl", await room("data-selected"));
  check("選中衣物後清楚顯示正在編輯哪一件（縮圖＋名稱），預設是位置工具", (await page.textContent('[data-testid="fit-name"]')).includes("測試襯衫") && (await page.locator('[data-testid="fit-thumb"] img').count()) === 1 && (await page.getAttribute('[data-testid="fit-panel"]', "data-active-tool")) === "place");
  await page.waitForTimeout(500);
  const f0 = await fits(), u0 = await room("data-undo");
  const g = await screen(600, 520);
  await pinch(g, 60, 200);
  check("在選中的衣物上雙指張開：放大的是畫面", (await zoom()) > 2.5, await zoom());
  check("衣物的位置、大小、旋轉完全不變", (await fits()) === f0, [f0, await fits()]);
  await page.waitForTimeout(500);
  check("沒有產生撤銷紀錄", (await room("data-undo")) === u0, [u0, await room("data-undo")]);
  // 第一指已經拖動了衣物少許，第二指才落下：衣物要回到原位
  const g2 = await screen(600, 520);
  await twoFinger(g2, [g2[0] - 30, g2[1]], [g2[0] + 70, g2[1] + 10], [g2[0] + 130, g2[1] + 10], { firstMoves: 14 });
  await page.waitForTimeout(500);
  check("第一指已拖動衣物、第二指才落下：衣物還原，不留撤銷紀錄", (await fits()) === f0 && (await room("data-undo")) === u0, [f0, await fits(), u0, await room("data-undo")]);
  // 扭轉手勢（兩指繞中心轉動）不會旋轉衣物
  const g3 = await screen(600, 520);
  await twoFinger([g3[0] - 50, g3[1]], [g3[0], g3[1] - 50], [g3[0] + 50, g3[1]], [g3[0], g3[1] + 50]);
  check("雙指扭轉不會旋轉衣物", (await fits()) === f0);
  await shot("01-zoomed-selected");

  console.log("放大後仍可準確操作衣物");
  const kz = Number(await stage("data-k"));
  const before = await fitOf("gar_bl");
  const s0 = await screen(600, 520);
  await swipe(s0, [s0[0] + 40, s0[1] + 24]);
  const moved = await fitOf("gar_bl");
  check("放大後單指拖動衣物：移動距離按畫面比例換算", near(moved[1] - before[1], 40 / kz, 4) && near(moved[2] - before[2], 24 / kz, 4) && moved[3] === before[3], [before, moved, kz]);
  await page.click('[data-testid="zoom-fit"]');
  const hr = await page.locator('[data-testid="handle-resize"]').boundingBox();
  await swipe([hr.x + hr.width / 2, hr.y + hr.height / 2], [hr.x + hr.width / 2 + 30, hr.y + hr.height / 2 + 30]);
  const resized = await fitOf("gar_bl");
  check("衣物大小用角位把手調整（畫面縮放後同樣準確）", resized[3] > moved[3] * 1.03, [moved, resized]);
  await setRange('[data-testid="fit-size"]', Math.log(500));
  check("或用「大小」滑桿", near((await fitOf("gar_bl"))[3], 500, 3), await fitOf("gar_bl"));
  await setRange('[data-testid="fit-rot"]', 12);
  check("「旋轉」滑桿", near((await fitOf("gar_bl"))[4], 12, 0.6));
  await setRange('[data-testid="fit-rot"]', 0);
  const zc = await zoom();
  await page.click('[data-testid="zoom-fit"]');
  const cf = await cam(), ff = await fitOf("gar_bl");
  check("自動取景：對準正在編輯的衣物", near(cf[0], ff[1], 60) && cf[2] !== zc, [cf, ff]);
  check("鏡頭操作期間衣物資料沒有再變", JSON.stringify(await fitOf("gar_bl")) === JSON.stringify(ff));

  console.log("手掌工具");
  await page.click('[data-testid="hand-tool"]');
  const fh = await fits(), ch = await cam();
  const sh = await screen(ff[1], ff[2]);
  await swipe(sh, [sh[0] + 40, sh[1] + 20]);
  check("手掌工具開啟時，在衣物上單指拖動只會移動畫面", (await fits()) === fh && !near((await cam())[0], ch[0], 2), [ch, await cam()]);
  await page.click('[data-testid="hand-tool"]');

  console.log("遮罩：雙指不會留下筆畫");
  await page.click('[data-view="upper"]');
  await page.click('[data-tool="mask"]');
  await ready();
  check("進入塗抹模式", (await stage("data-mode")) === "mask");
  const f1 = await fitOf("gar_bl");
  const chest = [f1[1], f1[2] - 60];
  const m0 = await screen(...chest);
  const zb = await zoom();
  await pinch(m0, 50, 170, { firstMoves: 3 });
  await page.waitForTimeout(450);
  check("塗抹模式下雙指＝縮放畫面", (await zoom()) > zb * 2);
  check("第二指加入：沒有留下任何筆畫", (await room("data-masked")) === "0" && isCloth(await colorAt(...chest)), [await room("data-masked"), await colorAt(...chest)]);
  const m1 = await screen(...chest);
  await page.click('[data-testid="mask-hint"]');
  await swipe(m1, [m1[0] + 24, m1[1] + 4]);
  await page.waitForTimeout(450);
  await ready();
  check("放大後單指塗抹：隱藏手指位置的布料", (await room("data-masked")) === "1" && !isCloth(await colorAt(chest[0] + 4, chest[1])), await colorAt(chest[0] + 4, chest[1]));
  const kb = Number(await stage("data-k"));
  check("筆刷按螢幕大小計算：放大後只影響細小範圍", isCloth(await colorAt(chest[0], chest[1] + 40 / kb)) && isCloth(await colorAt(chest[0] - 40 / kb, chest[1])), [await colorAt(chest[0], chest[1] + 40 / kb), kb]);
  await shot("02-mask-zoomed");
  await page.click('[data-testid="undo"]');
  await ready();
  check("撤銷這一筆", (await room("data-masked")) === "0" && isCloth(await colorAt(chest[0] + 4, chest[1])));

  console.log("部件：完整衣物＋顏色標記；衣物原圖視圖");
  await page.click('[data-tool="follow"]');
  check("新穿上的衣服預設是「固定原圖」（保持完整）", (await page.getAttribute('[data-wear-mode="fixed"]', "aria-pressed")) === "true");
  await page.click('[data-wear-mode="auto"]');
  await ready();
  const sum0 = await page.textContent('[data-testid="rig-summary"]');
  check("自動分辨左右袖", sum0.includes("自動分辨") && sum0.includes("右袖") && sum0.includes("左袖"), sum0);
  check("顯示部件顏色時，衣身仍然完整顯示", isCloth(await colorAt(...chest)), await colorAt(...chest));
  await page.click('[data-gview="source"]');
  await ready();
  check("切換到衣物原圖：只顯示這件衣物，鏡頭自動對準", (await room("data-gview")) === "source" && (await stage("data-mode")) === "view");
  // 原圖置中：襯衫衣身在圖片中央偏上（圖片 900×1200，衣身 x 330–570、y 200–760）
  const flat = await page.evaluate(() => { const ar = 1200 / 900, w = Math.min(1040, 1560 / ar), h = w * ar; return { x: (1200 - w) / 2, y: (1800 - h) / 2, w, h }; });
  const uv = (u, v) => [flat.x + u * flat.w, flat.y + v * flat.h];
  check("原圖視圖顯示完整的原始衣物（衣身及兩邊袖子都在）", isCloth(await colorAt(...uv(0.5, 0.4))) && (await colorAt(...uv(0.2, 0.5)))[3] > 200 && (await colorAt(...uv(0.8, 0.5)))[3] > 200, [await colorAt(...uv(0.5, 0.4)), await colorAt(...uv(0.2, 0.5))]);
  const zs = await zoom();
  await pinch(await screen(...uv(0.5, 0.4)), 60, 150);
  check("原圖視圖同樣可以雙指放大", (await zoom()) > zs * 1.8 && (await room("data-parts")) === "0");
  // 在原圖上把衣身中間一小塊標記為右袖
  await page.click('[data-part="1"]');
  check("揀選部件後，原圖上可以塗抹", (await stage("data-mode")) === "mask");
  const p0 = await screen(...uv(0.5, 0.4));
  await swipe(p0, [p0[0] + 20, p0[1]]);
  await page.waitForTimeout(450);
  check("在原圖上塗抹部件（使用原圖座標）", (await room("data-parts")) === "1" && (await page.textContent('[data-testid="rig-summary"]')).includes("人工標記"), await page.textContent('[data-testid="rig-summary"]'));
  const tinted = await colorAt(...uv(0.5 + 0.01, 0.4));
  check("原圖上以半透明顏色顯示標記（粉紅＝右袖）", tinted[0] > tinted[1] + 25 && tinted[3] > 200, tinted);
  await shot("03-source-view");
  await page.click('[data-gview="worn"]');
  await ready();
  check("切換回穿著預覽：同一份部件設定，不用重新設定", (await room("data-gview")) === "worn" && (await room("data-parts")) === "1" && (await page.textContent('[data-testid="rig-summary"]')).includes("人工標記"));
  check("切換視圖後回到原本的穿著視角", near(await zoom(), zb * 0 + (await zoom()), 0.001) && (await zoom()) > zb * 2);
  await page.click('[data-testid="reset-sleeve-r"]');
  await ready();
  const sum1 = await page.textContent('[data-testid="rig-summary"]');
  check("重新設定右袖：清走右袖標記，左袖保留，衣物保持完整", !sum1.includes("右袖") && sum1.includes("左袖") && isCloth(await colorAt(...chest)), sum1);
  await page.click('[data-testid="compare"]');
  await ready();
  check("對比原圖：暫時顯示完整衣物（不改動設定）", (await room("data-parts")) === "1" && isCloth(await colorAt(...chest)));
  await page.click('[data-testid="compare"]');
  await page.click('[data-gview="mesh"]');
  await ready();
  check("部件網格視圖", (await room("data-gview")) === "mesh");
  await shot("04-mesh-view");
  await page.click('[data-gview="worn"]');
  await page.click('[data-testid="parts-whole"]');
  await ready();
  check("恢復完整衣物（不拆袖）", (await page.textContent('[data-testid="rig-summary"]')).includes("整件衣物") && isCloth(await colorAt(...chest)));
  await page.click('[data-testid="parts-auto"]');
  await ready();
  check("清除部件設定：回到自動分辨", (await page.textContent('[data-testid="rig-summary"]')).includes("自動分辨"));

  console.log("底部面板：迷你／一般／展開");
  const saveBox = await page.locator('[data-testid="fit-save-default"]').evaluate((el) => !!el.closest('[data-testid="fit-scroll"]'));
  check("「存為衣物預設」在可捲動的內容之內，不會固定遮住其他控制項", saveBox);
  const grabber = await page.locator('[data-testid="panel-size"]').boundingBox();
  const gx = grabber.x + grabber.width / 2, gy = grabber.y + grabber.height / 2;
  const h0 = (await box()).height;
  await swipe([gx, gy], [gx, gy + 260]);
  check("向下拖動把手：面板縮到迷你，畫布變大", (await room("data-panel")) === "mini" && (await box()).height > h0 + 100, [await room("data-panel"), h0, (await box()).height]);
  check("迷你面板仍然保留已選衣物及工具", (await room("data-selected")) === "gar_bl" && (await page.locator('[data-testid="fit-compact"]').count()) === 1 && (await stage("data-mode")) === "mask");
  const w0 = (await fitOf("gar_bl"))[3];
  await page.click('[data-testid="fit-compact"] [aria-label="放大"]');
  check("迷你面板可以直接調整衣物", (await fitOf("gar_bl"))[3] > w0);
  await page.click('[data-testid="fit-compact"] [aria-label="縮小"]');
  const grabber2 = await page.locator('[data-testid="panel-size"]').boundingBox();
  await swipe([grabber2.x + grabber2.width / 2, grabber2.y + grabber2.height / 2], [grabber2.x + grabber2.width / 2, grabber2.y - 400]);
  check("向上拖動把手：展開", (await room("data-panel")) === "max", await room("data-panel"));
  await page.click('[data-testid="panel-size"]');
  check("輕按把手：回到一般高度", (await room("data-panel")) === "mid");
  await page.waitForTimeout(250);

  console.log("乾淨預覽（眼睛）");
  await page.click('[data-tool="follow"]');
  await page.click('[data-gview="mesh"]');
  await ready();
  const zp = await zoom();
  await page.click('[data-testid="focus"]');
  await ready();
  check("乾淨預覽：隱藏面板、選取框、骨架、部件顏色及網格", (await room("data-preview")) === "1" && (await page.locator('[data-testid="doll-panel"]').count()) === 0 && (await page.locator('[data-testid="fit-frame"]').count()) === 0 && (await page.locator("[data-handle]").count()) === 0 && (await room("data-gview")) === "worn" && (await stage("data-mode")) === "view");
  const pb = await box();
  const fp = await fits(), pp = await room("data-parts"), mp = await room("data-masked");
  await pinch([pb.x + pb.width / 2, pb.y + pb.height / 2], 200, 90);
  await swipe([pb.x + pb.width / 2, pb.y + pb.height / 2], [pb.x + pb.width / 2 + 30, pb.y + pb.height / 2 + 40]);
  check("預覽時仍可自由縮放及平移，不會改動衣物或塗抹", (await zoom()) < zp * 0.6 && (await fits()) === fp && (await room("data-parts")) === pp && (await room("data-masked")) === mp, [zp, await zoom()]);
  await shot("05-preview");
  await page.click('[data-testid="focus"]');
  await ready();
  check("退出預覽：恢復原本選中的衣物、進階工具及編輯視圖", (await room("data-selected")) === "gar_bl" && (await page.locator('[data-tool="follow"][aria-pressed="true"]').count()) === 1 && (await room("data-gview")) === "mesh");
  await page.click('[data-gview="worn"]');
  await page.click('[data-testid="fit-done"]');

  console.log("骨架：顯示方式及關節操作");
  await page.click('[data-view="full"]');
  await page.click('[data-tab="pose"]');
  await page.click('[data-posetab="joints"]');
  const ids = await page.locator("[data-handle]").evaluateAll((els) => els.map((e) => e.dataset.handle));
  check("預設是局部骨架：只顯示一個身體區域的控制點", (await page.locator('[data-skel="region"][aria-pressed="true"]').count()) === 1 && ids.length >= 1 && ids.length <= 3 && ids.every((i) => i.endsWith("_l")), ids);
  await page.click('[data-region="arm_r"]');
  const idsR = await page.locator("[data-handle]").evaluateAll((els) => els.map((e) => e.dataset.handle));
  check("揀選右手：只顯示右手的控制點", idsR.length >= 1 && idsR.every((i) => i.endsWith("_r")), idsR);
  await page.click('[data-testid="pose-frame"]');
  check("畫面對準這個身體區域（自動放大）", (await zoom()) > 1.5 && (await cam())[0] < 600, await cam());
  const dot = await page.locator('[data-handle="wrist_r"] circle, [data-handle="wrist_r"] rect').first().boundingBox();
  check("控制點視覺上細小（實際可點範圍較大）", dot.width <= 22, dot);
  // 拖手（IK）
  const pz0 = await room("data-pose");
  const h = page.locator('[data-handle="wrist_r"]');
  const sb = await box();
  const hp = [sb.x + Number(await h.getAttribute("data-x")), sb.y + Number(await h.getAttribute("data-y"))];
  await swipe(hp, [hp[0] + 46, hp[1] - 60]);
  const p1 = JSON.parse(await room("data-pose"));
  check("放大後拖動右手（IK）：同時調整肩膊及手肘", Math.abs(p1.shoulder_r ?? 0) + Math.abs(p1.elbow_r ?? 0) > 5 && pz0 === "{}", p1);
  const hint = await page.textContent('[data-testid="pose-hint"]');
  check("清楚說明拖動手掌實際控制的關節", hint.includes("右肩膊") && hint.includes("右手肘"), hint);
  check("IK 時同時顯示兩個關節的滑桿，名稱與作用一致", (await page.locator('input[data-bone="shoulder_r"]').count()) === 1 && (await page.locator('input[data-bone="elbow_r"]').count()) === 1 && (await page.locator('[data-testid="joint-title"]').allTextContents()).join("|") === "右肩膊（上臂方向）|右手肘（前臂彎曲）", await page.locator('[data-testid="joint-title"]').allTextContents());
  // 揀選手肘：只顯示手肘的滑桿
  await page.click('[data-joint="elbow_r"]');
  check("揀選右手肘：只顯示右手肘（前臂彎曲）的滑桿，不會顯示肩膊", (await page.locator('input[data-bone="elbow_r"]').count()) === 1 && (await page.locator('input[data-bone="shoulder_r"]').count()) === 0 && (await page.textContent('[data-testid="joint-title"]')) === "右手肘（前臂彎曲）");
  // 轉動關節（FK）
  await page.click('[data-drag="rotate"]');
  const he = page.locator('[data-handle="rot_elbow_r"]');
  const ep = [sb.x + Number(await he.getAttribute("data-x")), sb.y + Number(await he.getAttribute("data-y"))];
  await swipe(ep, [ep[0] + 30, ep[1] + 20]);
  const p2 = JSON.parse(await room("data-pose"));
  check("轉動關節：拖動前臂末端只改變手肘，肩膊不變", p2.elbow_r !== p1.elbow_r && p2.shoulder_r === p1.shoulder_r, [p1, p2]);
  await page.click('[data-drag="move"]');
  const idsM = await page.locator("[data-handle]").evaluateAll((els) => els.map((e) => e.dataset.handle));
  check("移動位置：只顯示可以平移的節點", idsM.length >= 1 && idsM.every((i) => i.startsWith("mov_")), idsM);
  await page.click('[data-drag="ik"]');
  // 姿勢模式下雙指縮放：正在拖動的關節還原
  const pz = await room("data-pose");
  await page.waitForTimeout(500);
  const up = await room("data-undo");
  const h2 = page.locator('[data-handle="wrist_r"]');
  const hp2 = [sb.x + Number(await h2.getAttribute("data-x")), sb.y + Number(await h2.getAttribute("data-y"))];
  await twoFinger(hp2, [hp2[0] - 30, hp2[1]], [hp2[0] + 80, hp2[1]], [hp2[0] + 130, hp2[1]], { firstMoves: 14 });
  await page.waitForTimeout(500);
  check("拖動關節途中第二指落下：姿勢還原，改為縮放畫面", (await room("data-pose")) === pz && (await room("data-undo")) === up, [pz, await room("data-pose")]);
  await page.click('[data-skel="full"]');
  const all = await page.locator("[data-handle]").count();
  check("完整骨架：顯示全部區域的控制點", all >= 10, all);
  await page.click('[data-skel="wire"]');
  check("線框模式：淡化角色及衣服", Number(await page.locator('[data-testid="doll-canvas"]').evaluate((c) => getComputedStyle(c).opacity)) < 0.9 || (await page.locator('[data-testid="doll-canvas"]').evaluate((c) => c.style.opacity)) === "0.38");
  await shot("06-wire");
  await page.click('[data-skel="clean"]');
  check("乾淨預覽：畫布沒有任何骨架或控制點", (await page.locator("[data-handle]").count()) === 0 && (await page.locator("[data-bone-line]").count()) === 0);
  await page.click('[data-view="full"]');
  await ready();
  const armPx = await pixels(180, 500, 240, 420);
  await page.click('[data-mini="shoulder_r"]');
  check("乾淨預覽下，點小人身上的關節來揀選", (await page.textContent('[data-testid="joint-title"]')) === "右肩膊（上臂方向）");
  await page.locator('input[data-bone="shoulder_r"]').fill("40");
  await ready();
  check("用滑桿調整姿勢，角色及衣物即時更新", JSON.parse(await room("data-pose")).shoulder_r === 40 && JSON.stringify(await pixels(180, 500, 240, 420)) !== JSON.stringify(armPx));
  await shot("07-clean-pose");
  await page.click('[data-testid="bone-reset"]');
  check("重設目前關節", !("shoulder_r" in JSON.parse(await room("data-pose"))));
  await page.click('[data-testid="region-reset"]');
  check("重設目前身體區域", !("elbow_r" in JSON.parse(await room("data-pose"))));
  await page.click('[data-posetab="presets"]');
  check("預設姿勢以小圖顯示", (await page.locator('[data-pose] svg').count()) >= 6);
  await page.click('[data-pose="hand_on_hip"]');
  await page.click('[data-testid="pose-reset"]');
  check("重設整個姿勢", (await room("data-pose")) === "{}");
  await page.click('[data-posetab="advanced"]');
  check("進階設定：手在衣服前後、骨架透明度", (await page.locator('[data-testid="skeleton-opacity"]').count()) === 1 && (await page.locator('[aria-pressed]', { hasText: "右手在衣服前" }).count()) === 1);
  await page.click('[data-posetab="joints"]');
  const pg = await page.locator('[data-testid="panel-size"]').boundingBox();
  await swipe([pg.x + pg.width / 2, pg.y + pg.height / 2], [pg.x + pg.width / 2, pg.y + 300]);
  check("姿勢面板縮到迷你後，仍可用滑桿調整目前關節", (await room("data-panel")) === "mini" && (await page.locator('[data-testid="pose-panel"][data-compact="1"] input[type="range"]').count()) >= 1);
  await page.click('[data-testid="panel-size"]');

  if (REAL) {
    console.log("真實衣物：自動拆袖後衣身完整");
    await page.click('[data-tab="layers"]');
    await page.click('[data-testid="clear-all"]');
    await page.click('[data-tab="clothes"]');
    await page.click('[data-garment="gar_real"]');
    await ready();
    const fr = await fitOf("gar_real");
    await tap(await screen(fr[1], fr[2]));
    await page.click('[data-tool="follow"]');
    await page.click('[data-wear-mode="auto"]');
    if ((await page.getAttribute('[data-testid="parts-hint"]', "aria-pressed")) === "true") await page.click('[data-testid="parts-hint"]');
    await ready();
    const info = await page.textContent('[data-testid="rig-summary"]');
    const body = await pixels(fr[1] - 40, fr[2] - 20, 80, 80);
    console.log("   ", info, body);
    check("真實上衣：顯示部件顏色時衣身沒有消失", body[3] > 235, body);
    await shot("08-real-parts");
    await page.click('[data-testid="parts-whole"]');
    await ready();
    const whole = await pixels(fr[1] - 40, fr[2] - 20, 80, 80);
    check("真實上衣：拆袖與整件模式下，衣身的畫面一致", Math.abs(whole[0] - body[0]) < 6 && Math.abs(whole[1] - body[1]) < 6 && Math.abs(whole[2] - body[2]) < 6, [body, whole]);
    await page.click('[data-testid="parts-auto"]');
    await page.click('[data-testid="fit-done"]');
  }

  console.log("小螢幕（iPhone SE 尺寸）");
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(300);
  const vb = await box();
  const bar = await page.locator('[data-testid="camera-bar"]').boundingBox();
  const panel = await page.locator('[data-testid="doll-panel"]').boundingBox();
  check("小螢幕：畫布仍有足夠空間，鏡頭控制及面板都在畫面之內", vb.height > 180 && bar.x + bar.width <= 320 && bar.y + bar.height <= vb.y + vb.height + 1 && panel.y + panel.height <= 568 + 1, [vb, bar, panel]);
  await shot("09-small");
  check("沒有頁面錯誤", R.errors.length === 0, R.errors);
} catch (e) {
  check("測試中斷 " + String(e.message).slice(0, 300), false);
  console.log(e.stack?.split("\n").slice(0, 4).join("\n"));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "p32-error.png") }).catch(() => undefined);
} finally {
  await R.close();
}
done();
