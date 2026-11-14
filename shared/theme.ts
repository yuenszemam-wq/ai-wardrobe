/**
 * 全站介面主題（Phase 3.8A → 3.8A.2）：語意化色彩及裝飾設定。
 *
 * Phase 3.8A.2 重點：
 * - 背景與文字分開：每個色票只代表一種用途（例如頁首背景不再同時用作深色文字）。
 * - 13 個「基本」色票（向後相容舊主題）＋ 進階色票（未設定時由基本色自動衍生）。
 * - 主題只改變介面顏色及外觀，不會改動衣物圖片、人物素材或已保存造型的像素。
 * - 錯誤、成功、警告及遮罩（隱藏／身後）保留固定的功能色，不受主題影響。
 * 伺服器以 app_settings.theme 保存，手機另存快取讓 App 啟動時立即套用。
 */
export const THEME_VERSION = 2;
export const MAX_CUSTOM_THEMES = 24;

export type ThemeGroup = "base" | "text" | "control" | "image" | "decor" | "canvas";
export const THEME_GROUPS: [ThemeGroup, string][] = [
  ["base", "基本介面"],
  ["text", "文字及圖示"],
  ["control", "按鈕及選擇"],
  ["image", "衣物及圖片"],
  ["decor", "裝飾"],
  ["canvas", "換裝及圖表"],
];

/** 基本色票（舊版主題已有，必定保存） */
export const BASIC_TOKENS = ["bg", "header", "nav", "card", "primary", "secondary", "selected", "text", "text2", "title", "border", "image", "chart"] as const;
export type BasicToken = (typeof BASIC_TOKENS)[number];
/** 進階色票（可選；未設定＝自動衍生） */
export const ADV_TOKENS = [
  "card2", "pop", "sheet", "input",
  "link", "icon", "iconOn", "inputText", "placeholder", "disabled",
  "onPrimary", "onSecondary", "onSelected", "check", "slider", "focus",
  "image2", "imageHi", "imageBorder", "dots", "imageDeco", "onImage",
  "ribbon", "onRibbon", "lace", "star", "line", "stripe", "shadow",
  "canvas", "canvasPattern", "tool", "toolIcon", "bone", "handle", "meshHandle", "chart2", "chart3", "chart4", "chart5",
] as const;
export type AdvToken = (typeof ADV_TOKENS)[number];
export type ThemeToken = BasicToken | AdvToken;
export type ThemeColors = Record<BasicToken, string>;
export type ResolvedColors = Record<ThemeToken, string>;

