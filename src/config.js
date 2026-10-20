// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password is
// kept as given (it is the projector's), never logged nor echoed: an invalid
// one is reported without its value.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { LIMITS, POLL_INTERVAL } from './constants.js';
import { DEFAULT_PORT } from './jvc/protocol.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). The password has none. */
export const DEFAULT_CONFIG = {
  addresses: '',
  poll_interval: POLL_INTERVAL.default,
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * The address of a projector typed by the user: an IPv4 address or a host
 * name, with an optional port (20554 by default).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^(?:tcp|https?):\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** The refresh interval in seconds; anything unreadable gives the default. */
export function parsePollInterval(raw) {
  const value = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  if (raw === null || raw === undefined || typeof raw === 'boolean' || !Number.isFinite(value)) {
    return POLL_INTERVAL.default;
  }
  return Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(value)));
}

/**
 * The network password of the projectors: printable, at most 64 characters.
 * @returns {{ password: string, passwordInvalid: boolean }}
 */
export function parsePassword(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { password: '', passwordInvalid: false };
  }
  // A number typed in the field arrives as a number: its digits are the password.
  const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  if (
    typeof text !== 'string' ||
    text.length > LIMITS.password ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(text)
  ) {
    return { password: '', passwordInvalid: true };
  }
  return { password: text, passwordInvalid: false };
}

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const addresses = [];
  const invalid = [];
  for (const entry of String(c.addresses ?? '')
    .split(/[\s,;]+/)
    .filter((e) => e !== '')) {
    const address = parseAddress(entry);
    if (!address) {
      invalid.push(entry.slice(0, 100));
    } else if (
      !addresses.some((a) => addressKey(a) === addressKey(address)) &&
      addresses.length < LIMITS.addresses
    ) {
      addresses.push(address);
    }
  }
  return {
    addresses,
    invalid,
    pollInterval: parsePollInterval(c.poll_interval),
    ...parsePassword(c.password),
  };
}
