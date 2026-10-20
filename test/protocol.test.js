// -----------------------------------------------------------------------------
// The protocol port (pure): frames, answers, authentication payloads, model
// matching and picture modes, checked against pyjvcprojector 2.1.0.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  PICTURE_MODE_LABELS,
  SPECS,
  answerValue,
  authPayloads,
  isAck,
  matchModel,
  offeredPictureModes,
  opFrame,
  parseInput,
  parseLightTime,
  parseMac,
  parseModel,
  parsePower,
  parseSignal,
  pictureModes,
  refFrame,
  requestFrame,
} from '../src/jvc/protocol.js';

const bytes = (...parts) =>
  Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
  );

test('frames as pyjvcprojector writes them', () => {
  assert.deepEqual(refFrame('PW'), bytes('?', [0x89, 0x01], 'PW\n'));
  assert.deepEqual(opFrame('PW', '1'), bytes('!', [0x89, 0x01], 'PW1\n'));
  assert.deepEqual(opFrame('RC', '732E'), bytes('!', [0x89, 0x01], 'RC732E\n'));
  assert.deepEqual(refFrame('PMPM'), bytes('?', [0x89, 0x01], 'PMPM\n'));
});

test('acks and answers: the header of the code, a bounded printable value', () => {
  assert.ok(isAck(bytes([0x06, 0x89, 0x01], 'PW\n'), 'PW'));
  assert.ok(isAck(bytes([0x06, 0x89, 0x01], 'PM\n'), 'PMPM'));
  assert.ok(!isAck(bytes([0x06, 0x89, 0x01], 'IP\n'), 'PW'));
  assert.ok(!isAck(bytes('@', [0x89, 0x01], 'PW\n'), 'PW'));
  assert.equal(answerValue(bytes('@', [0x89, 0x01], 'PW1\n'), 'PW'), '1');
  assert.equal(answerValue(bytes('@', [0x89, 0x01], 'PM03\n'), 'PMPM'), '03');
  assert.equal(answerValue(bytes('@', [0x89, 0x01], 'IP6\n'), 'PW'), undefined);
  assert.equal(answerValue(bytes('@', [0x89, 0x01], 'PW', [0x00], '\n'), 'PW'), undefined);
  assert.equal(answerValue(bytes('@', [0x89, 0x01], 'PW', 'x'.repeat(65), '\n'), 'PW'), undefined);
  assert.equal(answerValue(bytes('@', [0x89, 0x01], 'P'), 'PW'), undefined);
});

test('authentication payloads: padded plain form, SHA-256 of password + JVCKWPJ', () => {
  const { plain, hashed } = authPayloads('abcd1234');
  assert.equal(plain.length, 16);
  assert.deepEqual(plain.subarray(0, 8), Buffer.from('abcd1234'));
  assert.ok(plain.subarray(8).every((b) => b === 0));
  assert.equal(
    hashed.toString('ascii'),
    createHash('sha256').update('abcd1234JVCKWPJ').digest('hex'),
  );
  assert.equal(authPayloads('x'.repeat(20)).plain.length, 20);
  assert.equal(requestFrame(Buffer.alloc(0)).toString(), 'PJREQ');
  assert.equal(requestFrame(Buffer.from('ab')).toString(), 'PJREQ_ab');
  assert.equal(authPayloads('').plain.length, 0);
});

test('answers parsed strictly', () => {
  assert.deepEqual(['0', '1', '2', '3', '4', '5', ''].map(parsePower), [
    'standby',
    'on',
    'cooling',
    'warming',
    'error',
    undefined,
    undefined,
  ]);
  assert.equal(parsePower('__proto__'), undefined);
  assert.deepEqual(['6', '7', '0'].map(parseInput), ['hdmi1', 'hdmi2', undefined]);
  assert.deepEqual(['1', '0', 'x'].map(parseSignal), [true, false, undefined]);
  assert.equal(parseLightTime('04D2'), 1234);
  assert.equal(parseLightTime('zz'), undefined);
  assert.equal(parseLightTime('123456789'), undefined);
  assert.equal(parseModel('ILAFPJ -- B5A2'), 'B5A2');
  assert.equal(parseModel('ILAFPJ -- XHP1'), 'XHP1');
  assert.equal(parseModel('ILAFPJ -- <script>'), undefined);
  assert.equal(parseMac('E0DADC0A1562'), 'e0dadc0a1562');
  assert.equal(parseMac('E0-DA-DC-0A-15-62'), 'e0dadc0a1562');
  assert.equal(parseMac('E0DADC0A15'), undefined);
  assert.equal(parseMac('__proto__'), undefined);
});

test('models: exact name, then the first 3 characters, else none', () => {
  assert.deepEqual(matchModel('B5A2'), {
    spec: 'CS20221',
    model: 'B5A2',
    products: 'RS3100, NZ8, N98, V80R',
    exact: true,
  });
  assert.equal(matchModel('A2B1').model, 'B2A1');
  assert.equal(matchModel('B5A9').model, 'B5A3', 'prefix match, first in order');
  assert.equal(matchModel('B5A9').exact, false);
  assert.equal(matchModel('ZZZZ'), undefined);
  assert.equal(matchModel(''), undefined);
  assert.equal(SPECS.length, 10);
});

test('picture modes follow the model', () => {
  const b5a2 = offeredPictureModes('B5A2').map((m) => m.value);
  const b5a3 = offeredPictureModes('B5A3').map((m) => m.value);
  assert.ok(b5a2.includes('film'));
  assert.ok(!b5a3.includes('film'), 'Film is B5A1 / B5A2 only');
  assert.deepEqual(offeredPictureModes('B5A2')[0], { value: 'film', code: '00', label: 'Film' });
  // In code order, "0B" before "10".
  const codes = offeredPictureModes('B8A1').map((m) => m.code);
  assert.deepEqual(
    codes,
    [...codes].sort((a, b) => parseInt(a, 16) - parseInt(b, 16)),
  );
  assert.ok(codes.includes('10') && codes.includes('0B'));
  // CS20141 reads "4k" but never writes it; "reserved" is never offered.
  assert.ok(pictureModes('XHK3').some((m) => m.value === '4k'));
  assert.ok(!offeredPictureModes('XHK3').some((m) => m.value === '4k'));
  assert.ok(pictureModes('XHE').some((m) => m.value === 'reserved'));
  assert.ok(!offeredPictureModes('XHE').some((m) => m.value === 'reserved'));
  assert.deepEqual(offeredPictureModes('ZZZZ'), [], 'unknown model: no picture mode');
  for (const spec of SPECS) {
    for (const model of spec.models) {
      for (const mode of pictureModes(model.name)) {
        assert.ok(PICTURE_MODE_LABELS[mode.value], `${mode.value} has a label`);
        assert.match(mode.code, /^[0-9A-F]{2}$/);
      }
    }
  }
});
