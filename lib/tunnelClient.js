'use strict';

const { Client, utils: sshUtils } = require('ssh2');
const { EventEmitter } = require('events');
const configStore = require('./configStore');
const serialManager = require('./serialManager');
const { logTimestamp } = require('./logTimestamp');

const RECONNECT_DELAY_MS = 5000;

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

  /** Reads the one-line {"portId":...} handshake, then bridges the rest of the stream to that port. */
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

      let portId;
      try {
        portId = JSON.parse(line).portId;
      } catch {
        channel.end('bad handshake\n');
        return;
      }
      const portConfig = configStore.listPorts().find((p) => p.id === portId);
      if (!portConfig) {
        channel.end(`no such port: ${portId}\n`);
        return;
      }
      this.openPortSession(channel, portConfig, rest);
    };
    channel.on('data', onData);
    channel.once('error', () => {});
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
