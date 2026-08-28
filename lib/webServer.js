'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const configStore = require('./configStore');
const serialManager = require('./serialManager');
const systemStats = require('./systemStats');
const logStore = require('./logStore');

function sanitizeTftpFilename(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || base === '.' || base === '..') {
    throw new Error('invalid filename');
  }
  return base;
}

function loadSessionSecret() {
  const secretPath = path.join(configStore.DATA_DIR, 'session-secret');
  if (fs.existsSync(secretPath)) return fs.readFileSync(secretPath, 'utf8');
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

function createWebServer(sshServer, tftpServer, hostKeyPublic) {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: loadSessionSecret(),
      name: 'ts.sid',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
    })
  );

  const sseClients = new Set();
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };
  const onLog = (line) => {
    logStore.append(line);
    broadcast('log', line);
  };
  sshServer.on('log', onLog);
  sshServer.on('status-changed', () => broadcast('status', { running: sshServer.isRunning() }));
  sshServer.on('sessions-changed', () => broadcast('sessions', sshServer.listSessions()));
  tftpServer.on('log', onLog);
  tftpServer.on('status-changed', () => broadcast('tftp-status', { running: tftpServer.isRunning() }));

  function portStatuses() {
    const counts = new Map();
    for (const s of sshServer.listSessions()) {
      if (!s.portLabel) continue;
      counts.set(s.portLabel, (counts.get(s.portLabel) || 0) + 1);
    }
    return configStore
      .listPorts()
      .map((p) => ({
        id: p.id,
        label: p.label,
        path: p.path,
        access: p.access || 'exclusive',
        present: fs.existsSync(p.path),
        clients: counts.get(p.label) || 0
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  }

  const statsTimer = setInterval(async () => {
    if (sseClients.size === 0) return;
    const stats = await systemStats.getStats(configStore.DATA_DIR);
    broadcast('stats', {
      ...stats,
      clientsConnected: sshServer.listSessions().length,
      ports: portStatuses()
    });
  }, 3000);
  statsTimer.unref();

  function needsSetup() {
    return !configStore.getConfig().web.adminPasswordHash;
  }

  function requireAuth(req, res, next) {
    if (needsSetup()) return res.status(409).json({ error: 'setup_required' });
    if (req.session && req.session.authenticated) return next();
    return res.status(401).json({ error: 'unauthenticated' });
  }

  // Stricter gate for everything except session/login/logout/admin-password: while the
  // default password hasn't been changed yet, nothing else in the API works, so a
  // forced change can't be bypassed by talking to the API directly instead of the UI.
  function requireFullAuth(req, res, next) {
    requireAuth(req, res, () => {
      if (configStore.getConfig().web.mustChangePassword) {
        return res.status(403).json({ error: 'must_change_password' });
      }
      next();
    });
  }

  // ---------- Auth ----------
  app.get('/api/session', (req, res) => {
    const authenticated = !!(req.session && req.session.authenticated);
    res.json({
      authenticated,
      needsSetup: needsSetup(),
      mustChangePassword: authenticated && configStore.getConfig().web.mustChangePassword
    });
  });

  app.post('/api/setup', (req, res) => {
    if (!needsSetup()) return res.status(409).json({ error: 'already_configured' });
    const { username, password } = req.body || {};
    if (!username || !password || password.length < 8) {
      return res.status(400).json({ error: 'username and an 8+ character password are required' });
    }
    configStore.updateWeb({ adminUsername: username });
    configStore.setAdminPassword(password);
    req.session.authenticated = true;
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    if (needsSetup()) return res.status(409).json({ error: 'setup_required' });
    const { username, password } = req.body || {};
    const web = configStore.getConfig().web;
    if (
      username === web.adminUsername &&
      configStore.verifyPassword(password, web.adminPasswordSalt, web.adminPasswordHash)
    ) {
      req.session.authenticated = true;
      return res.json({ ok: true, mustChangePassword: web.mustChangePassword });
    }
    res.status(401).json({ error: 'invalid_credentials' });
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.post('/api/admin-password', requireAuth, (req, res) => {
    const { password } = req.body || {};
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    if (password === configStore.DEFAULT_ADMIN_PASSWORD) {
      return res.status(400).json({ error: 'choose a password other than the default' });
    }
    configStore.setAdminPassword(password);
    res.json({ ok: true });
  });

  // ---------- Backup / restore ----------
  app.get('/api/backup', requireFullAuth, (req, res) => {
    const filename = `serial-killer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(configStore.getConfig());
  });

  const restoreUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
  app.post('/api/restore', requireFullAuth, (req, res) => {
    restoreUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'no file provided' });
      let parsed;
      try {
        parsed = JSON.parse(req.file.buffer.toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'that file is not valid JSON' });
      }
      try {
        configStore.importConfig(parsed);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      res.json({ ok: true });
    });
  });

  // ---------- Config / server ----------
  app.get('/api/config', requireFullAuth, (req, res) => {
    const cfg = configStore.getConfig();
    res.json({
      ssh: cfg.ssh,
      web: { port: cfg.web.port, adminUsername: cfg.web.adminUsername },
      tftp: cfg.tftp
    });
  });

  app.post('/api/ssh-settings', requireFullAuth, (req, res) => {
    res.json(configStore.updateSSH(req.body || {}));
  });

  app.get('/api/host-key-fingerprint', requireFullAuth, (req, res) => {
    res.json({ fingerprint: hostKeyPublic });
  });

  app.get('/api/server/status', requireFullAuth, (req, res) => res.json({ running: sshServer.isRunning() }));

  app.post('/api/server/start', requireFullAuth, (req, res) => {
    sshServer.start(req.app.locals.hostKeyPrivate);
    res.json({ running: sshServer.isRunning() });
  });

  app.post('/api/server/stop', requireFullAuth, (req, res) => {
    sshServer.stop();
    res.json({ running: sshServer.isRunning() });
  });

  // ---------- Dashboard ----------
  app.get('/api/stats', requireFullAuth, async (req, res) => {
    const stats = await systemStats.getStats(configStore.DATA_DIR);
    res.json({
      ...stats,
      clientsConnected: sshServer.listSessions().length,
      ports: portStatuses()
    });
  });

  // ---------- Log ----------
  app.get('/api/log', requireFullAuth, (req, res) => res.json(logStore.getLines()));

  // ---------- TFTP ----------
  app.post('/api/tftp-settings', requireFullAuth, (req, res) => {
    res.json(configStore.updateTftp(req.body || {}));
  });

  app.get('/api/tftp/status', requireFullAuth, (req, res) => res.json({ running: tftpServer.isRunning() }));

  app.post('/api/tftp/start', requireFullAuth, (req, res) => {
    const tftp = configStore.getConfig().tftp;
    try {
      tftpServer.start(tftp.port, configStore.TFTP_ROOT_DIR, tftp.allowUpload);
      res.json({ running: tftpServer.isRunning() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/tftp/stop', requireFullAuth, (req, res) => {
    tftpServer.stop();
    res.json({ running: tftpServer.isRunning() });
  });

  app.get('/api/tftp/files', requireFullAuth, (req, res) => {
    fs.mkdirSync(configStore.TFTP_ROOT_DIR, { recursive: true });
    fs.readdir(configStore.TFTP_ROOT_DIR, { withFileTypes: true }, (err, entries) => {
      if (err) return res.json([]);
      const files = entries
        .filter((e) => e.isFile())
        .map((e) => {
          const stat = fs.statSync(path.join(configStore.TFTP_ROOT_DIR, e.name));
          return { name: e.name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json(files);
    });
  });

  const tftpUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        fs.mkdirSync(configStore.TFTP_ROOT_DIR, { recursive: true });
        cb(null, configStore.TFTP_ROOT_DIR);
      },
      filename: (req, file, cb) => {
        try {
          cb(null, sanitizeTftpFilename(file.originalname));
        } catch (e) {
          cb(e);
        }
      }
    }),
    limits: { fileSize: 1024 * 1024 * 1024 }
  });

  app.post('/api/tftp/files', requireFullAuth, (req, res) => {
    tftpUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'no file provided' });
      res.json({ ok: true, name: req.file.filename, size: req.file.size });
    });
  });

  app.get('/api/tftp/files/:name', requireFullAuth, (req, res) => {
    let name;
    try {
      name = sanitizeTftpFilename(req.params.name);
    } catch {
      return res.status(400).json({ error: 'invalid filename' });
    }
    res.download(path.join(configStore.TFTP_ROOT_DIR, name), name, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });

  app.delete('/api/tftp/files/:name', requireFullAuth, (req, res) => {
    let name;
    try {
      name = sanitizeTftpFilename(req.params.name);
    } catch {
      return res.status(400).json({ error: 'invalid filename' });
    }
    fs.unlink(path.join(configStore.TFTP_ROOT_DIR, name), (err) => {
      if (err) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    });
  });

  // ---------- Sessions ----------
  app.get('/api/sessions', requireFullAuth, (req, res) => res.json(sshServer.listSessions()));

  app.post('/api/sessions/:id/kick', requireFullAuth, (req, res) => {
    sshServer.kickSession(req.params.id);
    res.json({ ok: true });
  });

  // ---------- Ports ----------
  app.get('/api/ports/system', requireFullAuth, async (req, res) => {
    try {
      res.json(await serialManager.listSystemPorts());
    } catch (e) {
      res.json([]);
    }
  });

  app.get('/api/ports', requireFullAuth, (req, res) => res.json(configStore.listPorts()));

  app.post('/api/ports', requireFullAuth, (req, res) => res.json(configStore.savePort(req.body || {})));

  app.delete('/api/ports/:id', requireFullAuth, (req, res) => {
    configStore.deletePort(req.params.id);
    res.json({ ok: true });
  });

  // ---------- Users ----------
  app.get('/api/users', requireFullAuth, (req, res) => {
    res.json(configStore.listUsers().map((u) => ({ ...u, passwordHash: undefined, passwordSalt: undefined })));
  });

  app.post('/api/users', requireFullAuth, (req, res) => {
    const user = { ...req.body };
    if (user.newPassword) {
      const { salt, hash } = configStore.hashPassword(user.newPassword);
      user.passwordSalt = salt;
      user.passwordHash = hash;
      delete user.newPassword;
    } else if (user.id) {
      const existing = configStore.listUsers().find((u) => u.id === user.id);
      if (existing) {
        user.passwordSalt = existing.passwordSalt;
        user.passwordHash = existing.passwordHash;
      }
    }
    const saved = configStore.saveUser(user);
    res.json({ ...saved, passwordHash: undefined, passwordSalt: undefined });
  });

  app.delete('/api/users/:id', requireFullAuth, (req, res) => {
    configStore.deleteUser(req.params.id);
    res.json({ ok: true });
  });

  // ---------- Live events (log / sessions / status) ----------
  app.get('/api/events', requireFullAuth, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write('\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // ---------- Static UI ----------
  app.use(express.static(path.join(__dirname, '..', 'webui')));

  return app;
}

module.exports = { createWebServer };
