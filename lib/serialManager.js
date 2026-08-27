'use strict';

const { SerialPort } = require('serialport');
const { EventEmitter } = require('events');

// Tracks which configured port ids are currently open and who is attached,
// so sessions can share a port (per its configured access mode) instead of
// always fighting over exclusive access.
class SerialManager extends EventEmitter {
  constructor() {
    super();
    this.openPorts = new Map(); // portId -> { serialPort, refCount, sessions: Set<sessionId> }
  }

  async listSystemPorts() {
    return SerialPort.list();
  }

  isLocked(portId) {
    const entry = this.openPorts.get(portId);
    return !!entry && entry.refCount > 0;
  }

  lockInfo(portId) {
    const entry = this.openPorts.get(portId);
    return entry ? { sessionIds: Array.from(entry.sessions), count: entry.refCount } : null;
  }

  /**
   * Whether the given session is currently allowed to write to a port, per its access mode.
   * Evaluated live (not cached at attach time) so "first-write" can hand write access to the
   * next-oldest session if the current writer disconnects.
   */
  canSessionWrite(portId, sessionId, access) {
    if (access === 'shared-ro') return false;
    if (access === 'first-write') {
      const entry = this.openPorts.get(portId);
      if (!entry) return false;
      return entry.sessions.values().next().value === sessionId;
    }
    return true; // exclusive or shared-rw
  }

  /**
   * Attaches to a physical serial port for a given configured port profile.
   * - access "exclusive" (default): throws PORT_LOCKED if another session already holds it.
   * - access "shared-rw" / "shared-ro": additional sessions reuse the same open port instead
   *   of failing; "shared-ro" sessions get canWrite: false back so callers can block their input.
   * - access "first-write": like shared-rw, but only the longest-attached session can write;
   *   everyone else is read-only until that session releases, at which point the next-oldest
   *   remaining session becomes the writer.
   */
  async open(portConfig, sessionId) {
    const access = portConfig.access || 'exclusive';
    let entry = this.openPorts.get(portConfig.id);

    if (entry) {
      if (access === 'exclusive') {
        const err = new Error(`Port "${portConfig.label}" is already in use.`);
        err.code = 'PORT_LOCKED';
        throw err;
      }
    } else {
      const serialPort = new SerialPort({
        path: portConfig.path,
        baudRate: Number(portConfig.baudRate) || 9600,
        dataBits: Number(portConfig.dataBits) || 8,
        stopBits: Number(portConfig.stopBits) || 1,
        parity: portConfig.parity || 'none',
        rtscts: !!portConfig.rtscts,
        autoOpen: false
      });

      // Register the entry (and its in-flight open promise) *before* awaiting the
      // physical open, and synchronously — not after. Otherwise two attach() calls
      // arriving before the first open() callback fires both see no entry yet and
      // both try to physically open the same device, racing at the OS level.
      entry = { serialPort, refCount: 0, sessions: new Set() };
      entry.openPromise = new Promise((resolve, reject) => {
        serialPort.open((err) => (err ? reject(err) : resolve()));
      }).catch((err) => {
        if (this.openPorts.get(portConfig.id) === entry) this.openPorts.delete(portConfig.id);
        throw err;
      });
      this.openPorts.set(portConfig.id, entry);
    }

    await entry.openPromise;

    entry.refCount += 1;
    entry.sessions.add(sessionId);
    this.emit('lock-changed');

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.refCount -= 1;
      entry.sessions.delete(sessionId);
      this.emit('lock-changed');
      if (entry.refCount <= 0) {
        this.openPorts.delete(portConfig.id);
        if (entry.serialPort.isOpen) entry.serialPort.close(() => {});
      }
    };

    entry.serialPort.once('close', release);
    entry.serialPort.once('error', release);

    return {
      serialPort: entry.serialPort,
      release,
      canWrite: () => this.canSessionWrite(portConfig.id, sessionId, access)
    };
  }
}

module.exports = new SerialManager();
