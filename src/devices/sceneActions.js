// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`).
//
// A scene action is a command the scene engine sends to the integration
// (onSceneAction). Each action carries a `vacuum` field (source: "devices") so
// the author picks the target robot; index.js parses its duid and forwards the
// miIO RPC. These helpers resolve the free-text `rooms` field the manifest
// cannot populate dynamically, and stay pure for unit testing.
// -----------------------------------------------------------------------------

import { VACUUM_CLEANER_CLEAN_MODE } from '../constants.js';

// Stable manifest keys (never renamed once published).
export const SCENE_ACTIONS = {
  START_CLEANING: 'start_cleaning',
  CLEAN_ROOMS: 'clean_rooms',
  PAUSE_CLEANING: 'pause_cleaning',
  STOP_CLEANING: 'stop_cleaning',
  RETURN_TO_DOCK: 'return_to_dock',
  SET_FAN_POWER: 'set_fan_power',
};

// `mode` field value (manifest select) -> internal clean-mode value.
export const FAN_POWER_MODES = {
  quiet: VACUUM_CLEANER_CLEAN_MODE.QUIET,
  balanced: VACUUM_CLEANER_CLEAN_MODE.AUTO,
  turbo: VACUUM_CLEANER_CLEAN_MODE.DEEP_CLEAN,
  max: VACUUM_CLEANER_CLEAN_MODE.VACUUM,
};

/**
 * Resolve the free-text `rooms` field to the robot's segment ids.
 *
 * Accepts a comma-separated list of room NAMES (matched case-insensitively
 * against the robot's rooms) and/or raw numeric segment ids. Unknown names are
 * skipped; duplicates are removed.
 * @param {string} input the `rooms` field value (e.g. "Cuisine, Salon")
 * @param {Array<{id: number, name: string}>} rooms the robot's rooms
 * @returns {number[]} the resolved segment ids
 */
export function resolveRoomSegments(input, rooms = []) {
  const byName = new Map(
    rooms
      .filter((room) => room && room.name !== undefined && room.id !== undefined)
      .map((room) => [String(room.name).trim().toLowerCase(), Number(room.id)]),
  );
  const ids = [];
  for (const token of String(input || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (/^\d+$/.test(token)) {
      ids.push(Number(token));
      continue;
    }
    const id = byName.get(token.toLowerCase());
    if (id !== undefined && Number.isSafeInteger(id)) {
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}
