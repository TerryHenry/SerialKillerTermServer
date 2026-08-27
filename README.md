# Serial Killer Terminal Server

SSH-to-serial console server appliance, like a Digi PortServer/EZ. Supports
multiple simultaneous users and multiple serial ports, configured through a
web GUI. Ships as a bootable Raspberry Pi OS image.

This README covers building, flashing, and first boot. For day-to-day
administration and usage — the web admin UI, SSH console access, access
modes, TFTP — see [HANDBOOK.html](HANDBOOK.html).

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
  live sessions/logs.
- **Dashboard tab** — live CPU, memory, and disk usage, total connected
  clients, and a breakdown of how many clients are on each port.
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

## Building the image

Run on macOS, from this directory:

```bash
./build-image.sh
```

The first run downloads Raspberry Pi OS Lite (arm64), ~500MB. Subsequent
runs reuse the cached copy and just re-inject the app, so they're fast. This
script only mounts the FAT32 boot partition (`hdiutil`/`diskutil`) — it never
touches the Linux root filesystem from macOS.

Output:
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
