'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.TS_DATA_DIR || '/opt/terminalserver/data';
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const TFTP_ROOT_DIR = path.join(DATA_DIR, 'tftp');

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'letmein0!';

const defaults = {
  ssh: {
    port: 2222,
    banner: 'Welcome to Serial Killer Terminal Server\r\n',
    allowPortMenu: true,
    autoStart: true,
    enabled: true
  },
  web: {
    port: 8443,
    admins: []
  },
  // Off by default: unlike SSH-to-serial, this opens a second, browser-facing path to
  // the same serial ports, so it shouldn't come up on a freshly-provisioned appliance
  // without an admin deliberately turning it on.
  webTerminal: {
    enabled: false
  },
  tftp: {
    port: 69,
    allowUpload: true,
    autoStart: false
  },
  users: [],
  ports: []
};

function newAdmin(username, password, mustChangePassword) {
  const { salt, hash } = hashPassword(password);
  return {
    id: crypto.randomUUID(),
    username,
    passwordSalt: salt,
    passwordHash: hash,
    mustChangePassword: !!mustChangePassword,
    totpEnabled: false,
    totpSecret: null,
    totpPendingSecret: null
  };
}

// Merges a raw config object (from disk, or an uploaded backup) with defaults, so
// upgrades or older backups that predate a field don't crash the app. Also migrates
// the pre-multi-admin config shape (a single adminUsername/adminPasswordHash/
// adminPasswordSalt/mustChangePassword on `web` itself) into the `admins` list.
function mergeWithDefaults(raw) {
  const rawWeb = raw.web || {};
  let admins = Array.isArray(rawWeb.admins) ? rawWeb.admins : [];
  if (admins.length === 0 && rawWeb.adminUsername && rawWeb.adminPasswordHash) {
    admins = [
      {
        id: crypto.randomUUID(),
        username: rawWeb.adminUsername,
        passwordSalt: rawWeb.adminPasswordSalt,
        passwordHash: rawWeb.adminPasswordHash,
        mustChangePassword: !!rawWeb.mustChangePassword
      }
    ];
  }
  return {
    ssh: { ...defaults.ssh, ...raw.ssh },
    web: { port: rawWeb.port || defaults.web.port, admins },
    webTerminal: { ...defaults.webTerminal, ...raw.webTerminal },
    tftp: { ...defaults.tftp, ...raw.tftp },
    users: Array.isArray(raw.users) ? raw.users : [],
    ports: Array.isArray(raw.ports) ? raw.ports : []
  };
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    const seeded = JSON.parse(JSON.stringify(defaults));
    seeded.web.admins = [newAdmin(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, true)];
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(seeded, null, 2), { mode: 0o600 });
    return seeded;
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return mergeWithDefaults(raw);
}

let state = load();

function persist() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getConfig() {
  return state;
}

// Wholesale-replaces the current config with a previously-exported backup (see
// getConfig, used by the /api/backup route). Merged against defaults the same way
// a config.json loaded from disk is, so a backup taken by an older version still
// loads cleanly.
function importConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('not a valid backup file');
  }
  state = mergeWithDefaults(raw);
  persist();
  return state;
}

function updateSSH(partial) {
  state.ssh = { ...state.ssh, ...partial };
  persist();
  return state.ssh;
}

function updateWeb(partial) {
  state.web = { ...state.web, ...partial };
  persist();
  return state.web;
}

function updateTftp(partial) {
  state.tftp = { ...state.tftp, ...partial };
  persist();
  return state.tftp;
}

function updateWebTerminal(partial) {
  state.webTerminal = { ...state.webTerminal, ...partial };
  persist();
  return state.webTerminal;
}

// ---------- Admin accounts ----------
function listAdmins() {
  return state.web.admins;
}

function findAdminByUsername(username) {
  return state.web.admins.find((a) => a.username === username);
}

function findAdminById(id) {
  return state.web.admins.find((a) => a.id === id);
}

function createAdmin(username, password) {
  if (findAdminByUsername(username)) {
    throw new Error('that username is already in use');
  }
  const admin = newAdmin(username, password, false);
  state.web.admins.push(admin);
  persist();
  return admin;
}

function renameAdmin(id, username) {
  const admin = findAdminById(id);
  if (!admin) throw new Error('admin account not found');
  const existing = findAdminByUsername(username);
  if (existing && existing.id !== id) throw new Error('that username is already in use');
  admin.username = username;
  persist();
  return admin;
}

function setAdminPassword(id, password) {
  const admin = findAdminById(id);
  if (!admin) throw new Error('admin account not found');
  const { salt, hash } = hashPassword(password);
  admin.passwordSalt = salt;
  admin.passwordHash = hash;
  admin.mustChangePassword = false;
  persist();
  return admin;
}

function deleteAdmin(id) {
  if (state.web.admins.length <= 1) {
    throw new Error('cannot delete the only remaining admin account');
  }
  state.web.admins = state.web.admins.filter((a) => a.id !== id);
  persist();
}

// ---------- Admin two-factor auth (TOTP) ----------
// Two-step so a secret only takes effect once the admin has proven they can actually
// generate codes with it (scanned the QR into a real app) -- setAdminTotpPending stages
// it, confirmAdminTotp promotes it after a correct code is presented.
function setAdminTotpPending(id, secret) {
  const admin = findAdminById(id);
  if (!admin) throw new Error('admin account not found');
  admin.totpPendingSecret = secret;
  persist();
  return admin;
}

function confirmAdminTotp(id) {
  const admin = findAdminById(id);
  if (!admin) throw new Error('admin account not found');
  if (!admin.totpPendingSecret) throw new Error('no pending 2FA setup for this account');
  admin.totpSecret = admin.totpPendingSecret;
  admin.totpPendingSecret = null;
  admin.totpEnabled = true;
  persist();
  return admin;
}

function disableAdminTotp(id) {
  const admin = findAdminById(id);
  if (!admin) throw new Error('admin account not found');
  admin.totpEnabled = false;
  admin.totpSecret = null;
  admin.totpPendingSecret = null;
  persist();
  return admin;
}

function listUsers() {
  return state.users;
}

function saveUser(user) {
  const idx = state.users.findIndex((u) => u.id === user.id);
  if (idx >= 0) {
    state.users[idx] = user;
  } else {
    user.id = user.id || crypto.randomUUID();
    state.users.push(user);
  }
  persist();
  return user;
}

function deleteUser(id) {
  state.users = state.users.filter((u) => u.id !== id);
  persist();
}

function listPorts() {
  return state.ports;
}

function savePort(port) {
  const idx = state.ports.findIndex((p) => p.id === port.id);
  if (idx >= 0) {
    state.ports[idx] = port;
  } else {
    port.id = port.id || crypto.randomUUID();
    state.ports.push(port);
  }
  persist();
  return port;
}

function deletePort(id) {
  state.ports = state.ports.filter((p) => p.id !== id);
  persist();
}

module.exports = {
  DATA_DIR,
  TFTP_ROOT_DIR,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_PASSWORD,
  getConfig,
  importConfig,
  updateSSH,
  updateWeb,
  updateTftp,
  updateWebTerminal,
  listAdmins,
  findAdminByUsername,
  findAdminById,
  createAdmin,
  renameAdmin,
  setAdminPassword,
  deleteAdmin,
  setAdminTotpPending,
  confirmAdminTotp,
  disableAdminTotp,
  listUsers,
  saveUser,
  deleteUser,
  listPorts,
  savePort,
  deletePort,
  hashPassword,
  verifyPassword
};
