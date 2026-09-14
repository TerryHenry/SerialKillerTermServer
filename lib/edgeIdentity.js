'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Deliberately a separate keypair from the appliance's own SSH host key (lib/hostKeys.js)
// -- that one authenticates *this box* to end users; this one authenticates *this box*
// to a Central Office hub. Different trust relationships, different keys, so revoking or
// rotating one never touches the other.
function ensureEdgeIdentity(dataDir) {
  const keyDir = path.join(dataDir, 'fleet');
  fs.mkdirSync(keyDir, { recursive: true });
  const keyPath = path.join(keyDir, 'edge_ed25519_key');
  const pubPath = `${keyPath}.pub`;

  if (!fs.existsSync(keyPath)) {
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'terminalserver-edge-identity']);
    fs.chmodSync(keyPath, 0o600);
  }

  return {
    privateKey: fs.readFileSync(keyPath),
    publicKey: fs.existsSync(pubPath) ? fs.readFileSync(pubPath, 'utf8').trim() : null
  };
}

module.exports = { ensureEdgeIdentity };
