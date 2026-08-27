-- Emergency code cycle: idle → red|blue → idle (after all clear).
INSERT OR IGNORE INTO system_settings (key, value) VALUES ('evac_phase', 'idle');
