CREATE TABLE IF NOT EXISTS play_queue (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  pin_id TEXT NOT NULL,
  label TEXT NOT NULL,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_play_queue_status_created
  ON play_queue (status, created_at);
