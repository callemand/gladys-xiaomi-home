// How the client gets a map through Mi Home: get_map_v1 names the file the robot
// uploaded, the Xiaomi cloud gives its download URL, the file is a gzipped RRMap.
// The robot and the cloud are stubbed; the parser and the room names are real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { XiaomiClient } from '../src/xiaomi/client.js';
import { buildSyntheticMap } from './helpers/syntheticMap.js';

const DUID = '123456789';
const MAP_NAME = 'robomap/123456789/7';

/**
 * A client whose robot answers get_map_v1 with the given names, in turn, and
 * whose cloud serves the given map file.
 * @param {object} [options] options
 * @param {Array<*>} [options.names] successive get_map_v1 results
 * @param {Buffer} [options.file] the map file the cloud serves
 * @returns {{ client: XiaomiClient, calls: string[] }} the client and the call log
 */
function stubbedClient({ names = [[MAP_NAME]], file = gzipSync(buildSyntheticMap()) } = {}) {
  const calls = [];
  const client = new XiaomiClient({}, { mapRetryDelayMs: 1 });
  client.devices = [
    {
      duid: DUID,
      rooms: [
        { id: 2, name: 'Cuisine' },
        { id: 9, name: 'Garage' },
      ],
    },
  ];
  client.cloud = {
    isLoggedIn: () => true,
    async getMapFileUrl(name) {
      calls.push(`url:${name}`);
      return 'https://maps.example/file';
    },
    async downloadMapFile(url) {
      calls.push(`download:${url}`);
      return file;
    },
  };
  const pending = [...names];
  client.localTransports.set(DUID, {
    async request(method) {
      calls.push(method);
      return pending.length > 1 ? pending.shift() : pending[0];
    },
    disconnect() {},
  });
  return { client, calls };
}

test('the map named by get_map_v1 is downloaded, unzipped and parsed', async () => {
  const { client, calls } = stubbedClient();
  const map = await client.getMap(DUID, { includePixels: true });
  assert.deepEqual(calls, ['get_map_v1', `url:${MAP_NAME}`, 'download:https://maps.example/file']);
  assert.equal(map.mapSequence, 7);
  assert.ok(map.image.pixels, 'the pixel grid is kept for the renderer');
});

test('the segments carry the room names of the account', async () => {
  const { client } = stubbedClient();
  const map = await client.getMap(DUID);
  const names = Object.fromEntries(map.segments.map((s) => [s.segmentId, s.roomName]));
  assert.deepEqual(names, { 2: 'Cuisine', 3: null });
  assert.equal(map.namedSegmentCount, 1);
});

test('"retry" is asked again, until the robot names its map', async () => {
  const { client, calls } = stubbedClient({ names: [['retry'], ['retry'], [MAP_NAME]] });
  await client.getMap(DUID);
  assert.deepEqual(
    calls.filter((call) => call === 'get_map_v1'),
    ['get_map_v1', 'get_map_v1', 'get_map_v1'],
  );
});

test('a robot that never names its map is an error, and nothing is downloaded', async () => {
  const { client, calls } = stubbedClient({ names: [['retry']] });
  await assert.rejects(client.getMap(DUID), /did not name its map/);
  assert.equal(
    calls.some((call) => call.startsWith('download')),
    false,
  );
});

test('a map file served uncompressed is parsed as well', async () => {
  const { client } = stubbedClient({ file: buildSyntheticMap() });
  assert.equal((await client.getMap(DUID)).mapSequence, 7);
});

test('without the cloud there is no map', async () => {
  const { client } = stubbedClient();
  client.cloud = null;
  await assert.rejects(client.getMap(DUID), /Xiaomi cloud/);
});
