#!/usr/bin/env bash
# One-time Pi setup: SSH key + passwordless service restart for agent-pi sync.
set -euo pipefail

BRAD_PUBKEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGbCjbeHwhbh5u1wfbDnFmfFceQ8wtj10rBse97ZIqYX monitoring-mac-20260502'
USER_NAME="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"

mkdir -p "$USER_HOME/.ssh"
chmod 700 "$USER_HOME/.ssh"
AUTH="$USER_HOME/.ssh/authorized_keys"
touch "$AUTH"
chmod 600 "$AUTH"
if ! grep -Fq "$BRAD_PUBKEY" "$AUTH" 2>/dev/null; then
  echo "$BRAD_PUBKEY" >> "$AUTH"
fi
chown -R "$USER_NAME:$USER_NAME" "$USER_HOME/.ssh"

SUDOERS="/etc/sudoers.d/arnold-alarm-agent"
sudo tee "$SUDOERS" >/dev/null <<EOF
# Cursor agent-pi sync/restart (no full root shell)
${USER_NAME} ALL=(ALL) NOPASSWD: /bin/systemctl restart arnold-alarm-gateway, /bin/systemctl status arnold-alarm-gateway
EOF
sudo chmod 440 "$SUDOERS"

echo "==> Agent backdoor ready on Pi"
echo "    SSH key installed for monitoring-mac"
echo "    NOPASSWD systemctl restart arnold-alarm-gateway"
echo ""
echo "After git pull + rebuild, hit from Mac:"
echo "  bash scripts/agent-pi.sh health"
echo "  bash scripts/agent-pi.sh sync-notify"
