-- 0014：創作工作室 V2（Phase 3.9A.2；只新增欄位及資料表，不修改、不刪除任何現有資料）
--
-- outfits.background     造型背景（BackgroundSpec JSON，版本化；NULL＝舊造型，維持原本的顯示及匯出）。
-- outfit_layers          獨立圖層：每個畫布實例有自己的 layer_id（同一衣物或素材可以有多個圖層）。
--                        舊造型沒有圖層資料時，伺服器由 outfit_items 生成穩定的圖層（g:<garment_id>），位置及次序完全不變。
--                        保存時 outfit_items 仍同步為「不重複的衣物清單」，日誌、分析等現有功能不受影響。
--                        garment_id 不設外鍵：衣物日後刪除時保留圖層紀錄（顯示為缺少圖片），由 API 處理。
-- outfit_thumbs          造型完整合成縮圖（細小 WebP／JPEG 存 D1；version 用於快取）。
-- studio_assets          工作室素材（背景、裝飾、道具、配件、其他）。in_library＝0 表示只用於某個造型（不在「我的素材庫」顯示）。
-- studio_asset_versions  素材版本：原圖及去背圖存 R2 studio/ 路徑，小縮圖存 D1。去背圖只可加入一次（重新去背＝建立新版本，
--                        共用同一原圖檔案）。造型保存所用的版本 ID 及原圖／去背圖選擇（outfit_layers.variant），
--                        之後修改素材庫不會改變已保存的造型。R2 檔案按引用清理（同一檔案被其他版本使用時保留）。
ALTER TABLE outfits ADD COLUMN background TEXT;

CREATE TABLE IF NOT EXISTS outfit_layers (
  layer_id         TEXT NOT NULL,
  outfit_id        TEXT NOT NULL REFERENCES outfits(id) ON DELETE CASCADE,
  layer_type       TEXT NOT NULL CHECK (layer_type IN ('garment','garment_part','studio_asset')),
  garment_id       TEXT,
  garment_part_id  TEXT,
  asset_id         TEXT,
  asset_version_id TEXT,
  group_id         TEXT,
  name             TEXT,
  layer_order      INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  rotation         REAL NOT NULL DEFAULT 0,
  flip_x           INTEGER NOT NULL DEFAULT 0,
  flip_y           INTEGER NOT NULL DEFAULT 0,
  opacity          REAL NOT NULL DEFAULT 1,
  hidden           INTEGER NOT NULL DEFAULT 0,
  locked           INTEGER NOT NULL DEFAULT 0,
  mask             TEXT,
  variant          TEXT NOT NULL DEFAULT 'original' CHECK (variant IN ('original','cutout')),
  PRIMARY KEY (outfit_id, layer_id)
);
CREATE INDEX IF NOT EXISTS idx_outfit_layers_garment ON outfit_layers(garment_id);
CREATE INDEX IF NOT EXISTS idx_outfit_layers_asset ON outfit_layers(asset_version_id);

CREATE TABLE IF NOT EXISTS outfit_thumbs (
  outfit_id  TEXT PRIMARY KEY REFERENCES outfits(id) ON DELETE CASCADE,
  data       BLOB NOT NULL,
  mime_type  TEXT NOT NULL,
  byte_size  INTEGER NOT NULL,
  version    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_assets (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('background','decoration','prop','accessory','other')),
  name               TEXT NOT NULL,
  is_favorite        INTEGER NOT NULL DEFAULT 0,
  in_library         INTEGER NOT NULL DEFAULT 0,
  current_version_id TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_assets_lib ON studio_assets(in_library, kind, updated_at);

CREATE TABLE IF NOT EXISTS studio_asset_versions (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL REFERENCES studio_assets(id),
  r2_key      TEXT NOT NULL,
  cutout_key  TEXT,
  cutout_size INTEGER,
  mime_type   TEXT NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  file_size   INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  has_alpha   INTEGER NOT NULL DEFAULT 0,
  thumb       BLOB,
  thumb_mime  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_versions_asset ON studio_asset_versions(asset_id, created_at);
