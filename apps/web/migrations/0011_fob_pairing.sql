-- One active "link my fob" session at a time (from the phone app).
CREATE TABLE IF NOT EXISTS fob_pairing (
  pin_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL
);
