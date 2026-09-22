'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const { promisify } = require('util');
const configStore = require('./configStore');
const { runHelper } = require('./systemHelper');
const { logTimestamp } = require('./logTimestamp');

const execFileAsync = promisify(execFile);

const { version: CURRENT_VERSION, name: PACKAGE_NAME } = require('../package.json');
const RELEASES_API_URL = 'https://api.github.com/repos/TerryHenry/SerialKillerTermServer/releases/latest';
const APP_TARBALL_NAME = 'terminalserver-app.tar.gz';
const CHECKSUM_NAME = 'terminalserver-app.tar.gz.sha256';
const SIGNATURE_NAME = 'terminalserver-app.tar.gz.sig';
const MIN_FREE_MB = 500;
const APP_DIR = path.join(configStore.DATA_DIR, '..');
// Deliberately NOT part of SWAP_ITEMS below, and not shipped inside the app tarball
// itself -- provisioning/firstrun.sh copies this onto the Pi once, straight from the
// image's boot partition, entirely outside the update tarball's own contents. A trust
// anchor that a future update package could rewrite isn't a trust anchor: a single
// legitimately-signed-but-malicious release could otherwise swap in an
// attacker-controlled key and have every later release verify against that instead.
// Re-flashing (or a deliberate manual SSH change) is the only way this ever changes.
const PUBLIC_KEY_PATH = path.join(APP_DIR, 'release-signing-pubkey.pem');
const BACKUP_ROOT = path.join(configStore.DATA_DIR, 'backups');
const STAGING_DIR = path.join(configStore.DATA_DIR, 'update-staging');
const DOWNLOAD_PATH = path.join(configStore.DATA_DIR, 'update-download.tar.gz');
const SWAP_ITEMS = [
  'server.js',
  'package.json',
  'package-lock.json',
  'lib',
  'webui',
  'provisioning',
  'node_modules',
  // The Help tab's embedded Handbook/Quickstart (lib/webServer.js serves these
  // straight from APP_DIR) -- part of the ordinary swap, unlike the signing pubkey
  // above, since there's no trust-anchor concern here: refreshing them on every
  // update is exactly what should happen, so the embedded docs always match whatever
  // version is actually running.
  'HANDBOOK.html',
  'QUICKSTART.html'
];

function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

class SelfUpdateManager extends EventEmitter {
  constructor() {
    super();
    this.updating = false;
  }

  isUpdating() {
    return this.updating;
  }

  log(line) {
    this.emit('log', `[${logTimestamp()}] [UPDATE] ${line}`);
  }

