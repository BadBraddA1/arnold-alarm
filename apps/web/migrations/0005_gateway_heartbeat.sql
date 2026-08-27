CREATE TABLE IF NOT EXISTS gateway_heartbeat (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  last_seen TEXT NOT NULL,
  detail TEXT
);
