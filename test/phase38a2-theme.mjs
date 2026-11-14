// Phase 3.8A.2：完整主題系統瀏覽器測試（computed styles＋截圖）。
// 執行：node test/phase38a2-theme.mjs   （桌面 Chromium 模擬 iPhone 13，不等於 iPhone Safari／PWA 實機）
import { join } from "node:path";
import { startApp, addGarment, checker } from "./p38-setup.mjs";
import { buildModule } from "./doll-build.mjs";

const { check, done } = checker();
const T = await buildModule("shared/theme.ts", "p38a2-theme");
const A = await startApp("p38a2t");
const { env, page } = A;
const SHOTS = process.env.DOLL_SHOTS || A.TMP;
const shot = (n) => page.screenshot({ path: join(SHOTS, `p38a2-theme-${n}.png`), fullPage: false });

const SVG = '<path d="M300 200 L600 200 L700 1000 L200 1000 Z" fill="#7d3a6a"/>';
await addGarment(env, { id: "gar_a", name: "白色黑蕾絲娃娃領泡袖上衣", category: "上衣", subcategory: "襯衫", svg: SVG, price: 680, favorite: 1 });
await addGarment(env, { id: "gar_b", name: "紫色菱格人偶 JSK", category: "連身裙", subcategory: "JSK", svg: SVG });

// ── 純邏輯 ──
console.log("主題資料模型");
const old = T.normalizeThemeSettings({ v: 1, active: "custom_old", custom: [{ id: "custom_old", name: "舊主題", colors: { ...T.THEME_PRESETS[1].colors }, decor: { canvas: "#112233" } }] });
check("舊版自訂主題可讀取（保留 ID、顏色；舊畫布色轉為進階色票）", old.active === "custom_old" && old.custom[0].colors.bg === T.THEME_PRESETS[1].colors.bg && old.custom[0].adv.canvas === "#112233");
const rose = T.resolveColors(T.THEME_PRESETS[0]);
check("玫瑰桑紫的衍生數值＝原本介面（圖片框漸層、緞帶、輸入框）", rose.image2 === "#f3dcd8" && rose.ribbon === "#f2a7c3" && rose.input === "#fffaf6" && rose.onImage === "#1c0e1a");
for (const p of T.THEME_PRESETS) check(`預設主題「${p.name}」沒有可讀性問題`, T.readability(T.resolveColors(p)).length === 0, T.readability(T.resolveColors(p)));
const c1 = T.cloneTheme(T.THEME_PRESETS[0]), c2 = T.cloneTheme(c1);
check("新增／複製主題建立新 ID", c1.id !== c2.id && c1.id.startsWith("custom_") && c2.base === "rose_mulberry");
const edited = T.setToken(c1, "ribbon", "#000000");
check("修改進階色只寫入 adv，不改基本色", edited.adv.ribbon === "#000000" && edited.colors.chart === c1.colors.chart && edited.id === c1.id);
check("恢復單項：進階色改回自動衍生", !T.resetToken(edited, "ribbon").adv.ribbon);
const same = T.setToken(T.THEME_PRESETS[0], "text", T.THEME_PRESETS[0].colors.bg);
check("可讀性檢查區分「刻意設定相同顏色」", T.readability(T.resolveColors(same)).some((i) => i.sameColor && i.fg === "text"));
const fixed = T.autoFixText(same);
check("自動調整文字：只改文字色票並列出改動", fixed.changed.includes("text") && fixed.theme.colors.bg === same.colors.bg && T.readability(T.resolveColors(fixed.theme)).filter((i) => i.fg === "text").length === 0, fixed.changed);
check("超出上限有明確錯誤（不無聲截斷）", !!T.customLimitError({ custom: Array(T.MAX_CUSTOM_THEMES).fill(c1) }) && T.customLimitError({ custom: [] }) === null);

