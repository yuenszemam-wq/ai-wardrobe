-- 0011：自訂角色身體模型及姿勢庫（Phase 3.6B/C；只新增資料表，不修改或刪除任何現有資料）
--
-- doll_models            自訂身體（內置 Avatar V2 不在這裡）。revision＝目前版本。
-- doll_model_revisions   每次保存的不可變版本（def＝與 V2 不同的部件、關節、錨點、圖層及頭部對位，JSON）。
--                        造型記錄所用的模型及版本，舊造型日後仍按保存時的版本顯示。
-- doll_model_files       身體部件圖片（R2 doll/models/ 路徑），meta＝原始畫布尺寸及裁剪範圍。
-- doll_poses             我的姿勢庫（model_id NULL＝適用於所有相容身體）。
-- 衣物在每個身體上的預設繼續使用 doll_fit_templates（主鍵 garment_id＋avatar_id），avatar_id＝模型 id。
CREATE TABLE IF NOT EXISTS doll_models (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  base       TEXT NOT NULL DEFAULT 'avatar_v2',
  revision   INTEGER NOT NULL DEFAULT 1,
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  thumb      BLOB,
  thumb_mime TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS doll_model_revisions (
  model_id   TEXT NOT NULL REFERENCES doll_models(id) ON DELETE CASCADE,
  revision   INTEGER NOT NULL,
  def        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (model_id, revision)
);

CREATE TABLE IF NOT EXISTS doll_model_files (
  id         TEXT PRIMARY KEY,
  model_id   TEXT NOT NULL REFERENCES doll_models(id) ON DELETE CASCADE,
  r2_key     TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  file_size  INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doll_model_files_model ON doll_model_files(model_id);

CREATE TABLE IF NOT EXISTS doll_poses (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  model_id   TEXT,
  pose       TEXT NOT NULL,
  front      TEXT,
  thumb      BLOB,
  thumb_mime TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doll_poses_model ON doll_poses(model_id);
