// -----------------------------------------------------------------------------
// One TCP session with a JVC projector: connection, handshake (PJ_OK, PJREQ,
// PJACK) with the optional password, then reference and operation commands,
// one at a time, spaced as pyjvcprojector spaces them (0.1 s after a read,
// 1 s after an operation). Ported from pyjvcprojector 2.1.0 (MIT,
// jvcprojector/device.py and connection.py), see THIRD_PARTY_NOTICES.md.
//
// Untrusted input: at most 512 bytes are buffered, the handshake reads exactly
// 5 bytes, every answer is one line, matched against the expected header.
// The password and the authentication bytes are never logged nor put in an
// error message.
// -----------------------------------------------------------------------------

import net from 'node:net';
import {
  HANDSHAKE,
  answerValue,
  authPayloads,
  isAck,
  opFrame,
  refFrame,
  requestFrame,
} from './protocol.js';

export const ERROR_KINDS = Object.freeze({
  /** Nothing connected: refused, no route, no answer to the TCP connection. */
  UNREACHABLE: 'unreachable',
  /** The projector answered PJ_NG: another client is connected, or it is busy. */
  BUSY: 'busy',
  /** The projector refused the password (or asks for one). */
  AUTH: 'auth',
  /** Connected, then no answer in time. */
  TIMEOUT: 'timeout',
  /** Unexpected bytes. */
  PROTOCOL: 'protocol',
  /** No time left in the budget of the caller (nothing sent). */
  BUDGET: 'budget',
  /** The connection closed under a request. */
  CLOSED: 'closed',
});

export class JvcError extends Error {
  /** `sent`: an operation frame left, it may have reached the projector. */
  constructor(kind, message, { sent = false } = {}) {
    super(message);
    this.name = 'JvcError';
    this.kind = kind;
    this.sent = sent;
  }
}

const MAX_BUFFER = 512;
const HANDSHAKE_LENGTH = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export class Session {
  constructor(socket, { readTimeout, deadline, now = Date.now, spacing }) {
    this.socket = socket;
    this.readTimeout = readTimeout;
    this.deadline = deadline;
    this.now = now;
    this.spacing = spacing;
    this.buffer = Buffer.alloc(0);
    this.pending = undefined;
    this.closed = false;
    this.failure = undefined;
    this.nextSendAt = 0;
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.onClose());
    socket.on('close', () => this.onClose());
    if (socket.destroyed) {
      this.onClose();
    }
  }

  onData(chunk) {
    if (this.closed) {
      return;
    }
    if (this.buffer.length + chunk.length > MAX_BUFFER) {
      this.fail(new JvcError(ERROR_KINDS.PROTOCOL, 'Too much data from the projector'));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.serve();
  }

  onClose() {
    if (!this.closed) {
      this.fail(new JvcError(ERROR_KINDS.CLOSED, 'The projector closed the connection'));
    }
  }

  fail(err) {
    this.failure = this.failure ?? err;
    this.close();
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.socket.destroy();
    }
  }

  /** Settles the pending read when the buffer holds what it waits for. */
  serve() {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    let end;
    if (pending.bytes !== undefined) {
      end = this.buffer.length >= pending.bytes ? pending.bytes : -1;
    } else {
      const index = this.buffer.indexOf(0x0a);
      end = index === -1 ? -1 : index + 1;
    }
    if (end === -1) {
      return;
    }
    const data = this.buffer.subarray(0, end);
    this.buffer = this.buffer.subarray(end);
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(Buffer.from(data));
  }

  /** What is left before `until` (the deadline by default), capped by the read timeout. */
  left(until = this.deadline) {
    return Math.min(this.readTimeout, Math.min(until, this.deadline) - this.now());
  }

  read({ bytes, timeout, what }) {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (timeout <= 0) {
      const err = new JvcError(ERROR_KINDS.TIMEOUT, `No time left to read ${what}`);
      err.capped = true;
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        const err = new JvcError(ERROR_KINDS.TIMEOUT, `No ${what} from the projector in time`);
        // Cut short by the caller's budget: not a silence of the projector.
        err.capped = timeout < this.readTimeout;
        reject(err);
      }, timeout);
      this.pending = { bytes, resolve, reject, timer };
      this.serve();
    });
  }

  readBytes(bytes, timeout, what) {
    return this.read({ bytes, timeout, what });
  }

  readLine(timeout, what) {
    return this.read({ timeout, what });
  }

  write(buffer) {
    if (this.failure) {
      throw this.failure;
    }
    this.socket.write(buffer);
  }

  /** Waits for the spacing after the previous command; BUDGET when it does not fit. */
  async waitTurn() {
    const wait = this.nextSendAt - this.now();
    if (wait > 0) {
      if (this.now() + wait >= this.deadline) {
        throw new JvcError(ERROR_KINDS.BUDGET, 'No time left for this command, nothing sent');
      }
      await sleep(wait);
    }
  }

  /**
   * A reference command: the value the projector answers (raw ASCII), read
   * before `until` (the session deadline by default).
   */
  async ref(code, { until = this.deadline } = {}) {
    await this.waitTurn();
    if (this.left(until) <= 0) {
      throw new JvcError(ERROR_KINDS.BUDGET, 'No time left for this read');
    }
    this.write(refFrame(code));
    try {
      const ack = await this.readLine(this.left(until), `ack of ${code}`);
      if (!isAck(ack, code)) {
        throw new JvcError(ERROR_KINDS.PROTOCOL, `Unexpected ack for ${code}`);
      }
      const line = await this.readLine(this.left(until), `answer to ${code}`);
      const value = answerValue(line, code);
      if (value === undefined) {
        throw new JvcError(ERROR_KINDS.PROTOCOL, `Unexpected answer to ${code}`);
      }
      return value;
    } catch (err) {
      // A read that failed half-way leaves the line out of step: never reused.
      this.fail(err);
      throw err;
    } finally {
      this.nextSendAt = this.now() + this.spacing.ref;
    }
  }

  /**
   * An operation command. From the write on, every error is `sent`: the
   * frame may have reached the projector. `ackTimeout` may go past the
   * deadline (an input change is acked once done, up to 10 s later).
   */
  async op(code, value, ackTimeout = this.readTimeout) {
    await this.waitTurn();
    if (this.deadline - this.now() <= 0) {
      throw new JvcError(ERROR_KINDS.BUDGET, 'No time left for this command, nothing sent');
    }
    this.write(opFrame(code, value));
    try {
      const ack = await this.readLine(ackTimeout, `ack of ${code}`);
      if (!isAck(ack, code)) {
        throw new JvcError(ERROR_KINDS.PROTOCOL, `Unexpected ack for ${code}`);
      }
    } catch (err) {
      this.fail(err);
      throw new JvcError(err.kind, err.message, { sent: true });
    } finally {
      this.nextSendAt = this.now() + this.spacing.op;
    }
  }
}

