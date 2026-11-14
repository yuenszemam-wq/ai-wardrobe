-- 0013：穿搭日誌（Phase 3.9A.1；只新增資料表，不修改或刪除任何現有資料）
--
-- diary_entries  每筆穿搭紀錄。worn_date＝使用者本地日期（YYYY-MM-DD，由手機按本地時區計算，伺服器不作 UTC 轉換）。
--                kind：worn（已穿著，只有這類計入穿著統計）／planned（計劃）／inspiration（靈感）。
--                outfit_id／look_id 只是關聯（不設外鍵）：原造型日後修改或刪除，紀錄仍保留 snapshot（當時名稱）。
-- diary_items    實際穿著衣物。garment_id 不設外鍵：衣物日後刪除或封存，歷史紀錄仍保留當時名稱、分類及縮圖快照。
--                part＝套裝部件 id（空字串＝整件）。同一件衣物的多個部件只計一件衣物。
-- diary_snaps    衣物縮圖快照（由 D1 小縮圖複製，最多約 30 KB；按「衣物＋縮圖來源雜湊」去重，多筆紀錄共用，不複製高清圖）。
-- diary_photos   真人穿搭照片：圖片檔存 R2 diary/ 路徑（已在手機壓縮並移除 EXIF／GPS），小縮圖存 D1。
CREATE TABLE IF NOT EXISTS diary_entries (
  id           TEXT PRIMARY KEY,
  title        TEXT,
  worn_date    TEXT NOT NULL CHECK (worn_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  worn_time    TEXT,
  kind         TEXT NOT NULL DEFAULT 'worn' CHECK (kind IN ('worn','planned','inspiration')),
  outfit_id    TEXT,
  look_id      TEXT,
  source_name  TEXT,
  occasion     TEXT,
  location     TEXT,
  weather      TEXT,
  tags         TEXT,
  notes        TEXT,
  rating       INTEGER,
  is_favorite  INTEGER NOT NULL DEFAULT 0,
  cover_photo_id TEXT,
  tz           TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_date ON diary_entries(worn_date, worn_time);
CREATE INDEX IF NOT EXISTS idx_diary_kind ON diary_entries(kind, worn_date);

CREATE TABLE IF NOT EXISTS diary_snaps (
  id         TEXT PRIMARY KEY,
  garment_id TEXT NOT NULL,
  data       BLOB NOT NULL,
  mime_type  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS diary_items (
  entry_id    TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
  garment_id  TEXT NOT NULL,
  part        TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  name        TEXT NOT NULL,
  category    TEXT,
  subcategory TEXT,
  style       TEXT,
  snap_id     TEXT,
  PRIMARY KEY (entry_id, garment_id, part)
);
CREATE INDEX IF NOT EXISTS idx_diary_items_garment ON diary_items(garment_id);

CREATE TABLE IF NOT EXISTS diary_photos (
  id         TEXT PRIMARY KEY,
  entry_id   TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL UNIQUE,
  mime_type  TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  file_size  INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  thumb      BLOB,
  thumb_mime TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_photos_entry ON diary_photos(entry_id, position);
