-- Force change-on-first-login for temp PINs handed to staff.
ALTER TABLE alarm_pins ADD COLUMN must_change_pin INTEGER NOT NULL DEFAULT 0;
