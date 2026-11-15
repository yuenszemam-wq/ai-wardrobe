-- 0015：Phase 3.9A.2.1 穩定性修復（只新增欄位、資料表及索引；不修改、不刪除任何現有資料）
--
-- outfit_layers.image_id  衣物圖層保存時使用的衣物圖片版本（garment_images.id）。之後在衣櫃更換或新增透明圖，
--                         已保存的造型仍顯示當時的圖片；App 會提示「有新圖片」，由使用者明確選擇更新。
--                         舊資料為 NULL（照舊使用衣物目前的透明圖，畫面不變）；被造型使用的圖片不能刪除。
-- outfits.save_token      原子保存的比較及交換（CAS）標記：保存時在同一 D1 交易內先以 base_updated_at 更新並寫入隨機標記，
--                         再核對標記；另一部裝置同時保存時整個交易回滾並回覆 409，不會互相覆蓋圖層。
-- client_ops              冪等操作紀錄（op_id → 結果 ID）：網絡中斷後重試上傳素材或建立造型，不會重複建立。
--                         亦供 Phase 3.8C Outbox 使用。只保存識別碼及結果 ID，不保存圖片或個人資料。
-- r2_purge_queue          延遲／可重試的 R2 清理佇列：先在 D1 交易中記錄待刪除檔案，再刪除 R2；R2 失敗時保留紀錄，
--                         稍後重試，不會留下沒有紀錄的孤立檔案。刪除前再次核對沒有任何引用。
ALTER TABLE outfit_layers ADD COLUMN image_id TEXT;
CREATE INDEX IF NOT EXISTS idx_outfit_layers_image ON outfit_layers(image_id);

ALTER TABLE outfits ADD COLUMN save_token TEXT;

CREATE TABLE IF NOT EXISTS client_ops (
  op_id      TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  result_id  TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_ops_created ON client_ops(created_at);

CREATE TABLE IF NOT EXISTS r2_purge_queue (
  r2_key     TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  queued_at  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
