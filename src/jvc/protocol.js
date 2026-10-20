// -----------------------------------------------------------------------------
// The JVC D-ILA network protocol (TCP 20554), pure: frames, the handshake
// strings, the model specifications and the value maps of the commands this
// integration uses. Ported from pyjvcprojector 2.1.0 (MIT, Steve Easley,
// jvcprojector/device.py, command/base.py and command/command.py): see
// THIRD_PARTY_NOTICES.md.
//
// A reference command reads a value:   "?" 0x89 0x01 <code> "\n"
//   ack:      0x06 0x89 0x01 <code[0..2]> "\n"
//   answer:   "@"  0x89 0x01 <code[0..2]> <value> "\n"
// An operation command sets a value:   "!" 0x89 0x01 <code> <value> "\n"
//   ack:      0x06 0x89 0x01 <code[0..2]> "\n"
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export const DEFAULT_PORT = 20554;

export const HANDSHAKE = Object.freeze({
  OK: 'PJ_OK',
  NG: 'PJ_NG',
  REQ: 'PJREQ',
  ACK: 'PJACK',
  NAK: 'PJNAK',
});

const UNIT_ID = Buffer.from([0x89, 0x01]);
const HEAD_OP = Buffer.concat([Buffer.from('!'), UNIT_ID]);
const HEAD_REF = Buffer.concat([Buffer.from('?'), UNIT_ID]);
const HEAD_RES = Buffer.concat([Buffer.from('@'), UNIT_ID]);
const HEAD_ACK = Buffer.concat([Buffer.from([0x06]), UNIT_ID]);
const END = Buffer.from('\n');
const HEAD_LEN = 3;

/** The salt of the SHA-256 authentication of the recent models. */
const AUTH_SALT = 'JVCKWPJ';

/** The command codes used here (ASCII). */
export const CODES = Object.freeze({
  MODEL: 'MD',
  MAC: 'LSMA',
  POWER: 'PW',
  INPUT: 'IP',
  SIGNAL: 'SC',
  LIGHT_TIME: 'IFLT',
  REMOTE: 'RC',
  PICTURE_MODE: 'PMPM',
});

/** Longest value accepted in an answer: the protocol's values are a few characters. */
export const MAX_VALUE = 64;

export function refFrame(code) {
  return Buffer.concat([HEAD_REF, Buffer.from(code, 'ascii'), END]);
}

export function opFrame(code, value) {
  return Buffer.concat([HEAD_OP, Buffer.from(code, 'ascii'), Buffer.from(value, 'ascii'), END]);
}

/** Whether `line` (with its "\n") is the ack of `code`. */
export function isAck(line, code) {
  const expected = Buffer.concat([HEAD_ACK, Buffer.from(code.slice(0, 2), 'ascii')]);
  return line.length >= expected.length && line.subarray(0, expected.length).equals(expected);
}

/**
 * The value of the answer `line` (with its "\n") to `code`, or undefined when
 * it is not one: wrong header, too long, or not printable ASCII.
 */
export function answerValue(line, code) {
  const expected = Buffer.concat([HEAD_RES, Buffer.from(code.slice(0, 2), 'ascii')]);
  if (line.length < expected.length + 1 || !line.subarray(0, expected.length).equals(expected)) {
    return undefined;
  }
  const value = line.subarray(HEAD_LEN + 2, line.length - 1);
  if (value.length > MAX_VALUE) {
    return undefined;
  }
  for (const byte of value) {
    if (byte < 0x20 || byte > 0x7e) {
      return undefined;
    }
  }
  return value.toString('ascii');
}

/**
 * The two authentication payloads of a password, as pyjvcprojector builds
 * them: the password padded with NUL bytes to 16 bytes (older models), and the
 * SHA-256 hex digest of password + "JVCKWPJ" (recent models). Never logged.
 */
export function authPayloads(password) {
  if (!password) {
    return { plain: Buffer.alloc(0), hashed: Buffer.alloc(0) };
  }
  const bytes = Buffer.from(password, 'utf8');
  const plain = Buffer.alloc(Math.max(16, bytes.length));
  bytes.copy(plain);
  const hashed = Buffer.from(
    createHash('sha256').update(`${password}${AUTH_SALT}`, 'utf8').digest('hex'),
    'ascii',
  );
  return { plain, hashed };
}

/** The request line of the handshake: "PJREQ", or "PJREQ_" + the authentication. */
export function requestFrame(auth) {
  return auth.length > 0
    ? Buffer.concat([Buffer.from(`${HANDSHAKE.REQ}_`, 'ascii'), auth])
    : Buffer.from(HANDSHAKE.REQ, 'ascii');
}

