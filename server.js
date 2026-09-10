'use strict';

const https = require('https');

const configStore = require('./lib/configStore');
const { ensureHostKey } = require('./lib/hostKeys');
const { ensureTlsCert } = require('./lib/tlsCert');
const logStore = require('./lib/logStore');
const sshServer = require('./lib/sshServer');
const tftpServer = require('./lib/tftpServer');
const { createWebServer } = require('./lib/webServer');

logStore.init(configStore.DATA_DIR);

const hostKey = ensureHostKey(configStore.DATA_DIR);
const tlsCert = ensureTlsCert(configStore.DATA_DIR);

const { app, attachTerminalSocket } = createWebServer(sshServer, tftpServer, hostKey.publicKey);
app.locals.hostKeyPrivate = hostKey.privateKey;

const webPort = configStore.getConfig().web.port;
const httpsServer = https.createServer({ key: tlsCert.key, cert: tlsCert.cert }, app);
attachTerminalSocket(httpsServer);
httpsServer.listen(webPort, '0.0.0.0', () => {
  console.log(`Serial Killer Terminal Server admin UI listening on https://0.0.0.0:${webPort}`);
});

if (configStore.getConfig().ssh.enabled && configStore.getConfig().ssh.autoStart) {
  sshServer.start(hostKey.privateKey);
}

if (configStore.getConfig().tftp.autoStart) {
  const tftp = configStore.getConfig().tftp;
  tftpServer.start(tftp.port, configStore.TFTP_ROOT_DIR, tftp.allowUpload);
}

sshServer.on('log', (line) => console.log(line));
tftpServer.on('log', (line) => console.log(line));

process.on('SIGTERM', () => {
  sshServer.stop();
  tftpServer.stop();
  process.exit(0);
});
process.on('SIGINT', () => {
  sshServer.stop();
  tftpServer.stop();
  process.exit(0);
});
