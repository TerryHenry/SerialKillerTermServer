# Serial Killer Terminal Server

SSH-to-serial console server appliance. Supports
multiple simultaneous users and multiple serial ports, configured through a
web GUI. Ships as a bootable Raspberry Pi OS image.

This is the perfect solution for a rack of equipment in a lab or training 
class that you can access remotely via SSH. Device password recovery or 
misconfiguration no longer requires the administrator to be physically 
onsite with a serial console connection.

This README covers building, flashing, and first boot. Already flashed and
just want to get connected? See [QUICKSTART.html](QUICKSTART.html). For the
full reference — the web admin UI, SSH console access, access modes, TFTP,
backup/restore — see [HANDBOOK.html](HANDBOOK.html).

## What's on the image

- **SSH server** (default port `2222`) — each user logs in over SSH and is
  either dropped straight into their assigned serial port, or shown a menu of
  configured ports to choose from. `Ctrl+]` detaches back to the port menu.
  A user with a dedicated (assigned) port is never shown the port menu: if
  that port doesn't exist, can't be opened, or drops mid-session, they're
  disconnected outright rather than falling back to a picker.
- Each serial port has an **access mode**: `exclusive` (one session at a
  time, the default), `shared-rw` (multiple sessions, all can type — input
  from any of them goes to the port and everyone sees all output),
  `first-write` (multiple sessions, but only the longest-connected one can
  type — everyone else is read-only until it disconnects, at which point
  write access automatically passes to the next-oldest remaining session,
  live, without anyone needing to reconnect), or `shared-ro` (multiple
  sessions, none can type — pure monitoring).
- Each user has a **permission**: `read-write` or `read-only`. A session can
  type only if *both* the connecting user is read-write *and* the port's own
  access mode allows writing — e.g. a read-only user is always read-only
  regardless of the port, and a `shared-ro` port blocks typing for everyone
  regardless of the user.
- **Web admin UI** (default port `8443`, HTTPS with a self-signed
  certificate generated on first run) — configure serial ports, users
  (password and/or SSH public-key auth), SSH server settings, TFTP, and view
  live sessions/logs. Supports multiple admin accounts (not just one shared
  login), and login attempts are throttled after repeated failures.
- **Dashboard tab** — live CPU, memory, and disk usage, total connected
  clients, and a live status (present/missing) and client count for every
  configured serial port.
- **Network tab** — shows every network interface's status, IP address, and
  connection name (via NetworkManager), plus this Pi's public IP if it has
  internet access. Also enables/disables the Wi-Fi radio and joins a Wi-Fi
  network (scan or type an SSID + password) directly from the admin UI.
  Also sets the **NTP server** (defaults to `pool.ntp.org`, with a live
  synced/not-synced status), the **timezone**, and a **DNS override** (or
  hand DNS back to whatever DHCP provides).
- **Web-based serial console** (`https://<pi>:8443/terminal`) — the same
  users configured in the Users tab can also get a serial console straight
  in the browser (xterm.js, no extra software), alongside SSH access. Users
  with a dedicated assigned port connect straight to it; others pick from a
  port menu that shows labels only (no device paths). Read-only users and
  read-only/shared port access modes are enforced identically to the SSH
  path. **Off by default** — turn it on from the toggle on the Server tab.
- SSH-to-serial itself can also be disabled from the Server tab: the
  Stop/Start button there persists (unlike a plain "stop," a disabled
  server stays disabled across a reboot instead of coming back via
  auto-start).
- **Sessions tab** — every active session across *both* access channels, SSH
  and the web console, in one list, tagged with a Method column so you can
  tell them apart. Disconnect works the same way regardless of which
  channel a session came in on.
- **Audit log** — admin actions (settings changes, port/user/admin
  create/delete, backup restores, TFTP file changes) are recorded, tagged
  with who did it, right alongside the rest of the server's activity log.
- **Backup &amp; restore** — export the full config (ports, users, admin
  accounts, settings) as a single file and restore it later, optionally
  including the SSH host key so a restore reproduces the same host-key
  fingerprint instead of minting a new device identity.