// --- Answers -------------------------------------------------------------------

export const POWER = Object.freeze({
  STANDBY: 'standby',
  ON: 'on',
  COOLING: 'cooling',
  WARMING: 'warming',
  ERROR: 'error',
});

const POWER_READ = Object.freeze({
  0: POWER.STANDBY,
  1: POWER.ON,
  2: POWER.COOLING,
  3: POWER.WARMING,
  4: POWER.ERROR,
});

export const POWER_WRITE = Object.freeze({ on: '1', off: '0' });

/** `PW` answer -> power state, or undefined. */
export const parsePower = (value) =>
  Object.hasOwn(POWER_READ, value) ? POWER_READ[value] : undefined;

/** The inputs of `IP`: HDMI 1 and HDMI 2 (the only ones pyjvcprojector maps). */
export const INPUTS = Object.freeze([
  { value: 'hdmi1', code: '6', label: 'HDMI 1' },
  { value: 'hdmi2', code: '7', label: 'HDMI 2' },
]);

export const parseInput = (value) => INPUTS.find((i) => i.code === value)?.value;

/** `SC` answer -> true (signal), false (none), undefined. */
export const parseSignal = (value) => (value === '1' ? true : value === '0' ? false : undefined);

/** `IFLT` answer (hexadecimal hours) -> integer hours, or undefined. */
export function parseLightTime(value) {
  if (typeof value !== 'string' || !/^[0-9A-Fa-f]{1,8}$/.test(value)) {
    return undefined;
  }
  return Number.parseInt(value, 16);
}

/** `MD` answer ("ILAFPJ -- B5A2") -> model code ("B5A2"), or undefined. */
export function parseModel(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const model = value
    .replace(/^ILAFPJ\W+/, '')
    .trim()
    .toUpperCase();
  return /^[A-Z0-9-]{1,16}$/.test(model) ? model : undefined;
}

