# Arnold Alarm

PIN-gated class bells + evacuation for **Arnold Church of Christ**. Audio goes through a Raspberry Pi on church Wi‑Fi → UniFi Protect Alarm Manager (AI speakers).

| | |
|---|---|
| **Web** | https://alarm.arnoldcoc.org (Cloudflare Worker + D1) |
| **Local** | `~/Code/arnold-alarm` |
| **Gateway** | Pi `alarm-gw` → `http://alarm-gw.local:8787` (Tailscale `100.70.218.33`) |

## Architecture

```
Phone → alarm.arnoldcoc.org (Worker + D1 PINs)
Phone → alarm-gw.local:8787/play   (LAN / church Wi‑Fi only)
Pi    → UniFi Protect NVR → AI speakers
```

- Site works on cellular. **Play** needs either church Wi‑Fi (direct to Pi) or a PIN with **remote** scope (Worker queue → Pi poll).
- PINs live in **Cloudflare D1** (hashed). Sessions expire after **45 minutes** (or **30 minutes idle**) so a left-unlocked phone does not stay armed.
- **Arm / disarm:** Admins arm/disarm and run speaker check from the <strong>Admin</strong> panel. Staff can still send bells/codes while unarmed — commands are **held** (audit log) and speakers stay silent until an admin arms again. Default is armed. **Arm state + Home activity sync live across phones** via Ably (12s poll fallback if Ably is down).
- Status distinguishes **queued on campus** vs **playing now**, and **Pi offline** vs **Protect unreachable**.
- Home shows **last play** plus recent activity (Central time). PINs with only **bells** or only **evacuate** skip Home and open that panel directly (no activity log).

## Repo

```
apps/web/       Cloudflare Worker (Hono) + static UI + D1
apps/gateway/   Pi agent → Protect Alarm Manager
scripts/        Pi bootstrap
docs/           Plans (e.g. building-time bells)
```

## Web (Cloudflare)

```bash
cd ~/Code/arnold-alarm/apps/web
pnpm install
pnpm db:migrate          # D1 migrations (remote)
pnpm deploy              # Worker + alarm.arnoldcoc.org
```

Secrets (already set in prod):

- `SESSION_SECRET`
- `PLAY_JWT_SECRET` (must match Pi `gateway.env`)

Vars in `wrangler.jsonc`: `GATEWAY_URL`, `BELL_ACTIONS`, `EVACUATE_ACTION`.

PIN admin: sign in with an admin-scoped PIN → **PIN admin**.

**Temp PINs:** check **Temp PIN** when adding someone. Leave the PIN blank to auto-generate (shown once). On first login they must set their own 6-digit PIN before bells/emergency work. Status shows “Temp — awaiting change” until they do.

## Pi gateway

Bootstrap (on Pi):

```bash
curl -fsSL https://raw.githubusercontent.com/BadBraddA1/arnold-alarm/main/scripts/pi-bootstrap.sh | bash
```

Install gateway:

```bash
curl -fsSL https://raw.githubusercontent.com/BadBraddA1/arnold-alarm/main/apps/gateway/scripts/install.sh | bash
```

Config: `~/.config/arnold-alarm/gateway.env` — `PROTECT_HOST=192.168.50.152` (COC Arnold Campus UNVR Pro), `PROTECT_API_KEY`, and `ACTIONS` JSON.

Known AI speakers (Integration API):

| Name | ID |
|---|---|
| 200 Hallway | `6a3eee6d0024b103e44959f2` |
| 100 Hallway | `6a3b38450023b103e433fcab` |
| Lobby | `6a3b3da90010b103e4341d80` |
| Fellowship hall | `6a3b06950026b103e4329ce6` |

Emergency + bell clips use Protect **ringtones** (`PLAY_SPEAKER` on all speaker MACs). Ringtone IDs must match the NVR exactly (Protect returns HTTP 200 even for bad IDs — silence). Current IDs on COC Arnold Campus UNVR:

| Clip | Ringtone ID |
|---|---|
| Code Red Full Master | `6a3b249800d9b103e4333e04` |
| Code Blue Master | `6a3ed6e8013db103e448e0d1` |
| Code Green au | `6a3be77003a4b103e436e524` |
| TEST ACOC | `6a3b089901a2b103e432add8` |

**Speaker check** plays **Test_Start_Tone.mp3**, then **TEST_ACOC.ogg**, via talkback on all AI speakers. Clips live on the Pi under `~/.config/arnold-alarm/audio/`.

**Class bells** (`bells.first` / `bells.second`) use local talkback sequences:

| Action | Behavior |
|---|---|
| First bell | `Start_Bell_Tone.mp3` on **Lobby + Fellowship** only |
| Second bell | `Start_Bell_Tone.mp3` twice on all speakers (~1.5s gap) |

**Emergency codes** also use talkback (Protect `PLAY_SPEAKER` ringtones were returning HTTP 200 with no audio):

| Action | File | Loop |
|---|---|---|
| Code Red | `Code_Red_Full_Master.ogg` | until All clear (default) |
| Code Blue | `Code_Blue_Master.ogg` | until All clear (default) |
| All clear | `Code_Green_au.ogg` ×2 | no |

**Convenience PA** plays `Test_Start_Tone.mp3` (`PA_PREAMBLE_FILE`) on the PA speakers before live talkback. Set `PA_PREAMBLE_FILE=off` to skip.

