'use strict';

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const configStore = require('./configStore');
const serialManager = require('./serialManager');

const WS_PATH = '/ws/terminal';

/**
 * Attaches the web-terminal WebSocket endpoint to an existing HTTPS server, bridging
 * console-user connections to serial ports the same way sshServer.js does for SSH shells.
 * Runs alongside the Express app rather than through it because WebSocket upgrades happen
 * on the raw http.Server's 'upgrade' event, before Express's own routing.
 */
function attach(httpsServer, sessionMiddleware, log) {
  const wss = new WebSocketServer({ noServer: true });

  httpsServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith(WS_PATH)) return;

    // express-session normally runs as Express middleware against a real
    // (req, res) pair; a raw upgrade request has no response object, so we hand it
    // a throwaway http.ServerResponse just so the middleware can read/write the
    // session cookie the same way it would for an ordinary request.
    const res = new http.ServerResponse(req);
    sessionMiddleware(req, res, () => {
      const consoleUser = req.session && req.session.consoleUser;
      if (!consoleUser) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  });

  wss.on('connection', async (ws, req) => {
    const consoleUser = req.session.consoleUser;
    const url = new URL(req.url, 'https://localhost');
    const requestedPortId = url.searchParams.get('portId');
    const config = configStore.getConfig();

    let portConfig = null;
    if (consoleUser.defaultPortId) {
      portConfig = config.ports.find((p) => p.id === consoleUser.defaultPortId) || null;
    } else if (requestedPortId && config.ssh.allowPortMenu) {
      portConfig = config.ports.find((p) => p.id === requestedPortId) || null;
    }

    if (!portConfig) {
      ws.send(JSON.stringify({ type: 'error', message: 'No serial port available for this session.' }));
      ws.close();
      return;
    }

    const sessionId = `web:${consoleUser.id}:${crypto.randomUUID()}`;
    let serialPort;
    let release;
    let portCanWrite;
    try {
      ({ serialPort, release, canWrite: portCanWrite } = await serialManager.open(portConfig, sessionId));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
      ws.close();
      return;
    }

    const canWrite = () => portCanWrite() && consoleUser.permission !== 'read-only';

    log(`"${consoleUser.username}" connected via web terminal to "${portConfig.label}"${canWrite() ? '' : ' (read-only)'}`);
    ws.send(JSON.stringify({ type: 'connected', label: portConfig.label, readOnly: !canWrite() }));

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      serialPort.removeListener('data', onSerialData);
      serialPort.removeListener('close', onSerialClose);
      serialPort.removeListener('error', onSerialError);
      release();
      log(`"${consoleUser.username}" disconnected web terminal from "${portConfig.label}"`);
    };

    const onSerialData = (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    };
    const onSerialClose = () => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: `Port "${portConfig.label}" closed.` }));
        ws.close();
      }
      finish();
    };
    const onSerialError = (err) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        ws.close();
      }
      finish();
    };

    serialPort.on('data', onSerialData);
    serialPort.once('close', onSerialClose);
    serialPort.once('error', onSerialError);

    ws.on('message', (data, isBinary) => {
      if (!isBinary || !canWrite()) return;
      serialPort.write(data);
    });

    ws.once('close', finish);
  });
}

module.exports = { attach };
