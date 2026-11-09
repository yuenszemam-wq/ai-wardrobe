// 衣物分類字典（前端及後端共用）。
//
// - 這裡只是「預設分類」：首次使用時寫入 D1 taxonomy 表，之後使用者可在 App「分類管理」自由增加、改名、刪除、排序。
// - 每個節點有固定 ID（例如 c_dress、sleeve_length），顯示名稱可獨立修改；改名時會連帶更新已入庫衣物的值。
// - 衣物記錄保存的是顯示名稱（category、subcategory、style…），屬性存在 garments.attributes（JSON，鍵為屬性 ID）。
// - AI 不確定的欄位應留空並標記，不可強行猜測。

export interface DefaultCategory {
  id: string;
  name: string;
  subs: string[];
}

export interface DefaultAttribute {
  id: string;
  name: string;
  multi: boolean;
  /** 最多可選幾個（只適用於多選） */
  max?: number;
  /** 只在這些主分類顯示（主分類 ID）；不設定＝所有衣物都顯示 */
  showFor?: string[];
  options: string[];
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { id: "c_dress", name: "連身裙", subs: ["OP", "JSK", "吊帶裙", "背帶裙", "一般連身裙"] },
  { id: "c_top", name: "上衣", subs: ["Blouse", "T-shirt", "針織上衣", "毛衣", "衛衣", "背心", "一般上衣"] },
  { id: "c_skirt", name: "半身裙", subs: ["SK", "百褶裙", "蛋糕裙", "一般半身裙"] },
  { id: "c_outer", name: "外套", subs: ["大衣", "風衣", "斗篷／披肩", "針織外套", "西裝外套", "連帽外套", "一般外套"] },
  { id: "c_pants", name: "褲", subs: ["一般長褲", "短褲", "燈籠褲", "背帶褲", "裙褲"] },
  { id: "c_inner", name: "內搭與裙撐", subs: ["裙撐", "裙架", "襯裙", "內搭裙", "安全褲", "其他內搭"] },
  { id: "c_shoes", name: "鞋", subs: ["Lolita 鞋", "瑪麗珍鞋", "高跟鞋", "平底鞋", "靴", "運動鞋", "涼鞋", "拖鞋"] },
  { id: "c_socks", name: "襪", subs: ["一般襪", "連褲襪", "透明絲襪", "蕾絲襪", "襪套", "吊帶襪"] },
  { id: "c_head", name: "頭飾", subs: ["髮箍", "蝴蝶結", "Bonnet", "Headdress", "髮夾", "髮圈", "帽子", "頭紗", "假髮"] },
  { id: "c_bag", name: "手袋", subs: ["手提袋", "單肩袋", "斜孭袋", "背囊", "痛袋", "手拿包", "銀包"] },
  { id: "c_acc", name: "配件", subs: ["頸飾", "耳飾", "手飾", "戒指", "胸針", "領結", "腰帶／腰封", "手套／袖套", "腿飾", "其他配件"] },
  { id: "c_deco", name: "其他裝飾", subs: ["陽傘", "手杖／扇子", "可拆式裝飾", "玩偶／掛飾", "其他"] },
  { id: "c_set", name: "套裝", subs: ["兩件套", "多件套", "制服套裝", "Ouji 套裝"] },
  { id: "c_coord", name: "完整穿搭", subs: ["Coordinate"] },
];

const COLOR_OPTIONS = ["黑", "白", "灰", "粉紅", "紅", "紫", "藍", "綠", "黃", "橙", "啡", "米色", "金", "銀", "多色"];

/**
 * 屬性。style、primary_color、secondary_colors、season 四個沿用 garments 原有欄位
 * （多選以「、」分隔，secondary_colors 為 JSON 陣列），其餘存在 garments.attributes。
 */
