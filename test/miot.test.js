// The MIoT adapter (src/xiaomi/miot.js) and how the client routes the requests
// of a MIoT robot through it. The answers below follow the shape the Xiaomi
// Robot Vacuum S20+ (xiaomi.vacuum.b108gl) gives to get_properties / action.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONSUMABLE_LIFETIME, ROBOROCK_METHOD } from '../src/constants.js';
import { buildConsumableStates, buildPollStates } from '../src/devices/vacuum.js';
import { fakeVacuumIds } from './helpers/fakeGladys.js';
import { buildMapWidgetContent } from '../src/devices/mapWidget.js';
import {
  SCENE_TRIGGERS,
  computeSceneEvents,
  snapshotFromStatus,
} from '../src/devices/sceneTriggers.js';
import {
  MIOT_VACUUM_PROFILES,
  assertMiotSuccess,
  commandToMiot,
  consumableFromProperties,
  miotProfile,
  propertiesRequest,
  statusFromProperties,
} from '../src/xiaomi/miot.js';
import { XiaomiClient } from '../src/xiaomi/client.js';

const DID = '1068496858';
const MODEL = 'xiaomi.vacuum.b108gl';
const PROFILE = MIOT_VACUUM_PROFILES[MODEL];

const prop = (siid, piid, value, code = 0) => ({ did: DID, siid, piid, code, value });

// Docked and fully charged, balanced suction.
const STATUS_ANSWER = [
  prop(2, 1, 8),
  prop(2, 2, 0),
  prop(2, 5, 3200), // 32 m², in hundredths of m²
  prop(2, 6, 1860),
  prop(2, 8, 2),
  prop(3, 1, 100),
];

const CONSUMABLE_ANSWER = [prop(8, 2, 90), prop(9, 2, 50), prop(10, 2, 0)];

test('only the models with a profile are MIoT', () => {
  assert.equal(miotProfile(MODEL), PROFILE);
  assert.equal(miotProfile('roborock.vacuum.s5'), null);
  assert.equal(miotProfile(null), null);
});

test('get_properties asks for every property of the profile', () => {
  assert.deepEqual(propertiesRequest(DID, PROFILE.status), [
    { did: DID, siid: 2, piid: 1 },
    { did: DID, siid: 2, piid: 2 },
    { did: DID, siid: 2, piid: 5 },
    { did: DID, siid: 2, piid: 6 },
    { did: DID, siid: 2, piid: 8 },
    { did: DID, siid: 2, piid: 4 },
    { did: DID, siid: 3, piid: 1 },
  ]);
});

test('a MIoT status is reshaped as a Roborock get_status result', () => {
  assert.deepEqual(statusFromProperties(PROFILE, STATUS_ANSWER), {
    state: 100, // charging_complete
    error_code: 0,
    clean_area: 32e6,
    clean_time: 1860,
    fan_power: 102,
    battery: 100,
  });
});

test('every MIoT status of the S20+ maps to a Roborock state', () => {
  const expected = { 1: 3, 2: 8, 3: 8, 4: 5, 5: 10, 6: 6, 7: 7, 8: 100, 9: 29, 10: 14 };
  for (const [miot, roborock] of Object.entries(expected)) {
    assert.equal(statusFromProperties(PROFILE, [prop(2, 1, Number(miot))]).state, roborock);
  }
  // an unknown status is reported as unknown
  assert.equal(statusFromProperties(PROFILE, [prop(2, 1, 42)]).state, 0);
});

test('a MIoT fault is an error state, labelled without the Roborock table', () => {
  const status = statusFromProperties(PROFILE, [prop(2, 1, 1), prop(2, 2, 2)]);
  // Roborock code 2 would read "Pare-chocs bloqué": not what an S20+ fault 2 means.
  assert.deepEqual(status, { state: 12, error_code: 2, error_label: 'Erreur 2' });

  const labelled = { ...PROFILE, errors: { 2: 'Roue bloquée' } };
  assert.equal(statusFromProperties(labelled, [prop(2, 2, 2)]).error_label, 'Roue bloquée');

  // No fault: the MIoT status stands.
  assert.deepEqual(statusFromProperties(PROFILE, [prop(2, 1, 1), prop(2, 2, 0)]), {
    state: 3,
    error_code: 0,
  });
});

