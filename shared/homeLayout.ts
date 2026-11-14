/**
 * 主頁自訂布局（Phase 3.8A）：可新增、隱藏、排序的資訊元件，每個元件有自己的設定。
 * 伺服器以 app_settings.home_layout 保存正式設定（有版本）；手機另存一份最新快取，開啟 App 時直接使用。
 * 前端及 Worker 共用同一套驗證，未知元件或設定會被略去，舊版本自動升級。
 */
export const HOME_LAYOUT_VERSION = 2;

export type WidgetType =
  | "cover" | "overview" | "value" | "quick" | "recent" | "updated" | "favorites"
  | "recent_looks" | "fav_looks" | "analysis" | "todo" | "random_garment" | "random_look";
/** Phase 3.8A.2：小型（半寬）、中型（半寬或全寬）、大型（全寬）。舊版 compact／standard 自動升級。 */
export type WidgetSize = "small" | "medium" | "large";
export type WidgetSpan = 1 | 2;
export interface WidgetOpts {
  title?: boolean;
  count?: number;
  sort?: string;
  category?: string;
  only_when_content?: boolean;
  mode?: string;
  /** 封面：顯示衣櫃名稱、統計及文字可讀性漸層 */
  show_name?: boolean;
  show_stats?: boolean;
  shade?: number;
  /** 封面：自訂衣櫃名稱 */
  name?: string;
  /** 衣櫃概覽：顯示哪些統計及次序；快捷操作：顯示哪些功能及次序（Phase 3.8A.1） */
  items?: string[];
  /** 衣物元件：子分類、只顯示收藏、詳細模式 */
  subcategory?: string;
  favorite?: boolean;
  detail?: boolean;
  /** 分析摘要：圖表形式及是否顯示比例 */
  chart?: "donut" | "bars";
  show_pct?: boolean;
  /** 封面：獨立高度（相對寬度的百分比；未設定＝背景圖設定）及文字位置 */
  height?: number;
  text_pos?: "top" | "bottom";
  /** 封面：裁切位置（0–100，垂直）、縮放（1–3）、文字位置（左／中） */
  pos_y?: number;
  zoom?: number;
  align?: "left" | "center";
  /** 穿搭元件：只顯示衣服配搭／角色換裝 */
  look_kind?: "all" | "outfit" | "look";
  /** 衣物元件：顯示名稱（與封面共用 show_name）、品牌、分類 */
  show_brand?: boolean;
  show_category?: boolean;
  /** 分析：顯示圖例 */
  legend?: boolean;
}
/** 衣櫃概覽可選統計（鍵、名稱） */
export const OVERVIEW_ITEMS: [string, string][] = [["total", "衣物總數"], ["favorites", "收藏"], ["ai_todo", "待整理"], ["ai_review", "待確認"], ["ai_done", "已完成"], ["missing_image", "缺少圖片"], ["unpriced", "未填價格"]];
export const OVERVIEW_DEFAULT = ["total", "favorites", "ai_todo", "ai_review", "ai_done"];
/** 快捷操作可選功能 */
export const QUICK_ITEMS: [string, string][] = [["upload", "上傳"], ["outfit", "衣服配搭"], ["dressing", "角色換裝"], ["setup", "衣服設定"], ["assets", "角色素材"], ["analysis", "衣櫃分析"], ["wardrobe", "我的衣櫃"], ["looks", "我的穿搭"]];
export const QUICK_DEFAULT = ["upload", "outfit", "dressing", "setup", "analysis"];
export interface Widget { id: string; type: WidgetType; visible: boolean; size: WidgetSize; /** 展示方式（按元件類型） */ display: string; /** 佔用欄數（兩欄 Grid） */ span: WidgetSpan; opts: WidgetOpts }

