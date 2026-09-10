'use strict';

const os = require('os');
const { execFile } = require('child_process');

const PUBLIC_IP_TIMEOUT_MS = 3000;
const PUBLIC_IP_URL = 'https://api.ipify.org?format=json';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** IPv4 addresses per network interface, from Node's own view of the OS (always available). */
function localAddresses() {
  const nets = os.networkInterfaces();
  const byName = {};
  for (const [name, addrs] of Object.entries(nets)) {
    const ipv4 = (addrs || []).find((a) => a.family === 'IPv4' && !a.internal);
    if (ipv4) byName[name] = ipv4.address;
  }
  return byName;
}

/**
 * Richer per-interface status (connected/disconnected, connection/SSID name) via nmcli,
 * which is what Raspberry Pi OS Bookworm manages networking with. Falls back to just the
 * interfaces Node can see if nmcli isn't available (e.g. non-Linux dev/test machines).
 */
async function getInterfaces() {
  const addresses = localAddresses();
  const nmcliOut = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']);

  if (!nmcliOut) {
    return Object.entries(addresses)
      .filter(([name]) => name !== 'lo')
      .map(([name, ip]) => ({ name, type: name.startsWith('wl') ? 'wifi' : 'ethernet', state: 'unknown', ip, connection: null }));
  }

  return nmcliOut
    .trim()
    .split('\n')
    // nmcli -t escapes literal colons within a field as "\:" -- split only on unescaped
    // ones so a connection name containing ":" doesn't get chopped apart.
    .map((line) => line.split(/(?<!\\):/).map((s) => s.replace(/\\:/g, ':')))
    .filter(([, type]) => type === 'ethernet' || type === 'wifi')
    .map(([name, type, state, connection]) => ({
      name,
      type,
      state, // 'connected' | 'disconnected' | 'unavailable' | 'unmanaged' | ...
      ip: addresses[name] || null,
      connection: connection && connection !== '--' ? connection : null
    }));
}

/** 'enabled' | 'disabled' | null (nmcli unavailable) */
async function getWifiRadioState() {
  const out = await run('nmcli', ['radio', 'wifi']);
  if (!out) return null;
  return out.trim();
}

async function getPublicIp() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLIC_IP_TIMEOUT_MS);
    const res = await fetch(PUBLIC_IP_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    return data.ip || null;
  } catch {
    return null;
  }
}

module.exports = { getInterfaces, getWifiRadioState, getPublicIp };
