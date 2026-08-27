# Arnold Alarm

PIN-gated class bells + evacuation audio for **Arnold Church of Christ**, routed through a Raspberry Pi on church Wi‑Fi that talks to UniFi Protect Alarm Manager (AI speakers).

| | |
|---|---|
| **Web** | `https://alarm.arnoldcoc.org` (Vercel) |
| **Local** | `~/Code/arnold-alarm` (not iCloud) |
| **Gateway** | Pi hostname `alarm-gw` → `http://alarm-gw.local:8787` |

## How it works

1. Staff open the site (works on cellular) and enter a **6-digit PIN**.
2. PIN scopes unlock **Class bells**, **Evacuation**, and/or **PIN admin**.
3. **Play / schedule** calls the Pi on the LAN. The Pi triggers Protect Alarm Manager.
4. Off campus (cellular): UI loads; Play fails with a clear “join church Wi‑Fi” error.

```
Phone → alarm.arnoldcoc.org (PIN UI)
Phone → alarm-gw.local:8787/play  (LAN only)
Pi    → UniFi Protect NVR → AI speakers
```

## Class bells UI

- **Big building clock** — America/Chicago (building time).
- **Play now** buttons for each configured automation.
- **Ring in 15 min** — after service ends; schedule is stored **on the Pi**, so you can close the phone.

## Repo

```
apps/web/       Next.js (PIN auth, panels)
apps/gateway/   Node agent for the Pi
scripts/        Pi bootstrap
```

## Web env (`apps/web`)

Copy `.env.example` → `.env.local` (or Vercel env):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres |
| `SESSION_SECRET` | Cookie JWT secret |
| `PLAY_JWT_SECRET` | Shared with gateway |
| `NEXT_PUBLIC_GATEWAY_URL` | e.g. `http://alarm-gw.local:8787` |
| `NEXT_PUBLIC_BELL_ACTIONS` | `id:Label,id:Label` |
| `NEXT_PUBLIC_EVACUATE_ACTION` | `evacuate.main:Building evacuation` |

Seed PINs:

```bash
DATABASE_URL=... SEED_ADMIN_PIN=482901 pnpm seed:pins
```

## Pi setup (first boot)

### 1. Flash the SD

Raspberry Pi Imager → Raspberry Pi OS **Lite 64-bit**:

- Hostname: `alarm-gw`
- Enable SSH
- User/password you know
- Wi‑Fi = church SSID (or Ethernet)
- Locale timezone: **America/Chicago**

### 2. Bootstrap so Brad/Cursor can SSH in

On the Pi (keyboard/HDMI or local SSH), paste:

```bash
curl -fsSL https://raw.githubusercontent.com/BadBraddA1/arnold-alarm/main/scripts/pi-bootstrap.sh | bash
```

If the repo isn’t public yet, copy `scripts/pi-bootstrap.sh` from this machine:

```bash
# From Brad's Mac (same Wi‑Fi as the Pi):
scp ~/Code/arnold-alarm/scripts/pi-bootstrap.sh USER@PI_LAN_IP:~/
ssh USER@PI_LAN_IP 'bash ~/pi-bootstrap.sh'
```

That script:

- Installs your SSH public key
- Sets hostname `alarm-gw`
- Installs **Tailscale** with `--ssh`
- Prints LAN + Tailscale IPs — **send those back in chat**

### 3. Gateway install (Brad runs over SSH)

```bash
curl -fsSL https://raw.githubusercontent.com/BadBraddA1/arnold-alarm/main/apps/gateway/scripts/install.sh | bash
# or from a clone:
bash ~/arnold-alarm/apps/gateway/scripts/install.sh
```

Edit secrets:

```bash
nano ~/.config/arnold-alarm/gateway.env
sudo systemctl restart arnold-alarm-gateway
curl -s http://127.0.0.1:8787/health
```

### Gateway env

| Var | Purpose |
|---|---|
| `PLAY_JWT_SECRET` | Same as Vercel |
| `PROTECT_HOST` | NVR IP |
| `PROTECT_USER` / `PROTECT_PASS` | Local Protect admin |
| `PROTECT_API_KEY` | Optional Integration API key |
| `ACTIONS` | JSON map of actionId → webhook or automation |
| `CORS_ORIGIN` | `https://alarm.arnoldcoc.org` |

Example `ACTIONS`:

```json
{
  "bells.period_start": { "kind": "webhook", "url": "https://NVR/..." },
  "bells.period_end": { "kind": "webhook", "url": "https://NVR/..." },
  "bells.chapel": { "kind": "webhook", "url": "https://NVR/..." },
  "evacuate.main": { "kind": "webhook", "url": "https://NVR/..." }
}
```

## Protect checklist

1. Alarm Manager → create automations (Play audio / Play text on speaker).
2. Trigger = Webhook (or Integration run id).
3. Put webhook URLs / ids into gateway `ACTIONS`.
4. Confirm speakers are in the automation.

## DNS

CNAME `alarm` → Vercel project for `apps/web` on the `arnoldcoc.org` zone.

## Dev

```bash
cd ~/Code/arnold-alarm
pnpm install
pnpm dev                 # web :3010
pnpm dev:gateway         # gateway :8787
```
