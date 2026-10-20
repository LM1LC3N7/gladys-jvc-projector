// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known projectors by MAC address (address, port,
// model, picture mode options), and the addresses whose password was refused
// with the time of the next try. Never the password, nor anything derived
// from it.
//
// The MAC addresses come from the network: only 12 lowercase hexadecimal
// digits are keys, and the tables have no prototype.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from './constants.js';
import { DEFAULT_PORT } from './jvc/protocol.js';

export const emptyData = () => ({
  projectors: Object.create(null),
  authRefused: Object.create(null),
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isMac = (value) => typeof value === 'string' && /^[0-9a-f]{12}$/.test(value);
const OPTION_VALUE = /^[a-z0-9][a-z0-9+-]{0,31}$/;
const cleanLabel = (value, fallback) =>
  typeof value === 'string' && /^[\w +()./-]{1,40}$/.test(value) ? value : fallback;

function sanitizeOptions(options) {
  const seen = new Set();
  const result = [];
  for (const option of Array.isArray(options) ? options.slice(0, LIMITS.options * 2) : []) {
    if (
      isObject(option) &&
      typeof option.value === 'string' &&
      OPTION_VALUE.test(option.value) &&
      !seen.has(option.value) &&
      result.length < LIMITS.options
    ) {
      seen.add(option.value);
      result.push({ value: option.value, label: cleanLabel(option.label, option.value) });
    }
  }
  return result;
}

/** `retryAt` read back is capped: a far-future value never blocks for longer than `maxDelay`. */
function sanitize(data, { now = Date.now(), maxDelay = Infinity } = {}) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  if (isObject(data.projectors)) {
    for (const [mac, projector] of Object.entries(data.projectors).slice(0, LIMITS.projectors)) {
      if (!isMac(mac) || !isObject(projector) || projector.mac !== mac) {
        continue;
      }
      base.projectors[mac] = {
        mac,
        host: typeof projector.host === 'string' ? projector.host.slice(0, 253) : '',
        port:
          Number.isInteger(projector.port) && projector.port > 0 && projector.port < 65536
            ? projector.port
            : DEFAULT_PORT,
        model:
          typeof projector.model === 'string' && /^[A-Z0-9-]{1,16}$/.test(projector.model)
            ? projector.model
            : undefined,
        pictureOptions: sanitizeOptions(projector.pictureOptions),
      };
    }
  }
  if (isObject(data.authRefused)) {
    for (const [key, retryAt] of Object.entries(data.authRefused).slice(0, LIMITS.addresses * 2)) {
      if (/^[a-z0-9.:-]{1,260}$/.test(key) && Number.isFinite(retryAt)) {
        base.authRefused[key] = Math.min(retryAt, now + maxDelay);
      }
    }
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'jvc-projector.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.corrupted = false;
  }

  /**
   * The saved data. An unreadable file is moved aside to
   * `jvc-projector.json.bad` and `corrupted` is set, so the app says so
   * instead of silently starting over.
   */
  async load(options) {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(text), options);
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.corrupted = false;
  }

  async load(options) {
    return sanitize(JSON.parse(JSON.stringify(this.data)), options);
  }

  async save(data) {
    // Through JSON, as the file store: what a restart would read back.
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}

export { sanitize as sanitizeData };
