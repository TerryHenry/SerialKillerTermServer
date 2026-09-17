'use strict';

const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { utils: sshUtils } = require('ssh2');
const configStore = require('./configStore');
const selfUpdate = require('./selfUpdate');
const sshServer = require('./sshServer');
const tftpServer = require('./tftpServer');
const pinnedHttps = require('./pinnedHttps');
const tunnelClient = require('./tunnelClient');
const { ensureHostKey } = require('./hostKeys');
const { logTimestamp } = require('./logTimestamp');
const { version: APP_VERSION } = require('../package.json');

const INTERVAL_MS = 30000;

// Must serialize identically to central-office-hub/lib/webServer.js's own copy of this
// function -- see the comment at its call site below for why.
function adminsFingerprint(admins) {
  const normalized = admins
    .map((a) => ({ username: a.username, passwordHash: a.passwordHash }))
    .sort((a, b) => a.username.localeCompare(b.username));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Every 30s while in managed mode, tells the hub this box is alive: signs a small
 * {version, ports} payload with the same edge identity key the tunnel itself uses
 * (lib/edgeIdentity.js) and POSTs it to the hub's own admin API. Prefers riding over
 * the tunnel connection that's already open (a plain-HTTP request through an SSH
 * channel to the hub's internal listener -- see postJson/postJsonOverTunnel below),
 * so nothing beyond the tunnel port itself ever needs to reach this box's network --
 * falling back to a direct connection to a different port (fleet.hubApiPort) only
 * when the tunnel isn't currently up. The hub verifies the signature against the
 * site's enrolled public key using the exact sshUtils.parseKey(...).verify() call
 * already proven in tunnelServer.js's own publickey auth -- one crypto path for both,
 * regardless of which transport carried it. The direct-connection fallback's TLS is
 * self-signed, same as this box's own, so rejectUnauthorized is off for that request --
 * lib/pinnedHttps.js pins the hub's actual certificate fingerprint
 * (fleet.hubTlsFingerprint) there instead, once an admin has copied it in from the
 * hub's own System tab.
 */
class FleetHeartbeat extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
  }

  log(line) {
    this.emit('log', `[${logTimestamp()}] [fleet] ${line}`);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log(`heartbeat failed: ${err.message}`));
    }, INTERVAL_MS);
    this.timer.unref();
    this.tick().catch((err) => this.log(`heartbeat failed: ${err.message}`));
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Verifies the hub's signed command before acting on it -- mirrors the exact
   * parseKey/verify primitive the hub uses to authenticate this box's own upstream
   * heartbeat payload, just in the other direction. Without this, anything on-path
   * between this box and the hub (realistic on a cellular WAN) could answer the
   * heartbeat itself and push arbitrary commands straight off an HTTPS response this
   * box never actually validated -- rejectUnauthorized was also false, so not even TLS
   * was doing real work here. sync-admins is the sharpest edge: it accepts
   * attacker-supplied {username, passwordSalt, passwordHash} triples, so an on-path
   * attacker could push themselves a working admin account rather than needing to crack
   * anything. Deliberately fails closed (refuses to act, does not trust-on-first-use)
   * when this box hasn't pinned the hub's host key yet, since these commands execute
   * unattended -- pin the hub's fingerprint in the Central Office panel to enable them. */
  verifyHubCommand(response, hubHostKeyFingerprint) {
    if (!response || !response.commandPayload || !response.commandSignature) {
      return { command: null, payload: null };
    }
    if (!hubHostKeyFingerprint) {
      this.log(
        'hub sent a command but this box has not pinned the hub\'s host key -- refusing to act on it (pin the hub\'s fingerprint, from the hub\'s own System tab, in this box\'s Central Office panel to enable hub-pushed commands)'
      );
      return { command: null, payload: null };
    }
    try {
      const hubKey = sshUtils.parseKey(hubHostKeyFingerprint);
      if (hubKey instanceof Error) throw hubKey;
      const verified = hubKey.verify(Buffer.from(response.commandPayload, 'utf8'), Buffer.from(response.commandSignature, 'base64'));
      if (verified !== true) {
        this.log('hub command signature verification failed -- ignoring (wrong pinned fingerprint, or a possible on-path tamperer)');
        return { command: null, payload: null };
      }
      const parsed = JSON.parse(response.commandPayload);
      return { command: parsed.command || null, payload: parsed.payload !== undefined ? parsed.payload : null };
    } catch (err) {
      this.log(`could not verify hub command signature: ${err.message}`);
      return { command: null, payload: null };
    }
  }

  async tick() {
    const { hubHost, hubApiPort } = configStore.getConfig().fleet;
    if (!hubHost) return;

    const { ensureEdgeIdentity } = require('./edgeIdentity');
    const identity = ensureEdgeIdentity(configStore.DATA_DIR);
    const config = configStore.getConfig();
    const payload = JSON.stringify({
      version: APP_VERSION,
      // present: the same fs.existsSync(device path) check this box's own Dashboard/
      // Serial Ports tab already uses (webServer.js's portStatuses()) -- lets the hub
      // show real per-port presence instead of just inferring "reachable" from whether
      // the tunnel itself is up. access: this port's own access mode
      // (exclusive/shared-rw/first-write/shared-ro), informational on the hub's side --
      // it can't enforce this itself (it doesn't own the port), only display it so an
      // admin granting hub-side permission understands what this port already allows.
      // path/baudRate/captureEnabled ride along too (not just id/label/present/access) so
      // a hub administrator can actually see and edit a complete picture of this box's
      // ports via "set-ports", rather than only the subset the topology diagram needs.
      ports: configStore.listPorts().map((p) => ({
        id: p.id,
        label: p.label,
        path: p.path,
        baudRate: p.baudRate,
        captureEnabled: !!p.captureEnabled,
        present: fs.existsSync(p.path),
        access: p.access || 'exclusive'
      })),
      sshEnabled: config.ssh.enabled,
      webTerminalEnabled: config.webTerminal.enabled,
      tftp: {
        running: tftpServer.isRunning(),
        port: config.tftp.port,
        allowUpload: config.tftp.allowUpload,
        autoStart: config.tftp.autoStart
      },
      // A one-way digest of {username, passwordHash} pairs, not the raw values --
      // avoids a sensitive credential payload riding along on every routine heartbeat
      // (sync-admins/backup already carry the real hashes, but only as a deliberate,
      // less-frequent action) while still letting the hub tell whether this box's admin
      // table *actually* matches its own. Comparing usernames alone (the previous
      // approach) gave a false "in sync" reading for any two boxes that both still use
      // the default "admin" username, regardless of whether Sync Admins was ever
      // applied -- passwordHash is included specifically to catch that. Must serialize
      // identically to the hub's own copy of this function
      // (central-office-hub/lib/webServer.js's adminsFingerprint) or a truly matching
      // table would never compare equal.
      adminsFingerprint: adminsFingerprint(configStore.listAdmins()),
      // Lets the hub warn an admin when a site has never pinned its fingerprint --
      // since verifyHubCommand() above fails closed in that state, an unpinned site
      // silently ignores every command the hub pushes (updates, backup restore, admin
      // sync, port/access/TFTP config) rather than erroring, which would otherwise look
      // identical to "everything's fine" from the hub's side.
      hubKeyPinned: !!config.fleet.hubHostKeyFingerprint
    });

    const key = sshUtils.parseKey(identity.privateKey);
    const signature = key.sign(Buffer.from(payload, 'utf8'));
    if (signature instanceof Error) throw signature;

    const body = JSON.stringify({
      publicKey: identity.publicKey,
      payload,
      signature: signature.toString('base64')
    });

    const response = await this.postJson(hubHost, hubApiPort, '/api/fleet/heartbeat', body, config.fleet.hubTlsFingerprint);
    const { command, payload: commandPayload } = this.verifyHubCommand(response, config.fleet.hubHostKeyFingerprint);
    if (command === 'apply-update') {
      this.log('hub queued an update -- applying');
      if (!selfUpdate.isUpdating()) {
        selfUpdate.applyUpdate().catch(() => {
          // Already logged inside applyUpdate itself.
        });
      }
    } else if (command === 'send-backup') {
      this.log('hub requested a config backup -- sending');
      await this.sendBackup(hubHost, hubApiPort, identity, config.fleet.hubTlsFingerprint).catch((err) => {
        this.log(`sending config backup failed: ${err.message}`);
      });
    } else if (command === 'restore-backup') {
      this.log('hub pushed a config restore -- applying');
      try {
        configStore.importConfig(commandPayload);
        this.log('config restored from the hub-pushed backup -- some settings may need a service restart to fully take effect');
      } catch (err) {
        this.log(`config restore failed: ${err.message}`);
      }
    } else if (command === 'sync-admins') {
      this.log('hub pushed an admin sync -- replacing local admin accounts');
      try {
        const synced = configStore.replaceAdmins(commandPayload);
        this.log(`local admin accounts now match the hub's (${synced.length} account${synced.length === 1 ? '' : 's'}) -- any admin session not in that list will need to log in again`);
      } catch (err) {
        this.log(`admin sync failed, local admins unchanged: ${err.message}`);
      }
    } else if (command === 'set-ports') {
      this.log('hub pushed a port configuration -- replacing local serial ports');
      try {
        const ports = configStore.replacePorts(commandPayload);
        this.log(`local ports now match the hub's pushed configuration (${ports.length} port${ports.length === 1 ? '' : 's'})`);
      } catch (err) {
        this.log(`port configuration failed, local ports unchanged: ${err.message}`);
      }
    } else if (command === 'set-local-access') {
      const { sshEnabled, webTerminalEnabled } = commandPayload || {};
      this.log(`hub pushed local access settings -- SSH ${sshEnabled ? 'enabled' : 'disabled'}, web console ${webTerminalEnabled ? 'enabled' : 'disabled'}`);
      try {
        configStore.updateWebTerminal({ enabled: !!webTerminalEnabled });
        configStore.updateSSH({ enabled: !!sshEnabled });
        if (sshEnabled) {
          const hostKey = ensureHostKey(configStore.DATA_DIR);
          sshServer.start(hostKey.privateKey);
        } else {
          sshServer.stop();
        }
      } catch (err) {
        this.log(`applying hub-pushed local access settings failed: ${err.message}`);
      }
    } else if (command === 'set-tftp') {
      const { enabled, port, allowUpload, autoStart } = commandPayload || {};
      this.log(`hub pushed TFTP server settings -- ${enabled ? 'enabled' : 'disabled'}, port ${port}`);
      try {
        configStore.updateTftp({ port, allowUpload: !!allowUpload, autoStart: !!autoStart });
        if (enabled) {
          if (tftpServer.isRunning()) tftpServer.stop();
          tftpServer.start(port, configStore.TFTP_ROOT_DIR, !!allowUpload);
        } else {
          tftpServer.stop();
        }
      } catch (err) {
        this.log(`applying hub-pushed TFTP settings failed: ${err.message}`);
      }
    }
  }

  /** Pushes this box's own config up to the hub in response to a queued "send-backup"
   * command -- deliberately excludes the SSH host key (unlike the manual /api/backup
   * download, which offers that as an opt-in checkbox): auto-transmitting a private key
   * over an unattended channel is a bigger step than a deliberate admin action. */
  async sendBackup(hubHost, hubApiPort, identity, hubTlsFingerprint) {
    const payload = JSON.stringify({ backup: configStore.getConfig() });
    const key = sshUtils.parseKey(identity.privateKey);
    const signature = key.sign(Buffer.from(payload, 'utf8'));
    if (signature instanceof Error) throw signature;
    const body = JSON.stringify({ publicKey: identity.publicKey, payload, signature: signature.toString('base64') });
    await this.postJson(hubHost, hubApiPort, '/api/fleet/backup', body, hubTlsFingerprint);
  }

  // Prefers routing this over the tunnel that's already open (tunnelClient.js's
  // openHubApiChannel) so heartbeat/backup never actually need fleet.hubApiPort
  // reachable on its own -- only the tunnel port has to get through a firewall.
  // Falls back to a direct connection to hubApiPort whenever the tunnel isn't
  // currently up (including the first heartbeat right after enabling managed mode,
  // before the tunnel has finished connecting) or the tunneled attempt itself fails
  // for any reason -- an admin who hasn't closed off hubApiPort loses nothing by
  // this preferring the tunnel first.
  async postJson(host, port, urlPath, body, hubTlsFingerprint) {
    if (tunnelClient.status().connected) {
      try {
        const stream = await tunnelClient.openHubApiChannel();
        return await this.postJsonOverTunnel(stream, urlPath, body);
      } catch (err) {
        this.log(`tunneled request failed (${err.message}) -- falling back to a direct connection`);
      }
    }
    return pinnedHttps.postJson(host, port, urlPath, body, hubTlsFingerprint, (line) => this.log(line));
  }

  /** Posts JSON to the hub's internal API over an already-open tunnel channel -- plain
   * HTTP, not HTTPS: the channel is already flowing through the tunnel's own
   * authenticated, encrypted SSH connection (tunnelClient.js's host-key pinning), so a
   * second TLS layer on top of it would be redundant -- and layering TLS over a
   * non-net.Socket duplex stream like an SSH channel is exactly the case Node's own
   * tls.connect docs warn is unreliable. The payload's ed25519 signature (verified by
   * the hub's route handler regardless of transport) is what actually authenticates it
   * either way; this transport choice doesn't weaken that. */
  postJsonOverTunnel(stream, urlPath, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          createConnection: () => stream,
          path: urlPath,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 10000
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`hub returned HTTP ${res.statusCode}: ${data}`));
            }
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error('hub returned invalid JSON'));
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.write(body);
      req.end();
    });
  }
}

module.exports = new FleetHeartbeat();
