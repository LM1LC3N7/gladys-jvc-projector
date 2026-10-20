// -----------------------------------------------------------------------------
// JvcApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store and the fake projector on the loopback
// interface. The polling timer never fires: the tests drive the rounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { JvcApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { MAC_ID, startFakeProjector } from './fixtures/fakeProjector.js';

const SELECTOR = 'jvc-projector';
const id = (key, mac = MAC_ID) => `ext:${SELECTOR}:projector:${mac}${key ? `:${key}` : ''}`;
const PASSWORD = 'Secr3t-Pass';
const QUIET = { debug() {}, info() {}, warn() {}, error() {} };

/** No polling round; real (short) background timers. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const FAST = {
  ...TIMINGS,
  connectTimeout: 300,
  readTimeout: 300,
  slowAckTimeout: 1_200,
  spacing: { ref: 2, op: 10 },
  connectSpacing: 5,
  commandBudget: 900,
  preRead: 300,
  pollBudget: 1_500,
  recheckDelay: 30,
  deferredStep: 40,
  deferredStandby: 3_000,
  persistDelay: 5,
};

async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function setup(t, { fakeOptions, config, timings = {}, store = new MemoryStore() } = {}) {
  const fake = await startFakeProjector(fakeOptions);
  t.after(() => fake.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { addresses: `127.0.0.1:${fake.port}` },
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const app = new JvcApp({ gladys, logger, store, timers, timings: { ...FAST, ...timings } });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  return { fake, gladys, app, logs, store };
}

async function discovered(gladys, mac = MAC_ID) {
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id(undefined, mac)),
    'the projector in the Discovery tab',
  );
  return gladys.fake.discoveredDevices.find((d) => d.external_id === id(undefined, mac));
}

async function createDevice(gladys) {
  const device = await discovered(gladys);
  await gladys.fake.deviceCreated(device);
  await waitFor(() => gladys.fake.lastState(id('power')) !== undefined, 'the power state');
  return device;
}

const press = (gladys, device, key, value = 1) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(key)),
    value,
  );

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

test('a typed address becomes a Gladys device, identified by its MAC; states once created', async (t) => {
  const { gladys, fake } = await setup(t, { fakeOptions: { power: '1' } });
  const device = await discovered(gladys);
  assert.equal(device.name, 'JVC B5A2');
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: '127.0.0.1' }]);
  const keys = device.features.map((f) => f.external_id.slice(id().length + 1));
  assert.deepEqual(keys, [
    'power',
    'power_status',
    'power_on',
    'standby',
    'input',
    'picture_mode',
    'remote_key',
    'signal',
    'light_time',
  ]);
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  // No switch, nothing an "everything on / off" could command; the power is read only.
  assert.ok(device.features.every((f) => f.category !== 'switch'));
  assert.deepEqual(
    [byKey.power.category, byKey.power.type, byKey.power.read_only],
    ['unknown', 'binary', true],
  );
  assert.deepEqual([byKey.power_on.category, byKey.power_on.type], ['button', 'push']);
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual([byKey.light_time.category, byKey.light_time.unit], ['duration', 'hours']);
  assert.deepEqual(byKey.input.supported_options, [
    { value: 'hdmi1', label: 'HDMI 1' },
    { value: 'hdmi2', label: 'HDMI 2' },
  ]);
  const modes = byKey.picture_mode.supported_options.map((o) => o.value);
  assert.ok(modes.includes('film'), 'B5A2 has Film');
  assert.ok(modes.includes('frame-adapt-hdr3'));
  assert.ok(!modes.includes('reserved'));
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');
  assert.ok(fake.received.some((r) => r.code === 'LSMA'));

  await createDevice(gladys);
  await waitFor(() => gladys.fake.lastState(id('light_time')) === 1234, 'the lamp hours');
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('power_status')), 'On');
  assert.equal(gladys.fake.lastState(id('signal')), 1);
  assert.equal(gladys.fake.lastState(id('input')), 'hdmi1');
  assert.equal(gladys.fake.lastState(id('picture_mode')), 'natural');
  assert.equal(fake.ops().length, 0, 'reading never sends an operation');
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
});

test('in standby: power 0, signal 0, no input nor picture mode read', async (t) => {
  const { gladys, fake } = await setup(t);
  await createDevice(gladys);
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.equal(gladys.fake.lastState(id('power_status')), 'Standby');
  assert.equal(gladys.fake.lastState(id('signal')), 0);
  assert.equal(gladys.fake.lastState(id('input')), undefined);
  assert.ok(!fake.received.some((r) => r.code === 'PMPM' || r.code === 'IP'));
});

test('Power on is sent from standby only; the warm-up is shown', async (t) => {
  const { gladys, fake } = await setup(t, { fakeOptions: { warmMs: 300 } });
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(fake.ops(), [{ kind: 'op', code: 'PW', value: '1' }]);
  await waitFor(() => gladys.fake.lastState(id('power_status')) === 'Warming up', 'warming up');
  assert.equal(gladys.fake.lastState(id('power')), 1);

  // Already warming up / on: nothing sent again.
  const again = await press(gladys, device, 'power_on');
  assert.equal(again.success, true);
  assert.equal(fake.ops().length, 1);
});

test('Power on while cooling down is refused, nothing sent', async (t) => {
  const { gladys, fake } = await setup(t, { fakeOptions: { power: '2' } });
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, false);
  assert.match(ack.error, /cooling down/);
  assert.match(ack.error, /nothing sent/);
  assert.equal(fake.ops().length, 0);
});

test('Standby is sent when on, not when already in standby', async (t) => {
  const { gladys, fake } = await setup(t, { fakeOptions: { power: '1' } });
  const device = await createDevice(gladys);
  const ack = await press(gladys, device, 'standby');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(fake.ops(), [{ kind: 'op', code: 'PW', value: '0' }]);
  await waitFor(() => gladys.fake.lastState(id('power_status')) === 'Cooling down', 'cooling');
  await waitFor(() => fake.power === '0', 'standby');
  const again = await press(gladys, device, 'standby');
  assert.equal(again.success, true);
  assert.equal(fake.ops().length, 1, 'nothing sent in standby');
});

test('Standby while warming up is sent once the projector is on; Power on cancels it', async (t) => {
  const { gladys, fake } = await setup(t, { fakeOptions: { power: '0', warmMs: 250 } });
  const device = await createDevice(gladys);
  await press(gladys, device, 'power_on');
  await waitFor(() => fake.power === '3', 'warming up');
  const ack = await press(gladys, device, 'standby');
  // Not done yet: said so, never answered as a plain success.
  assert.equal(ack.success, false);
  assert.match(ack.error, /warming up: standby will be sent once it is on, nothing sent yet/);
  assert.equal(fake.ops().length, 1, 'not sent while warming up');
  await waitFor(() => fake.ops().length === 2, 'the deferred standby');
  assert.deepEqual(fake.ops()[1], { kind: 'op', code: 'PW', value: '0' });

  // A second cycle: Power on while the standby waits cancels it.
  await waitFor(() => fake.power === '0', 'back in standby', 3_000);
  await press(gladys, device, 'power_on');
  await waitFor(() => fake.power === '3', 'warming up again');
  await press(gladys, device, 'standby');
  await press(gladys, device, 'power_on');
  await waitFor(() => fake.power === '1', 'on');
  await settle(200);
  assert.equal(
    fake.ops().filter((o) => o.value === '0').length,
    1,
    'the second standby was cancelled',
  );
});

test('input and picture mode: validated first, sent only when on', async (t) => {
  const { gladys, fake } = await setup(t, { fakeOptions: { power: '1' } });
  const device = await createDevice(gladys);
  assert.equal((await press(gladys, device, 'input', 'hdmi2')).success, true);
  assert.deepEqual(fake.ops().at(-1), { kind: 'op', code: 'IP', value: '7' });
  assert.equal((await press(gladys, device, 'picture_mode', 'film')).success, true);
  assert.deepEqual(fake.ops().at(-1), { kind: 'op', code: 'PMPM', value: '00' });
  assert.equal((await press(gladys, device, 'remote_key', 'menu')).success, true);
  assert.deepEqual(fake.ops().at(-1), { kind: 'op', code: 'RC', value: '732E' });
  await waitFor(() => gladys.fake.lastState(id('input')) === 'hdmi2', 'the new input');

  const before = fake.connections;
  for (const [key, value] of [
    ['input', 'hdmi3'],
    ['picture_mode', 'thx'],
    ['picture_mode', '__proto__'],
    ['remote_key', 'power'],
    ['power', 1],
    ['light_time', 5],
  ]) {
    const ack = await press(gladys, device, key, value);
    assert.equal(ack.success, false, `${key}=${value}`);
  }
  assert.equal(fake.connections, before, 'an invalid command never connects');

  fake.power = '0';
  const ack = await press(gladys, device, 'input', 'hdmi1');
  assert.equal(ack.success, false);
  assert.match(ack.error, /not on \(standby\): nothing sent/);
});

test('an input change acked late: "sent, without confirmation" within the budget', async (t) => {
  const { gladys, fake } = await setup(t, {
    fakeOptions: { power: '1', opAck: { IP: 'never' } },
    timings: { slowAckTimeout: 2_500 },
  });
  const device = await createDevice(gladys);
  const started = Date.now();
  const ack = await press(gladys, device, 'input', 'hdmi2');
  const elapsed = Date.now() - started;
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, without confirmation/);
  assert.ok(elapsed < FAST.commandBudget + 400, `answered in ${elapsed} ms`);
  assert.equal(fake.input, '7');

  // A command queued behind it while the ack is awaited is dropped, never sent late.
  const second = await press(gladys, device, 'input', 'hdmi1');
  assert.equal(second.success, false);
  assert.match(second.error, /nothing sent/);
  assert.equal(fake.ops().filter((o) => o.code === 'IP').length, 1);
});

test('standby goes before the commands waiting', async (t) => {
  const { gladys, fake } = await setup(t, {
    fakeOptions: { power: '1', opAck: { RC: 150 } },
    timings: { commandBudget: 2_000 },
  });
  const device = await createDevice(gladys);
  const first = press(gladys, device, 'remote_key', 'up');
  await waitFor(() => fake.ops().length === 1, 'the first key');
  const second = press(gladys, device, 'remote_key', 'down');
  const standby = press(gladys, device, 'standby');
  await Promise.all([first, second, standby]);
  assert.deepEqual(
    fake.ops().map((o) => o.value),
    ['7301', '0'],
    'standby jumped ahead; the key after it found the projector cooling down',
  );
});

test('a password: plain form first, SHA-256 form next; never logged nor stored', async (t) => {
  for (const authMode of ['plain', 'hashed']) {
    await t.test(authMode, async (t) => {
      const store = new MemoryStore();
      const { gladys, fake, logs, app } = await setup(t, {
        fakeOptions: { password: PASSWORD, authMode, power: '1' },
        config: { addresses: '127.0.0.1:0', password: PASSWORD },
        store,
      });
      await gladys.fake.configUpdated({ addresses: `127.0.0.1:${fake.port}`, password: PASSWORD });
      const device = await createDevice(gladys);
      assert.equal((await press(gladys, device, 'remote_key', 'ok')).success, true);
      const first = fake.requests[0].toString('latin1');
      assert.ok(first.startsWith('PJREQ_'));
      if (authMode === 'hashed') {
        // The form that worked is used first afterwards.
        assert.equal(fake.requests.at(-1).length, 6 + 64);
      }
      await settle(30);
      await app.stop();
      const everything = [
        ...logs,
        JSON.stringify(store.data),
        JSON.stringify(gladys.fake.connectionStatuses),
        JSON.stringify(gladys.fake.discoveredDevices),
        JSON.stringify(gladys.fake.states),
      ].join('\n');
      assert.ok(!everything.includes(PASSWORD), 'the password never leaves');
    });
  }
});

test('a refused password: stop persisted, no retry before 30 minutes, retried after a save', async (t) => {
  const store = new MemoryStore();
  const { gladys, fake, app, logs } = await setup(t, {
    fakeOptions: { password: PASSWORD, power: '1' },
    config: { addresses: '127.0.0.1:0', password: 'wrong-one' },
    store,
  });
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${fake.port}`, password: 'wrong-one' });
  await waitFor(() => gladys.fake.connectionStatus?.connected === false, 'the refused status');
  assert.match(gladys.fake.connectionStatus.message.en, /Password refused/);
  assert.match(gladys.fake.connectionStatus.message.fr, /Mot de passe refusé/);
  await settle(30);
  const key = `127.0.0.1:${fake.port}`;
  assert.ok(store.data.authRefused[key] > Date.now() + 29 * 60_000, 'persisted');
  const connections = fake.connections;

  // Rounds (and a reconnection to Gladys) never send it again.
  await app.tick();
  await app.tick();
  await app.start({ addresses: key, password: 'wrong-one' }, { connected: true });
  assert.equal(fake.connections, connections, 'not tried again');

  // A restart reads the stop back (capped at 30 minutes).
  const restarted = new JvcApp({ gladys, logger: QUIET, store, timers, timings: FAST });
  await restarted.start({ addresses: key, password: 'wrong-one' });
  assert.equal(fake.connections, connections, 'not tried again after a restart');
  await restarted.stop();

  // A configuration save tries again: the right password is accepted.
  await gladys.fake.configUpdated({ addresses: key, password: PASSWORD });
  await discovered(gladys);
  await waitFor(() => gladys.fake.connectionStatus?.connected === true, 'connected again');
  assert.ok(!logs.join('\n').includes('wrong-one'));
  assert.ok(!logs.join('\n').includes(PASSWORD));
});

test('a projector that asks for a password when none is set', async (t) => {
  const { gladys, fake } = await setup(t, { fakeOptions: { password: PASSWORD } });
  await waitFor(() => gladys.fake.connectionStatus?.connected === false, 'the refused status');
  assert.equal(fake.requests[0].toString('latin1'), 'PJREQ');
});

test('a busy projector: nothing published, commands "nothing sent"', async (t) => {
  const { gladys, fake, app } = await setup(t, { fakeOptions: { power: '1' } });
  const device = await createDevice(gladys);
  const count = gladys.fake.states.length;
  fake.mode = 'busy';
  await app.poll();
  assert.equal(gladys.fake.states.length, count);
  const ack = await press(gladys, device, 'input', 'hdmi2');
  assert.equal(ack.success, false);
  assert.match(ack.error, /busy.*nothing sent/);
  // Standby is never refused for an unread state: tried again in a new session.
  fake.mode = 'ok';
  fake.refSilent = { PW: 'never' };
  const standby = await press(gladys, device, 'standby');
  assert.equal(standby.success, true, standby.error);
  assert.deepEqual(fake.ops().at(-1), { kind: 'op', code: 'PW', value: '0' });
});

test('an unreachable projector: power 0, "Not reachable", named in the status', async (t) => {
  const { gladys, fake, app } = await setup(t, { fakeOptions: { power: '1' } });
  const device = await createDevice(gladys);
  await fake.close();
  await app.poll();
  await app.updateStatus();
  assert.equal(gladys.fake.lastState(id('power')), 0);
  assert.equal(gladys.fake.lastState(id('power_status')), 'Not reachable');
  assert.match(gladys.fake.connectionStatus.message.en, /Not reachable.*JVC B5A2/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing sent/);
});

test('another projector at the address: the old one loses it, never commanded there', async (t) => {
  const { gladys, fake, app } = await setup(t, { fakeOptions: { power: '1' } });
  const device = await createDevice(gladys);
  await fake.close();
  await app.poll();
  // The same port, another projector.
  const other = await startFakeProjector({ mac: 'AABBCCDDEEFF', power: '1' });
  t.after(() => other.close());
  app.data.projectors[MAC_ID].port = other.port;
  await app.poll();
  assert.equal(app.data.projectors[MAC_ID].host, '');
  const ack = await press(gladys, device, 'standby');
  assert.equal(ack.success, false);
  assert.match(ack.error, /address unknown/);
  assert.equal(other.ops().length, 0);
});

test('a reconnection to Gladys publishes the status and the devices again, without asking sooner', async (t) => {
  const { gladys, fake } = await setup(t, { fakeOptions: { power: '1' } });
  await createDevice(gladys);
  const statuses = gladys.fake.connectionStatuses.length;
  const connections = fake.connections;
  await gladys.disconnect();
  await gladys.connect();
  await waitFor(() => gladys.fake.connectionStatuses.length > statuses, 'the status again');
  assert.equal(fake.connections, connections, 'no projector asked because of it');
});

test('not a JVC projector: nothing remembered', async (t) => {
  const { gladys, app } = await setup(t, { fakeOptions: { mode: 'garbage' } });
  await settle(50);
  assert.equal(app.projectors.length, 0);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('a projector flooding bytes is cut at 512 bytes', async (t) => {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write('PJ_OK');
    socket.once('data', () => {
      socket.write('PJACK');
      socket.write(Buffer.alloc(4096, 0x41));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { addresses: `127.0.0.1:${server.address().port}` },
  });
  const app = new JvcApp({
    gladys,
    logger: QUIET,
    store: new MemoryStore(),
    timers,
    timings: FAST,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  assert.equal(app.projectors.length, 0);
  assert.equal(app.probeErrors.get(`127.0.0.1:${server.address().port}`), 'protocol');
});

test('"Check the projectors" reads each projector', async (t) => {
  const { gladys } = await setup(t, { fakeOptions: { power: '1' } });
  await discovered(gladys);
  const ack = await gladys.fake.action('check_projectors');
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /JVC B5A2 \(127\.0\.0\.1:\d+\): on, 1234 h of light/);
  assert.match(ack.data.message.fr, /allumé, 1234 h d'éclairage/);
});

test('/data keeps the projectors and the picture modes; a restart starts from them', async (t) => {
  const store = new MemoryStore();
  const { gladys, fake, app } = await setup(t, { fakeOptions: { power: '1' }, store });
  await discovered(gladys);
  await app.stop();
  const saved = store.data.projectors[MAC_ID];
  assert.equal(saved.model, 'B5A2');
  assert.equal(saved.port, fake.port);
  assert.ok(saved.pictureOptions.some((o) => o.value === 'film'));
  assert.equal(Object.getPrototypeOf(app.data.projectors), null);
});

// --- Review 1 ------------------------------------------------------------------------

/** A server that greets, answers the first request with PJNAK, then `after(socket)`. */
async function nakServer(t, after) {
  const server = net.createServer((socket) => {
    server.requests += 1;
    socket.on('error', () => {});
    socket.write('PJ_OK');
    socket.once('data', () => after(socket));
  });
  server.requests = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

test('I1 standby pressed during the slow ack of an input change goes out at once', async (t) => {
  const { gladys, fake } = await setup(t, {
    fakeOptions: { power: '1', opAck: { IP: 'never' } },
    timings: { slowAckTimeout: 2_500 },
  });
  const device = await createDevice(gladys);
  const input = press(gladys, device, 'input', 'hdmi2');
  await waitFor(() => fake.ops().length === 1, 'the input frame');
  await settle(100);
  const started = Date.now();
  const standby = await press(gladys, device, 'standby');
  assert.equal(standby.success, true, standby.error);
  assert.ok(Date.now() - started < FAST.commandBudget + 200);
  assert.deepEqual(fake.ops().at(-1), { kind: 'op', code: 'PW', value: '0' });
  const inputAck = await input;
  assert.equal(inputAck.success, false);
  assert.match(inputAck.error, /Sent, without confirmation/);
});

test('I1 standby closes a background read instead of waiting behind it', async (t) => {
  const { gladys, fake, app } = await setup(t, { fakeOptions: { power: '1' } });
  const device = await createDevice(gladys);
  fake.refSilent = { SC: 'never' };
  const round = app.poll();
  await waitFor(() => fake.received.filter((r) => r.code === 'SC').length > 0, 'a stuck read');
  fake.refSilent = {};
  const standby = await press(gladys, device, 'standby');
  assert.equal(standby.success, true, standby.error);
  assert.deepEqual(fake.ops().at(-1), { kind: 'op', code: 'PW', value: '0' });
  await round;
});

test('I2 a deferred standby keeps one chain, whatever the rounds', async (t) => {
  const { gladys, fake, app } = await setup(t, {
    fakeOptions: { power: '0', warmMs: 2_500 },
    timings: { deferredStep: 200, deferredStandby: 10_000 },
  });
  const device = await createDevice(gladys);
  await press(gladys, device, 'power_on');
  await waitFor(() => fake.power === '3', 'warming up');
  await press(gladys, device, 'standby');
  const reads = () => fake.received.filter((r) => r.code === 'PW' && r.kind === 'ref').length;
  const before = reads();
  const start = Date.now();
  for (let i = 0; i < 6; i += 1) {
    await app.poll();
    await settle(50);
  }
  await settle(1_200 - (Date.now() - start));
  // 6 rounds + one chain at 200 ms (+ the recheck of Power on): about 13.
  assert.ok(reads() - before <= 15, `${reads() - before} reads`);
});

test('I3 a failed read while warming up keeps the deferred standby', async (t) => {
  const { gladys, fake } = await setup(t, {
    fakeOptions: { power: '0', warmMs: 1_000 },
    timings: { deferredStep: 100, deferredStandby: 5_000 },
  });
  const device = await createDevice(gladys);
  await press(gladys, device, 'power_on');
  await waitFor(() => fake.power === '3', 'warming up');
  await press(gladys, device, 'standby');
  fake.mode = 'busy';
  await settle(250);
  fake.mode = 'ok';
  await waitFor(
    () => fake.ops().some((o) => o.code === 'PW' && o.value === '0'),
    'the deferred standby',
    4_000,
  );
});

for (const [name, after] of [
  ['closed', (socket) => socket.end('PJNAK')],
  ['silent', (socket) => socket.write('PJNAK')],
]) {
  test(`I4 PJNAK then ${name}: a refusal, persisted, never sent again`, async (t) => {
    const server = await nakServer(t, after);
    const key = `127.0.0.1:${server.address().port}`;
    const store = new MemoryStore();
    const gladys = createFakeGladys({
      selector: SELECTOR,
      config: { addresses: key, password: 'wrong' },
    });
    const app = new JvcApp({ gladys, logger: QUIET, store, timers, timings: FAST });
    registerHandlers(gladys, app);
    t.after(() => app.stop());
    await gladys.connect();
    await waitFor(() => Object.hasOwn(app.data.authRefused, key), 'the refusal');
    assert.equal(app.probeErrors.get(key), 'auth');
    const sent = server.requests;
    for (let i = 0; i < 3; i += 1) {
      app.probes.clear();
      await app.tick();
    }
    assert.equal(server.requests, sent, 'not tried again before 30 minutes');
    await settle(30);
    assert.ok(store.data.authRefused[key] > Date.now() + 29 * 60_000);
    assert.equal(gladys.fake.connectionStatus.connected, false);
  });
}

test('I5 another projector at the address between two rounds: nothing published for it, nothing sent', async (t) => {
  const { gladys, app } = await setup(t, { fakeOptions: { power: '1' } });
  await createDevice(gladys);
  const other = await startFakeProjector({ mac: 'AABBCCDDEEFF', power: '0' });
  t.after(() => other.close());
  // No "not reachable" round in between.
  app.data.projectors[MAC_ID].port = other.port;
  await app.poll();
  assert.equal(gladys.fake.lastState(id('power_status')), 'Not reachable');
  assert.ok(!gladys.fake.states.some((s) => s.text === 'Standby'));
  assert.equal(app.data.projectors[MAC_ID].host, '');
  assert.equal(other.ops().length, 0);
});

test('I5 a command checks the MAC in its own session', async (t) => {
  const { gladys, app } = await setup(t, { fakeOptions: { power: '1' } });
  const device = await createDevice(gladys);
  const other = await startFakeProjector({ mac: 'AABBCCDDEEFF', power: '0' });
  t.after(() => other.close());
  app.data.projectors[MAC_ID].port = other.port;
  for (const key of ['power_on', 'standby']) {
    const ack = await press(gladys, device, key);
    assert.equal(ack.success, false, key);
    assert.match(ack.error, /another projector answers at its address|address unknown/);
    assert.match(ack.error, /nothing sent/);
  }
  assert.equal(other.ops().length, 0);
  assert.equal(app.data.projectors[MAC_ID].host, '');
});

test('M1 a reconnection keeps the round timer; M2 two starts load /data once', async (t) => {
  const fake = await startFakeProjector({ power: '1' });
  t.after(() => fake.close());
  let intervals = 0;
  const counting = { ...timers, setInterval: () => (intervals += 1) };
  const gladys = createFakeGladys({ selector: SELECTOR, config: {} });
  let loads = 0;
  const store = new MemoryStore();
  const load = store.load.bind(store);
  store.load = async (options) => {
    loads += 1;
    await settle(20);
    return load(options);
  };
  const app = new JvcApp({ gladys, logger: QUIET, store, timers: counting, timings: FAST });
  t.after(() => app.stop());
  const config = { addresses: `127.0.0.1:${fake.port}` };
  await Promise.all([app.start(config, { connected: true }), app.start(config, { saved: true })]);
  assert.equal(loads, 1);
  assert.equal(app.projectors.length, 1, 'the projector found is kept');
  await app.start(config, { connected: true });
  await app.start(config, { connected: true });
  assert.equal(intervals, 1, 'the timer is not restarted');
  await app.start({ ...config, poll_interval: 60 }, { saved: true });
  assert.equal(intervals, 2, 'a new interval restarts it');
});

test('M5 a refusal for an address no longer in use is forgotten', async (t) => {
  const store = new MemoryStore();
  store.data.authRefused = { '10.9.9.9': Date.now() + 60_000 };
  const { gladys } = await setup(t, { fakeOptions: { power: '1' }, store });
  await discovered(gladys);
  await waitFor(() => gladys.fake.connectionStatus?.connected === true, 'connected');
  await settle(30);
  assert.deepEqual(store.data.authRefused, {});
});
