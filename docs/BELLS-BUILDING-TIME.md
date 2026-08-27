# Building-time bells

**Status:** UI + campus audio wired — First / Second bell against the building clock (America/Chicago). List shows Central fire time; **Void** cancels before it fires.

## Product

1. **First bell** — `Start_Bell_Tone.mp3` on **Lobby + Fellowship** only (not hallways).
2. **Second bell** — same `Start_Bell_Tone.mp3` **twice** on all speakers (~1.5s gap).
3. **Schedule at building time** — hour : minute + AM/PM Central; LAN timer or cloud queue.
4. **See time + Void** — pending list with Central fire time; Void removes it.

## Audio on the Pi

Files in `~/.config/arnold-alarm/audio/` (talkback / sequence ACTIONS):

| File | Used by |
|---|---|
| `Start_Bell_Tone.mp3` | First + Second bell |
| `Test_Start_Tone.mp3` | PA preamble + speaker-check preamble |
| `TEST_ACOC.ogg` | Speaker check (after preamble) |
| `Code_Red_Full_Master.ogg` | Code Red (loops until All clear) |
| `Code_Blue_Master.ogg` | Code Blue (loops until All clear) |
| `Code_Green_au.ogg` | All clear ×2 |

```bash
# gateway.env ACTIONS (abridged)
"bells.first": { "kind": "sequence", "steps": [
  { "kind": "talkback", "file": "Start_Bell_Tone.mp3", "speakerIds": ["<lobby>","<fellowship>"] }
]},
"bells.second": { "kind": "sequence", "steps": [
  { "kind": "talkback", "file": "Start_Bell_Tone.mp3", "speakerIds": ["…all four…"] },
  { "kind": "wait", "ms": 1500 },
  { "kind": "talkback", "file": "Start_Bell_Tone.mp3", "speakerIds": ["…all four…"] }
]}
```

Then `sudo systemctl restart arnold-alarm-gateway`.

## Technical

- Worker `BELL_ACTIONS`: `bells.first:First bell,bells.second:Second bell`
- Client computes `delayMinutes` from Central wall time (max 12 hours).
- Gateway `sequence` action kind runs talkback / wait / ringtone steps in order.
- Emergency codes use **talkback** (not Protect `PLAY_SPEAKER`) so audio actually plays and All clear can stop a loop.
- `PA_PREAMBLE_FILE=Test_Start_Tone.mp3` (set `off` to skip).

## Later (optional)

- Persist LAN schedules across Pi reboot
- Recurring weekday period schedule
- Change which speakers get the first-bell start tone
