#!/bin/bash
# Injected onto the boot (bootfs) partition and triggered exactly once via a
# `systemd.run=` kernel command-line parameter (the same mechanism Raspberry Pi
# Imager's own "OS customization" feature uses). Runs very early in boot,
# before normal networking is guaranteed up, so this script only does local,
# offline setup: it drops app files + systemd units in place and schedules the
# network-dependent work (installing Node.js, npm install) as a separate
# systemd unit (terminalserver-setup.service) that waits for network-online.target.
set -uo pipefail

if mountpoint -q /boot/firmware; then
  BOOTDIR=/boot/firmware
else
  BOOTDIR=/boot
fi

LOG="$BOOTDIR/firstrun.log"
exec > >(tee -a "$LOG") 2>&1
echo "=== Serial Killer Terminal Server firstrun starting: $(date -u) ==="

APP_DIR=/opt/terminalserver
mkdir -p "$APP_DIR"

echo "Extracting application files..."
tar -xzf "$BOOTDIR/terminalserver-app.tar.gz" -C "$APP_DIR"

echo "Installing systemd units..."
install -m 644 "$APP_DIR/provisioning/terminalserver.service" /etc/systemd/system/terminalserver.service
install -m 644 "$APP_DIR/provisioning/terminalserver-setup.service" /etc/systemd/system/terminalserver-setup.service
chmod +x "$APP_DIR/provisioning/setup.sh"

echo "Configuring keyboard layout (non-interactive, avoids console-setup's boot-time detection prompt)..."
raspi-config nonint do_configure_keyboard us || true

echo "Configuring default Linux user account (avoids userconfig.service's interactive first-boot prompt)..."
DEFAULT_OS_USER=admin
DEFAULT_OS_PASSWORD='letmein0!'
if [ -x /usr/lib/userconf-pi/userconf ]; then
  # Same backend Raspberry Pi Imager's own "Set username and password" customization
  # calls; creates the account, sets the password, and disables userconfig.service.
  /usr/lib/userconf-pi/userconf "$DEFAULT_OS_USER" "$(openssl passwd -6 "$DEFAULT_OS_PASSWORD")"
else
  if ! id -u "$DEFAULT_OS_USER" >/dev/null 2>&1; then
    useradd -m -s /bin/bash -G sudo,adm,dialout,plugdev,users "$DEFAULT_OS_USER"
  fi
  echo "$DEFAULT_OS_USER:$DEFAULT_OS_PASSWORD" | chpasswd
  systemctl disable userconfig.service 2>/dev/null || true
fi

echo "Setting hostname..."
CURRENT_HOSTNAME=$(cat /etc/hostname 2>/dev/null | tr -d '[:space:]')
if [ "$CURRENT_HOSTNAME" != "terminalserver" ]; then
  echo "terminalserver" > /etc/hostname
  sed -i "s/\b$CURRENT_HOSTNAME\b/terminalserver/g" /etc/hosts || true
  hostnamectl set-hostname terminalserver || true
fi

systemctl daemon-reload
systemctl enable terminalserver-setup.service

echo "Cleaning up first-boot trigger..."
rm -f "$BOOTDIR/firstrun.sh"
CMDLINE_FILE="$BOOTDIR/cmdline.txt"
sed -i \
  -e 's| systemd.run=[^ ]*||' \
  -e 's| systemd.run_success_action=[^ ]*||' \
  -e 's| systemd.unit=kernel-command-line.target||' \
  "$CMDLINE_FILE"

echo "=== Serial Killer Terminal Server firstrun complete: $(date -u), rebooting to apply ==="
exit 0
