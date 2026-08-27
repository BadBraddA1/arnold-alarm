CREATE TABLE IF NOT EXISTS play_audit (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  label TEXT NOT NULL,
  pin_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'lan',
  status TEXT NOT NULL DEFAULT 'requested',
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_play_audit_created
  ON play_audit (created_at DESC);
