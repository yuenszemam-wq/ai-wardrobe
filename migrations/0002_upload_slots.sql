-- 0002：批量二進位上傳槽（R2 先寫，成功後才寫 D1 衣物記錄）
--
-- 每個「上傳槽」代表一件待匯入的衣物：AI 先提交衣物資料及預期檔名／解像度，
-- 伺服器只預留 garment_id，不建立 garments 記錄。
-- 圖片以二進位 PUT 到短效網址 → 驗證 → 寫入 R2 → 成功後才在同一個 D1 batch 內
-- 建立 garments、garment_images、import_jobs。D1 失敗會刪除 R2 物件並可重試。

CREATE TABLE IF NOT EXISTS upload_slots (
  id              TEXT PRIMARY KEY,
  ticket_hash     TEXT REFERENCES upload_tickets(token_hash) ON DELETE SET NULL,
  batch_id        TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  client_key      TEXT NOT NULL,
  label           TEXT,
  file_name       TEXT,                  -- 預期檔名，上傳頁用來自動配對
  image_type      TEXT NOT NULL DEFAULT 'processed' CHECK (image_type IN ('original','processed')),
  garment_id      TEXT NOT NULL,         -- 預留 id；圖片寫入 R2 成功後才建立 garments 記錄
  garment_json    TEXT NOT NULL,         -- 衣物資料（JSON）
  needs_review    INTEGER NOT NULL DEFAULT 0,
  expected_width  INTEGER,               -- 若提供，上傳尺寸必須完全相同（防止被縮小）
  expected_height INTEGER,
  require_alpha   INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','uploading','done','duplicate','failed')),
  lock_until      TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  image_id        TEXT,
  r2_key          TEXT,
  sha256          TEXT,
  mime_type       TEXT,
  width           INTEGER,
  height          INTEGER,
  file_size       INTEGER,
  has_alpha       INTEGER,
  job_id          TEXT,
  duplicate_of    TEXT,                  -- 重複時指向已存在的 garment_id
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (batch_id, client_key)
);
CREATE INDEX IF NOT EXISTS idx_slots_ticket ON upload_slots(ticket_hash, position);
CREATE INDEX IF NOT EXISTS idx_slots_batch ON upload_slots(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_slots_sha ON upload_slots(sha256);
