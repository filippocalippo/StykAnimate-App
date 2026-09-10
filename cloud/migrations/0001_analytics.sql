PRAGMA foreign_keys = ON;

-- One cumulative snapshot per installation per UTC day. Never append click events.
CREATE TABLE IF NOT EXISTS daily_snapshots (
  installation_id TEXT NOT NULL,
  day TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  release TEXT NOT NULL,
  platform TEXT NOT NULL,
  first_seen_day TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  upload_count INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, day)
);
CREATE INDEX IF NOT EXISTS daily_snapshots_day ON daily_snapshots(day);

CREATE TABLE IF NOT EXISTS ingestion_budget (
  day TEXT PRIMARY KEY,
  accepted_uploads INTEGER NOT NULL DEFAULT 0,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  feedback_count INTEGER NOT NULL DEFAULT 0,
  configured_limit INTEGER NOT NULL DEFAULT 12000
);
CREATE TABLE IF NOT EXISTS storage_budget (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  summary_bytes INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO storage_budget(singleton, summary_bytes) VALUES(1, 0);

CREATE TRIGGER IF NOT EXISTS snapshots_insert_budget AFTER INSERT ON daily_snapshots BEGIN
  INSERT INTO ingestion_budget(day, accepted_uploads, payload_bytes)
  VALUES(date('now'), 1, NEW.payload_bytes)
  ON CONFLICT(day) DO UPDATE SET accepted_uploads = accepted_uploads + 1, payload_bytes = payload_bytes + NEW.payload_bytes;
  UPDATE storage_budget SET summary_bytes = summary_bytes + NEW.payload_bytes WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS snapshots_update_budget AFTER UPDATE OF sequence ON daily_snapshots BEGIN
  INSERT INTO ingestion_budget(day, accepted_uploads, payload_bytes)
  VALUES(date('now'), 1, NEW.payload_bytes)
  ON CONFLICT(day) DO UPDATE SET accepted_uploads = accepted_uploads + 1, payload_bytes = payload_bytes + NEW.payload_bytes;
  UPDATE storage_budget SET summary_bytes = summary_bytes + NEW.payload_bytes - OLD.payload_bytes WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS snapshots_delete_budget AFTER DELETE ON daily_snapshots BEGIN
  UPDATE storage_budget SET summary_bytes = MAX(0, summary_bytes - OLD.payload_bytes) WHERE singleton = 1;
END;

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  contact TEXT,
  release TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS feedback_installation ON feedback(installation_id);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback(created_at);
CREATE TRIGGER IF NOT EXISTS feedback_budget AFTER INSERT ON feedback BEGIN
  INSERT INTO ingestion_budget(day, feedback_count) VALUES(date('now'), 1)
  ON CONFLICT(day) DO UPDATE SET feedback_count = feedback_count + 1;
END;

-- Irreversible aggregate totals only; excludes identities, error samples, feedback, and small cohorts.
CREATE TABLE IF NOT EXISTS daily_rollups (
  day TEXT PRIMARY KEY,
  installations INTEGER NOT NULL CHECK(installations >= 5),
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