/** 色票說明：群組、名稱、對應 CSS 變數 */
export const TOKEN_INFO: Record<ThemeToken, { group: ThemeGroup; label: string; vars: string[] }> = {
  bg: { group: "base", label: "主背景", vars: ["--color-plum", "--aw-bg"] },
  header: { group: "base", label: "頁首背景", vars: ["--aw-header", "--color-head"] },
  nav: { group: "base", label: "底部選單背景", vars: ["--aw-nav"] },
  card: { group: "base", label: "卡片背景", vars: ["--aw-card"] },
  card2: { group: "base", label: "次層卡片背景", vars: ["--aw-card2", "--color-velvet"] },
  pop: { group: "base", label: "彈出視窗背景", vars: ["--aw-pop"] },
  sheet: { group: "base", label: "底部抽屜背景", vars: ["--aw-sheet"] },
  input: { group: "base", label: "輸入框背景", vars: ["--aw-input", "--color-field"] },
  text: { group: "text", label: "主要文字", vars: ["--color-cream", "--aw-text"] },
  text2: { group: "text", label: "次要文字", vars: ["--aw-text2", "--color-mauve"] },
  title: { group: "text", label: "標題文字", vars: ["--color-gold-soft", "--aw-title"] },
  link: { group: "text", label: "連結文字", vars: ["--aw-link", "--color-amethyst-deep"] },
  icon: { group: "text", label: "一般圖示", vars: ["--aw-icon"] },
  iconOn: { group: "text", label: "選中圖示", vars: ["--aw-icon-on"] },
  inputText: { group: "text", label: "輸入框文字", vars: ["--aw-input-text"] },
  placeholder: { group: "text", label: "Placeholder", vars: ["--aw-placeholder"] },
  disabled: { group: "text", label: "停用狀態文字", vars: ["--aw-disabled"] },
  primary: { group: "control", label: "主要按鈕背景", vars: ["--aw-primary", "--color-amethyst"] },
  onPrimary: { group: "control", label: "主要按鈕文字", vars: ["--aw-on-primary", "--color-white"] },
  secondary: { group: "control", label: "次要按鈕背景", vars: ["--aw-secondary"] },
  onSecondary: { group: "control", label: "次要按鈕文字", vars: ["--aw-on-secondary"] },
  selected: { group: "control", label: "選中狀態背景", vars: ["--aw-selected"] },
  onSelected: { group: "control", label: "選中狀態文字", vars: ["--aw-on-selected"] },
  check: { group: "control", label: "勾選框及開關", vars: ["--aw-check"] },
  slider: { group: "control", label: "滑桿", vars: ["--aw-slider"] },
  focus: { group: "control", label: "Focus 邊框", vars: ["--aw-focus"] },
  image: { group: "image", label: "衣物圖片框背景", vars: ["--aw-image", "--color-rose-soft"] },
  image2: { group: "image", label: "圖片框漸層", vars: ["--aw-image2", "--color-rose"] },
  imageHi: { group: "image", label: "圖片框高光", vars: ["--aw-image-hi"] },
  imageBorder: { group: "image", label: "圖片框邊框", vars: ["--aw-image-border"] },
  dots: { group: "image", label: "波點", vars: ["--aw-dots"] },
  imageDeco: { group: "image", label: "圖片底部裝飾", vars: ["--aw-image-deco"] },
  onImage: { group: "image", label: "衣物名稱及分類文字", vars: ["--aw-on-image", "--color-ink"] },
  ribbon: { group: "decor", label: "緞帶標題背景", vars: ["--aw-ribbon"] },
  onRibbon: { group: "decor", label: "緞帶標題文字", vars: ["--aw-on-ribbon"] },
  lace: { group: "decor", label: "蕾絲", vars: ["--aw-lace", "--color-lace"] },
  star: { group: "decor", label: "星形裝飾", vars: ["--aw-star"] },
  border: { group: "decor", label: "邊框", vars: ["--color-gold", "--aw-border"] },
  line: { group: "decor", label: "內外框線", vars: ["--aw-line"] },
  stripe: { group: "decor", label: "背景條紋", vars: ["--aw-stripe"] },
  shadow: { group: "decor", label: "陰影", vars: ["--aw-shadow"] },
  canvas: { group: "canvas", label: "人物畫布背景", vars: ["--aw-canvas"] },
  canvasPattern: { group: "canvas", label: "畫布圖案", vars: ["--aw-canvas-pattern"] },
  tool: { group: "canvas", label: "畫布浮動工具背景", vars: ["--aw-tool"] },
  toolIcon: { group: "canvas", label: "畫布浮動工具圖示", vars: ["--aw-tool-icon"] },
  bone: { group: "canvas", label: "骨架顯示", vars: ["--aw-bone"] },
  handle: { group: "canvas", label: "選中控制點", vars: ["--aw-handle"] },
  meshHandle: { group: "canvas", label: "網格變形控制點", vars: ["--aw-mesh"] },
  chart: { group: "canvas", label: "圖表主要顏色", vars: ["--aw-chart", "--aw-chart-1"] },
  chart2: { group: "canvas", label: "圖表色票 2", vars: ["--aw-chart-2"] },
  chart3: { group: "canvas", label: "圖表色票 3", vars: ["--aw-chart-3"] },
  chart4: { group: "canvas", label: "圖表色票 4", vars: ["--aw-chart-4"] },
  chart5: { group: "canvas", label: "圖表色票 5", vars: ["--aw-chart-5"] },
};
export const ALL_TOKENS: ThemeToken[] = [...BASIC_TOKENS, ...ADV_TOKENS];
export const isBasic = (k: ThemeToken): k is BasicToken => (BASIC_TOKENS as readonly string[]).includes(k);
/** 舊版相容：[token, 名稱, CSS 變數] */
export const THEME_TOKENS = BASIC_TOKENS.map((k) => [k, TOKEN_INFO[k].label, TOKEN_INFO[k].vars[0]] as const);

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
  /** 舊版：角色換裝畫布背景（3.8A.2 起改為進階色票 canvas；保留讀取） */
  canvas: string | null;
}
export interface ThemeDef {
  id: string;
  name: string;
  colors: ThemeColors;
  /** 進階色票：只保存使用者明確設定的項目，其餘自動衍生 */
  adv?: Partial<Record<AdvToken, string>>;
  decor: ThemeDecor;
  /** 由哪個預設主題開始（恢復單項預設顏色時使用） */
  base?: string;
  builtin?: boolean;
}
export interface ThemeSettings { v: number; active: string; custom: ThemeDef[]; updated_at?: string }