const BLACK = Object.fromEntries(T.BASIC_TOKENS.map((k) => [k, "#000000"]));
const BLACK_ADV = Object.fromEntries(T.ADV_TOKENS.map((k) => [k, "#000000"]));
const setLocal = (custom, active) => page.evaluate(([c, a]) => localStorage.setItem("aw:theme", JSON.stringify({ v: 2, active: a, custom: c, updated_at: "local-test" })), [custom, active]);
/** 掃描畫面上所有元素（含 ::before／::after）的 computed 顏色；回傳有彩度（非灰階）的顏色及位置 */
const scanChromatic = () => page.evaluate(() => {
  const out = [];
  // 任何 CSS 顏色（rgb、color(srgb)、oklab、oklch…）以 canvas 轉成 RGBA
  const cv = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
  const toRgba = (c) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = "#000"; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const parse = (s) => [...s.matchAll(/(?:rgba?|color|oklab|oklch|lab|lch|hsla?)\([^()]*\)/g)].map((m) => toRgba(m[0]));
  const skip = (el) => el.closest("img,canvas,video,[data-garment-pixels],[data-color-swatch],[data-status-color]");
  for (const el of document.querySelectorAll("body *")) {
    if (skip(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    for (const pseudo of [null, "::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo);
      if (pseudo && (cs.content === "none" || cs.display === "none")) continue;
      const props = ["color", "backgroundColor", "backgroundImage", "boxShadow", "fill", "stroke"];
      if (parseFloat(cs.borderTopWidth) > 0) props.push("borderTopColor");
      if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) props.push("outlineColor");
      for (const p of props) {
        if ((p === "color" || p === "fill" || p === "stroke") && pseudo) continue;
        if ((p === "fill" || p === "stroke") && !(el instanceof SVGElement)) continue;
        if (p === "color" && !el.childNodes.length) continue;
        for (const [rr, gg, bb, a] of parse(cs[p] || "")) {
          if (a < 0.06) continue;
          const chroma = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
          if (chroma > 28) out.push({ el: (el.getAttribute("data-testid") || el.className?.baseVal || el.className || el.tagName).toString().slice(0, 60), pseudo, p, rgb: [rr, gg, bb, a].map((v) => Math.round(v * 100) / 100) });
        }
      }
    }
  }
  return out;
});

try {
  await page.goto(A.base + "/");
  console.log("全黑色票診斷（基本＋進階全部黑色）");
  await setLocal([{ id: "custom_black", name: "全黑", colors: BLACK, adv: BLACK_ADV, decor: { lace: true, pattern: "stripe" } }], "custom_black");
  const pages = [["/", "home"], ["/wardrobe", "wardrobe"], ["/import", "upload"], ["/outfits", "outfits"], ["/settings", "settings"], ["/settings/theme", "theme"], ["/g/gar_a", "detail"]];
  for (const [path, name] of pages) {
    await page.goto(A.base + path);
    await page.waitForTimeout(700);
    const hits = await scanChromatic();
    check(`全黑：${path} 沒有殘留的粉紅／奶油／金色（非灰階顏色）`, hits.length === 0, hits.slice(0, 8));
    if (name === "home" || name === "wardrobe" || name === "upload") await shot(`01-black-${name}`);
  }

  console.log("黑底＋淺色文字");
  const dark = T.setToken(T.setToken(T.setToken({ ...T.cloneTheme(T.THEME_PRESETS[0], "黑底白字"), colors: { ...BLACK, text: "#f5f5f5", text2: "#bdbdbd", title: "#ffffff", border: "#777777", image: "#1a1a1a", chart: "#999999" } }, "onImage", "#f0f0f0"), "inputText", "#f0f0f0"), "input", "#222222");
  await setLocal([dark], dark.id);
  const ratio = () => page.evaluate(() => {
    const cv = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
    const rgba = (c) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = "#000"; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const rgb = (s) => rgba(s).slice(0, 3);
    const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratioOf = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    /** 每個有文字的元素：找最近的實底背景，計算對比 */
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const v = rgba(getComputedStyle(e).backgroundColor); if (v[3] > 0.9) return v.slice(0, 3); } return rgb(getComputedStyle(document.body).backgroundColor); };
    let worst = 99, where = "";
    for (const el of document.querySelectorAll("main *, nav *, header *")) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const r = el.getBoundingClientRect(); if (!r.width || r.top > innerHeight) continue;
      const cs = getComputedStyle(el); if (cs.visibility === "hidden" || Number(cs.opacity) < 0.5) continue;
      // 只計算沒有背景圖片（漸層）的元素
      let hasImg = false; for (let e = el; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).backgroundImage !== "none") { hasImg = true; break; }
      if (hasImg) continue;
      const v = ratioOf(rgb(cs.color), bgOf(el));
      if (v < worst) { worst = v; where = (el.className || el.tagName) + "：" + el.textContent.trim().slice(0, 20); }
    }
    return [Math.round(worst * 10) / 10, where];
  });
  for (const path of ["/", "/wardrobe", "/settings"]) {
    await page.goto(A.base + path); await page.waitForTimeout(600);
    const [w, where] = await ratio();
    check(`黑底白字：${path} 所有純色背景上的文字對比 ≥ 3`, w >= 3, [w, where]);
  }
  await page.goto(A.base + "/"); await page.waitForTimeout(500); await shot("02-dark");

  console.log("白底＋深色文字");
  const light = { ...T.cloneTheme(T.THEME_PRESETS[4], "白底黑字"), colors: { ...T.THEME_PRESETS[4].colors, bg: "#ffffff", card: "#ffffff", header: "#f2f2f2", nav: "#f2f2f2", text: "#111111", text2: "#555555", title: "#222222" } };
  await setLocal([light], light.id);
  for (const path of ["/", "/wardrobe", "/settings"]) {
    await page.goto(A.base + path); await page.waitForTimeout(600);
    const [w, where] = await ratio();
    check(`白底黑字：${path} 文字對比 ≥ 3（深色面板沒有錯誤的淺色文字）`, w >= 3, [w, where]);
  }
  await shot("03-light");
  console.log("預設主題");
  for (const p of T.THEME_PRESETS) {
    await setLocal([], p.id);
    await page.goto(A.base + "/"); await page.waitForTimeout(400);
    const [w, where] = await ratio();
    check(`${p.name}：首頁文字對比 ≥ 3`, w >= 3, [w, where]);
    const rib = await page.evaluate(() => { const r = document.querySelector(".ribbon"); return r ? getComputedStyle(r).color : null; });
    if (rib) check(`${p.name}：緞帶文字跟隨主題`, rib.replace(/\s/g, "").includes(T.hexToRgb(T.resolveColors(p).onRibbon).join(",")), rib);
  }
  await setLocal([], "gothic_violet"); await page.goto(A.base + "/"); await page.waitForTimeout(400); await shot("04-gothic");
  await setLocal([], "rose_mulberry"); await page.goto(A.base + "/"); await page.waitForTimeout(400); await shot("05-rose");
  // 自訂粉色、高對比
  const pink = { ...T.cloneTheme(T.THEME_PRESETS[3], "自訂粉色"), colors: { ...T.THEME_PRESETS[3].colors, bg: "#ffd6e7", card: "#fff0f6", header: "#ffc2da", nav: "#ffc2da", text: "#4a1030", text2: "#7a3858", title: "#7a1040", secondary: "#ffe0ee" } };
  const hc = { ...T.cloneTheme(T.THEME_PRESETS[0], "高對比"), colors: { ...BLACK, text: "#ffffff", text2: "#ffff00", title: "#ffffff", primary: "#ffff00", selected: "#00ffff", border: "#ffffff", image: "#ffffff", chart: "#ffff00", secondary: "#000000" } };
  for (const th of [pink, hc]) {
    await setLocal([th], th.id);
    await page.goto(A.base + "/wardrobe"); await page.waitForTimeout(500);
    const [w, where] = await ratio();
    check(`${th.name}：衣櫃文字對比 ≥ 3`, w >= 3, [w, where]);
  }

  console.log("原生控件及表面範圍");
  await setLocal([], "rose_mulberry");
  await page.goto(A.base + "/wardrobe"); await page.waitForTimeout(400);
  const accent = await page.evaluate(() => { const i = document.createElement("input"); i.type = "checkbox"; document.querySelector("main").append(i); const a = getComputedStyle(i).accentColor; i.remove(); return a; });
  check("勾選框使用主題勾選色（不是瀏覽器藍色）", accent.replace(/\s/g, "").includes("143,77,124"), accent);
  const scope = await page.evaluate(() => { const d = document.createElement("div"); d.className = "bg-cream/5 p-2"; d.textContent = "x"; document.querySelector("main").append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  check("bg-cream/5（低透明度）不會被當成淺色表面而變成深色文字", scope.replace(/\s/g, "").includes("246,231,223"), scope);

  console.log("主題編輯：新增、編輯、預覽隔離、取消、保存");
  await page.goto(A.base + "/settings/theme");
  await page.waitForSelector('[data-testid="theme-list"]');
  await page.click('[data-testid="theme-add"]');
  await page.click('[data-add-from="gothic_violet"]');
  await page.waitForSelector('[data-testid="theme-editor"]');
  const rootBg0 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-plum").trim());
  await page.click('[data-token="bg"]');
  await page.fill('[data-testid="theme-hex"]', "#003344"); await page.locator('[data-testid="theme-hex"]').blur();
  const prevBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="theme-preview"]')).backgroundColor);
  const rootBg1 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-plum").trim());
  check("修改顏色即時更新預覽", prevBg.replace(/\s/g, "") === "rgb(0,51,68)", prevBg);
  check("草稿只套用在預覽容器，全站主題不變", rootBg0 === rootBg1, [rootBg0, rootBg1]);
  for (const k of ["home", "wardrobe", "upload", "studio", "dress", "settings"]) {
    await page.click(`[data-preview-tab="${k}"]`);
    check(`預覽切換：${k}`, (await page.getAttribute('[data-testid="theme-preview"]', "data-preview-page")) === k);
  }
  await page.locator('[data-testid="theme-preview"]').scrollIntoViewIfNeeded();
  await shot("06-preview-dress");
  await page.click('[data-testid="theme-trial"]');
  check("套用到整個 App 試用：全站暫時使用草稿", (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-plum").trim())) === "#003344");
  // 進階色票：色相滑桿顯示彩虹漸層
  await page.click('[data-testid="theme-advanced"]');
  await page.click('[data-token="ribbon"]');
  const hueBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="theme-hue"]')).getPropertyValue("--aw-track"));
  check("色相滑桿是彩虹漸層", /#f00/.test(hueBg) && /#0ff/.test(hueBg), hueBg);
  const satBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="theme-sat"]')).getPropertyValue("--grad"));
  check("飽和度滑桿按目前顏色顯示漸層", /linear-gradient/.test(satBg), satBg);
  await page.click('[data-testid="theme-cancel"]');
  await page.waitForSelector('[data-testid="theme-list"]');
  check("取消編輯完整恢復原本主題", (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-plum").trim())) === rootBg0 && !(await page.evaluate(() => document.documentElement.dataset.themeTrial)));
  check("取消後沒有建立新主題", (await page.locator("[data-custom-card]").count()) === 0);
  // 新增並保存
  await page.click('[data-testid="theme-add"]');
  await page.click('[data-testid="theme-add-current"]');
  await page.fill('[data-testid="theme-name"]', "我的黑夜");
  await page.click('[data-token="bg"]');
  await page.fill('[data-testid="theme-hex"]', "#101010"); await page.locator('[data-testid="theme-hex"]').blur();
  // 保存工具列不遮住內容
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(200);
  const cover = await page.evaluate(() => { const bar = document.querySelector('[data-testid="theme-actions"]').getBoundingClientRect(); const last = document.querySelector('[data-testid="theme-decor"]').getBoundingClientRect(); const nav = document.querySelector("nav.app-tabbar").getBoundingClientRect(); return { lastBottom: last.bottom, barTop: bar.top, barBottom: bar.bottom, navTop: nav.top }; });
  check("主題編輯保存工具列不遮住最後的設定，也不壓住底部選單", cover.lastBottom <= cover.barTop + 1 && cover.barBottom <= cover.navTop + 1, cover);
  await shot("07-editor-bottom");
  await page.click('[data-testid="theme-save"]');
  await page.waitForSelector('[data-testid="theme-list"]');
  let st = JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='theme'").first()).value);
  check("新增主題保存到伺服器並套用", st.custom.length === 1 && st.custom[0].name === "我的黑夜" && st.active === st.custom[0].id, st);
  const id = st.custom[0].id;
  // 編輯已有主題：保留 ID，不建立重複主題
  await page.click(`[data-custom-card="${id}"] [data-testid="theme-edit"]`);
  check("編輯已有主題：顯示為編輯（不是新增）", (await page.getAttribute('[data-testid="theme-editor"]', "data-new")) === "0" && (await page.getAttribute('[data-testid="theme-editor"]', "data-editing")) === id);
  await page.click('[data-token="title"]');
  await page.fill('[data-testid="theme-hex"]', "#ffeeaa"); await page.locator('[data-testid="theme-hex"]').blur();
  await page.click('[data-testid="theme-save"]');
  await page.waitForSelector('[data-testid="theme-list"]');
  st = JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='theme'").first()).value);
  check("編輯已有主題不會建立重複主題（保留原 ID）", st.custom.length === 1 && st.custom[0].id === id && st.custom[0].colors.title === "#ffeeaa", st.custom.map((c) => c.id));
  // 複製＝新 ID
  await page.click(`[data-custom-card="${id}"] [data-testid="theme-duplicate"]`);
  await page.waitForFunction(() => document.querySelectorAll("[data-custom-card]").length === 2);
  st = JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='theme'").first()).value);
  check("複製主題建立新 ID", st.custom.length === 2 && st.custom[1].id !== id);
  // 刪除使用中主題：合理切換
  await page.click(`[data-custom-card="${id}"] [data-testid="theme-delete"]`);
  await page.waitForFunction(() => document.querySelectorAll("[data-custom-card]").length === 1);
  st = JSON.parse((await env.DB.prepare("SELECT value FROM app_settings WHERE key='theme'").first()).value);
  check("刪除使用中的主題：切換到來源預設主題", st.active === "rose_mulberry" && st.custom.length === 1, st.active);
  // 重新啟動
  await page.click(`[data-custom-card="${st.custom[0].id}"] [data-testid="theme-apply"]`);
  await page.waitForFunction((x) => document.documentElement.dataset.theme === x, st.custom[0].id);
  await page.goto(A.base + "/");
  check("切換主題後重新啟動 App：立即套用", (await page.evaluate(() => document.documentElement.dataset.theme)) === st.custom[0].id);

  console.log("首頁 Widget 設定的文字顏色");
  await setLocal([], "rose_mulberry");
  await page.goto(A.base + "/");
  check("沒有瀏覽器錯誤", A.errors.length === 0, A.errors);
} finally {
  await A.close();
  done();
}
