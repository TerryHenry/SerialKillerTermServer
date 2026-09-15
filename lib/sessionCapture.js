'use strict';

const fs = require('fs');
const path = require('path');
const configStore = require('./configStore');

const CAPTURE_DIR = path.join(configStore.DATA_DIR, 'captures');

function sanitizePart(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'unknown';
}

// Filenames are flat (no per-port subdirectories) and self-describing, the same
// approach the TFTP file browser already uses -- keeps "is this path still inside
// CAPTURE_DIR" trivial to check for the download/delete routes.
function sanitizeCaptureFilename(name) {
  const base = path.basename(String(name || '').trim());
  if (!base || base === '.' || base === '..') {
    throw new Error('invalid filename');
  }
  return base;
}

/**
 * Starts a capture file for one session if the port has capture enabled OR the
 * connecting user does (meta.userCaptureEnabled) -- either is enough to trigger it, so
 * an admin can always capture a sensitive port regardless of who's on it, and
 * separately always capture a specific user regardless of which port they're on.
 * Returns null when neither is set, otherwise an object with write(data) (call for both
 * directions, in event order, so the file reads like the session actually happened) and
 * close().
 */
function startCapture(portConfig, meta) {
  const portWantsIt = !!(portConfig && portConfig.captureEnabled);
  const userWantsIt = !!(meta && meta.userCaptureEnabled);
  if (!portWantsIt && !userWantsIt) return null;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}_${sanitizePart(portConfig.label)}_${sanitizePart(meta.username)}.log`;
  const filePath = path.join(CAPTURE_DIR, filename);
  const stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
  const triggeredBy = [portWantsIt && 'port', userWantsIt && 'user'].filter(Boolean).join('+');
  stream.write(
    `=== Session capture started ${new Date().toISOString()} — user "${meta.username}" via ${meta.method} on "${portConfig.label}" (triggered by: ${triggeredBy}) ===\n`
  );
  let closed = false;
  return {
    write(data) {
      if (!closed) stream.write(data);
    },
    close() {
      if (closed) return;
      closed = true;
      stream.write(`\n=== Session capture ended ${new Date().toISOString()} ===\n`);
      stream.end();
    }
  };
}

function listCaptures() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  return fs
    .readdirSync(CAPTURE_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const stat = fs.statSync(path.join(CAPTURE_DIR, e.name));
      return { name: e.name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

module.exports = { CAPTURE_DIR, startCapture, listCaptures, sanitizeCaptureFilename };