export const DEFAULT_DECOR: ThemeDecor = { radius: 18, border: 1, frame: "arch", pattern: "stripe", lace: true, density: "standard", canvas: null };
const preset = (id: string, name: string, colors: ThemeColors, decor: Partial<ThemeDecor> = {}, adv: Partial<Record<AdvToken, string>> = {}): ThemeDef => ({ id, name, colors, adv, decor: { ...DEFAULT_DECOR, ...decor }, builtin: true });
/** 預設主題。「玫瑰桑紫」＝原有介面（進階色票寫明原本數值，外觀與舊版相同）。 */
export const THEME_PRESETS: ThemeDef[] = [
  preset("rose_mulberry", "玫瑰桑紫", { bg: "#2a1526", header: "#1c0e1a", nav: "#3b1f35", card: "#4a2742", primary: "#8f4d7c", secondary: "#4a2742", selected: "#a35c8f", text: "#f6e7df", text2: "#b79bae", title: "#f0d9c0", border: "#d9b391", image: "#f9ece7", chart: "#f2a7c3" }, {}, {
    card2: "#3b1f35", pop: "#3b1f35", sheet: "#2a1526", input: "#fffaf6", link: "#e8bfd3", icon: "#b79bae", iconOn: "#f0d9c0", inputText: "#1c0e1a", placeholder: "#8a6d80", disabled: "#7d6474",
    onPrimary: "#fffaf6", onSecondary: "#f6e7df", onSelected: "#fffaf6", check: "#8f4d7c", slider: "#c9789f", focus: "#d9b391",
    image2: "#f3dcd8", imageHi: "#fffaf6", imageBorder: "#d9b391", dots: "#c97aa0", imageDeco: "#c97aa0", onImage: "#1c0e1a",
    ribbon: "#f2a7c3", onRibbon: "#1c0e1a", lace: "#fdf6f1", star: "#d9b391", line: "#d9b391", stripe: "#321b2e", shadow: "#000000",
    canvas: "#efe3ef", canvasPattern: "#c97aa0", tool: "#1c0e1a", toolIcon: "#f6e7df", bone: "#e0569a", handle: "#f0d9c0", meshHandle: "#8f4d7c",
    chart2: "#c9a0dc", chart3: "#d9b391", chart4: "#8fb8de", chart5: "#9ad4b8",
  }),
  preset("gothic_violet", "哥德黑紫", { bg: "#16101c", header: "#0b070f", nav: "#0b070f", card: "#2b2036", primary: "#6a3d8f", secondary: "#2b2036", selected: "#7b4aa6", text: "#ece4f4", text2: "#a796b8", title: "#d8c6ee", border: "#9a83b8", image: "#efe8f5", chart: "#b98ae0" }),
  preset("black_gold", "黑金", { bg: "#121110", header: "#080807", nav: "#080807", card: "#26221c", primary: "#8a6a2f", secondary: "#2a251d", selected: "#a3803c", text: "#f3ecdf", text2: "#b2a58e", title: "#ecd59a", border: "#c9a45c", image: "#f6f0e2", chart: "#e3c06f" }, { pattern: "plain" }),
  preset("sweet_pink", "甜美粉色", { bg: "#5a2c45", header: "#3d1b2f", nav: "#3d1b2f", card: "#7a3b5e", primary: "#d0628f", secondary: "#6a3352", selected: "#e07aa3", text: "#fff3f7", text2: "#f0c3d6", title: "#ffe0ec", border: "#f5b5cf", image: "#fff1f6", chart: "#ff9cc3" }, { pattern: "dots" }),
  preset("cream_gold", "奶油白金", { bg: "#f4ece2", header: "#e9dccb", nav: "#e9dccb", card: "#fffaf3", primary: "#a77b4f", secondary: "#e6d6c2", selected: "#b7895a", text: "#3b2a22", text2: "#7a6556", title: "#7a5432", border: "#c9a47a", image: "#ffffff", chart: "#c08a5a" }, { pattern: "plain", lace: false }),
];
export const DEFAULT_THEME_ID = "rose_mulberry";
export const defaultThemeSettings = (): ThemeSettings => ({ v: THEME_VERSION, active: DEFAULT_THEME_ID, custom: [] });

