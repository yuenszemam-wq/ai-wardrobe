-- 0018：AI Lab Phase 1（Workers AI 衣物辨認）使用記錄及配額（只新增資料表；不修改、不刪除任何現有資料）
--
-- ai_usage_events   每次模型呼叫（包括重試及「測試連線」）一行。只保存技術資料，不保存圖片、Base64 或完整 AI 回答。
--                   request_id 唯一：重複 request_id 不會再次呼叫模型。實際用量未知時保持 NULL，不填虛構數值。
-- ai_usage_daily    每日（UTC 日期，與 Workers AI 免費額度重設時間一致）呼叫次數、已預留／結算的 Neurons、進行中數量。
-- ai_usage_monthly  每月（UTC）呼叫次數。
-- 配額以條件式 UPDATE 原子預留，前端不能修改；設定（開關、較低上限、Kill Switch）存在 app_settings key 'ai_lab'。
-- 回復：DROP TABLE ai_usage_events; DROP TABLE ai_usage_daily; DROP TABLE ai_usage_monthly;（不影響衣物及 ai_suggestions）
CREATE TABLE IF NOT EXISTS ai_usage_events (
  request_id             TEXT PRIMARY KEY,
  user_id                TEXT,
  garment_id             TEXT,
  provider               TEXT NOT NULL,
  model_id               TEXT NOT NULL,
  prompt_version         TEXT NOT NULL,
  operation_type         TEXT NOT NULL,           -- recognize / retry / test
  request_status         TEXT NOT NULL,           -- reserved / success / invalid_output / failed / timeout / uncertain
  cache_key              TEXT,
  estimated_input_tokens INTEGER,
  actual_input_tokens    INTEGER,
  actual_output_tokens   INTEGER,
  reserved_neurons       REAL NOT NULL DEFAULT 0,
  estimated_neurons      REAL,
  actual_neurons         REAL,
  estimated_cost_usd     REAL,
  usage_source           TEXT,                    -- model_usage / estimate / none
  pricing_version        TEXT,
  latency_ms             INTEGER,
  suggestion_id          INTEGER,
  error_code             TEXT,
  day                    TEXT NOT NULL,
  created_at             TEXT NOT NULL,
  settled_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_day ON ai_usage_events(day, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_garment ON ai_usage_events(garment_id, created_at);

CREATE TABLE IF NOT EXISTS ai_usage_daily (
  day        TEXT PRIMARY KEY,                    -- YYYY-MM-DD（UTC）
  requests   INTEGER NOT NULL DEFAULT 0,
  neurons    REAL NOT NULL DEFAULT 0,             -- 預留＋已結算（保守）
  inflight   INTEGER NOT NULL DEFAULT 0,
  success    INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_usage_monthly (
  month      TEXT PRIMARY KEY,                    -- YYYY-MM（UTC）
  requests   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
