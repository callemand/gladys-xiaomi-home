// -----------------------------------------------------------------------------
// MIoT robot vacuums.
//
// The robots Xiaomi builds itself (xiaomi.vacuum.*) do not speak the Roborock
// RPCs (get_status, get_consumable, app_start...): they answer none of them,
// and the request ends in "user ack timeout", on the LAN as through the cloud.
// They speak MIoT instead: properties and actions addressed by
// (siid, piid / aiid), read with `get_properties`, written with
// `set_properties`, run with `action`. Both transports carry these methods
// unchanged.
//
// This module translates between the two, so that the rest of the integration
// keeps speaking Roborock: a MIoT status is reshaped as a get_status result, the
// consumables as a get_consumable one, and the Roborock commands become MIoT
// actions. Each supported model has a profile, read from its spec on
// https://home.miot-spec.com — the (siid, piid) of a property differ from one
// model to the next, so a model without a profile is not guessed at.
// -----------------------------------------------------------------------------

import { CONSUMABLE_LIFETIME, ROBOROCK_METHOD } from '../constants.js';

// Roborock state code of an error: a MIoT fault is reported as this state.
const ROBOROCK_ERROR_STATE = 12;
// Roborock state code of a room (segment) cleaning.
const ROBOROCK_SEGMENT_CLEANING_STATE = 18;

/**
 * The MIoT profiles, by model.
 *
 * - `status`: the (siid, piid) of each property read for get_status;
 * - `areaUnitMm2`: the size, in mm², of one unit of the cleaned area (the spec
 *   does not say it: it is read on the robot against the app);
 * - `states`: MIoT status value -> Roborock state code;
 * - `segmentCleaning` (optional): the MIoT status and sweep type of a room
 *   cleaning, reported as the Roborock segment_cleaning state;
 * - `errors` (optional): MIoT fault code -> label, once the codes of the model
 *   are known; a fault without a label is reported as `Erreur <code>`;
 * - `fanPowers`: MIoT suction level value -> Roborock fan power;
 * - `consumables`: the (siid, piid) of the remaining-life percentages, by
 *   get_consumable field;
 * - `actions`: Roborock method -> the (siid, aiid) of the MIoT action;
 * - `map`: when the robot uploads its map (see map/xiaomiJsonMap.js), the
 *   (siid, piid) of the property naming the map file;
 * - `roomClean` (optional): the (siid, aiid) of the action cleaning the rooms
 *   given as a comma-separated string of the map room ids.
 */
export const MIOT_VACUUM_PROFILES = {
  // Xiaomi Robot Vacuum S20+ — https://home.miot-spec.com/spec/xiaomi.vacuum.b108gl
  'xiaomi.vacuum.b108gl': {
    status: {
      state: { siid: 2, piid: 1 },
      error_code: { siid: 2, piid: 2 },
      clean_area: { siid: 2, piid: 5 },
      clean_time: { siid: 2, piid: 6 }, // seconds
      fan_power: { siid: 2, piid: 8 },
      sweep_type: { siid: 2, piid: 4 },
      battery: { siid: 3, piid: 1 },
    },
    // Hundredths of m²: the robot reports 2500 where the app shows 25 m².
    areaUnitMm2: 1e4,
    states: {
      1: 3, // Idle -> idle
      2: 8, // Charging -> charging
      3: 8, // BreakCharging (recharging mid-clean) -> charging
      4: 5, // Sweeping -> cleaning
      5: 10, // Paused -> paused
      6: 6, // Go Charging -> returning_home
      7: 7, // Remote -> manual_mode
      8: 100, // Charged -> charging_complete
      9: 29, // Mapping -> mapping
      10: 14, // Updating -> updating
    },
    // Sweeping (4) with the SelectRoom sweep type (8): a room cleaning.
    segmentCleaning: { status: 4, sweepType: 8 },
    fanPowers: {
      1: 101, // Silent -> quiet
      2: 102, // Basic -> balanced
      3: 103, // Strong -> turbo
      4: 104, // Full Speed -> max
    },
    consumables: {
      // The spec names the three brush-cleaner services alike: the Chinese
      // labels tell them apart (主刷 main brush, 边刷 side brush, 抹布 mop).
      main_brush_work_time: { siid: 8, piid: 2, lifetime: CONSUMABLE_LIFETIME.MAIN_BRUSH_SECONDS },
      side_brush_work_time: { siid: 9, piid: 2, lifetime: CONSUMABLE_LIFETIME.SIDE_BRUSH_SECONDS },
      filter_work_time: { siid: 10, piid: 2, lifetime: CONSUMABLE_LIFETIME.FILTER_SECONDS },
    },
    actions: {
      [ROBOROCK_METHOD.APP_START]: { siid: 2, aiid: 1 },
      [ROBOROCK_METHOD.APP_STOP]: { siid: 2, aiid: 2 },
      [ROBOROCK_METHOD.APP_PAUSE]: { siid: 2, aiid: 6 },
      [ROBOROCK_METHOD.APP_CHARGE]: { siid: 3, aiid: 1 },
    },
    // map-obj-name: {"index":…,"obj_name":"<user id>/<did>/<n>"}
    map: { objectName: { siid: 7, piid: 1 } },
    // start-vacuum-room-sweep, its single input being vacuum-room-ids (2.13).
    roomClean: { siid: 2, aiid: 13 },
  },
};

/**
 * The MIoT profile of a model, if it has one.
 * @param {string|null} model the Mi Home model
 * @returns {object|null} the profile, or null for a Roborock-speaking robot
 */
export function miotProfile(model) {
  return (model && MIOT_VACUUM_PROFILES[model]) || null;
}

