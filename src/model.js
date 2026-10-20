// -----------------------------------------------------------------------------
// Known projectors -> Gladys devices and states (pure). One Gladys device per
// projector, keyed by its MAC address (`LSMA`, as Home Assistant): the address
// may change, the MAC does not.
//
// Categories and types of the Gladys core only: `button/push` for "Power on"
// and "Standby", the power state read only (`unknown/binary`) — no switch,
// nothing an "everything on / off" (voice assistants, scenes) could turn into
// a command —, `text/text` for the power status, `text/select` for the input,
// the picture mode and the remote keys, `unknown/binary` for the signal and
// `duration/integer` in hours for the lamp / laser time (`hours` is one of the
// units the core lists for `duration`).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES, LIMITS } from './constants.js';
import { INPUTS, POWER, REMOTE_KEYS } from './jvc/protocol.js';

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_STATUS]: {
    name: 'Power status',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
  },
  [FEATURES.POWER_ON]: {
    name: 'Power on',
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.INPUT]: {
    name: 'Input',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.PICTURE_MODE]: {
    name: 'Picture mode',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.REMOTE_KEY]: {
    name: 'Remote key',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
  },
  [FEATURES.SIGNAL]: {
    name: 'Signal',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
  },
  [FEATURES.LIGHT_TIME]: {
    name: 'Lamp / laser time',
    category: C.DURATION,
    type: T.DURATION.INTEGER,
    unit: U.HOURS,
    min: 0,
    max: 1_000_000,
    read_only: true,
    keep_history: true,
  },
});

export const INPUT_OPTIONS = Object.freeze(INPUTS.map(({ value, label }) => ({ value, label })));
export const REMOTE_OPTIONS = Object.freeze(
  REMOTE_KEYS.map(({ value, label }) => ({ value, label })),
);

/** The texts of the "Power status" feature (a text state has one language: English). */
export const POWER_TEXTS = Object.freeze({
  [POWER.ON]: 'On',
  [POWER.WARMING]: 'Warming up',
  [POWER.COOLING]: 'Cooling down',
  [POWER.STANDBY]: 'Standby',
  [POWER.ERROR]: 'Error',
  unreachable: 'Not reachable',
});

/** The picture mode options of a projector (they only grow). */
export const pictureOptions = (projector) =>
  (Array.isArray(projector.pictureOptions) ? projector.pictureOptions : [])
    .slice(0, LIMITS.options)
    .map(({ value, label }) => ({ value, label }));

export function deviceName(projector) {
  return projector.model ? `JVC ${projector.model}` : `JVC projector ${projector.mac}`;
}

export function buildDevice(gladys, projector) {
  const ids = gladys.externalIds(DEVICE_TYPE, projector.mac);
  const options = {
    [FEATURES.INPUT]: INPUT_OPTIONS,
    [FEATURES.PICTURE_MODE]: pictureOptions(projector),
    [FEATURES.REMOTE_KEY]: REMOTE_OPTIONS,
  };
  return {
    name: deviceName(projector),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: projector.host || '' }],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(options[key] ? { supported_options: options[key].map((o) => ({ ...o })) } : {}),
    })),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a reading. `reading` is null for a projector that does not
 * answer (power 0, "Not reachable"), undefined when nothing is known (nothing
 * published), else { power, signal?, input?, pictureMode?, lightTime? }.
 */
export function stateList(gladys, projector, reading) {
  if (reading === undefined) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, projector.mac);
  const id = (key) => ids.feature(key);
  if (reading === null) {
    return [
      { device_feature_external_id: id(FEATURES.POWER), state: 0 },
      { device_feature_external_id: id(FEATURES.POWER_STATUS), text: POWER_TEXTS.unreachable },
    ];
  }
  const states = [];
  if (!Object.hasOwn(POWER_TEXTS, reading.power) || reading.power === 'unreachable') {
    return states;
  }
  const on = reading.power === POWER.ON;
  states.push(
    {
      device_feature_external_id: id(FEATURES.POWER),
      state: on || reading.power === POWER.WARMING ? 1 : 0,
    },
    { device_feature_external_id: id(FEATURES.POWER_STATUS), text: POWER_TEXTS[reading.power] },
  );
  if (!on) {
    states.push({ device_feature_external_id: id(FEATURES.SIGNAL), state: 0 });
  } else if (typeof reading.signal === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.SIGNAL), state: reading.signal ? 1 : 0 });
  }
  if (on && INPUT_OPTIONS.some((o) => o.value === reading.input)) {
    states.push({ device_feature_external_id: id(FEATURES.INPUT), text: reading.input });
  }
  if (on && pictureOptions(projector).some((o) => o.value === reading.pictureMode)) {
    states.push({
      device_feature_external_id: id(FEATURES.PICTURE_MODE),
      text: reading.pictureMode,
    });
  }
  if (Number.isSafeInteger(reading.lightTime) && reading.lightTime >= 0) {
    states.push({ device_feature_external_id: id(FEATURES.LIGHT_TIME), state: reading.lightTime });
  }
  return states;
}
