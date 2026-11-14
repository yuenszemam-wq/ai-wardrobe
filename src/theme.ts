/**
 * 介面主題（Phase 3.8A.2）：把主題的語意色彩套用到指定元素的 CSS 變數。
 *
 * - 正式主題：套用在 document.documentElement（App 啟動時先用手機快取立即套用）。
 * - 編輯草稿：可以只套用在預覽容器（scope），不影響全站；選擇「套用到整個 App 試用」時才暫時套用到 root，
 *   取消或離開編輯時以 restoreTheme() 恢復正式主題。
 * 所有變數都直接寫入最終顏色（不依賴其他變數），所以巢狀的預覽容器可以獨立顯示不同主題。
 */
import { ThemeDef, ThemeSettings, activeTheme, defaultThemeSettings, normalizeThemeSettings, themeData, themeVars } from "../shared/theme";

const KEY = "aw:theme";
const applied = new WeakMap<HTMLElement, string[]>();

export function applyTheme(t: ThemeDef, el: HTMLElement = document.documentElement) {
  const vars = themeVars(t), st = el.style;
  for (const name of applied.get(el) ?? []) if (!(name in vars)) st.removeProperty(name);
  for (const [k, v] of Object.entries(vars)) st.setProperty(k, v);
  applied.set(el, Object.keys(vars));
  for (const [k, v] of Object.entries(themeData(t))) el.dataset[k] = v;
  if (el === document.documentElement) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", vars["--aw-header"]);
}
/** 預覽容器使用的 style 物件（React） */
export function themeStyle(t: ThemeDef): Record<string, string> { return themeVars(t); }
export function localTheme(): ThemeSettings {
  try { const v = localStorage.getItem(KEY); return v ? normalizeThemeSettings(JSON.parse(v)) : defaultThemeSettings(); } catch { return defaultThemeSettings(); }
}
export function storeTheme(s: ThemeSettings) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 私人瀏覽 */ } }
/** 啟動時立即套用本機快取的主題 */
export function bootTheme() { applyTheme(activeTheme(localTheme())); }
/** 恢復正式（已保存）主題：取消編輯或結束試用時使用 */
export function restoreTheme() { applyTheme(activeTheme(localTheme())); delete document.documentElement.dataset.themeTrial; }
/** 暫時把草稿套用到整個 App 試用（未保存） */
export function trialTheme(t: ThemeDef) { applyTheme(t); document.documentElement.dataset.themeTrial = "1"; }
/** 伺服器設定較新時套用並更新快取（另一部裝置修改後）；正在試用草稿時不覆蓋畫面 */
export function syncTheme(server: ThemeSettings | null | undefined) {
  const local = localTheme();
  const next = server ? normalizeThemeSettings(server) : null;
  if (!next) return;
  if (next.updated_at && next.updated_at !== local.updated_at) {
    storeTheme(next);
    if (!document.documentElement.dataset.themeTrial) applyTheme(activeTheme(next));
  }
}
