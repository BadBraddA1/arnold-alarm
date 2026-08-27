# Building-time bells (plan)

**Goal:** Schedule class bells against the **building clock** (America/Chicago), not only “ring in 15 minutes from now.”

Today the bells page shows Central time and supports a relative delay (`POST /schedule` with `delayMinutes`). Staff still have to do the math for “period ends at 10:15.”

## Product shape

1. **Pick a bell** (period end / chapel / etc.).
2. **Pick a building time** — time-of-day on the campus clock (e.g. 10:15 AM Central).
3. **Confirm** — show “Rings at 10:15 AM Central (in 12 min)” before arming.
4. **Survives closing the phone** — job lives on the Pi gateway (same as today).
5. **Cancel** — same scheduled list UI.

Optional later: recurring weekday period schedule (stored on gateway or Worker), not required for v1.

## Technical approach

| Piece | Change |
|---|---|
| UI (`apps/web/public`) | Time picker (hour/minute + AM/PM) next to “Ring in 15 min”; compute `delayMinutes` from building clock vs now in `America/Chicago`. |
| Gateway | Keep relative `delayMinutes` for v1 **or** add `fireAt` (epoch ms) / `atLocal` (`HH:mm` + timezone) so the Pi owns the clock math. Prefer **`fireAt` UTC ms** computed on the client from Central wall time — avoids Pi TZ drift if Pi timezone is wrong. |
| Remote queue | Extend Worker queue job with optional `fireAt`; Pi schedules with `setTimeout` until fire (cap max horizon, e.g. 12 hours). |
| DST | Always compute with `America/Chicago` (Temporal or careful `Intl`/`date-fns-tz`). Never use browser local TZ for fire time. |
| Safety | Reject past times; confirm if within 60s; max one pending job per action unless staff cancels. |

## UX sketch

```
[ Building clock  9:58:12 AM ]

Ring at building time
  [ 10 ] : [ 15 ]  [ AM ▾ ]   Bell: Period end ▾
  [ Schedule ring ]

After service (shortcut)
  [ Ring period end in 15 min ]
```

## Rollout

1. Ship absolute-time UI that converts to existing `delayMinutes` (no gateway change) — fastest.
2. If jobs span reboot or long delays matter, persist schedules on the Pi (`~/.config/arnold-alarm/schedules.json`) and restore timers on gateway start.
3. Only then add recurring weekly periods if the school asks.

## Out of scope for first pass

- Syncing UniFi Protect automation schedules
- Multi-building timezones
- Calendar import

## Acceptance

- Staff can set “ring at 10:15” while looking at the building clock and hear the bell within a few seconds of 10:15 Central.
- Cancel works from the same phone (on Wi‑Fi) or remote PIN.
- README + bells UI copy updated; no speaker test required to ship the UI (verify once on an empty campus).
