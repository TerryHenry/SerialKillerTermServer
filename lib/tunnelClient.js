'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const { Client, utils: sshUtils } = require('ssh2');
const { EventEmitter } = require('events');
const configStore = require('./configStore');
const serialManager = require('./serialManager');
const systemInfo = require('./systemInfo');
const systemStats = require('./systemStats');
const networkInfo = require('./networkInfo');
const sshServer = require('./sshServer');
const webTerminal = require('./webTerminal');
const { logTimestamp } = require('./logTimestamp');
const { version: APP_VERSION } = require('../package.json');

const RECONNECT_DELAY_MS = 5000;

/** Same rule the local TFTP upload route (webServer.js) enforces -- kept here too since
 * this is a separate entry point into the same directory. */
function sanitizeTftpFilename(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || base === '.' || base === '..') {
    throw new Error('invalid filename');
  }
  return base;
}

/**
 * Manages this box's outbound tunnel to a Central Office hub, when in managed mode.
 * Connects out (never listens for inbound hub connections -- the whole point is that no
 * wiring closet needs an open inbound port), registers one remote forward, and for every
 * connection the hub opens back through it, reads a one-line JSON handshake naming which
 * locally-configured port to bridge to. From there it's the same bidirectional-pipe shape
 * lib/sshServer.js already uses for a local session, just fed by a tunneled socket instead
 * of a directly-connected SSH client.
 */