  async fetchLatestRelease() {
    const res = await fetch(RELEASES_API_URL, {
      headers: { 'User-Agent': PACKAGE_NAME, Accept: 'application/vnd.github+json' }
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
    return res.json();
  }

  /** Public status used by the "Check for Updates" button -- no side effects. */
  async checkForUpdate() {
    let release;
    try {
      release = await this.fetchLatestRelease();
    } catch {
      throw new Error('could not reach GitHub — check the Pi has internet access');
    }
    if (!release) {
      return { currentVersion: CURRENT_VERSION, found: false };
    }
    const tarballAsset = release.assets.find((a) => a.name === APP_TARBALL_NAME);
    const checksumAsset = release.assets.find((a) => a.name === CHECKSUM_NAME);
    const signatureAsset = release.assets.find((a) => a.name === SIGNATURE_NAME);
    return {
      currentVersion: CURRENT_VERSION,
      found: true,
      latestVersion: release.tag_name,
      upToDate: normalizeVersion(release.tag_name) === normalizeVersion(CURRENT_VERSION),
      url: release.html_url,
      // Older releases (published before this feature existed) won't carry these assets --
      // still reported as "an update exists," just not one this appliance can self-apply.
      // An unsigned release counts the same way: the checksum alone only proves the
      // download matches what GitHub is currently serving, not who put it there.
      canApplyInPlace: !!(tarballAsset && checksumAsset && signatureAsset)
    };
  }

  /** Loaded fresh on every apply rather than cached at module load -- a missing or
   * unreadable key should fail the one update attempt that needed it, not crash the
   * whole app on startup for something that only matters when an update is actually
   * requested. */
  loadPublicKey() {
    let pem;
    try {
      pem = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
    } catch (err) {
      throw new Error(`could not read the release signing public key at ${PUBLIC_KEY_PATH}: ${err.message}`);
    }
    const key = crypto.createPublicKey({ key: pem, format: 'pem' });
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error(`release signing public key at ${PUBLIC_KEY_PATH} is not an ed25519 key`);
    }
    return key;
  }

  hasSigningKey() {
    return fs.existsSync(PUBLIC_KEY_PATH);
  }

  /** Bootstraps the trust anchor on a box that was imaged before this file existed on
   * the boot partition -- firstrun.sh normally places it once, on first boot only (see
   * PUBLIC_KEY_PATH's own comment for why an update tarball can never carry it). An
   * older box's first boot predates that convention entirely, so it never got one and
   * has no way to self-apply an update since. Deliberately refuses to overwrite an
   * existing key -- once a trust anchor is set, by re-flashing or this one-time manual
   * step, it stays fixed; this is a bootstrap path for a box that has never had one, not
   * a way to rotate one that's already there. */
  setSigningKey(pem) {
    if (this.hasSigningKey()) {
      throw new Error('a release signing public key is already set on this box -- refusing to replace it');
    }
    let key;
    try {
      key = crypto.createPublicKey({ key: pem, format: 'pem' });
    } catch (err) {
      throw new Error(`not a valid PEM public key: ${err.message}`);
    }
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error(`not an ed25519 key (got "${key.asymmetricKeyType}")`);
    }
    // Re-exported from the parsed key rather than writing the admin's pasted text
    // verbatim -- normalizes whitespace/line-wrapping and confirms what's written to
    // disk is exactly what was just validated above, not a close-but-not-quite variant.
    const normalized = key.export({ type: 'spki', format: 'pem' });
    fs.writeFileSync(PUBLIC_KEY_PATH, normalized, { mode: 0o644 });
  }

  async checkFreeSpace() {
    const { stdout } = await execFileAsync('df', ['-Pk', configStore.DATA_DIR]);
    const line = stdout.trim().split('\n')[1] || '';
    const availKb = Number(line.trim().split(/\s+/)[3]);
    if (!Number.isFinite(availKb)) return; // couldn't parse -- don't block on a soft check
    if (availKb / 1024 < MIN_FREE_MB) {
      throw new Error(`only ${Math.round(availKb / 1024)}MB free — need at least ${MIN_FREE_MB}MB to apply an update safely`);
    }
  }

