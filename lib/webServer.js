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
const { logTimestamp } = require('./logTimestamp');
const loginThrottle = require('./loginThrottle');
const hostKeys = require('./hostKeys');
const networkInfo = require('./networkInfo');
const wifiControl = require('./wifiControl');
const systemControl = require('./systemControl');
const webTerminal = require('./webTerminal');

const { version: APP_VERSION } = require('../package.json');
const RELEASES_API_URL = 'https://api.github.com/repos/TerryHenry/SerialKillerTermServer/releases/latest';

function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

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
  const sessionMiddleware = session({
    secret: loadSessionSecret(),
    name: 'ts.sid',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
  });
  app.use(sessionMiddleware);

  const sseClients = new Set();
  const broadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };
  const onLog = (line) => {
    logStore.append(line);
    broadcast('log', line);
  };
  // Sessions from both access channels (SSH and the browser web console) are tracked by
  // their own managers but shown merged everywhere the admin UI displays them.
  function allSessions() {
    return [...sshServer.listSessions(), ...webTerminal.listSessions()];
  }

  sshServer.on('log', onLog);
  sshServer.on('status-changed', () => broadcast('status', { running: sshServer.isRunning() }));
  sshServer.on('sessions-changed', () => broadcast('sessions', allSessions()));
  tftpServer.on('log', onLog);
  tftpServer.on('status-changed', () => broadcast('tftp-status', { running: tftpServer.isRunning() }));
  webTerminal.on('log', onLog);
  webTerminal.on('sessions-changed', () => broadcast('sessions', allSessions()));

  // Records an admin-attributed action into the same persisted, live-tailed log the
  // SSH/TFTP servers already use, so "who changed what" shows up right alongside
  // connect/disconnect activity instead of living in a separate, easy-to-miss place.
  function audit(req, message) {
    const who = (req.session && req.session.username) || 'unknown';
    onLog(`[${logTimestamp()}] [AUDIT] "${who}" ${message}`);
  }

  function portStatuses() {
    const counts = new Map();
    for (const s of allSessions()) {
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
      clientsConnected: allSessions().length,
      ports: portStatuses()
    });
  }, 3000);
  statsTimer.unref();

  function needsSetup() {
    return configStore.listAdmins().length === 0;
  }

  function requireAuth(req, res, next) {
    if (needsSetup()) return res.status(409).json({ error: 'setup_required' });
    if (req.session && req.session.authenticated) return next();
    return res.status(401).json({ error: 'unauthenticated' });
  }

  // Stricter gate for everything except session/login/logout/admin-password: while the
  // logged-in admin still has a default or otherwise-forced password, nothing else in
  // the API works, so a forced change can't be bypassed by talking to the API directly
  // instead of the UI.
  function requireFullAuth(req, res, next) {
    requireAuth(req, res, () => {
      const admin = configStore.findAdminById(req.session.adminId);
      if (!admin || admin.mustChangePassword) {
        return res.status(403).json({ error: 'must_change_password' });
      }
      next();
    });
  }

  // ---------- Auth ----------
  app.get('/api/session', (req, res) => {
    const authenticated = !!(req.session && req.session.authenticated);
    const admin = authenticated ? configStore.findAdminById(req.session.adminId) : null;
    res.json({
      authenticated,
      needsSetup: needsSetup(),
      username: admin ? admin.username : null,
      mustChangePassword: !!(admin && admin.mustChangePassword)
    });
  });

  app.post('/api/setup', (req, res) => {
    if (!needsSetup()) return res.status(409).json({ error: 'already_configured' });
    const { username, password } = req.body || {};
    if (!username || !password || password.length < 8) {
      return res.status(400).json({ error: 'username and an 8+ character password are required' });
    }
    const admin = configStore.createAdmin(username, password);
    req.session.authenticated = true;
    req.session.adminId = admin.id;
    req.session.username = admin.username;
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    if (needsSetup()) return res.status(409).json({ error: 'setup_required' });
    const { username, password } = req.body || {};
    const ip = req.ip;
    if (loginThrottle.isLocked(ip, username)) {
      const secs = loginThrottle.remainingLockSeconds(ip, username);
      return res.status(429).json({ error: `too many failed attempts — try again in ${secs}s` });
    }
    const admin = configStore.findAdminByUsername(username);
    if (admin && configStore.verifyPassword(password, admin.passwordSalt, admin.passwordHash)) {
      loginThrottle.recordSuccess(ip, username);
      req.session.authenticated = true;
      req.session.adminId = admin.id;
      req.session.username = admin.username;
      audit(req, `logged in from ${ip}`);
      return res.json({ ok: true, mustChangePassword: admin.mustChangePassword });
    }
    loginThrottle.recordFailure(ip, username);
    onLog(`[${logTimestamp()}] [AUDIT] login failed for "${username}" from ${ip}`);
    res.status(401).json({ error: 'invalid_credentials' });
  });

  app.post('/api/logout', (req, res) => {
    const who = req.session && req.session.username;
    req.session.destroy(() => {
      if (who) onLog(`[${logTimestamp()}] [AUDIT] "${who}" logged out`);
      res.json({ ok: true });
    });
  });

  // Self-service password change for whoever is currently logged in.
  app.post('/api/admin-password', requireAuth, (req, res) => {
    const { password } = req.body || {};
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    if (password === configStore.DEFAULT_ADMIN_PASSWORD) {
      return res.status(400).json({ error: 'choose a password other than the default' });
    }
    configStore.setAdminPassword(req.session.adminId, password);
    audit(req, 'changed their own password');
    res.json({ ok: true });
  });

  // ---------- Web terminal (console-user auth, separate from admin auth) ----------
  function requireConsoleAuth(req, res, next) {
    if (req.session && req.session.consoleUser) return next();
    return res.status(401).json({ error: 'unauthenticated' });
  }

  app.get('/api/terminal/session', (req, res) => {
    const enabled = configStore.getConfig().webTerminal.enabled;
    if (!enabled) {
      return res.json({ authenticated: false, username: null, needsPortSelection: false, enabled: false });
    }
    const consoleUser = req.session && req.session.consoleUser;
    res.json({
      authenticated: !!consoleUser,
      username: consoleUser ? consoleUser.username : null,
      needsPortSelection: !!(consoleUser && !consoleUser.defaultPortId),
      enabled: true
    });
  });

  app.post('/api/terminal/login', (req, res) => {
    if (!configStore.getConfig().webTerminal.enabled) {
      return res.status(503).json({ error: 'the web console is currently disabled' });
    }
    const { username, password } = req.body || {};
    const ip = req.ip;
    // Prefixed so a console-user login attempt can't share (or exhaust) the same
    // lockout bucket as an admin-account login attempt for a same-named account.
    const throttleUsername = `console:${username}`;
    if (loginThrottle.isLocked(ip, throttleUsername)) {
      const secs = loginThrottle.remainingLockSeconds(ip, throttleUsername);
      return res.status(429).json({ error: `too many failed attempts — try again in ${secs}s` });
    }
    const user = configStore.listUsers().find((u) => u.username === username);
    const validPassword =
      user &&
      (user.authMethod === 'password' || user.authMethod === 'both') &&
      user.passwordHash &&
      configStore.verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!validPassword) {
      loginThrottle.recordFailure(ip, throttleUsername);
      onLog(`[${logTimestamp()}] [AUDIT] web terminal login failed for "${username}" from ${ip}`);
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    loginThrottle.recordSuccess(ip, throttleUsername);
    req.session.consoleUser = {
      id: user.id,
      username: user.username,
      permission: user.permission || 'read-write',
      defaultPortId: user.defaultPortId || null
    };
    onLog(`[${logTimestamp()}] [AUDIT] "${user.username}" logged into the web terminal from ${ip}`);
    res.json({ ok: true, needsPortSelection: !user.defaultPortId });
  });

  app.post('/api/terminal/logout', (req, res) => {
    const who = req.session && req.session.consoleUser && req.session.consoleUser.username;
    delete req.session.consoleUser;
    if (who) onLog(`[${logTimestamp()}] [AUDIT] "${who}" logged out of the web terminal`);
    res.json({ ok: true });
  });

  app.get('/api/terminal/ports', requireConsoleAuth, (req, res) => {
    const config = configStore.getConfig();
    if (!config.webTerminal.enabled) return res.status(503).json({ error: 'the web console is currently disabled' });
    if (!config.ssh.allowPortMenu) return res.json([]);
    // Console users only ever need a label to pick from -- the underlying device path
    // (by-id/by-path/raw ttyUSB) is admin-facing detail, not something to expose here.
    res.json(portStatuses().map(({ id, label, present, clients }) => ({ id, label, present, clients })));
  });

  app.get('/terminal', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'webui', 'terminal.html'));
  });

  // ---------- Version ----------
  app.get('/api/version', requireFullAuth, (req, res) => res.json({ version: APP_VERSION }));

  app.get('/api/check-update', requireFullAuth, async (req, res) => {
    try {
      const ghRes = await fetch(RELEASES_API_URL, {
        headers: { 'User-Agent': 'serial-killer-terminal-server', Accept: 'application/vnd.github+json' }
      });
      if (ghRes.status === 404) {
        return res.json({ currentVersion: APP_VERSION, found: false });
      }
      if (!ghRes.ok) {
        return res.status(502).json({ error: `GitHub returned HTTP ${ghRes.status}` });
      }
      const release = await ghRes.json();
      res.json({
        currentVersion: APP_VERSION,
        found: true,
        latestVersion: release.tag_name,
        upToDate: normalizeVersion(release.tag_name) === normalizeVersion(APP_VERSION),
        url: release.html_url
      });
    } catch (e) {
      res.status(502).json({ error: 'could not reach GitHub — check the Pi has internet access' });
    }
  });

  // ---------- Admin accounts ----------
  app.get('/api/admins', requireFullAuth, (req, res) => {
    res.json(
      configStore.listAdmins().map((a) => ({
        id: a.id,
        username: a.username,
        mustChangePassword: a.mustChangePassword,
        isSelf: a.id === req.session.adminId
      }))
    );
  });

  app.post('/api/admins', requireFullAuth, (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password || password.length < 8) {
      return res.status(400).json({ error: 'username and an 8+ character password are required' });
    }
    try {
      const admin = configStore.createAdmin(username, password);
      audit(req, `created admin account "${admin.username}"`);
      res.json({ id: admin.id, username: admin.username, mustChangePassword: admin.mustChangePassword });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/admins/:id', requireFullAuth, (req, res) => {
    const { username, password } = req.body || {};
    try {
      let admin = configStore.findAdminById(req.params.id);
      if (!admin) return res.status(404).json({ error: 'admin account not found' });
      if (username && username !== admin.username) {
        const oldUsername = admin.username;
        admin = configStore.renameAdmin(req.params.id, username);
        audit(req, `renamed admin account "${oldUsername}" to "${username}"`);
        if (req.session.adminId === admin.id) req.session.username = admin.username;
      }
      if (password) {
        if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
        admin = configStore.setAdminPassword(req.params.id, password);
        audit(req, `reset the password for admin account "${admin.username}"`);
      }
      res.json({ id: admin.id, username: admin.username, mustChangePassword: admin.mustChangePassword });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/admins/:id', requireFullAuth, (req, res) => {
    if (req.params.id === req.session.adminId) {
      return res.status(400).json({ error: "you can't delete the account you're logged in as" });
    }
    try {
      const admin = configStore.findAdminById(req.params.id);
      configStore.deleteAdmin(req.params.id);
      audit(req, `deleted admin account "${admin ? admin.username : req.params.id}"`);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ---------- Backup / restore ----------
  app.get('/api/backup', requireFullAuth, (req, res) => {
    const filename = `serial-killer-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    const payload = { ...configStore.getConfig() };
    if (req.query.includeHostKey) {
      const hostKey = hostKeys.readHostKeyFiles(configStore.DATA_DIR);
      if (hostKey) payload._hostKeyBackup = hostKey;
    }
    audit(req, `downloaded a config backup${req.query.includeHostKey ? ' (including the SSH host key)' : ''}`);
    res.json(payload);
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
      let hostKeyRestored = false;
      try {
        configStore.importConfig(parsed);
        if (parsed._hostKeyBackup && parsed._hostKeyBackup.privateKey) {
          hostKeys.writeHostKeyFiles(configStore.DATA_DIR, parsed._hostKeyBackup);
          hostKeyRestored = true;
        }
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      audit(req, `restored config from a backup file${hostKeyRestored ? ' (including the SSH host key)' : ''}`);
      res.json({ ok: true, hostKeyRestored });
    });
  });

  // ---------- Config / server ----------
  app.get('/api/config', requireFullAuth, (req, res) => {
    const cfg = configStore.getConfig();
    res.json({
      ssh: cfg.ssh,
      web: { port: cfg.web.port },
      webTerminal: cfg.webTerminal,
      tftp: cfg.tftp
    });
  });

  app.post('/api/ssh-settings', requireFullAuth, (req, res) => {
    const result = configStore.updateSSH(req.body || {});
    audit(req, 'updated SSH server settings');
    res.json(result);
  });

  app.get('/api/host-key-fingerprint', requireFullAuth, (req, res) => {
    res.json({ fingerprint: hostKeyPublic });
  });

  app.get('/api/server/status', requireFullAuth, (req, res) =>
    res.json({ running: sshServer.isRunning(), enabled: configStore.getConfig().ssh.enabled })
  );

  // Starting/stopping SSH-to-serial from here also persists it (ssh.enabled), so a
  // deliberate "Stop" stays stopped across a reboot instead of quietly coming back via
  // autoStart -- the same click both takes effect now and disables it going forward.
  app.post('/api/server/start', requireFullAuth, (req, res) => {
    configStore.updateSSH({ enabled: true });
    sshServer.start(req.app.locals.hostKeyPrivate);
    audit(req, 'started and enabled the SSH server');
    res.json({ running: sshServer.isRunning(), enabled: true });
  });

  app.post('/api/server/stop', requireFullAuth, (req, res) => {
    configStore.updateSSH({ enabled: false });
    sshServer.stop();
    audit(req, 'stopped and disabled the SSH server');
    res.json({ running: sshServer.isRunning(), enabled: false });
  });

  app.post('/api/webterminal-settings', requireFullAuth, (req, res) => {
    const enabled = !!(req.body && req.body.enabled);
    configStore.updateWebTerminal({ enabled });
    audit(req, `${enabled ? 'enabled' : 'disabled'} the web console (HTTPS-to-serial)`);
    res.json({ enabled });
  });

  // ---------- Dashboard ----------
  app.get('/api/stats', requireFullAuth, async (req, res) => {
    const stats = await systemStats.getStats(configStore.DATA_DIR);
    res.json({
      ...stats,
      clientsConnected: allSessions().length,
      ports: portStatuses()
    });
  });

  // ---------- Log ----------
  app.get('/api/log', requireFullAuth, (req, res) => res.json(logStore.getLines()));

  // ---------- Network ----------
  app.get('/api/network', requireFullAuth, async (req, res) => {
    const [interfaces, publicIp, wifiRadio, ntp, timezone] = await Promise.all([
      networkInfo.getInterfaces(),
      networkInfo.getPublicIp(),
      networkInfo.getWifiRadioState(),
      networkInfo.getNtpStatus(),
      networkInfo.getTimezone()
    ]);
    res.json({ interfaces, publicIp, wifiRadio, ntp, timezone, dns: networkInfo.getDnsServers() });
  });

  app.get('/api/network/timezones', requireFullAuth, async (req, res) => {
    res.json(await networkInfo.listTimezones());
  });

  app.post('/api/network/ntp', requireFullAuth, async (req, res) => {
    const server = (req.body && req.body.server || '').trim();
    if (!server) return res.status(400).json({ error: 'ntp server is required' });
    try {
      await systemControl.setNtpServer(server);
      audit(req, `set the NTP server to "${server}"`);
      res.json({ ok: true, server });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/network/timezone', requireFullAuth, async (req, res) => {
    const timezone = (req.body && req.body.timezone || '').trim();
    if (!timezone) return res.status(400).json({ error: 'timezone is required' });
    try {
      await systemControl.setTimezone(timezone);
      audit(req, `set the timezone to "${timezone}"`);
      res.json({ ok: true, timezone });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/network/dns', requireFullAuth, async (req, res) => {
    const raw = (req.body && req.body.servers) || '';
    const servers = String(raw).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const invalid = servers.filter((s) => !networkInfo.isIpv4(s));
    if (invalid.length) {
      return res.status(400).json({ error: `not an IPv4 address: ${invalid.join(', ')}` });
    }
    try {
      await systemControl.setDns(servers);
      audit(req, servers.length ? `set DNS servers to ${servers.join(', ')}` : 'cleared the DNS override (back to DHCP-provided DNS)');
      res.json({ ok: true, servers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/network/wifi/enable', requireFullAuth, async (req, res) => {
    try {
      await wifiControl.enable();
      audit(req, 'enabled Wi-Fi');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/network/wifi/disable', requireFullAuth, async (req, res) => {
    try {
      await wifiControl.disable();
      audit(req, 'disabled Wi-Fi');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/network/wifi/scan', requireFullAuth, async (req, res) => {
    try {
      const networks = await wifiControl.scan();
      res.json(networks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/network/wifi/connect', requireFullAuth, async (req, res) => {
    const { ssid, password } = req.body || {};
    if (!ssid) return res.status(400).json({ error: 'ssid is required' });
    try {
      await wifiControl.connect(ssid, password);
      audit(req, `connected Wi-Fi to network "${ssid}"`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---------- TFTP ----------
  app.post('/api/tftp-settings', requireFullAuth, (req, res) => {
    const result = configStore.updateTftp(req.body || {});
    audit(req, 'updated TFTP settings');
    res.json(result);
  });

  app.get('/api/tftp/status', requireFullAuth, (req, res) => res.json({ running: tftpServer.isRunning() }));

  app.post('/api/tftp/start', requireFullAuth, (req, res) => {
    const tftp = configStore.getConfig().tftp;
    try {
      tftpServer.start(tftp.port, configStore.TFTP_ROOT_DIR, tftp.allowUpload);
      audit(req, 'started the TFTP server');
      res.json({ running: tftpServer.isRunning() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/tftp/stop', requireFullAuth, (req, res) => {
    tftpServer.stop();
    audit(req, 'stopped the TFTP server');
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
      audit(req, `uploaded TFTP file "${req.file.filename}"`);
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
      audit(req, `deleted TFTP file "${name}"`);
      res.json({ ok: true });
    });
  });

  // ---------- Sessions ----------
  app.get('/api/sessions', requireFullAuth, (req, res) => res.json(allSessions()));

  app.post('/api/sessions/:id/kick', requireFullAuth, (req, res) => {
    // Session ids are unscoped UUIDs, one manager per session -- trying both is simpler
    // than tagging/parsing ids by channel, and a miss on the wrong manager is a no-op.
    sshServer.kickSession(req.params.id);
    webTerminal.kickSession(req.params.id);
    audit(req, 'disconnected an active session');
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

  app.post('/api/ports', requireFullAuth, (req, res) => {
    const isNew = !req.body || !req.body.id;
    const saved = configStore.savePort(req.body || {});
    audit(req, `${isNew ? 'created' : 'updated'} serial port "${saved.label}"`);
    res.json(saved);
  });

  app.delete('/api/ports/:id', requireFullAuth, (req, res) => {
    const existing = configStore.listPorts().find((p) => p.id === req.params.id);
    configStore.deletePort(req.params.id);
    audit(req, `deleted serial port "${existing ? existing.label : req.params.id}"`);
    res.json({ ok: true });
  });

  // ---------- Users ----------
  app.get('/api/users', requireFullAuth, (req, res) => {
    res.json(configStore.listUsers().map((u) => ({ ...u, passwordHash: undefined, passwordSalt: undefined })));
  });

  app.post('/api/users', requireFullAuth, (req, res) => {
    const isNew = !req.body || !req.body.id;
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
    audit(req, `${isNew ? 'created' : 'updated'} SSH user "${saved.username}"`);
    res.json({ ...saved, passwordHash: undefined, passwordSalt: undefined });
  });

  app.delete('/api/users/:id', requireFullAuth, (req, res) => {
    const existing = configStore.listUsers().find((u) => u.id === req.params.id);
    configStore.deleteUser(req.params.id);
    audit(req, `deleted SSH user "${existing ? existing.username : req.params.id}"`);
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

  function attachTerminalSocket(httpsServer) {
    webTerminal.attach(httpsServer, sessionMiddleware);
  }

  return { app, attachTerminalSocket };
}

module.exports = { createWebServer };
