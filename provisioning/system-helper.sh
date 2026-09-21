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
  lldp-install)
    # Fixed package name only. Idempotent: does nothing if lldpd is already present.
    if command -v lldpd >/dev/null 2>&1; then echo "already installed"; exit 0; fi
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y --no-install-recommends lldpd
    ;;  lldp-status)
    # Read-only: reports whether lldpd is installed/running and which discovery protocols
    # it is configured to speak, as key=value lines the app parses.
    installed=0; command -v lldpd >/dev/null 2>&1 && installed=1
    active=0; systemctl is-active --quiet lldpd 2>/dev/null && active=1
    args=""
    if [ -f /etc/default/lldpd ]; then
      args="$(sed -n 's/^DAEMON_ARGS="\(.*\)"$/\1/p' /etc/default/lldpd | head -1)"
    fi
    cdp=0; fdp=0
    case " $args " in *" -c "*) cdp=1 ;; esac
    case " $args " in *" -f "*) fdp=1 ;; esac
    echo "installed=$installed"
    echo "active=$active"
    echo "cdp=$cdp"
    echo "fdp=$fdp"
    ;;
  lldp-set)
    # lldp-set <enabled 0|1> <cdp 0|1> <fdp 0|1>. Fixed flags only -- nothing the caller
    # supplies is ever written into the daemon's argument line except these validated
    # switches, since this script is the actual privilege boundary.
    enabled="${2:?enabled flag required}"
    cdp="${3:?cdp flag required}"
    fdp="${4:?fdp flag required}"
    for v in "$enabled" "$cdp" "$fdp"; do
      case "$v" in 0|1) ;; *) echo "flags must be 0 or 1" >&2; exit 1 ;; esac
    done
    command -v lldpd >/dev/null 2>&1 || { echo "lldpd is not installed -- install it with: sudo apt-get install lldpd" >&2; exit 1; }
    daemon_args=""
    [ "$cdp" = "1" ] && daemon_args="$daemon_args -c"
    [ "$fdp" = "1" ] && daemon_args="$daemon_args -f"
    daemon_args="${daemon_args# }"
    printf '# Managed by the terminal server admin UI.\nDAEMON_ARGS="%s"\n' "$daemon_args" > /etc/default/lldpd
    if [ "$enabled" = "1" ]; then
      systemctl enable lldpd >/dev/null 2>&1 || true
      systemctl restart lldpd
    else
      systemctl disable --now lldpd >/dev/null 2>&1 || true
    fi
    ;;
  lldp-neighbors)
    exec lldpcli -f json0 show neighbors details
    ;;
  service-restart)
    # Takes no arguments -- the app can only ever restart itself, never target an
    # arbitrary unit. All the actual update logic (download, checksum, staging,
    # validation, backup) runs unprivileged as the app's own account, which already
    # owns /opt/terminalserver; this is the one step that genuinely needs root.
    exec systemctl restart terminalserver.service
    ;;
  ip-set)
    # The connection name (not the device name) is passed in, already resolved
    # device->connection on the Node side via the same colon-escaping-aware nmcli
    # parsing getInterfaces() already does -- this script just trusts that resolution
    # and re-validates the IP-shaped values, since it's the actual privilege boundary.
    conn="${2:?connection name required}"
    address="${3:?ip address required}"
    prefix="${4:?prefix required}"
    gateway="${5:?gateway required}"
    for v in "$address" "$gateway"; do
      case "$v" in
        *[!0-9.]*|'') echo "not an IPv4 address: $v" >&2; exit 1 ;;
      esac
    done
    case "$prefix" in
      ''|*[!0-9]*) echo "invalid prefix length: $prefix" >&2; exit 1 ;;
    esac
    nmcli connection modify "$conn" ipv4.method manual ipv4.addresses "$address/$prefix" ipv4.gateway "$gateway"
    exec nmcli connection up "$conn"
    ;;
  ip-clear)
    conn="${2:?connection name required}"
    nmcli connection modify "$conn" ipv4.method auto ipv4.addresses "" ipv4.gateway ""
    exec nmcli connection up "$conn"
    ;;
  os-password-set)
    # The new password is read from stdin (chpasswd's own interface), not argv -- argv
    # values are briefly visible to other local processes via the process list, and
    # there's no reason to accept that exposure when chpasswd already reads from stdin
    # natively. Only ever targets the fixed "admin" account created at first boot, never
    # a caller-supplied username.
    password="$(cat)"
    [ -n "$password" ] || { echo "password required" >&2; exit 1; }
    printf 'admin:%s\n' "$password" | chpasswd
    ;;
  reboot)
    # Takes no arguments, same reasoning as service-restart -- the app can only ever
    # reboot the one host it's running on.
    exec systemctl reboot
    ;;
  hostname-set)
    hostname="${2:?hostname required}"
    update_mdns="${3:-0}"
    case "$hostname" in
      ''|*[!a-zA-Z0-9-]*|-*|*-) echo "invalid hostname: $hostname" >&2; exit 1 ;;
    esac
    if [ "${#hostname}" -gt 63 ]; then
      echo "hostname too long: $hostname" >&2
      exit 1
    fi
    hostnamectl set-hostname "$hostname"
    # hostnamectl only changes the kernel/system hostname -- it never touches
    # /etc/hosts, so the conventional "127.0.1.1 <hostname>" line there silently keeps
    # naming the OLD hostname. The moment the two diverge, anything that resolves the
    # local hostname for itself (sudo included, for its own logging) starts failing
    # with "unable to resolve host <name>: Name or service not known" -- found live,
    # not by inspection, on a renamed appliance. Update that line to match, or add it
    # fresh if this image never had one.
    if grep -q '^127\.0\.1\.1[[:space:]]' /etc/hosts; then
      sed -i "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1\t$hostname/" /etc/hosts
    else
      printf '127.0.1.1\t%s\n' "$hostname" >> /etc/hosts
    fi
    # Opt-in: avahi-daemon doesn't necessarily re-advertise under the new name on its
    # own, so the "<oldname>.local" mDNS address can keep working (or stop working)
    # independently of the Linux hostname change above until it's restarted. Only do
    # this when asked -- an admin may be relying on the existing .local name staying
    # put for bookmarks or scripts even after renaming the underlying host.
    if [ "$update_mdns" = "1" ] && systemctl list-unit-files avahi-daemon.service >/dev/null 2>&1; then
      systemctl restart avahi-daemon || true
    fi
    ;;
  *)
    echo "usage: system-helper.sh {lldp-install|lldp-status|lldp-set <en> <cdp> <fdp>|lldp-neighbors|enable|disable|scan|connect <ssid> [password]|ntp-set <server>|timezone-set <tz>|dns-set <servers...>|dns-clear|service-restart|ip-set <conn> <addr> <prefix> <gw>|ip-clear <conn>|os-password-set|reboot|hostname-set <name>}" >&2
    exit 1
    ;;
esac
