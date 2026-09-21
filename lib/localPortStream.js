'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

/**
 * Opens one of this box's own serial ports and wraps it as the small stream the batch runner
 * drives (data/close events, write, destroy). It goes through serialManager like any other
 * session, so the port's access mode is honored: an exclusive port that a user has open fails
 * with that reason, and a port this session can't write to is refused up front rather than
 * letting a script silently type into nothing.
 */
async function openLocalPort(serialManager, portConfig) {
  const { serialPort, release, canWrite } = await serialManager.open(portConfig, crypto.randomUUID());
  if (!canWrite()) {
    release();
    throw new Error('this port is read-only under its current access mode, so a script cannot type into it');
  }

  const stream = new EventEmitter();
  let closed = false;
  const onData = (chunk) => stream.emit('data', chunk);
  const finish = () => {
    if (closed) return;
    closed = true;
    serialPort.removeListener('data', onData);
    serialPort.removeListener('close', finish);
    serialPort.removeListener('error', finish);
    release();
    stream.emit('close');
  };
  serialPort.on('data', onData);
  serialPort.once('close', finish);
  serialPort.once('error', finish);

  stream.write = (buf) => {
    if (!closed && canWrite()) serialPort.write(buf);
    return true;
  };
  stream.destroy = finish;
  return stream;
}

module.exports = { openLocalPort };
