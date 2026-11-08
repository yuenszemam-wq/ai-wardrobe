-- 0004：AI 待整理流程（向後相容：只新增欄位及資料表，不修改或刪除舊欄位）
--
-- App 批量上傳 → 衣物以「待整理衣物 NNN」建立，ai_status = 'pending_ai'
-- → ChatGPT／Claude 讀取待整理清單及短效圖片網址，提交 ai_suggestions（不直接改 garments）
-- → Worker 驗證建議 → ai_status = 'pending_review'
-- → 使用者在 App 確認（全部／部分欄位）後才正式寫入 garments。

-- ai_status：NULL＝舊資料（不在 AI 流程內）
--   pending_ai      待 AI 辨認
--   ai_processing   AI 整理中（有租約，逾時自動退回 pending_ai）
--   pending_review  待人工確認
--   done            已完成
--   failed          辨認失敗
--   needs_rework    需要重新處理
ALTER TABLE garments ADD COLUMN ai_status TEXT
  CHECK (ai_status IS NULL OR ai_status IN ('pending_ai','ai_processing','pending_review','done','failed','needs_rework'));
ALTER TABLE garments ADD COLUMN display_no INTEGER;                       -- 「待整理衣物 001」的編號
ALTER TABLE garments ADD COLUMN name_is_placeholder INTEGER NOT NULL DEFAULT 0;
ALTER TABLE garments ADD COLUMN locked_fields TEXT;                       -- JSON array：人工修正過、AI 不可覆寫的欄位
ALTER TABLE garments ADD COLUMN version INTEGER NOT NULL DEFAULT 1;       -- 每次修改 +1；AI 建議須附上讀取時的版本
ALTER TABLE garments ADD COLUMN ai_claimed_at TEXT;                       -- AI 整理中的租約開始時間
ALTER TABLE garments ADD COLUMN ai_claimed_by TEXT;
ALTER TABLE garments ADD COLUMN ai_updated_at TEXT;                       -- 最後一次 AI 提交建議的時間
ALTER TABLE garments ADD COLUMN ai_error TEXT;

-- HEIC 原檔另存的 JPEG 預覽：image_type='original'、variant='preview'、derived_from 指向 HEIC 原檔
ALTER TABLE garment_images ADD COLUMN variant TEXT;

CREATE INDEX IF NOT EXISTS idx_garments_ai_status ON garments(ai_status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_garments_display_no ON garments(display_no) WHERE display_no IS NOT NULL;

-- AI 建議：每次提交一行，永不直接覆寫正式資料
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  garment_id       TEXT NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  idempotency_key  TEXT NOT NULL UNIQUE,      -- 重試同一 key 不會重複建立
  base_version     INTEGER NOT NULL,          -- AI 讀取時的 garments.version
  source           TEXT NOT NULL DEFAULT 'chatgpt',   -- chatgpt / claude / 其他
  image_id         TEXT,                      -- AI 實際查看的圖片
  vision_checked   INTEGER NOT NULL DEFAULT 0,-- AI 聲明已實際查看圖片像素（1）；只看 metadata 必須為 0
  payload          TEXT NOT NULL,             -- AI 提交的原始 JSON
  normalized       TEXT,                      -- 驗證後的欄位 JSON
  status           TEXT NOT NULL DEFAULT 'submitted'
                   CHECK (status IN ('submitted','valid','invalid','accepted','partially_accepted','rejected','superseded')),
  error_message    TEXT,
  accepted_fields  TEXT,                      -- JSON array：使用者接受的欄位
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  validated_at     TEXT,
  decided_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_sugg_garment ON ai_suggestions(garment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_sugg_status ON ai_suggestions(status, created_at);

-- 短效簽名圖片網址（Worker 每分鐘為待整理衣物產生；網址以 HMAC 簽名，過期即失效）
CREATE TABLE IF NOT EXISTS ai_image_links (
  image_id    TEXT PRIMARY KEY,
  garment_id  TEXT NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,                  -- analysis（原圖或 HEIC 預覽）/ thumbnail
  url         TEXT NOT NULL,
  width       INTEGER,
  height      INTEGER,
  mime_type   TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_links_garment ON ai_image_links(garment_id);
