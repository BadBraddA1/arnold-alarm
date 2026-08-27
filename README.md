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
- PINs live in **Cloudflare D1** (hashed). Sessions + play tokens are JWTs.
- Recent activity on home shows who played what (Central time); stacked cards on mobile.

## Repo

```
apps/web/       Cloudflare Worker (Hono) + static UI + D1
apps/gateway/   Pi agent → Protect Alarm Manager
scripts/        Pi bootstrap
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

**Test tone — all speakers** uses the Integration API test-sound endpoint (built-in tone), not a ringtone clip.

`PROTECT_USER` / `PROTECT_PASS` must be a **local Protect admin** on the UNVR (Settings → Admins → local access). SSH `root` is not the same account.

```json
{ "kind": "talkback", "file": "Code_Blue_Master.ogg", "speakerIds": ["..."] }
```

## Protect (still required for custom clips / talkback)

1. Alarm Manager automations (play audio / text on speaker).
2. Webhook or automation IDs → gateway `ACTIONS` on the Pi (`~/.config/arnold-alarm/gateway.env`), then `sudo systemctl restart arnold-alarm-gateway`.
3. Same `PLAY_JWT_SECRET` as the Worker.

Remote play also needs Worker secret `GATEWAY_POLL_SECRET` matching the Pi, and the PIN’s **remote** scope checked in PIN admin.

## Class bells UI

- Big **building clock** (America/Chicago).
- **Ring in 15 min** after service (timer on the Pi).
- Play-now buttons per automation.

## Emergency codes UI

- **Code Red** / **Code Blue** buttons are color-matched (red / blue), large tap targets, confirm before play.
- **Stop & All clear** is green (Code Green ×2 only — not a direct Code Green play button).
- Confirm sheets tint to the same code color. Test tone stays secondary under “Speaker check”.