/** 每種元件的展示方式：[鍵, 名稱, 建議大小] */
export const DISPLAYS: Record<WidgetType, [string, string, WidgetSize][]> = {
  cover: [["full", "全幅大圖", "large"], ["banner", "橫向封面", "large"], ["mini", "迷你封面", "small"], ["image", "純圖片", "large"], ["name", "圖片＋衣櫃名稱", "large"], ["stats", "圖片＋統計資料", "large"]],
  overview: [["grid", "多項統計網格", "large"], ["single", "單一數字", "small"], ["pair", "雙欄統計", "medium"], ["row", "橫向數字列", "large"], ["list", "緊湊文字列表", "medium"]],
  value: [["amount_count", "金額＋已填件數", "large"], ["amount", "只顯示總金額", "small"], ["full", "完整價格統計", "large"], ["progress", "價格資料完成度", "medium"]],
  quick: [["icons", "小型圖示按鈕列", "large"], ["cards2", "雙欄功能卡片", "large"], ["grid", "多欄圖示網格", "large"], ["single", "單一功能", "small"]],
  recent: [["carousel", "橫向圖片滑動", "large"], ["hero", "單件大圖", "small"], ["grid2", "雙欄圖片", "large"], ["grid3", "三欄圖片", "large"], ["list", "緊湊詳細列表", "large"]],
  updated: [["carousel", "橫向圖片滑動", "large"], ["hero", "單件大圖", "small"], ["grid2", "雙欄圖片", "large"], ["grid3", "三欄圖片", "large"], ["list", "緊湊詳細列表", "large"]],
  favorites: [["carousel", "橫向圖片滑動", "large"], ["hero", "單件大圖", "small"], ["grid2", "雙欄圖片", "large"], ["grid3", "三欄圖片", "large"], ["list", "緊湊詳細列表", "large"]],
  random_garment: [["carousel", "橫向圖片滑動", "large"], ["hero", "單件大圖", "small"], ["grid2", "雙欄圖片", "large"], ["grid3", "三欄圖片", "large"], ["list", "緊湊詳細列表", "large"]],
  recent_looks: [["carousel", "橫向相簿", "large"], ["hero", "單張大圖", "small"], ["grid2", "雙欄卡片", "large"], ["grid3", "三欄卡片", "large"], ["list", "緊湊列表", "large"]],
  fav_looks: [["carousel", "橫向相簿", "large"], ["hero", "單張大圖", "small"], ["grid2", "雙欄卡片", "large"], ["grid3", "三欄卡片", "large"], ["list", "緊湊列表", "large"]],
  random_look: [["hero", "單張大圖", "small"], ["carousel", "橫向相簿", "large"], ["grid2", "雙欄卡片", "large"], ["list", "緊湊列表", "large"]],
  analysis: [["donut", "圓環圖", "large"], ["bars", "橫向長條圖", "large"], ["rank", "分類排行", "medium"], ["ratio", "單一比例", "small"], ["numbers", "純數字摘要", "medium"]],
  todo: [["chips", "標籤列", "large"], ["list", "緊湊列表", "medium"], ["count", "待處理總數", "small"]],
};
export const SIZE_LABEL: Record<WidgetSize, string> = { small: "小型", medium: "中型", large: "大型" };
export const displayLabel = (t: WidgetType, d: string) => DISPLAYS[t]?.find((x) => x[0] === d)?.[1] ?? d;
/** 大小 → 欄數：小型＝半寬；大型＝全寬；中型＝按選擇（預設全寬）。全幅封面只可全寬。 */
export function spanFor(type: WidgetType, display: string, size: WidgetSize, want?: unknown): WidgetSpan {
  if (type === "cover" && display !== "mini") return 2;
  if (size === "small") return 1;
  if (size === "large") return 2;
  return want === 1 ? 1 : 2;
}
export interface HomeLayout { v: number; widgets: Widget[]; updated_at?: string; /** 伺服器保存次數（單調遞增），用來判斷版本新舊及編輯衝突 */ rev?: number }
/** a 是否比 b 新：先比較 rev，再比較保存時間（不只是「不相同」） */
export function isNewerLayout(a: Pick<HomeLayout, "rev" | "updated_at"> | null | undefined, b: Pick<HomeLayout, "rev" | "updated_at"> | null | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  const ra = a.rev ?? 0, rb = b.rev ?? 0;
  if (ra !== rb) return ra > rb;
  const ta = Date.parse(a.updated_at ?? "") || 0, tb = Date.parse(b.updated_at ?? "") || 0;
  return ta > tb;
}

