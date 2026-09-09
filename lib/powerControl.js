'use strict';

const TuyaDevice = require('tuyapi');

const CONNECT_TIMEOUT_MS = 5000;
const POWER_CYCLE_OFF_MS = 5000;

function hasPlug(portConfig) {
  return !!(portConfig.powerPlugId && portConfig.powerPlugKey && portConfig.powerPlugIp);
}

function makeDevice(portConfig) {
  return new TuyaDevice({
    id: portConfig.powerPlugId,
    key: portConfig.powerPlugKey,
    ip: portConfig.powerPlugIp,
    version: portConfig.powerPlugVersion || '3.3'
  });
}

function withDevice(portConfig, fn) {
  return new Promise((resolve, reject) => {
    const device = makeDevice(portConfig);
    let settled = false;

    const cleanup = () => {
      try {
        device.disconnect();
      } catch {
        // already disconnected
      }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    // TuyaDevice is an EventEmitter, and an unreachable/unresponsive plug (wrong IP,
    // powered off, network issue -- all routine, expected failure modes here, not edge
    // cases) surfaces as an 'error' event rather than a rejected promise. An EventEmitter
    // with no 'error' listener makes Node treat that as an uncaught exception and crash
    // the whole process on the next tick -- not just fail this one call -- so this
    // listener is load-bearing, not optional, however find()/connect() eventually fail.
    device.on('error', fail);

    (async () => {
      try {
        await device.find({ timeout: CONNECT_TIMEOUT_MS / 1000 });
        await device.connect();
        succeed(await fn(device));
      } catch (err) {
        fail(err);
      }
    })();
  });
}

/** Turns the plug on (true) or off (false). */
async function setPower(portConfig, on) {
  await withDevice(portConfig, (device) => device.set({ set: !!on }));
}

/** Reads the plug's current on/off state without changing it. */
async function getPower(portConfig) {
  return withDevice(portConfig, (device) => device.get({ schema: false }));
}

/** Powers off, waits, then powers back on. */
async function powerCycle(portConfig, offDurationMs = POWER_CYCLE_OFF_MS) {
  await withDevice(portConfig, async (device) => {
    await device.set({ set: false });
    await new Promise((resolve) => setTimeout(resolve, offDurationMs));
    await device.set({ set: true });
  });
}

/** Connectivity/credentials check for the port editor's "Test Connection" button. */
async function testConnection(plugConfig) {
  const state = await getPower({
    powerPlugId: plugConfig.deviceId,
    powerPlugKey: plugConfig.localKey,
    powerPlugIp: plugConfig.ip,
    powerPlugVersion: plugConfig.version
  });
  return { on: !!state };
}

module.exports = { hasPlug, setPower, getPower, powerCycle, testConnection };
