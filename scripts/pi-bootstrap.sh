#!/usr/bin/env bash
# Self-contained Pi bootstrap — paste entire file on the Pi, or:
#   bash <(curl -fsSL …) once the repo is on GitHub.
set -euo pipefail

BRAD_PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGbCjbeHwhbh5u1wfbDnFmfFceQ8wtj10rBse97ZIqYX monitoring-mac-20260502'
HOSTNAME_WANT="${HOSTNAME_WANT:-alarm-gw}"
USER_NAME="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"

echo "==> Arnold alarm Pi bootstrap (SSH + Tailscale + hostname)"

sudo apt-get update
sudo apt-get install -y openssh-server curl git ca-certificates avahi-daemon
sudo systemctl enable --now ssh
sudo systemctl enable --now avahi-daemon

sudo hostnamectl set-hostname "$HOSTNAME_WANT"
if grep -qE '127\.0\.1\.1' /etc/hosts; then
  sudo sed -i "s/127\\.0\\.1\\.1.*/127.0.1.1\\t${HOSTNAME_WANT}/" /etc/hosts
fi

mkdir -p "$USER_HOME/.ssh"
chmod 700 "$USER_HOME/.ssh"
AUTH="$USER_HOME/.ssh/authorized_keys"
touch "$AUTH"
chmod 600 "$AUTH"
if ! grep -Fq "$BRAD_PUBKEY" "$AUTH" 2>/dev/null; then
  echo "$BRAD_PUBKEY" >> "$AUTH"
fi
chown -R "$USER_NAME:$USER_NAME" "$USER_HOME/.ssh"

sudo timedatectl set-timezone America/Chicago || true
sudo timedatectl set-ntp true || true

if [[ ! -x /usr/bin/tailscale ]]; then
  curl -fsSL https://tailscale.com/install.sh | sudo sh
fi

echo
echo "Approve Tailscale on this Pi (opens a URL):"
sudo tailscale up --ssh --hostname="$HOSTNAME_WANT" || true

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
TS_IP="$(tailscale ip -4 2>/dev/null || true)"

echo
echo "========================================"
echo " Tell Cursor / Brad these values:"
echo "   user:      $USER_NAME"
echo "   hostname:  $HOSTNAME_WANT"
echo "   LAN IP:    ${LAN_IP:-unknown}"
echo "   Tailscale: ${TS_IP:-pending — finish URL login above}"
echo "   SSH try:   ssh ${USER_NAME}@${TS_IP:-$LAN_IP}"
echo "========================================"
