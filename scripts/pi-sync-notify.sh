#!/usr/bin/env bash
# Pull latest gateway + enable speaker-check desk notify on the Pi.
# Run ON the Pi: curl -fsSL https://raw.githubusercontent.com/BadBraddA1/arnold-alarm/main/scripts/pi-sync-notify.sh | bash
set -euo pipefail

APP_HOME="${HOME}"
REPO="${APP_HOME}/arnold-alarm"
ENV_FILE="${APP_HOME}/.config/arnold-alarm/gateway.env"
AUDIO_DIR="${APP_HOME}/.config/arnold-alarm/audio"

# Physical desk phones (G3 Touch) + Adin's mobile (0023). Skip other Endpoint App lines for now.
#   0011 Left desk · 0014 Elders office · 0015 Right desk · 0023 Adin's phone
# Not in speaker check: 0013 Vanessa · 0018 Cindy · 0019 Andy · 0020 Pat (Endpoint App)
NOTIFY_EXTS="${NOTIFY_EXTS:-0023,0011,0014,0015}"
NOTIFY_LABELS="${NOTIFY_LABELS:-0023:Adin's phone,0011:Left desk,0014:Elders office,0015:Right desk}"

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
merge_env "TEST_NOTIFY_FROM" "${TEST_NOTIFY_FROM:-9090}"
merge_env "PA_MAX_CONCURRENT_CALLS" "${PA_MAX_CONCURRENT_CALLS:-8}"
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
echo "Done. Run speaker check from desk → Speaker test (0023, 0011, 0014, 0015)."
