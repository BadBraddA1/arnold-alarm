#!/usr/bin/env bash
# Remote Pi ops over Tailscale — no Tailscale SSH approval dance.
# Uses the same secret as cloud poll (GATEWAY_POLL_SECRET on the Pi).
set -euo pipefail

PI_URL="${ARNOLD_ALARM_PI_URL:-http://100.70.218.33:8787}"
SECRET_FILE="${ARNOLD_ALARM_AGENT_SECRET:-$HOME/.config/arnold-alarm/gateway-poll-secret}"
ACTION="${1:-health}"

if [[ ! -f "$SECRET_FILE" ]]; then
  echo "Missing secret file: $SECRET_FILE" >&2
  echo "Save GATEWAY_POLL_SECRET there (same value as Pi gateway.env)." >&2
  exit 1
fi

SECRET="$(tr -d '[:space:]' < "$SECRET_FILE")"
if [[ -z "$SECRET" ]]; then
  echo "Empty secret in $SECRET_FILE" >&2
  exit 1
fi

if [[ "$ACTION" == "health" && "${2:-}" == "" ]]; then
  curl -fsS "$PI_URL/agent?action=health" \
    -H "Authorization: Bearer $SECRET" | python3 -m json.tool 2>/dev/null || \
  curl -fsS "$PI_URL/agent?action=health" -H "Authorization: Bearer $SECRET"
  exit 0
fi

curl -fsS -X POST "$PI_URL/agent" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"$ACTION\"}" | python3 -m json.tool 2>/dev/null || \
curl -fsS -X POST "$PI_URL/agent" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"$ACTION\"}"
