/**
 * 介面主題（Phase 3.8A）：套用語意色彩到 CSS 變數。
 * App 啟動時先用手機快取立即套用（避免先顯示舊主題再切換），之後與伺服器設定同步。
 */
import { DEFAULT_THEME_ID, THEME_TOKENS, ThemeDef, ThemeSettings, activeTheme, defaultThemeSettings, hexToRgb, isLight, normalizeThemeSettings } from "../shared/theme";

const KEY = "aw:theme";
const mix = (hex: string, other: [number, number, number], t: number) => { const c = hexToRgb(hex); return `rgb(${c.map((v, i) => Math.round(v + (other[i] - v) * t)).join(" ")})`; };

const DERIVED = ["--color-ink", "--color-velvet", "--color-amethyst", "--color-mauve", "--color-gold-soft", "--color-rose-soft", "--aw-stripe", "--aw-radius", "--aw-border-w", "--aw-canvas"];
export function applyTheme(t: ThemeDef, root: HTMLElement = document.documentElement) {
  const c = t.colors, st = root.style;
  root.dataset.theme = t.id;
  if (t.builtin && t.id === DEFAULT_THEME_ID) {
    // 預設主題＝原本的介面：移除所有覆蓋，完全使用 styles.css 的原有數值
    for (const [, , v] of THEME_TOKENS) st.removeProperty(v);
    for (const v of DERIVED) st.removeProperty(v);
    for (const k of ["pattern", "frame", "lace", "density", "scheme", "canvas"]) delete root.dataset[k];
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#1c0e1a");
    return;
  }
  for (const [k, , v] of THEME_TOKENS) st.setProperty(v, c[k]);
  // 由主色衍生的漸層及深淺（不需要使用者逐一設定）
  st.setProperty("--color-ink", c.header);
  st.setProperty("--color-velvet", mix(c.card, [0, 0, 0], 0.15));
  st.setProperty("--color-amethyst", c.primary);
  st.setProperty("--color-mauve", c.text2);
  st.setProperty("--color-gold-soft", c.title);
  st.setProperty("--color-rose-soft", c.image);
  st.setProperty("--aw-stripe", mix(c.bg, isLight(c.bg) ? [0, 0, 0] : [255, 255, 255], 0.04));
  st.setProperty("--aw-radius", t.decor.radius + "px");
  st.setProperty("--aw-border-w", t.decor.border + "px");
  st.setProperty("--aw-canvas", t.decor.canvas ?? "");
  root.dataset.pattern = t.decor.pattern;
  root.dataset.frame = t.decor.frame;
  root.dataset.lace = t.decor.lace ? "1" : "0";
  root.dataset.density = t.decor.density;
  if (t.decor.canvas) root.dataset.canvas = "1"; else delete root.dataset.canvas;
  root.dataset.scheme = isLight(c.bg) ? "light" : "dark";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", c.header);
}
export function localTheme(): ThemeSettings {
  try { const v = localStorage.getItem(KEY); return v ? normalizeThemeSettings(JSON.parse(v)) : defaultThemeSettings(); } catch { return defaultThemeSettings(); }
}
export function storeTheme(s: ThemeSettings) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 私人瀏覽 */ } }
/** 啟動時立即套用本機快取的主題 */
export function bootTheme() { applyTheme(activeTheme(localTheme())); }
/** 伺服器設定較新時套用並更新快取（另一部裝置修改後） */
export function syncTheme(server: ThemeSettings | null | undefined) {
  const local = localTheme();
  const next = server ? normalizeThemeSettings(server) : null;
  if (!next) return;
  if (next.updated_at && next.updated_at !== local.updated_at) { storeTheme(next); applyTheme(activeTheme(next)); }
}
