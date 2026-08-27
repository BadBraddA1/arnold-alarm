#!/usr/bin/env bash
# Install Asterisk + wire extension 1010 → arnold-alarm AudioSocket (convenience PA).
# NOT for emergency use.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AST_SRC="$ROOT/asterisk"
CONF_DIR="${ASTERISK_CONF_DIR:-/etc/asterisk}"
ENV_FILE="${HOME}/.config/arnold-alarm/gateway.env"
TALK_IP="${TALK_CONSOLE_IP:-}"
SOFT_PASS="${PA_SOFTPHONE_PASSWORD:-$(openssl rand -hex 4)}"

echo "==> Arnold Alarm convenience PA installer"
echo "    Extension 1010 → AudioSocket 127.0.0.1:9092 → Protect talkback"
echo "    This is NOT an emergency path."

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run as the pi user (not root); script will sudo where needed."
  exit 1
fi

if [[ -z "$TALK_IP" ]]; then
  echo ""
  echo "Set TALK_CONSOLE_IP to your UniFi Talk / UDM LAN IP, e.g.:"
  echo "  TALK_CONSOLE_IP=192.168.1.1 bash $0"
  echo "Continuing with placeholder TALK_CONSOLE_IP (edit pjsip later)."
  TALK_IP="192.168.1.1"
fi

echo "==> Installing asterisk (apt)"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq asterisk asterisk-modules || \
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq asterisk

echo "==> Writing Asterisk configs"
TMP="$(mktemp -d)"
sed "s/CHANGE_ME_SOFTPHONE/${SOFT_PASS}/g; s/TALK_CONSOLE_IP/${TALK_IP}/g" \
  "$AST_SRC/pjsip.conf" > "$TMP/pjsip.conf"
cp "$AST_SRC/extensions.conf" "$TMP/extensions.conf"

sudo mkdir -p "$CONF_DIR"
# Backup once
if [[ -f "$CONF_DIR/pjsip.conf" && ! -f "$CONF_DIR/pjsip.conf.arnold-bak" ]]; then
  sudo cp "$CONF_DIR/pjsip.conf" "$CONF_DIR/pjsip.conf.arnold-bak"
fi
if [[ -f "$CONF_DIR/extensions.conf" && ! -f "$CONF_DIR/extensions.conf.arnold-bak" ]]; then
  sudo cp "$CONF_DIR/extensions.conf" "$CONF_DIR/extensions.conf.arnold-bak"
fi

sudo cp "$TMP/pjsip.conf" "$CONF_DIR/pjsip.conf"
sudo cp "$TMP/extensions.conf" "$CONF_DIR/extensions.conf"
sudo chown root:asterisk "$CONF_DIR/pjsip.conf" "$CONF_DIR/extensions.conf" 2>/dev/null || true
sudo chmod 640 "$CONF_DIR/pjsip.conf" "$CONF_DIR/extensions.conf" 2>/dev/null || true

echo "==> Enabling AudioSocket in gateway.env"
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
if ! grep -q '^PA_ENABLED=' "$ENV_FILE" 2>/dev/null; then
  cat >> "$ENV_FILE" <<EOF

# Convenience PA (SIP → talkback) — NOT for emergency
PA_ENABLED=1
PA_AUDIOSOCKET_PORT=9092
# Comma-separated Protect speaker device IDs (same as talkback ACTIONS). Required if ACTIONS has no talkback entries.
# PA_SPEAKER_IDS=
EOF
else
  sed -i 's/^PA_ENABLED=.*/PA_ENABLED=1/' "$ENV_FILE"
fi

echo "==> Restart Asterisk + arnold-alarm-gateway"
sudo systemctl enable asterisk 2>/dev/null || true
sudo systemctl restart asterisk
sudo systemctl restart arnold-alarm-gateway 2>/dev/null || \
  echo "    (restart arnold-alarm-gateway manually if unit name differs)"

echo ""
echo "Done."
echo "  Softphone test: register SIP 100 / pass ${SOFT_PASS} @ $(hostname -I | awk '{print $1}') then dial 1010"
echo "  UniFi Talk: add third-party SIP provider → this Pi IP:5060 (see README)"
echo "  Health: curl -s http://127.0.0.1:8787/health | jq .pa"
echo ""
echo "Remind staff: dial-in PA is convenience only — emergencies use Arnold Alarm codes."
