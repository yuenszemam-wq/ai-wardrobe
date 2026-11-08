// 衣物分類（前端及後端共用）。全部可手動修正；AI 不確定時應留空並標記，不可強行猜測。

export const CATEGORIES = [
  "連身裙",
  "上衣",
  "半身裙",
  "外套",
  "褲",
  "鞋",
  "襪",
  "頭飾",
  "手袋",
  "配件",
  "完整穿搭",
] as const;

export const LOLITA_SUBCATEGORIES = [
  "JSK",
  "OP",
  "SK",
  "Blouse",
  "Petticoat",
  "Bonnet",
  "Headbow",
  "KC",
  "Cape",
] as const;

export const STYLES = [
  "Gothic Lolita",
  "Sweet Lolita",
  "Classic Lolita",
  "Hime Lolita",
  "Ouji",
  "地雷系",
  "其他",
] as const;

export const COLORS = [
  "黑",
  "白",
  "粉紅",
  "紫",
  "紅",
  "酒紅",
  "藍",
  "淺藍",
  "綠",
  "黃",
  "米白",
  "啡",
  "灰",
  "金",
  "銀",
  "多色",
] as const;

export const SEASONS = ["春", "夏", "秋", "冬", "四季"] as const;

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
] as const;

/** 子類 → 建議主類（只作提示，不會強制） */
export const SUBCATEGORY_HINT: Record<string, string> = {
  JSK: "連身裙",
  OP: "連身裙",
  SK: "半身裙",
  Blouse: "上衣",
  Petticoat: "半身裙",
  Bonnet: "頭飾",
  Headbow: "頭飾",
  KC: "頭飾",
  Cape: "外套",
};
