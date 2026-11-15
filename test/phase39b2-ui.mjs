// Phase 3.9B.2 UI：匯出衣物套件（去背圖＋衣服設定）及角色髮型套件 → 在「朋友的部署」（另一個全新資料庫）匯入 → 獨立副本
// （新 ID、圖片、衣服設定、髮型檔案引用換成新檔案）；被修改的套件及惡意套件被拒絕且沒有寫入任何資料。
// 執行：node test/phase39b2-ui.mjs（桌面 Chromium 模擬 iPhone；不等於 iPhone 實機）
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, addGarment, checker, sharp } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p39b2a");
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const api = (page, method, path, body, ct) => page.evaluate(async ([method, path, body, ct]) => { const r = await fetch(path, { method, headers: { "x-requested-with": "ai-wardrobe", "content-type": ct || "application/json" }, body: body == null ? undefined : ct ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, path, body, ct]);
await addGarment(A.env, { id: "gar_jsk", name: "紫色 JSK", category: "連身裙", subcategory: "JSK", svg: '<rect x="200" y="300" width="500" height="800" fill="#5b2491"/>', price: 1280 });
await A.env.DB.prepare("UPDATE garments SET brand = 'AP', notes = '私人備註' WHERE id = 'gar_jsk'").run();
const hairPng = (await sharp({ create: { width: 300, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from('<svg width="300" height="400"><rect x="50" y="20" width="200" height="360" fill="#644950"/></svg>') }]).png().toBuffer()).toString("base64");
let file1, file2;
try {
  const page = A.page;
  await page.goto(A.base + "/"); await page.waitForSelector('[data-testid="tab-add"]'); await page.waitForTimeout(600);
  const img = (await A.env.DB.prepare("SELECT id FROM garment_images WHERE garment_id = 'gar_jsk' AND image_type = 'processed'").first()).id;
  let r = await api(page, "PUT", "/api/doll/templates/gar_jsk", { fit: { cx: 600, cy: 700, w: 520, rotation: 0 }, slot: "dress", image_id: img, data: { opts: { follow: "upper", neck: true } } });
  check("準備：衣服設定", r.status === 200, r.body);
  const hair = (await api(page, "POST", "/api/doll/assets", { kind: "hair", name: "長直髮", category: "長髮" })).body;
  const f = (await api(page, "POST", `/api/doll/assets/${hair.id}/files`, hairPng, "image/png")).body;
  await api(page, "PATCH", `/api/doll/assets/${hair.id}`, { config: { parts: [{ id: "back", label: "後髮", file: f.ref, layer: "back", x: 300, y: 0, w: 600, h: 800 }] } });

  console.log("匯出");
  await page.evaluate(() => { navigator.canShare = () => false; });
  await page.goto(A.base + "/settings/packages");
  await page.waitForSelector('[data-pkg-pick="gar_jsk"]');
  await page.click('[data-pkg-pick="gar_jsk"]');
  let dl = page.waitForEvent("download");
  await page.click('[data-testid="pkg-export-run"]');
  file1 = join(A.TMP, "garments.awpkg.zip"); await (await dl).saveAs(file1);
  check("匯出衣物套件（ZIP）", readFileSync(file1).subarray(0, 2).toString() === "PK");
  const text = readFileSync(file1).toString("latin1");
  check("預設不包含價格及備註", !text.includes("私人備註") && !text.includes("1280"));
  await page.click('[data-pkg-tab="character"]');
  await page.click(`[data-pkg-asset="${hair.id}"] input`);
  dl = page.waitForEvent("download");
  await page.click('[data-testid="pkg-character-run"]');
  file2 = join(A.TMP, "hair.awpkg.zip"); await (await dl).saveAs(file2);
  check("匯出角色髮型套件", readFileSync(file2).subarray(0, 2).toString() === "PK");
  await A.close();
} catch (e) { console.error(e); check("未預期錯誤（匯出）", false, String(e?.stack || e)); await A.close().catch(() => undefined); }

// 朋友的部署：全新資料庫
const B = await startApp("p39b2b");
try {
  const page = B.page;
  await page.goto(B.base + "/"); await page.waitForSelector('[data-testid="tab-add"]'); await page.waitForTimeout(500);
  await page.goto(B.base + "/settings/packages");
  await page.click('[data-pkg-tab="import"]');
  console.log("惡意及被修改的套件");
  const tampered = Buffer.from(readFileSync(file1)); tampered[tampered.length - 200] ^= 0xff;
  const tp = join(B.TMP, "tampered.zip"); writeFileSync(tp, tampered);
  await page.setInputFiles('[data-testid="pkg-file"]', tp);
  await page.waitForSelector('[data-testid="pkg-error"]', { timeout: 8000 });
  check("被修改的套件：驗證失敗，沒有寫入任何資料", (await B.env.DB.prepare("SELECT COUNT(*) AS n FROM garments").first()).n === 0);
  await page.setInputFiles('[data-testid="pkg-file"]', { name: "x.zip", mimeType: "application/zip", buffer: Buffer.from("not a zip at all") });
  await page.waitForFunction(() => /不是有效/.test(document.querySelector('[data-testid="pkg-error"]')?.textContent || ""), null, { timeout: 8000 }).catch(() => undefined);
  check("不是 ZIP：明確錯誤", /不是有效/.test(await page.textContent('[data-testid="pkg-error"]')));

  console.log("匯入衣物套件");
  await page.setInputFiles('[data-testid="pkg-file"]', file1);
  await page.waitForSelector('[data-testid="pkg-preview"]', { timeout: 10000 });
  check("預覽：1 件衣物、Avatar V2 設定可直接套用", (await page.textContent('[data-testid="pkg-preview"]')).includes("1 件衣物") && (await page.textContent('[data-testid="pkg-compat"]')).includes("直接套用"));
  await page.screenshot({ path: join(SHOTS, "p39b2-preview.png") });
  await page.click('[data-testid="pkg-confirm"]');
  await page.waitForSelector('[data-testid="pkg-done"]', { timeout: 20000 });
  const g = await B.env.DB.prepare("SELECT id, name, brand, price, notes FROM garments").first();
  check("建立獨立副本（新 ID）：名稱、品牌；沒有私人欄位", g && g.id !== "gar_jsk" && g.name === "紫色 JSK" && g.brand === "AP" && g.price === null && g.notes === null, g);
  const imgs = (await B.env.DB.prepare("SELECT id, image_type, has_alpha FROM garment_images WHERE garment_id = ? AND image_type != 'thumbnail'").bind(g.id).all()).results;
  check("匯入去背透明圖", imgs.length === 1 && imgs[0].image_type === "processed" && imgs[0].has_alpha === 1, imgs);
  const t = await B.env.DB.prepare("SELECT avatar_id, slot, image_id, data FROM doll_fit_templates WHERE garment_id = ?").bind(g.id).first().catch(() => null);
  check("衣服設定套用到新衣物（使用新圖片 ID）", t && t.avatar_id === "avatar_v2" && t.slot === "dress" && t.image_id === imgs[0].id, t);
  console.log("匯入角色素材套件");
  await page.setInputFiles('[data-testid="pkg-file"]', file2);
  await page.waitForSelector('[data-testid="pkg-preview"]', { timeout: 10000 });
  await page.click('[data-testid="pkg-confirm"]');
  await page.waitForSelector('[data-testid="pkg-done"]', { timeout: 20000 });
  const a = await B.env.DB.prepare("SELECT id, name, config FROM doll_assets WHERE kind = 'hair'").first();
  const files = (await B.env.DB.prepare("SELECT id FROM doll_asset_files WHERE asset_id = ?").bind(a.id).all()).results;
  check("髮型匯入：新素材及檔案，設定內的引用換成新檔案", a.name === "長直髮" && files.length === 1 && JSON.parse(a.config).parts[0].file === "file:" + files[0].id, [a, files]);
  const errs = B.errors.filter((e) => !/net::ERR_FAILED|Failed to fetch/.test(e));
  check("沒有瀏覽器錯誤", errs.length === 0, errs);
} catch (e) { console.error(e); check("未預期錯誤（匯入）", false, String(e?.stack || e)); }
await B.close();
done();
