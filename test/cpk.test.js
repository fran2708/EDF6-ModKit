const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { parseUtf, unmask, readIndex, extract } = require('../src/cpk')
const { decompress } = require('../src/crilayla')
const { vanillaProvider } = require('../src/vanilla')
const { tmpdir, write } = require('./helpers')

// --- generadores mínimos para los tests -------------------------------------------------------

// Tabla @UTF con columnas por fila de tipo u32 (0x4), u64 (0x6) o string (0xa).
function utf(name, columns, rows) {
  const strings = ['<NULL>', name, ...columns.map(c => c.name)]
  for (const row of rows) for (const c of columns) if (c.type === 0xa) strings.push(row[c.name])
  const strOffsets = new Map()
  let strBlob = Buffer.alloc(0)
  for (const s of strings) {
    if (strOffsets.has(s)) continue
    strOffsets.set(s, strBlob.length)
    strBlob = Buffer.concat([strBlob, Buffer.from(s + '\0', 'utf8')])
  }
  const size = { 0x4: 4, 0x6: 8, 0xa: 4 }
  const rowLength = columns.reduce((n, c) => n + size[c.type], 0)
  const colBlob = Buffer.concat(columns.map(c => {
    const b = Buffer.alloc(5)
    b.writeUInt8(0x50 | c.type, 0)
    b.writeUInt32BE(strOffsets.get(c.name), 1)
    return b
  }))
  const rowBlob = Buffer.concat(rows.map(row => {
    const b = Buffer.alloc(rowLength)
    let p = 0
    for (const c of columns) {
      const v = row[c.name]
      if (c.type === 0x4) b.writeUInt32BE(v, p)
      if (c.type === 0x6) b.writeBigUInt64BE(BigInt(v), p)
      if (c.type === 0xa) b.writeUInt32BE(strOffsets.get(v), p)
      p += size[c.type]
    }
    return b
  }))
  const head = Buffer.alloc(32)
  const rowsOffset = 24 + colBlob.length
  const stringsOffset = rowsOffset + rowBlob.length
  const dataOffset = stringsOffset + strBlob.length
  head.write('@UTF', 0, 'latin1')
  head.writeUInt32BE(dataOffset, 4)
  head.writeUInt16BE(1, 8)
  head.writeUInt16BE(rowsOffset, 10)
  head.writeUInt32BE(stringsOffset, 12)
  head.writeUInt32BE(dataOffset, 16)
  head.writeUInt32BE(strOffsets.get(name), 20)
  head.writeUInt16BE(columns.length, 24)
  head.writeUInt16BE(rowLength, 26)
  head.writeUInt32BE(rows.length, 28)
  return Buffer.concat([head, colBlob, rowBlob, strBlob])
}

function chunk(magic, table) {
  const head = Buffer.alloc(16)
  head.write(magic, 0, 'latin1')
  head.writeBigUInt64LE(BigInt(table.length), 8)
  return Buffer.concat([head, table])
}

// Comprime con CRILAYLA usando solo literales, más una referencia opcional. Los bits se leen de
// atrás para adelante y los datos se reconstruyen desde el final.
function crilayla(data, backref) {
  const bits = []
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1) }
  let i = data.length - 1
  while (i >= 0) {
    if (backref && i === backref.at) {
      push(1, 1); push(backref.offset, 13); push(0, 2) // largo 3
      i -= 3
      continue
    }
    push(0, 1); push(data[i], 8)
    i--
  }
  while (bits.length % 8) bits.push(0)
  const bytes = []
  for (let b = 0; b < bits.length; b += 8) bytes.push(parseInt(bits.slice(b, b + 8).join(''), 2))
  const compressed = Buffer.from(bytes.reverse()) // el primer byte leído va al final
  const header = Buffer.alloc(16)
  header.write('CRILAYLA', 0, 'latin1')
  header.writeUInt32LE(data.length, 8)
  header.writeUInt32LE(compressed.length, 12)
  const raw = Buffer.alloc(0x100, 0x41)
  return { packed: Buffer.concat([header, compressed, raw]), raw }
}

