'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function ensureHostKey(dataDir) {
  const keyDir = path.join(dataDir, 'ssh');
  fs.mkdirSync(keyDir, { recursive: true });
  const keyPath = path.join(keyDir, 'host_ed25519_key');
  const pubPath = `${keyPath}.pub`;

  if (!fs.existsSync(keyPath)) {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'terminalserver-host-key']);
    fs.chmodSync(keyPath, 0o600);
  }

  return {
    privateKey: fs.readFileSync(keyPath),
    publicKey: fs.existsSync(pubPath) ? fs.readFileSync(pubPath, 'utf8').trim() : null,
    keyPath
  };
}

module.exports = { ensureHostKey };
