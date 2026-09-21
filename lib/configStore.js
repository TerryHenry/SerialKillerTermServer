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
    admins: [],
    // Admins are signed out after this many idle minutes; 0 disables it.
    idleTimeoutMinutes: 5
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
  // Off by default -- forwarding the audit log to a syslog server is an opt-in choice
  // tied to a specific network destination, not something a freshly-provisioned
  // appliance should do on its own.
  // Log tab / server.log keep at most this many entries; the oldest are dropped.
  log: { maxEntries: 1000 },
  syslog: {
    enabled: false,
    host: '',
    port: 514,
    facility: 16 // local0 -- the conventional facility for a custom/embedded appliance
  },
  // Length-first by default, per current NIST 800-63B guidance, rather than mandatory
  // character-class complexity -- the complexity toggles exist for admins under a
  // compliance regime that still requires them, but aren't the default push.
  passwordPolicy: {
    minLength: 8,
    requireMixedCase: false,
    requireDigit: false,
    requireSymbol: false,
    checkBreached: true,
    // Off by default, same as every other opt-in security control here. Unlike the
    // fields above, this one only ever applies to admin accounts (console users and
    // the Pi System Account have no bearing on this box's own configuration the way an
    // admin login does) -- it lives in this object anyway rather than a separate one,
    // since it's still "a requirement enforced at admin login" in the same spirit.
    // Enforced in webServer.js's requireFullAuth: an admin without 2FA set up while
    // this is on can still log in and reach exactly the routes needed to enable it
    // (self, 2FA setup/confirm), same carve-out mustChangePassword already gets.
    requireAdminTotp: false
  },
  // Off by default -- tunneling into a Central Office hub is an opt-in choice tied to a
  // specific hub address, not something a freshly-provisioned appliance should do on its
  // own any more than syslog forwarding or webTerminal are.
  fleet: {
    mode: 'standalone',
    hubHost: '',
    // Matches the hub's own default tunnel port (443) -- chosen there so this box's
    // outbound connection to the hub doesn't need a new firewall rule at whatever site
    // it's deployed to, since outbound 443 is almost always already permitted.
    hubPort: 443,
    // The hub's tunnel/SSH listener (hubPort) and its admin web API are different ports
    // on the same host -- enrollment and heartbeats talk to this one.
    hubApiPort: 8443,
    // Blank only ever means "no connection has happened yet" -- tunnelClient.js pins
    // whatever key the hub presents on the very first connection (trust-on-first-use,
    // like ~/.ssh/known_hosts) and enforces an exact match on every one after that. An
    // admin can still paste the value from the hub's own System tab here ahead of time
    // to skip the TOFU window entirely.
    hubHostKeyFingerprint: '',
    // Blank only ever means "no connection has happened yet" here too -- the first
    // outbound HTTPS call to the hub (enrollment, heartbeat, or backup push, whichever
    // happens first) pins whatever certificate it saw via lib/pinnedHttps.js, and every
    // call after that must match it exactly. An admin can still paste the hub's TLS
    // fingerprint (its own System tab) here ahead of time to skip the TOFU window.
    hubTlsFingerprint: ''
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
    web: {
      port: rawWeb.port || defaults.web.port,
      admins,
      idleTimeoutMinutes: Number.isInteger(rawWeb.idleTimeoutMinutes) ? rawWeb.idleTimeoutMinutes : defaults.web.idleTimeoutMinutes
    },
    webTerminal: { ...defaults.webTerminal, ...raw.webTerminal },
    tftp: { ...defaults.tftp, ...raw.tftp },
    syslog: { ...defaults.syslog, ...raw.syslog },
    log: { ...defaults.log, ...raw.log },
    passwordPolicy: { ...defaults.passwordPolicy, ...raw.passwordPolicy },
    fleet: { ...defaults.fleet, ...raw.fleet },
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

// Wipes ports, console users, admin accounts, and SSH/TFTP/web/syslog settings back to
// what a freshly-provisioned appliance ships with -- the same seeding logic load() uses
// on a truly first boot. Deliberately scoped to config.json only: network settings, the
// SSH host key, the TLS certificate, and session capture files all live outside it and
// are untouched, so this can't strand the admin off the network the way a full wipe could.
function resetToDefaults() {
  const seeded = JSON.parse(JSON.stringify(defaults));
  seeded.web.admins = [newAdmin(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD, true)];
  state = seeded;
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

function updateLog(partial) {
  state.log = { ...state.log, ...partial };
  persist();
  return state.log;
}

function updateSyslog(partial) {
  state.syslog = { ...state.syslog, ...partial };
  persist();
  return state.syslog;
}

function updatePasswordPolicy(partial) {
  state.passwordPolicy = { ...state.passwordPolicy, ...partial };
  persist();
  return state.passwordPolicy;
}

function updateFleet(partial) {
  state.fleet = { ...state.fleet, ...partial };
  persist();
  return state.fleet;
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

/** Replaces the entire local admin table with hub-synced accounts (a fleet "sync-admins"
 * command) -- so this box's own admin login matches the hub's exactly instead of
 * maintaining separate credentials. Validated before applying: never accepts an empty or
 * malformed list, since that would strand the box's admin UI with no way to log in short
 * of a factory reset. Takes {username, passwordSalt, passwordHash} triples (already
 * hashed -- the hub never sees or sends a plaintext password) and assigns each a fresh
 * local id; 2FA is deliberately not carried over and starts disabled. */
function replaceAdmins(admins) {
  if (!Array.isArray(admins) || admins.length === 0) {
    throw new Error('refusing to replace admins with an empty or invalid list');
  }
  const validated = admins.map((a) => {
    if (!a || typeof a.username !== 'string' || !a.username.trim() || !a.passwordSalt || !a.passwordHash) {
      throw new Error('one or more synced admin entries is missing required fields');
    }
    return {
      id: crypto.randomUUID(),
      username: a.username,
      passwordSalt: a.passwordSalt,
      passwordHash: a.passwordHash,
      mustChangePassword: false,
      totpEnabled: false,
      totpSecret: null,
      totpPendingSecret: null
    };
  });
  state.web.admins = validated;
  persist();
  return validated;
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

function recordAdminLogin(id) {
  const admin = findAdminById(id);
  if (!admin) return;
  admin.lastLoginAt = new Date().toISOString();
  persist();
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

function findUserById(id) {
  return state.users.find((u) => u.id === id);
}

// ---------- Console user two-factor auth (TOTP) ----------
// Admin-managed rather than self-service (console users have no account settings page
// of their own to do this from) -- same two-step stage/confirm shape as admin 2FA so a
// botched QR scan doesn't lock an account out of the gate.
function setUserTotpPending(id, secret) {
  const user = findUserById(id);
  if (!user) throw new Error('user not found');
  user.totpPendingSecret = secret;
  persist();
  return user;
}

function confirmUserTotp(id) {
  const user = findUserById(id);
  if (!user) throw new Error('user not found');
  if (!user.totpPendingSecret) throw new Error('no pending 2FA setup for this account');
  user.totpSecret = user.totpPendingSecret;
  user.totpPendingSecret = null;
  user.totpEnabled = true;
  persist();
  return user;
}

function disableUserTotp(id) {
  const user = findUserById(id);
  if (!user) throw new Error('user not found');
  user.totpEnabled = false;
  user.totpSecret = null;
  user.totpPendingSecret = null;
  persist();
  return user;
}

function recordUserLogin(id) {
  const user = findUserById(id);
  if (!user) return;
  user.lastLoginAt = new Date().toISOString();
  persist();
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

/** Applies a fleet "sync-users" command: replaces every hub-managed local login with the
 * hub's list, and never touches accounts created locally on this box. Unlike admins, an
 * empty list is valid (it means the hub no longer wants any logins pushed here). Takes
 * already-hashed {username, passwordSalt, passwordHash, permission, captureEnabled}
 * entries. A pushed username that collides with a locally-created account is skipped
 * rather than overwriting it -- the local account wins. Password-only, no 2FA and no
 * default port; those stay local decisions. */
function replaceHubManagedUsers(entries) {
  if (!Array.isArray(entries)) throw new Error('refusing to sync users from a malformed list');
  const validated = entries.map((e) => {
    if (!e || typeof e.username !== 'string' || !e.username.trim() || !e.passwordSalt || !e.passwordHash) {
      throw new Error('one or more synced user entries is missing required fields');
    }
    return e;
  });
  const localNames = new Set(state.users.filter((u) => !u.hubManaged).map((u) => u.username));
  const skipped = [];
  const applied = [];
  for (const e of validated) {
    if (localNames.has(e.username)) {
      skipped.push(e.username);
      continue;
    }
    applied.push({
      id: crypto.randomUUID(),
      username: e.username,
      authMethod: 'password',
      permission: e.permission === 'read-only' ? 'read-only' : 'read-write',
      captureEnabled: !!e.captureEnabled,
      publicKey: '',
      defaultPortId: null,
      passwordSalt: e.passwordSalt,
      passwordHash: e.passwordHash,
      hubManaged: true
    });
  }
  state.users = [...state.users.filter((u) => !u.hubManaged), ...applied];
  persist();
  return { applied, skipped };
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

/** Wholesale replace, for a hub-pushed port configuration (see fleetHeartbeat's
 * "set-ports" command) -- mirrors replaceAdmins' pattern rather than diffing against
 * the existing list, since the hub always sends its own idea of the complete set. */
function replacePorts(ports) {
  if (!Array.isArray(ports)) {
    throw new Error('ports must be an array');
  }
  const validAccess = new Set(['exclusive', 'shared-rw', 'first-write', 'shared-ro']);
  const validated = ports.map((p) => {
    if (!p || typeof p.label !== 'string' || !p.label.trim() || typeof p.path !== 'string' || !p.path.trim()) {
      throw new Error('one or more pushed ports is missing a label or device path');
    }
    return {
      id: p.id || crypto.randomUUID(),
      label: p.label.trim(),
      path: p.path.trim(),
      baudRate: Number(p.baudRate) || 9600,
      access: validAccess.has(p.access) ? p.access : 'exclusive',
      captureEnabled: !!p.captureEnabled
    };
  });
  state.ports = validated;
  persist();
  return state.ports;
}

module.exports = {
  DATA_DIR,
  TFTP_ROOT_DIR,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_PASSWORD,
  getConfig,
  importConfig,
  resetToDefaults,
  updateSSH,
  updateWeb,
  updateTftp,
  updateWebTerminal,
  updateSyslog,
  updateLog,
  updatePasswordPolicy,
  updateFleet,
  listAdmins,
  findAdminByUsername,
  findAdminById,
  createAdmin,
  replaceAdmins,
  renameAdmin,
  setAdminPassword,
  recordAdminLogin,
  deleteAdmin,
  setAdminTotpPending,
  confirmAdminTotp,
  disableAdminTotp,
  listUsers,
  findUserById,
  setUserTotpPending,
  confirmUserTotp,
  disableUserTotp,
  recordUserLogin,
  saveUser,
  replaceHubManagedUsers,
  deleteUser,
  listPorts,
  savePort,
  deletePort,
  replacePorts,
  hashPassword,
  verifyPassword
};
