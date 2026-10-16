// The JSON map of the MIoT robots Xiaomi builds itself (src/map/xiaomiJsonMap.js):
// a synthetic map is encrypted the way the robot does, then read back through
// the client, down to the PNG the widget shows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { renderMapPngBase64 } from '../src/map/mapRender.js';
import { decryptJsonMap, mapObjectName, parseJsonMap } from '../src/map/xiaomiJsonMap.js';
import { XiaomiClient } from '../src/xiaomi/client.js';

const DID = '1068496858';
const MODEL = 'xiaomi.vacuum.b108gl';
const OBJECT_NAME = `1234567890/${DID}/5`;
const IV = Buffer.from('ABCDEF1234123412', 'latin1');

/**
 * Encrypt a JSON map into the `{"version":2,"data":…}` envelope the robot uploads.
 * @param {object} payload the JSON map
 * @returns {Buffer} the envelope file
 */
function envelopeOf(payload) {
  const modelKey = Buffer.from(MODEL.slice(-16), 'latin1');
  const workCipher = createCipheriv('aes-128-cbc', modelKey, IV);
  const work = Buffer.concat([
    workCipher.update(Buffer.concat([modelKey, Buffer.from(DID, 'latin1')])),
    workCipher.final(),
  ]);
  const key = createHash('md5').update(work).digest();
  const cipher = createCipheriv('aes-128-cbc', key, IV);
  const data = Buffer.concat([
    cipher.update(deflateSync(Buffer.from(JSON.stringify(payload)))),
    cipher.final(),
  ]).toString('base64');
  return Buffer.from(JSON.stringify({ version: 2, data }));
}

// A 6x4 map: a wall border around two rooms (grid ids 3 and 4) and one floor cell.
// prettier-ignore
const CELLS = [
  255, 255, 255, 255, 255, 255,
  255,   3,   3,   4,   4, 255,
  255,   3,   1,   4,   4, 255,
  255, 255, 255, 255, 255, 255,
];

const PAYLOAD = {
  map_id: 3,
  width: 6,
  height: 4,
  resolution: 50,
  origin_x: -100,
  origin_y: -50,
  map_data: deflateSync(Buffer.from(CELLS)).toString('base64'),
  have_pile: true,
  pile_x: 25,
  pile_y: 25,
  pile_yaw: 0,
  position: { x: 50, y: 50, yaw: Math.PI / 2 },
  paths: {
    points: [
      { x: 0, y: 0 },
      { x: 50, y: 25 },
    ],
  },
  map_room_info: [{ grid_id: 4, room_id: 12 }],
  room_attrs: [
    { grid_id: 3, name: 'Salon' },
    { room_id: 12, name: 'Cuisine' },
  ],
};

test('the map object name comes from the map-obj-name JSON, or the bare name', () => {
  assert.equal(mapObjectName(JSON.stringify({ index: 1, obj_name: OBJECT_NAME })), OBJECT_NAME);
  assert.equal(mapObjectName(OBJECT_NAME), OBJECT_NAME);
  assert.equal(mapObjectName(JSON.stringify({ index: 1 })), null);
  assert.equal(mapObjectName(''), null);
});

test('the envelope decrypts back to the JSON map', () => {
  assert.deepEqual(decryptJsonMap(envelopeOf(PAYLOAD), MODEL, DID), PAYLOAD);
  assert.throws(() => decryptJsonMap(Buffer.from('{"version":1}'), MODEL, DID), /version 1/);
});

test('the JSON map becomes the structure the renderer reads', () => {
  const map = parseJsonMap(PAYLOAD, { includePixels: true });
  assert.equal(map.pixelSizeMm, 50);
  assert.deepEqual(
    map.segments.map(({ segmentId, pixelCount, roomId, roomName, named }) => ({
      segmentId,
      pixelCount,
      roomId,
      roomName,
      named,
    })),
    [
      { segmentId: 1, pixelCount: 1, roomId: 1, roomName: null, named: false }, // floor, no room
      { segmentId: 3, pixelCount: 3, roomId: 3, roomName: 'Salon', named: true },
      { segmentId: 4, pixelCount: 4, roomId: 12, roomName: 'Cuisine', named: true }, // via room_id 12
    ],
  );
  assert.equal(map.image.left, -2);
  assert.equal(map.image.top, -1);
  assert.equal(map.image.pixels[0], 1); // wall
  assert.equal(map.image.pixels[7], (3 << 3) | 7); // room 3
  assert.deepEqual(map.robot, { x: 50, y: 50, angle: 90 });
  assert.deepEqual(map.charger, { x: 25, y: 25, angle: 0 });
  assert.equal(map.path.points.length, 2);
  assert.match(renderMapPngBase64(map), /^iVBORw0KGgo/); // a PNG
});

test('an empty map (nothing uploaded yet) is refused', () => {
  assert.throws(
    () => parseJsonMap({ ...PAYLOAD, width: 1, height: 1 }),
    /has not uploaded a map yet/,
  );
});

test('the client fetches the file named by map-obj-name', async () => {
  const fetched = [];
  const client = new XiaomiClient({}, { preferLocal: false });
  client.devices = [{ duid: DID, name: 'S20+', model: MODEL, online: true, rooms: [] }];
  client.cloud = {
    isLoggedIn: () => true,
    async rpc(did, rpc) {
      assert.deepEqual(rpc.params, [{ did: DID, siid: 7, piid: 1 }]);
      return [
        {
          did: DID,
          siid: 7,
          piid: 1,
          code: 0,
          value: JSON.stringify({ index: 1, obj_name: OBJECT_NAME }),
        },
      ];
    },
    async getInterimFileUrl(objectName) {
      fetched.push(objectName);
      return 'https://example.invalid/map';
    },
    async downloadMapFile() {
      return envelopeOf(PAYLOAD);
    },
  };
  const map = await client.getMap(DID);
  assert.deepEqual(fetched, [OBJECT_NAME]);
  assert.equal(map.namedSegmentCount, 2);
  assert.equal(map.image.pixels, undefined);
});