export interface WidgetSpec {
  type: WidgetType;
  label: string;
  hint: string;
  /** 可用的排序選項（每個元件獨立） */
  sorts?: [string, string][];
  /** 預設顯示數量；undefined＝沒有數量設定 */
  count?: number;
  maxCount?: number;
  /** 可加入多個（例如不同分類的最近加入） */
  multi?: boolean;
  category?: boolean;
  onlyWhen?: boolean;
}
export const WIDGETS: WidgetSpec[] = [
  { type: "cover", label: "背景封面", hint: "主頁背景圖、衣櫃名稱及統計" },
  { type: "overview", label: "衣櫃概覽", hint: "衣物總數、收藏、待整理、待確認、已完成、缺少圖片、未填價格", multi: true },
  { type: "value", label: "衣櫃總價", hint: "已填價格的合計及數目（未填價格不當作零元）", multi: true },
  { type: "quick", label: "快捷操作", hint: "上傳、衣服配搭、角色換裝、衣服設定、角色素材、衣櫃分析、我的穿搭", multi: true },
  { type: "recent", label: "最近加入衣物", hint: "最新加入的衣物", sorts: [["created", "最新加入"], ["created_asc", "最早加入"]], count: 8, maxCount: 24, multi: true, category: true },
  { type: "updated", label: "最近修改衣物", hint: "最近修改過資料的衣物", sorts: [["updated", "最近修改"]], count: 8, maxCount: 24, multi: true, category: true },
  { type: "favorites", label: "收藏衣物", hint: "已收藏的衣物", sorts: [["updated", "最近修改"], ["created", "最新加入"], ["name", "名稱"], ["price_desc", "價錢高至低"]], count: 8, maxCount: 24, category: true, onlyWhen: true, multi: true },
  { type: "recent_looks", label: "最近穿搭", hint: "最近保存的衣服配搭及角色換裝", sorts: [["updated", "最近更新"], ["created", "最新建立"]], count: 6, maxCount: 18, onlyWhen: true, multi: true },
  { type: "fav_looks", label: "收藏穿搭", hint: "已收藏的穿搭及造型", sorts: [["updated", "最近更新"], ["name", "名稱"]], count: 6, maxCount: 18, onlyWhen: true, multi: true },
  { type: "analysis", label: "衣櫃分析摘要", hint: "主分類、子分類、顏色、品牌、風格", sorts: [["category", "主分類"], ["subcategory", "子分類"], ["color", "顏色"], ["brand", "品牌"], ["style", "風格"]], count: 5, maxCount: 10, multi: true },
  { type: "todo", label: "待處理事項", hint: "AI 待整理、待確認、缺少圖片、未填價格", onlyWhen: true },
  { type: "random_garment", label: "隨機衣物推薦", hint: "隨機推薦衣物；按「重新推薦」才會更換", count: 3, maxCount: 8, category: true, multi: true },
  { type: "random_look", label: "隨機穿搭", hint: "隨機顯示已保存的穿搭；按「重新推薦」才會更換", count: 1, maxCount: 3, onlyWhen: true, multi: true },
];
export const widgetSpec = (t: string) => WIDGETS.find((w) => w.type === t);

