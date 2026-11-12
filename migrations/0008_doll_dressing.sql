-- 0008：角色換裝（只新增資料表，不修改或刪除任何現有資料）
--
-- doll_fit_templates：每件衣物在某個角色身上的「穿著模板」（校正一次，之後自動套用）
-- doll_looks／doll_look_items：保存的造型。ov_* 是該造型的個別位置修改，
--   全部 NULL＝跟隨穿著模板（沒有模板則用分類預設位置）。
-- 座標一律是 1200×1800 邏輯畫布的像素；圖片本身只讀現有 R2 透明圖，不複製。
CREATE TABLE IF NOT EXISTS doll_fit_templates (
  garment_id TEXT NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  avatar_id  TEXT NOT NULL DEFAULT 'base_v1',
  image_id   TEXT REFERENCES garment_images(id) ON DELETE SET NULL, -- 校正時所用的透明圖
  cx REAL NOT NULL, cy REAL NOT NULL,      -- 圖片中心
  w  REAL NOT NULL,                        -- 顯示寬度；高度按圖片比例
  rotation REAL NOT NULL DEFAULT 0,        -- 度
  slot TEXT,                               -- 圖層位置覆寫；NULL＝按分類
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (garment_id, avatar_id)
);

CREATE TABLE IF NOT EXISTS doll_looks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_id TEXT NOT NULL DEFAULT 'base_v1',
  notes TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doll_looks_created ON doll_looks(created_at DESC);

CREATE TABLE IF NOT EXISTS doll_look_items (
  look_id    TEXT NOT NULL REFERENCES doll_looks(id) ON DELETE CASCADE,
  garment_id TEXT NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  z INTEGER NOT NULL DEFAULT 0,
  image_id TEXT,
  ov_cx REAL, ov_cy REAL, ov_w REAL, ov_rotation REAL, -- 全部 NULL＝跟隨模板
  PRIMARY KEY (look_id, garment_id)
);
CREATE INDEX IF NOT EXISTS idx_doll_look_items_garment ON doll_look_items(garment_id);
