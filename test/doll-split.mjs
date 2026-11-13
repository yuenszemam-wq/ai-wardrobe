// Phase 3.3：套裝拆件（瀏覽器測試）。自動拆出分開的部件、手動選取、穿上全部部件、單獨脫下、保存及重新開啟。
// 執行：node test/doll-split.mjs   REAL_SET=透明 PNG 路徑 可額外用真實套裝圖檢查自動拆件。
// 注意：桌面 Chromium 模擬 iPhone 螢幕及觸控，不等於 iPhone Safari 實機驗收。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checker, startRoom, svgPng } from "./doll-room.mjs";

const { check, done } = checker();
const SHOTS = process.env.DOLL_SHOTS || "";
// 套裝：連身裙在中間，左右袖套、頸飾、頭飾各自分開（透明位置分隔）
const SET = '<path d="M330 330 L570 330 L700 1100 L200 1100 Z" fill="#8a1c2c"/><rect x="60" y="420" width="90" height="380" rx="30" fill="#1b1b1b"/><rect x="750" y="420" width="90" height="380" rx="30" fill="#1b1b1b"/><rect x="380" y="230" width="140" height="45" rx="20" fill="#2b2b2b"/><path d="M300 60 Q450 -10 600 60 L600 140 Q450 90 300 140 Z" fill="#3a3a3a"/>';
const REAL = process.env.REAL_SET && existsSync(process.env.REAL_SET) ? process.env.REAL_SET : "";
const garments = [{ id: "gar_set", name: "測試女僕套裝", category: "套裝", subcategory: "多件套", png: await svgPng(SET, 900, 1200) }];
if (REAL) garments.push({ id: "gar_real", name: "真實套裝", category: "套裝", subcategory: "多件套", png: new Uint8Array(readFileSync(REAL)) });
const R = await startRoom({ garments, name: "split" });
const { page, env, room, ready, screen, pixels, tap } = R;
const shot = (n) => (SHOTS ? page.screenshot({ path: join(SHOTS, `p33-${n}.png`) }) : null);
const fitOf = async (k) => JSON.parse(await room("data-fits")).find((f) => f[0] === k);
const solid = (px) => px[3] > 200;

async function openSplit(gid) {
  const f = await fitOf(gid);
  await tap(await screen(f[1], f[2]));
  await page.click('[data-tool="wear"]');
  await page.click('[data-testid="open-split"]');
  await page.waitForSelector('[data-testid="split-editor"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="split-stage"]')?.dataset.k);
}

