-- Approved 2026-11-12; additive, nullable; retain existing looks.
ALTER TABLE doll_looks ADD COLUMN hair_style   TEXT;  -- 髮型 id，例如 'twin_tails_long'
ALTER TABLE doll_looks ADD COLUMN hair_color   TEXT;  -- 預設髮色 id 或 '#rrggbb'
ALTER TABLE doll_looks ADD COLUMN accent_color TEXT;  -- 挑染色：預設 id、'#rrggbb' 或 'original'；NULL＝跟隨髮色預設
ALTER TABLE doll_looks ADD COLUMN pose         TEXT;  -- JSON：{"shoulder_r":12,...}（度）；NULL 或 '{}'＝預設 A 字站姿
