# Serial Killer Terminal Server

Latest Release is here: https://github.com/TerryHenry/SerialKillerTermServer/releases

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
  certificate generated on first run) — a sidebar nav groups its ten tabs by
  purpose (Access, Network, Server, Security, plus Dashboard and About on
  their own), destructive actions (reboot, restore-from-backup, factory
  reset) are set apart in a visually distinct "Danger Zone" wherever they
  appear, and the whole UI follows the OS/browser's light or dark
  preference automatically. Configure serial ports, users
  (password and/or SSH public-key auth), SSH server settings, TFTP, and view
  live sessions/logs. Supports multiple admin accounts (not just one shared
  login), and login attempts are throttled after repeated failures.
  Optional TOTP-based two-factor authentication (Google Authenticator,
  Authy, 1Password, etc.), off by default — self-service per admin account
  from My Account, or admin-managed per console user from the Users tab
  (SSH prompts for the code via keyboard-interactive right after the
  password/key check; the web console prompts the same way admin login
  does). The Password Policy panel can also *require* it for every admin
  account — an admin without it set up is walked straight into enrollment
  immediately after their next login, before reaching anything else.
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
- **Dashboard tab** — live CPU, memory, disk, and uptime, total connected
  clients, a live status (present/missing) and client count for every
  configured serial port, and a read-only system-information panel (OS
  release, kernel version, CPU model/cores, total memory, disk usage,
  Node.js and app versions).
- **Network tab** also carries a System Control panel: a hostname field
  (change and it takes effect immediately, no reboot needed). Changing the
  hostname leaves the existing `<name>.local` mDNS address alone unless you
  also check **Also update the mDNS (.local) name**, which restarts
  `avahi-daemon` so it catches up to match — opt-in, so a rename can't
  silently break something else that's bookmarked the old `.local` address.
- **Server tab** has a Danger Zone with Restore from Backup, Reset to
  Factory Default, and Reboot Now grouped together, set apart from the
  routine settings above them.
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
- **Device paths hidden by default** on the Serial Ports tab (screen-privacy
  convenience, not an access control) — click **Show Device Paths** to
  reveal them for the session, or again to re-hide.
- **TLS certificate management** (Admin Account tab) — view the web UI's
  current HTTPS certificate (type, subject, issuer, validity, SHA-256
  fingerprint), upload a custom cert + key pair (PEM) to replace the
  auto-generated self-signed one, or revert back to a fresh self-signed
  cert. The uploaded pair is validated (parseable, and the key actually
  matches the cert) entirely in memory before anything live is touched, so
  a bad upload can't break HTTPS access. Takes effect after a restart — a
  **Restart Service Now** button is right there for it.
- **Reset to Factory Default** (Server tab) — wipes ports, console users,
  admin accounts, and SSH/TFTP/web/syslog settings back to defaults
  (reseeding the default admin account with a forced password change).
  Deliberately scoped to `config.json`: network settings, the SSH host key,
  the TLS certificate, and session captures are untouched. Requires typing
  `RESET` to confirm; the service restarts immediately afterward.
- **Password policy** (Admin Account tab) — one configurable policy enforced
  everywhere a password gets set: admin accounts, the Pi System Account, and
  console users. Defaults to a 12-character minimum plus a check against a
  bundled list of ~10,000 commonly breached passwords (checked locally, no
  network call), favoring length over mandatory complexity per current NIST
  800-63B guidance — with optional toggles (min length 8–64, require
  upper/lowercase, a digit, a symbol) for appliances under a policy that
  requires them. Every password field's hint text reflects the live policy.
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
  Transfers negotiate a larger block size and window (RFC 2347/2348/2349/7440)
  when the client asks, stream from disk instead of loading whole files into
  memory, and uploads land under a temporary name until they complete.
- **Neighbor discovery (LLDP / CDP / FDP)** — the Network tab shows which
  switch and port each interface is connected to, via `lldpd` (installed
  during first-boot setup, and fetched automatically on the first start of an
  existing Pi that lacks it -- needs internet).
  LLDP is on by default; CDP (Cisco) and FDP (Foundry/Brocade) listening are
  optional switches on the same panel. A managed box's hub can also read its
  neighbors and change these settings remotely.
- **Baud auto-detect** — in the Add/Edit Serial Port dialog, **Auto-detect** listens at
  each common speed (8N1, then 7E1) after sending a carriage return and fills in the
  first one that returns readable text. It refuses a port that has a live session, and
  only opens devices this box actually reports.
- **Batch actions** — the Batch tab runs one script against several of this box's serial
  ports at once, for jobs like logging in and rebooting, factory-resetting or upgrading a
  set of devices. Steps are one per line (`login`, `send`, `expect`, `expect-regex`,
  `wait`, `set`; any other line is typed as a command), with `{{username}}`/`{{password}}`
  filled in per device from fields that are never saved. It goes through the same access
  modes as any session: a port a user has open (exclusive) fails with that reason, and a
  read-only port is refused. Each port gets a record of per-step status, the device's
  output and any failure reason; batches can be cancelled, scripts saved as templates, and
  the last 50 batches are kept. (The Central Office hub has the same feature across sites.)- **Hub forwarding** — the Central Office panel has an **Allow hub forwarding** switch
  (on by default). With it on, a Central Office admin can reach a device on this box's
  network (a switch's web page, an SSH login) through the tunnel using a hub-side
  "Forward". The box only ever connects to the named device on its own network -- never to
  itself (loopback is refused) -- and refuses everything when the switch is off.- **Admin idle timeout** — admins are signed out after a period with no mouse or
  keyboard activity (Admin Account tab; default 5 minutes, 0 disables it), enforced by
  the server as well as the browser.
- **Configurable dashboard** — hide, show and reorder the Dashboard's widgets (System,
  Serial Ports, System Information, Active Sessions, Recent Activity) with
  **Customize**; the layout is remembered in that browser.
