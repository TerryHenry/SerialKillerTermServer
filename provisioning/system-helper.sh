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
    # Debian release/arch combination carries these packages, and a box that will never
    # use powerman-pdu/cyclades-pm10 shouldn't fail its whole UPS setup over it. "powerman"
    # is the separate daemon that actually speaks to serial/networked PDUs (Cyclades PM10
    # included, via its own stock device script); nut-powerman-pdu is just NUT's bridge
    # into it.
    nice -n 19 apt-get install -y --no-install-recommends nut-powerman-pdu || true
    nice -n 19 apt-get install -y --no-install-recommends powerman || true
    # powermand runs as its own unprivileged "powerman" user (see powerman.service), which
    # needs dialout membership to open a serial-attached PDU the same way "terminalserver"
    # itself does for console ports.
    usermod -aG dialout powerman 2>/dev/null || true
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
    # extra: driver-specific single value the Node side already picked out for us -- SNMP
    # community string for snmp-ups, the powerman device/node name for cyclades-pm10 (used
    # only in the powerman.conf this script generates, not written to ups.conf -- NUT's
    # powerman-pdu driver takes no extra settings at all), unused for every other driver.
    extra="${5:-}"
    # login/password: only meaningful for cyclades-pm10, where they're the PM10's own
    # serial console credentials (baked into a generated powerman device script -- see
    # below), not anything NUT itself knows about. Empty for every other driver.
    login="${6:-}"
    login_password="${7:-}"
    case "$name" in *[!a-zA-Z0-9_-]*|'') echo "invalid ups name: $name" >&2; exit 1 ;; esac
    case "$driver" in usbhid-ups|blazer_ser|blazer_usb|genericups|snmp-ups|powerman-pdu|cyclades-pm10|dummy-ups) ;; *) echo "unsupported driver: $driver" >&2; exit 1 ;; esac

    pm_dev_file=/etc/powerman/serial-killer-pm10.dev
    pm_conf_file=/etc/powerman/powerman.conf
    if [ "$driver" = "cyclades-pm10" ]; then
      [ -n "$login" ] || { echo "a login username is required for cyclades-pm10" >&2; exit 1; }
      case "$login" in *[\"\\]*) echo "username may not contain a quote or backslash" >&2; exit 1 ;; esac
      # A blank password on a reconfigure means "keep what's already there" (matches the
      # upsd monitoring password pattern just below) -- extracted from the previously
      # generated device script rather than re-prompting every time an admin just wants to
      # change, say, the port. Required outright the first time, since there's nothing to
      # fall back to yet.
      if [ -z "$login_password" ] && [ -f "$pm_dev_file" ]; then
        # The login script's two "send" lines (username, then password) are always the
        # first two lines matching this pattern anywhere in the generated file -- every
        # other script block (ping/status/on/off/cycle) comes later and follows the
        # login block, so the 2nd match is unambiguously the password.
        login_password="$(grep 'send "' "$pm_dev_file" | sed -n '2p' | sed -e 's/^[[:space:]]*send "//' -e 's/\\n"[[:space:]]*$//')"
      fi
      [ -n "$login_password" ] || { echo "a login password is required for the first cyclades-pm10 setup" >&2; exit 1; }
      case "$login_password" in *[\"\\]*) echo "password may not contain a quote or backslash" >&2; exit 1 ;; esac
      pm_name="$extra"
      case "$pm_name" in *[!a-zA-Z0-9_-]*|'') pm_name="pm10" ;; esac

      command -v powermand >/dev/null 2>&1 || { echo "powerman is not installed -- run ups-install first" >&2; exit 1; }
      usermod -aG dialout powerman 2>/dev/null || true

      # Same stock script Debian's powerman package ships at
      # /etc/powerman/cyclades-pm10.dev, with only the login send lines replaced -- the
      # factory-default script logs in as admin/pm8, which most real deployments change.
      # $1/$2 below are powerman's own regex capture-group references (its script
      # language), not shell variables, hence the escaping.
      cat > "$pm_dev_file" <<DEVEOF
#
# Cyclades PM10 (customized by Serial Killer Terminal Server with the configured login)
#
specification "pm10" {
	timeout 	10
	pingperiod	60
	plug name { "1" "2" "3" "4" "5" "6" "7" "8" "9" "10" }

	script login {
		expect "Username: "
		send "$login\n"
		expect "Password: "
		send "$login_password\n"
		expect "pm>"
	}
	script ping {
                send "\n"
                expect "pm>"
        }
	script status_all {
		send "status 1-10\n"
		expect "Users"
		foreachplug {
			expect "([0-9]+)[[:space:]]+Unlocked (ON|OFF)"
			setplugstate \$1 \$2 on="ON" off="OFF"
		}
		expect "pm>"
	}
	script on {
		send "on %s\n"
		expect "Outlet turned on."
		expect "pm>"
	}
	script on_all {
		send "on 1-10\n"
		foreachplug {
			expect "Outlet turned on."
		}
		expect "pm>"
	}
	script off {
		send "off %s\n"
		expect "Outlet turned off."
		expect "pm>"
	}
	script off_all {
		send "off 1-10\n"
		foreachplug {
			expect "Outlet turned off."
		}
		expect "pm>"
	}
	script cycle {
		send "off %s\n"
		expect "Outlet turned off."
		expect "pm>"
		delay 4
		send "on %s\n"
		expect "Outlet turned on."
		expect "pm>"
	}
	script cycle_all {
		send "off 1-10\n"
		foreachplug {
			expect "Outlet turned off."
		}
		expect "pm>"
		delay 4
		send "on 1-10\n"
		foreachplug {
			expect "Outlet turned on."
		}
		expect "pm>"
	}
	script status_temp_all {
		send "temperature\n"
		expect "IPDU #1: Temperature: ([0-9.]+)"
		setplugstate "1" \$1
		setplugstate "2" \$1
		setplugstate "3" \$1
		setplugstate "4" \$1
		setplugstate "5" \$1
		setplugstate "6" \$1
		setplugstate "7" \$1
		setplugstate "8" \$1
		setplugstate "9" \$1
		setplugstate "10" \$1
	}
}
DEVEOF
      # Owned by the powerman user itself (its own service account, not a shared group)
      # since the credentials inside are only meant to be readable by the daemon that
      # needs them and by root -- see powerman.service's "User=powerman".
      chown powerman:root "$pm_dev_file"
      chmod 600 "$pm_dev_file"

      {
        printf 'listen "127.0.0.1:10101"\n'
        printf 'include "%s"\n' "$pm_dev_file"
        printf 'device "%s" "pm10" "%s" "9600,8n1"\n' "$pm_name" "$port"
        printf 'node "%s-outlet[1-10]" "%s"\n' "$pm_name" "$pm_name"
      } > "$pm_conf_file"
      chown root:root "$pm_conf_file"
      chmod 644 "$pm_conf_file"

      systemctl daemon-reload
      systemctl enable powerman.service >/dev/null 2>&1 || true
      # powermand only reads its config at startup -- unlike nut-server below, an
      # enable --now on an already-running instance wouldn't pick up a changed login or
      # port, so this always restarts it outright.
      systemctl restart powerman.service
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
    driver_effective="$driver"
    if [ "$driver" = "cyclades-pm10" ]; then
      # The actual NUT-side driver is always powerman-pdu, talking to the powermand
      # instance this script just configured on localhost -- "cyclades-pm10" only exists
      # as a distinct choice at the app/UI level, to trigger the powerman setup above.
      driver_effective="powerman-pdu"
      port_effective="localhost:10101"
    fi
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
      printf '\tdriver = %s\n' "$driver_effective"
      printf '\tport = %s\n' "$port_effective"
      printf '\tdesc = "Managed by Serial Killer Terminal Server"\n'
      if [ "$driver" = "dummy-ups" ]; then
        printf '\tmode = dummy-once\n'
      fi
      if [ "$driver" = "snmp-ups" ] && [ -n "$extra" ]; then
        printf '\tcommunity = %s\n' "$extra"
      fi
      # powerman-pdu itself takes no extra ups.conf settings at all (confirmed against
      # its man page) -- whichever specific PDU/device it reports on is entirely
      # determined by what powermand was configured with above, not by anything here.
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
    echo "usage: system-helper.sh {lldp-install|lldp-status|lldp-set <en> <cdp> <fdp>|lldp-neighbors|ups-install|ups-configure <name> <driver> <port> [extra] [login] [login-password]|ups-disable|ups-status|enable|disable|scan|connect <ssid> [password]|ntp-set <server>|timezone-set <tz>|dns-set <servers...>|dns-clear|service-restart|ip-set <conn> <addr> <prefix> <gw>|ip-clear <conn>|os-password-set|reboot|hostname-set <name>}" >&2
    exit 1
    ;;
esac
