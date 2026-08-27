#!/usr/bin/env bash
# Install arnold-alarm gateway on a Raspberry Pi (Debian/Raspberry Pi OS).
# Idempotent. Run as a normal user with sudo.
set -euo pipefail

APP_USER="${SUDO_USER:-${USER}}"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
INSTALL_DIR="${INSTALL_DIR:-$APP_HOME/arnold-alarm}"
GATEWAY_DIR="$INSTALL_DIR/apps/gateway"
ENV_DIR="$APP_HOME/.config/arnold-alarm"
ENV_FILE="$ENV_DIR/gateway.env"
REPO_URL="${REPO_URL:-https://github.com/BadBraddA1/arnold-alarm.git}"
NODE_MAJOR="${NODE_MAJOR:-22}"

echo "==> arnold-alarm gateway install"
echo "    user=$APP_USER home=$APP_HOME dir=$INSTALL_DIR"

sudo apt-get update
sudo apt-get install -y curl git ca-certificates build-essential avahi-daemon

# Node.js via NodeSource
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# pnpm
if ! command -v pnpm >/dev/null 2>&1; then
  sudo npm install -g pnpm@9
fi

# Timezone = building time (Arnold, MO)
sudo timedatectl set-timezone America/Chicago || true
sudo timedatectl set-ntp true || true

# Hostname for mDNS: alarm-gw.local
CURRENT_HOST="$(hostname)"
if [[ "$CURRENT_HOST" != "alarm-gw" ]]; then
  echo "==> Setting hostname to alarm-gw (was $CURRENT_HOST)"
  sudo hostnamectl set-hostname alarm-gw
  if grep -q '10\.0\.0\.1\|127\.0\.1\.1' /etc/hosts 2>/dev/null; then
    sudo sed -i 's/10\.0\.0\.1.*/10.0.0.1\talarm-gw/' /etc/hosts || true
    sudo sed -i 's/127\.0\.1\.1.*/127.0.1.1\talarm-gw/' /etc/hosts || true
  fi
fi
sudo systemctl enable --now avahi-daemon || true

# Clone or pull
if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "==> Updating repo"
  git -C "$INSTALL_DIR" fetch --all --prune
  git -C "$INSTALL_DIR" pull --ff-only || true
else
  echo "==> Cloning $REPO_URL"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$GATEWAY_DIR"
pnpm install --frozen-lockfile=false
pnpm build

mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$INSTALL_DIR/apps/gateway/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "==> Wrote $ENV_FILE — edit PROTECT_* and ACTIONS before relying on play"
fi

UNIT_PATH="/etc/systemd/system/arnold-alarm-gateway.service"
sudo tee "$UNIT_PATH" >/dev/null <<EOF
[Unit]
Description=Arnold Alarm UniFi Protect gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$GATEWAY_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $GATEWAY_DIR/dist/index.js
Restart=always
RestartSec=3
# Allow local NVR self-signed certs
Environment=NODE_TLS_REJECT_UNAUTHORIZED=0

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now arnold-alarm-gateway.service

echo
echo "==> Installed. Service: arnold-alarm-gateway"
echo "    Health:  curl -s http://127.0.0.1:8787/health"
echo "    LAN URL: http://alarm-gw.local:8787"
echo "    Config:  $ENV_FILE"
echo "    Logs:    journalctl -u arnold-alarm-gateway -f"
