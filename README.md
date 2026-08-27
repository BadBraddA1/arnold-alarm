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

- Site works on cellular; **Play** fails off campus until you’re on church Wi‑Fi (Pi unreachable).
- PINs live in **Cloudflare D1** (hashed). Sessions + play tokens are JWTs.

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

Config: `~/.config/arnold-alarm/gateway.env` — set `PROTECT_*` and `ACTIONS` JSON when Alarm Manager webhooks are ready.

## Protect (still required for sound)

1. Alarm Manager automations (play audio / text on speaker).
2. Webhook or automation IDs → gateway `ACTIONS`.
3. Same `PLAY_JWT_SECRET` as the Worker.

## Class bells UI

- Big **building clock** (America/Chicago).
- **Ring in 15 min** after service (timer on the Pi).
- Play-now buttons per automation.
