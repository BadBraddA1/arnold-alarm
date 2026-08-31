-- Physical fobs + 3-hour user leases (arm via app or phone IVR 4)
CREATE TABLE IF NOT EXISTS fob_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fob_leases (
  fob_id TEXT PRIMARY KEY,
  pin_id TEXT NOT NULL,
  label TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  armed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fob_leases_expires ON fob_leases (expires_at);

ALTER TABLE alarm_pins ADD COLUMN fob_id TEXT;
