-- Alarm PINs (hashed) + login rate limits
CREATE TABLE IF NOT EXISTS alarm_pins (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pin_rate_limits (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT (datetime('now'))
);
