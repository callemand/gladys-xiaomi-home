// -----------------------------------------------------------------------------
// Xiaomi JSON map — the map of the MIoT robots Xiaomi builds itself (S20+ and
// kin), turned into the same structure parseRRMap() yields, so the renderer
// draws it unchanged.
//
// The robot names its current map file in its `map-obj-name` property
// (`{"index":…,"obj_name":"<user id>/<did>/<n>"}`) and uploads it to the Xiaomi
// cloud as a `{"version":2,"data":"<base64>"}` envelope: AES-128-CBC with a
// fixed IV, the key derived from the model and the device id, the plaintext a
// zlib-compressed JSON map. In that JSON, the grid is itself base64 + zlib, one
// byte per cell: 0 outside, 1-2 floor, 3-63 a room (its grid id), above a wall.
// Coordinates are millimetres.
//
// Envelope decryption from the Xiaomi Home app as reverse-engineered by
// xiaomi-vac; map layout from vacuum-map-parser-xiaomi (Apache-2.0):
// reimplemented, not copied.
// -----------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const ENVELOPE_IV = Buffer.from('ABCDEF1234123412', 'latin1');

// Grid cell values.
const CELL_OUTSIDE = 0;
const CELL_FLOOR_MAX = 2;
const CELL_ROOM_MAX = 63;

// RRMap pixel encoding the renderer reads: low 3 bits = type, the rest = segment.
const RR_WALL = 1;
const RR_FLOOR = 7;
// Floor that belongs to no room gets a segment of its own, left unnamed like
// the unsegmented floor of a Roborock map. Room grid ids start at 3, so 1 is free.
const FLOOR_SEGMENT_ID = 1;

/**
 * The map object name a robot gives in its `map-obj-name` property.
 * @param {*} value the raw property value: `{"obj_name": …}` JSON, or the name
 * @returns {string|null} the object name, or null when there is none
 */
export function mapObjectName(value) {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.obj_name === 'string' && parsed.obj_name) {
      return parsed.obj_name;
    }
    return null;
  } catch {
    return value; // a bare object name
  }
}

/**
 * Decrypt a downloaded map file into the JSON map.
 * @param {Buffer} file the `{"version":2,"data":…}` envelope served by the cloud
 * @param {string} model the Mi Home model
 * @param {string} did the device id
 * @returns {object} the JSON map
 */
export function decryptJsonMap(file, model, did) {
  let envelope;
  try {
    envelope = JSON.parse(file.toString('utf8'));
  } catch {
    throw new Error(`The map file is not a JSON envelope (${file.length} bytes)`);
  }
  if (!envelope || envelope.version !== 2 || typeof envelope.data !== 'string') {
    throw new Error(`Unsupported map envelope (version ${envelope && envelope.version})`);
  }
  // The key: MD5 of (model tail + did), AES-CBC-encrypted with the model tail.
  const modelKey = Buffer.from(model.slice(-16), 'latin1');
  const cipher = createCipheriv('aes-128-cbc', modelKey, ENVELOPE_IV);
  const work = Buffer.concat([
    cipher.update(Buffer.concat([modelKey, Buffer.from(did, 'latin1')])),
    cipher.final(),
  ]);
  const key = createHash('md5').update(work).digest();
  const decipher = createDecipheriv('aes-128-cbc', key, ENVELOPE_IV);
  const plain = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(inflateSync(plain).toString('utf8'));
}

/**
 * Map a grid cell to the RRMap encoding the renderer reads.
 * @param {number} value the cell
 * @returns {number} the RRMap pixel (0 outside)
 */
function toRRPixel(value) {
  if (value === CELL_OUTSIDE) {
    return 0;
  }
  if (value <= CELL_FLOOR_MAX) {
    return (FLOOR_SEGMENT_ID << 3) | RR_FLOOR;
  }
  if (value <= CELL_ROOM_MAX) {
    return (value << 3) | RR_FLOOR;
  }
  return RR_WALL;
}

/**
 * A yaw in degrees: the firmwares give radians, centi-degrees or degrees.
 * @param {*} yaw the raw yaw
 * @returns {number} degrees
 */
function yawToDegrees(yaw) {
  const value = Number(yaw);
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (Math.abs(value) <= 2 * Math.PI + 0.001) {
    return (value * 180) / Math.PI;
  }
  return Math.abs(value) > 180 ? value / 100 : value;
}

/**
 * The rooms of a JSON map, by grid id: the grid id is what the cells carry,
 * the room id what the robot expects to clean a room (`map_room_info` pairs
 * them; without it, they are the same), and `room_attrs` names them, keyed by
 * either id.
 * @param {object} payload the JSON map
 * @returns {{ names: Map<number, string>, roomIds: Map<number, number> }} by grid id
 */