const w = (type: WidgetType, opts: WidgetOpts = {}, visible = true, size: WidgetSize = "large", display = DISPLAYS[type][0][0]): Widget => ({ id: type, type, visible, size, display, span: spanFor(type, display, size), opts });
/** 新元件（新增小工具時）：按展示方式的建議大小 */
export function newWidget(type: WidgetType, id: string, display = DISPLAYS[type][0][0], size?: WidgetSize, opts?: WidgetOpts): Widget {
  const tpl = defaultHomeLayout().widgets.find((x) => x.type === type)!;
  const sz = size ?? DISPLAYS[type].find((d) => d[0] === display)?.[2] ?? "large";
  const spec = widgetSpec(type)!;
  return { id, type, visible: true, size: sz, display, span: spanFor(type, display, sz), opts: normalizeOpts(spec, { ...tpl.opts, ...(opts ?? {}) }) };
}
/** 建議預設主頁：封面 → 簡潔概覽 → 總價 → 小型快捷操作 → 最近加入 → 最近穿搭 → 分析 → 有需要才顯示的待處理事項 */
export function defaultHomeLayout(): HomeLayout {
  return {
    v: HOME_LAYOUT_VERSION,
    widgets: [
      w("cover", { show_name: true, show_stats: true, shade: 0.55 }),
      w("overview", { title: false }, true, "medium", "row"),
      w("value", { title: false }, true, "medium"),
      w("quick", { title: false }, true, "medium"),
      w("recent", { title: true, count: 8, sort: "created" }),
      w("recent_looks", { title: true, count: 6, sort: "updated", only_when_content: true }),
      w("analysis", { title: true, mode: "category" }),
      w("todo", { title: true, only_when_content: true }, true, "medium"),
      w("favorites", { title: true, count: 8, sort: "updated", only_when_content: true }, false),
      w("updated", { title: true, count: 8, sort: "updated" }, false),
      w("fav_looks", { title: true, count: 6, sort: "updated", only_when_content: true }, false),
      w("random_garment", { title: true, count: 3 }, false),
      w("random_look", { title: true, count: 1, only_when_content: true }, false),
    ],
  };
}

