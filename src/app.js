// -----------------------------------------------------------------------------
// The integration: the JVC projectors it knows (typed addresses, identified by
// their MAC address), the Gladys devices built from them, the polling (one
// short TCP session per projector and round), the commands (validated before
// anything is queued, serialized per address, the power state read again
// just before acting, each within the 5 s Gladys waits for its ack) and the
// "Check the projectors" button. index.js only wires the SDK handlers to it
// (src/handlers.js).
//
// Power on and standby are push buttons, never a switch: power on is sent
// only from standby, standby only when on (a standby asked while warming up
// is sent once the projector is on). The network password is sent to the
// projector only, never logged, never written to /data; a refused password
// stops the tries to that address (persisted), tried again every 30 minutes
// or at the next configuration save.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import { DEVICE_TYPE, FEATURES, LIMITS, TIMINGS } from './constants.js';
import { T } from './i18n.js';
import { ERROR_KINDS, JvcError, openSession as defaultOpenSession } from './jvc/client.js';
import {
  CODES,
  DEFAULT_PORT,
  INPUTS,
  POWER,
  POWER_WRITE,
  REMOTE_KEYS,
  offeredPictureModes,
  parseInput,
  parseLightTime,
  parseMac,
  parseModel,
  parsePower,
  parseSignal,
  pictureModes,
} from './jvc/protocol.js';
import { buildDevice, deviceName, featureKey, pictureOptions, stateList } from './model.js';
import { FileStore, emptyData, isMac } from './store.js';

const BUTTONS = new Set([FEATURES.POWER_ON, FEATURES.STANDBY]);
const NOTHING_SENT = 'nothing sent';
const short = (value) => String(value).slice(0, 32);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Queue priorities: standby first, then the other commands, then the background reads. */
const PRIORITY = Object.freeze({ STANDBY: 0, COMMAND: 1, BACKGROUND: 2 });

/** Runs `task` over `items`, `limit` at a time, results in order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** An error of a command that never left: its message says so. */
function notSent(err) {
  if (err?.sent) {
    return new JvcError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the projector', {
      sent: true,
    });
  }
  const message = String(err?.message ?? err);
  return message.includes(NOTHING_SENT)
    ? err
    : new JvcError(err?.kind ?? ERROR_KINDS.PROTOCOL, `${message}: ${NOTHING_SENT}`);
}

