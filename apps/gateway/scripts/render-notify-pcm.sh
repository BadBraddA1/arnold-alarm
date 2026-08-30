#!/usr/bin/env bash
# Render 8 kHz mono s16le PCM clips for speaker-check desk notify (macOS say + ffmpeg).
# Usage:
#   bash scripts/render-notify-pcm.sh notify
#   bash scripts/render-notify-pcm.sh delay
#   bash scripts/render-notify-pcm.sh goodbye
set -euo pipefail

OUT_DIR="${1:-${HOME}/.config/arnold-alarm/audio}"
MODE="${2:-all}"
mkdir -p "$OUT_DIR"

render() {
  local name="$1"
  local text="$2"
  local aiff="/tmp/arnold-alarm-${name}.aiff"
  local pcm="${OUT_DIR}/${name}.pcm"
  echo "==> ${name}: ${text}"
  say -o "$aiff" "$text"
  ffmpeg -y -loglevel error -i "$aiff" -ar 8000 -ac 1 -f s16le "$pcm"
  rm -f "$aiff"
  echo "    wrote ${pcm}"
}

case "$MODE" in
  notify)
    render "pa-sip-test-notify" \
      "Stand by for a speaker test on campus. Press zero to delay the test."
    ;;
  delay)
    render "pa-sip-test-delay" \
      "Okay. Delaying the speaker test for a few minutes."
    ;;
  goodbye)
    render "pa-sip-goodbye" "Goodbye."
    ;;
  all)
    render "pa-sip-test-notify" \
      "Stand by for a speaker test on campus. Press zero to delay the test."
    render "pa-sip-test-delay" \
      "Okay. Delaying the speaker test for a few minutes."
    render "pa-sip-goodbye" "Goodbye."
    ;;
  *)
    echo "Usage: $0 [out-dir] notify|delay|goodbye|all" >&2
    exit 1
    ;;
esac

echo "Done. Set on the Pi if needed:"
echo "  TEST_NOTIFY_PROMPT=${OUT_DIR}/pa-sip-test-notify.pcm"
echo "  TEST_NOTIFY_DELAY_PROMPT=${OUT_DIR}/pa-sip-test-delay.pcm"
