-- Absolute fire time for delayed/remote bell schedules (UTC ISO).
ALTER TABLE play_queue ADD COLUMN fire_at TEXT;