const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
export function normalizeOpts(spec: WidgetSpec, o: unknown): WidgetOpts {
  const src = o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  const out: WidgetOpts = {};
  if (bool(src.title) !== undefined) out.title = src.title as boolean;
  if (spec.count !== undefined) { const n = Math.round(Number(src.count)); out.count = Number.isFinite(n) && n >= 1 ? Math.min(spec.maxCount ?? 24, n) : spec.count; }
  if (spec.sorts) out.sort = spec.sorts.some(([k]) => k === src.sort) ? String(src.sort) : spec.sorts[0][0];
  if (spec.type === "analysis") out.mode = spec.sorts!.some(([k]) => k === src.mode) ? String(src.mode) : "category";
  if (spec.category && typeof src.category === "string" && src.category.length <= 40) out.category = src.category;
  if (spec.onlyWhen && bool(src.only_when_content) !== undefined) out.only_when_content = src.only_when_content as boolean;
  const pickItems = (allowed: [string, string][]) => { if (!Array.isArray(src.items)) return; const ok = new Set(allowed.map(([k]) => k)); const list = src.items.filter((x): x is string => typeof x === "string" && ok.has(x)).filter((x, i, a) => a.indexOf(x) === i); if (list.length) out.items = list; };
  if (spec.type === "overview") pickItems(OVERVIEW_ITEMS);
  if (spec.type === "quick") pickItems(QUICK_ITEMS);
  if (spec.category && typeof src.subcategory === "string" && src.subcategory.length <= 40 && src.subcategory) out.subcategory = src.subcategory;
  if (spec.category && src.favorite === true && spec.type !== "favorites") out.favorite = true;
  if (spec.category && bool(src.detail) !== undefined) out.detail = src.detail as boolean;
  if (spec.type === "analysis") { if (src.chart === "donut" || src.chart === "bars") out.chart = src.chart; if (bool(src.show_pct) !== undefined) out.show_pct = src.show_pct as boolean; }
  if (spec.type === "cover") {
    const h = Number(src.height); if (src.height != null && Number.isFinite(h)) out.height = Math.min(140, Math.max(30, Math.round(h)));
    if (src.text_pos === "top" || src.text_pos === "bottom") out.text_pos = src.text_pos;
    out.show_name = bool(src.show_name) ?? true;
    out.show_stats = bool(src.show_stats) ?? true;
    const s = Number(src.shade); out.shade = Number.isFinite(s) ? Math.min(0.9, Math.max(0, Math.round(s * 100) / 100)) : 0.55;
    if (typeof src.name === "string" && src.name.trim()) out.name = src.name.trim().slice(0, 20);
    const py = Number(src.pos_y); if (src.pos_y != null && Number.isFinite(py)) out.pos_y = Math.min(100, Math.max(0, Math.round(py)));
    const z = Number(src.zoom); if (src.zoom != null && Number.isFinite(z)) out.zoom = Math.min(3, Math.max(1, Math.round(z * 100) / 100));
    if (src.align === "left" || src.align === "center") out.align = src.align;
  }
  if (spec.type === "recent_looks" || spec.type === "fav_looks" || spec.type === "random_look") { if (src.look_kind === "outfit" || src.look_kind === "look") out.look_kind = src.look_kind; }
  if (spec.category) for (const k of ["show_name", "show_brand", "show_category"] as const) if (bool(src[k]) !== undefined) out[k] = src[k] as boolean;
  if (spec.type === "analysis" && bool(src.legend) !== undefined) out.legend = src.legend as boolean;
  return out;
}
/** 驗證並修正布局：保留使用者次序；未知元件略去；同類（不可多個）只保留第一個；缺少的元件以隱藏狀態補在最後 */
export function normalizeHomeLayout(v: unknown): HomeLayout {
  const d = defaultHomeLayout();
  if (!v || typeof v !== "object" || !Array.isArray((v as HomeLayout).widgets)) return d;
  const seen = new Set<string>(), types = new Set<string>(), out: Widget[] = [];
  for (const raw of (v as HomeLayout).widgets.slice(0, 40)) {
    if (!raw || typeof raw !== "object") continue;
    const spec = widgetSpec(String((raw as Widget).type));
    if (!spec) continue;
    if (!spec.multi && types.has(spec.type)) continue;
    let id = typeof raw.id === "string" && /^[a-z_0-9-]{1,40}$/.test(raw.id) ? raw.id : spec.type;
    while (seen.has(id)) id = id + "_2";
    seen.add(id); types.add(spec.type);
    out.push(normalizeWidget(spec, raw, id));
  }
  for (const x of d.widgets) if (!types.has(x.type)) out.push({ ...x, visible: false });
  const updated_at = typeof (v as HomeLayout).updated_at === "string" ? (v as HomeLayout).updated_at : undefined;
  const rev = Number((v as HomeLayout).rev);
  return { v: HOME_LAYOUT_VERSION, widgets: out, ...(updated_at ? { updated_at } : {}), ...(Number.isSafeInteger(rev) && rev > 0 ? { rev } : {}) };
}

/**
 * 單一元件的大小、展示方式及欄數。舊版（v1）：compact／standard 都是全寬，升級為中型／大型全寬，
 * 展示方式按舊設定推斷（例如概覽 compact＝橫向數字列、分析 chart＝圓環／長條），外觀保持不變。
 */
export function normalizeWidget(spec: WidgetSpec, raw: Omit<Partial<Widget>, "size"> & { size?: string }, id: string): Widget {
  const opts = normalizeOpts(spec, raw.opts);
  const list = DISPLAYS[spec.type];
  const legacy = raw.size === "compact" || raw.size === "standard";
  const size: WidgetSize = raw.size === "small" || raw.size === "medium" || raw.size === "large" ? raw.size : raw.size === "compact" ? "medium" : "large";
  let display = typeof raw.display === "string" && list.some(([k]) => k === raw.display) ? raw.display : "";
  if (!display) {
    if (spec.type === "overview") display = raw.size === "compact" ? "row" : "grid";
    else if (spec.type === "analysis") display = opts.chart === "bars" ? "bars" : "donut";
    else display = list[0][0];
  }
  const span = legacy ? 2 : spanFor(spec.type, display, size, raw.span);
  return { id, type: spec.type, visible: raw.visible !== false, size, display, span, opts };
}
