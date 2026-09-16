'use strict';

const https = require('https');
const configStore = require('./configStore');

/**
 * POSTs JSON to a host over HTTPS, pinning the server's TLS certificate fingerprint
 * instead of trusting whatever certificate it presents. Every hub is self-signed, so
 * there's no CA chain for rejectUnauthorized to validate anyway -- it's off here by
 * design, and the manual fingerprint comparison below is what actually verifies
 * identity in its place. Without this, a MITM sitting between this box and its hub
 * could terminate TLS with its own certificate undetected: it would read (not just
 * tamper with) every plaintext payload sent this way, which for a config-backup push
 * means admin password hashes and TOTP secrets, and could also answer as a fake hub
 * during the one-time enrollment handshake, harvesting the enrollment token and this
 * box's public key or substituting its own.
 *
 * A blank pinnedFingerprint means "no connection has happened yet", not "don't
 * verify": the first successful connection pins whatever certificate it saw (via
 * configStore.updateFleet()) and every one after that is compared against it,
 * rejecting a mismatch outright -- the same trust-on-first-use model
 * tunnelClient.js's hostVerifier uses for the hub's SSH host key. An admin who wants
 * zero TOFU window can still paste the hub's fingerprint (shown on its own System
 * tab) into this box's Central Office panel before ever enrolling.
 */
function postJson(host, port, path, body, pinnedFingerprint, log, timeoutMs = 10000) {
  if (typeof log !== 'function') log = () => {};
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        rejectUnauthorized: false,
        timeout: timeoutMs,
        // Without this, Node's default Agent caches a TLS session ticket per host and
        // silently resumes it on the next call -- a resumed handshake never re-sends
        // the certificate, so getPeerCertificate() comes back empty and there'd be
        // nothing to check the pin against. Forcing a one-off connection (no Agent)
        // means every call does a full handshake and actually presents a certificate
        // to verify -- the extra handshake cost is irrelevant at one call per 30s.
        agent: false
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
        const cert = socket.getPeerCertificate();
        const actual = cert && cert.fingerprint256 ? cert.fingerprint256 : null;
        if (!pinnedFingerprint) {
          if (actual) {
            configStore.updateFleet({ hubTlsFingerprint: actual });
            log(`pinned the hub's TLS certificate on first connection -- a future connection presenting a different one will be rejected`);
          }
          return;
        }
        const normalizedActual = actual ? actual.replace(/:/g, '').toUpperCase() : null;
        const expected = String(pinnedFingerprint).replace(/:/g, '').toUpperCase();
        if (!normalizedActual || normalizedActual !== expected) {
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
