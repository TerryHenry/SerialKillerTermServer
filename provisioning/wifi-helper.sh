#!/bin/bash
# Runs as root via a narrowly-scoped sudoers NOPASSWD rule (see firstrun.sh) so the
# unprivileged terminalserver service account can manage Wi-Fi without running the
# whole app as root. Takes structured subcommands rather than raw nmcli arguments so
# the sudoers grant only ever has to trust this one fixed, reviewable script.
set -euo pipefail

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
  *)
    echo "usage: wifi-helper.sh {enable|disable|scan|connect <ssid> [password]}" >&2
    exit 1
    ;;
esac