/** `LSMA` answer -> MAC address as 12 lowercase hexadecimal digits, or undefined. */
export function parseMac(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const hex = value.replace(/[\s:-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(hex)) {
    return undefined;
  }
  // All zeros, broadcast or multicast: no identity (two projectors would share it).
  if (hex === '000000000000' || (Number.parseInt(hex.slice(0, 2), 16) & 1) === 1) {
    return undefined;
  }
  return hex;
}

// --- Remote keys -------------------------------------------------------------------

/** `RC` codes, from pyjvcprojector (`Remote`), in the order Home Assistant lists them. */
export const REMOTE_KEYS = Object.freeze([
  { value: 'menu', code: '732E', label: 'Menu' },
  { value: 'up', code: '7301', label: 'Up' },
  { value: 'down', code: '7302', label: 'Down' },
  { value: 'left', code: '7336', label: 'Left' },
  { value: 'right', code: '7334', label: 'Right' },
  { value: 'ok', code: '732F', label: 'OK' },
  { value: 'back', code: '7303', label: 'Back' },
  { value: 'mpc', code: '73F0', label: 'MPC' },
  { value: 'hide', code: '731D', label: 'Hide' },
  { value: 'info', code: '7374', label: 'Info' },
  { value: 'input', code: '7308', label: 'Input' },
  { value: 'cmd', code: '738A', label: 'CMD' },
  { value: 'advanced-menu', code: '7373', label: 'Advanced menu' },
  { value: 'picture-mode', code: '73F4', label: 'Picture mode' },
  { value: 'color-profile', code: '7388', label: 'Colour profile' },
  { value: 'lens-control', code: '7330', label: 'Lens control' },
  { value: 'setting-memory', code: '73D4', label: 'Setting memory' },
  { value: 'gamma-settings', code: '73F5', label: 'Gamma settings' },
  { value: 'hdmi1', code: '7370', label: 'HDMI 1' },
  { value: 'hdmi2', code: '7371', label: 'HDMI 2' },
  { value: 'mode-1', code: '73D8', label: 'Mode 1' },
  { value: 'mode-2', code: '73D9', label: 'Mode 2' },
  { value: 'mode-3', code: '73DA', label: 'Mode 3' },
  { value: 'mode-4', code: '73E5', label: 'Mode 4' },
  { value: 'mode-5', code: '73E6', label: 'Mode 5' },
  { value: 'mode-6', code: '73E7', label: 'Mode 6' },
  { value: 'mode-7', code: '73E8', label: 'Mode 7' },
  { value: 'mode-8', code: '73E9', label: 'Mode 8' },
  { value: 'mode-9', code: '73EA', label: 'Mode 9' },
  { value: 'mode-10', code: '73EB', label: 'Mode 10' },
  { value: 'gamma', code: '7375', label: 'Gamma' },
  { value: 'natural', code: '736A', label: 'Natural' },
  { value: 'cinema', code: '7368', label: 'Cinema' },
  { value: 'color-temp', code: '7376', label: 'Colour temperature' },
  { value: 'anamorphic', code: '73C5', label: 'Anamorphic' },
  { value: 'lens-aperture', code: '7320', label: 'Lens aperture' },
  { value: '3d-format', code: '73D6', label: '3D format' },
]);

// --- Models and picture modes -------------------------------------------------------

/**
 * The specifications, in pyjvcprojector's matching order. A model code is a
 * family: `products` names the projectors that report it.
 */
export const SPECS = Object.freeze([
  {
    name: 'CS20241',
    models: [
      { name: 'B8A2', names: ['B8A2'], products: 'RS3200, NZ800, N988, V800R' },
      { name: 'B8A1', names: ['B8A1'], products: 'RS4200, NZ900, N1188, V900R' },
    ],
  },
  {
    name: 'CS20242',
    models: [
      { name: 'D8A2', names: ['D8A2'], products: 'NZ500, RS1200, N799, N788, N700, Z5' },
      { name: 'D8A1', names: ['D8A1'], products: 'NZ700, RS2200, N899, N888, N800, Z7' },
    ],
  },
  {
    name: 'CS20221',
    models: [
      { name: 'B5A3', names: ['B5A3'], products: 'RS2100, NZ7, N88, V70R' },
      { name: 'B5A2', names: ['B5A2'], products: 'RS3100, NZ8, N98, V80R' },
      { name: 'B5A1', names: ['B5A1'], products: 'RS4100, NZ9, N11, V90R' },
      { name: 'B5B1', names: ['B5B1'], products: 'RS1100, NP5, N78, V50' },
    ],
  },
  {
    name: 'CS20191',
    models: [
      { name: 'B2A3', names: ['B2A3', 'A2B3'], products: 'RS1000, NX5, N5, N6, V5' },
      { name: 'B2A2', names: ['B2A2', 'A2B2'], products: 'RS2000, NX7, N7, N8, V7' },
      { name: 'B2A1', names: ['B2A1', 'A2B1'], products: 'RS3000, NX9, NX11, V9R' },
    ],
  },
  { name: 'CS20172', models: [{ name: 'A0A0', names: ['A0A0'], products: 'Z1, RS4500' }] },
  {
    name: 'CS20171',
    models: [
      { name: 'XHR1', names: ['XHR1', 'XHS1'], products: 'X570R, RS420, X590R, RS440' },
      {
        name: 'XHR3',
        names: ['XHR3', 'XHS3'],
        products: 'X770R, X970, X970R, RS520, RS620, X790R, X990R, RS540, RS640',
      },
    ],
  },
  {
    name: 'CS20161',
    models: [
      { name: 'XHP1', names: ['XHP1'], products: 'X550R, X5000, XC5890R, RS400' },
      { name: 'XHP2', names: ['XHP2'], products: 'XC6890, XC6890R' },
      {
        name: 'XHP3',
        names: ['XHP3'],
        products: 'X750R, X7000, XC7890R, RS500, X950R, X9000, RS600, PX1',
      },
    ],
  },
  {
    name: 'CS20141',
    models: [
      { name: 'XHK1', names: ['XHK1'], products: 'X500R, XC5880R, RS49' },
      { name: 'XHK2', names: ['XHK2'], products: 'RS4910' },
      {
        name: 'XHK3',
        names: ['XHK3'],
        products: 'X700R, X7880R, XC7880R, RS57, X900R, RS67, RS6710',
      },
    ],
  },
  {
    name: 'CS20131',
    models: [
      { name: 'XHG1', names: ['XHG1'], products: 'X35, XC3800, RS46, RS4810' },
      { name: 'XHH1', names: ['XHH1'], products: 'X55R, XC5800R, RS48' },
      { name: 'XHH4', names: ['XHH4'], products: 'X75R, XC7800R, RS56, X95R, XC9800R, RS66' },
    ],
  },
  {
    name: 'CS20121',
    models: [
      { name: 'XHE', names: ['XHE'], products: 'X30, XC388, RS45, RS4800' },
      { name: 'XHF', names: ['XHF'], products: 'X70R, XC788R, RS55, X90R, XC988R, RS65' },
    ],
  },
]);

/**
 * The specification and model of a model code: an exact name first, then the
 * first 3 characters (as pyjvcprojector), else undefined ("limp mode": no
 * picture mode).
 */
export function matchModel(code) {
  if (typeof code !== 'string' || code === '') {
    return undefined;
  }
  for (const spec of SPECS) {
    const model = spec.models.find((m) => m.names.includes(code));
    if (model) {
      return { spec: spec.name, model: model.name, products: model.products, exact: true };
    }
  }
  for (const spec of SPECS) {
    const model = spec.models.find((m) => m.names.some((n) => n.slice(0, 3) === code.slice(0, 3)));
    if (model) {
      return { spec: spec.name, model: model.name, products: model.products, exact: false };
    }
  }
  return undefined;
}

/**
 * `PMPM` codes per specification. A value [name, ...models] exists only on
 * those models (pyjvcprojector's tuples). CS20141 reads and writes the same
 * map.
 */
const PICTURE_MODES = Object.freeze({
  CS20241: {
    '00': 'film',
    '01': 'cinema',
    '03': 'natural',
    '04': 'hdr10',
    '0B': 'frame-adapt-hdr',
    '0C': 'user-1',
    '0D': 'user-2',
    '0E': 'user-3',
    '0F': 'user-4',
    10: 'user-5',
    11: 'user-6',
    14: 'hlg',
    15: 'hdr10+',
    17: 'filmmaker-mode',
    18: 'frame-adapt-hdr2',
    19: 'frame-adapt-hdr3',
    '1B': 'vivid',
    '1C': 'natural-ll',
    '1D': 'hdr10-ll',
    '1E': 'hlg-ll',
  },
  CS20242: {
    '01': 'cinema',
    '03': 'natural',
    '0B': 'frame-adapt-hdr',
    '0C': 'sdr-1',
    '0D': 'sdr-2',
    '0E': 'hdr1',
    '0F': 'hdr2',
    14: 'hlg',
    15: 'hdr10+',
    17: 'filmmaker-mode',
    18: 'frame-adapt-hdr2',
    '1B': 'vivid',
  },
  CS20221: {
    '00': ['film', 'B5A1', 'B5A2'],
    '01': 'cinema',
    '03': 'natural',
    '04': 'hdr10',
    '0B': 'frame-adapt-hdr',
    '0C': 'user-1',
    '0D': 'user-2',
    '0E': 'user-3',
    '0F': 'user-4',
    10: 'user-5',
    11: 'user-6',
    14: 'hlg',
    15: 'hdr10+',
    16: 'pana-pq',
    17: 'filmmaker-mode',
    18: 'frame-adapt-hdr2',
    19: 'frame-adapt-hdr3',
  },
  CS20191: {
    '00': ['film', 'B2A1', 'B2A2'],
    '01': 'cinema',
    '03': 'natural',
    '04': 'hdr10',
    '06': ['thx', 'B2A1'],
    '0B': 'frame-adapt-hdr',
    '0C': 'user-1',
    '0D': 'user-2',
    '0E': 'user-3',
    '0F': 'user-4',
    10: 'user-5',
    11: 'user-6',
    14: 'hlg',
    16: 'pana-pq',
  },
  CS20172: {
    '00': 'film',
    '01': 'cinema',
    '03': 'natural',
    '04': 'hdr',
    '06': 'thx',
    '0C': 'user-1',
    '0D': 'user-2',
    '0E': 'user-3',
    '0F': 'user-4',
    10: 'user-5',
    11: 'user-6',
  },
  CS20171: {
    '00': ['film', 'XHR3'],
    '01': 'cinema',
    '02': 'animation',
    '03': 'natural',
    '04': 'hdr',
    '06': ['thx', 'XHR3'],
    '0C': 'user-1',
    '0D': 'user-2',
    '0E': 'user-3',
    '0F': 'user-4',
    10: 'user-5',
  },
  CS20161: {
    '00': ['film', 'XHP3'],
    '01': 'cinema',
    '02': 'animation',
    '03': 'natural',
    '06': ['thx', 'XHP3'],
    '0C': 'user-1',
    '0D': 'user-2',
    '0E': 'user-3',
    '0F': 'user-4',
    10: 'user-5',
    11: 'user-6',
  },
  CS20141: {
    '00': ['film', 'XHK3'],
    '01': 'cinema',
    '02': 'animation',
    '03': 'natural',
    '04': 'stage',
    '06': ['thx', 'XHK3'],
    '0B': '4k',
    '0C': 'user-1',
    '0D': 'user-2',
    '0E': 'user-3',
    '0F': 'user-4',
    12: ['photo', 'XHK3'],
  },
  CS20131: {
    '00': 'film',
    '01': 'cinema',
    '02': 'animation',
    '03': 'natural',
    '04': 'stage',
    '05': 'reserved',
    '06': 'thx',
    '07': ['isf-day', 'XHH4'],
    '08': ['isf-night', 'XHH4'],
    '09': ['thx-bright', 'XHH4'],
    '0A': ['thx-dark', 'XHH4'],
    '0B': '3d',
    '0C': 'user-1',
    '0D': 'user-2',
    '0E': 'user-3',
    '0F': 'user-4',
    10: 'user-5',
  },
  CS20121: {
    '00': 'film',
    '01': 'cinema',
    '02': 'animation',
    '03': 'natural',
    '04': 'stage',
    '05': 'reserved',
    '06': 'thx',
    '07': ['isf-day', 'XHF'],
    '08': ['isf-night', 'XHF'],
    '09': ['thx-bright', 'XHF'],
    '0A': ['thx-dark', 'XHF'],
    '0B': '3d',
    '0C': 'user-1',
    '0D': 'user-2',
    '0E': 'user-3',
    '0F': 'user-4',
    10: 'user-5',
  },
});

/** Read like pyjvcprojector, never offered in the dropdown: "reserved" is no mode. */
const NOT_OFFERED = new Set(['reserved']);

/** Codes pyjvcprojector reads but never writes (CS20141: "4k" is in `read` only). */
const READ_ONLY_CODES = Object.freeze({ CS20141: ['0B'] });

export const PICTURE_MODE_LABELS = Object.freeze({
  film: 'Film',
  cinema: 'Cinema',
  animation: 'Animation',
  natural: 'Natural',
  'natural-ll': 'Natural (low latency)',
  stage: 'Stage',
  thx: 'THX',
  'thx-bright': 'THX Bright',
  'thx-dark': 'THX Dark',
  'isf-day': 'ISF Day',
  'isf-night': 'ISF Night',
  '3d': '3D',
  '4k': '4K',
  photo: 'Photo',
  hdr: 'HDR',
  hdr1: 'HDR 1',
  hdr2: 'HDR 2',
  hdr10: 'HDR10',
  'hdr10-ll': 'HDR10 (low latency)',
  'hdr10+': 'HDR10+',
  hlg: 'HLG',
  'hlg-ll': 'HLG (low latency)',
  'sdr-1': 'SDR 1',
  'sdr-2': 'SDR 2',
  'pana-pq': 'PANA_PQ',
  'frame-adapt-hdr': 'Frame Adapt HDR',
  'frame-adapt-hdr2': 'Frame Adapt HDR 2',
  'frame-adapt-hdr3': 'Frame Adapt HDR 3',
  'filmmaker-mode': 'Filmmaker Mode',
  vivid: 'Vivid',
  'user-1': 'User 1',
  'user-2': 'User 2',
  'user-3': 'User 3',
  'user-4': 'User 4',
  'user-5': 'User 5',
  'user-6': 'User 6',
  reserved: 'Reserved',
});

/**
 * The picture modes of a model code: [{ value, code, label }] in code order,
 * empty for an unknown model (limp mode).
 */
export function pictureModes(modelCode) {
  const match = matchModel(modelCode);
  if (!match) {
    return [];
  }
  const map = PICTURE_MODES[match.spec];
  const modes = [];
  for (const [code, entry] of Object.entries(map)) {
    const [value, ...only] = Array.isArray(entry) ? entry : [entry];
    if (only.length > 0 && !only.includes(match.model)) {
      continue;
    }
    // Object.entries gives "10" before "0B" (integer-like keys first): the
    // codes are put back in the projector's order below.
    const padded = code.padStart(2, '0');
    modes.push({
      value,
      code: padded,
      label: PICTURE_MODE_LABELS[value] ?? value,
      writable: !NOT_OFFERED.has(value) && !(READ_ONLY_CODES[match.spec] ?? []).includes(padded),
    });
  }
  return modes.sort((a, b) => Number.parseInt(a.code, 16) - Number.parseInt(b.code, 16));
}

/** The picture modes offered in the dropdown: the writable ones. */
export const offeredPictureModes = (modelCode) =>
  pictureModes(modelCode)
    .filter((m) => m.writable)
    .map(({ value, code, label }) => ({ value, code, label }));
