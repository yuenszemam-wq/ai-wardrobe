// Phase 3.6B/C 瀏覽器測試：角色素材工作室、身體編輯器、換裝頁切換身體、模型專屬衣服設定、姿勢庫、髮件可見性遮罩。
// CI 以桌面 Chromium 模擬手機尺寸，不等於 iPhone Safari 實機。
import { checker, startRoom, svgPng, sharp } from "./doll-room.mjs";
const { check, done } = checker();
const R = await startRoom({ name: "p36", garments: [{ id: "gar_seed", name: "測試JSK", category: "連身裙", subcategory: "JSK", png: await svgPng('<rect x="200" y="150" width="500" height="900" fill="#5b2491"/>') }] });
const { page, env, ready, room, screen, pixels, swipe } = R;
const canvas = () => page.locator('[data-testid="doll-canvas"]').evaluate((c) => c.toDataURL());
const editorReady = () => page.waitForFunction(() => document.querySelector('[data-testid="doll-canvas"]')?.dataset.ready === "1", null, { timeout: 20000 });
try {
  // ───── 穿搭工作室第四個入口 ─────
  await page.goto(R.base + "/outfits");
  check("穿搭工作室有角色素材入口", (await page.locator('[data-testid="entry-assets"]').count()) === 1);
  await page.goto(R.base + "/dressing/assets");
  await page.waitForSelector('[data-testid="studio-bodies"]');
  check("角色素材有四個分類", (await page.locator("[data-studio-tab]").count()) === 4);
  check("內置 Avatar V2 列在身體列表", (await page.locator('[data-body-card="avatar_v2"]').count()) === 1);

  // ───── 新增身體（複製 V2）並進入編輯器 ─────
  await page.click('[data-testid="body-new"]');
  await page.waitForSelector('[data-testid="model-editor"]');
  await editorReady();
  const mid = page.url().split("/").pop();
  check("新身體有獨立 id", /^dm_/.test(mid), mid);
  const v2pixels = await canvas();
  check("未修改的副本與 V2 相同（同一套素材）", (await page.getAttribute('[data-testid="model-editor"]', "data-def")) === JSON.stringify({ v: 1, base: "avatar_v2", parts: {}, bones: {}, anchors: {}, head: { dx: 0, dy: 0, s: 1 } }));

  // 部件：選擇右手掌，上傳與角色對齊的全畫布 PNG（自動按原圖座標對位）
  await page.click('[data-part="hand_r"]');
  await page.waitForSelector('[data-testid="part-editor"]');
  const handPng = new Uint8Array(await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800"><ellipse cx="270" cy="930" rx="60" ry="70" fill="#2a8f5a"/></svg>')).png().toBuffer());
  await page.locator('input[type="file"]').first().setInputFiles({ name: "hand_r.png", mimeType: "image/png", buffer: Buffer.from(handPng) });
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="model-editor"]').dataset.def).parts.hand_r?.file?.startsWith("file:dmf_"), null, { timeout: 15000 });
  const def1 = JSON.parse(await page.getAttribute('[data-testid="model-editor"]', "data-def"));
  check("全畫布 PNG 自動對位到原圖座標", Math.abs(def1.parts.hand_r.x - 210) < 3 && Math.abs(def1.parts.hand_r.y - 860) < 3, def1.parts.hand_r);
  check("保存原始畫布尺寸及裁剪範圍", def1.parts.hand_r.src?.w === 1200 && def1.parts.hand_r.src.crop[0] > 200);
  await editorReady();
  check("替換部件後畫布像素改變", (await canvas()) !== v2pixels);

  // 骨架：右手肘連同下游移動 30px（前臂、手掌一起移）
  await page.click('[data-model-tab="bones"]');
  await page.click('[data-joint="elbow_r"]');
  const yInput = page.locator('[data-testid="joint-editor"] input[type="number"]').nth(1);
  await yInput.fill("680"); await page.waitForTimeout(150);
  const def2 = JSON.parse(await page.getAttribute('[data-testid="model-editor"]', "data-def"));
  check("骨架修改移動靜止關節及下游部件", def2.bones.elbow_r?.pivot?.[1] === 680 && def2.parts.lower_arm_r?.y === 607 + 30, def2);
  check("骨架控制點顯示", (await page.locator("[data-model-handle]").count()) >= 17);
  await page.click('[data-testid="model-undo"]');
  check("撤銷骨架修改", !JSON.parse(await page.getAttribute('[data-testid="model-editor"]', "data-def")).bones.elbow_r);
  await yInput.fill("680"); await page.waitForTimeout(150);

  // 活動範圍
  await page.locator('[data-testid="joint-editor"] input[type="number"]').nth(3).fill("100");
  await page.waitForTimeout(100);
  await page.click('[data-testid="model-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="model-editor"]').dataset.rev === "2", null, { timeout: 15000 });
  const saved = await env.DB.prepare("SELECT revision FROM doll_models WHERE id = ?").bind(mid).first();
  const rev2 = JSON.parse((await env.DB.prepare("SELECT def FROM doll_model_revisions WHERE model_id = ? AND revision = 2").bind(mid).first()).def);
  check("保存產生第 2 版", saved.revision === 2 && rev2.bones.elbow_r.pivot[1] === 680 && rev2.bones.elbow_r.min !== undefined);
  check("第 1 版保持不變", JSON.parse((await env.DB.prepare("SELECT def FROM doll_model_revisions WHERE model_id = ? AND revision = 1").bind(mid).first()).def).parts.hand_r === undefined);
  check("保存身體縮圖", !!(await env.DB.prepare("SELECT thumb FROM doll_models WHERE id = ?").bind(mid).first()).thumb);
  await page.click('[data-model-tab="preview"]');
  check("預覽分頁可以拖動手腳", (await page.locator('[data-handle="wrist_r"]').count()) === 1);

  // ───── 換裝頁：穿衣、切換身體、保存造型 ─────
  await page.goto(R.base + "/dressing");
  await page.waitForSelector('[data-garment="gar_seed"]');
  await page.click('[data-garment="gar_seed"]'); await ready();
  check("新造型預設使用 Avatar V2", (await room("data-model")) === "avatar_v2");
  const onV2 = await canvas();
  await page.click('[data-tab="look"]'); await page.click('[data-looktab="body"]');
  await page.waitForSelector(`[data-body="${mid}"]`);
  await page.click(`[data-body="${mid}"]`);
  await page.waitForFunction((m) => document.querySelector('[data-testid="dressing-room"]').dataset.model === m, mid);
  await ready();
  check("切換身體不會脫下衣服", (await room("data-worn")) === "gar_seed");
  check("切換身體使用新身體的素材", (await canvas()) !== onV2);
  await page.fill('[data-testid="look-name"]', "新身體造型");
  await page.click('[data-testid="save-look"]');
  await page.waitForFunction(() => location.pathname.startsWith("/dressing/look_"), null, { timeout: 15000 });
  const look = await env.DB.prepare("SELECT avatar_id, state FROM doll_looks ORDER BY created_at DESC LIMIT 1").first();
  check("造型記錄身體及版本", look.avatar_id === mid && JSON.parse(look.state).model.rev === 2, look.avatar_id);
  check("換裝未改動 V2 衣物設定", (await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_fit_templates").first()).n === 0);
  await page.reload(); await ready();
  check("重新開啟造型使用保存時的身體", (await room("data-model")) === mid && (await room("data-model-rev")) === "2");

  // 切換回 V2，再切換回來，原有設定恢復
  await page.click('[data-tab="look"]'); await page.click('[data-looktab="body"]');
  await page.click('[data-body="avatar_v2"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="dressing-room"]').dataset.model === "avatar_v2"); await ready();
  check("切換回 Avatar V2", (await canvas()) === onV2);

  // ───── 姿勢庫 ─────
  await page.click('[data-tab="pose"]');
  await page.click('[data-posetab="presets"]');
  await page.locator('[data-testid="pose-presets"] button').nth(1).click();
  await page.click('[data-posetab="mine"]');
  await page.click('[data-testid="pose-save"]');
  await page.waitForSelector("[data-my-pose]", { timeout: 15000 });
  check("保存到我的姿勢", (await env.DB.prepare("SELECT COUNT(*) AS n FROM doll_poses").first()).n === 1);
  await page.click('[data-testid="pose-reset"]');
  await page.locator("[data-my-pose]").first().click();
  check("套用已保存姿勢", (await room("data-pose")) !== "{}");

  // ───── 髮件可見性遮罩 ─────
  await page.click('[data-tab="look"]'); await page.click('[data-looktab="hair"]');
  await page.click('[data-worn-hair="hair_bangs"]');
  await page.click('[data-testid="hair-vis"]');
  await ready();
  const before = await pixels(560, 90, 80, 80);
  await swipe(await screen(540, 80), await screen(660, 150), 12);
  await page.waitForTimeout(300); await ready();
  const after = await pixels(560, 90, 80, 80);
  check("塗抹後瀏海部分隱藏（畫面像素改變）", JSON.stringify(before) !== JSON.stringify(after), [before, after]);
  check("髮件原圖不變（遮罩另存於造型髮件設定）", await page.evaluate(() => fetch("/doll/avatar_v2/hair/twin_tails_long/hair_bangs.png").then((r) => r.ok)));

  // ───── 衣服設定：按身體 ─────
  await page.goto(R.base + `/dressing/setup?model=${mid}`);
  await page.waitForSelector('[data-setup-garment="gar_seed"]');
  check("衣服設定可以選擇校正模型", (await page.locator(`[data-setup-model="${mid}"][aria-pressed="true"]`).count()) === 1);
  await page.click('[data-setup-garment="gar_seed"]'); await ready();
  check("設定頁顯示目前身體", ((await page.textContent('[data-testid="setup-model"]')) || "").includes("測試"));
  check("設定頁使用該身體", (await room("data-model")) === mid);
  await page.click('[data-testid="setup-save"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="dressing-room"]').dataset.dirty === "0", null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const t = await env.DB.prepare("SELECT avatar_id FROM doll_fit_templates WHERE garment_id = 'gar_seed'").all();
  check("衣服設定保存為該身體專屬", t.results.length === 1 && t.results[0].avatar_id === mid, t.results);
  check("沒有瀏覽器錯誤", R.errors.length === 0, R.errors);
} catch (e) { check("瀏覽器測試中斷：" + e.message, false); console.log(e.stack); }
finally { await R.close(); done(); }
