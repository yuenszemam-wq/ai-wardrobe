-- Phase 3.8B：AI Wardrobe 自身的 R2 操作統計（只新增資料表，不修改或刪除任何現有資料）。
-- 每月、每個用途、每種操作一行；Worker 每個請求結束時以原子方式累加（INSERT … ON CONFLICT DO UPDATE n = n + excluded.n）。
-- 正式及預覽環境使用各自的 D1 資料庫，所以統計天然分開；env 欄位再記錄一次以便核對。
CREATE TABLE IF NOT EXISTS r2_usage (
  month    TEXT NOT NULL,            -- YYYY-MM（UTC，與 Cloudflare 計費月份一致）
  env      TEXT NOT NULL,            -- production / preview / test
  purpose  TEXT NOT NULL,            -- originals / processed / thumbnails / outfits / doll_assets / doll_models / home_bg / other
  op       TEXT NOT NULL,            -- class_a / class_b / free
  n        INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (month, env, purpose, op)
);
