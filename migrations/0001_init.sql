-- AI Wardrobe 初始資料表
-- 圖片檔案只存 R2；D1 只存資料及 R2 key。禁止把 Base64 圖片寫入 D1。

-- ───────── 帳戶與安全 ─────────
CREATE TABLE IF NOT EXISTS app_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 一般設定（例如首次設定碼的雜湊）
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 供 ChatGPT／Claude MCP 或外部匯入使用的存取權杖（只存 SHA-256 雜湊）
CREATE TABLE IF NOT EXISTS api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  token_hint   TEXT NOT NULL,
  scopes       TEXT NOT NULL,           -- 逗號分隔：read,import,upload,update
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

-- 每日使用量（費用及濫用控制）
CREATE TABLE IF NOT EXISTS usage_daily (
  day          TEXT NOT NULL,
  actor        TEXT NOT NULL,           -- token id 或 'session'
  calls        INTEGER NOT NULL DEFAULT 0,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, actor)
);

-- 短效圖片上傳連結（給無法直接傳送圖片的 AI 客戶端）
CREATE TABLE IF NOT EXISTS upload_tickets (
  token_hash  TEXT PRIMARY KEY,
  batch_id    TEXT REFERENCES import_batches(id) ON DELETE CASCADE,
  targets     TEXT NOT NULL,            -- JSON: [{garment_id, image_type, label}]
  expires_at  TEXT NOT NULL,
  max_files   INTEGER NOT NULL,
  used_files  INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_upload_tickets_expires ON upload_tickets(expires_at);

-- ───────── 衣物 ─────────
CREATE TABLE IF NOT EXISTS garments (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  category         TEXT,
  subcategory      TEXT,
  brand            TEXT,
  style            TEXT,
  primary_color    TEXT,
  secondary_colors TEXT,                -- JSON array
  pattern          TEXT,
  season           TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','review','archived')),
  is_favorite      INTEGER NOT NULL DEFAULT 0,
  uncertain_fields TEXT,                -- JSON array：AI 不確定的欄位
  ai_note          TEXT,                -- AI 的判斷說明
  source           TEXT,                -- manual / chatgpt / claude / api
  client_key       TEXT UNIQUE,         -- 防止重複匯入的冪等鍵
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_garments_status_created ON garments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_garments_category ON garments(category, subcategory);
CREATE INDEX IF NOT EXISTS idx_garments_style ON garments(style);
CREATE INDEX IF NOT EXISTS idx_garments_color ON garments(primary_color);
CREATE INDEX IF NOT EXISTS idx_garments_favorite ON garments(is_favorite);

CREATE TABLE IF NOT EXISTS garment_images (
  id          TEXT PRIMARY KEY,
  garment_id  TEXT NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  image_type  TEXT NOT NULL CHECK (image_type IN ('original','processed','thumbnail')),
  r2_key      TEXT NOT NULL UNIQUE,
  mime_type   TEXT NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  file_size   INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  has_alpha   INTEGER NOT NULL DEFAULT 0,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  derived_from TEXT REFERENCES garment_images(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (garment_id, image_type, sha256)
);
CREATE INDEX IF NOT EXISTS idx_gimg_garment ON garment_images(garment_id, image_type);
CREATE INDEX IF NOT EXISTS idx_gimg_sha ON garment_images(sha256);

-- ───────── 批量匯入 ─────────
CREATE TABLE IF NOT EXISTS import_batches (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  note            TEXT,
  client_ref      TEXT UNIQUE,          -- AI 可用同一個 ref 跨對話續做同一批
  total_images    INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  success_count   INTEGER NOT NULL DEFAULT 0,
  review_count    INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','finalized')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_created ON import_batches(created_at DESC);

CREATE TABLE IF NOT EXISTS import_jobs (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  client_key    TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'garment' CHECK (kind IN ('garment','outfit')),
  image_id      TEXT,                   -- garment_images.id 或 outfit_images.id
  garment_id    TEXT REFERENCES garments(id) ON DELETE SET NULL,
  outfit_id     TEXT REFERENCES outfits(id) ON DELETE SET NULL,
  label         TEXT,
  status        TEXT NOT NULL DEFAULT 'awaiting_image'
                CHECK (status IN ('awaiting_image','done','review','failed')),
  error_message TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (batch_id, client_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_batch_status ON import_jobs(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_garment ON import_jobs(garment_id);

-- ───────── 穿搭 ─────────
CREATE TABLE IF NOT EXISTS outfits (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  notes       TEXT,
  style       TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','review','archived')),
  source      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outfits_created ON outfits(created_at DESC);

CREATE TABLE IF NOT EXISTS outfit_items (
  outfit_id   TEXT NOT NULL REFERENCES outfits(id) ON DELETE CASCADE,
  garment_id  TEXT NOT NULL REFERENCES garments(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  layer_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (outfit_id, garment_id)
);
CREATE INDEX IF NOT EXISTS idx_outfit_items_garment ON outfit_items(garment_id);

-- 真人穿搭照等整套圖片
CREATE TABLE IF NOT EXISTS outfit_images (
  id         TEXT PRIMARY KEY,
  outfit_id  TEXT NOT NULL REFERENCES outfits(id) ON DELETE CASCADE,
  image_type TEXT NOT NULL CHECK (image_type IN ('original','processed','thumbnail')),
  r2_key     TEXT NOT NULL UNIQUE,
  mime_type  TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  file_size  INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  has_alpha  INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (outfit_id, image_type, sha256)
);
CREATE INDEX IF NOT EXISTS idx_oimg_outfit ON outfit_images(outfit_id);

-- ───────── 日誌 ─────────
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
