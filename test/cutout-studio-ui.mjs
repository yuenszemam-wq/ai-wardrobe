// Cutout Studio UI：開啟工作室、自動去背轉遮罩、Undo／Redo、擦除、魔術棒、套索、雙指縮放不誤擦、縮放後筆刷位置、
// 儲存（真正透明 PNG、原圖不變、縮圖、來源關聯）、重新開啟舊去背圖並從原圖還原、另存為新衣物（不重複儲存原圖）。
// 執行：node test/cutout-studio-ui.mjs（PW_BROWSER=webkit 可用 WebKit；桌面瀏覽器模擬手機，不等於 iPhone Safari／PWA 實機驗收）
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startApp, addGarment, checker, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("cutstudio");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `cutstudio-${n}.png`) });
const W = 600, H = 800;
// 900×1200 座標：白底；深色裙（x 250–650, y 300–1000）；裙上白色蝴蝶結（x 400–500, y 400–480，與背景同色但不相連）；
// 左下粉紅色手袋（x 60–200, y 900–1100）
await addGarment(env, {
  id: "gar_outfit", name: "完整穿搭", category: "完整穿搭", subcategory: "", w: W, h: H, opaque: true,
  svg: '<rect x="250" y="300" width="400" height="700" fill="#2a1f33"/><rect x="400" y="400" width="100" height="80" fill="#ffffff"/><rect x="60" y="900" width="140" height="200" fill="#f08cb4"/>',
});
const sx = (x) => (x / 900) * W, sy = (y) => (y / 1200) * H; // SVG 座標 → 圖片像素
const origRow = await env.DB.prepare("SELECT id, r2_key, sha256 FROM garment_images WHERE garment_id = 'gar_outfit' AND image_type = 'original'").first();
const sha = (b) => createHash("sha256").update(b).digest("hex");
const r2bytes = async (key) => env.IMAGES.objects.get(key).bytes;

/** 圖片座標 → 螢幕座標 */
async function screenOf(ix, iy) {
  return page.evaluate(([ix, iy]) => {
    const c = document.querySelector('[data-testid="cs-canvas"]');
    const [s, tx, ty] = c.dataset.view.split(",").map(Number);
    const r = c.getBoundingClientRect();
    return [r.left + tx + ix * s, r.top + ty + iy * s];
  }, [ix, iy]);
}
/** 畫布上某圖片座標的顯示顏色（背景預覽設為黑色時，透明＝黑） */
async function viewPixel(ix, iy) {
  return page.evaluate(([ix, iy]) => {
    const c = document.querySelector('[data-testid="cs-canvas"]');
    const [s, tx, ty] = c.dataset.view.split(",").map(Number);
    const k = c.width / c.getBoundingClientRect().width;
    return [...c.getContext("2d").getImageData(Math.round((tx + ix * s) * k), Math.round((ty + iy * s) * k), 1, 1).data];
  }, [ix, iy]);
}
const isBlack = (p) => p[0] < 20 && p[1] < 20 && p[2] < 20;
const isWhite = (p) => p[0] > 235 && p[1] > 235 && p[2] > 235;
const isPink = (p) => p[0] > 200 && p[1] < 170 && p[2] > 140;
const isDress = (p) => p[0] > 30 && p[0] < 60 && p[2] > 40 && p[2] < 70;
const maskVer = async () => Number(await page.getAttribute('[data-testid="cs-canvas"]', "data-mask-version")) || 0;
const settle = () => page.waitForTimeout(150);
async function stroke(points) {
  const [x0, y0] = await screenOf(...points[0]);
  await page.mouse.move(x0, y0); await page.mouse.down();
  for (const p of points.slice(1)) { const [x, y] = await screenOf(...p); await page.mouse.move(x, y, { steps: 3 }); }
  await page.mouse.up(); await settle();
}
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const tool = async (t) => { await page.click(`[data-tool="${t}"]`); await frames(); await settle(); };
const pointer = (type, id, x, y) => page.evaluate(([type, id, x, y]) => {
  document.querySelector('[data-testid="cs-canvas"]').dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true, isPrimary: id === 1, buttons: type === "pointerup" ? 0 : 1 }));
}, [type, id, x, y]);