// ───── 色彩工具 ─────
const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);
export function hexToRgb(hex: string): [number, number, number] { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export const rgbToHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("");
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 對比度（1–21） */
export function contrast(a: string, b: string): number { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
export const isLight = (hex: string) => luminance(hex) > 0.4;
/** 兩色混合（t=0 → a，t=1 → b） */
export function mixHex(a: string, b: string, t: number): string { const x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t); }
/** 在背景上可讀的文字色：優先使用 prefer（如對比足夠），否則按背景深淺選深色或淺色 */
export function onColor(bg: string, prefer?: string, min = 4.5): string {
  if (prefer && contrast(prefer, bg) >= min) return prefer;
  return contrast("#1d1418", bg) >= contrast("#fffaf6", bg) ? "#1d1418" : "#fffaf6";
}
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
const rotate = (hex: string, deg: number) => { const [h, s, l] = hexToHsl(hex); return hslToHex((h + deg + 360) % 360, s, l); };

/** 由基本色衍生進階色票（使用者沒有設定的項目） */
export function deriveAdvanced(c: ThemeColors, legacyCanvas?: string | null): Record<AdvToken, string> {
  const dark = !isLight(c.bg);
  const input = isLight(c.image) ? mixHex(c.image, "#ffffff", 0.4) : c.image;
  const inputText = onColor(input, c.text);
  return {
    card2: mixHex(c.card, "#000000", 0.15), pop: mixHex(c.card, "#000000", 0.15), sheet: c.bg, input,
    link: mixHex(c.title, c.chart, 0.45), icon: c.text2, iconOn: c.title, inputText, placeholder: mixHex(inputText, input, 0.45), disabled: mixHex(c.text, c.bg, 0.5),
    onPrimary: onColor(c.primary, "#fffaf6"), onSecondary: onColor(c.secondary, c.text), onSelected: onColor(c.selected, "#fffaf6"),
    check: c.selected, slider: c.primary, focus: c.border,
    image2: mixHex(c.image, c.chart, 0.16), imageHi: isLight(c.image) ? mixHex(c.image, "#ffffff", 0.6) : c.image, imageBorder: c.border, dots: c.chart, imageDeco: c.chart, onImage: onColor(c.image),
    ribbon: c.chart, onRibbon: onColor(c.chart), lace: isLight(c.image) ? mixHex(c.image, "#ffffff", 0.5) : mixHex(c.image, c.text, 0.3), star: c.border, line: c.border,
    stripe: mixHex(c.bg, dark ? "#ffffff" : "#000000", 0.04), shadow: "#000000",
    canvas: legacyCanvas && isHex(legacyCanvas) ? legacyCanvas : mixHex(c.image, c.primary, 0.08), canvasPattern: c.chart, tool: c.header, toolIcon: onColor(c.header, c.text), bone: c.chart, handle: c.title, meshHandle: c.primary,
    chart2: rotate(c.chart, 60), chart3: rotate(c.chart, 140), chart4: rotate(c.chart, 200), chart5: rotate(c.chart, 270),
  };
}
/** 完整色票：基本色＋（使用者設定的進階色 或 自動衍生） */
export function resolveColors(t: ThemeDef): ResolvedColors {
  const d = deriveAdvanced(t.colors, t.decor.canvas);
  const out = { ...t.colors } as ResolvedColors;
  for (const k of ADV_TOKENS) out[k] = isHex(t.adv?.[k]) ? t.adv![k]!.toLowerCase() : d[k];
  return out;
}
/** 單項的預設值（恢復預設）：主題的來源預設主題的數值 */
export function tokenDefault(t: ThemeDef, k: ThemeToken): string {
  const base = THEME_PRESETS.find((p) => p.id === (t.builtin ? t.id : t.base)) ?? null;
  if (isBasic(k)) return (base ?? THEME_PRESETS[0]).colors[k];
  // 進階：有預設主題寫明的數值用該數值，否則按目前基本色衍生
  return (base?.adv?.[k] && base.colors.bg === t.colors.bg ? base.adv[k] : undefined) ?? deriveAdvanced(t.colors, t.decor.canvas)[k];
}

const clamp = (n: unknown, a: number, b: number, d: number) => { const v = Number(n); return Number.isFinite(v) ? Math.min(b, Math.max(a, Math.round(v))) : d; };
export function normalizeTheme(t: unknown, fallback: ThemeDef = THEME_PRESETS[0]): ThemeDef | null {
  if (!t || typeof t !== "object") return null;
  const o = t as Partial<ThemeDef>;
  if (typeof o.id !== "string" || !/^[a-z0-9_-]{1,40}$/.test(o.id)) return null;
  const colors = {} as ThemeColors;
  for (const k of BASIC_TOKENS) { const c = (o.colors as Record<string, unknown> | undefined)?.[k]; colors[k] = isHex(c) ? c.toLowerCase() : fallback.colors[k]; }
  const adv: Partial<Record<AdvToken, string>> = {};
  const srcAdv = (o.adv ?? {}) as Record<string, unknown>;
  for (const k of ADV_TOKENS) if (isHex(srcAdv[k])) adv[k] = (srcAdv[k] as string).toLowerCase();
  const d = (o.decor ?? {}) as Partial<ThemeDecor>;
  const decor: ThemeDecor = {
    radius: clamp(d.radius, 0, 32, DEFAULT_DECOR.radius), border: clamp(d.border, 0, 4, DEFAULT_DECOR.border),
    frame: d.frame === "round" ? "round" : "arch", pattern: d.pattern === "dots" || d.pattern === "plain" ? d.pattern : "stripe",
    lace: d.lace !== false, density: d.density === "compact" || d.density === "loose" ? d.density : "standard",
    canvas: isHex(d.canvas) ? d.canvas.toLowerCase() : null,
  };
  // 舊版自訂主題的獨立畫布色 → 進階色票 canvas（只在未明確設定時）
  if (decor.canvas && !adv.canvas) adv.canvas = decor.canvas;
  const base = typeof o.base === "string" && THEME_PRESETS.some((p) => p.id === o.base) ? o.base : undefined;
  return { id: o.id, name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 20) : "我的主題", colors, ...(Object.keys(adv).length ? { adv } : {}), decor, ...(base ? { base } : {}) };
}
export function normalizeThemeSettings(v: unknown): ThemeSettings {
  const d = defaultThemeSettings();
  if (!v || typeof v !== "object") return d;
  const o = v as Partial<ThemeSettings>;
  const custom = (Array.isArray(o.custom) ? o.custom : []).slice(0, MAX_CUSTOM_THEMES).map((t) => normalizeTheme(t)).filter((t): t is ThemeDef => !!t && !THEME_PRESETS.some((p) => p.id === t.id));
  const uniq = [...new Map(custom.map((c) => [c.id, c])).values()];
  const ids = new Set([...THEME_PRESETS.map((p) => p.id), ...uniq.map((c) => c.id)]);
  const active = typeof o.active === "string" && ids.has(o.active) ? o.active : DEFAULT_THEME_ID;
  return { v: THEME_VERSION, active, custom: uniq, ...(typeof o.updated_at === "string" ? { updated_at: o.updated_at } : {}) };
}
/** 超出自訂主題上限時回傳錯誤（避免無聲截斷資料） */
export function customLimitError(s: ThemeSettings, adding = 1): string | null {
  return s.custom.length + adding > MAX_CUSTOM_THEMES ? `自訂主題最多 ${MAX_CUSTOM_THEMES} 個，請先刪除不需要的主題` : null;
}
export const activeTheme = (s: ThemeSettings): ThemeDef => s.custom.find((c) => c.id === s.active) ?? THEME_PRESETS.find((p) => p.id === s.active) ?? THEME_PRESETS[0];
export const newThemeId = () => "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** 以主題為起點建立新的自訂主題（新 ID） */
export function cloneTheme(from: ThemeDef, name?: string): ThemeDef {
  return { id: newThemeId(), name: (name ?? (from.builtin ? from.name + "（自訂）" : from.name + "（複本）")).slice(0, 20), colors: { ...from.colors }, ...(from.adv && Object.keys(from.adv).length ? { adv: { ...from.adv } } : {}), decor: { ...from.decor }, base: from.builtin ? from.id : from.base ?? DEFAULT_THEME_ID };
}
/** 將色票設定到主題（基本色寫入 colors；進階色寫入 adv） */
export function setToken(t: ThemeDef, k: ThemeToken, hex: string): ThemeDef {
  const v = hex.toLowerCase();
  if (isBasic(k)) return { ...t, colors: { ...t.colors, [k]: v } };
  return { ...t, adv: { ...(t.adv ?? {}), [k]: v } };
}
/** 恢復單項：基本色回到來源預設；進階色移除覆蓋（重新自動衍生） */
export function resetToken(t: ThemeDef, k: ThemeToken): ThemeDef {
  if (isBasic(k)) return { ...t, colors: { ...t.colors, [k]: tokenDefault(t, k) } };
  const adv = { ...(t.adv ?? {}) }; delete adv[k];
  const decor = k === "canvas" ? { ...t.decor, canvas: null } : t.decor;
  return { ...t, adv, decor };
}

