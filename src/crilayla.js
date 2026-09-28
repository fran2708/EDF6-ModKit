// CRILAYLA decompression, the LZ compression used by CRI's CPK archives.
//
// Format: "CRILAYLA" + uncompressed size (u32 LE) + raw header offset (u32 LE) + compressed
// data + 0x100 uncompressed bytes (the start of the file). The compressed data is read back to
// front, bit by bit, and the output is also written back to front.

const MAGIC = 'CRILAYLA'
const RAW_HEADER = 0x100
const VLE_LENS = [2, 3, 5, 8]

function isCompressed(buffer) {
  return buffer.length >= 16 && buffer.toString('latin1', 0, 8) === MAGIC
}

function decompress(src) {
  if (!isCompressed(src)) throw new Error('Not a CRILAYLA block')
  const uncompressedSize = src.readUInt32LE(8)
  const headerOffset = src.readUInt32LE(12)
  const out = Buffer.alloc(RAW_HEADER + uncompressedSize)
  src.copy(out, 0, headerOffset + 0x10, headerOffset + 0x10 + RAW_HEADER)

  let input = src.length - RAW_HEADER - 1
  const outputEnd = RAW_HEADER + uncompressedSize - 1
  let pool = 0
  let left = 0
  let written = 0

  function bits(count) {
    let value = 0
    let produced = 0
    while (produced < count) {
      if (left === 0) {
        if (input < 16) throw new Error('CRILAYLA: truncated compressed data')
        pool = src[input--]
        left = 8
      }
      const take = Math.min(left, count - produced)
      value = (value << take) | ((pool >> (left - take)) & ((1 << take) - 1))
      left -= take
      produced += take
    }
    return value
  }

  while (written < uncompressedSize) {
    if (bits(1)) {
      let from = outputEnd - written + bits(13) + 3
      let length = 3
      let level = 0
      for (; level < VLE_LENS.length; level++) {
        const v = bits(VLE_LENS[level])
        length += v
        if (v !== (1 << VLE_LENS[level]) - 1) break
      }
      if (level === VLE_LENS.length) {
        let v
        do {
          v = bits(8)
          length += v
        } while (v === 0xff)
      }
      for (let i = 0; i < length; i++) {
        out[outputEnd - written] = out[from--]
        written++
      }
    } else {
      out[outputEnd - written] = bits(8)
      written++
    }
  }
  return out
}

module.exports = { decompress, isCompressed }
