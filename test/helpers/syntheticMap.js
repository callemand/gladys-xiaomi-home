// -----------------------------------------------------------------------------
// A small, hand-built RRMap (the map format get_map_v1 leads to), shared by the
// parser unit tests and the end-to-end test that serves it from the fake cloud.
// -----------------------------------------------------------------------------

import { RRMAP_BLOCK } from '../../src/map/mapParser.js';

// --- helpers to build a synthetic RRMap ------------------------------------
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}
function i32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n, 0);
  return b;
}

// A block = type | header_len | data_len | headerExtra | data.
function block(type, headerExtra, data) {
  const headerLen = 8 + headerExtra.length;
  return Buffer.concat([u16(type), u16(headerLen), u32(data.length), headerExtra, data]);
}

// A segment pixel: low 3 bits = type (7 = floor-in-segment), high 5 = segment id.
function segPixel(id) {
  return ((id << 3) | 7) & 0xff;
}
const WALL = 1;

export function buildSyntheticMap() {
  // 4x4 image: a wall row, then two 2-pixel segments (ids 2 and 3).
  const width = 4;
  const height = 4;
  // prettier-ignore
  const pixels = Buffer.from([
    0,    WALL, WALL, 0,
    0,    segPixel(2), segPixel(2), 0,
    0,    segPixel(3), segPixel(3), 0,
    0,    0,    0,    0,
  ]);
  const imageHeader = Buffer.concat([
    u32(2), // segment count (g3 layout, since headerExtra > 16 bytes)
    u32(5), // top
    u32(6), // left
    u32(height),
    u32(width),
  ]);
  const image = block(RRMAP_BLOCK.IMAGE, imageHeader, pixels);

  const charger = block(
    RRMAP_BLOCK.CHARGER_LOCATION,
    Buffer.alloc(0),
    Buffer.concat([i32(100), i32(200), i32(45)]),
  );
  const robot = block(
    RRMAP_BLOCK.ROBOT_POSITION,
    Buffer.alloc(0),
    Buffer.concat([i32(110), i32(210), i32(-90)]),
  );

  const pathHeader = Buffer.concat([u32(2), u32(4), i32(0)]); // pointCount, pointSize, angle
  const pathData = Buffer.concat([u16(300), u16(400), u16(320), u16(420)]);
  const path = block(RRMAP_BLOCK.PATH, pathHeader, pathData);

  // one no-go quadrilateral (4 points)
  const noGoData = Buffer.concat([
    u16(10),
    u16(10),
    u16(20),
    u16(10),
    u16(20),
    u16(20),
    u16(10),
    u16(20),
  ]);
  const noGo = block(RRMAP_BLOCK.NO_GO_AREAS, u32(1), noGoData);

  // two virtual walls (2 points each)
  const wallsData = Buffer.concat([u16(1), u16(2), u16(3), u16(4), u16(5), u16(6), u16(7), u16(8)]);
  const walls = block(RRMAP_BLOCK.VIRTUAL_WALLS, u32(2), wallsData);

  const digest = block(RRMAP_BLOCK.DIGEST, Buffer.alloc(0), u32(0));

  const body = Buffer.concat([image, charger, robot, path, noGo, walls, digest]);
  const header = Buffer.concat([
    Buffer.from('rr'),
    u16(20), // header length
    u32(body.length),
    u16(1), // major
    u16(0), // minor
    u32(42), // map index
    u32(7), // map sequence
  ]);
  return Buffer.concat([header, body]);
}
