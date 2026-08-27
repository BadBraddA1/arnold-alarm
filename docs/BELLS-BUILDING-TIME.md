# Building-time bells

**Status:** UI shipped — schedule First / Second bell against the building clock (America/Chicago). List shows the scheduled Central time; **Void** cancels before it fires.

## Product

1. **First bell** / **Second bell** only (period start/end, chapel, and TEST ACOC removed from the bells panel).
2. **Schedule at building time** — hour : minute + AM/PM on Central time; converts to a delay and queues on campus (LAN timer) or in the cloud queue (remote PIN).
3. **Play now** — one-tap each bell.
4. **See time + Void** — pending list shows Central fire time and countdown; **Void** removes it (LAN gateway or cloud `/api/schedule`).

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
- **Remote:** delayed jobs stay `scheduled` in D1 with `fire_at` until due (or voided); Pi claims only when due.
- **LAN:** gateway `setTimeout` schedule; GET/DELETE `/schedule`.
- Gateway accepts delays up to 720 minutes (12h).

## Later (optional)

- Persist LAN schedules across Pi reboot
- Recurring weekday period schedule
