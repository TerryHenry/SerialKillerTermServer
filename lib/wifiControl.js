'use strict';

const { runHelper } = require('./systemHelper');

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