`PROTECT_USER` / `PROTECT_PASS` must be a **local Protect admin** on the UNVR (Settings → Admins → local access). SSH `root` is not the same account.

```json
{ "kind": "talkback", "file": "Code_Blue_Master.ogg", "speakerIds": ["..."] }
```

Sequence example (second bell):

```json
{
  "kind": "sequence",
  "steps": [
    { "kind": "talkback", "file": "Start_Bell_Tone.mp3", "speakerIds": ["…all…"] },
    { "kind": "wait", "ms": 1500 },
    { "kind": "talkback", "file": "Start_Bell_Tone.mp3", "speakerIds": ["…all…"] }
  ]
}
```

## Class bells UI

- Big **building clock** (America/Chicago).
- **First bell** / **Second bell** — play now, or **schedule at building time** (hour:minute AM/PM Central). Pending rings show the Central fire time with **Void** to cancel.
- Schedule survives closing the page (timer on the Pi for LAN; cloud queue for remote). See [`docs/BELLS-BUILDING-TIME.md`](docs/BELLS-BUILDING-TIME.md).

## Emergency codes UI

- **Code Red** / **Code Blue:** tap starts a **10s phone alarm** (campus silent). Arming takes over the screen — **Send now** / **Cancel** stay in view (no scroll). Phone alarm uses media playback so it still sounds with the iPhone silent switch on (volume buttons). Auto-send at 0. Then loop until All clear. Only one code at a time; All clear grayed until a code is active.
- **Stop & All clear** is green (Code Green ×2 only — not a direct Code Green play button).
- **Admin** panel: arm/disarm, live speaker status (from Protect), volume profiles, speaker check, and staff PIN management.
- **Volume profiles:** class bells play at a quieter Protect volume (default **60%**); emergency / all clear / speaker check / PA use full (**100%**). Speakers restore to emergency level after each bell so idle stays loud-ready.

## Ops / safety notes

- **Remote scope** is never implied by admin — grant sparingly in PIN admin.
- **Mid-clip stop:** Talkback streams (bells, emergency codes, PA) stop on **Stop & All clear**. Legacy Protect ringtone plays cannot be cut mid-clip if still used somewhere.
- **Ringtone ID validation:** gateway still checks NVR ringtone IDs when a ringtone ACTION is used; prefer talkback for campus clips.
- **PWA:** Add to Home Screen on iPhone (Share → Add to Home Screen). Manifest + icons ship with the Worker assets.
- **SIP PA (ext 9090):** convenience paging only — never a substitute for Code Red / Blue / All clear.

## Empty-campus verification (when people leave)

No need to re-test speakers for UI work. When the building is empty, re-verify once:

1. Test tone — walk each horn.
2. Code Blue once (short), then All clear.
3. Remote queue from cell (remote PIN) — confirm status says queued, then audio after Pi poll.

## Convenience PA (SIP dial-in — not emergency)

Office dials **9090** → live PA on campus speakers. Dial **9099** → SIP test only (Pi speaks a short prompt back to your phone; **speakers stay silent**). **Do not use for lockdown / evacuate.**

```
Talk / softphone → sip:9090@alarm-gw → Protect talkback → speakers
Talk / softphone → sip:9099@alarm-gw → prompt in earpiece only (no speakers)
```

Built into the Node gateway (`@vexyl.ai/sip`) — no Asterisk required.

### Install / enable on the Pi

```bash
cd ~/arnold-alarm/apps/gateway
git pull
TALK_CONSOLE_IP=192.168.1.1 bash scripts/install-pa.sh
```

Confirm:

```bash
curl -s http://127.0.0.1:8787/health | jq .pa
# enabled, listening, extension 9090, testExtension 9099, mode sip-ua
```

**Softphone test (safe):** dial `sip:9099@192.168.1.204` — hear the prompt, hang up. Speakers should stay quiet.

**Softphone PA:** dial `sip:9090@192.168.1.204` — speak, hang up (plays on campus speakers).

### UniFi Talk wiring

1. Talk → Settings → **Third-Party SIP Provider** → Custom → Pi LAN IP, UDP **5060**, **Register = No**.
2. Prefer **Add Third-Party Device** (extension) over short codes on a trunk — Talk dials extensions more reliably than trunk DIDs.
3. Softphone / trunk: **9099** (earpiece test), **9090** (live PA). Talk extension **0022** (when registered) plays a menu:
   - **1** = page building
   - **2** = phone-only test
   - **3** = enter PIN → choose Code Red / Blue / All clear → `#` to confirm (plays on campus when armed; logged when unarmed)

Env (`~/.config/arnold-alarm/gateway.env`): `PA_ENABLED=1`, `PA_EXT=9090`, `PA_TEST_EXT=9099`, `PA_SPEAKER_IDS=…`, `GATEWAY_POLL_SECRET`, and for Talk: `PA_TALK_HOST`, `PA_TALK_USER`, `PA_TALK_PASS`, `PA_TALK_MODE=menu`.

## Protect (optional backup / custom clips)

1. Alarm Manager automations (play audio / text on speaker) — optional backup to ringtones.
2. Webhook or automation IDs → gateway `ACTIONS` on the Pi (`~/.config/arnold-alarm/gateway.env`), then `sudo systemctl restart arnold-alarm-gateway`.
3. Same `PLAY_JWT_SECRET` as the Worker.

Remote play also needs Worker secret `GATEWAY_POLL_SECRET` matching the Pi, and the PIN’s **remote** scope checked in PIN admin.