try {
  await page.goto(A.base + "/g/gar_outfit");
  await page.waitForSelector('[data-testid="studio-start"]');
  console.log("開啟工作室");
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('[data-testid="studio-start"]').click(); });
  await page.waitForSelector('[data-testid="cutout-studio"]');
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="cs-canvas"]')?.dataset.maskVersion) > 0, null, { timeout: 15000 });
  check("工具列包含 9 個工具", (await page.locator("[data-tool]").count()) === 9);
  check("沒有顯示未實作的「智能選取」", (await page.getByText("智能選取").count()) === 0);
  await page.click('[data-bg="black"]');
  await settle();
  check("開始時背景未去除（白色）", isWhite(await viewPixel(sx(100), sy(150))), await viewPixel(sx(100), sy(150)));
  await shot("01-open");

  console.log("自動去背 → 可編輯遮罩");
  await tool("auto");
  await page.click('[data-testid="auto-run"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="cs-history"]')?.textContent?.startsWith("1"), null, { timeout: 15000 });
  await settle();
  check("自動去背：背景透明（黑色預覽）", isBlack(await viewPixel(sx(100), sy(150))), await viewPixel(sx(100), sy(150)));
  check("自動去背：裙上白色蝴蝶結保留", isWhite(await viewPixel(sx(450), sy(440))), await viewPixel(sx(450), sy(440)));
  check("自動去背：裙保留", isDress(await viewPixel(sx(450), sy(700))), await viewPixel(sx(450), sy(700)));
  await shot("02-auto");
  await page.click('[data-testid="cs-undo"]'); await settle();
  check("Undo：回到自動去背前", isWhite(await viewPixel(sx(100), sy(150))));
  await page.click('[data-testid="cs-redo"]'); await settle();
  check("Redo：再次套用", isBlack(await viewPixel(sx(100), sy(150))));

  console.log("背景預覽");
  await page.click('[data-bg="pink"]'); await settle();
  const pinkBg = await viewPixel(sx(100), sy(150));
  check("背景預覽切換為粉色", pinkBg[0] > 230 && pinkBg[1] > 180 && pinkBg[1] < 215, pinkBg);
  await page.click('[data-bg="black"]'); await settle();

  console.log("擦除及還原筆刷");
  await tool("erase");
  await page.fill('[data-testid="brush-size"]', "40");
  await stroke([[sx(300), sy(800)], [sx(600), sy(800)]]);
  check("擦除：筆畫經過的位置透明", isBlack(await viewPixel(sx(450), sy(800))), await viewPixel(sx(450), sy(800)));
  check("擦除：筆畫外不受影響", isDress(await viewPixel(sx(450), sy(900))));
  await tool("restore");
  await stroke([[sx(300), sy(800)], [sx(600), sy(800)]]);
  check("還原筆刷：從原圖恢復", isDress(await viewPixel(sx(450), sy(800))), await viewPixel(sx(450), sy(800)));

  console.log("魔術棒");
  await tool("wand");
  const [bx, by] = await screenOf(sx(130), sy(1000));
  await page.mouse.click(bx, by);
  await page.waitForSelector('[data-testid="selection-actions"]');
  check("點擊後先顯示選取範圍（未套用）", isPink(await viewPixel(sx(130), sy(1050))) || (await page.getAttribute('[data-testid="cs-canvas"]', "data-selection")) === "1");
  await page.click('[data-testid="sel-remove"]'); await settle();
  check("移除選取：手袋透明", isBlack(await viewPixel(sx(130), sy(1000))), await viewPixel(sx(130), sy(1000)));
  check("相連選取不影響裙", isDress(await viewPixel(sx(450), sy(700))));

  console.log("套索");
  await tool("lasso");
  await stroke([[sx(380), sy(380)], [sx(520), sy(380)], [sx(520), sy(500)], [sx(380), sy(500)], [sx(380), sy(390)]]);
  await page.waitForSelector('[data-testid="selection-actions"]');
  await page.click('[data-testid="sel-remove"]'); await settle();
  check("套索移除：蝴蝶結透明", isBlack(await viewPixel(sx(450), sy(440))), await viewPixel(sx(450), sy(440)));
  await page.click('[data-testid="cs-undo"]'); await settle();
  check("Undo 套索", isWhite(await viewPixel(sx(450), sy(440))));

  console.log("多邊形及矩形");
  await tool("polygon");
  for (const [x, y] of [[sx(270), sy(320)], [sx(420), sy(320)], [sx(420), sy(470)], [sx(270), sy(470)]]) { const [a, b] = await screenOf(x, y); await page.mouse.click(a, b); }
  check("多邊形節點計數", (await page.getByText("4 個節點").count()) === 1);
  await page.click('[data-testid="poly-undo"]');
  check("刪除最後節點", (await page.getByText("3 個節點").count()) === 1);
  await page.click('[data-testid="poly-close"]');
  await page.waitForSelector('[data-testid="selection-actions"]');
  await page.click('[data-testid="sel-cancel"]');
  await tool("rect");
  await stroke([[sx(560), sy(900)], [sx(640), sy(990)]]);
  await page.waitForSelector('[data-testid="selection-actions"]');
  await page.click('[data-testid="sel-invert"]');
  await page.click('[data-testid="sel-cancel"]');
  check("矩形選取、反轉、取消後遮罩不變", isDress(await viewPixel(sx(600), sy(950))));

  console.log("雙指縮放不誤擦");
  await tool("erase");
  const zoom0 = Number(await page.getAttribute('[data-testid="cs-canvas"]', "data-zoom"));
  const [p1x, p1y] = await screenOf(sx(420), sy(650));
  const [p2x, p2y] = await screenOf(sx(480), sy(750));
  await pointer("pointerdown", 1, p1x, p1y);
  await pointer("pointermove", 1, p1x + 6, p1y + 4);
  await pointer("pointerdown", 2, p2x, p2y);
  for (let i = 1; i <= 6; i++) { await pointer("pointermove", 1, p1x - i * 12, p1y - i * 12); await pointer("pointermove", 2, p2x + i * 12, p2y + i * 12); }
  await pointer("pointerup", 2, p2x + 72, p2y + 72);
  await pointer("pointerup", 1, p1x - 72, p1y - 72);
  await settle();
  const zoom1 = Number(await page.getAttribute('[data-testid="cs-canvas"]', "data-zoom"));
  check("雙指張開：畫面放大", zoom1 > zoom0 * 1.2, [zoom0, zoom1]);
  check("歷史沒有增加誤擦步驟", (await page.textContent('[data-testid="cs-history"]')).startsWith("4"), await page.textContent('[data-testid="cs-history"]'));
  const cb = await page.evaluate(() => { const r = document.querySelector('[data-testid="cs-canvas"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await page.mouse.move(cb[0], cb[1]);
  await page.mouse.wheel(0, -300); await settle();
  check("滑鼠滾輪縮放", Number(await page.getAttribute('[data-testid="cs-canvas"]', "data-zoom")) > zoom1, await page.getAttribute('[data-testid="cs-canvas"]', "data-zoom"));
  // 放大後在指定圖片座標擦一點，之後在輸出 PNG 檢查同一位置
  await page.click('[data-testid="cs-fit"]'); await settle();
  check("第一隻手指的筆畫已取消（沒有誤擦）", isDress(await viewPixel(sx(420), sy(650))), await viewPixel(sx(420), sy(650)));
  // 放大至 3 倍並以裙中心為中心
  await page.evaluate(() => { const c = document.querySelector('[data-testid="cs-canvas"]'); const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent("wheel", { deltaY: -700, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true })); });
  await settle();
  await page.fill('[data-testid="brush-size"]', "12");
  const target = [Math.round(sx(450)), Math.round(sy(600))];
  const [tx1, ty1] = await screenOf(...target);
  await stroke([target, [target[0] + 1, target[1]]]);
  await shot("03-zoomed-erase");
  await page.click('[data-testid="cs-fit"]');

  console.log("邊緣修正");
  await tool("edge");
  const before = await maskVer();
  await page.click('[data-testid="edge-feather"]');
  await page.waitForFunction((v) => Number(document.querySelector('[data-testid="cs-canvas"]').dataset.maskVersion) > v, before, { timeout: 15000 });
  check("邊緣柔化已套用（可復原）", (await page.textContent('[data-testid="cs-history"]')).startsWith("6"), await page.textContent('[data-testid="cs-history"]'));

  console.log("完成及儲存");
  await page.click('[data-testid="cs-done"]');
  await page.waitForSelector('[data-testid="cs-finish"]');
  check("完成頁顯示透明像素統計", /透明像素/.test(await page.textContent('[data-testid="finish-alpha"]')));
  await shot("04-finish");
  await page.click('[data-testid="finish-save"]');
  await page.waitForSelector('[data-testid="cutout-studio"]', { state: "detached", timeout: 15000 });
  const proc = await env.DB.prepare("SELECT * FROM garment_images WHERE garment_id = 'gar_outfit' AND image_type = 'processed'").first();
  check("新增去背圖（processed）", !!proc);
  check("去背圖 derived_from＝原圖", proc?.derived_from === origRow.id);
  check("去背圖記錄為有 alpha", Number(proc?.has_alpha) === 1);
  check("去背圖原解析度", proc?.width === W && proc?.height === H, [proc?.width, proc?.height]);
  const png = await r2bytes(proc.r2_key);
  const { data: px, info } = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => px[(Math.round(y) * info.width + Math.round(x)) * 4 + 3];
  check("輸出是 PNG", png[0] === 0x89 && png[1] === 0x50);
  check("輸出背景真正透明（alpha 0）", alphaAt(sx(100), sy(150)) === 0, alphaAt(sx(100), sy(150)));
  check("輸出衣服不透明", alphaAt(sx(450), sy(900)) === 255, alphaAt(sx(450), sy(900)));
  check("手袋已移除", alphaAt(sx(130), sy(1000)) === 0);
  check("放大後的筆刷位置準確（同一圖片座標透明）", alphaAt(...target) < 60, alphaAt(...target));
  check("背景預覽（黑色）沒有寫入輸出", px[(Math.round(sy(150)) * info.width + Math.round(sx(100))) * 4] !== 0 || alphaAt(sx(100), sy(150)) === 0);
  check("原圖 SHA-256 不變（R2）", sha(await r2bytes(origRow.r2_key)) === origRow.sha256);
  const thumb = await env.DB.prepare("SELECT id FROM garment_images WHERE derived_from = ? AND image_type = 'thumbnail'").bind(proc.id).first();
  const thumbD1 = await env.DB.prepare("SELECT image_id FROM garment_thumbnails WHERE image_id IN (SELECT id FROM garment_images WHERE derived_from = ?)").bind(proc.id).first().catch(() => null);
  check("產生對應縮圖", !!thumb || !!thumbD1);
  const edit = await env.DB.prepare("SELECT * FROM cutout_edits WHERE image_id = ?").bind(proc.id).first();
  check("cutout_edits 記錄來源原圖", edit?.source_image_id === origRow.id && edit?.source_sha256 === origRow.sha256, edit);
  check("cutout_edits 沒有保存圖片資料", !String(edit?.edit_summary || "").includes("base64") && String(edit?.edit_summary || "").length < 2000);

  console.log("重新開啟舊去背圖，從原圖還原");
  await page.reload();
  await page.waitForSelector('[data-testid="studio-start"]');
  // 衣物詳情預設顯示主圖（去背圖）
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('[data-testid="studio-start"]').click(); });
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="cs-canvas"]')?.dataset.maskVersion) > 0, null, { timeout: 15000 });
  check("提示從既有去背圖繼續編輯", /既有去背圖/.test(await page.textContent('[data-testid="cs-note"]')), await page.textContent('[data-testid="cs-note"]'));
  await page.click('[data-bg="black"]'); await settle();
  check("舊遮罩：手袋仍是透明", isBlack(await viewPixel(sx(130), sy(1000))));
  await tool("restore");
  await page.fill('[data-testid="brush-size"]', "120");
  await stroke([[sx(130), sy(950)], [sx(130), sy(1050)]]);
  check("還原筆刷從真正原圖恢復手袋", isPink(await viewPixel(sx(130), sy(1000))), await viewPixel(sx(130), sy(1000)));

  console.log("另存為新衣物（同一原圖拆多件）");
  // 只保留手袋：魔術棒選手袋 → 只保留選取
  await tool("wand");
  const [bx2, by2] = await screenOf(sx(130), sy(1000));
  await page.mouse.click(bx2, by2);
  await page.waitForSelector('[data-testid="selection-actions"]');
  await page.click('[data-testid="sel-keep"]'); await settle();
  check("只保留選取：裙被移除", isBlack(await viewPixel(sx(450), sy(700))));
  const nGar = (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n;
  const nOrig = (await env.DB.prepare("SELECT COUNT(*) AS n FROM garment_images WHERE image_type = 'original'").first()).n;
  await page.click('[data-testid="cs-done"]');
  await page.waitForSelector('[data-testid="cs-finish"]');
  await page.fill('[data-testid="finish-new-name"]', "粉紅手袋");
  await page.click('[data-testid="finish-new"]');
  await page.waitForSelector('[data-testid="cs-finish"]', { state: "detached", timeout: 15000 });
  check("另存後返回同一張原圖繼續編輯", await page.locator('[data-testid="cutout-studio"]').isVisible());
  const newG = await env.DB.prepare("SELECT * FROM garments WHERE name = '粉紅手袋'").first();
  check("新增一件待整理衣物", !!newG && newG.status === "review" && (await env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n === nGar + 1, newG);
  check("沒有重複儲存原圖", (await env.DB.prepare("SELECT COUNT(*) AS n FROM garment_images WHERE image_type = 'original'").first()).n === nOrig);
  const np = await env.DB.prepare("SELECT * FROM garment_images WHERE garment_id = ? AND image_type = 'processed'").bind(newG?.id).first();
  check("新衣物有獨立去背圖並設為主圖", !!np && Number(np.is_primary) === 1);
  const ne = await env.DB.prepare("SELECT * FROM cutout_edits WHERE image_id = ?").bind(np?.id).first();
  check("新衣物去背圖參照原本衣物的原圖", ne?.source_image_id === origRow.id, ne);
  const npng = await r2bytes(np.r2_key);
  const { data: npx, info: ni } = await sharp(Buffer.from(npng)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  check("新衣物 PNG：手袋保留、裙透明", npx[(Math.round(sy(1000)) * ni.width + Math.round(sx(130))) * 4 + 3] === 255 && npx[(Math.round(sy(700)) * ni.width + Math.round(sx(450))) * 4 + 3] === 0);
  check("原衣物去背圖未被覆寫", (await env.DB.prepare("SELECT COUNT(*) AS n FROM garment_images WHERE garment_id = 'gar_outfit' AND image_type = 'processed'").first()).n === 1);
  await shot("05-after-new");

  console.log("由拆出的衣物重新編輯：回到原本的原圖");
  await page.click('[data-testid="cs-cancel"]');
  await page.goto(A.base + `/g/${newG.id}`);
  await page.waitForSelector('[data-testid="studio-start"]');
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('[data-testid="studio-start"]').click(); });
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="cs-canvas"]')?.dataset.maskVersion) > 0, null, { timeout: 15000 });
  check("跨衣物來源：提示從既有去背圖繼續", /既有去背圖/.test(await page.textContent('[data-testid="cs-note"]')));
  await page.click('[data-bg="black"]'); await settle();
  await tool("restore");
  await page.fill('[data-testid="brush-size"]', "120");
  await stroke([[sx(450), sy(650)], [sx(450), sy(750)]]);
  check("可從原本的原圖還原裙的像素", isDress(await viewPixel(sx(450), sy(700))), await viewPixel(sx(450), sy(700)));
  await page.click('[data-testid="cs-cancel"]');

  console.log("創作工作室素材上傳：手動去背（圖片模式）");
  const oid = (await page.evaluate(async () => (await (await fetch("/api/outfits", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ai-wardrobe" }, body: JSON.stringify({ name: "素材測試", layers: [] }) })).json()).id));
  await page.goto(A.base + `/outfits/${oid}`);
  await page.waitForSelector('[data-tab="assets"]');
  await page.click('[data-tab="assets"]');
  const bagJpg = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#ffffff" } }).composite([{ input: Buffer.from('<svg width="400" height="300"><rect x="120" y="80" width="160" height="140" fill="#7a1f2b"/></svg>') }]).jpeg().toBuffer();
  await page.setInputFiles('[data-testid="asset-file"]', { name: "手袋.jpg", mimeType: "image/jpeg", buffer: bagJpg });
  await page.waitForSelector('[data-testid="asset-manual-cutout"]');
  await page.click('[data-testid="asset-manual-cutout"]');
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="cs-canvas"]')?.dataset.maskVersion) > 0, null, { timeout: 15000 });
  check("素材上傳可開啟 Cutout Studio（沒有測試 id 衝突）", (await page.locator('[data-testid="cs-canvas"]').count()) === 1);
  await tool("wand");
  const [wx, wy] = await screenOf(5, 5);
  await page.mouse.click(wx, wy);
  await page.waitForSelector('[data-testid="selection-actions"]');
  await page.click('[data-testid="sel-remove"]'); await settle();
  await page.click('[data-testid="cs-done"]');
  await page.waitForSelector('[data-testid="finish-use"]');
  await page.click('[data-testid="finish-use"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="asset-upload"]')?.dataset.cut === "done", null, { timeout: 10000 });
  check("手動去背結果回到素材上傳並顯示去背圖", (await page.getAttribute('[data-testid="asset-preview"]', "data-show")) === "cutout");

  console.log("權限");
  const anon = await fetch(`${A.base}/api/images/${np.id}`);
  check("未登入不能讀取去背圖", anon.status === 401 || anon.status === 403, anon.status);
  const anon2 = await fetch(`${A.base}/api/cutout-edits/${np.id}`);
  check("未登入不能讀取來源關聯", anon2.status === 401 || anon2.status === 403, anon2.status);
} catch (e) {
  console.error(e);
  check("測試沒有例外", false, String(e?.stack || e));
  await shot("error").catch(() => {});
} finally {
  done();
  await A.close?.();
  process.exit(process.exitCode || 0);
}