function roomsByGridId(payload) {
  const roomIds = new Map();
  const gridByRoomId = new Map();
  for (const entry of Array.isArray(payload.map_room_info) ? payload.map_room_info : []) {
    const gridId = Number(entry && entry.grid_id);
    const roomId = Number(entry && entry.room_id);
    if (Number.isInteger(gridId) && Number.isInteger(roomId)) {
      roomIds.set(gridId, roomId);
      gridByRoomId.set(roomId, gridId);
    }
  }
  const names = new Map();
  for (const attr of Array.isArray(payload.room_attrs) ? payload.room_attrs : []) {
    const name = attr && (attr.name || attr.room_name);
    if (!name) {
      continue;
    }
    const gridId =
      attr.grid_id !== undefined
        ? Number(attr.grid_id)
        : (gridByRoomId.get(Number(attr.room_id ?? attr.id)) ?? Number(attr.room_id ?? attr.id));
    if (Number.isInteger(gridId)) {
      names.set(gridId, String(name));
    }
  }
  return { names, roomIds };
}

/**
 * Parse a JSON map into the structure parseRRMap() yields (see mapParser.js):
 * coordinates in millimetres, a pixel grid of `pixelSizeMm`. Every room is
 * flagged `named` (the robot names them itself), the floor of no room is not.
 * @param {object} payload the JSON map (see decryptJsonMap)
 * @param {object} [options] options
 * @param {boolean} [options.includePixels] keep the pixel grid, for rendering
 * @returns {object} the parsed map
 */
export function parseJsonMap(payload, { includePixels = false } = {}) {
  const width = Number(payload.width);
  const height = Number(payload.height);
  const pixelSizeMm = Number(payload.resolution) || 50;
  if (!payload.map_data || !(width > 1) || !(height > 1)) {
    throw new Error('The robot has not uploaded a map yet');
  }
  const cells = inflateSync(Buffer.from(payload.map_data, 'base64'));

  const pixels = new Uint16Array(width * height);
  const stats = new Map(); // segmentId -> { pixelCount, minX, minY, maxX, maxY }
  for (let i = 0; i < Math.min(cells.length, pixels.length); i += 1) {
    const value = toRRPixel(cells[i]);
    pixels[i] = value;
    if ((value & 0x07) !== RR_FLOOR) {
      continue;
    }
    const segmentId = value >> 3;
    const x = i % width;
    const y = Math.floor(i / width);
    const entry = stats.get(segmentId);
    if (!entry) {
      stats.set(segmentId, { pixelCount: 1, minX: x, minY: y, maxX: x, maxY: y });
      continue;
    }
    entry.pixelCount += 1;
    entry.minX = Math.min(entry.minX, x);
    entry.minY = Math.min(entry.minY, y);
    entry.maxX = Math.max(entry.maxX, x);
    entry.maxY = Math.max(entry.maxY, y);
  }

  const { names, roomIds } = roomsByGridId(payload);
  const segments = [...stats.entries()]
    .map(([segmentId, s]) => ({
      segmentId,
      pixelCount: s.pixelCount,
      bbox: { minX: s.minX, minY: s.minY, maxX: s.maxX, maxY: s.maxY },
      roomId: roomIds.get(segmentId) ?? segmentId,
      roomName: names.get(segmentId) || null,
      // Like the Roborock maps: the floor of no room is neither drawn nor counted.
      named: segmentId !== FLOOR_SEGMENT_ID,
    }))
    .sort((a, b) => a.segmentId - b.segmentId);

  const position = payload.position;
  const paths = payload.paths;
  const pathSource = Array.isArray(paths) ? paths : paths && paths.points;
  const pathPoints = (Array.isArray(pathSource) ? pathSource : [])
    .filter((point) => point && Number.isFinite(Number(point.x)))
    .map((point) => ({ x: Number(point.x), y: Number(point.y) }));

  const image = {
    top: (Number(payload.origin_y) || 0) / pixelSizeMm,
    left: (Number(payload.origin_x) || 0) / pixelSizeMm,
    width,
    height,
    segments,
  };
  if (includePixels) {
    image.pixels = pixels;
  }

  return {
    pixelSizeMm,
    image,
    robot:
      position && typeof position === 'object'
        ? {
            x: Number(position.x) || 0,
            y: Number(position.y) || 0,
            angle: yawToDegrees(position.yaw),
          }
        : null,
    charger: payload.have_pile
      ? {
          x: Number(payload.pile_x) || 0,
          y: Number(payload.pile_y) || 0,
          angle: yawToDegrees(payload.pile_yaw),
        }
      : null,
    path: pathPoints.length > 1 ? { points: pathPoints } : null,
    segments,
    noGoAreas: [],
    noMoppingAreas: [],
    virtualWalls: [],
    cleanedZones: [],
  };
}
