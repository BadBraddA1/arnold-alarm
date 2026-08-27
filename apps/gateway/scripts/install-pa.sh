#!/usr/bin/env bash
# Enable convenience PA on the gateway: SIP dial PA_EXT (default 1010) → live talkback.
# PA_TEST_EXT (default 1011) answers with a phone-only prompt (no speakers).
# Built into the Node gateway (no Asterisk). NOT for emergency use.
set -euo pipefail

ENV_FILE="${HOME}/.config/arnold-alarm/gateway.env"
PA_EXT="${PA_EXT:-1010}"
PA_TEST_EXT="${PA_TEST_EXT:-1011}"
TALK_IP="${TALK_CONSOLE_IP:-$(ip -4 route 2>/dev/null | awk '/default/ {print $3; exit}')}"
SPEAKERS="${PA_SPEAKER_IDS:-}"

echo "==> Arnold Alarm convenience PA"
echo "    Dial ${PA_EXT} → campus speakers (talkback)"
echo "    Dial ${PA_TEST_EXT} → phone-only SIP test (no speakers)"
echo "    This is NOT an emergency path."

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"

# Known campus speaker IDs if not provided
if [[ -z "$SPEAKERS" ]]; then
  SPEAKERS="6a3eee6d0024b103e44959f2,6a3b38450023b103e433fcab,6a3b3da90010b103e4341d80,6a3b06950026b103e4329ce6"
fi

python3 - <<PY
from pathlib import Path
p = Path("$ENV_FILE")
text = p.read_text() if p.exists() else ""
updates = {
  "PA_ENABLED": "1",
  "PA_EXT": "$PA_EXT",
  "PA_TEST_EXT": "$PA_TEST_EXT",
  "PA_SIP_PORT": "5060",
  "PA_SPEAKER_IDS": "$SPEAKERS",
  "PA_ACCEPT_ANY": "1",
}
# Do not set TALK_CONSOLE_IP by default — exact-IP whitelist blocks Talk phones.
lines = text.splitlines()
keys = set()
out = []
for line in lines:
  if "=" in line and not line.strip().startswith("#"):
    k = line.split("=", 1)[0].strip()
    if k in updates:
      out.append(f"{k}={updates[k]}")
      keys.add(k)
      continue
  out.append(line)
if not any("Convenience PA" in l for l in out):
  out.append("")
  out.append("# Convenience PA (SIP → talkback) — NOT for emergency")
for k, v in updates.items():
  if k not in keys:
    out.append(f"{k}={v}")
p.write_text("\n".join(out) + "\n")
print("wrote", p)
PY

grep -E '^(PA_|TALK_CONSOLE_IP=)' "$ENV_FILE" || true

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if command -v pnpm >/dev/null; then
  pnpm install
  pnpm build
else
  npm install
  npm run build
fi

sudo systemctl restart arnold-alarm-gateway
sleep 2
echo ""
curl -s http://127.0.0.1:8787/health | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin).get("pa"), indent=2))'
echo ""
LAN="$(hostname -I | awk '{print $1}')"
echo "SIP test (safe):  dial ${PA_TEST_EXT} @ ${LAN}:5060  — prompt in ear, no speakers"
echo "Live PA:           dial ${PA_EXT} @ ${LAN}:5060  — goes to campus speakers"
echo "UniFi Talk: third-party SIP provider → Pi LAN IP, UDP 5060 (console IP hint: ${TALK_IP})"