class TunnelClient extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.stopped = true;
  }

  log(line) {
    this.emit('log', `[${logTimestamp()}] [fleet] ${line}`);
  }

  status() {
    return { connected: this.connected };
  }

  start() {
    this.stopped = false;
    this.connectOnce();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.client) this.client.end();
    this.connected = false;
    this.emit('status-changed');
  }

  connectOnce() {
    if (this.stopped) return;
    const { hubHost, hubPort, hubHostKeyFingerprint } = configStore.getConfig().fleet;
    if (!hubHost) {
      this.log('no hub configured, not connecting');
      return;
    }

    const { ensureEdgeIdentity } = require('./edgeIdentity');
    const identity = ensureEdgeIdentity(configStore.DATA_DIR);

    const client = new Client();
    this.client = client;

    client.on('ready', () => {
      this.connected = true;
      this.log(`connected to hub ${hubHost}:${hubPort}`);
      this.emit('status-changed');
      client.forwardIn('127.0.0.1', 0, (err) => {
        if (err) this.log(`forwardIn failed: ${err.message}`);
      });
    });

    client.on('tcp connection', (info, accept, reject) => {
      let channel;
      try {
        channel = accept();
      } catch (err) {
        this.log(`failed to accept tunneled connection: ${err.message}`);
        return;
      }
      this.bridgeChannel(channel);
    });

    client.on('close', () => {
      this.connected = false;
      this.emit('status-changed');
      if (!this.stopped) {
        this.log(`disconnected from hub, retrying in ${RECONNECT_DELAY_MS / 1000}s`);
        this.reconnectTimer = setTimeout(() => this.connectOnce(), RECONNECT_DELAY_MS);
      }
    });

    client.on('error', (err) => {
      this.log(`tunnel error: ${err.message}`);
    });

    client.connect({
      host: hubHost,
      port: hubPort,
      username: '_edge',
      privateKey: identity.privateKey,
      readyTimeout: 10000,
      // Blank fingerprint = unverified, same as before this existed (keeps an
      // already-enrolled site working without a forced migration). A pinned one is
      // compared as parsed key bytes, the same technique the hub's own tunnelServer.js
      // uses to match a site by its public key -- not a string/text comparison.
      hostVerifier: (presentedKey) => {
        if (!hubHostKeyFingerprint) return true;
        try {
          const expected = sshUtils.parseKey(hubHostKeyFingerprint);
          if (expected instanceof Error) return false;
          return presentedKey.equals(expected.getPublicSSH());
        } catch {
          return false;
        }
      }
    });
  }

  /** Reads the one-line JSON handshake, then bridges the rest of the stream according to
   * what it asks for: either a serial port ({"portId":...}) or this box's own local
   * admin UI ({"admin":true}), the latter letting a hub operator reach the web admin
   * panel without needing direct network access to this box. */
  bridgeChannel(channel) {
    let buf = Buffer.alloc(0);
    let handshakeDone = false;

    const onData = (chunk) => {
      if (handshakeDone) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > 1024) {
          channel.end('bad handshake\n');
        }
        return;
      }
      handshakeDone = true;
      channel.removeListener('data', onData);
      const line = buf.slice(0, nl).toString('utf8').trim();
      const rest = buf.slice(nl + 1);

      let handshake;
      try {
        handshake = JSON.parse(line);
      } catch {
        channel.end('bad handshake\n');
        return;
      }

      if (handshake.admin) {
        this.openAdminSession(channel, rest);
        return;
      }

      if (handshake.listDevices) {
        this.sendDeviceList(channel);
        return;
      }

      if (handshake.siteInfo) {
        this.sendSiteInfo(channel);
        return;
      }

      if (handshake.uploadTftp) {
        this.receiveTftpUpload(channel, handshake, rest);
        return;
      }

      const portConfig = configStore.listPorts().find((p) => p.id === handshake.portId);
      if (!portConfig) {
        channel.end(`no such port: ${handshake.portId}\n`);
        return;
      }
      this.openPortSession(channel, portConfig, rest);
    };
    channel.on('data', onData);
    channel.once('error', () => {});
  }

  /** Bridges a tunneled channel directly to this box's own local HTTPS admin UI. Pure
   * byte-for-byte passthrough -- TLS is negotiated end-to-end between the browser that
   * eventually connects and this box's own cert (self-signed or custom), never touched
   * or terminated by the hub or this bridge. */
  openAdminSession(channel, leftoverData) {
    const webPort = configStore.getConfig().web.port;
    const sock = net.connect(webPort, '127.0.0.1', () => {
      if (leftoverData && leftoverData.length) sock.write(leftoverData);
      this.log('fleet admin-UI tunnel session connected');
    });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      channel.removeListener('data', onChannelData);
      channel.removeListener('close', onChannelClose);
      channel.removeListener('error', onChannelClose);
      sock.removeListener('data', onSockData);
      sock.removeListener('close', onSockClose);
      sock.removeListener('error', onSockClose);
      sock.destroy();
      this.log('fleet admin-UI tunnel session disconnected');
    };

    const onSockData = (data) => {
      if (!channel.destroyed) channel.write(data);
    };
    const onChannelData = (data) => {
      if (!sock.destroyed) sock.write(data);
    };
    const onSockClose = () => {
      channel.end();
      finish();
    };
    const onChannelClose = () => finish();

    channel.on('data', onChannelData);
    channel.once('close', onChannelClose);
    channel.once('error', onChannelClose);
    sock.on('data', onSockData);
    sock.once('close', onSockClose);
    sock.once('error', onSockClose);
  }

  /** One-shot request/response, unlike openAdminSession/openPortSession's indefinite
   * bidirectional bridges: writes a single JSON line (this box's available serial
   * devices, the same list its own local "Refresh" button uses) and ends the channel --
   * lets a hub operator's "Configure Ports" UI offer a real device picker instead of a
   * blind text field, without needing a live network path to this box at all. */
  sendDeviceList(channel) {
    serialManager
      .listSystemPorts()
      .then((ports) => {
        channel.end(`${JSON.stringify({ ok: true, ports })}\n`);
      })
      .catch((err) => {
        channel.end(`${JSON.stringify({ ok: false, error: err.message })}\n`);
      });
  }

  /** Another one-shot request/response: the same fields this box's own Dashboard and
   * Network tab show about itself, gathered fresh on request rather than carried on
   * every heartbeat (this is a lot more than the heartbeat needs routinely). */
  sendSiteInfo(channel) {
    Promise.all([
      Promise.resolve(systemInfo.getSystemInfo()),
      systemStats.getStats(configStore.DATA_DIR),
      networkInfo.getInterfaces(),
      networkInfo.getPublicIp().catch(() => null)
    ])
      .then(([info, stats, interfaces, publicIp]) => {
        channel.end(
          `${JSON.stringify({
            ok: true,
            hostname: info.hostname,
            mdnsName: `${info.hostname}.local`,
            osRelease: info.osRelease,
            kernel: info.kernel,
            arch: info.arch,
            cpuModel: info.cpuModel,
            cpuCores: info.cpuCores,
            cpuPercent: stats.cpuPercent,
            memory: stats.memory,
            disk: stats.disk,
            uptimeSec: info.uptimeSec,
            nodeVersion: info.nodeVersion,
            appVersion: APP_VERSION,
            clientsConnected: sshServer.listSessions().length + webTerminal.listSessions().length,
            interfaces,
            publicIp
          })}\n`
        );
      })
      .catch((err) => {
        channel.end(`${JSON.stringify({ ok: false, error: err.message })}\n`);
      });
  }

  /** Receives a file pushed from the hub and writes it straight into this box's TFTP
   * root. The handshake carries both the destination filename and the exact byte count
   * to expect -- completion is driven by reaching that count, not by the hub ending its
   * side of the channel. That matters here specifically: the hub's local forward-listener
   * bridges this channel with plain `.pipe()` on its end (see central-office-hub's
   * tunnelServer.js), and having the hub half-close its write side to signal "done
   * sending" was observed to tear down the return path before this box's response could
   * get back -- the hub read an empty buffer every time, confirmed with a live test.
   * listDevices/siteInfo never hit this because only the box ends its channel there; the
   * hub only ever writes its handshake and waits. This upload path now matches that same
   * shape. Written to a temp path first and renamed into place once fully received, so a
   * dropped connection mid-upload never leaves a truncated file at the real filename. */
  receiveTftpUpload(channel, handshake, leftoverData) {
    let filename;
    try {
      filename = sanitizeTftpFilename(handshake.filename);
    } catch (e) {
      channel.end(`${JSON.stringify({ ok: false, error: e.message })}\n`);
      return;
    }
    const expectedSize = Number.isInteger(handshake.size) && handshake.size >= 0 ? handshake.size : null;
    if (expectedSize === null) {
      channel.end(`${JSON.stringify({ ok: false, error: 'missing or invalid file size in upload handshake' })}\n`);
      return;
    }
    const targetDir = configStore.TFTP_ROOT_DIR;
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, filename);
    const tmpPath = `${targetPath}.uploading`;
    const writeStream = fs.createWriteStream(tmpPath);
    let bytesWritten = 0;
    let done = false;

    const respond = (payload) => {
      if (done) return;
      done = true;
      channel.removeListener('data', onData);
      channel.removeListener('error', onError);
      channel.end(`${JSON.stringify(payload)}\n`);
    };

    const finalize = () => {
      writeStream.end(() => {
        fs.rename(tmpPath, targetPath, (err) => {
          if (err) return respond({ ok: false, error: err.message });
          this.log(`fleet TFTP upload received: "${filename}" (${bytesWritten} bytes)`);
          respond({ ok: true, filename, bytesWritten });
        });
      });
    };
    const onData = (chunk) => {
      bytesWritten += chunk.length;
      writeStream.write(chunk);
      if (bytesWritten >= expectedSize) finalize();
    };
    const onError = (err) => {
      writeStream.destroy();
      fs.unlink(tmpPath, () => {});
      respond({ ok: false, error: err.message });
    };

    channel.on('data', onData);
    channel.once('error', onError);
    if (leftoverData && leftoverData.length) onData(leftoverData);
    else if (expectedSize === 0) finalize();
  }

  openPortSession(channel, portConfig, leftoverData) {
    const sessionId = require('crypto').randomUUID();
    serialManager
      .open(portConfig, sessionId)
      .then(({ serialPort, release, canWrite }) => {
        this.log(`fleet session connected to "${portConfig.label}"`);
        if (leftoverData && leftoverData.length) {
          if (canWrite()) serialPort.write(leftoverData);
        }

        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          channel.removeListener('data', onChannelData);
          channel.removeListener('close', onChannelClose);
          channel.removeListener('error', onChannelClose);
          serialPort.removeListener('data', onSerialData);
          serialPort.removeListener('close', onSerialClose);
          serialPort.removeListener('error', onSerialClose);
          release();
          this.log(`fleet session disconnected from "${portConfig.label}"`);
        };

        const onSerialData = (data) => {
          if (!channel.destroyed) channel.write(data);
        };
        const onChannelData = (data) => {
          if (canWrite()) serialPort.write(data);
        };
        const onSerialClose = () => {
          channel.end();
          finish();
        };
        const onChannelClose = () => finish();

        channel.on('data', onChannelData);
        channel.once('close', onChannelClose);
        channel.once('error', onChannelClose);
        serialPort.on('data', onSerialData);
        serialPort.once('close', onSerialClose);
        serialPort.once('error', onSerialClose);
      })
      .catch((err) => {
        channel.end(`could not open port: ${err.message}\n`);
      });
  }
}

module.exports = new TunnelClient();
