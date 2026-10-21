// -----------------------------------------------------------------------------
// The TCP session against small hostile servers on the loopback interface.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ERROR_KINDS, openSession } from '../src/jvc/client.js';

async function server(t, onRequest) {
  const s = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write('PJ_OK');
    socket.once('data', () => onRequest(socket));
  });
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => s.close(resolve)));
  return s.address().port;
}

const open = (port, deadlineMs) =>
  openSession({
    host: '127.0.0.1',
    port,
    password: 'secret12',
    deadline: Date.now() + deadlineMs,
    connectTimeout: 300,
    readTimeout: 300,
    spacing: { ref: 1, op: 1 },
  });

test('R3 PJNAK then a full silence: a refusal', async (t) => {
  const port = await server(t, (socket) => socket.write('PJNAK'));
  await assert.rejects(open(port, 2_000), (err) => err.kind === ERROR_KINDS.AUTH);
});

test('R3 PJNAK then the budget runs out: not a refusal', async (t) => {
  const port = await server(t, (socket) => socket.write('PJNAK'));
  await assert.rejects(open(port, 150), (err) => err.kind === ERROR_KINDS.TIMEOUT);
});

test('PJNAK then closed: a refusal', async (t) => {
  const port = await server(t, (socket) => socket.end('PJNAK'));
  await assert.rejects(open(port, 2_000), (err) => err.kind === ERROR_KINDS.AUTH);
});

test('the error messages never hold the password', async (t) => {
  const port = await server(t, (socket) => socket.end('PJNAK'));
  await assert.rejects(open(port, 2_000), (err) => !err.message.includes('secret12'));
});
