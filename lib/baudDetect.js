'use strict';

const { SerialPort } = require('serialport');

// Most-common first: detection stops at the first rate that yields readable text.
const BAUDS = [9600, 115200, 38400, 19200, 57600, 4800, 2400, 1200, 230400];
const FRAMINGS = [
  { dataBits: 8, parity: 'none', stopBits: 1, label: '8N1' },
  { dataBits: 7, parity: 'even', stopBits: 1, label: '7E1' }
];
const DWELL_MS = 700;
const MIN_BYTES = 3;
const MIN_PRINTABLE_RATIO = 0.9;

/** Share of bytes that look like text (printable ASCII, CR, LF, tab). Wrong-baud reads come
 * back as mostly high-bit/control garbage, so this cleanly separates the right rate. */
function printableRatio(buf) {
  if (!buf.length) return 0;
  let ok = 0;
  for (const b of buf) {
    if ((b >= 0x20 && b <= 0x7e) || b === 0x0d || b === 0x0a || b === 0x09) ok += 1;
  }
  return ok / buf.length;
}

function openReal(devicePath, framing, baudRate) {
  return new SerialPort({
    path: devicePath,
    baudRate,
    dataBits: framing.dataBits,
    parity: framing.parity,
    stopBits: framing.stopBits,
    autoOpen: false
  });
}

/** Listens to one (baud, framing) combination: nudges the device with a carriage return
 * (many consoles stay silent until something is typed) and collects whatever comes back. */
function probe(devicePath, framing, baudRate, open, dwellMs) {
  return new Promise((resolve, reject) => {
    const port = open(devicePath, framing, baudRate);
    const chunks = [];
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      port.removeAllListeners('data');
      const done = () => (err ? reject(err) : resolve(Buffer.concat(chunks)));
      if (port.isOpen) port.close(() => done());
      else done();
    };
    port.on('error', (e) => finish(e));
    port.open((err) => {
      if (err) return finish(err);
      port.on('data', (c) => chunks.push(c));
      port.write('\r', () => {});
      setTimeout(() => finish(null), dwellMs);
    });
  });
}

/** Tries baud rates (8N1 first, then 7E1) and reports the first that produces readable
 * output. Returns {baudRate, dataBits, parity, stopBits, framing, sample} or
 * {baudRate: null, reason}. Open/permission errors propagate to the caller. */
async function detect(devicePath, { open = openReal, dwellMs = DWELL_MS, bauds = BAUDS, framings = FRAMINGS } = {}) {
  let sawAnyData = false;
  for (const framing of framings) {
    for (const baud of bauds) {
      const data = await probe(devicePath, framing, baud, open, dwellMs);
      if (data.length) sawAnyData = true;
      if (data.length >= MIN_BYTES && printableRatio(data) >= MIN_PRINTABLE_RATIO) {
        return {
          baudRate: baud,
          dataBits: framing.dataBits,
          parity: framing.parity,
          stopBits: framing.stopBits,
          framing: framing.label,
          sample: data.toString('latin1').replace(/[^\x20-\x7e\r\n\t]/g, '.').slice(0, 80)
        };
      }
    }
  }
  return {
    baudRate: null,
    reason: sawAnyData
      ? 'The device answered, but nothing at the common speeds looked like readable text.'
      : 'The device did not respond at any common speed. Check the cable, and that the device is powered and has a console attached.'
  };
}

const inProgress = new Set();

/** The entry point the web routes use: only ever opens a device this box actually reports
 * (never an arbitrary path a caller made up), refuses one that has a live session, and
 * runs at most one detection per device at a time. */
async function detectForDevice(requestedPath) {
  const serialManager = require('./serialManager');
  const configStore = require('./configStore');
  const systemPorts = await serialManager.listSystemPorts();
  const match = systemPorts.find((p) => p.path === requestedPath || p.devicePath === requestedPath);
  if (!match) throw new Error('that device was not found on this box');
  const inUse = configStore
    .listPorts()
    .some((p) => (p.path === match.path || p.path === match.devicePath) && serialManager.isLocked(p.id));
  if (inUse) throw new Error('that port has an active session -- disconnect it first');
  if (inProgress.has(match.path)) throw new Error('detection is already running for that device');
  inProgress.add(match.path);
  try {
    return await detect(match.path);
  } finally {
    inProgress.delete(match.path);
  }
}

module.exports = { detect, detectForDevice, printableRatio };
