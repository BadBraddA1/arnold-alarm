#!/usr/bin/env bash
# Pull latest gateway + enable speaker-check desk notify on the Pi.
# Run ON the Pi: curl -fsSL https://raw.githubusercontent.com/BadBraddA1/arnold-alarm/main/scripts/pi-sync-notify.sh | bash
set -euo pipefail

APP_HOME="${HOME}"
REPO="${APP_HOME}/arnold-alarm"
ENV_FILE="${APP_HOME}/.config/arnold-alarm/gateway.env"
AUDIO_DIR="${APP_HOME}/.config/arnold-alarm/audio"

# Edit these for your campus desk phones (comma-separated Talk extensions):
NOTIFY_EXTS="${NOTIFY_EXTS:-0023}"
NOTIFY_LABELS="${NOTIFY_LABELS:-0023:SEC desk}"

merge_env() {
  local key="$1"
  local val="$2"
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

echo "==> Arnold Alarm — sync desk notify on Pi"
echo "    repo=$REPO"
echo "    env=$ENV_FILE"

if [[ ! -d "$REPO/.git" ]]; then
  echo "ERROR: $REPO not found — run apps/gateway/scripts/install.sh first" >&2
  exit 1
fi

cd "$REPO"
git pull --ff-only origin main

merge_env "TEST_NOTIFY_EXTS" "$NOTIFY_EXTS"
merge_env "TEST_NOTIFY_LABELS" "$NOTIFY_LABELS"
merge_env "SPEAKER_CHECK_NOTIFY_ONLY" "1"
merge_env "TEST_NOTIFY_PROMPT" "${AUDIO_DIR}/pa-sip-test-notify.pcm"
merge_env "TEST_NOTIFY_DELAY_PROMPT" "${AUDIO_DIR}/pa-sip-test-delay.pcm"

mkdir -p "$AUDIO_DIR"
missing=0
for f in pa-sip-test-notify.pcm pa-sip-test-delay.pcm pa-sip-goodbye.pcm; do
  if [[ ! -s "${AUDIO_DIR}/${f}" ]]; then
    echo "MISSING: ${AUDIO_DIR}/${f}"
    missing=1
  fi
done
if [[ "$missing" -eq 1 ]]; then
  echo ""
  echo "Copy PCM clips from your Mac (one time):"
  echo "  scp ~/.config/arnold-alarm/audio/pa-sip-*.pcm ${USER}@alarm-gw:${AUDIO_DIR}/"
  echo "Or on a Mac: bash apps/gateway/scripts/render-notify-pcm.sh all"
  echo ""
fi

cd "$REPO/apps/gateway"
pnpm install
pnpm run build
sudo systemctl restart arnold-alarm-gateway

sleep 2
echo ""
echo "==> Health (look for testNotify.configured=true and promptReady=true):"
curl -s http://127.0.0.1:8787/health | python3 -m json.tool 2>/dev/null | head -40 || curl -s http://127.0.0.1:8787/health | head -c 800
echo ""
echo "Done. Run speaker check from desk → Speaker test. SEC should ring with press-0 prompt."