test('a MIoT fault fires the error scene trigger with its own label', () => {
  const before = snapshotFromStatus(statusFromProperties(PROFILE, [prop(2, 1, 1), prop(2, 2, 0)]));
  const after = snapshotFromStatus(statusFromProperties(PROFILE, [prop(2, 1, 1), prop(2, 2, 2)]));
  const events = computeSceneEvents(before, after, {
    vacuum: 'ext:test:vacuum:1',
    deviceName: 'S20+',
  });
  const error = events.find((event) => event.key === SCENE_TRIGGERS.ROBOT_ERROR);
  assert.equal(error.data.error_code, 2);
  assert.equal(error.data.error_label, 'Erreur 2');
});

test('the properties the robot refuses are left out', () => {
  const status = statusFromProperties(PROFILE, [prop(2, 1, 4), prop(3, 1, 0, -4004)]);
  assert.deepEqual(status, { state: 5 });
});

test('the reshaped status feeds the existing Gladys states', () => {
  const ids = fakeVacuumIds(DID);
  const states = buildPollStates(ids, statusFromProperties(PROFILE, STATUS_ANSWER));
  const byCode = Object.fromEntries(
    states.map((state) => [state.device_feature_external_id.split(':').pop(), state.state]),
  );
  assert.deepEqual(byCode, {
    state: 6, // docked
    'run-mode': 0, // idle
    'clean-mode': 0, // auto
    battery: 100,
  });
});

test('remaining percentages survive the round trip through used seconds', () => {
  const consumable = consumableFromProperties(PROFILE, CONSUMABLE_ANSWER);
  assert.deepEqual(consumable, {
    main_brush_work_time: Math.round(0.1 * CONSUMABLE_LIFETIME.MAIN_BRUSH_SECONDS),
    side_brush_work_time: Math.round(0.5 * CONSUMABLE_LIFETIME.SIDE_BRUSH_SECONDS),
    filter_work_time: CONSUMABLE_LIFETIME.FILTER_SECONDS,
  });

  const ids = fakeVacuumIds(DID);
  const percents = Object.fromEntries(
    buildConsumableStates(ids, consumable).map((state) => [
      state.device_feature_external_id.split(':').pop(),
      state.state,
    ]),
  );
  assert.deepEqual(percents, { 'main-brush': 90, 'side-brush': 50, filter: 0 });
});

test('the Roborock commands become MIoT actions', () => {
  const action = (siid, aiid) => ({ method: 'action', params: { did: DID, siid, aiid, in: [] } });
  assert.deepEqual(commandToMiot(PROFILE, DID, ROBOROCK_METHOD.APP_START), action(2, 1));
  assert.deepEqual(commandToMiot(PROFILE, DID, ROBOROCK_METHOD.APP_STOP), action(2, 2));
  assert.deepEqual(commandToMiot(PROFILE, DID, ROBOROCK_METHOD.APP_PAUSE), action(2, 6));
  assert.deepEqual(commandToMiot(PROFILE, DID, ROBOROCK_METHOD.APP_CHARGE), action(3, 1));
});

test('the fan power becomes the MIoT suction level', () => {
  assert.deepEqual(commandToMiot(PROFILE, DID, ROBOROCK_METHOD.SET_FAN_POWER, [103]), {
    method: 'set_properties',
    params: [{ did: DID, siid: 2, piid: 8, value: 3 }],
  });
  // gentle (105) has no MIoT equivalent on this model
  assert.equal(commandToMiot(PROFILE, DID, ROBOROCK_METHOD.SET_FAN_POWER, [105]), null);
  assert.equal(commandToMiot(PROFILE, DID, ROBOROCK_METHOD.APP_SEGMENT_CLEAN, [{}]), null);
});

test('a room cleaning becomes start-vacuum-room-sweep, the room ids as a string', () => {
  assert.deepEqual(
    commandToMiot(PROFILE, DID, ROBOROCK_METHOD.APP_SEGMENT_CLEAN, [{ segments: [12, 3] }]),
    { method: 'action', params: { did: DID, siid: 2, aiid: 13, in: ['12,3'] } },
  );
  // No room or a malformed id would read as "clean everything": refused.
  for (const segments of [[], ['salon'], [-1], [1.5]]) {
    assert.equal(
      commandToMiot(PROFILE, DID, ROBOROCK_METHOD.APP_SEGMENT_CLEAN, [{ segments }]),
      null,
    );
  }
  // A profile without roomClean refuses it too.
  assert.equal(
    commandToMiot({ ...PROFILE, roomClean: undefined }, DID, ROBOROCK_METHOD.APP_SEGMENT_CLEAN, [
      { segments: [12] },
    ]),
    null,
  );
});