function makeCpk(file, files) {
  const headerSize = 0x800
  const contents = files.map(f => f.stored)
  const tocRows = []
  let offset = 0
  const dataStart = 0x800 * 2
  for (let i = 0; i < files.length; i++) {
    tocRows.push({
      DirName: files[i].dir, FileName: files[i].name,
      FileSize: files[i].stored.length, ExtractSize: files[i].size,
      FileOffset: dataStart - headerSize + offset,
    })
    offset += files[i].stored.length
  }
  const toc = chunk('TOC ', unmask(utf('CpkTocInfo', [
    { name: 'DirName', type: 0xa }, { name: 'FileName', type: 0xa },
    { name: 'FileSize', type: 0x4 }, { name: 'ExtractSize', type: 0x4 }, { name: 'FileOffset', type: 0x6 },
  ], tocRows)))
  const header = chunk('CPK ', unmask(utf('CpkHeader', [
    { name: 'ContentOffset', type: 0x6 }, { name: 'TocOffset', type: 0x6 },
  ], [{ ContentOffset: dataStart, TocOffset: headerSize }])))
  const out = Buffer.alloc(dataStart + offset)
  header.copy(out, 0)
  toc.copy(out, headerSize)
  Buffer.concat(contents).copy(out, dataStart)
  write(file, out)
}

// --- tests ------------------------------------------------------------------------------------

test('@UTF: parsea tablas enmascaradas y sin enmascarar', () => {
  const table = utf('T', [{ name: 'A', type: 0x4 }, { name: 'B', type: 0xa }], [{ A: 7, B: 'hola' }, { A: 8, B: 'chau' }])
  const expected = { name: 'T', rows: [{ A: 7, B: 'hola' }, { A: 8, B: 'chau' }] }
  assert.deepEqual(parseUtf(table), expected)
  assert.deepEqual(parseUtf(unmask(table)), expected)
})

test('CRILAYLA: literales y referencias hacia atrás', () => {
  const data = Buffer.from('XYZXYZ')
  // Los 3 primeros bytes (índices 0..2) repiten los 3 de más adelante: referencia con offset 0.
  const { packed, raw } = crilayla(data, { at: 2, offset: 0 })
  const out = decompress(packed)
  assert.deepEqual(out.subarray(0, 0x100), raw)
  assert.equal(out.subarray(0x100).toString(), 'XYZXYZ')
})

test('CPK: índice y extracción, con y sin compresión', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'Root.cpk')
  const plain = Buffer.from('contenido plano')
  const { packed, raw } = crilayla(Buffer.from('comprimido'))
  makeCpk(file, [
    { dir: 'WEAPON', name: 'A.SGO', stored: plain, size: plain.length },
    { dir: 'DEFAULTPACKAGE', name: 'Config.sgo', stored: packed, size: 0x100 + 10 },
  ])
  const index = readIndex(file)
  assert.deepEqual([...index.keys()], ['WEAPON/A.SGO', 'DEFAULTPACKAGE/CONFIG.SGO'])
  assert.equal(extract(file, index.get('WEAPON/A.SGO')).toString(), 'contenido plano')
  const unpacked = extract(file, index.get('DEFAULTPACKAGE/CONFIG.SGO'))
  assert.deepEqual(unpacked, Buffer.concat([raw, Buffer.from('comprimido')]))
})

test('vanillaProvider: usa vanilla/ primero y si no extrae del CPK', () => {
  const game = tmpdir()
  const plain = Buffer.from('del cpk')
  makeCpk(path.join(game, 'Root.cpk'), [{ dir: 'WEAPON', name: 'A.SGO', stored: plain, size: plain.length }])
  const vanillaDir = path.join(game, 'ModKit', 'vanilla')
  write(path.join(vanillaDir, 'UI', 'B.SGO'), 'a mano')

  const v = vanillaProvider({ vanillaDir, gameDir: game })
  assert.equal(fs.readFileSync(v.get('UI/B.SGO').abs, 'utf8'), 'a mano')
  assert.equal(v.relOf('WEAPON/A.SGO'), 'WEAPON/A.SGO')
  assert.ok(!fs.existsSync(path.join(vanillaDir, 'WEAPON', 'A.SGO'))) // relOf no extrae
  const got = v.get('WEAPON/A.SGO')
  assert.equal(fs.readFileSync(got.abs, 'utf8'), 'del cpk')
  assert.equal(v.get('NO/EXISTE.SGO'), undefined)
  assert.deepEqual([...v.topDirs()].sort(), ['UI', 'WEAPON'])
})

const GAME = process.env.EDF6_GAME_DIR
test('integración: extraer CONFIG.SGO del Root.cpk real', { skip: !GAME && 'definir EDF6_GAME_DIR' }, () => {
  const codec = require('../src/codec')
  const file = path.join(GAME, 'Root.cpk')
  const index = readIndex(file)
  const entry = index.get('DEFAULTPACKAGE/CONFIG.SGO')
  const buffer = extract(file, entry)
  assert.equal(buffer.length, entry.extractSize)
  const doc = codec.decode(buffer)
  assert.ok(doc.variables.some(v => v.name === 'SoldierInit'))
})