const refusedMessage = (password) =>
  password
    ? 'The projector refused the password'
    : 'The projector asks for a password (network password set on the projector)';

function connect({ host, port, timeout, createConnection }) {
  return new Promise((resolve, reject) => {
    if (timeout <= 0) {
      reject(new JvcError(ERROR_KINDS.BUDGET, 'No time left to connect, nothing sent'));
      return;
    }
    const socket = createConnection({ host, port });
    socket.setNoDelay?.(true);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new JvcError(ERROR_KINDS.UNREACHABLE, `No answer from ${host}:${port}`));
    }, timeout);
    const onError = (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(
        new JvcError(
          ERROR_KINDS.UNREACHABLE,
          `Cannot connect to ${host}:${port} (${err.code ?? 'error'})`,
        ),
      );
    };
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      // Until the session listens: an error is never left unhandled.
      socket.on('error', () => {});
      resolve(socket);
    });
    socket.once('error', onError);
  });
}

/**
 * Opens a session: TCP connection, PJ_OK, then PJREQ with the password when
 * one is set. With a password, the plain one (padded to 16 bytes) is tried
 * first, then its SHA-256 form (recent models), on the same connection, as
 * pyjvcprojector does; `authMode` ('plain' | 'hashed') says which one
 * worked, so the next session starts with it.
 *
 * @returns {Promise<{ session: Session, authMode: string | undefined }>}
 */
export async function openSession({
  host,
  port,
  password,
  authMode,
  deadline,
  connectTimeout,
  readTimeout,
  spacing,
  now = Date.now,
  createConnection = net.createConnection,
}) {
  const socket = await connect({
    host,
    port,
    timeout: Math.min(connectTimeout, deadline - now()),
    createConnection,
  });
  const session = new Session(socket, { readTimeout, deadline, now, spacing });
  let nak = false;
  try {
    const hello = (await session.readBytes(HANDSHAKE_LENGTH, session.left(), 'greeting')).toString(
      'latin1',
    );
    if (hello === HANDSHAKE.NG) {
      throw new JvcError(ERROR_KINDS.BUSY, 'The projector is busy (another client connected?)');
    }
    if (hello !== HANDSHAKE.OK) {
      throw new JvcError(ERROR_KINDS.PROTOCOL, 'Not a JVC projector greeting');
    }
    const { plain, hashed } = authPayloads(password);
    const tries = !password
      ? [['none', Buffer.alloc(0)]]
      : authMode === 'hashed'
        ? [
            ['hashed', hashed],
            ['plain', plain],
          ]
        : [
            ['plain', plain],
            ['hashed', hashed],
          ];
    for (const [mode, auth] of tries) {
      session.write(requestFrame(auth));
      const answer = (
        await session.readBytes(HANDSHAKE_LENGTH, session.left(), 'handshake answer')
      ).toString('latin1');
      if (answer === HANDSHAKE.ACK) {
        return { session, authMode: password ? mode : undefined };
      }
      if (answer !== HANDSHAKE.NAK) {
        throw new JvcError(ERROR_KINDS.PROTOCOL, 'Unexpected handshake answer');
      }
      nak = true;
    }
    throw new JvcError(ERROR_KINDS.AUTH, refusedMessage(password));
  } catch (err) {
    session.close();
    const refusalEnd =
      err.kind === ERROR_KINDS.CLOSED ||
      err.kind === ERROR_KINDS.PROTOCOL ||
      (err.kind === ERROR_KINDS.TIMEOUT && !err.capped);
    if (nak && refusalEnd) {
      // A PJNAK was received: what ends the handshake after it (closed, a
      // full silence, garbage) is a refusal, never a busy projector tried
      // again. A budget running out is not (the caller had no time left).
      throw new JvcError(ERROR_KINDS.AUTH, refusedMessage(password));
    }
    if (err.kind === ERROR_KINDS.CLOSED && session.buffer.length === 0) {
      // Closed before or during the handshake: some models close at once
      // when another client is connected.
      throw new JvcError(ERROR_KINDS.BUSY, 'The projector closed the connection at the handshake');
    }
    throw err;
  }
}
