-- 0005：可編輯分類字典、衣物屬性、穿搭自由排版（只新增，不刪除舊欄位）
--
-- 分類字典：固定 ID，顯示名稱可修改。預設內容由 Worker 首次讀取時寫入（shared/taxonomy.ts）。
--   kind = category（主分類）/ subcategory（子分類，parent_id = 主分類）
--        / attribute（屬性，例如袖長）/ option（屬性選項，parent_id = 屬性）
CREATE TABLE IF NOT EXISTS taxonomy (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('category','subcategory','attribute','option')),
  parent_id  TEXT REFERENCES taxonomy(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  multi      INTEGER NOT NULL DEFAULT 0,   -- 屬性：1＝多選
  max_select INTEGER,                      -- 屬性：多選上限（例如主要顏色最多 2 個）
  show_for   TEXT,                         -- 屬性：JSON 陣列（主分類 ID）；NULL＝所有衣物
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_taxonomy_parent ON taxonomy(kind, parent_id, sort_order);

-- 衣物屬性（JSON 物件，鍵為屬性 ID，例如 {"sleeve_length":"長袖","material":["棉","蕾絲"]}）
-- 風格／主要顏色／季節沿用原有欄位（多選以「、」分隔），次要顏色沿用 secondary_colors。
ALTER TABLE garments ADD COLUMN attributes TEXT;

-- 穿搭畫布：每件單品的位置及大小（佔畫布百分比）
ALTER TABLE outfit_items ADD COLUMN x REAL;
ALTER TABLE outfit_items ADD COLUMN y REAL;
ALTER TABLE outfit_items ADD COLUMN w REAL;
ALTER TABLE outfit_items ADD COLUMN h REAL;

-- 舊資料映射（不刪除任何衣物）
UPDATE garments SET category = '內搭與裙撐', subcategory = '裙撐' WHERE subcategory = 'Petticoat';
UPDATE garments SET category = '頭飾', subcategory = '蝴蝶結' WHERE subcategory = 'Headbow';
UPDATE garments SET category = '頭飾', subcategory = '髮箍' WHERE subcategory = 'KC';
UPDATE garments SET category = '外套', subcategory = '斗篷／披肩' WHERE subcategory = 'Cape';
UPDATE garments SET primary_color = '紅' WHERE primary_color = '酒紅';
UPDATE garments SET primary_color = '藍' WHERE primary_color = '淺藍';
UPDATE garments SET primary_color = '米色' WHERE primary_color = '米白';
UPDATE garments SET secondary_colors = REPLACE(REPLACE(REPLACE(secondary_colors, '"酒紅"', '"紅"'), '"淺藍"', '"藍"'), '"米白"', '"米色"')
  WHERE secondary_colors LIKE '%酒紅%' OR secondary_colors LIKE '%淺藍%' OR secondary_colors LIKE '%米白%';
UPDATE garments SET season = '春、夏、秋、冬' WHERE season = '四季';