- **TFTP server** (default port `69`, off by default) — start/stop from the
  TFTP tab in the admin UI. Serves and accepts files (if uploads are
  enabled) from `/opt/terminalserver/data/tftp`, e.g. for pushing firmware
  or config files to/from network devices over their console port's
  neighboring management interface. The same tab lists what's in that
  directory, with buttons to upload a file from your machine or delete one.
- Runs as `terminalserver.service` under a dedicated unprivileged
  `terminalserver` system user (member of `dialout` for serial access), with
  `CAP_NET_BIND_SERVICE` granted so it can bind TFTP's privileged port 69
  without running as root.
- Normal Raspberry Pi OS SSH (port 22) is also enabled for admin access to
  the Pi itself, under a default Linux account (`admin` / `letmein0!`,
  same credentials as the web UI's default login) created during first boot
  so Raspberry Pi OS's own mandatory first-run account-creation prompt
  (`userconfig.service`) doesn't block on the physical console. Change it
  with `passwd` once logged in — unlike the web UI's admin password, this
  one isn't force-rotated for you.


Images:
- `build/terminalserver-pi.img` — flashable image
- `build/terminalserver-pi.img.gz` — same, gzip-compressed for transfer

## Flashing

Use [Raspberry Pi Imager](https://www.raspberrypi.com/software/) (or
`balenaEtcher`) and select "Use custom" with `terminalserver-pi.img(.gz)`.
Don't use Imager's own OS customization options — this image already carries
its own first-boot provisioning.

## First boot

1. Boot the Pi with network connectivity (Ethernet is simplest — no Wi-Fi is
   pre-configured on the image).
2. On first boot the image runs a one-time `firstrun.sh` (via a
   `systemd.run=` kernel command-line trigger — the same mechanism Raspberry
   Pi Imager's own customization uses) that installs systemd units and sets
   the hostname to `terminalserver`, then reboots.
3. After reboot, `terminalserver-setup.service` waits for real network
   connectivity, installs Node.js and the app's npm dependencies, then
   starts `terminalserver.service`. This step needs internet access and can
   take a few minutes; progress is logged to
   `/opt/terminalserver/data/setup.log` on the Pi (also visible via
   `journalctl -u terminalserver-setup`).
4. Once running, visit `https://terminalserver.local:8443` (or the Pi's IP)
   and sign in with the default admin account: **`admin` / `letmein0!`**.
   The certificate is self-signed, so your browser will warn on first visit
   — accept/proceed past it (or replace
   `/opt/terminalserver/data/tls/web_{key,cert}.pem` with your own CA-issued
   cert).
5. You'll immediately be required to set a new password before anything
   else in the admin UI works — the API itself enforces this (not just the
   UI), and it won't accept the default password as the replacement. Once
   changed, configure serial ports and users as normal.

## Notes / limitations

- The admin web UI's TLS certificate is self-signed and generated locally on
  first boot (`lib/tlsCert.js`, via `openssl`) — fine for a trusted LAN, but
  browsers will show a warning until you either accept it or swap in your
  own certificate.
- Re-running `build-image.sh` is safe — it strips any previously injected
  `cmdline.txt` trigger before adding its own.
- Wi-Fi, DNS, NTP, and timezone control rely on Raspberry Pi OS Bookworm's
  default NetworkManager (`nmcli`) and `systemd-timesyncd`/`timedatectl`
  stacks. The unprivileged `terminalserver` service account is granted a
  narrowly-scoped, validated `sudoers.d` rule during setup that lets it run
  exactly one fixed helper script (`provisioning/system-helper.sh`) as root
  — never a raw shell or arbitrary command. `terminalserver.service`
  intentionally carries no `CapabilityBoundingSet` restriction, because that
  setting applies to the whole process tree including the `sudo` child the
  app shells out to — a narrow bounding set breaks sudo's own root
  transition outright (`sudo: unable to change to root gid: Operation not
  permitted`). The actual privilege boundary is the sudoers rule, not the
  capability set.
- A DNS override is applied to every currently-active NetworkManager
  connection (not just one), so it holds regardless of which interface,
  Ethernet or Wi-Fi, ends up carrying traffic. The Network tab's DNS field
  always reflects what's actually in effect (read from `/etc/resolv.conf`),
  whether that came from DHCP or an override set here.
