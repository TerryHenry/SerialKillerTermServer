'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function ensureTlsCert(dataDir) {
  const certDir = path.join(dataDir, 'tls');
  fs.mkdirSync(certDir, { recursive: true });
  const keyPath = path.join(certDir, 'web_key.pem');
  const certPath = path.join(certDir, 'web_cert.pem');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    execFileSync('openssl', [
      'req', '-x509',
      '-newkey', 'rsa:2048',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '3650',
      '-nodes',
      '-subj', '/CN=terminalserver',
      '-addext', 'subjectAltName=DNS:terminalserver,DNS:terminalserver.local'
    ]);
    fs.chmodSync(keyPath, 0o600);
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
}

module.exports = { ensureTlsCert };