/**
 * The params of a get_properties request.
 * @param {string} did the device id
 * @param {object} properties the (siid, piid) to read, by name
 * @returns {Array<object>} the get_properties params
 */
export function propertiesRequest(did, properties) {
  return Object.values(properties).map(({ siid, piid }) => ({ did, siid, piid }));
}

/**
 * The values of a get_properties answer, by name. A property the robot did not
 * answer (non-zero code) is left out.
 * @param {object} properties the (siid, piid) that were read, by name
 * @param {Array<object>} results the get_properties result
 * @returns {object} the values, by name
 */
function valuesByName(properties, results) {
  const values = {};
  for (const [name, { siid, piid }] of Object.entries(properties)) {
    const found = (Array.isArray(results) ? results : []).find(
      (result) => result && result.siid === siid && result.piid === piid,
    );
    if (found && (found.code === undefined || found.code === 0) && found.value !== undefined) {
      values[name] = found.value;
    }
  }
  return values;
}

/**
 * Reshape a MIoT status as a Roborock get_status result.
 * @param {object} profile the MIoT profile
 * @param {Array<object>} results the get_properties result
 * @returns {object} the status, with the Roborock field names and codes
 */
export function statusFromProperties(profile, results) {
  const values = valuesByName(profile.status, results);
  const status = {};
  if (values.state !== undefined) {
    const state = profile.states[values.state];
    // An unknown MIoT status is reported as unknown, never as another state.
    status.state = state === undefined ? 0 : state;
    const segment = profile.segmentCleaning;
    if (segment && values.state === segment.status && values.sweep_type === segment.sweepType) {
      status.state = ROBOROCK_SEGMENT_CLEANING_STATE;
    }
  }
  if (values.error_code !== undefined) {
    status.error_code = values.error_code;
    // The MIoT status has no error value: a fault is the only sign of one. Its
    // codes are not the Roborock ones, so the label never comes from that table.
    if (values.error_code !== 0) {
      status.state = ROBOROCK_ERROR_STATE;
      status.error_label =
        (profile.errors && profile.errors[values.error_code]) || `Erreur ${values.error_code}`;
    }
  }
  if (values.clean_area !== undefined) {
    status.clean_area = values.clean_area * profile.areaUnitMm2; // mm², like Roborock
  }
  if (values.clean_time !== undefined) {
    status.clean_time = values.clean_time;
  }
  if (values.fan_power !== undefined && profile.fanPowers[values.fan_power] !== undefined) {
    status.fan_power = profile.fanPowers[values.fan_power];
  }
  if (values.battery !== undefined) {
    status.battery = values.battery;
  }
  return status;
}

/**
 * Reshape the MIoT remaining-life percentages as a Roborock get_consumable
 * result: Roborock counts the time each part has been used, so the remaining
 * percentage is turned back into used seconds against the same lifetime.
 * @param {object} profile the MIoT profile
 * @param {Array<object>} results the get_properties result
 * @returns {object} the consumables, with the Roborock field names
 */
export function consumableFromProperties(profile, results) {
  const values = valuesByName(profile.consumables, results);
  const consumable = {};
  for (const [field, { lifetime }] of Object.entries(profile.consumables)) {
    const percent = Number(values[field]);
    if (values[field] !== undefined && Number.isFinite(percent)) {
      consumable[field] = Math.round(((100 - percent) / 100) * lifetime);
    }
  }
  return consumable;
}

/**
 * Translate a Roborock command into the MIoT request a robot understands.
 * @param {object} profile the MIoT profile
 * @param {string} did the device id
 * @param {string} method the Roborock method
 * @param {Array} params the Roborock params
 * @returns {{ method: string, params: object|Array }|null} the MIoT request, or
 *   null when the model has no equivalent
 */
export function commandToMiot(profile, did, method, params = []) {
  const action = profile.actions[method];
  if (action) {
    return { method: 'action', params: { did, siid: action.siid, aiid: action.aiid, in: [] } };
  }
  if (method === ROBOROCK_METHOD.APP_SEGMENT_CLEAN && profile.roomClean) {
    const request = Array.isArray(params) ? params[0] : params;
    const segments = (request && Array.isArray(request.segments) ? request.segments : []).map(
      Number,
    );
    // Never an empty or malformed list: the robot reads no room ids as "clean
    // everything". The ids go as a string: an integer is read as no ids too.
    if (segments.length === 0 || !segments.every((id) => Number.isSafeInteger(id) && id >= 0)) {
      return null;
    }
    const { siid, aiid } = profile.roomClean;
    return { method: 'action', params: { did, siid, aiid, in: [segments.join(',')] } };
  }
  if (method === ROBOROCK_METHOD.SET_FAN_POWER) {
    const fanPower = Number(Array.isArray(params) ? params[0] : params);
    const entry = Object.entries(profile.fanPowers).find(([, power]) => power === fanPower);
    if (!entry) {
      return null;
    }
    const { siid, piid } = profile.status.fan_power;
    return { method: 'set_properties', params: [{ did, siid, piid, value: Number(entry[0]) }] };
  }
  return null;
}

/**
 * Throw when a MIoT answer reports a failure: an action answers `{ code }`, a
 * set_properties one `[{ code }]`.
 * @param {*} result the MIoT answer
 * @param {string} method the MIoT method that was sent
 */
export function assertMiotSuccess(result, method) {
  const answers = Array.isArray(result) ? result : [result];
  const failed = answers.find((answer) => answer && answer.code !== undefined && answer.code !== 0);
  if (failed) {
    throw new Error(`MIoT ${method} refused by the robot (code ${failed.code})`);
  }
}
