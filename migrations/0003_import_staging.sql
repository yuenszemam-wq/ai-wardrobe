-- 0003：D1 暫存匯入（給只能經 Cloudflare D1 API 寫入的 AI，例如 ChatGPT 的 Cloudflare 連接器）
--
-- AI 把圖片 Base64 分段寫入 import_staging（每段建議 ≤ 1,000,000 字元，D1 每行上限 2 MB），
-- 並提交它自己計算的原檔 SHA-256。Worker 每分鐘自動處理：
--   接回各段 → 解碼 → 核對 SHA-256 → 沿用上傳槽流程（驗證尺寸／透明 → 先寫 R2 → 成功後才寫 D1 衣物記錄）
--   → 清除暫存 Base64，只保留結果。
-- Base64 只會短暫存在這個表，處理後即清空；正式圖片只存 R2。

CREATE TABLE IF NOT EXISTS import_staging (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  client_ref      TEXT NOT NULL,            -- 批次識別碼，例如 2026-11-08-chatgpt-1
  client_key      TEXT NOT NULL,            -- 批次內每件衣物唯一，例如 01
  part_no         INTEGER NOT NULL DEFAULT 1,
  part_count      INTEGER NOT NULL DEFAULT 1,
  data            TEXT NOT NULL,            -- Base64（此段）；處理後清空
  sha256          TEXT,                     -- 原檔 SHA-256（hex），每件只需在第 1 段填寫
  file_name       TEXT,
  image_type      TEXT NOT NULL DEFAULT 'processed' CHECK (image_type IN ('original','processed')),
  expected_width  INTEGER,
  expected_height INTEGER,
  garment_json    TEXT,                     -- 衣物資料 JSON（name、category、subcategory、style、primary_color…）
  source          TEXT NOT NULL DEFAULT 'chatgpt',
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','processing','done','duplicate','failed')),
  error_message   TEXT,
  garment_id      TEXT,
  batch_id        TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at    TEXT,
  UNIQUE (client_ref, client_key, part_no)
);
CREATE INDEX IF NOT EXISTS idx_staging_status ON import_staging(status, created_at);
