'use strict';

const path = require('path');
const { execFile } = require('child_process');
const configStore = require('./configStore');

const HELPER_PATH = path.join(configStore.DATA_DIR, '..', 'provisioning', 'wifi-helper.sh');

function runHelper(args) {
  return new Promise((resolve, reject) => {
    // execFile (not exec) with an argv array -- never shell-interpolated, so an SSID or
    // password containing spaces/quotes/special characters can't break out of the
    // command or inject anything, however it's spelled.
    execFile('sudo', [HELPER_PATH, ...args], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'command failed').trim()));
      resolve(stdout);
    });
  });
}

async function enable() {
  await runHelper(['enable']);
}

async function disable() {
  await runHelper(['disable']);
}

/** Returns [{ ssid, signal, security }], strongest first, deduplicated by SSID. */
async function scan() {
  const out = await runHelper(['scan']);
  const seen = new Map();
  for (const line of out.trim().split('\n')) {
    if (!line) continue;
    // nmcli -t escapes literal colons within a field as "\:" since colon is the field
    // separator -- split only on unescaped ones so an SSID containing ":" survives intact.
    const [ssid, signal, security] = line.split(/(?<!\\):/).map((s) => s.replace(/\\:/g, ':'));
    if (!ssid) continue;
    const signalNum = Number(signal) || 0;
    const existing = seen.get(ssid);
    if (!existing || signalNum > existing.signal) {
      seen.set(ssid, { ssid, signal: signalNum, security: security || '' });
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.signal - a.signal);
}

async function connect(ssid, password) {
  await runHelper(password ? ['connect', ssid, password] : ['connect', ssid]);
}

module.exports = { enable, disable, scan, connect };
