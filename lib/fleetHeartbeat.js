'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const { utils: sshUtils } = require('ssh2');
const configStore = require('./configStore');
const selfUpdate = require('./selfUpdate');
const { logTimestamp } = require('./logTimestamp');
const { version: APP_VERSION } = require('../package.json');

const INTERVAL_MS = 30000;

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
      ports: configStore.listPorts().map((p) => ({ id: p.id, label: p.label })),
      sshEnabled: config.ssh.enabled,
      webTerminalEnabled: config.webTerminal.enabled,
      // Usernames only, never salts/hashes -- enough for the hub to tell whether this
      // box's admin table currently matches its own, without a sensitive credential
      // payload riding along on every routine heartbeat (sync-admins/backup already
      // carry the real hashes, but only as a deliberate, less-frequent action).
      adminUsernames: configStore.listAdmins().map((a) => a.username)
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
