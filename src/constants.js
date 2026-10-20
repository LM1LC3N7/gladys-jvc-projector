// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <MAC address of the projector, 12 hex digits>)`. */
export const DEVICE_TYPE = 'projector';

export const FEATURES = Object.freeze({
  /** Read only: 1 on (or warming up), 0 standby, cooling down, error or unreachable. */
  POWER: 'power',
  /** Read only text: On, Warming up, Cooling down, Standby, Error, Not reachable. */
  POWER_STATUS: 'power_status',
  /** Push button: power on, sent only from standby. */
  POWER_ON: 'power_on',
  /** Push button: standby, sent only when on (deferred while warming up). */
  STANDBY: 'standby',
  /** Dropdown: HDMI 1, HDMI 2. */
  INPUT: 'input',
  /** Dropdown: the picture modes of the model. */
  PICTURE_MODE: 'picture_mode',
  /** Dropdown: one remote control key per selection. */
  REMOTE_KEY: 'remote_key',
  /** Read only: 1 when the input has a signal. */
  SIGNAL: 'signal',
  /** Read only: lamp / laser hours. */
  LIGHT_TIME: 'light_time',
});

export const ACTIONS = Object.freeze({
  CHECK: 'check_projectors',
});

export const POLL_INTERVAL = Object.freeze({ min: 10, max: 300, default: 15 });

export const TIMINGS = Object.freeze({
  /** TCP connection, and each read of the handshake or of an answer (pyjvcprojector: 2 s). */
  connectTimeout: 2_000,
  readTimeout: 2_000,
  /**
   * The ack of an input or picture mode change (pyjvcprojector: 10 s; the
   * projector acks once the change is done). Waited for after the answer to
   * Gladys, holding the queue of the projector, then the socket is closed.
   */
  slowAckTimeout: 10_000,
  /** Spacing of the commands of a session (pyjvcprojector: 0.1 s after a read, 1 s after an operation). */
  spacing: Object.freeze({ ref: 100, op: 1_000 }),
  /** Two connections to a projector are at least this far apart (pyjvcprojector: 0.75 s). */
  connectSpacing: 750,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * queue, connection, state read just before, operation) gets
   * `commandBudget`, the state read `preRead` of it.
   */
  commandBudget: 3_500,
  preRead: 1_500,
  /** One polling round of one projector, all its reads included. */
  pollBudget: 8_000,
  /** A typed address where no projector answered yet is asked again at most this often. */
  probeRetry: 60_000,
  /** A refused password is tried again at most this often (or at the next configuration save). */
  authRetry: 30 * 60_000,
  /** After a power command, the state is read again this much later. */
  recheckDelay: 3_000,
  /** A standby asked while warming up waits this long at most, checked every `deferredStep`. */
  deferredStandby: 3 * 60_000,
  deferredStep: 5_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** Projectors asked at once by "Check the projectors". */
  checkConcurrency: 4,
});

export const LIMITS = Object.freeze({ projectors: 10, addresses: 10, password: 64, options: 60 });
