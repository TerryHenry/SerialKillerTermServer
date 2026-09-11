'use strict';

const path = require('path');
const { execFile } = require('child_process');
const configStore = require('./configStore');

const HELPER_PATH = path.join(configStore.DATA_DIR, '..', 'provisioning', 'system-helper.sh');

/**
 * Runs the one fixed, sudoers-whitelisted helper script as root. Shared by wifiControl.js
 * and systemControl.js -- both just hand it different structured subcommands.
 */
function runHelper(args) {
  return new Promise((resolve, reject) => {
    // execFile (not exec) with an argv array -- never shell-interpolated, so a value
    // containing spaces/quotes/special characters (an SSID, password, DNS list, timezone)
    // can't break out of the command or inject anything, however it's spelled.
    execFile('sudo', [HELPER_PATH, ...args], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'command failed').trim()));
      resolve(stdout);
    });
  });
}

module.exports = { runHelper };