// ───── 可讀性 ─────
export interface ReadabilityIssue { pair: string; ratio: number; min: number; fg: ThemeToken; bg: ThemeToken; sameColor: boolean }
const PAIRS: [ThemeToken, ThemeToken, string, number][] = [
  ["text", "bg", "主要文字／主背景", 4.5], ["text", "card", "主要文字／卡片", 4.5], ["text2", "card", "次要文字／卡片", 3], ["text2", "bg", "次要文字／主背景", 3],
  ["title", "bg", "標題／主背景", 3], ["title", "card", "標題／卡片", 3], ["onPrimary", "primary", "主要按鈕文字", 4.5], ["onSecondary", "secondary", "次要按鈕文字", 4.5],
  ["onSelected", "selected", "選中狀態文字", 4.5], ["text2", "card", "未選中狀態文字", 3], ["text", "nav", "底部選單文字", 4.5], ["icon", "nav", "底部選單圖示", 3], ["text", "header", "頁首文字", 4.5],
  ["inputText", "input", "輸入框文字", 4.5], ["onImage", "image", "衣物名稱／圖片框", 4.5], ["onRibbon", "ribbon", "緞帶標題文字", 4.5],
];
export function readability(c: ResolvedColors): ReadabilityIssue[] {
  const seen = new Set<string>();
  const out: ReadabilityIssue[] = [];
  for (const [fg, bg, pair, min] of PAIRS) {
    const r = contrast(c[fg], c[bg]);
    if (r < min && !seen.has(pair)) { seen.add(pair); out.push({ pair, ratio: Math.round(r * 10) / 10, min, fg, bg, sameColor: c[fg] === c[bg] }); }
  }
  return out;
}
/** 舊版 API：只看基本色（衍生色自動計算） */
export function readabilityIssues(c: ThemeColors): string[] {
  return readability(resolveColors({ id: "x", name: "x", colors: c, decor: DEFAULT_DECOR })).map((i) => `${i.pair}對比不足（${i.ratio.toFixed(1)}:1）`);
}
/** 自動文字顏色建議：按背景深淺給出足夠對比的文字色 */
export function autoText(bg: string): { text: string; text2: string; title: string } {
  return isLight(bg) ? { text: "#2e211c", text2: "#6e5a50", title: "#5e3d24" } : { text: "#f6ece4", text2: "#bfaab8", title: "#f0d9c0" };
}
/** 「自動調整文字顏色」：只修改對比不足的文字色票，回傳修改後主題及改動清單（不會無提示套用） */
export function autoFixText(t: ThemeDef): { theme: ThemeDef; changed: ThemeToken[] } {
  let next = t;
  const changed: ThemeToken[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const c = resolveColors(next);
    for (const i of readability(c)) {
      if (changed.includes(i.fg)) continue;
      const bgs = PAIRS.filter((p) => p[0] === i.fg).map((p) => c[p[1]]);
      // 選擇對所有背景都最可讀的候選色
      const base = autoText(i.bg === "card" || i.bg === "bg" ? c.bg : c[i.bg]);
      const cands = [base.text, base.text2, base.title, "#1d1418", "#fffaf6", onColor(c[i.bg])];
      const best = cands.map((h) => [h, Math.min(...bgs.map((b) => contrast(h, b)))] as const).sort((a, b) => b[1] - a[1])[0][0];
      const keepTone = i.fg === "text2" ? mixHex(best, c[i.bg], 0.25) : best;
      const v = contrast(keepTone, c[i.bg]) >= i.min ? keepTone : best;
      next = setToken(next, i.fg, v);
      changed.push(i.fg);
    }
  }
  return { theme: next, changed };
}

