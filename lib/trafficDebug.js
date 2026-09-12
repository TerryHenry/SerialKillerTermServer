'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const configStore = require('./configStore');
const serialManager = require('./serialManager');

const WS_PATH = '/ws/traffic';

/**
 * Read-only admin debug tap: streams the raw bytes already flowing on a port (as seen
 * by serialManager's 'traffic' event) to the browser as hex + ASCII, for diagnosing
 * wiring/protocol issues. Never opens a port itself and never writes to one -- if
 * nothing else has the port open, there's simply nothing to show yet.
 */
function attach(httpsServer, sessionMiddleware) {
  const wss = new WebSocketServer({ noServer: true });

  httpsServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith(WS_PATH)) return;

    const res = new http.ServerResponse(req);
    sessionMiddleware(req, res, () => {
      const admin = req.session && req.session.authenticated && configStore.findAdminById(req.session.adminId);
      if (!admin || admin.mustChangePassword) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'https://localhost');
    const portId = url.searchParams.get('portId');
    if (!portId) {
      ws.close();
      return;
    }

    const onTraffic = (id, direction, chunk) => {
      if (id !== portId || ws.readyState !== ws.OPEN) return;
      ws.send(
        JSON.stringify({
          type: 'traffic',
          direction,
          hex: chunk.toString('hex'),
          ascii: chunk.toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
          length: chunk.length,
          ts: Date.now()
        })
      );
    };
    serialManager.on('traffic', onTraffic);
    ws.once('close', () => serialManager.removeListener('traffic', onTraffic));
  });
}

module.exports = { attach };
