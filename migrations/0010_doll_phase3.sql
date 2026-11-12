-- 0010：角色換裝 Phase 3（只新增欄位及資料表；不修改或刪除任何現有資料）
--
-- doll_looks.state        完整造型狀態（JSON）：頭部、髮型、髮色、姿勢、衣物次序、隱藏、穿法及個別調整。
--                         舊造型此欄為 NULL，開啟時由 doll_look_items 讀出並換算，保存後才寫入。
-- doll_fit_templates.data 衣物預設穿著設定（JSON）：跟隨骨架方式、後領、遮罩、建議姿勢、其他穿法。
-- doll_look_thumbs        造型縮圖（實際組裝完成的角色畫面，細小 JPEG 存 D1）。
-- doll_assets／doll_asset_files  角色素材（頭部、髮型、衣物額外部件）；圖片檔存 R2 的 doll/ 路徑。
ALTER TABLE doll_looks ADD COLUMN state TEXT;
ALTER TABLE doll_fit_templates ADD COLUMN data TEXT;

CREATE TABLE IF NOT EXISTS doll_look_thumbs (
  look_id    TEXT PRIMARY KEY REFERENCES doll_looks(id) ON DELETE CASCADE,
  data       BLOB NOT NULL,
  mime_type  TEXT NOT NULL,
  byte_size  INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doll_assets (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('head','hair','garment_part')),
  name       TEXT NOT NULL,
  category   TEXT,
  garment_id TEXT REFERENCES garments(id) ON DELETE CASCADE,  -- 只限 garment_part
  config     TEXT,                                            -- JSON：部件位置、圖層、骨骼、染色設定
  thumb      BLOB,
  thumb_mime TEXT,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doll_assets_kind ON doll_assets(kind, status);
CREATE INDEX IF NOT EXISTS idx_doll_assets_garment ON doll_assets(garment_id);

CREATE TABLE IF NOT EXISTS doll_asset_files (
  id         TEXT PRIMARY KEY,
  asset_id   TEXT NOT NULL REFERENCES doll_assets(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  file_size  INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doll_asset_files_asset ON doll_asset_files(asset_id);
