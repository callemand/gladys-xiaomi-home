import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRRMap, PIXEL_SIZE_MM, RRMAP_BLOCK } from '../src/map/mapParser.js';
import { attachRoomNames } from '../src/xiaomi/rooms.js';

import { buildSyntheticMap } from './helpers/syntheticMap.js';

test('parseRRMap rejects a non-RRMap buffer', () => {
  assert.throws(() => parseRRMap(Buffer.from('not a map')), /rr/);
});

test('parseRRMap extracts the top-level header', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.deepEqual(map.version, { major: 1, minor: 0 });
  assert.equal(map.mapIndex, 42);
  assert.equal(map.mapSequence, 7);
  assert.equal(map.pixelSizeMm, PIXEL_SIZE_MM);
});

test('parseRRMap reads the image bounds and per-segment pixel stats', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.equal(map.image.width, 4);
  assert.equal(map.image.height, 4);
  assert.equal(map.image.top, 5);
  assert.equal(map.image.left, 6);
  assert.equal(map.image.segmentCountDeclared, 2);
  assert.equal(map.image.wallPixels, 2);
  assert.equal(map.image.segmentCountInPixels, 2);
  assert.deepEqual(
    map.segments.map((s) => ({ id: s.segmentId, px: s.pixelCount })),
    [
      { id: 2, px: 2 },
      { id: 3, px: 2 },
    ],
  );
});

test('parseRRMap reads robot and dock positions', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.deepEqual(map.charger, { x: 100, y: 200, angle: 45 });
  assert.deepEqual(map.robot, { x: 110, y: 210, angle: -90 });
});

test('parseRRMap reads the cleaning path points', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.equal(map.path.pointCount, 2);
  assert.deepEqual(map.path.points, [
    { x: 300, y: 400 },
    { x: 320, y: 420 },
  ]);
});

test('parseRRMap reads no-go areas and virtual walls', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.equal(map.noGoAreas.length, 1);
  assert.equal(map.noGoAreas[0].length, 4);
  assert.deepEqual(map.noGoAreas[0][0], { x: 10, y: 10 });
  assert.equal(map.virtualWalls.length, 2);
  assert.deepEqual(map.virtualWalls[0], { x0: 1, y0: 2, x1: 3, y1: 4 });
  assert.deepEqual(map.virtualWalls[1], { x0: 5, y0: 6, x1: 7, y1: 8 });
});

test('parseRRMap records every block type it walked, ending cleanly', () => {
  const map = parseRRMap(buildSyntheticMap());
  assert.ok(map.blocksSeen.includes(RRMAP_BLOCK.IMAGE));
  assert.ok(map.blocksSeen.includes(RRMAP_BLOCK.DIGEST));
});

test('attachRoomNames names the segments that get_room_mapping knows, keeps the rest', () => {
  const map = parseRRMap(buildSyntheticMap()); // segments 2 and 3
  // get_room_mapping named segment 2 "Cuisine" but not segment 3.
  const named = attachRoomNames(map.segments, [{ id: 2, name: 'Cuisine' }]);
  const seg2 = named.find((s) => s.segmentId === 2);
  const seg3 = named.find((s) => s.segmentId === 3);
  assert.equal(seg2.roomName, 'Cuisine');
  assert.equal(seg2.named, true);
  assert.equal(seg3.roomName, null);
  assert.equal(seg3.named, false);
  // the pixel stats are preserved through the merge
  assert.equal(seg2.pixelCount, 2);
});

test('attachRoomNames tolerates no room mapping', () => {
  const map = parseRRMap(buildSyntheticMap());
  const named = attachRoomNames(map.segments, []);
  assert.equal(named.length, map.segments.length);
  assert.ok(named.every((s) => s.named === false && s.roomName === null));
});
