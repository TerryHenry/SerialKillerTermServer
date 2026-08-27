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
    autoStart: true
  },
  web: {
    port: 8443,
    adminUsername: DEFAULT_ADMIN_USERNAME,
    adminPasswordSalt: null,
    adminPasswordHash: null,
    mustChangePassword: false
  },
  tftp: {
    port: 69,
    allowUpload: true,
    autoStart: false
  },
  users: [],
  ports: []
};

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    const seeded = JSON.parse(JSON.stringify(defaults));
    const { salt, hash } = hashPassword(DEFAULT_ADMIN_PASSWORD);
    seeded.web.adminPasswordSalt = salt;
    seeded.web.adminPasswordHash = hash;
    seeded.web.mustChangePassword = true;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(seeded, null, 2), { mode: 0o600 });
    return seeded;
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Merge with defaults so upgrades that add new fields don't crash on old configs.
  return {
    ssh: { ...defaults.ssh, ...raw.ssh },
    web: { ...defaults.web, ...raw.web },
    tftp: { ...defaults.tftp, ...raw.tftp },
    users: raw.users || [],
    ports: raw.ports || []
  };
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

function setAdminPassword(password) {
  const { salt, hash } = hashPassword(password);
  state.web.adminPasswordSalt = salt;
  state.web.adminPasswordHash = hash;
  state.web.mustChangePassword = false;
  persist();
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
  updateSSH,
  updateWeb,
  updateTftp,
  setAdminPassword,
  listUsers,
  saveUser,
  deleteUser,
  listPorts,
  savePort,
  deletePort,
  hashPassword,
  verifyPassword
};
