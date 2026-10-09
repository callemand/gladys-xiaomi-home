// -----------------------------------------------------------------------------
// CRC-32 (IEEE 802.3), needed by the PNG encoder (src/map/mapRender.js).
// -----------------------------------------------------------------------------

// CRC-32 (IEEE 802.3) table, computed once.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Standard CRC-32 (IEEE) of a buffer, matching Python's binascii.crc32.
 * @param {Buffer} buffer the input bytes
 * @returns {number} the unsigned 32-bit CRC
 */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
