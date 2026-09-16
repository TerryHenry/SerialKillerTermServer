'use strict';

const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { utils: sshUtils } = require('ssh2');
const configStore = require('./configStore');
const selfUpdate = require('./selfUpdate');
const sshServer = require('./sshServer');
const tftpServer = require('./tftpServer');
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
 * (lib/edgeIdentity.js) and POSTs it to the hub's own admin API (a different port than
 * the tunnel/SSH listener -- fleet.hubApiPort). The hub verifies the signature against
 * the site's enrolled public key using the exact sshUtils.parseKey(...).verify() call
 * already proven in tunnelServer.js's own publickey auth -- one crypto path for both.
 * The hub's cert is self-signed, same as this box's own -- verified another way (the
 * signature), not by TLS trust, matching the tunnel's own unverified-by-default posture
 * ahead of Phase 4's host-key pinning.
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
      adminsFingerprint: adminsFingerprint(configStore.listAdmins())
    });

    const key = sshUtils.parseKey(identity.privateKey);
    const signature = key.sign(Buffer.from(payload, 'utf8'));
    if (signature instanceof Error) throw signature;

    const body = JSON.stringify({
      publicKey: identity.publicKey,
      payload,
      signature: signature.toString('base64')
    });

    const response = await this.postJson(hubHost, hubApiPort, '/api/fleet/heartbeat', body);
    if (response.command === 'apply-update') {
      this.log('hub queued an update -- applying');
      if (!selfUpdate.isUpdating()) {
        selfUpdate.applyUpdate().catch(() => {
          // Already logged inside applyUpdate itself.
        });
      }
    } else if (response.command === 'send-backup') {
      this.log('hub requested a config backup -- sending');
      await this.sendBackup(hubHost, hubApiPort, identity).catch((err) => {
        this.log(`sending config backup failed: ${err.message}`);
      });
    } else if (response.command === 'restore-backup') {
      this.log('hub pushed a config restore -- applying');
      try {
        configStore.importConfig(response.payload);
        this.log('config restored from the hub-pushed backup -- some settings may need a service restart to fully take effect');
      } catch (err) {
        this.log(`config restore failed: ${err.message}`);
      }
    } else if (response.command === 'sync-admins') {
      this.log('hub pushed an admin sync -- replacing local admin accounts');
      try {
        const synced = configStore.replaceAdmins(response.payload);
        this.log(`local admin accounts now match the hub's (${synced.length} account${synced.length === 1 ? '' : 's'}) -- any admin session not in that list will need to log in again`);
      } catch (err) {
        this.log(`admin sync failed, local admins unchanged: ${err.message}`);
      }
    } else if (response.command === 'set-ports') {
      this.log('hub pushed a port configuration -- replacing local serial ports');
      try {
        const ports = configStore.replacePorts(response.payload);
        this.log(`local ports now match the hub's pushed configuration (${ports.length} port${ports.length === 1 ? '' : 's'})`);
      } catch (err) {
        this.log(`port configuration failed, local ports unchanged: ${err.message}`);
      }
    } else if (response.command === 'set-local-access') {
      const { sshEnabled, webTerminalEnabled } = response.payload || {};
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
    } else if (response.command === 'set-tftp') {
      const { enabled, port, allowUpload, autoStart } = response.payload || {};
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
  async sendBackup(hubHost, hubApiPort, identity) {
    const payload = JSON.stringify({ backup: configStore.getConfig() });
    const key = sshUtils.parseKey(identity.privateKey);
    const signature = key.sign(Buffer.from(payload, 'utf8'));
    if (signature instanceof Error) throw signature;
    const body = JSON.stringify({ publicKey: identity.publicKey, payload, signature: signature.toString('base64') });
    await this.postJson(hubHost, hubApiPort, '/api/fleet/backup', body);
  }

  postJson(host, port, urlPath, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host,
          port,
          path: urlPath,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          rejectUnauthorized: false,
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
