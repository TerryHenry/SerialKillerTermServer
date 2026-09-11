#!/bin/bash
# One-time setup, run by terminalserver-setup.service after first boot has real
# network connectivity. Installs Node.js, installs app dependencies, and hands
# off to the always-on terminalserver.service.
set -uo pipefail

APP_DIR=/opt/terminalserver
DATA_DIR="$APP_DIR/data"
LOG="$DATA_DIR/setup.log"
mkdir -p "$DATA_DIR"
exec > >(tee -a "$LOG") 2>&1

echo "=== Serial Killer Terminal Server first-boot setup starting: $(date -u) ==="

retry() {
  local attempts=5
  local delay=10
  local n=1
  until "$@"; do
    if [ "$n" -ge "$attempts" ]; then
      echo "Command failed after $n attempts: $*"
      return 1
    fi
    echo "Command failed (attempt $n/$attempts), retrying in ${delay}s: $*"
    n=$((n + 1))
    sleep "$delay"
  done
}

export DEBIAN_FRONTEND=noninteractive

# This service re-runs on every boot until it succeeds (see
# terminalserver-setup.service's ConditionPathExists), so if a previous
# attempt was cut off mid-install by a reboot or power loss, dpkg can be left
# in an interrupted state ("E: dpkg was interrupted, you must manually run
# 'dpkg --configure -a'"), which blocks all further apt-get calls. Repair
# that unconditionally before touching apt.
echo "Repairing any interrupted dpkg state..."
dpkg --configure -a || true
apt-get install -y -f --no-install-recommends || true

retry apt-get update
if [ $? -ne 0 ]; then
  echo "FATAL: apt-get update failed" >&2
  exit 1
fi

retry apt-get install -y --no-install-recommends ca-certificates curl gnupg build-essential python3 openssl
if [ $? -ne 0 ]; then
  echo "FATAL: failed to install base packages" >&2
  exit 1
fi

# Debian/Raspberry Pi OS's own "npm" package drags in a large tree of
# separately-packaged "node-*" Debian modules (node-deep-equal,
# node-get-intrinsic, node-babel7, libjs-util, ...) whose versions frequently
# don't resolve against each other, causing apt-get install to fail outright.
# NodeSource's own repo ships a self-contained Node.js + npm build instead,
# with no dependency on Debian's node-* ecosystem.
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Installing Node.js from NodeSource..."
  NODE_MAJOR=22
  mkdir -p /etc/apt/keyrings
  retry curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc
  if [ $? -ne 0 ]; then
    echo "FATAL: failed to fetch NodeSource signing key" >&2
    exit 1
  fi
  chmod a+r /etc/apt/keyrings/nodesource.asc
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list

  retry apt-get update
  if [ $? -ne 0 ]; then
    echo "FATAL: apt-get update (NodeSource) failed" >&2
    exit 1
  fi

  retry apt-get install -y --no-install-recommends nodejs
  if [ $? -ne 0 ]; then
    echo "FATAL: failed to install Node.js" >&2
    exit 1
  fi
fi

if ! id -u terminalserver >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin --groups dialout terminalserver
fi

echo "Granting the service account scoped permission to manage Wi-Fi, DNS, NTP, and timezone..."
chmod +x "$APP_DIR/provisioning/system-helper.sh"
SUDOERS_FILE=/etc/sudoers.d/terminalserver-system
SUDOERS_TMP=$(mktemp)
echo "terminalserver ALL=(root) NOPASSWD: $APP_DIR/provisioning/system-helper.sh" > "$SUDOERS_TMP"
# Validate before installing -- sudo reads the *whole* sudoers config atomically, so a
# malformed drop-in here can silently break sudo for the entire system, not just this
# rule. Never place an unvalidated file into /etc/sudoers.d/.
if visudo -c -f "$SUDOERS_TMP" >/dev/null 2>&1; then
  install -m 440 "$SUDOERS_TMP" "$SUDOERS_FILE"
else
  echo "WARNING: generated sudoers rule failed validation -- Wi-Fi/DNS/NTP/timezone control will be unavailable" >&2
fi
rm -f "$SUDOERS_TMP"

# Seed the default NTP server (pool.ntp.org) on first boot only -- guarded so re-running
# this idempotent setup script (it retries on every boot until it succeeds) never clobbers
# an admin's own choice made afterward from the Network tab.
if [ ! -f /etc/systemd/timesyncd.conf.d/50-terminalserver.conf ]; then
  echo "Setting default NTP server (pool.ntp.org)..."
  mkdir -p /etc/systemd/timesyncd.conf.d
  printf '[Time]\nNTP=pool.ntp.org\n' > /etc/systemd/timesyncd.conf.d/50-terminalserver.conf
  systemctl restart systemd-timesyncd || true
fi

cd "$APP_DIR" || exit 1
retry npm install --omit=dev --no-audit --no-fund
if [ $? -ne 0 ]; then
  echo "FATAL: npm install failed" >&2
  exit 1
fi

chown -R terminalserver:terminalserver "$APP_DIR"

systemctl daemon-reload
systemctl enable terminalserver.service
systemctl start terminalserver.service

touch "$DATA_DIR/.setup-complete"
systemctl disable terminalserver-setup.service

echo "=== Serial Killer Terminal Server first-boot setup complete: $(date -u) ==="
echo "Admin UI: https://<this-pi>:8443  (first visit creates the admin account)"