export const DEFAULT_ATTRIBUTES: DefaultAttribute[] = [
  {
    id: "style",
    name: "風格",
    multi: true,
    options: ["Gothic Lolita", "Sweet Lolita", "Classic Lolita", "Hime Lolita", "Punk Lolita", "Wa Lolita", "Qi Lolita", "Ouji", "地雷系", "量產型", "哥德風", "哥德龐克", "學院風", "日常", "Cosplay", "其他"],
  },
  { id: "sleeve_length", name: "袖長", multi: false, showFor: ["c_top", "c_outer", "c_dress"], options: ["無袖", "短袖", "五分袖", "七分袖", "長袖", "可拆袖"] },
  { id: "top_length", name: "衣長", multi: false, showFor: ["c_top", "c_outer"], options: ["短版", "常規", "長版"] },
  { id: "skirt_length", name: "裙長", multi: false, showFor: ["c_dress", "c_skirt"], options: ["迷你", "膝上", "及膝", "過膝", "小腿", "腳踝", "拖地"] },
  { id: "pants_length", name: "褲長", multi: false, showFor: ["c_pants"], options: ["短褲", "五分", "七分", "九分", "長褲"] },
  { id: "neckline", name: "領型", multi: false, showFor: ["c_top", "c_outer", "c_dress"], options: ["圓領", "方領", "V領", "立領", "高領", "娃娃領", "水手領", "一字肩", "露肩", "其他"] },
  { id: "skirt_shape", name: "裙形", multi: false, showFor: ["c_dress", "c_skirt"], options: ["A字", "鐘形", "傘形", "蛋糕裙", "直筒", "魚尾", "不規則"] },
  { id: "heel", name: "鞋跟", multi: false, showFor: ["c_shoes"], options: ["平底", "低跟", "中跟", "高跟", "厚底"] },
  { id: "shaft_height", name: "鞋筒高度", multi: false, showFor: ["c_shoes"], options: ["低筒", "短靴", "中筒", "長靴", "過膝"] },
  { id: "sock_length", name: "襪長", multi: false, showFor: ["c_socks"], options: ["船襪", "短襪", "中筒", "及膝", "過膝", "連褲襪"] },
  { id: "primary_color", name: "主要顏色", multi: true, max: 2, options: COLOR_OPTIONS },
  { id: "secondary_colors", name: "次要顏色", multi: true, options: COLOR_OPTIONS },
  { id: "pattern_tags", name: "圖案", multi: true, options: ["素色", "格紋", "條紋", "花卉", "蕾絲", "蝴蝶結", "動物", "星月", "十字架", "教堂", "古董", "童話", "書本", "甜點", "文字", "其他"] },
  { id: "material", name: "材質", multi: true, options: ["棉", "聚酯纖維", "雪紡", "蕾絲", "薄紗", "絲絨", "緞面", "針織", "羊毛", "牛仔", "皮革", "其他"] },
  { id: "decoration", name: "裝飾元素", multi: true, options: ["蝴蝶結", "荷葉邊", "蕾絲", "刺繡", "珍珠", "鏈條", "十字架", "緞帶", "綁帶", "金屬扣", "可拆裝飾", "其他"] },
  { id: "season", name: "季節", multi: true, options: ["春", "夏", "秋", "冬"] },
  { id: "condition", name: "衣物狀態", multi: false, options: ["全新", "良好", "一般", "有瑕疵", "待清洗", "維修中"] },
  { id: "collection_status", name: "收藏狀態", multi: false, options: ["擁有", "願望清單", "已出售", "已送出"] },
  { id: "brand_confidence", name: "品牌確認", multi: false, options: ["已確認", "高度可能", "未確認"] },
];

/** 這幾個屬性存在 garments 原有欄位，不放入 attributes JSON */
export const COLUMN_ATTRIBUTES = ["style", "primary_color", "secondary_colors", "season"] as const;
export type ColumnAttribute = (typeof COLUMN_ATTRIBUTES)[number];
export const isColumnAttribute = (id: string): id is ColumnAttribute => (COLUMN_ATTRIBUTES as readonly string[]).includes(id);

// ── 舊名稱映射（升級前的資料或 AI 仍使用舊名稱時自動轉換） ──
export const LEGACY_SUBCATEGORY: Record<string, { sub: string; category: string }> = {
  Petticoat: { sub: "裙撐", category: "內搭與裙撐" },
  Headbow: { sub: "蝴蝶結", category: "頭飾" },
  KC: { sub: "髮箍", category: "頭飾" },
  Cape: { sub: "斗篷／披肩", category: "外套" },
};
export const LEGACY_COLOR: Record<string, string> = { 酒紅: "紅", 淺藍: "藍", 米白: "米色" };
export const LEGACY_SEASON: Record<string, string[]> = { 四季: ["春", "夏", "秋", "冬"] };

// ── 舊程式及 MCP 說明仍會引用的清單（以預設值為準；實際可用值以 D1 分類字典為準） ──
export const CATEGORIES = DEFAULT_CATEGORIES.map((c) => c.name);
export const LOLITA_SUBCATEGORIES = ["JSK", "OP", "SK", "Blouse", "Bonnet", "Headdress"] as const;
export const STYLES = DEFAULT_ATTRIBUTES.find((a) => a.id === "style")!.options;
export const COLORS = COLOR_OPTIONS;
export const SEASONS = ["春", "夏", "秋", "冬"];

