'use strict';

const https = require('https');

/**
 * POSTs JSON to a host over HTTPS, pinning the server's TLS certificate fingerprint
 * instead of trusting whatever certificate it presents. Every hub is self-signed, so
 * there's no CA chain for rejectUnauthorized to validate anyway -- it's off here by
 * design, and the manual fingerprint comparison below (once one is pinned) is what
 * actually verifies identity in its place. Without this, a MITM sitting between this
 * box and its hub could terminate TLS with its own certificate undetected: it would
 * read (not just tamper with) every plaintext payload sent this way, which for a
 * config-backup push means admin password hashes and TOTP secrets, and could also
 * answer as a fake hub during the one-time enrollment handshake, harvesting the
 * enrollment token and this box's public key or substituting its own.
 *
 * Not pinned yet (pinnedFingerprint falsy): trust-on-first-use, matching this
 * project's existing SSH host-key-pinning posture for tunnelClient.js -- enough to
 * get a first connection going, closed once the admin pastes the hub's fingerprint
 * (shown on its own System tab) into this box's Central Office panel.
 */
function postJson(host, port, path, body, pinnedFingerprint, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        rejectUnauthorized: false,
        timeout: timeoutMs
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`hub returned HTTP ${res.statusCode}: ${data}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('hub returned invalid JSON'));
          }
        });
      }
    );
    // Runs as soon as the TLS handshake completes, before any request body is sent or
    // response data read -- a pinned mismatch aborts the socket right here, so nothing
    // sensitive ever actually reaches the wire toward an impersonator.
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        if (!pinnedFingerprint) return;
        const cert = socket.getPeerCertificate();
        const actual = cert && cert.fingerprint256 ? cert.fingerprint256.replace(/:/g, '') : null;
        const expected = String(pinnedFingerprint).replace(/:/g, '').toUpperCase();
        if (!actual || actual.toUpperCase() !== expected) {
          req.destroy(new Error('hub TLS certificate does not match the pinned fingerprint -- refusing to send (possible impersonation)'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.write(body);
    req.end();
  });
}

module.exports = { postJson };
