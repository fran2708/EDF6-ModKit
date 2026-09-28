// Lectura de archivos CPK de CRI (Root.cpk, Chunk01.cpk, ...), lo justo para extraer archivos
// por ruta sin cargar el CPK entero en memoria.
//
// Un CPK tiene un header "CPK " seguido de una tabla @UTF con los offsets de las demás tablas;
// la TOC ("TOC ") lista cada archivo con su carpeta, nombre, tamaño y offset. Las tablas @UTF
// suelen venir enmascaradas con un XOR estándar de CRI.

const fs = require('fs')
const { decompress, isCompressed } = require('./crilayla')
const { fileKey } = require('./mods')

// --- tablas @UTF -----------------------------------------------------------------------------

function unmask(buffer) {
  const out = Buffer.from(buffer)
  let key = 0x5f
  for (let i = 0; i < out.length; i++) {
    out[i] ^= key
    key = (key * 0x15) & 0xff
  }
  return out
}

const STORAGE_MASK = 0xf0
const STORAGE_ZERO = 0x10
const STORAGE_CONSTANT = 0x30
const STORAGE_PERROW = 0x50
const TYPE_MASK = 0x0f

function readValue(buf, pos, type, strings, data) {
  switch (type) {
    case 0x0: return [buf.readUInt8(pos), 1]
    case 0x1: return [buf.readInt8(pos), 1]
    case 0x2: return [buf.readUInt16BE(pos), 2]
    case 0x3: return [buf.readInt16BE(pos), 2]
    case 0x4: return [buf.readUInt32BE(pos), 4]
    case 0x5: return [buf.readInt32BE(pos), 4]
    case 0x6: return [Number(buf.readBigUInt64BE(pos)), 8]
    case 0x7: return [Number(buf.readBigInt64BE(pos)), 8]
    case 0x8: return [buf.readFloatBE(pos), 4]
    case 0x9: return [buf.readDoubleBE(pos), 8]
    case 0xa: return [cstring(buf, strings + buf.readUInt32BE(pos)), 4]
    case 0xb: {
      const off = buf.readUInt32BE(pos)
      const size = buf.readUInt32BE(pos + 4)
      return [buf.subarray(data + off, data + off + size), 8]
    }
    default: throw new Error(`Tipo de columna @UTF desconocido: ${type}`)
  }
}

function cstring(buf, pos) {
  const end = buf.indexOf(0, pos)
  return buf.toString('utf8', pos, end === -1 ? buf.length : end)
}

// Parsea una tabla @UTF (enmascarada o no). Devuelve { name, rows: [{ columna: valor }] }.
function parseUtf(input) {
  let buf = input
  if (buf.toString('latin1', 0, 4) !== '@UTF') {
    buf = unmask(input)
    if (buf.toString('latin1', 0, 4) !== '@UTF') throw new Error('No es una tabla @UTF')
  }
  const base = 8 // los offsets son relativos al final de "@UTF" + tamaño
  const rowsOffset = base + buf.readUInt16BE(10)
  const strings = base + buf.readUInt32BE(12)
  const data = base + buf.readUInt32BE(16)
  const name = cstring(buf, strings + buf.readUInt32BE(20))
  const numColumns = buf.readUInt16BE(24)
  const rowLength = buf.readUInt16BE(26)
  const numRows = buf.readUInt32BE(28)

  const columns = []
  let pos = 32
  for (let c = 0; c < numColumns; c++) {
    const flags = buf.readUInt8(pos)
    const colName = cstring(buf, strings + buf.readUInt32BE(pos + 1))
    pos += 5
    const col = { name: colName, storage: flags & STORAGE_MASK, type: flags & TYPE_MASK }
    if (col.storage === STORAGE_CONSTANT) {
      const [value, size] = readValue(buf, pos, col.type, strings, data)
      col.value = value
      pos += size
    }
    columns.push(col)
  }

  const rows = []
  for (let r = 0; r < numRows; r++) {
    let p = rowsOffset + r * rowLength
    const row = {}
    for (const col of columns) {
      if (col.storage === STORAGE_PERROW) {
        const [value, size] = readValue(buf, p, col.type, strings, data)
        row[col.name] = value
        p += size
      } else if (col.storage === STORAGE_CONSTANT) {
        row[col.name] = col.value
      } else if (col.storage === STORAGE_ZERO) {
        row[col.name] = null
      }
    }
    rows.push(row)
  }
  return { name, rows }
}

// --- CPK -------------------------------------------------------------------------------------

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, offset + done)
    if (n === 0) throw new Error(`Fin de archivo inesperado leyendo ${length} bytes en ${offset}`)
    done += n
  }
  return buf
}

// Lee un chunk "XXXX" + flags(4) + tamaño(8) + tabla @UTF.
function readChunk(fd, offset, magic) {
  const head = readAt(fd, offset, 16)
  const got = head.toString('latin1', 0, 4)
  if (got !== magic) throw new Error(`Se esperaba "${magic}" en ${offset} y hay "${got}"`)
  const size = Number(head.readBigUInt64LE(8))
  return parseUtf(readAt(fd, offset + 16, size))
}

// Índice de un CPK: Map(fileKey -> { rel, offset, size, extractSize }).
function readIndex(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const header = readChunk(fd, 0, 'CPK ').rows[0]
    if (!header.TocOffset) throw new Error(`${file} no tiene TOC con nombres de archivo`)
    const toc = readChunk(fd, header.TocOffset, 'TOC ')
    // Los offsets de la TOC son relativos al comienzo de la TOC, o al del contenido si está antes.
    const base = Math.min(header.TocOffset, header.ContentOffset || header.TocOffset)
    const index = new Map()
    for (const row of toc.rows) {
      const rel = row.DirName ? `${row.DirName}/${row.FileName}` : row.FileName
      index.set(fileKey(rel), {
        rel,
        offset: base + row.FileOffset,
        size: row.FileSize,
        extractSize: row.ExtractSize ?? row.FileSize,
      })
    }
    return index
  } finally {
    fs.closeSync(fd)
  }
}

function extract(file, entry) {
  const fd = fs.openSync(file, 'r')
  try {
    const raw = readAt(fd, entry.offset, entry.size)
    return isCompressed(raw) ? decompress(raw) : raw
  } finally {
    fs.closeSync(fd)
  }
}

module.exports = { parseUtf, unmask, readIndex, extract }
