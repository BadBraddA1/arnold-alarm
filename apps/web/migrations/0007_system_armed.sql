-- Global arm/disarm: when unarmed, commands are logged but speakers stay silent.
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO system_settings (key, value) VALUES ('armed', '1');
