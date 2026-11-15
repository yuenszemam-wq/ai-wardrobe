-- 0017：Cutout Studio 手動去背的來源關聯（只新增一個資料表；不修改、不刪除任何現有資料）
--
-- cutout_edits  每張由 Cutout Studio 產生的去背圖（garment_images.image_type='processed'）記錄一行：
--   image_id         去背結果圖片（刪除該圖片時自動刪除此記錄）
--   source_image_id  原始圖片。可以屬於另一件衣物（同一張穿搭相拆出多件衣物時重用同一張原圖，不重複儲存原圖）；
--                    原圖被刪除時設為 NULL（去背圖本身保留）。
--   source_sha256／source_width／source_height  原圖指紋及尺寸（重新編輯時核對原圖未被改動）
--   mask_width／mask_height  遮罩解析度（正常＝原圖尺寸；使用者選擇降解析度處理時會較小）
--   editor_version   Cutout Studio 版本；edit_summary 只保存簡短的操作統計（JSON），不保存圖片或 Base64。
-- 遮罩本身不另外存 R2：去背圖與原圖同尺寸，重新編輯時以「去背圖 alpha ÷ 原圖 alpha」還原遮罩。
-- 回復：DROP TABLE cutout_edits;（不影響衣物及圖片）
CREATE TABLE IF NOT EXISTS cutout_edits (
  image_id        TEXT PRIMARY KEY REFERENCES garment_images(id) ON DELETE CASCADE,
  source_image_id TEXT REFERENCES garment_images(id) ON DELETE SET NULL,
  source_sha256   TEXT NOT NULL,
  source_width    INTEGER NOT NULL,
  source_height   INTEGER NOT NULL,
  mask_width      INTEGER NOT NULL,
  mask_height     INTEGER NOT NULL,
  editor_version  INTEGER NOT NULL,
  edit_summary    TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cutout_edits_source ON cutout_edits(source_image_id);
