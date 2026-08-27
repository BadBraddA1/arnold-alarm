#!/usr/bin/env bash
# Install convenience PA: dial 1010 → Asterisk (Docker if needed) → AudioSocket → talkback.
# NOT for emergency use.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AST_SRC="$ROOT/asterisk"
ENV_FILE="${HOME}/.config/arnold-alarm/gateway.env"
TALK_IP="${TALK_CONSOLE_IP:-}"
SOFT_PASS="${PA_SOFTPHONE_PASSWORD:-$(openssl rand -hex 4)}"
PA_EXT="${PA_EXT:-1010}"
AST_CONF_DIR="${HOME}/.config/arnold-alarm/asterisk"
COMPOSE_FILE="$AST_CONF_DIR/docker-compose.yml"

echo "==> Arnold Alarm convenience PA installer"
echo "    Extension ${PA_EXT} → AudioSocket 127.0.0.1:9092 → Protect talkback"
echo "    This is NOT an emergency path."

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run as the pi user (not root); script will sudo where needed."
  exit 1
fi

if [[ -z "$TALK_IP" ]]; then
  TALK_IP="$(ip -4 route | awk '/default/ {print $3; exit}')"
  echo "TALK_CONSOLE_IP defaulting to gateway ${TALK_IP}"
fi

mkdir -p "$AST_CONF_DIR"
sed "s/CHANGE_ME_SOFTPHONE/${SOFT_PASS}/g; s/TALK_CONSOLE_IP/${TALK_IP}/g; s/1010/${PA_EXT}/g; s/888/${PA_EXT}/g" \
  "$AST_SRC/pjsip.conf" > "$AST_CONF_DIR/pjsip.conf"
sed "s/1010/${PA_EXT}/g; s/888/${PA_EXT}/g" \
  "$AST_SRC/extensions.conf" > "$AST_CONF_DIR/extensions.conf"

# Minimal modules / rtp so container starts cleanly
cat > "$AST_CONF_DIR/modules.conf" <<'EOF'
[modules]
autoload=yes
noload => chan_sip.so
EOF

cat > "$AST_CONF_DIR/rtp.conf" <<'EOF'
[general]
rtpstart=10000
rtpend=10100
EOF

cat > "$AST_CONF_DIR/asterisk.conf" <<'EOF'
[directories]
astetcdir => /etc/asterisk
astmoddir => /usr/lib/asterisk/modules
astvarlibdir => /var/lib/asterisk
astdbdir => /var/lib/asterisk
astkeydir => /var/lib/asterisk
astdatadir => /var/lib/asterisk
astagidir => /var/lib/asterisk/agi-bin
astspooldir => /var/spool/asterisk
astrundir => /var/run/asterisk
astlogdir => /var/log/asterisk
EOF

install_asterisk_apt() {
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq asterisk && return 0
  return 1
}

install_asterisk_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "==> Installing Docker (Asterisk not in apt)"
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER" || true
  fi
  # Ensure docker usable without re-login
  if ! docker info >/dev/null 2>&1; then
    echo "==> Using sudo docker (re-login later for group docker)"
    DOCKER="sudo docker"
  else
    DOCKER="docker"
  fi

  # Arm-friendly Asterisk 20 image with PJSIP + AudioSocket
  IMAGE="${ASTERISK_IMAGE:-andrius/asterisk:20-current}"
  echo "==> Pulling $IMAGE"
  $DOCKER pull "$IMAGE"

  cat > "$COMPOSE_FILE" <<EOF
services:
  asterisk:
    image: ${IMAGE}
    container_name: arnold-alarm-asterisk
    network_mode: host
    restart: unless-stopped
    volumes:
      - ${AST_CONF_DIR}/pjsip.conf:/etc/asterisk/pjsip.conf:ro
      - ${AST_CONF_DIR}/extensions.conf:/etc/asterisk/extensions.conf:ro
      - ${AST_CONF_DIR}/modules.conf:/etc/asterisk/modules.conf:ro
      - ${AST_CONF_DIR}/rtp.conf:/etc/asterisk/rtp.conf:ro
EOF

  if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
    (cd "$AST_CONF_DIR" && $DOCKER compose -f "$COMPOSE_FILE" up -d)
  else
    $DOCKER rm -f arnold-alarm-asterisk 2>/dev/null || true
    $DOCKER run -d --name arnold-alarm-asterisk --network host --restart unless-stopped \
      -v "$AST_CONF_DIR/pjsip.conf:/etc/asterisk/pjsip.conf:ro" \
      -v "$AST_CONF_DIR/extensions.conf:/etc/asterisk/extensions.conf:ro" \
      -v "$AST_CONF_DIR/modules.conf:/etc/asterisk/modules.conf:ro" \
      -v "$AST_CONF_DIR/rtp.conf:/etc/asterisk/rtp.conf:ro" \
      "$IMAGE"
  fi
}

echo "==> Installing Asterisk"
if install_asterisk_apt; then
  echo "    apt asterisk OK"
  sudo cp "$AST_CONF_DIR/pjsip.conf" /etc/asterisk/pjsip.conf
  sudo cp "$AST_CONF_DIR/extensions.conf" /etc/asterisk/extensions.conf
  sudo systemctl enable asterisk 2>/dev/null || true
  sudo systemctl restart asterisk
else
  echo "    apt asterisk unavailable — using Docker"
  install_asterisk_docker
fi

echo "==> Enabling PA in gateway.env"
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
if ! grep -q '^PA_ENABLED=' "$ENV_FILE" 2>/dev/null; then
  cat >> "$ENV_FILE" <<EOF

# Convenience PA (SIP → talkback) — NOT for emergency
PA_ENABLED=1
PA_AUDIOSOCKET_PORT=9092
EOF
else
  # portable sed
  if sed --version >/dev/null 2>&1; then
    sed -i 's/^PA_ENABLED=.*/PA_ENABLED=1/' "$ENV_FILE"
  else
    sed -i '' 's/^PA_ENABLED=.*/PA_ENABLED=1/' "$ENV_FILE"
  fi
fi

echo "==> Restart arnold-alarm-gateway"
sudo systemctl restart arnold-alarm-gateway 2>/dev/null || \
  echo "    (restart arnold-alarm-gateway manually if unit name differs)"

sleep 2
echo ""
echo "Done."
echo "  Softphone: SIP user 100 / pass ${SOFT_PASS} @ $(hostname -I | awk '{print $1}') → dial ${PA_EXT}"
echo "  UniFi Talk: third-party SIP → this Pi :5060 (Talk console IP used: ${TALK_IP})"
echo "  Health: curl -s http://127.0.0.1:8787/health | jq .pa"
echo ""
echo "Remind staff: dial-in PA is convenience only — emergencies use Arnold Alarm codes."