/** 主題 → CSS 變數（全部最終值，不依賴其他變數，方便在預覽容器內獨立套用） */
export function themeVars(t: ThemeDef): Record<string, string> {
  const c = resolveColors(t);
  const v: Record<string, string> = {};
  for (const k of ALL_TOKENS) for (const name of TOKEN_INFO[k].vars) v[name] = c[k];
  const rgba = (hex: string, a: number) => { const [r, g, b] = hexToRgb(hex); return `rgb(${r} ${g} ${b} / ${a})`; };
  v["--aw-radius"] = t.decor.radius + "px";
  v["--aw-border-w"] = t.decor.border + "px";
  v["--aw-arch-radius"] = t.decor.frame === "round" ? t.decor.radius + "px" : "999px 999px 14px 14px";
  v["--aw-lace-on"] = t.decor.lace ? "block" : "none";
  v["--aw-pad"] = t.decor.density === "compact" ? "0.6rem" : t.decor.density === "loose" ? "1.4rem" : "1rem";
  v["--aw-body-pattern"] = t.decor.pattern === "stripe" ? `repeating-linear-gradient(90deg, ${c.bg} 0 12px, ${c.stripe} 12px 24px)` : t.decor.pattern === "dots" ? `radial-gradient(circle, ${c.stripe} 1.6px, transparent 2.2px)` : "none";
  v["--aw-body-pattern-size"] = t.decor.pattern === "dots" ? "16px 16px" : "auto";
  v["--aw-shadow-soft"] = rgba(c.shadow, 0.28);
  v["--aw-shadow-strong"] = rgba(c.shadow, 0.4);
  v["--aw-scheme"] = isLight(c.bg) ? "light" : "dark";
  // 狀態色：只按深淺切換文字，保持功能辨識
  if (isLight(c.bg)) { v["--color-ok-ink"] = "#1f5a36"; v["--color-danger-ink"] = "#7a1530"; v["--color-wine"] = "#a12c4b"; }
  else { v["--color-ok-ink"] = "#d6f5e1"; v["--color-danger-ink"] = "#ffd3df"; v["--color-wine"] = "#f28ba3"; }
  return v;
}
/** 主題的 data-* 標記（圖案、圖片框、蕾絲、密度、深淺） */
export function themeData(t: ThemeDef): Record<string, string> {
  return { theme: t.id, pattern: t.decor.pattern, frame: t.decor.frame, lace: t.decor.lace ? "1" : "0", density: t.decor.density, scheme: isLight(t.colors.bg) ? "light" : "dark" };
}
