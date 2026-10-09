import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAN_POWER_MODES,
  SCENE_ACTIONS,
  resolveRoomSegments,
} from '../src/devices/sceneActions.js';
import { VACUUM_CLEANER_CLEAN_MODE } from '../src/constants.js';

const ROOMS = [
  { id: 16, name: 'Cuisine' },
  { id: 17, name: 'Salon' },
  { id: 18, name: 'Chambre' },
];

test('the action keys are the stable manifest keys', () => {
  assert.equal(SCENE_ACTIONS.CLEAN_ROOMS, 'clean_rooms');
  assert.equal(SCENE_ACTIONS.SET_FAN_POWER, 'set_fan_power');
});

test('resolveRoomSegments matches room names case-insensitively', () => {
  assert.deepEqual(resolveRoomSegments('Cuisine, salon', ROOMS), [16, 17]);
});

test('resolveRoomSegments accepts raw ids and drops unknown names and duplicates', () => {
  assert.deepEqual(resolveRoomSegments('99, Cuisine, Cuisine, Garage', ROOMS), [99, 16]);
});

test('resolveRoomSegments returns an empty array for empty input', () => {
  assert.deepEqual(resolveRoomSegments('', ROOMS), []);
  assert.deepEqual(resolveRoomSegments(undefined, ROOMS), []);
});

test('FAN_POWER_MODES maps the manifest modes to clean-mode values', () => {
  assert.equal(FAN_POWER_MODES.quiet, VACUUM_CLEANER_CLEAN_MODE.QUIET);
  assert.equal(FAN_POWER_MODES.balanced, VACUUM_CLEANER_CLEAN_MODE.AUTO);
  assert.equal(FAN_POWER_MODES.turbo, VACUUM_CLEANER_CLEAN_MODE.DEEP_CLEAN);
  assert.equal(FAN_POWER_MODES.max, VACUUM_CLEANER_CLEAN_MODE.VACUUM);
});
