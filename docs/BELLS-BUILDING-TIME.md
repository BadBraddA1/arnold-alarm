# Building-time bells

**Status:** UI shipped — schedule First / Second bell against the building clock (America/Chicago).

## Product

1. **First bell** / **Second bell** only (period start/end, chapel, and TEST ACOC removed from the bells panel).
2. **Schedule at building time** — hour : minute + AM/PM on Central time; converts to a delay and queues on the gateway (same as before).
3. **Play now** — one-tap each bell.
4. **Cancel** — pending jobs list on the bells page (LAN) or remote queue when the PIN has remote.

## Audio (pending clips)

Wire Protect ringtone IDs on the Pi when the files are uploaded:

| Action | `ACTIONS` key | Notes |
|---|---|---|
| First bell | `bells.first` | Placeholder may still be TEST ACOC until real clip is on the NVR |
| Second bell | `bells.second` | Same |

```bash
# on Pi ~/.config/arnold-alarm/gateway.env — ACTIONS JSON
"bells.first": { "kind": "ringtone", "ringtoneId": "<id>" },
"bells.second": { "kind": "ringtone", "ringtoneId": "<id>" }
```

Then `sudo systemctl restart arnold-alarm-gateway`.

## Technical

- Worker `BELL_ACTIONS`: `bells.first:First bell,bells.second:Second bell`
- Client computes `delayMinutes` from Central wall time (max 12 hours; if time already passed today, schedules tomorrow).
- Gateway still uses relative `delayMinutes` / `setTimeout`.

## Later (optional)

- Persist schedules across Pi reboot
- Recurring weekday period schedule
