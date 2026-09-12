'use strict';

const os = require('os');
const fs = require('fs');

function getOsRelease() {
  try {
    const content = fs.readFileSync('/etc/os-release', 'utf8');
    const match = content.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function getSystemInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    osRelease: getOsRelease(),
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: cpus[0] ? cpus[0].model : 'unknown',
    cpuCores: cpus.length,
    totalMemory: os.totalmem(),
    uptimeSec: os.uptime(),
    nodeVersion: process.version
  };
}

module.exports = { getSystemInfo };
