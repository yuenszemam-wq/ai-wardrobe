// Phase 3.8A：主頁自訂布局、設定頁、介面主題、穿搭工作室、角色素材及衣服設定介面
// 執行：node test/phase38-home.mjs（iPhone 13 viewport＋觸控模擬；桌面 Chromium，不等於 iPhone Safari 實機）
import { join } from "node:path";
import { startApp, addGarment, checker } from "./p38-setup.mjs";

const { check, done } = checker();
const A = await startApp("p38h");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38h-${n}.png`), fullPage: false });
for (let i = 0; i < 10; i++) await addGarment(env, { id: `gar_h${"abcdefghij"[i]}`, name: `首頁衣物 ${i + 1}`, category: i % 2 ? "半身裙" : "連身裙", subcategory: i % 2 ? "SK" : "JSK", svg: `<path d="M300 200 L600 200 L800 1100 L100 1100 Z" fill="#${["6b2d5c", "1f3a5f", "7a1f2b"][i % 3]}"/>`, w: 450, h: 600, price: i % 3 ? 200 + i * 10 : null, favorite: i % 4 === 0 ? 1 : 0, created: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
const layoutOf = () => page.getAttribute('[data-testid="home"]', "data-layout");

try {
  console.log("主頁");
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="home"]');
  const l0 = await layoutOf();
  check("預設主頁次序：封面→概覽→總價→快捷→最近加入→…", l0.startsWith("cover,overview,value,quick,recent"), l0);
  check("主頁右上角是「編輯」，不是上傳", (await page.locator('[data-testid="home-edit"]').count()) === 1 && (await page.locator('header a[href="/import"]').count()) === 0);
  check("底部選單仍保留上傳", (await page.locator('nav a[href="/import"]').count()) === 1);
  check("衣櫃總數沒有在多個大型卡片重複", (await page.locator('[data-testid="w-overview"] .frame').count()) <= 7);
  await page.waitForSelector('[data-testid="w-recent"] [data-garment], [data-testid="w-recent"] a', { timeout: 8000 }).catch(() => undefined);
  await shot("01-home");

  console.log("主頁編輯器");
  await page.click('[data-testid="home-edit"]');
  await page.waitForSelector('[data-testid="home-editor"]');
  // 隱藏「快捷操作」→ 主頁即時預覽
  await page.click('[data-toggle="quick"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="home"]').dataset.layout.includes("quick")).catch(() => undefined);
  check("即時預覽：隱藏元件後主頁立即更新", !(await layoutOf()).split(",").includes("quick"));
  // 「總價」向上移兩格
  await page.click('[data-widget="value"] [data-move="up"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="home"]').dataset.layout.startsWith("cover,value"));
  await page.click('[data-widget="value"] [data-move="up"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="home"]').dataset.layout.startsWith("value,cover")).catch(() => undefined);
  check("向上／向下按鈕排序", (await layoutOf()).startsWith("value,cover"), await layoutOf());
  // 最近加入：顯示 3 件、只顯示半身裙
  await page.click('[data-widget="recent"] [data-settings="recent"]');
  await page.fill('[data-widget-settings="recent"] [data-opt="count"]', "3");
  await page.selectOption('[data-widget-settings="recent"] [data-opt="category"]', "半身裙");
  await page.waitForTimeout(200);
  await page.click('[role="dialog"] [aria-label="關閉"]');
  const recentN = await page.locator('[data-testid="w-recent"] .shrink-0').count();
  check("元件獨立設定：數量及分類篩選", recentN === 3, recentN);
  // 新增一個「收藏衣物」，並設定獨立排序
  await page.click('[data-testid="home-add"]');
  await page.click('[data-add="favorites"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="home"]').dataset.layout.includes("favorites")).catch(() => undefined);
  check("新增元件", (await layoutOf()).split(",").includes("favorites"), await layoutOf());
  await shot("02-editor");
  await page.click('[data-testid="home-save"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="home-editor"]'));
  const row = await env.DB.prepare("SELECT value FROM app_settings WHERE key='home_layout'").first();
  const saved = JSON.parse(row.value);
  check("保存到伺服器（版本化 home_layout）", saved.v === 1 && saved.widgets.find((w) => w.type === "recent").opts.count === 3 && saved.widgets.find((w) => w.type === "quick").visible === false && !!saved.updated_at, saved.widgets.slice(0, 3));
  // 重新開啟：伺服器回應很慢時，仍然直接顯示本機布局（不先顯示預設）
  await page.route("**/api/settings", async (r) => { await new Promise((res) => setTimeout(res, 2500)); await r.continue().catch(() => undefined); });
  await page.goto(A.base + "/");
  await page.waitForSelector('[data-testid="home"]');
  check("重新開啟 App：立即顯示本機布局", (await layoutOf()).startsWith("value,cover") && !(await layoutOf()).includes("quick"), await layoutOf());
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // 取消：不保存
  await page.click('[data-testid="home-edit"]');
  await page.click('[data-toggle="value"]');
  await page.click('button:has-text("取消")');
  check("取消：放棄修改", (await layoutOf()).startsWith("value"));

  console.log("設定頁");
  await page.goto(A.base + "/settings");
  await page.waitForSelector('[data-testid="settings-home"]');
  const groups = await page.locator("[data-settings-group]").evaluateAll((els) => els.map((e) => e.dataset.settingsGroup));
  check("設定頁統一分組：個人化／衣櫃管理／資料及儲存／AI 及帳戶", groups.join() === "個人化,衣櫃管理,資料及儲存,AI 及帳戶", groups);
  const heights = await page.locator("[data-settings-row]").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  check("列表高度一致", Math.max(...heights) - Math.min(...heights) <= 2, heights);
  check("首頁不再顯示縮圖技術面板", (await page.locator('text=今日補建讀取').count()) === 0);
  await shot("03-settings");
  await page.click('[data-settings-row="home"]');
  await page.waitForSelector('[data-testid="home-editor"]');
  check("設定 → 主頁佈局 使用同一個編輯器", (await page.locator('[data-widget="value"]').count()) === 1);
  await page.click('[data-testid="home-reset"]');
  await page.click('[data-testid="home-save"]');
  await page.waitForURL("**/settings");
  check("還原預設布局", JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='home_layout'").first()).value).widgets[0].type === "cover");

  console.log("介面顏色");
  await page.goto(A.base + "/settings/theme");
  await page.waitForSelector('[data-testid="theme-list"]');
  check("提供五個預設主題，玫瑰桑紫為目前主題", (await page.locator("[data-theme-card]").count()) === 5 && (await page.getAttribute('[data-theme-card="rose_mulberry"]', "data-active")) === "1");
  const bg0 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.click('[data-theme-card="gothic_violet"] button[aria-pressed]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === "gothic_violet");
  const bg1 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("切換主題：全站顏色即時改變", bg0 !== bg1, [bg0, bg1]);
  check("主題保存到伺服器", JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='theme'").first()).value).active === "gothic_violet");
  for (const path of ["/wardrobe", "/outfits", "/dressing/assets", "/settings"]) {
    await page.goto(A.base + path);
    await page.waitForTimeout(400);
    const c = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check(`主題套用到 ${path}`, c === bg1, c);
  }
  // 啟動時立即套用（設定回應很慢）
  await page.route("**/api/settings", async (r) => { await new Promise((res) => setTimeout(res, 2500)); await r.continue().catch(() => undefined); });
  await page.goto(A.base + "/");
  check("重新開啟：立即套用本機主題", (await page.evaluate(() => document.documentElement.dataset.theme)) === "gothic_violet");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // 淺色主題的文字可讀性
  await page.goto(A.base + "/settings/theme");
  await page.click('[data-theme-card="cream_gold"] button[aria-pressed]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === "cream_gold");
  const contrastOk = await page.evaluate(() => {
    const rgb = (s) => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
    const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    return ratio(rgb(getComputedStyle(document.body).color), rgb(getComputedStyle(document.body).backgroundColor));
  });
  check("淺色主題：主要文字與背景對比足夠（≥4.5）", contrastOk >= 4.5, contrastOk);
  await shot("04-theme-light");
  // 自訂主題：低對比提示＋自動文字顏色
  await page.click('[data-theme-card="rose_mulberry"] [data-testid="theme-customize"]');
  await page.click('[data-token="text"]');
  await page.fill('[data-testid="theme-hex"]', "#3a2030");
  await page.locator('[data-testid="theme-hex"]').blur();
  check("低對比時顯示可讀性提示", (await page.locator('[data-testid="theme-issues"]').count()) === 1);
  await page.click('[data-testid="theme-auto-text"]');
  check("自動文字顏色修正對比", (await page.locator('[data-testid="theme-issues"]').count()) === 0);
  await page.fill('[data-testid="theme-name"]', "我的夜色");
  await shot("05-theme-editor");
  await page.click('[data-testid="theme-save"]');
  await page.waitForSelector('[data-testid="theme-list"]');
  const th = JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='theme'").first()).value);
  check("保存自訂主題並套用", th.custom.length === 1 && th.custom[0].name === "我的夜色" && th.active === th.custom[0].id, th);
  await page.click('[data-testid="theme-reset"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === "rose_mulberry");
  check("還原預設主題：回到原有介面數值", (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-plum").trim())) === "#2a1526");

  console.log("穿搭工作室及角色素材");
  await page.goto(A.base + "/outfits");
  await page.waitForSelector('[data-testid="studio-main"]');
  const mainH = (await page.locator('[data-testid="studio-main"] a').first().boundingBox()).height;
  const toolH = (await page.locator('[data-testid="studio-tools"] a').first().boundingBox()).height;
  check("主要入口與管理入口大小明確區分", mainH > toolH + 8 && mainH < 90, [mainH, toolH]);
  const listTop = (await page.locator("h2:has-text('我的穿搭')").boundingBox()).y;
  check("我的穿搭更快出現在畫面", listTop < 330, listTop);
  await shot("06-studio");
  await page.evaluate(() => fetch("/api/doll/models", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "ai-wardrobe" }, body: JSON.stringify({ from: "avatar_v2", name: "測試身體" }) }));
  await page.goto(A.base + "/dressing/assets");
  await page.waitForFunction(() => document.querySelectorAll("[data-asset-card]").length >= 2);
  const sizes = await page.locator("[data-asset-card]").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  check("角色素材：每排兩個同尺寸卡片", sizes.length >= 2 && sizes.every(([w, h]) => Math.abs(w - sizes[0][0]) <= 2 && Math.abs(h - sizes[0][1]) <= 2), sizes);
  await page.click('[data-asset-card="body"][data-id="avatar_v2"] [data-testid="asset-more"]');
  const items = await page.locator('[role="menu"] [role="menuitem"]').allTextContents();
  check("「⋯」集中管理操作（內置身體只有支援的功能，不可刪除）", items.includes("複製") && items.includes("衣服設定") && !items.includes("刪除") && !items.includes("改名"), items);
  await page.keyboard.press("Escape"); await page.mouse.click(5, 300);
  await page.click('[data-asset-card="body"]:not([data-id="avatar_v2"]) [data-testid="asset-more"]');
  const items2 = await page.locator('[role="menu"] [role="menuitem"]').allTextContents();
  check("自訂身體的更多操作：編輯、改名、匯出、封存、刪除", ["編輯身體", "改名", "匯出", "封存", "刪除"].every((x) => items2.includes(x)), items2);
  await shot("07-assets");
  await page.goto(A.base + "/dressing/setup");
  await page.waitForSelector("[data-setup-garment], [data-testid='garment-setup']");
  check("沒有瀏覽器錯誤", A.errors.length === 0, A.errors);
} catch (e) {
  check("執行過程沒有例外", false, String(e?.stack || e));
  await shot("error").catch(() => undefined);
}
await A.close();
done();
