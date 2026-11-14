/**
 * 全站介面主題（Phase 3.8A）：語意色彩及裝飾設定。
 * 主題只改變介面顏色及外觀，不會改動任何衣物圖片。伺服器以 app_settings.theme 保存，手機另存快取讓 App 啟動時立即套用。
 */
export const THEME_VERSION = 1;

/** 語意色彩：每一項對應一個 CSS 變數 */
export const THEME_TOKENS = [
  ["bg", "主背景", "--color-plum"],
  ["header", "頁首背景", "--aw-header"],
  ["nav", "底部選單背景", "--aw-nav"],
  ["card", "卡片背景", "--aw-card"],
  ["primary", "主要按鈕", "--aw-primary"],
  ["secondary", "次要按鈕", "--aw-secondary"],
  ["selected", "選中狀態", "--aw-selected"],
  ["text", "主要文字", "--color-cream"],
  ["text2", "次要文字", "--aw-text2"],
  ["title", "標題文字", "--color-gold-soft"],
  ["border", "邊框及裝飾色", "--color-gold"],
  ["image", "衣物圖片底色", "--aw-image"],
  ["chart", "圖表主色", "--aw-chart"],
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number][0];
export type ThemeColors = Record<ThemeToken, string>;

export interface ThemeDecor {
  /** 卡片圓角（px） */
  radius: number;
  /** 邊框粗幼（px） */
  border: number;
  /** 衣物圖片框：拱形或普通圓角 */
  frame: "arch" | "round";
  /** 背景圖案 */
  pattern: "stripe" | "dots" | "plain";
  /** 蕾絲裝飾 */
  lace: boolean;
  /** 版面密度 */
  density: "compact" | "standard" | "loose";
  /** 角色換裝畫布背景（獨立設定，不必跟隨 App 背景）；null＝預設 */
  canvas: string | null;
}
export interface ThemeDef { id: string; name: string; colors: ThemeColors; decor: ThemeDecor; builtin?: boolean }
export interface ThemeSettings { v: number; active: string; custom: ThemeDef[]; updated_at?: string }