try {
  await page.goto(R.base + "/dressing");
  await page.waitForSelector('[data-garment="gar_set"]');
  const n0 = (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n;
  await page.click('[data-garment="gar_set"]');
  await ready();
  const setFit = await fitOf("gar_set");
  // 套裝圖 900×1200：袖套中心約 (105/900, 610/1200)
  const at = (u, v) => [setFit[1] + (u - 0.5) * setFit[3], setFit[2] + (v - 0.5) * setFit[3] * (1200 / 900)];
  const glove = at(105 / 900, 610 / 1200), dress = at(0.5, 700 / 1200);
  check("整件套裝：袖套及連身裙都在", solid(await pixels(...glove, 10, 10)) && solid(await pixels(...dress, 10, 10)));

  console.log("拆件編輯器：自動拆出分開的部件");
  await openSplit("gar_set");
  await page.click('[data-testid="split-auto"]');
  const names = await page.locator("[data-piece]").allTextContents();
  check("自動找出 4 個分開的部件，另加「其餘部分」（主體）", names.length === 5 && names.some((t) => t.includes("袖套")) && names.some((t) => t.includes("頭飾")) && names.some((t) => t.includes("主體")), names);
  await shot("01-split-auto");
  // 改名及分類
  await page.locator("[data-piece]").first().click();
  await page.fill('[data-testid="split-name"]', "測試部件");
  // 手動：新部件用方形選取連身裙下擺（只會選到布料）
  await page.click('[data-testid="split-add"]');
  await page.click('[data-split-tool="rect"]');
  const st = await page.locator('[data-testid="split-stage"]').boundingBox();
  const k = Number(await page.getAttribute('[data-testid="split-stage"]', "data-k")), ox = Number(await page.getAttribute('[data-testid="split-stage"]', "data-ox")), oy = Number(await page.getAttribute('[data-testid="split-stage"]', "data-oy"));
  const gw = await page.evaluate(() => 0); void gw;
  // 遮罩格長邊 480 → 900×1200 圖的格為 360×480；換算：圖片像素 × 0.4
  const g = (x, y) => [st.x + ox + x * 0.4 * k, st.y + oy + y * 0.4 * k];
  await page.mouse.move(...g(150, 1000)); await page.mouse.down(); await page.mouse.move(...g(500, 1050), { steps: 5 }); await page.mouse.move(...g(750, 1150), { steps: 5 }); await page.mouse.up();
  check("方形選取：新部件出現", (await page.locator("[data-piece]").count()) === 6);
  await page.click('[data-testid="split-save"]');
  await page.waitForSelector('[data-testid="split-editor"]', { state: "detached", timeout: 20000 });
  const tpl = JSON.parse((await env.DB.prepare("SELECT data FROM doll_fit_templates WHERE garment_id='gar_set' AND avatar_id='avatar_v2'").first()).data);
  check("部件保存到套裝的穿著設定（原圖不變、沒有新增衣物）", tpl.pieces?.length === 6 && tpl.pieces.filter((p) => p.mask).length === 5 && tpl.pieces.some((p) => p.rest) && (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n === n0, tpl.pieces?.map((p) => [p.name, p.box]));

  console.log("穿上部件");
  await ready();
  await page.click('[data-testid="wear-all-pieces"]');
  await page.waitForFunction(() => { const r = document.querySelector('[data-testid="dressing-room"]'); return r && (r.dataset.worn || "").split(",").filter((x) => x.includes("#pc_")).length === 6 && r.dataset.resolved === "6"; }, null, { timeout: 30000 });
  await ready();
  const worn = (await room("data-worn")).split(",");
  check("改為穿上全部部件：6 個部件，整件套裝已脫下", worn.length === 6 && worn.every((w) => w.startsWith("gar_set#pc_")), worn);
  check("部件留在套裝原本的位置（袖套、連身裙位置不變）", solid(await pixels(...glove, 10, 10)) && solid(await pixels(...dress, 10, 10)));
  await shot("02-pieces-worn");
  // 單獨脫下右袖套
  const gloveKey = "gar_set#" + tpl.pieces.find((p) => p.box && !p.rest && p.box[0] < 105 / 900 && p.box[2] > 105 / 900 && p.box[1] < 0.5 && p.box[3] > 0.5).id;
  await page.click('[data-tab="layers"]');
  await page.click(`[data-layer="${gloveKey}"] [aria-label="脫下"]`);
  await ready();
  check("單獨脫下右袖套：袖套消失，連身裙保留", !solid(await pixels(...glove, 10, 10)) && solid(await pixels(...dress, 10, 10)) && (await room("data-worn")).split(",").length === 5);
  // 單獨移動頭飾，其他部件不動
  const head = tpl.pieces.find((p) => !p.rest && p.box[3] < 0.15);
  const hk = "gar_set#" + head.id, hf0 = await fitOf(hk), df0 = await fitOf("gar_set#" + tpl.pieces.find((p) => p.rest).id);
  await page.click(`[data-layer="${hk}"] button:nth-of-type(2)`);
  await page.click('[data-testid="fit-panel"] [aria-label="向上微調"]');
  check("每個部件可以獨立調整（只移動頭飾）", (await fitOf(hk))[2] < hf0[2] && JSON.stringify(await fitOf("gar_set#" + tpl.pieces.find((p) => p.rest).id)) === JSON.stringify(df0));
  await page.click('[data-tool="wear"]');
  check("部件說明：不是另一件衣物", (await page.locator('[data-testid="piece-info"]').count()) === 1);
  await page.click('[data-testid="fit-save-default"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="fit-from"]')?.textContent.includes("衣物預設"));
  const tpl2 = JSON.parse((await env.DB.prepare("SELECT data FROM doll_fit_templates WHERE garment_id='gar_set' AND avatar_id='avatar_v2'").first()).data);
  check("部件的預設位置存回套裝拆件設定", !!tpl2.pieces.find((p) => p.id === head.id)?.fit);
  await page.click('[data-testid="fit-done"]');

  console.log("保存及重新開啟");
  await page.fill('[data-testid="look-name"]', "拆件測試");
  await page.click('[data-testid="save-look"]');
  await page.waitForFunction(() => /\/dressing\/look_/.test(location.pathname), null, { timeout: 20000 });
  const look = await env.DB.prepare("SELECT id, state FROM doll_looks ORDER BY created_at DESC LIMIT 1").first();
  const st2 = JSON.parse(look.state);
  check("造型保存部件及部件設定快照", st2.items.length === 5 && st2.items.every((i) => i.piece && i.piece_def?.id === i.piece));
  check("造型索引每件衣物只記一次", (await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_look_items WHERE look_id = ?").bind(look.id).first()).n === 1);
  await page.goto(R.base + "/dressing/" + look.id);
  await page.waitForFunction(() => document.querySelector('[data-testid="dressing-room"]')?.dataset.resolved === "5", null, { timeout: 30000 });
  await ready();
  check("重新開啟：部件全部回來，右袖套仍然脫下", (await room("data-worn")).split(",").length === 5 && !solid(await pixels(...glove, 10, 10)) && solid(await pixels(...dress, 10, 10)));
  await shot("03-reopened");

  if (REAL) {
    console.log("真實套裝：自動拆件");
    await page.goto(R.base + "/dressing");
    await page.waitForSelector('[data-garment="gar_real"]');
    await page.click('[data-garment="gar_real"]');
    await ready();
    await openSplit("gar_real");
    await page.click('[data-testid="split-auto"]');
    const rn = await page.locator("[data-piece]").allTextContents();
    console.log("    ", rn.join("｜"));
    check("真實套裝：自動拆出頭飾、頸飾、左右袖套及主體", rn.length >= 5 && rn.filter((t) => t.includes("袖套")).length === 2 && rn.some((t) => t.includes("頭飾")) && rn.some((t) => t.includes("頸飾")), rn);
    await shot("04-real-split");
    await page.click('[data-testid="split-save"]');
    await page.waitForSelector('[data-testid="split-editor"]', { state: "detached", timeout: 20000 });
    await ready();
    await page.click('[data-testid="wear-all-pieces"]');
    await page.waitForFunction(() => { const r = document.querySelector('[data-testid="dressing-room"]'); return r && (r.dataset.worn || "").split(",").filter((x) => x.includes("gar_real#")).length >= 5 && Number(r.dataset.resolved) >= 5; }, null, { timeout: 40000 });
    await ready();
    await shot("05-real-pieces");
  }
  check("沒有頁面錯誤", R.errors.length === 0, R.errors);
} catch (e) {
  check("測試中斷 " + String(e.message).slice(0, 300), false);
  console.log(e.stack?.split("\n").slice(0, 4).join("\n"));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "p33-error.png") }).catch(() => undefined);
} finally {
  await R.close();
}
done();
