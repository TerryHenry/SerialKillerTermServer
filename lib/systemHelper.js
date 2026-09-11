'use strict';

const path = require('path');
const { execFile } = require('child_process');
const configStore = require('./configStore');

const HELPER_PATH = path.join(configStore.DATA_DIR, '..', 'provisioning', 'system-helper.sh');

/**
 * Runs the one fixed, sudoers-whitelisted helper script as root. Shared by wifiControl.js
 * and systemControl.js -- both just hand it different structured subcommands.
 *
 * `stdinInput`, when given, is written to the child's stdin and the pipe closed -- used
 * for the one subcommand (os-password-set) that takes a secret over stdin instead of argv
 * so it's never briefly visible to other local processes via the process list.
 */
function runHelper(args, stdinInput) {
  return new Promise((resolve, reject) => {
    // execFile (not exec) with an argv array -- never shell-interpolated, so a value
    // containing spaces/quotes/special characters (an SSID, password, DNS list, timezone)
    // can't break out of the command or inject anything, however it's spelled.
    const child = execFile('sudo', [HELPER_PATH, ...args], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'command failed').trim()));
      resolve(stdout);
    });
    if (stdinInput !== undefined) child.stdin.end(stdinInput);
  });
}

module.exports = { runHelper };
