-- 0016：Phase 3.9B.1 衣櫃分享（只新增資料表；不修改、不刪除任何現有資料）
--
-- share_links       可撤銷的唯讀分享連結。只保存連結權杖的 SHA-256（token_hash），連結本身只在建立／重新產生時顯示一次；
--                   重新產生＝舊連結即時失效。fields＝公開欄位白名單（JSON）；options＝公開分析等選項（JSON）。
--                   scope：selected＝只公開 share_link_items 列出的衣物；all＝全部（封存除外），share_link_items 為排除清單。
--                   revoked_at／expires_at 之後連結立即失效。view_count 只作使用者參考。
-- share_link_items  每條連結的衣物清單（公開或排除，按 scope）。衣物刪除時自動移除。
-- 公開資料一律由伺服器按白名單投影：不會公開原始相片（只提供重新編碼的縮圖及去背透明圖）、私人備註、價格（除非選擇）等。
CREATE TABLE IF NOT EXISTS share_links (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  message        TEXT,
  scope          TEXT NOT NULL DEFAULT 'selected' CHECK (scope IN ('selected','all')),
  fields         TEXT NOT NULL,
  options        TEXT NOT NULL,
  expires_at     TEXT,
  revoked_at     TEXT,
  view_count     INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS share_link_items (
  share_id   TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  garment_id TEXT NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  PRIMARY KEY (share_id, garment_id)
);
CREATE INDEX IF NOT EXISTS idx_share_items_garment ON share_link_items(garment_id);
