'use strict';

const { Server, utils: sshUtils } = require('ssh2');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const configStore = require('./configStore');
const serialManager = require('./serialManager');

const ESCAPE_BYTE = 0x1d; // Ctrl+]

class SSHServerManager extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.sessions = new Map();
  }

  log(line) {
    const msg = `[${new Date().toLocaleTimeString()}] ${line}`;
    this.emit('log', msg);
  }

  isRunning() {
    return !!this.server;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      username: s.username,
      permission: s.permission,
      portLabel: s.portLabel,
      connectedAt: s.connectedAt,
      method: 'ssh'
    }));
  }

  kickSession(id) {
    const session = this.sessions.get(id);
    if (session && session.stream) {
      session.stream.end();
      session.stream.destroy();
    }
  }

  start(hostKeyBuffer) {
    if (this.server) return;
    const { port } = configStore.getConfig().ssh;

    this.server = new Server({ hostKeys: [hostKeyBuffer] }, (client) => this.handleClient(client));

    this.server.on('error', (err) => {
      this.log(`Server error: ${err.message}`);
      this.emit('error', err);
    });

    this.server.listen(port, '0.0.0.0', () => {
      this.log(`SSH server listening on port ${port}`);
      this.emit('status-changed');
    });
  }

  stop() {
    if (!this.server) return;
    for (const session of this.sessions.values()) {
      session.release?.();
      session.stream?.destroy();
    }
    this.sessions.clear();
    this.server.close();
    this.server = null;
    this.log('SSH server stopped');
    this.emit('status-changed');
    this.emit('sessions-changed');
  }

  handleClient(client) {
    let authedUser = null;
    const sock = client._sock;
    const remoteInfo = sock ? `${sock.remoteAddress}:${sock.remotePort}` : 'unknown';

    client.on('authentication', (ctx) => {
      const users = configStore.listUsers();
      const user = users.find((u) => u.username === ctx.username);
      if (!user) {
        this.log(`Auth rejected: unknown user "${ctx.username}" from ${remoteInfo}`);
        return ctx.reject(['password', 'publickey']);
      }

      if (ctx.method === 'password') {
        if (
          (user.authMethod === 'password' || user.authMethod === 'both') &&
          user.passwordHash &&
          configStore.verifyPassword(ctx.password, user.passwordSalt, user.passwordHash)
        ) {
          authedUser = user;
          return ctx.accept();
        }
        return ctx.reject(['password', 'publickey']);
      }

      if (ctx.method === 'publickey') {
        if ((user.authMethod === 'publickey' || user.authMethod === 'both') && user.publicKey) {
          try {
            const allowedKey = sshUtils.parseKey(user.publicKey);
            if (allowedKey instanceof Error || !allowedKey) return ctx.reject(['password', 'publickey']);
            const keyMatches =
              ctx.key.algo === allowedKey.type && allowedKey.getPublicSSH().equals(ctx.key.data);
            if (!keyMatches) return ctx.reject(['password', 'publickey']);

            if (ctx.signature) {
              const verified = allowedKey.verify(ctx.blob, ctx.signature);
              if (verified === true) {
                authedUser = user;
                return ctx.accept();
              }
              return ctx.reject(['password', 'publickey']);
            }
            // Key-probe phase (no signature yet): tell client this key would work.
            return ctx.accept();
          } catch (e) {
            return ctx.reject(['password', 'publickey']);
          }
        }
        return ctx.reject(['password', 'publickey']);
      }

      ctx.reject(['password', 'publickey']);
    });

    client.on('ready', () => {
      this.log(`"${authedUser.username}" authenticated from ${remoteInfo}`);
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (accept) => accept && accept());
        session.on('window-change', (accept) => accept && accept());
        session.on('shell', (accept) => {
          const stream = accept();
          this.startSession(authedUser, stream, remoteInfo);
        });
        session.on('exec', (accept, reject) => reject());
      });
    });

    client.on('close', () => {
      if (authedUser) this.log(`Connection closed for "${authedUser.username}" (${remoteInfo})`);
    });
    client.on('error', (err) => this.log(`Client error (${remoteInfo}): ${err.message}`));
  }

  startSession(user, stream, remoteInfo) {
    const sessionId = crypto.randomUUID();
    const sessionRecord = {
      id: sessionId,
      username: user.username,
      permission: user.permission || 'read-write',
      portLabel: null,
      connectedAt: new Date().toISOString(),
      release: null,
      stream
    };
    this.sessions.set(sessionId, sessionRecord);
    this.emit('sessions-changed');

    stream.once('close', () => {
      sessionRecord.release?.();
      this.sessions.delete(sessionId);
      this.emit('sessions-changed');
    });

    const config = configStore.getConfig();
    if (config.ssh.banner) stream.write(config.ssh.banner.replace(/\r?\n/g, '\r\n'));

    (async () => {
      try {
        if (user.defaultPortId) {
          // Dedicated single-port users never see the general port menu: if their
          // assigned port doesn't exist, can't be opened, or later drops, disconnect
          // them outright rather than falling back to a picker they shouldn't have.
          const portConfig = config.ports.find((p) => p.id === user.defaultPortId);
          if (!portConfig) {
            stream.write('\r\nYour assigned serial port no longer exists. Contact your administrator.\r\n');
            stream.end();
            return;
          }
          await this.connectToPort(sessionRecord, stream, portConfig);
          stream.write('\r\nDisconnecting.\r\n');
          stream.end();
          return;
        }

        if (!config.ssh.allowPortMenu) {
          stream.write('\r\nNo port assigned and the port menu is disabled. Contact your administrator.\r\n');
          stream.end();
          return;
        }

        await this.runMenuLoop(sessionRecord, stream);
        stream.end();
      } catch (err) {
        this.log(`Session error for "${user.username}": ${err.message}`);
        stream.end();
      }
    })();
  }

  async runMenuLoop(sessionRecord, stream) {
    while (!stream.destroyed) {
      const ports = configStore.listPorts();
      if (ports.length === 0) {
        stream.write('\r\nNo serial ports configured. Contact your administrator.\r\n');
        return;
      }

      stream.write('\r\nAvailable serial ports:\r\n');
      ports.forEach((p, i) => {
        const info = serialManager.lockInfo(p.id);
        const access = p.access || 'exclusive';
        let tag = '';
        if (info) {
          tag = access === 'exclusive' ? '  [in use]' : `  [${info.count} connected]`;
        }
        stream.write(`  [${i + 1}] ${p.label}  (${p.path} @ ${p.baudRate})${tag}\r\n`);
      });
      stream.write('\r\nEnter port number (or "q" to quit): ');

      const line = await this.readLine(stream);
      if (line === null) return; // connection closed
      const trimmed = line.trim().toLowerCase();
      if (trimmed === 'q' || trimmed === 'quit' || trimmed === 'exit') {
        stream.write('\r\nGoodbye.\r\n');
        return;
      }

      const idx = parseInt(trimmed, 10) - 1;
      const portConfig = ports[idx];
      if (!portConfig) {
        stream.write('\r\nInvalid selection.\r\n');
        continue;
      }

      await this.connectToPort(sessionRecord, stream, portConfig);
    }
  }

  /** Bridges an SSH shell stream to a serial port until detach/close. Returns true if it should fall back to the menu. */
  connectToPort(sessionRecord, stream, portConfig) {
    return serialManager
      .open(portConfig, sessionRecord.id)
      .then(
        ({ serialPort, release, canWrite: portCanWrite }) =>
          new Promise((resolve) => {
            // Live check, not a snapshot: "first-write" ports hand write access to the
            // next-oldest session when the current writer disconnects, so this can flip
            // over the lifetime of the session even though the user's own permission can't.
            const canWrite = () => portCanWrite() && sessionRecord.permission !== 'read-only';
            sessionRecord.portLabel = portConfig.label;
            sessionRecord.release = release;
            this.emit('sessions-changed');
            this.log(`"${sessionRecord.username}" connected to "${portConfig.label}"${canWrite() ? '' : ' (read-only)'}`);
            stream.write(`\r\nConnected to ${portConfig.label}. Press Ctrl+] to return to the port menu.\r\n`);
            if (!canWrite()) stream.write('This session is read-only; your input will not be sent to the port.\r\n');
            stream.write('\r\n');

            let done = false;
            const finish = (backToMenu) => {
              if (done) return;
              done = true;
              stream.removeListener('data', onStreamData);
              stream.removeListener('close', onStreamClose);
              stream.removeListener('error', onStreamClose);
              serialPort.removeListener('data', onSerialData);
              serialPort.removeListener('close', onSerialClose);
              serialPort.removeListener('error', onSerialError);
              release();
              sessionRecord.portLabel = null;
              sessionRecord.release = null;
              this.emit('sessions-changed');
              this.log(`"${sessionRecord.username}" disconnected from "${portConfig.label}"`);
              resolve(backToMenu);
            };

            const onSerialData = (data) => {
              if (!stream.destroyed) stream.write(data);
            };
            const onStreamData = (data) => {
              const escIdx = data.indexOf(ESCAPE_BYTE);
              if (escIdx !== -1) {
                if (escIdx > 0 && canWrite()) serialPort.write(data.slice(0, escIdx));
                stream.write('\r\n[Detached from port]\r\n');
                finish(true);
                return;
              }
              if (canWrite()) serialPort.write(data);
            };
            const onSerialClose = () => {
              stream.write(`\r\n[Port "${portConfig.label}" closed]\r\n`);
              finish(true);
            };
            const onSerialError = (err) => {
              stream.write(`\r\n[Port error: ${err.message}]\r\n`);
              finish(true);
            };
            const onStreamClose = () => finish(false);

            stream.on('data', onStreamData);
            stream.once('close', onStreamClose);
            stream.once('error', onStreamClose);
            serialPort.on('data', onSerialData);
            serialPort.once('close', onSerialClose);
            serialPort.once('error', onSerialError);
          })
      )
      .catch((err) => {
        stream.write(`\r\nCould not open port "${portConfig.label}": ${err.message}\r\n`);
        // Only meaningful to callers that branch on it (the menu loop); a dedicated
        // defaultPortId session ignores this and disconnects regardless.
        return true;
      });
  }

  /** Reads a single line from the raw SSH stream with manual echo/backspace handling. */
  readLine(stream) {
    return new Promise((resolve) => {
      let buf = '';
      const cleanup = () => {
        stream.removeListener('data', onData);
        stream.removeListener('close', onClose);
      };
      const onClose = () => {
        cleanup();
        resolve(null);
      };
      const onData = (data) => {
        for (const byte of data) {
          if (byte === 0x03) {
            cleanup();
            stream.write('^C\r\n');
            resolve('q');
            return;
          }
          if (byte === 0x0d || byte === 0x0a) {
            cleanup();
            stream.write('\r\n');
            resolve(buf);
            return;
          }
          if (byte === 0x7f || byte === 0x08) {
            if (buf.length > 0) {
              buf = buf.slice(0, -1);
              stream.write('\b \b');
            }
            continue;
          }
          if (byte >= 0x20 && byte <= 0x7e) {
            buf += String.fromCharCode(byte);
            stream.write(String.fromCharCode(byte));
          }
        }
      };
      stream.on('data', onData);
      stream.once('close', onClose);
    });
  }
}

module.exports = new SSHServerManager();