test('sweeping with the SelectRoom sweep type is a segment cleaning', () => {
  assert.equal(statusFromProperties(PROFILE, [prop(2, 1, 4), prop(2, 4, 8)]).state, 18);
  assert.equal(statusFromProperties(PROFILE, [prop(2, 1, 4), prop(2, 4, 1)]).state, 5);
  assert.equal(statusFromProperties(PROFILE, [prop(2, 1, 1), prop(2, 4, 8)]).state, 3);
});

test('a refused MIoT command throws', () => {
  assert.doesNotThrow(() => assertMiotSuccess({ code: 0 }, 'action'));
  assert.doesNotThrow(() => assertMiotSuccess([{ code: 0 }], 'set_properties'));
  assert.throws(() => assertMiotSuccess({ code: -4004 }, 'action'), /code -4004/);
  assert.throws(() => assertMiotSuccess([{ code: -4001 }], 'set_properties'), /code -4001/);
});

// --- Client routing ------------------------------------------------------------

/**
 * A client knowing one MIoT robot, whose (cloud) transport answers like it.
 * @returns {{ client: XiaomiClient, sent: Array<object> }} the client and the RPCs sent
 */
function miotClient() {
  const sent = [];
  const client = new XiaomiClient({}, { preferLocal: false });
  client.devices = [{ duid: DID, name: 'S20+', model: MODEL, online: true, rooms: [] }];
  client.cloud = {
    isLoggedIn: () => true,
    async rpc(did, rpc) {
      sent.push({ method: rpc.method, params: rpc.params });
      if (rpc.method === 'get_properties') {
        const asked = rpc.params.map(({ siid, piid }) => `${siid}.${piid}`);
        return [...STATUS_ANSWER, ...CONSUMABLE_ANSWER].filter((answer) =>
          asked.includes(`${answer.siid}.${answer.piid}`),
        );
      }
      return { code: 0 };
    },
  };
  return { client, sent };
}

test('a MIoT robot is polled with get_properties, never get_status', async () => {
  const { client, sent } = miotClient();
  const status = await client.getStatus(DID);
  assert.equal(status.state, 100);
  assert.equal(status.battery, 100);
  const consumable = await client.getConsumable(DID);
  assert.equal(consumable.filter_work_time, CONSUMABLE_LIFETIME.FILTER_SECONDS);
  assert.deepEqual(
    sent.map((rpc) => rpc.method),
    ['get_properties', 'get_properties'],
  );
});

test('a MIoT robot receives the MIoT action of a Roborock command', async () => {
  const { client, sent } = miotClient();
  await client.sendCommand(DID, ROBOROCK_METHOD.APP_START, []);
  assert.deepEqual(sent, [{ method: 'action', params: { did: DID, siid: 2, aiid: 1, in: [] } }]);
});

test('a command without MIoT equivalent is refused before reaching the robot', async () => {
  const { client, sent } = miotClient();
  await assert.rejects(client.sendCommand(DID, ROBOROCK_METHOD.GET_MAP_V1, []), /not supported/);
  assert.deepEqual(sent, []);
});

test('a MIoT robot has no cleaning history', async () => {
  const { client, sent } = miotClient();
  assert.equal(await client.getCleanSummary(DID), null);
  assert.deepEqual(sent, []);
});

test('a MIoT robot has a map only when its profile says how to fetch it', () => {
  const { client } = miotClient();
  client.devices.push(
    { duid: '42', name: 'S5', model: 'roborock.vacuum.s5', rooms: [] },
    { duid: '43', name: 'Other', model: 'xiaomi.vacuum.test', rooms: [] },
  );
  MIOT_VACUUM_PROFILES['xiaomi.vacuum.test'] = { ...PROFILE, map: undefined };
  try {
    assert.equal(client.supportsMap(DID), true);
    assert.equal(client.supportsMap('42'), true);
    assert.equal(client.supportsMap('43'), false);
  } finally {
    delete MIOT_VACUUM_PROFILES['xiaomi.vacuum.test'];
  }
});

test('the widget of a robot without a map keeps its tiles, status and buttons', () => {
  const content = buildMapWidgetContent(null, {
    imageKey: null,
    vacuumExternalId: 'ext:test:vacuum:1068496858',
    status: statusFromProperties(PROFILE, STATUS_ANSWER),
    consumables: { mainBrush: 90, sideBrush: 50, filter: 0, sensor: null },
  });
  const types = content.components.map((component) => component.type);
  assert.equal(types.includes('image'), false);
  assert.deepEqual(types, ['value', 'gauge', 'status', 'button', 'button']);
  assert.equal(content.components[1].value, 32); // cleaned surface, m²
});
