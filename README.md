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
  Optional TOTP-based two-factor authentication (Google Authenticator,
  Authy, 1Password, etc.), off by default — self-service per admin account
  from My Account, or admin-managed per console user from the Users tab
  (SSH prompts for the code via keyboard-interactive right after the
  password/key check; the web console prompts the same way admin login
  does).
- **Bulk user import** — add a whole roster of console accounts at once
  from a CSV file (Users tab), instead of one-by-one through the form.
  Only ever creates new accounts; a username that already exists is
  skipped, never overwritten.
- **In-place updates** — the About tab's Apply Update button patches a
  running Pi to a newer release (small app-only download, not a
  multi-gigabyte image) instead of requiring a full SD card re-flash.
  Checksum-verified, syntax-checked, and backed up before anything live is
  touched; one click rolls back if you change your mind. See
  [Applying updates](#applying-updates) below.
- **Dashboard tab** — live CPU, memory, and disk usage, total connected
  clients, and a live status (present/missing) and client count for every
  configured serial port.
- **System tab** — live uptime, a hostname field (change and it takes effect
  immediately, no reboot needed), a Reboot Now button, and a read-only
  system-information panel (OS release, kernel version, CPU model/cores,
  total memory, disk usage, Node.js and app versions) for support and
  troubleshooting without needing a separate shell session.
- **Per-port traffic counters and live debug** — the Serial Ports tab shows
  cumulative RX/TX byte counts per port since the app last started, plus a
  Debug button that opens a live, read-only hex/ASCII dump of traffic
  already crossing that port (it taps an active session; it doesn't open
  the port itself).
- **Session capture to file** — an optional per-port setting
  (`captureEnabled`) that logs every session on that port, byte for byte in
  the order it happened, to a plain-text file under
  `/opt/terminalserver/data/captures`. Browse, download, or delete captures
  from the Sessions tab.
- **Network tab** — shows every network interface's status, IP address, and
  connection name (via NetworkManager), plus this Pi's public IP if it has
  internet access. Also enables/disables the Wi-Fi radio and joins a Wi-Fi
  network (scan or type an SSID + password) directly from the admin UI.
  Also sets the **NTP server** (defaults to `pool.ntp.org`, with a live
  synced/not-synced status), the **timezone**, and a **DNS override** (or
  hand DNS back to whatever DHCP provides). **Static IP** lets you assign a
  fixed address/subnet mask/gateway per interface, or revert one to DHCP —
  a wrong value here can take that interface (and the admin UI, if you're
  on it) off the network, so it's not included in backup/restore and needs
  SSH or the physical console to recover from if it goes wrong.
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
  Optionally mirrored in real time to an **external syslog server** (UDP,
  RFC 3164/BSD format), off by default, configurable from the Log tab.
- **Last login tracking** — the Users and Admin Accounts tables show each
  account's most recent successful login (SSH, web console, or admin UI, as
  applicable), or "Never" if it hasn't been used yet.
- **Backup &amp; restore** — export the full config (ports, users, admin
  accounts, settings) as a single file and restore it later, optionally
  including the SSH host key so a restore reproduces the same host-key
  fingerprint instead of minting a new device identity. Also covers the
  NTP server, timezone, and DNS override, since those live outside
  `config.json` entirely (Wi-Fi credentials are deliberately not included —
  NetworkManager doesn't expose a saved password through a normal read).
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
  (`userconfig.service`) doesn't block on the physical console. Change its
  password from Admin Account → Pi System Account in the web UI, or with
  `passwd` once logged in over SSH — unlike the web UI's admin password,
  this one isn't force-rotated for you.


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

## Applying updates

Once a Pi is flashed and running, later releases (that publish an in-place
update package — see "Publishing a release" below) can be applied directly
from the admin UI instead of re-flashing:

1. About tab → **Check for Updates**.
2. If a newer version is available and publishes an update package, an
   **Apply Update** button appears. Confirming it downloads (~a few hundred
   KB, not the full image), checksum-verifies, syntax-checks, and installs
   dependencies for the new version in a staging area — all before the
   running service is touched — then backs up the current version, swaps
   in the new one, and restarts.
3. The page reconnects and reloads on its own once the service is back
   (a few seconds; active SSH/web-console sessions disconnect, same as any
   restart). **Roll Back to Previous Version** undoes the most recent
   update the same way, in reverse.

If the new version won't even start, `terminalserver.service` gives up
after 3 failed restarts within 60 seconds (rather than crash-looping), and
`sudo bash /opt/terminalserver/provisioning/rollback-update.sh` over SSH
restores the backup independently of whether the app is running at all.

### Publishing a release

For a release to be self-update-capable, its GitHub Release needs two
extra assets alongside the image — `build-image.sh` generates both in
`build/`:

- `terminalserver-app.tar.gz` — the app-only tarball (`server.js`,
  `package.json`/`package-lock.json`, `lib/`, `webui/`, `provisioning/`,
  no `node_modules`) that gets applied in place.
- `terminalserver-app.tar.gz.sha256` — its checksum. The updater refuses to
  apply a download that doesn't match this exactly.

Releases published without these two files still show up in **Check for
Updates** (so admins know a newer version exists), just without an
**Apply Update** button — re-flashing is the only option for those.

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
  capability set. The same helper script (and thus the same sudoers rule,
  unchanged) also handles the System tab's reboot and hostname-change
  actions — the sudoers grant covers the whole script file, not individual
  subcommands, so extending it never requires touching `setup.sh` or
  re-provisioning an already-deployed Pi.
- The in-place updater keeps this same narrow-privilege model: everything
  through staging, syntax-checking, `npm install`, and backup runs
  unprivileged as the `terminalserver` account (which already owns
  `/opt/terminalserver`) — the sudoers helper is only ever called for the
  final `systemctl restart terminalserver.service`, and only after
  everything else has already succeeded.
- A DNS override is applied to every currently-active NetworkManager
  connection (not just one), so it holds regardless of which interface,
  Ethernet or Wi-Fi, ends up carrying traffic. The Network tab's DNS field
  always reflects what's actually in effect (read from `/etc/resolv.conf`),
  whether that came from DHCP or an override set here.
- Two-factor auth (TOTP) is implemented in-house against RFC 4226/6238
  directly on Node's built-in `crypto` (`lib/totp.js`, verified against the
  official RFC 4226 test vectors) rather than pulling in a dependency for
  it. Lost your authenticator device with no other admin account to help?
  Same recovery path as a lost admin password: edit
  `/opt/terminalserver/data/config.json` over SSH on port 22 (clear that
  admin's `totpEnabled`/`totpSecret`) and restart the service.
- Session capture files (`/opt/terminalserver/data/captures`) accumulate
  indefinitely with no automatic rotation or cleanup — delete old ones from
  the Sessions tab (or the filesystem directly) if a port with capture
  enabled sees heavy, ongoing use on a space-constrained SD card. They're
  also not included in backup/restore, the same as TFTP files.
- Syslog forwarding is plain UDP (standard for BSD/RFC 3164 syslog) —
  unencrypted and unauthenticated in transit. Fine on a trusted LAN
  alongside the collector; route it through a VPN otherwise.
- `npm audit` is clean except one moderate `qs`/`express` advisory that
  can't be resolved without a major Express 4→5 upgrade — a bigger, separate
  effort given how much routing/middleware behavior a major version bump
  touches. Everything else (including the `multer` DoS advisories) is
  patched.
