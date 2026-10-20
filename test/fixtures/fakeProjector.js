// -----------------------------------------------------------------------------
// A fake JVC projector on 127.0.0.1: the handshake (PJ_OK / PJ_NG, PJREQ with
// an optional password in plain or SHA-256 form, PJACK / PJNAK), reference
// and operation commands with their acks, a power cycle that goes through
// warming up and cooling down, and the misbehaviours the tests need (busy,
// silent, ops never acked or acked late, garbage).
// -----------------------------------------------------------------------------

import net from 'node:net';
import { createHash } from 'node:crypto';

export const MAC = 'E0DADC0A1562';
export const MAC_ID = MAC.toLowerCase();

const UNIT = Buffer.from([0x89, 0x01]);
const CODES = ['LSMA', 'IFLT', 'PMPM', 'MD', 'PW', 'IP', 'SC', 'RC'];

export async function startFakeProjector(options = {}) {
  const fake = {
    mac: options.mac ?? MAC,
    model: options.model ?? 'ILAFPJ -- B5A2',
    password: options.password ?? '',
    /** 'plain' or 'hashed': the authentication form this projector accepts. */
    authMode: options.authMode ?? 'plain',
    power: options.power ?? '0',
    input: options.input ?? '6',
    signal: options.signal ?? '1',
    lightTime: options.lightTime ?? '04D2',
    pictureMode: options.pictureMode ?? '03',
    warmMs: options.warmMs ?? 150,
    coolMs: options.coolMs ?? 150,
    /** 'ok' | 'busy' | 'silent' | 'close' | 'garbage' */
    mode: options.mode ?? 'ok',
    /** code -> 'never' | ms: when the ack of an operation comes */
    opAck: options.opAck ?? {},
    /** code -> 'never': references never answered */
    refSilent: options.refSilent ?? {},
    /** Every command line received: { kind: 'ref' | 'op', code, value }. */
    received: [],
    /** Every handshake request received (raw bytes). */
    requests: [],
    connections: 0,
    sockets: new Set(),
  };

  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  function setPower(value) {
    if (value === '1' && fake.power === '0') {
      fake.power = '3';
      later(() => {
        if (fake.power === '3') {
          fake.power = '1';
        }
      }, fake.warmMs);
    } else if (value === '0' && fake.power === '1') {
      fake.power = '2';
      later(() => {
        if (fake.power === '2') {
          fake.power = '0';
        }
      }, fake.coolMs);
    }
  }

  function answer(code) {
    switch (code) {
      case 'MD':
        return fake.model;
      case 'LSMA':
        return fake.mac;
      case 'PW':
        return fake.power;
      case 'IP':
        return fake.input;
      case 'SC':
        return fake.signal;
      case 'IFLT':
        return fake.lightTime;
      case 'PMPM':
        return fake.pictureMode;
      default:
        return undefined;
    }
  }

  function apply(code, value) {
    if (code === 'PW') {
      setPower(value);
    } else if (code === 'IP') {
      fake.input = value;
    } else if (code === 'PMPM') {
      fake.pictureMode = value;
    }
  }

  function accepts(auth) {
    if (!fake.password) {
      return true;
    }
    if (fake.authMode === 'hashed') {
      const hash = createHash('sha256').update(`${fake.password}JVCKWPJ`).digest('hex');
      return auth.toString('latin1') === hash;
    }
    const padded = Buffer.alloc(Math.max(16, Buffer.byteLength(fake.password)));
    Buffer.from(fake.password).copy(padded);
    return auth.equals(padded);
  }

  const server = net.createServer((socket) => {
    fake.connections += 1;
    fake.sockets.add(socket);
    socket.on('close', () => fake.sockets.delete(socket));
    socket.on('error', () => {});
    if (fake.mode === 'silent') {
      return;
    }
    if (fake.mode === 'busy') {
      socket.end('PJ_NG');
      return;
    }
    if (fake.mode === 'close') {
      socket.destroy();
      return;
    }
    if (fake.mode === 'garbage') {
      socket.write('HELLO');
      return;
    }
    socket.write('PJ_OK');
    let authed = false;
    let naks = 0;
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (!authed) {
        // One write of the client = one handshake request (loopback).
        fake.requests.push(Buffer.from(chunk));
        const text = chunk.toString('latin1');
        if (!text.startsWith('PJREQ')) {
          socket.destroy();
          return;
        }
        const auth = text.startsWith('PJREQ_') ? chunk.subarray(6) : Buffer.alloc(0);
        if (fake.password && auth.length === 0) {
          socket.write('PJNAK');
          naks += 1;
        } else if (accepts(auth)) {
          authed = true;
          socket.write('PJACK');
        } else {
          socket.write('PJNAK');
          naks += 1;
        }
        if (naks >= 2) {
          socket.end();
        }
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      let index;
      while ((index = buffer.indexOf(0x0a)) !== -1) {
        const line = buffer.subarray(0, index);
        buffer = buffer.subarray(index + 1);
        const kind = line[0] === 0x3f ? 'ref' : line[0] === 0x21 ? 'op' : undefined;
        if (!kind || !line.subarray(1, 3).equals(UNIT)) {
          continue;
        }
        const rest = line.subarray(3).toString('latin1');
        const code = CODES.find((c) => rest.startsWith(c));
        if (!code) {
          continue;
        }
        const value = rest.slice(code.length);
        fake.received.push({ kind, code, value });
        const ack = Buffer.concat([
          Buffer.from([0x06]),
          UNIT,
          Buffer.from(`${code.slice(0, 2)}\n`),
        ]);
        if (kind === 'ref') {
          if (fake.refSilent[code] === 'never') {
            continue;
          }
          socket.write(ack);
          socket.write(
            Buffer.concat([
              Buffer.from('@'),
              UNIT,
              Buffer.from(`${code.slice(0, 2)}${answer(code)}\n`),
            ]),
          );
        } else {
          const when = fake.opAck[code];
          if (when === 'never') {
            apply(code, value);
            continue;
          }
          if (typeof when === 'number') {
            later(() => {
              apply(code, value);
              if (!socket.destroyed) {
                socket.write(ack);
              }
            }, when);
            continue;
          }
          apply(code, value);
          socket.write(ack);
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = server.address().port;
  fake.ops = () => fake.received.filter((r) => r.kind === 'op');
  fake.close = () =>
    new Promise((resolve) => {
      for (const t of timers) {
        clearTimeout(t);
      }
      for (const socket of fake.sockets) {
        socket.destroy();
      }
      server.close(() => resolve());
    });
  return fake;
}
