/**
 * 主頁自訂布局（Phase 3.8A）：可新增、隱藏、排序的資訊元件，每個元件有自己的設定。
 * 伺服器以 app_settings.home_layout 保存正式設定（有版本）；手機另存一份最新快取，開啟 App 時直接使用。
 * 前端及 Worker 共用同一套驗證，未知元件或設定會被略去，舊版本自動升級。
 */
export const HOME_LAYOUT_VERSION = 1;

export type WidgetType =
  | "cover" | "overview" | "value" | "quick" | "recent" | "updated" | "favorites"
  | "recent_looks" | "fav_looks" | "analysis" | "todo" | "random_garment" | "random_look";
export type WidgetSize = "compact" | "standard";
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
}
export interface Widget { id: string; type: WidgetType; visible: boolean; size: WidgetSize; opts: WidgetOpts }
export interface HomeLayout { v: number; widgets: Widget[]; updated_at?: string }

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
  { type: "overview", label: "衣櫃概覽", hint: "衣物總數、收藏、待整理、待確認、已完成、缺少圖片、未填價格" },
  { type: "value", label: "衣櫃總價", hint: "已填價格的合計及數目，進入詳細分析" },
  { type: "quick", label: "快捷操作", hint: "上傳、衣服配搭、角色換裝、衣服設定、衣櫃分析" },
  { type: "recent", label: "最近加入衣物", hint: "最新加入的衣物", sorts: [["created", "最新加入"], ["created_asc", "最早加入"]], count: 8, maxCount: 24, multi: true, category: true },
  { type: "updated", label: "最近修改衣物", hint: "最近修改過資料的衣物", sorts: [["updated", "最近修改"]], count: 8, maxCount: 24, multi: true, category: true },
  { type: "favorites", label: "收藏衣物", hint: "已收藏的衣物", sorts: [["updated", "最近修改"], ["created", "最新加入"], ["name", "名稱"], ["price_desc", "價錢高至低"]], count: 8, maxCount: 24, category: true, onlyWhen: true },
  { type: "recent_looks", label: "最近穿搭", hint: "最近保存的衣服配搭及角色換裝", sorts: [["updated", "最近更新"], ["created", "最新建立"]], count: 6, maxCount: 18, onlyWhen: true },
  { type: "fav_looks", label: "收藏穿搭", hint: "已收藏的穿搭及造型", sorts: [["updated", "最近更新"], ["name", "名稱"]], count: 6, maxCount: 18, onlyWhen: true },
  { type: "analysis", label: "衣櫃分析摘要", hint: "主分類、子分類、顏色、品牌、風格", sorts: [["category", "主分類"], ["subcategory", "子分類"], ["color", "顏色"], ["brand", "品牌"], ["style", "風格"]] },
  { type: "todo", label: "待處理事項", hint: "AI 待整理、待確認、缺少圖片、未填價格", onlyWhen: true },
  { type: "random_garment", label: "隨機衣物推薦", hint: "每次開啟隨機推薦衣物", count: 3, maxCount: 8, category: true },
  { type: "random_look", label: "隨機穿搭", hint: "隨機顯示一套已保存的穿搭", count: 1, maxCount: 3, onlyWhen: true },
];
export const widgetSpec = (t: string) => WIDGETS.find((w) => w.type === t);

const w = (type: WidgetType, opts: WidgetOpts = {}, visible = true, size: WidgetSize = "standard"): Widget => ({ id: type, type, visible, size, opts });
/** 建議預設主頁：封面 → 簡潔概覽 → 總價 → 小型快捷操作 → 最近加入 → 最近穿搭 → 分析 → 有需要才顯示的待處理事項 */
export function defaultHomeLayout(): HomeLayout {
  return {
    v: HOME_LAYOUT_VERSION,
    widgets: [
      w("cover", { show_name: true, show_stats: true, shade: 0.55 }),
      w("overview", { title: false }, true, "compact"),
      w("value", { title: false }, true, "compact"),
      w("quick", { title: false }, true, "compact"),
      w("recent", { title: true, count: 8, sort: "created" }),
      w("recent_looks", { title: true, count: 6, sort: "updated", only_when_content: true }),
      w("analysis", { title: true, mode: "category" }),
      w("todo", { title: true, only_when_content: true }, true, "compact"),
      w("favorites", { title: true, count: 8, sort: "updated", only_when_content: true }, false),
      w("updated", { title: true, count: 8, sort: "updated" }, false),
      w("fav_looks", { title: true, count: 6, sort: "updated", only_when_content: true }, false),
      w("random_garment", { title: true, count: 3 }, false),
      w("random_look", { title: true, count: 1, only_when_content: true }, false),
    ],
  };
}

const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
function normalizeOpts(spec: WidgetSpec, o: unknown): WidgetOpts {
  const src = o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  const out: WidgetOpts = {};
  if (bool(src.title) !== undefined) out.title = src.title as boolean;
  if (spec.count !== undefined) { const n = Math.round(Number(src.count)); out.count = Number.isFinite(n) && n >= 1 ? Math.min(spec.maxCount ?? 24, n) : spec.count; }
  if (spec.sorts) out.sort = spec.sorts.some(([k]) => k === src.sort) ? String(src.sort) : spec.sorts[0][0];
  if (spec.type === "analysis") out.mode = spec.sorts!.some(([k]) => k === src.mode) ? String(src.mode) : "category";
  if (spec.category && typeof src.category === "string" && src.category.length <= 40) out.category = src.category;
  if (spec.onlyWhen && bool(src.only_when_content) !== undefined) out.only_when_content = src.only_when_content as boolean;
  if (spec.type === "cover") {
    out.show_name = bool(src.show_name) ?? true;
    out.show_stats = bool(src.show_stats) ?? true;
    const s = Number(src.shade); out.shade = Number.isFinite(s) ? Math.min(0.9, Math.max(0, Math.round(s * 100) / 100)) : 0.55;
    if (typeof src.name === "string" && src.name.trim()) out.name = src.name.trim().slice(0, 20);
  }
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
    out.push({ id, type: spec.type, visible: raw.visible !== false, size: raw.size === "compact" ? "compact" : "standard", opts: normalizeOpts(spec, raw.opts) });
  }
  for (const x of d.widgets) if (!types.has(x.type)) out.push({ ...x, visible: false });
  const updated_at = typeof (v as HomeLayout).updated_at === "string" ? (v as HomeLayout).updated_at : undefined;
  return { v: HOME_LAYOUT_VERSION, widgets: out, ...(updated_at ? { updated_at } : {}) };
}
