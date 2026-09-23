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
    nice -n 19 apt-get update -qq
    nice -n 19 apt-get install -y --no-install-recommends lldpd
    # LLDP on by default (start now and at boot). CDP/FDP stay off -- opt-in via lldp-set.
    systemctl enable --now lldpd >/dev/null 2>&1 || true
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
    showall=0
    case " $args " in *" -H 0 "*) showall=1 ;; esac
    echo "installed=$installed"
    echo "active=$active"
    echo "cdp=$cdp"
    echo "fdp=$fdp"
    echo "showall=$showall"
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
    # lldpd hides a neighbor heard over several protocols and shows only the "best" one by
    # default (-H 15), so a switch seen over both LLDP and CDP would appear as LLDP only.
    # -H 0 turns that filtering off so every protocol heard is listed.
    if [ "$cdp" = "1" ] || [ "$fdp" = "1" ]; then daemon_args="$daemon_args -H 0"; fi
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
  ups-install)
    # Fixed package list only. Idempotent: does nothing if already present. "nut" pulls
    # in nut-client + nut-server + most driver binaries (usbhid-ups, blazer_ser,
    # genericups, dummy-ups, etc.) -- not installed until an admin actually configures a
    # UPS, same as lldpd above. nut-powerman-pdu is a separate Debian package (pulls in
    # libpowerman0) that Debian doesn't bundle into the main "nut" package, so it's listed
    # explicitly -- still tiny and harmless to install even if powerman-pdu is never used.
    if command -v upsd >/dev/null 2>&1; then echo "already installed"; exit 0; fi
    export DEBIAN_FRONTEND=noninteractive
    nice -n 19 apt-get update -qq
    nice -n 19 apt-get install -y --no-install-recommends nut
    # Best-effort and separate from the required "nut" install above: not every
    # Debian release/arch combination carries this package, and a box that will never
    # use powerman-pdu shouldn't fail its whole UPS setup over it.
    nice -n 19 apt-get install -y --no-install-recommends nut-powerman-pdu || true
    # Debian's nut package auto-enables nut-driver-enumerator's path/service units, which
    # watch ups.conf and start/stop per-UPS driver instances on their own -- nothing else
    # to enable here for the driver itself.
    ;;
  ups-configure)
    # ups-configure <name> <driver> <port>. Writes the whole standalone NUT config
    # (single box, driver + upsd + upsmon all local) from scratch every time -- simpler
    # and safer than trying to patch an existing config in place, and cheap since this
    # only runs when an admin actively changes UPS settings. The one thing NOT
    # regenerated is upsd's own monitoring password, preserved across reconfigures so
    # upsmon doesn't need restarting for no reason.
    name="${2:?ups name required}"
    driver="${3:?driver required}"
    port="${4:?port required}"
    # extra: driver-specific single value the Node side already picked out for us --
    # SNMP community string for snmp-ups, PDU node identifier for powerman-pdu, unused
    # (and fine to be empty) for every other driver. See lib/upsMonitor.js.
    extra="${5:-}"
    case "$name" in *[!a-zA-Z0-9_-]*|'') echo "invalid ups name: $name" >&2; exit 1 ;; esac
    case "$driver" in usbhid-ups|blazer_ser|blazer_usb|genericups|snmp-ups|powerman-pdu|dummy-ups) ;; *) echo "unsupported driver: $driver" >&2; exit 1 ;; esac
    if [ "$driver" = "powerman-pdu" ] && [ -z "$extra" ]; then
      echo "powerman-pdu requires a PDU identifier" >&2
      exit 1
    fi

    mkdir -p /etc/nut
    chown root:nut /etc/nut 2>/dev/null || true

    existing_password=""
    if [ -f /etc/nut/upsd.users ]; then
      existing_password="$(sed -n 's/^[[:space:]]*password[[:space:]]*=[[:space:]]*//p' /etc/nut/upsd.users | head -1)"
    fi
    password="$existing_password"
    [ -n "$password" ] || password="$(openssl rand -hex 16)"

    printf 'MODE=standalone\n' > /etc/nut/nut.conf

    port_effective="$port"
    if [ "$driver" = "dummy-ups" ]; then
      # dummy-ups reads its simulated values from a plain "key: value" file (the same
      # shape upsc itself prints, by design -- a real capture can be dropped in here
      # verbatim) -- NUT's own package ships no sample file, confirmed against the real
      # Debian package contents, so one is generated here rather than pointing at
      # something that doesn't exist. Fixed path regardless of whatever port value was
      # submitted for this driver -- there's nothing else it could meaningfully mean.
      port_effective=/etc/nut/dummy-ups.dev
      if [ ! -f "$port_effective" ]; then
        {
          printf 'battery.charge: 100\n'
          printf 'battery.runtime: 3600\n'
          printf 'battery.voltage: 13.5\n'
          printf 'device.model: Dummy UPS (simulated)\n'
          printf 'device.type: ups\n'
          printf 'input.voltage: 120.0\n'
          printf 'ups.load: 15\n'
          printf 'ups.mfr: Serial Killer Terminal Server\n'
          printf 'ups.model: Dummy UPS (simulated)\n'
          printf 'ups.status: OL\n'
        } > "$port_effective"
      fi
    fi

    {
      printf '[%s]\n' "$name"
      printf '\tdriver = %s\n' "$driver"
      printf '\tport = %s\n' "$port_effective"
      printf '\tdesc = "Managed by Serial Killer Terminal Server"\n'
      if [ "$driver" = "dummy-ups" ]; then
        printf '\tmode = dummy-once\n'
      fi
      if [ "$driver" = "snmp-ups" ] && [ -n "$extra" ]; then
        printf '\tcommunity = %s\n' "$extra"
      fi
      if [ "$driver" = "powerman-pdu" ]; then
        printf '\tidentifier = %s\n' "$extra"
      fi
    } > /etc/nut/ups.conf

    printf 'LISTEN 127.0.0.1 3493\n' > /etc/nut/upsd.conf

    {
      printf '[upsmon]\n'
      printf '\tpassword = %s\n' "$password"
      printf '\tupsmon primary\n'
      printf '\tactions = SET\n'
      printf '\tinstcmds = ALL\n'
    } > /etc/nut/upsd.users

    {
      printf 'MONITOR %s@localhost 1 upsmon %s primary\n' "$name" "$password"
      printf 'MINSUPPLIES 1\n'
      printf 'POLLFREQ 5\n'
      printf 'POLLFREQALERT 5\n'
      printf 'HOSTSYNC 15\n'
      # Deliberately NOT wired to an actual shutdown -- this app reports power events
      # (on battery, low battery) up to the hub via heartbeat/alerts, but a box
      # unexpectedly powering itself off is a much bigger decision than "monitor and
      # report," and not one to make on an admin's behalf implicitly. logger here just
      # gets the event into the system journal (and this app's own log, since it reads
      # journal/syslog) instead of silently doing nothing.
      printf 'NOTIFYCMD "/usr/bin/logger -t nut-monitor"\n'
      printf 'NOTIFYFLAG ONLINE SYSLOG\n'
      printf 'NOTIFYFLAG ONBATT SYSLOG\n'
      printf 'NOTIFYFLAG LOWBATT SYSLOG\n'
      printf 'NOTIFYFLAG COMMOK SYSLOG\n'
      printf 'NOTIFYFLAG COMMBAD SYSLOG\n'
      printf 'SHUTDOWNCMD "/usr/bin/logger -t nut-monitor NUT requested a shutdown, but this appliance does not act on it automatically"\n'
    } > /etc/nut/upsmon.conf

    chown root:nut /etc/nut/upsd.users /etc/nut/upsmon.conf 2>/dev/null || true
    chmod 640 /etc/nut/upsd.users /etc/nut/upsmon.conf
    chmod 644 /etc/nut/nut.conf /etc/nut/ups.conf /etc/nut/upsd.conf

    systemctl daemon-reload
    systemctl enable --now nut-server.service >/dev/null 2>&1 || true
    systemctl enable --now nut-monitor.service >/dev/null 2>&1 || true
    # nut-driver-enumerator (path unit watching ups.conf) starts the actual per-UPS
    # driver instance on its own within a couple of seconds of the file changing: no
    # direct systemctl call needed for it here, and calling one directly would race the
    # enumerator's own regeneration of the unit file.
    ;;
  ups-disable)
    systemctl disable --now nut-monitor.service >/dev/null 2>&1 || true
    systemctl disable --now nut-server.service >/dev/null 2>&1 || true
    ;;
  ups-status)
    # Read-only: reports whether nut is installed and upsd/upsmon are active, as
    # key=value lines the app parses -- mirrors lldp-status.
    installed=0; command -v upsd >/dev/null 2>&1 && installed=1
    serverActive=0; systemctl is-active --quiet nut-server.service 2>/dev/null && serverActive=1
    monitorActive=0; systemctl is-active --quiet nut-monitor.service 2>/dev/null && monitorActive=1
    echo "installed=$installed"
    echo "serverActive=$serverActive"
    echo "monitorActive=$monitorActive"
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
    echo "usage: system-helper.sh {lldp-install|lldp-status|lldp-set <en> <cdp> <fdp>|lldp-neighbors|ups-install|ups-configure <name> <driver> <port> [extra]|ups-disable|ups-status|enable|disable|scan|connect <ssid> [password]|ntp-set <server>|timezone-set <tz>|dns-set <servers...>|dns-clear|service-restart|ip-set <conn> <addr> <prefix> <gw>|ip-clear <conn>|os-password-set|reboot|hostname-set <name>}" >&2
    exit 1
    ;;
esac
