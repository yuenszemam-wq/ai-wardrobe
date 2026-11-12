-- 草案（未批准、未套用）：0009 Avatar V2 造型設定
-- 只新增可空欄位，不修改或刪除任何現有資料；舊造型四欄皆為 NULL＝沿用原本的 base_v1 行為。
-- 批准後才搬到 migrations/0009_avatar_v2.sql 並套用到正式 D1。
-- 復原：ALTER TABLE doll_looks DROP COLUMN pose;（其餘三欄同樣）並刪除 d1_migrations 該行。
--
-- avatar_id 已存在於 doll_looks 及 doll_fit_templates（0008），新角色只需使用新值 'avatar_v2'，
-- 所以 base_v1 的穿著模板與 avatar_v2 的穿著模板天然分開，互不覆寫。
ALTER TABLE doll_looks ADD COLUMN hair_style   TEXT;  -- 髮型 id，例如 'twin_tails_long'
ALTER TABLE doll_looks ADD COLUMN hair_color   TEXT;  -- 預設髮色 id 或 '#rrggbb'
ALTER TABLE doll_looks ADD COLUMN accent_color TEXT;  -- 挑染色：預設 id、'#rrggbb' 或 'original'；NULL＝跟隨髮色預設
ALTER TABLE doll_looks ADD COLUMN pose         TEXT;  -- JSON：{"shoulder_r":12,...}（度）；NULL 或 '{}'＝預設 A 字站姿