  async downloadFile(url, destPath) {
    const res = await fetch(url, { headers: { 'User-Agent': PACKAGE_NAME } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const fileStream = fs.createWriteStream(destPath);
    await new Promise((resolve, reject) => {
      const { Readable } = require('stream');
      Readable.fromWeb(res.body).pipe(fileStream).on('finish', resolve).on('error', reject);
    });
  }

  async sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      fs.createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
    });
    return hash.digest('hex');
  }

  /**
   * Strips macOS build-artifact cruft (AppleDouble "._*" sidecar files -- the release
   * tarball is built on a Mac; if the source tree had any extended attributes on it, GNU
   * tar on Linux doesn't understand the xattr PAX headers macOS's tar writes and
   * materializes them as separate "._name" files instead of ignoring them, including
   * "._server.js" et al -- and .DS_Store, in case one snuck in) so they can't end up in
   * the live app directory or trip up the syntax check below.
   */
  async stripMacCruft(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('._') || entry.name === '.DS_Store') {
        await this.rmrf(full);
      } else if (entry.isDirectory()) {
        await this.stripMacCruft(full);
      }
    }
  }

  /** Recursively chmod +x's every .sh file under dir. */
  async chmodExecutable(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // dir doesn't exist -- nothing to do
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.chmodExecutable(full);
      } else if (entry.name.endsWith('.sh')) {
        await fsp.chmod(full, 0o755);
      }
    }
  }

  /** Recursively `node --check`s every .js file under dir (skipping node_modules). */
  async checkAllSyntax(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('._')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.checkAllSyntax(full);
      } else if (entry.name.endsWith('.js')) {
        await execFileAsync(process.execPath, ['--check', full]);
      }
    }
  }

  async rmrf(target) {
    await fsp.rm(target, { recursive: true, force: true });
  }

  async pruneOldBackups() {
    await fsp.mkdir(BACKUP_ROOT, { recursive: true });
    const entries = await fsp.readdir(BACKUP_ROOT);
    const backups = entries.filter((e) => e.startsWith('pre-update-')).sort();
    // Keep only the single most recent backup -- one level of undo, without letting
    // backups (which include a full node_modules copy) accumulate and fill the SD card.
    for (const old of backups) {
      await this.rmrf(path.join(BACKUP_ROOT, old));
    }
  }

  async copyInto(srcDir, destDir, items) {
    await fsp.mkdir(destDir, { recursive: true });
    for (const item of items) {
      const src = path.join(srcDir, item);
      if (!fs.existsSync(src)) continue;
      await fsp.cp(src, path.join(destDir, item), { recursive: true });
    }
  }

  /**
   * The whole apply flow: download, verify, stage, validate, back up, swap in, restart.
   * Everything up through the backup step is fully reversible with no live impact --
   * the running service is never touched until the very last step.
   */
  async applyUpdate() {
    if (this.updating) {
      const err = new Error('an update is already in progress');
      this.log(`FAILED: ${err.message}`);
      throw err;
    }
    this.updating = true;
    try {
      this.log('checking latest release...');
      const release = await this.fetchLatestRelease();
      if (!release) throw new Error('no releases found');
      const targetVersion = release.tag_name;
      const tarballAsset = release.assets.find((a) => a.name === APP_TARBALL_NAME);
      const checksumAsset = release.assets.find((a) => a.name === CHECKSUM_NAME);
      const signatureAsset = release.assets.find((a) => a.name === SIGNATURE_NAME);
      if (!tarballAsset || !checksumAsset || !signatureAsset) {
        throw new Error(`release ${targetVersion} does not publish a signed in-place update package`);
      }
      if (normalizeVersion(targetVersion) === normalizeVersion(CURRENT_VERSION)) {
        throw new Error(`already on ${CURRENT_VERSION}`);
      }

      await this.checkFreeSpace();

      this.log(`downloading ${targetVersion}...`);
      await this.downloadFile(tarballAsset.browser_download_url, DOWNLOAD_PATH);

      this.log('verifying checksum...');
      const checksumRes = await fetch(checksumAsset.browser_download_url, { headers: { 'User-Agent': PACKAGE_NAME } });
      if (!checksumRes.ok) throw new Error(`could not fetch checksum: HTTP ${checksumRes.status}`);
      const checksumText = await checksumRes.text();
      const expectedSha = (checksumText.trim().split(/\s+/)[0] || '').toLowerCase();
      const actualSha = await this.sha256File(DOWNLOAD_PATH);
      if (!expectedSha || expectedSha !== actualSha) {
        throw new Error('checksum mismatch -- downloaded file does not match the published release, refusing to apply it');
      }

      // The checksum above only proves this download matches what GitHub is currently
      // serving -- it says nothing about who put it there. Anyone who can publish a
      // release (a compromised maintainer account, a hijacked CI token) can ship a
      // tarball and a matching checksum together; only a signature checked against a
      // key that ships with the appliance itself, not fetched from GitHub, actually
      // proves authorship. Signs the checksum file's own bytes (see
      // scripts/sign-release.js), which transitively covers the tarball too, since a
      // tampered tarball would already have failed the checksum comparison above.
      this.log('verifying release signature...');
      const sigRes = await fetch(signatureAsset.browser_download_url, { headers: { 'User-Agent': PACKAGE_NAME } });
      if (!sigRes.ok) throw new Error(`could not fetch signature: HTTP ${sigRes.status}`);
      const sigText = (await sigRes.text()).trim();
      const signature = Buffer.from(sigText, 'base64');
      const publicKey = this.loadPublicKey();
      const signatureValid = signature.length > 0 && crypto.verify(null, Buffer.from(checksumText), publicKey, signature);
      if (!signatureValid) {
        throw new Error('signature verification failed -- this release was not signed with the expected key, refusing to apply it (possible supply-chain compromise)');
      }

      this.log('extracting...');
      await this.rmrf(STAGING_DIR);
      await fsp.mkdir(STAGING_DIR, { recursive: true });
      // Shells out to the system tar (present on both Raspberry Pi OS and macOS dev
      // machines) rather than pulling in a JS tar-parsing dependency for this one step.
      await execFileAsync('tar', ['-xzf', DOWNLOAD_PATH, '-C', STAGING_DIR]);
      await this.stripMacCruft(STAGING_DIR);

      const stagedPkgPath = path.join(STAGING_DIR, 'package.json');
      if (!fs.existsSync(path.join(STAGING_DIR, 'server.js')) || !fs.existsSync(stagedPkgPath)) {
        throw new Error('extracted update package is missing expected files');
      }
      const stagedPkg = JSON.parse(await fsp.readFile(stagedPkgPath, 'utf8'));
      if (stagedPkg.name !== PACKAGE_NAME) {
        throw new Error('extracted update package does not look like this application');
      }

      this.log('checking syntax of the new version before touching anything live...');
      await this.checkAllSyntax(STAGING_DIR);

      this.log('installing dependencies for the new version (this can take a minute)...');
      await execFileAsync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: STAGING_DIR,
        timeout: 10 * 60 * 1000
      });

      this.log('backing up the current version...');
      await this.pruneOldBackups();
      const backupDir = path.join(BACKUP_ROOT, `pre-update-${normalizeVersion(CURRENT_VERSION)}-${Date.now()}`);
      await this.copyInto(APP_DIR, backupDir, SWAP_ITEMS);

      this.log('swapping in the new version...');
      for (const item of SWAP_ITEMS) {
        await this.rmrf(path.join(APP_DIR, item));
        const staged = path.join(STAGING_DIR, item);
        if (fs.existsSync(staged)) {
          await fsp.rename(staged, path.join(APP_DIR, item));
        }
      }
      // Belt and suspenders: the tarball should already carry the right executable bits
      // (git tracks them), but a fresh in-place install of provisioning/ is exactly the
      // kind of thing a future packaging regression could silently strip -- and the one
      // script that matters here (system-helper.sh) is the one this whole restart step
      // depends on being runnable.
      await this.chmodExecutable(path.join(APP_DIR, 'provisioning'));

      await this.rmrf(STAGING_DIR);
      await this.rmrf(DOWNLOAD_PATH);

      this.log(`update to ${targetVersion} staged successfully -- restarting the service now`);
      // The HTTP response for the request that triggered this has already been sent by
      // the caller; this process is about to be killed by the restart it's requesting.
      await runHelper(['service-restart']);
    } catch (err) {
      this.log(`FAILED: ${err.message}`);
      throw err;
    } finally {
      this.updating = false;
    }
  }

  async latestBackupDir() {
    if (!fs.existsSync(BACKUP_ROOT)) return null;
    const entries = (await fsp.readdir(BACKUP_ROOT)).filter((e) => e.startsWith('pre-update-')).sort();
    return entries.length ? path.join(BACKUP_ROOT, entries[entries.length - 1]) : null;
  }

  async hasBackup() {
    return !!(await this.latestBackupDir());
  }

  /**
   * Restores the most recent pre-update backup while the app is still healthy enough to
   * serve this request -- for "the update applied fine but I don't want it" cases. If the
   * new version won't even start, use provisioning/rollback-update.sh over SSH instead;
   * that one works even when this app can't.
   */
  async rollback() {
    if (this.updating) {
      const err = new Error('an update is already in progress');
      this.log(`ROLLBACK FAILED: ${err.message}`);
      throw err;
    }
    const backupDir = await this.latestBackupDir();
    if (!backupDir) {
      const err = new Error('no backup found to roll back to');
      this.log(`ROLLBACK FAILED: ${err.message}`);
      throw err;
    }
    this.updating = true;
    try {
      this.log(`rolling back to backup at ${backupDir}...`);
      for (const item of SWAP_ITEMS) {
        const backed = path.join(backupDir, item);
        if (!fs.existsSync(backed)) continue;
        await this.rmrf(path.join(APP_DIR, item));
        await fsp.cp(backed, path.join(APP_DIR, item), { recursive: true });
      }
      this.log('rollback staged -- restarting the service now');
      await runHelper(['service-restart']);
    } catch (err) {
      this.log(`ROLLBACK FAILED: ${err.message}`);
      throw err;
    } finally {
      this.updating = false;
    }
  }
}

module.exports = new SelfUpdateManager();