export class JvcApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'jvc-projector' }),
    store = new FileStore(),
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
    openSession = defaultOpenSession,
    createConnection,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.openSessionImpl = openSession;
    this.createConnection = createConnection;
    this.config = normalizeConfig();
    this.data = undefined;
    /** mac -> null (not reachable) | undefined (unknown) | { power, signal?, input?, pictureMode?, lightTime? } */
    this.readings = new Map();
    /** addressKey -> { running, items } */
    this.queues = new Map();
    /** macs of the devices created in Gladys */
    this.created = new Set();
    this.createdStale = false;
    /** addressKey -> time of the last probe of a typed address */
    this.probes = new Map();
    /** addressKey -> kind of the last probe failure */
    this.probeErrors = new Map();
    /** addressKey -> 'plain' | 'hashed': the authentication form that worked (memory only) */
    this.authModes = new Map();
    /** addressKey -> time of the last connection */
    this.lastConnect = new Map();
    /** mac -> { until }: a standby asked while warming up */
    this.deferred = new Map();
    /** addressKeys with a background read queued */
    this.readQueued = new Set();
    this.backgroundTimers = new Set();
    this.generation = 0;
    this.pollTimer = undefined;
    this.persistTimer = undefined;
    this.polling = undefined;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys
   * (`connected`) and on every configuration save (`saved`). What this app
   * remembered as "already published" is forgotten on a connection, since the
   * core forgot it too; the projectors are not asked sooner because of it.
   * A save clears the refused passwords: it may hold a new one.
   */
  async start(raw = {}, { connected = false, saved = false } = {}) {
    this.config = normalizeConfig(raw);
    this.started = true;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = this.timers.setInterval(() => this.tick(), this.config.pollInterval * 1000);
    if (connected) {
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    let first = false;
    if (!this.data) {
      first = true;
      try {
        this.data = await this.store.load({ now: this.now(), maxDelay: this.timings.authRetry });
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/jvc-projector.json moved to jvc-projector.json.bad');
      }
    }
    if (saved) {
      if (Object.keys(this.data.authRefused).length > 0) {
        this.data.authRefused = Object.create(null);
        this.persist();
      }
      this.authModes.clear();
      this.probes.clear();
    }
    const fresh = first || saved;
    await this.step('read the Gladys devices', () => this.refreshCreated());
    await this.step('probe the addresses', () => this.probeAddresses(fresh));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the states', () => (fresh ? this.poll() : this.publishAllStates()));
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const handle of this.backgroundTimers) {
      this.timers.clearTimeout(handle);
    }
    this.backgroundTimers.clear();
    this.deferred.clear();
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.store.save(this.data).catch(() => {});
    }
    return Promise.resolve();
  }

  /** One round: the created devices if unread, the typed addresses, the polling, the status. */
  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => (this.createdStale ? this.refreshCreated() : undefined))
      .then(() => this.probeAddresses(false))
      .then((changed) => (changed ? this.publishDevices() : undefined))
      .then(() => this.poll())
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Polling failed: ${err.message}`));
  }

  /** Background work, cancelled by stop(). */
  later(task, ms) {
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.backgroundTimers.delete(handle);
      if (generation === this.generation) {
        Promise.resolve()
          .then(task)
          .catch((err) => this.logger.debug?.(`Background task failed: ${err.message}`));
      }
    }, ms);
    this.backgroundTimers.add(handle);
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  /**
   * The queue of one address: one TCP session at a time (a projector takes
   * one client). Lower priorities go first, never before the task running.
   */
  enqueue(key, task, priority = PRIORITY.COMMAND) {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = { running: false, items: [] };
      this.queues.set(key, queue);
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, priority };
      const index = queue.items.findIndex((i) => i.priority > priority);
      queue.items.splice(index === -1 ? queue.items.length : index, 0, item);
      this.drain(queue);
    });
  }

  async drain(queue) {
    if (queue.running) {
      return;
    }
    queue.running = true;
    while (queue.items.length > 0) {
      const item = queue.items.shift();
      try {
        item.resolve(await item.task());
      } catch (err) {
        item.reject(err);
      }
    }
    queue.running = false;
  }

  // --- Sessions ----------------------------------------------------------------

  authRefusedAt(key) {
    const retryAt = this.data?.authRefused?.[key];
    return Number.isFinite(retryAt) && this.now() < retryAt ? retryAt : undefined;
  }

  markAuthRefused(key) {
    const first = !Object.hasOwn(this.data.authRefused, key);
    this.data.authRefused[key] = this.now() + this.timings.authRetry;
    this.persist();
    if (first) {
      // The address only: never the password.
      this.logger.warn(`${key}: password refused by the projector, tried again in 30 minutes`);
    }
    this.updateStatus().catch(() => {});
  }

  /**
   * Runs `task(session)` in one session with the projector at `address`,
   * before `deadline`. Connections are spaced by `connectSpacing`. A refused
   * password is not sent again before its retry time.
   */
  async withSession(address, deadline, task) {
    const key = addressKey(address);
    if (this.authRefusedAt(key)) {
      throw new JvcError(
        ERROR_KINDS.AUTH,
        `Password refused by the projector at ${key} (fix it in the configuration), ${NOTHING_SENT}`,
      );
    }
    const wait =
      (this.lastConnect.get(key) ?? -Infinity) + this.timings.connectSpacing - this.now();
    if (wait > 0) {
      if (this.now() + wait >= deadline) {
        throw new JvcError(ERROR_KINDS.BUDGET, `No time left for this command, ${NOTHING_SENT}`);
      }
      await sleep(wait);
    }
    this.lastConnect.set(key, this.now());
    let opened;
    try {
      opened = await this.openSessionImpl({
        host: address.host,
        port: address.port,
        password: this.config.password,
        authMode: this.authModes.get(key),
        deadline,
        connectTimeout: this.timings.connectTimeout,
        readTimeout: this.timings.readTimeout,
        spacing: this.timings.spacing,
        now: this.now,
        createConnection: this.createConnection,
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.AUTH) {
        this.markAuthRefused(key);
      }
      throw err;
    }
    if (opened.authMode) {
      this.authModes.set(key, opened.authMode);
    }
    if (Object.hasOwn(this.data.authRefused, key)) {
      delete this.data.authRefused[key];
      this.persist();
      this.logger.info(`${key}: password accepted again`);
      this.updateStatus().catch(() => {});
    }
    try {
      return await task(opened.session);
    } finally {
      opened.session.close();
    }
  }

  // --- Known projectors ------------------------------------------------------------

  get projectors() {
    return Object.values(this.data?.projectors ?? {});
  }

  projectorOf(gladysDevice) {
    return this.projectors.find(
      (p) => this.gladys.externalIds(DEVICE_TYPE, p.mac).device === gladysDevice?.external_id,
    );
  }

  addressOf(projector) {
    return { host: projector.host, port: projector.port ?? DEFAULT_PORT };
  }

  keyOf(projector) {
    return addressKey(this.addressOf(projector));
  }

  /**
   * Remembers the projector answering at `address` by its MAC. Another
   * projector that had this address lost it (DHCP): never commanded at an
   * address that is no longer its own.
   */
  remember({ mac, model }, address) {
    if (!isMac(mac)) {
      return undefined;
    }
    const table = this.data.projectors;
    let projector = Object.hasOwn(table, mac) ? table[mac] : undefined;
    if (!projector) {
      if (Object.keys(table).length >= LIMITS.projectors) {
        this.warnOnce(
          'projectors',
          `More than ${LIMITS.projectors} projectors: the next ones are ignored`,
        );
        return undefined;
      }
      projector = { mac, host: '', port: DEFAULT_PORT, pictureOptions: [] };
      table[mac] = projector;
      this.persist();
    }
    for (const other of this.projectors) {
      if (other.mac !== mac && other.host === address.host && other.port === address.port) {
        this.logger.warn(`${deviceName(other)} no longer answers at ${addressKey(address)}`);
        other.host = '';
        this.readings.set(other.mac, null);
        this.persist();
        this.publishStates(other).catch(() => {});
      }
    }
    if (projector.host !== address.host || projector.port !== address.port) {
      projector.host = address.host;
      projector.port = address.port;
      this.persist();
    }
    if (model && model !== projector.model) {
      projector.model = model;
      this.persist();
    }
    this.mergePictureOptions(projector, offeredPictureModes(projector.model));
    return projector;
  }

  /** The picture mode dropdown only grows. True when it grew. */
  mergePictureOptions(projector, modes) {
    const options = pictureOptions(projector);
    let changed = false;
    for (const mode of modes) {
      if (!options.some((o) => o.value === mode.value) && options.length < LIMITS.options) {
        options.push({ value: mode.value, label: mode.label });
        changed = true;
      }
    }
    if (changed) {
      projector.pictureOptions = options;
      this.persist();
    }
    return changed;
  }

  /**
   * The picture mode options of the device created in Gladys
   * (`gladys.devices`, kept up to date by the SDK), merged into the known
   * projector: options seen before a reset of /data are never dropped.
   */
  mergeCreatedOptions(projector) {
    const externalId = this.gladys.externalIds(DEVICE_TYPE, projector.mac).device;
    const created = (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === externalId,
    );
    const feature = (Array.isArray(created?.features) ? created.features : []).find(
      (f) => f?.external_id === `${externalId}:${FEATURES.PICTURE_MODE}`,
    );
    const options = (Array.isArray(feature?.supported_options) ? feature.supported_options : [])
      .filter((o) => typeof o?.value === 'string' && /^[a-z0-9][a-z0-9+-]{0,31}$/.test(o.value))
      .map((o) => ({
        value: o.value,
        label: typeof o.label === 'string' ? o.label.slice(0, 40) : o.value,
      }));
    this.mergePictureOptions(projector, options);
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const projectors = this.projectors;
    projectors.forEach((p) => this.mergeCreatedOptions(p));
    await this.gladys.publishDiscoveredDevices(projectors.map((p) => buildDevice(this.gladys, p)));
  }

  /**
   * The devices created in Gladys. When `getDevices` fails, the list the SDK
   * keeps (`gladys.devices`) is used, and the call is made again at every
   * round until it works.
   */
  async refreshCreated() {
    let list;
    try {
      list = await this.gladys.getDevices();
      this.createdStale = false;
    } catch (err) {
      this.createdStale = true;
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      this.logger.warn(`Could not read the Gladys devices (${err.message}): using the last list`);
      list = this.gladys.devices;
    }
    const byExternalId = new Map(
      this.projectors.map((p) => [this.gladys.externalIds(DEVICE_TYPE, p.mac).device, p.mac]),
    );
    this.created = new Set(
      (Array.isArray(list) ? list : [])
        .map((d) => byExternalId.get(d?.external_id))
        .filter(Boolean),
    );
  }

  // --- Identification -----------------------------------------------------------------

  /** Model and MAC of the projector at `address`, in the queue of that address. */
  identify(address) {
    const key = addressKey(address);
    return this.enqueue(
      key,
      () =>
        this.withSession(address, this.now() + this.timings.pollBudget, async (session) => {
          const model = parseModel(await session.ref(CODES.MODEL));
          const mac = parseMac(await session.ref(CODES.MAC));
          if (!mac) {
            throw new JvcError(ERROR_KINDS.PROTOCOL, 'MAC address unreadable');
          }
          return { mac, model };
        }),
      PRIORITY.BACKGROUND,
    );
  }

  /** The typed addresses where no known projector is: asked at start, then every minute at most. */
  async probeAddresses(force) {
    let changed = false;
    const spacing = Math.max(this.timings.probeRetry, this.config.pollInterval * 1000);
    await Promise.all(
      this.config.addresses.map(async (address) => {
        const key = addressKey(address);
        if (this.projectors.some((p) => p.host && this.keyOf(p) === key)) {
          this.probeErrors.delete(key);
          return;
        }
        const last = this.probes.get(key) ?? -Infinity;
        if (!force && this.now() - last < spacing) {
          return;
        }
        if (this.authRefusedAt(key)) {
          return;
        }
        this.probes.set(key, this.now());
        try {
          const info = await this.identify(address);
          const projector = this.remember(info, address);
          this.probeErrors.delete(key);
          if (projector) {
            changed = true;
            this.logger.info(`${deviceName(projector)} found at ${key}`);
          }
        } catch (err) {
          this.probeErrors.set(key, err.kind ?? ERROR_KINDS.PROTOCOL);
          this.logger.debug?.(`${key}: ${err.message}`);
        }
      }),
    );
    return changed;
  }

  // --- Polling -------------------------------------------------------------------------

  poll() {
    if (!this.polling) {
      this.polling = Promise.all(
        this.projectors
          .filter((p) => this.created.has(p.mac) && p.host)
          .map((p) => this.queueRead(p)),
      ).finally(() => {
        this.polling = undefined;
      });
    }
    return this.polling;
  }

  /** One background read of a projector; one at most waiting per address. */
  queueRead(projector) {
    const key = this.keyOf(projector);
    if (this.readQueued.has(key)) {
      return Promise.resolve();
    }
    this.readQueued.add(key);
    return this.enqueue(
      key,
      () => {
        this.readQueued.delete(key);
        return this.readProjector(projector);
      },
      PRIORITY.BACKGROUND,
    ).catch((err) => this.logger.debug?.(`${deviceName(projector)}: ${err.message}`));
  }

  /** A read that may fail without failing the round (the session is then closed). */
  async soft(task) {
    try {
      return await task();
    } catch {
      return undefined;
    }
  }

  /**
   * Reads a projector (called from its queue): power, then, when on, signal,
   * input, lamp time and picture mode (with a signal only, as Home
   * Assistant). A secondary read that fails never drops the power state.
   */
  async readProjector(projector) {
    if (!projector.host) {
      return null;
    }
    const before = this.readings.get(projector.mac);
    const address = this.addressOf(projector);
    let reading;
    try {
      reading = await this.withSession(
        address,
        this.now() + this.timings.pollBudget,
        async (session) => {
          if (!before) {
            // Back (or first) online: the address must still be this projector's.
            const mac = parseMac(await session.ref(CODES.MAC));
            if (mac !== projector.mac) {
              return { otherMac: mac };
            }
          }
          const power = parsePower(await session.ref(CODES.POWER));
          if (!power) {
            this.warnOnce(
              `power:${projector.mac}`,
              `${deviceName(projector)}: unknown power state`,
            );
            return undefined;
          }
          const result = { power };
          if (power === POWER.ON) {
            result.signal = parseSignal(await this.soft(() => session.ref(CODES.SIGNAL)));
            result.input = parseInput(await this.soft(() => session.ref(CODES.INPUT)));
            result.lightTime = parseLightTime(await this.soft(() => session.ref(CODES.LIGHT_TIME)));
            if (result.signal === true && pictureOptions(projector).length > 0) {
              const code = await this.soft(() => session.ref(CODES.PICTURE_MODE));
              result.pictureMode = pictureModes(projector.model).find(
                (m) => m.code === code,
              )?.value;
            }
          }
          return result;
        },
      );
    } catch (err) {
      reading = err.kind === ERROR_KINDS.UNREACHABLE ? null : undefined;
      if (reading === undefined) {
        this.logger.debug?.(`${deviceName(projector)}: ${err.message}`);
      }
    }
    if (reading && 'otherMac' in reading) {
      // Its address went to another projector (DHCP): never commanded there.
      this.logger.warn(`${deviceName(projector)}: another projector answers at ${projector.host}`);
      projector.host = '';
      this.persist();
      reading = null;
      // When it is a typed address, it is identified again at the next round.
      this.probes.delete(addressKey(address));
    }
    // An unknown answer keeps what was known.
    if (reading !== undefined) {
      this.readings.set(projector.mac, reading);
    }
    await this.publishStates(projector);
    this.followDeferred(projector, reading);
    return reading;
  }

  async publishStates(projector) {
    if (!this.created.has(projector.mac)) {
      return;
    }
    const states = stateList(this.gladys, projector, this.readings.get(projector.mac));
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(`Could not publish the states of ${deviceName(projector)}: ${err.message}`);
    }
  }

  async publishAllStates() {
    for (const projector of this.projectors) {
      await this.publishStates(projector);
    }
  }

  recheck(projector) {
    this.later(() => this.queueRead(projector), this.timings.recheckDelay);
  }

  // --- Deferred standby ---------------------------------------------------------------

  /** A standby asked while warming up: sent as soon as the projector is on. */
  deferStandby(projector) {
    const entry = { until: this.now() + this.timings.deferredStandby };
    this.deferred.set(projector.mac, entry);
    this.logger.info(`${deviceName(projector)}: warming up, standby sent once it is on`);
    this.scheduleDeferred(projector, entry);
  }

  cancelDeferred(projector) {
    this.deferred.delete(projector.mac);
  }

  scheduleDeferred(projector, entry) {
    this.later(() => {
      if (this.deferred.get(projector.mac) !== entry) {
        return undefined;
      }
      // A failed read stops the chain: the polling rounds take over.
      return this.queueRead(projector);
    }, this.timings.deferredStep);
  }

  /** After each read: the deferred standby is sent, kept waiting, or dropped. */
  followDeferred(projector, reading) {
    const entry = this.deferred.get(projector.mac);
    if (!entry) {
      return;
    }
    if (this.now() > entry.until) {
      this.deferred.delete(projector.mac);
      this.logger.warn(`${deviceName(projector)}: deferred standby dropped (still not on)`);
      return;
    }
    const power = reading?.power;
    if (power === POWER.ON) {
      this.deferred.delete(projector.mac);
      this.enqueue(
        this.keyOf(projector),
        () => this.sendStandbyNow(projector),
        PRIORITY.STANDBY,
      ).catch((err) =>
        this.logger.warn(`${deviceName(projector)}: deferred standby failed (${err.message})`),
      );
    } else if (power === POWER.WARMING) {
      this.scheduleDeferred(projector, entry);
    } else if (reading !== undefined) {
      // Standby, cooling down, error, not reachable: nothing left to do.
      this.deferred.delete(projector.mac);
    }
  }

  /** The deferred standby, from the queue: power read again, PW0 only when on. */
  async sendStandbyNow(projector) {
    if (!projector.host) {
      return;
    }
    await this.withSession(
      this.addressOf(projector),
      this.now() + this.timings.commandBudget,
      async (session) => {
        const power = parsePower(await session.ref(CODES.POWER));
        if (power === POWER.ON) {
          await session.op(CODES.POWER, POWER_WRITE.off);
          this.logger.info(`${deviceName(projector)}: deferred standby sent`);
        }
      },
    );
    this.recheck(projector);
  }

  // --- Commands --------------------------------------------------------------------

  /** Validates a command before anything is queued or sent. */
  validate(projector, key, value) {
    if (BUTTONS.has(key)) {
      return undefined;
    }
    if (key === FEATURES.INPUT) {
      const input = INPUTS.find((i) => i.value === value);
      if (!input) {
        throw new Error(`Unknown input "${short(value)}"`);
      }
      return input.code;
    }
    if (key === FEATURES.PICTURE_MODE) {
      const mode = offeredPictureModes(projector.model).find((m) => m.value === value);
      if (typeof value !== 'string' || !mode) {
        throw new Error(`Picture mode "${short(value)}" is not one of this model`);
      }
      return mode.code;
    }
    if (key === FEATURES.REMOTE_KEY) {
      const remote = REMOTE_KEYS.find((k) => k.value === value);
      if (!remote) {
        throw new Error(`Unknown remote key "${short(value)}"`);
      }
      return remote.code;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  async setValue(gladysDevice, feature, value) {
    const projector = this.projectorOf(gladysDevice);
    if (!projector) {
      throw new Error(`Unknown projector ${short(gladysDevice?.external_id)}`);
    }
    const key = featureKey(gladysDevice.external_id, feature?.external_id);
    const code = this.validate(projector, key, value);
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.now();
    let late = false;
    // Set just before an operation frame leaves: from then on it may have
    // reached the projector, whatever happens next.
    const context = { mayHaveSent: false };
    if (key === FEATURES.POWER_ON) {
      // Asking for power on cancels a standby waiting for the end of the warm-up.
      this.cancelDeferred(projector);
    }
    const run = this.enqueue(
      projector.host ? this.keyOf(projector) : `lost:${projector.mac}`,
      async () => {
        if (late || this.remaining(started) < 50) {
          // Gladys stopped waiting while this command was queued: dropped, never sent late.
          late = true;
          throw new JvcError(ERROR_KINDS.BUDGET, `No time left for this command, ${NOTHING_SENT}`);
        }
        try {
          return await this.command(projector, key, code, started, context);
        } catch (err) {
          throw notSent(err);
        }
      },
      key === FEATURES.STANDBY ? PRIORITY.STANDBY : PRIORITY.COMMAND,
    );
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          late = true;
          reject(
            context.mayHaveSent
              ? new JvcError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the projector', {
                  sent: true,
                })
              : new JvcError(
                  ERROR_KINDS.BUDGET,
                  `No time left for this command (projector busy), ${NOTHING_SENT}`,
                ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  /** The power state read just before acting, within `preRead`. */
  async readPowerBefore(session, started) {
    const until = Math.min(started + this.timings.commandBudget, this.now() + this.timings.preRead);
    return parsePower(await session.ref(CODES.POWER, { until }));
  }

  async command(projector, key, code, started, context) {
    if (!projector.host) {
      throw new JvcError(
        ERROR_KINDS.UNREACHABLE,
        `${deviceName(projector)}: address unknown, type its new address in the configuration`,
      );
    }
    const address = this.addressOf(projector);
    const deadline = started + this.timings.commandBudget;
    if (key !== FEATURES.STANDBY) {
      return this.withSession(address, deadline, async (session) => {
        let power;
        try {
          power = await this.readPowerBefore(session, started);
        } catch (err) {
          throw new JvcError(err.kind, `Power state not read (${err.message})`);
        }
        return this.act(projector, session, key, code, power, context);
      });
    }
    // Standby is never refused because the state could not be read (or the
    // handshake went wrong): it is then sent in a new session, time allowing.
    let unread = false;
    try {
      await this.withSession(address, deadline, async (session) => {
        let power;
        try {
          power = await this.readPowerBefore(session, started);
        } catch {
          unread = true;
          return undefined;
        }
        return this.act(projector, session, key, code, power, context);
      });
    } catch (err) {
      const retryable = [
        ERROR_KINDS.BUSY,
        ERROR_KINDS.TIMEOUT,
        ERROR_KINDS.PROTOCOL,
        ERROR_KINDS.CLOSED,
      ];
      if (err.sent || !retryable.includes(err.kind)) {
        throw err;
      }
      unread = true;
    }
    if (unread) {
      await this.blindStandby(projector, address, deadline, context);
    }
    return undefined;
  }

  /** Standby when the state could not be read: PW0 in a new session, if time allows. */
  async blindStandby(projector, address, deadline, context) {
    await this.withSession(address, deadline, async (session) => {
      context.mayHaveSent = true;
      await session.op(CODES.POWER, POWER_WRITE.off);
    });
    this.logger.info(`${deviceName(projector)}: standby sent without a power state`);
    this.recheck(projector);
  }

  async act(projector, session, key, code, power, context) {
    const name = deviceName(projector);
    const send = async (opCode, value, ackTimeout) => {
      context.mayHaveSent = true;
      try {
        await session.op(opCode, value, ackTimeout);
      } finally {
        this.recheck(projector);
      }
    };
    switch (key) {
      case FEATURES.POWER_ON:
        if (power === POWER.ON || power === POWER.WARMING) {
          return undefined;
        }
        if (power === POWER.STANDBY) {
          await send(CODES.POWER, POWER_WRITE.on);
          return undefined;
        }
        if (power === POWER.COOLING) {
          throw new Error(`${name} is cooling down and refuses power on until it is in standby`);
        }
        throw new Error(`${name}: power state ${power ?? 'unknown'}, power on not sent`);
      case FEATURES.STANDBY:
        if (power === POWER.STANDBY || power === POWER.COOLING) {
          return undefined;
        }
        if (power === POWER.WARMING) {
          // The projector ignores standby while warming up: sent once it is on.
          this.deferStandby(projector);
          return undefined;
        }
        await send(CODES.POWER, POWER_WRITE.off);
        return undefined;
      default:
        if (power !== POWER.ON) {
          throw new Error(`${name} is not on (${power ?? 'unknown'})`);
        }
        if (key === FEATURES.INPUT) {
          await send(CODES.INPUT, code, this.timings.slowAckTimeout);
        } else if (key === FEATURES.PICTURE_MODE) {
          await send(CODES.PICTURE_MODE, code, this.timings.slowAckTimeout);
        } else {
          await send(CODES.REMOTE, code);
        }
        return undefined;
    }
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(gladysDevice) {
    const projector = this.projectorOf(gladysDevice);
    if (!projector) {
      return;
    }
    this.created.add(projector.mac);
    // The SDK forgot what was published for this device: everything again.
    if (this.readings.has(projector.mac)) {
      await this.publishStates(projector);
    } else {
      await this.queueRead(projector);
    }
    await this.updateStatus();
  }

  async deviceDeleted(gladysDevice) {
    const projector = this.projectorOf(gladysDevice);
    if (projector) {
      this.created.delete(projector.mac);
      this.cancelDeferred(projector);
      await this.updateStatus();
    }
  }

  // --- Configuration screen button -------------------------------------------------

  async checkProjectors() {
    if (this.projectors.length === 0) {
      return T.noProjector;
    }
    const lines = await mapLimit(this.projectors, this.timings.checkConcurrency, async (p) => {
      const label = `${deviceName(p)} (${p.host ? this.keyOf(p) : '?'})`;
      if (!p.host) {
        return T.checkLine(label, { error: ERROR_KINDS.UNREACHABLE });
      }
      if (this.authRefusedAt(this.keyOf(p))) {
        return T.checkLine(label, { error: ERROR_KINDS.AUTH });
      }
      try {
        const outcome = await this.enqueue(
          this.keyOf(p),
          () =>
            this.withSession(this.addressOf(p), this.now() + this.timings.pollBudget, async (s) => {
              const power = parsePower(await s.ref(CODES.POWER));
              const lightTime =
                power === POWER.ON
                  ? parseLightTime(await this.soft(() => s.ref(CODES.LIGHT_TIME)))
                  : undefined;
              return { power, lightTime };
            }),
          PRIORITY.BACKGROUND,
        );
        return T.checkLine(label, outcome);
      } catch (err) {
        return T.checkLine(label, { error: err.kind ?? ERROR_KINDS.PROTOCOL });
      }
    });
    return T.check(lines, this.config.pollInterval);
  }

  // --- Status ---------------------------------------------------------------------

  async updateStatus() {
    if (!this.started || !this.data) {
      return;
    }
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    if (this.config.passwordInvalid) {
      notes.push(T.invalidPassword);
    }
    // Listed until a try succeeds (or a configuration save), even past the retry time.
    const refused = Object.keys(this.data.authRefused);
    if (refused.length > 0) {
      const labels = refused.map((key) => {
        const projector = this.projectors.find((p) => p.host && this.keyOf(p) === key);
        return projector ? `${deviceName(projector)} (${key})` : key;
      });
      notes.push(T.authRefused(labels));
    }
    const silent = this.config.addresses
      .map(addressKey)
      .filter(
        (key) =>
          !this.projectors.some((p) => p.host && this.keyOf(p) === key) &&
          this.probeErrors.has(key) &&
          this.probeErrors.get(key) !== ERROR_KINDS.AUTH,
      );
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const lost = this.projectors.filter((p) => this.created.has(p.mac) && !p.host);
    if (lost.length > 0) {
      notes.push(T.addressUnknown(lost.map(deviceName)));
    }
    const off = this.projectors
      .filter((p) => this.created.has(p.mac) && p.host && this.readings.get(p.mac) === null)
      .map(deviceName);
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    // A local integration: "connected" means running, unless a password is refused.
    const status = { connected: refused.length === 0 };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
