import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, parseAddress, parsePassword, parsePollInterval } from '../src/config.js';
import { sanitizeData } from '../src/store.js';

test('addresses: IPv4 or host name, optional port, 20554 by default', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 20554 });
  assert.deepEqual(parseAddress(' Projector.local:2000 '), { host: 'projector.local', port: 2000 });
  assert.deepEqual(parseAddress('tcp://10.0.0.2:20554/'), { host: '10.0.0.2', port: 20554 });
  for (const bad of ['', '999.1.1.1', '1.2.3', 'a b', 'host:0', 'host:70000', '-x.local']) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
  const config = normalizeConfig({ addresses: '192.168.1.50, nope!, 192.168.1.50;10.0.0.3:2000' });
  assert.deepEqual(config.addresses, [
    { host: '192.168.1.50', port: 20554 },
    { host: '10.0.0.3', port: 2000 },
  ]);
  assert.deepEqual(config.invalid, ['nope!']);
});

test('refresh interval: 10 to 300 s, 15 by default', () => {
  assert.equal(parsePollInterval(undefined), 15);
  assert.equal(parsePollInterval(''), 15);
  assert.equal(parsePollInterval(true), 15);
  assert.equal(parsePollInterval('2'), 10);
  assert.equal(parsePollInterval(9999), 300);
  assert.equal(parsePollInterval('30'), 30);
});

test('password: kept as typed, refused (never echoed) when unusable', () => {
  assert.deepEqual(parsePassword(undefined), { password: '', passwordInvalid: false });
  assert.deepEqual(parsePassword('abc 123'), { password: 'abc 123', passwordInvalid: false });
  assert.deepEqual(parsePassword(12345678), { password: '12345678', passwordInvalid: false });
  assert.deepEqual(parsePassword('a\nb'), { password: '', passwordInvalid: true });
  assert.deepEqual(parsePassword('x'.repeat(65)), { password: '', passwordInvalid: true });
  assert.deepEqual(parsePassword({}), { password: '', passwordInvalid: true });
});

test('/data read back: only MAC keys, no prototype, refusals capped', () => {
  const now = 1_000_000;
  const data = sanitizeData(
    JSON.parse(
      '{"projectors":{"__proto__":{"mac":"__proto__"},"e0dadc0a1562":{"mac":"e0dadc0a1562","host":"10.0.0.2","port":20554,"model":"B5A2","pictureOptions":[{"value":"film","label":"Film"},{"value":"__proto__","label":"x"},{"value":"<b>","label":"y"}]},"E0DADC0A1563":{"mac":"E0DADC0A1563"}},"authRefused":{"10.0.0.2":99999999999,"bad key!":5}}',
    ),
    { now, maxDelay: 1_800_000 },
  );
  assert.deepEqual(Object.keys(data.projectors), ['e0dadc0a1562']);
  assert.equal(Object.getPrototypeOf(data.projectors), null);
  assert.deepEqual(data.projectors.e0dadc0a1562.pictureOptions, [{ value: 'film', label: 'Film' }]);
  assert.deepEqual({ ...data.authRefused }, { '10.0.0.2': now + 1_800_000 });
  assert.deepEqual(Object.keys(sanitizeData('nope').projectors), []);
});