- The SSH port menu no longer shows device paths, only each port's label and baud rate.- **Hub-managed users** — when this box is managed by a Central Office hub,
  the hub can push console users to it (Sync Users / "Push to edge sites").
  Those logins are password-only and replaced wholesale on each sync;
  accounts created locally here are never touched, and a local account wins
  if a pushed username collides with it.
- Runs as `terminalserver.service` under a dedicated unprivileged
  `terminalserver` system user (member of `dialout` for serial access), with
  `CAP_NET_BIND_SERVICE` granted so it can bind TFTP's privileged port 69
  without running as root.
- Normal Raspberry Pi OS SSH (port 22) is also enabled for admin access to
  the Pi itself, under a default Linux account (`admin` / `letmein0!`,
  same credentials as the web UI's default login) created during first boot
  so Raspberry Pi OS's own mandatory first-run account-creation prompt
  (`userconfig.service`) doesn't block on the physical console. Its
  password is expired immediately (`passwd -e`), so the first console or
  SSH login is forced to set a real one before getting a shell — the same
  effect as the web UI's forced first-login change, just enforced by the
  OS instead of the app. Change it proactively from Admin Account → Pi
  System Account in the web UI, or with `passwd` once logged in over SSH,
  if you'd rather not wait to be prompted.


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

For a release to be self-update-capable, its GitHub Release needs three
extra assets alongside the image — `build-image.sh` generates all three in
`build/`:

- `terminalserver-app.tar.gz` — the app-only tarball (`server.js`,
  `package.json`/`package-lock.json`, `lib/`, `webui/`, `provisioning/`,
  no `node_modules`) that gets applied in place.
- `terminalserver-app.tar.gz.sha256` — its checksum. The updater refuses to
  apply a download that doesn't match this exactly.
- `terminalserver-app.tar.gz.sig` — a detached Ed25519 signature over the
  checksum file, verified against `release-signing-pubkey.pem` (baked into
  the image at build time, never fetched from GitHub). The checksum alone
  only proves a download matches what GitHub is *currently* serving, not
  who put it there — anyone with release access (or a hijacked release
  pipeline) could otherwise publish a tarball and a matching checksum
  together. The signature is what actually proves authorship.

  Generate this by running `build-image.sh` with `RELEASE_SIGNING_KEY` set
  to the path of your Ed25519 **private** key's PEM file — keep that file
  out of this repo entirely (password manager, hardware key, offline
  storage) and pass its path in explicitly every time:

  ```
  RELEASE_SIGNING_KEY=/path/to/release-signing-key.PRIVATE.pem ./build-image.sh
  ```

  A build without `RELEASE_SIGNING_KEY` set still works for everything
  except self-update — enrolled appliances correctly refuse to self-apply
  an update from a release that doesn't publish a valid signature. To
  generate a new keypair (only ever needed once, or when deliberately
  rotating): `node -e "const{publicKey,privateKey}=require('crypto').generateKeyPairSync('ed25519',{publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});console.log(publicKey,privateKey)"`
  — commit the public half as `release-signing-pubkey.pem` at the repo
  root, and move the private half somewhere secure immediately.

Releases published without these files still show up in **Check for
Updates** (so admins know a newer version exists), just without an
**Apply Update** button — re-flashing is the only option for those.

## Notes / limitations

- Session/request hardening: every login (admin, 2FA-completed, first-run
  setup, and the separate web-console login) regenerates the session id,
  closing session fixation. Every state-changing request needs a per-session
  CSRF token echoed back in a header, on top of `SameSite=Lax`. The web
  console's own WebSocket connection separately checks its `Origin`, since
  `SameSite` doesn't cover a WS handshake the way it covers a form POST.
  Responses carry `X-Frame-Options`, `X-Content-Type-Options`,
  `Referrer-Policy`, and HSTS. First-run admin setup is rate-limited the
  same way login is.
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
  unchanged) also handles the Server tab's reboot action and the Network
  tab's hostname change — the sudoers grant covers the whole script file,
  not individual subcommands, so extending it never requires touching
  `setup.sh` or re-provisioning an already-deployed Pi.
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
  admin's `totpEnabled`/`totpSecret`) and restart the service. If
  `passwordPolicy.requireAdminTotp` is on, that just re-enrolls them on
  their next login (a fresh QR to scan) rather than letting them skip 2FA
  — the policy still applies once they're back in.
- The breached-password list backing the password policy
  (`lib/data/common-passwords.txt`, ~10,000 entries, ~70&nbsp;KB, sourced
  from SecLists) is bundled at build time and checked entirely in-process —
  no network call, no third-party API, ever. Tightening the policy only
  applies going forward; it doesn't retroactively invalidate passwords set
  before the change.
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

## License

[MIT](LICENSE)