export const DEFAULT_DECOR: ThemeDecor = { radius: 18, border: 1, frame: "arch", pattern: "stripe", lace: true, density: "standard", canvas: null };
const preset = (id: string, name: string, colors: ThemeColors, decor: Partial<ThemeDecor> = {}): ThemeDef => ({ id, name, colors, decor: { ...DEFAULT_DECOR, ...decor }, builtin: true });
/** 預設主題。「玫瑰桑紫」＝現有介面，保持為預設。 */
export const THEME_PRESETS: ThemeDef[] = [
  preset("rose_mulberry", "玫瑰桑紫", { bg: "#2a1526", header: "#1c0e1a", nav: "#3b1f35", card: "#4a2742", primary: "#8f4d7c", secondary: "#4a2742", selected: "#a35c8f", text: "#f6e7df", text2: "#b79bae", title: "#f0d9c0", border: "#d9b391", image: "#f9ece7", chart: "#f2a7c3" }),
  preset("gothic_violet", "哥德黑紫", { bg: "#16101c", header: "#0b070f", nav: "#0b070f", card: "#2b2036", primary: "#6a3d8f", secondary: "#2b2036", selected: "#7b4aa6", text: "#ece4f4", text2: "#a796b8", title: "#d8c6ee", border: "#9a83b8", image: "#efe8f5", chart: "#b98ae0" }),
  preset("black_gold", "黑金", { bg: "#121110", header: "#080807", nav: "#080807", card: "#26221c", primary: "#8a6a2f", secondary: "#2a251d", selected: "#a3803c", text: "#f3ecdf", text2: "#b2a58e", title: "#ecd59a", border: "#c9a45c", image: "#f6f0e2", chart: "#e3c06f" }, { pattern: "plain" }),
  preset("sweet_pink", "甜美粉色", { bg: "#5a2c45", header: "#3d1b2f", nav: "#3d1b2f", card: "#7a3b5e", primary: "#d0628f", secondary: "#6a3352", selected: "#e07aa3", text: "#fff3f7", text2: "#f0c3d6", title: "#ffe0ec", border: "#f5b5cf", image: "#fff1f6", chart: "#ff9cc3" }, { pattern: "dots" }),
  preset("cream_gold", "奶油白金", { bg: "#f4ece2", header: "#e9dccb", nav: "#e9dccb", card: "#fffaf3", primary: "#a77b4f", secondary: "#e6d6c2", selected: "#b7895a", text: "#3b2a22", text2: "#7a6556", title: "#7a5432", border: "#c9a47a", image: "#ffffff", chart: "#c08a5a" }, { pattern: "plain", lace: false }),
];
export const DEFAULT_THEME_ID = "rose_mulberry";
export const defaultThemeSettings = (): ThemeSettings => ({ v: THEME_VERSION, active: DEFAULT_THEME_ID, custom: [] });

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (n: unknown, a: number, b: number, d: number) => { const v = Number(n); return Number.isFinite(v) ? Math.min(b, Math.max(a, Math.round(v))) : d; };
export function normalizeTheme(t: unknown, fallback: ThemeDef = THEME_PRESETS[0]): ThemeDef | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Partial<ThemeDef>;
  if (typeof o.id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(o.id)) return null;
  const colors = {} as ThemeColors;
  for (const [k] of THEME_TOKENS) { const c = (o.colors as Record<string, unknown> | undefined)?.[k]; colors[k] = typeof c === "string" && HEX.test(c) ? c.toLowerCase() : fallback.colors[k]; }
  const d = (o.decor ?? {}) as Partial<ThemeDecor>;
  const decor: ThemeDecor = {
    radius: clamp(d.radius, 0, 32, DEFAULT_DECOR.radius), border: clamp(d.border, 0, 4, DEFAULT_DECOR.border),
    frame: d.frame === "round" ? "round" : "arch", pattern: d.pattern === "dots" || d.pattern === "plain" ? d.pattern : "stripe",
    lace: d.lace !== false, density: d.density === "compact" || d.density === "loose" ? d.density : "standard",
    canvas: typeof d.canvas === "string" && HEX.test(d.canvas) ? d.canvas.toLowerCase() : null,
  };
  return { id: o.id, name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 20) : "我的主題", colors, decor };
}
export function normalizeThemeSettings(v: unknown): ThemeSettings {
  const d = defaultThemeSettings();
  if (!v || typeof v !== "object") return d;
  const o = v as Partial<ThemeSettings>;
  const custom = (Array.isArray(o.custom) ? o.custom : []).slice(0, 12).map((t) => normalizeTheme(t)).filter((t): t is ThemeDef => !!t && !THEME_PRESETS.some((p) => p.id === t.id));
  const ids = new Set([...THEME_PRESETS.map((p) => p.id), ...custom.map((c) => c.id)]);
  const active = typeof o.active === "string" && ids.has(o.active) ? o.active : DEFAULT_THEME_ID;
  return { v: THEME_VERSION, active, custom: [...new Map(custom.map((c) => [c.id, c])).values()], ...(typeof o.updated_at === "string" ? { updated_at: o.updated_at } : {}) };
}
export const activeTheme = (s: ThemeSettings): ThemeDef => s.custom.find((c) => c.id === s.active) ?? THEME_PRESETS.find((p) => p.id === s.active) ?? THEME_PRESETS[0];

// ───── 色彩工具（可讀性） ─────
export function hexToRgb(hex: string): [number, number, number] { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export const rgbToHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("");
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 對比度（1–21） */
export function contrast(a: string, b: string): number { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
export const isLight = (hex: string) => luminance(hex) > 0.4;
/** 自動文字顏色建議：按背景深淺給出足夠對比的文字色 */
export function autoText(bg: string): { text: string; text2: string; title: string } {
  return isLight(bg) ? { text: "#2e211c", text2: "#6e5a50", title: "#5e3d24" } : { text: "#f6ece4", text2: "#bfaab8", title: "#f0d9c0" };
}
/** 可讀性檢查：文字與背景、卡片的對比不足 3:1 的組合 */
export function readabilityIssues(c: ThemeColors): string[] {
  const out: string[] = [];
  const pairs: [ThemeToken, ThemeToken, string, number][] = [["text", "bg", "主要文字／主背景", 4.5], ["text", "card", "主要文字／卡片", 4.5], ["title", "bg", "標題／主背景", 3], ["title", "card", "標題／卡片", 3], ["text2", "card", "次要文字／卡片", 3], ["text", "header", "文字／頁首", 4.5], ["text", "nav", "文字／底部選單", 4.5]];
  for (const [a, b, label, min] of pairs) if (contrast(c[a], c[b]) < min) out.push(`${label}對比不足（${contrast(c[a], c[b]).toFixed(1)}:1）`);
  return out;
}
/** HSL 調整（色相、飽和度、明度） */
export function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}
export function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
