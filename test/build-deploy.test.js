const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const codec = require('../src/codec')
const { loadMods } = require('../src/mods')
const { build } = require('../src/build')
const { deploy, clean } = require('../src/deploy')
const { importFolder } = require('../src/importer')
const { resolve } = require('../src/path')
const { vanillaProvider } = require('../src/vanilla')
const { configDoc, tmpdir, write } = require('./helpers')

const CONFIG = 'DEFAULTPACKAGE/CONFIG.SGO'

function setup() {
  const dir = tmpdir()
  write(path.join(dir, 'vanilla', CONFIG), codec.encode(configDoc()))
  return dir
}

function mod(dir, id, manifest, files = {}) {
  write(path.join(dir, 'mods', id, 'mod.json'), JSON.stringify(manifest))
  for (const [rel, data] of Object.entries(files)) write(path.join(dir, 'mods', id, 'files', rel), data)
}

function modsInOrder(dir, ids) {
  const all = loadMods(path.join(dir, 'mods'))
  return ids.map(id => all.find(m => m.id === id))
}

test('codec: SGO and DSGO round trip', () => {
  const doc = configDoc()
  const sgo = codec.decode(codec.encode(doc))
  assert.equal(sgo.format, 'SGO')
  assert.deepEqual(sgo.variables, doc.variables)
  const dsgo = { ...configDoc(), format: 'DSGO' }
  for (const v of dsgo.variables) {
    const walk = n => {
      if (n.type === 'float' || n.type === 'int') n.type = 'double'
      if (n.type === 'ptr') n.value.forEach(walk)
    }
    walk(v)
  }
  const back = codec.decode(codec.encode(dsgo))
  assert.equal(back.format, 'DSGO')
  assert.deepEqual(back.variables, dsgo.variables)
})

test('build: patches from two mods combine on top of the original', () => {
  const dir = setup()
  mod(dir, 'armor', { patches: { [CONFIG]: [{ op: 'mul', path: 'SoldierInit/*/3/1', value: 10 }] } })
  mod(dir, 'slots', { patches: { [CONFIG]: [{ op: 'append', path: 'SoldierInit/0/2', node: { type: 'int', value: 2 } }] } })
  const r = build(modsInOrder(dir, ['slots', 'armor']), { vanilla: vanillaProvider({ vanillaDir: path.join(dir, 'vanilla') }) })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.conflicts, [])
  const out = codec.decode(r.outputs.get(CONFIG).buffer)
  assert.equal(resolve(out, 'SoldierInit/0/3/1')[0].node.value, 5)
  assert.equal(resolve(out, 'SoldierInit/0/2')[0].node.value.length, 3)
})

test('build: a whole file is turned into a patch automatically and combines', () => {
  const dir = setup()
  const legacy = configDoc()
  legacy.variables[0].value = 'LEGACY'
  mod(dir, 'legacy', {}, { [CONFIG.toLowerCase()]: codec.encode(legacy) })
  mod(dir, 'armor', { patches: { [CONFIG]: [{ op: 'mul', path: 'SoldierInit/1/3/1', value: 2 }] } })
  const r = build(modsInOrder(dir, ['legacy', 'armor']), { vanilla: vanillaProvider({ vanillaDir: path.join(dir, 'vanilla') }) })
  assert.deepEqual(r.errors, [])
  const entry = r.outputs.get(CONFIG)
  assert.equal(entry.rel, CONFIG) // the original's name is used, not the mod's
  const out = codec.decode(entry.buffer)
  assert.equal(out.variables[0].value, 'LEGACY')
  assert.equal(resolve(out, 'SoldierInit/1/3/1')[0].node.value, 0.5)
})

test('build: without the original nothing can be patched and nothing is written', () => {
  const dir = setup()
  mod(dir, 'weapon', { patches: { 'WEAPON/X.SGO': [{ op: 'mul', path: 'a', value: 2 }] } })
  const r = build(modsInOrder(dir, ['weapon']), { vanilla: vanillaProvider({ vanillaDir: path.join(dir, 'vanilla') }) })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0].message, /Root.cpk/)
  assert.equal(r.outputs.size, 0)
})

test('deploy: backs up what was there, clean restores it', () => {
  const dir = setup()
  const out = path.join(dir, 'Mods')
  write(path.join(out, 'UI', 'A.txt'), 'from the user')
  const outputs = new Map([
    ['UI/A.TXT', { rel: 'UI/A.txt', buffer: Buffer.from('from the modkit'), mods: ['m'] }],
    ['UI/B.TXT', { rel: 'UI/B.txt', buffer: Buffer.from('new'), mods: ['m'] }],
  ])
  deploy(out, outputs)
  assert.equal(fs.readFileSync(path.join(out, 'UI', 'A.txt'), 'utf8'), 'from the modkit')

  // Second build without B: B is deleted, A stays.
  outputs.delete('UI/B.TXT')
  deploy(out, outputs)
  assert.ok(!fs.existsSync(path.join(out, 'UI', 'B.txt')))

  clean(out)
  assert.equal(fs.readFileSync(path.join(out, 'UI', 'A.txt'), 'utf8'), 'from the user')
})

test('deploy: an identical pre-existing file is backed up too', () => {
  const dir = tmpdir()
  write(path.join(dir, 'X.txt'), 'same')
  deploy(dir, new Map([['X.TXT', { rel: 'X.txt', buffer: Buffer.from('same'), mods: ['m'] }]]))
  clean(dir)
  assert.equal(fs.readFileSync(path.join(dir, 'X.txt'), 'utf8'), 'same')
})

test('deploy: does not delete files edited by hand after the build', () => {
  const dir = tmpdir()
  deploy(dir, new Map([['X.TXT', { rel: 'X.txt', buffer: Buffer.from('modkit'), mods: ['m'] }]]))
  fs.writeFileSync(path.join(dir, 'X.txt'), 'edited')
  const log = clean(dir)
  assert.match(log[0], /edited by hand/)
  assert.equal(fs.readFileSync(path.join(dir, 'X.txt'), 'utf8'), 'edited')
})

test('import: separates patches from copied files', () => {
  const dir = setup()
  const legacy = path.join(dir, 'legacy')
  const doc = configDoc()
  doc.variables[2].value = 'Other'
  write(path.join(legacy, CONFIG), codec.encode(doc))
  write(path.join(legacy, 'UI', 'tex.dds'), 'binary')
  const r = importFolder(legacy, path.join(dir, 'mods', 'viejo'), { vanilla: vanillaProvider({ vanillaDir: path.join(dir, 'vanilla') }) })
  assert.deepEqual(r.patched, [CONFIG])
  assert.deepEqual(r.copied, ['UI/tex.dds'])
  const [m] = loadMods(path.join(dir, 'mods'))
  assert.deepEqual(m.patches[CONFIG], [{ op: 'set', path: 'name.en', value: 'Other' }])
})
