'use strict';

const { runHelper } = require('./systemHelper');

async function setNtpServer(server) {
  await runHelper(['ntp-set', server]);
}

async function setTimezone(timezone) {
  await runHelper(['timezone-set', timezone]);
}

/** Pass an empty/undefined `servers` array to revert to DHCP-provided DNS. */
async function setDns(servers) {
  if (!servers || servers.length === 0) {
    await runHelper(['dns-clear']);
    return;
  }
  await runHelper(['dns-set', ...servers]);
}

module.exports = { setNtpServer, setTimezone, setDns };
