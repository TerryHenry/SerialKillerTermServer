'use strict';

const { execFile } = require('child_process');
const systemHelper = require('./systemHelper');
const configStore = require('./configStore');

const SUPPORTED_DRIVERS = ['usbhid-ups', 'blazer_ser', 'blazer_usb', 'genericups', 'snmp-ups', 'dummy-ups'];

function parseStatus(text) {
  const kv = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^(\w+)=(\d)$/);
    if (m) kv[m[1]] = m[2] === '1';
  }
  return {
    installed: !!kv.installed,
    serverActive: !!kv.serverActive,
    monitorActive: !!kv.monitorActive
  };
}

async function getStatus() {
  try {
    return parseStatus(await systemHelper.runHelper(['ups-status']));
  } catch (err) {
    return { installed: false, serverActive: false, monitorActive: false, error: err.message };
  }
}

let installing = null;
function ensureInstalled() {
  if (installing) return installing;
  installing = (async () => {
    const status = await getStatus();
    if (status.installed || process.platform !== 'linux') return status;
    await systemHelper.runHelper(['ups-install'], undefined, 5 * 60 * 1000);
    return getStatus();
  })().finally(() => {
    installing = null;
  });
  return installing;
}

/** Validates and applies UPS settings: installs NUT if this is the first time enabling
 * it, writes the driver/port config through the privileged helper, and persists the
 * settings so they survive a restart. Disabling stops the services but leaves the
 * config file on disk (re-enabling doesn't need the driver/port re-entered). */
async function setConfig({ enabled, name, driver, port }) {
  const cleanName = String(name || '').trim();
  const cleanDriver = String(driver || '').trim();
  const cleanPort = String(port || '').trim();
  if (enabled) {
    if (!cleanName || !/^[a-zA-Z0-9_-]+$/.test(cleanName)) {
      throw new Error('UPS name must contain only letters, numbers, hyphens, and underscores');
    }
    if (!SUPPORTED_DRIVERS.includes(cleanDriver)) {
      throw new Error(`unsupported driver "${cleanDriver}"`);
    }
    if (!cleanPort) throw new Error('a port is required');
    await ensureInstalled();
    await systemHelper.runHelper(['ups-configure', cleanName, cleanDriver, cleanPort], undefined, 30000);
  } else {
    await systemHelper.runHelper(['ups-disable']);
  }
  return configStore.updateUps({ enabled: !!enabled, name: cleanName || 'ups', driver: cleanDriver || 'usbhid-ups', port: cleanPort || 'auto' });
}

/** One-shot query of live values via `upsc` -- a plain unprivileged network call to
 * upsd on 127.0.0.1:3493, not the privileged helper: upsd's own protocol allows
 * anonymous read-only status queries (only SET/INSTCMD actions need the
 * upsd.users credentials configured in ups-configure). */
function queryRaw(name) {
  return new Promise((resolve, reject) => {
    execFile('upsc', [`${name}@localhost`], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'upsc failed').trim()));
      const kv = {};
      for (const line of stdout.split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      resolve(kv);
    });
  });
}

/** Reduces upsc's full variable dump to the handful of fields worth showing in the UI
 * and reporting on every heartbeat -- battery.charge/runtime, load, and a friendly read
 * of ups.status's space-separated codes (OL/OB/LB/... -- see NUT's own docs for the
 * full set; only the ones that matter for "is this box about to lose power" are
 * surfaced as booleans here). */
function summarize(kv) {
  const statusCodes = String(kv['ups.status'] || '').split(/\s+/).filter(Boolean);
  const charge = Number(kv['battery.charge']);
  const runtime = Number(kv['battery.runtime']);
  const load = Number(kv['ups.load']);
  return {
    statusCodes,
    online: statusCodes.includes('OL'),
    onBattery: statusCodes.includes('OB'),
    lowBattery: statusCodes.includes('LB'),
    charging: statusCodes.includes('CHRG'),
    batteryCharge: Number.isFinite(charge) ? charge : null,
    batteryRuntimeSeconds: Number.isFinite(runtime) ? runtime : null,
    loadPercent: Number.isFinite(load) ? load : null,
    model: kv['device.model'] || kv['ups.model'] || null,
    driver: kv['driver.name'] || null
  };
}

/** Full status for the UI: install/service state plus a live query if the monitor is
 * actually running. Never throws -- a query failure (UPS unplugged, driver crashed) is
 * reported as a field, not an exception, since "UPS is misbehaving" is exactly the
 * state an admin opens this panel to see. */
async function getFullStatus() {
  const config = configStore.getConfig().ups;
  const service = await getStatus();
  let live = null;
  let liveError = null;
  // Tried whenever UPS monitoring is enabled, regardless of what the privileged-helper
  // service check above reported -- that check is itself a sudo round-trip that can
  // fail for reasons having nothing to do with whether upsd is actually answering
  // queries right now (found in testing: it's the ONLY thing that needs a working sudo
  // setup at all here). The query's own success or failure is the real ground truth.
  if (config.enabled) {
    try {
      live = summarize(await queryRaw(config.name));
    } catch (e) {
      liveError = e.message;
    }
  }
  return { config, service, live, liveError };
}

/** Lighter than getFullStatus() -- no privileged-helper round-trip to check service
 * state, just a direct upsc query. Used on every 30s heartbeat, where a sudo subprocess
 * call each time would be wasteful; the web UI's own panel uses getFullStatus() instead,
 * where that extra detail (is the service even installed/running) is worth showing.
 * Returns null on any failure (UPS unplugged, driver not up yet, not configured) rather
 * than throwing -- a heartbeat should never fail just because the UPS query did. */
async function getHeartbeatSnapshot() {
  const config = configStore.getConfig().ups;
  if (!config.enabled) return null;
  try {
    return summarize(await queryRaw(config.name));
  } catch {
    return null;
  }
}

module.exports = { SUPPORTED_DRIVERS, getStatus, ensureInstalled, setConfig, queryRaw, summarize, getFullStatus, getHeartbeatSnapshot };