export const GARMENT_FIELDS = [
  "name",
  "category",
  "subcategory",
  "brand",
  "style",
  "primary_color",
  "secondary_colors",
  "pattern",
  "season",
  "notes",
  "attributes",
] as const;

/** 多選欄位以「、」分隔儲存（style、primary_color、season） */
export const MULTI_SEP = "、";
export function splitMulti(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v !== "string") return [];
  return v
    .split(/[、,，/／]/)
    .map((x) => x.trim())
    .filter(Boolean);
}
export function joinMulti(list: string[]): string | null {
  const u = [...new Set(list.map((x) => x.trim()).filter(Boolean))];
  return u.length ? u.join(MULTI_SEP) : null;
}

// ── 分類字典（D1 taxonomy 表）的資料形狀 ──
export type TaxKind = "category" | "subcategory" | "attribute" | "option";
export interface TaxNode {
  id: string;
  kind: TaxKind;
  parent_id: string | null;
  name: string;
  sort_order: number;
  multi: boolean;
  max_select: number | null;
  show_for: string[] | null;
}
export interface Taxonomy {
  categories: (TaxNode & { subs: TaxNode[] })[];
  attributes: (TaxNode & { options: TaxNode[] })[];
}

/** 首次使用時寫入 D1 的預設節點（固定 ID） */
export function defaultTaxonomyRows(): TaxNode[] {
  const rows: TaxNode[] = [];
  DEFAULT_CATEGORIES.forEach((c, i) => {
    rows.push({ id: c.id, kind: "category", parent_id: null, name: c.name, sort_order: i, multi: false, max_select: null, show_for: null });
    c.subs.forEach((s, j) =>
      rows.push({ id: `${c.id}_${String(j + 1).padStart(2, "0")}`, kind: "subcategory", parent_id: c.id, name: s, sort_order: j, multi: false, max_select: null, show_for: null }),
    );
  });
  DEFAULT_ATTRIBUTES.forEach((a, i) => {
    rows.push({ id: a.id, kind: "attribute", parent_id: null, name: a.name, sort_order: i, multi: a.multi, max_select: a.max ?? null, show_for: a.showFor ?? null });
    a.options.forEach((o, j) =>
      rows.push({ id: `${a.id}_${String(j + 1).padStart(2, "0")}`, kind: "option", parent_id: a.id, name: o, sort_order: j, multi: false, max_select: null, show_for: null }),
    );
  });
  return rows;
}

export function buildTaxonomy(rows: TaxNode[]): Taxonomy {
  const byOrder = (a: TaxNode, b: TaxNode) => a.sort_order - b.sort_order || a.name.localeCompare(b.name);
  const kids = (pid: string, kind: TaxKind) => rows.filter((r) => r.kind === kind && r.parent_id === pid).sort(byOrder);
  return {
    categories: rows.filter((r) => r.kind === "category").sort(byOrder).map((c) => ({ ...c, subs: kids(c.id, "subcategory") })),
    attributes: rows.filter((r) => r.kind === "attribute").sort(byOrder).map((a) => ({ ...a, options: kids(a.id, "option") })),
  };
}

/** 衣物目前所屬主分類的 ID（以名稱對應） */
export function categoryIdOf(tax: Taxonomy, categoryName: string | null | undefined): string | null {
  if (!categoryName) return null;
  return tax.categories.find((c) => c.name === categoryName)?.id ?? null;
}

/** 某主分類應顯示的屬性（沒有選主分類時只顯示通用屬性） */
export function attributesFor(tax: Taxonomy, categoryName: string | null | undefined) {
  const cid = categoryIdOf(tax, categoryName);
  return tax.attributes.filter((a) => !a.show_for || !a.show_for.length || (cid !== null && a.show_for.includes(cid)));
}

/** 讀出衣物某屬性的值（統一為字串陣列） */
export function attributeValues(
  g: { style?: string | null; primary_color?: string | null; secondary_colors?: string[] | null; season?: string | null; attributes?: Record<string, unknown> | null },
  attrId: string,
): string[] {
  switch (attrId) {
    case "style":
      return splitMulti(g.style);
    case "primary_color":
      return splitMulti(g.primary_color);
    case "secondary_colors":
      return Array.isArray(g.secondary_colors) ? g.secondary_colors : [];
    case "season":
      return splitMulti(g.season).flatMap((s) => LEGACY_SEASON[s] ?? [s]);
    default: {
      const v = g.attributes?.[attrId];
      if (Array.isArray(v)) return v.map(String);
      return typeof v === "string" && v ? [v] : [];
    }
  }
}
