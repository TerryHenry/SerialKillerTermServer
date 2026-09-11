#!/bin/bash
# Runs as root via a narrowly-scoped sudoers NOPASSWD rule (see setup.sh) so the
# unprivileged terminalserver service account can manage Wi-Fi, DNS, NTP, and the system
# timezone without running the whole app as root. Takes structured subcommands rather than
# raw nmcli/timedatectl arguments so the sudoers grant only ever has to trust this one
# fixed, reviewable script.
set -euo pipefail

NTP_DROPIN_DIR=/etc/systemd/timesyncd.conf.d
NTP_DROPIN_FILE="$NTP_DROPIN_DIR/50-terminalserver.conf"

case "${1:-}" in
  enable)
    exec nmcli radio wifi on
    ;;
  disable)
    exec nmcli radio wifi off
    ;;
  scan)
    exec nmcli -t -f SSID,SIGNAL,SECURITY device wifi list --rescan yes
    ;;
  connect)
    ssid="${2:?ssid required}"
    password="${3:-}"
    if [ -n "$password" ]; then
      exec nmcli device wifi connect "$ssid" password "$password"
    else
      exec nmcli device wifi connect "$ssid"
    fi
    ;;
  ntp-set)
    server="${2:?ntp server required}"
    mkdir -p "$NTP_DROPIN_DIR"
    printf '[Time]\nNTP=%s\n' "$server" > "$NTP_DROPIN_FILE"
    systemctl restart systemd-timesyncd
    ;;
  timezone-set)
    tz="${2:?timezone required}"
    exec timedatectl set-timezone "$tz"
    ;;
  dns-set)
    shift
    servers="$*"
    [ -n "$servers" ] || { echo "at least one DNS server required" >&2; exit 1; }
    # IPv4 only -- the app validates this before ever calling here, but re-checked since
    # this script is the actual privilege boundary. IPv6 DNS is left alone either way.
    for s in $servers; do
      case "$s" in
        *[!0-9.]*|'') echo "not an IPv4 address: $s" >&2; exit 1 ;;
      esac
    done
    # Applied to every currently-active connection (not just one) so the override holds
    # regardless of which interface (Ethernet or Wi-Fi) ends up carrying traffic.
    nmcli -t -f NAME connection show --active | while IFS= read -r conn; do
      [ -n "$conn" ] || continue
      nmcli connection modify "$conn" ipv4.ignore-auto-dns yes ipv4.dns "$servers"
      nmcli connection up "$conn" >/dev/null
    done
    ;;
  dns-clear)
    nmcli -t -f NAME connection show --active | while IFS= read -r conn; do
      [ -n "$conn" ] || continue
      nmcli connection modify "$conn" ipv4.ignore-auto-dns no ipv4.dns ""
      nmcli connection up "$conn" >/dev/null
    done
    ;;
  *)
    echo "usage: system-helper.sh {enable|disable|scan|connect <ssid> [password]|ntp-set <server>|timezone-set <tz>|dns-set <servers...>|dns-clear}" >&2
    exit 1
    ;;
esac
