const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { zipSync, strToU8 } = require('fflate')
const codec = require('../src/codec')
const { installZip, locate } = require('../src/zipimport')
const { vanillaProvider } = require('../src/vanilla')
const { startServer } = require('../src/server')
const { configDoc, tmpdir, write } = require('./helpers')

const CONFIG = 'DEFAULTPACKAGE/CONFIG.SGO'

// Juego falso: los originales van directo en ModKit/vanilla (sin CPK).
function setup() {
  const game = tmpdir()
  write(path.join(game, 'EDF6.exe'), '')
  fs.mkdirSync(path.join(game, 'Mods'))
  const ws = path.join(game, 'ModKit')
  write(path.join(ws, 'vanilla', CONFIG), codec.encode(configDoc()))
  write(path.join(ws, 'vanilla', 'WEAPON', 'A.SGO'), codec.encode(configDoc()))
  fs.mkdirSync(path.join(ws, 'mods'))
  const configFile = path.join(ws, 'modkit.json')
  write(configFile, JSON.stringify({ gameDir: '..', load: [] }))
  const vanilla = vanillaProvider({ vanillaDir: path.join(ws, 'vanilla'), gameDir: game })
  return { game, ws, configFile, vanilla, modsDir: path.join(ws, 'mods') }
}

function variantDoc(name) {
  const d = configDoc()
  d.variables[2].value = name
  return codec.encode(d)
}

function zip(files) {
  const entries = {}
  for (const [name, data] of Object.entries(files)) entries[name] = typeof data === 'string' ? strToU8(data) : new Uint8Array(data)
  return Buffer.from(zipSync(entries))
}

test('locate: envoltorios, carpeta de variante y archivos nuevos', () => {
  const { vanilla } = setup()
  const top = vanilla.topDirs()
  assert.deepEqual(locate(['MiMod', 'Mods', 'DEFAULTPACKAGE', 'CONFIG.SGO'], vanilla, top),
    { gameRel: CONFIG, label: 'MiMod/Mods' })
  assert.deepEqual(locate(['DEFAULTPACKAGE', 'Armor x10', 'config.sgo'], vanilla, top),
    { gameRel: CONFIG, label: 'Armor x10' })
  assert.deepEqual(locate(['MiMod', 'WEAPON', 'nuevo.sgo'], vanilla, top),
    { gameRel: 'WEAPON/nuevo.sgo', label: 'MiMod' })
  assert.equal(locate(['LEEME.txt'], vanilla, top), null)
  assert.equal(locate(['DEFAULTPACKAGE', 'CONFIG.json'], vanilla, top), null)
})

test('installZip: mod viejo simple con envoltorio', () => {
  const { vanilla, modsDir } = setup()
  const buf = zip({ 'Mi Mod/DEFAULTPACKAGE/CONFIG.SGO': variantDoc('Cambiado'), 'Mi Mod/leeme.txt': 'hola' })
  const r = installZip(buf, { zipName: 'Mi Mod v2.zip', modsDir, vanilla })
  assert.deepEqual(r.installed, ['mi-mod-v2'])
  assert.match(r.notes.join(), /ignoraron 1/)
  const manifest = JSON.parse(fs.readFileSync(path.join(modsDir, 'mi-mod-v2', 'mod.json'), 'utf8'))
  assert.deepEqual(manifest.patches[CONFIG], [{ op: 'set', path: 'name.en', value: 'Cambiado' }])
  assert.equal(manifest.description, 'Importado de Mi Mod v2.zip')
})

test('installZip: variantes se ofrecen y se instala la elegida', () => {
  const { vanilla, modsDir } = setup()
  const buf = zip({
    'DEFAULTPACKAGE/Armor x2/CONFIG.SGO': variantDoc('x2'),
    'DEFAULTPACKAGE/Armor x10/CONFIG.SGO': variantDoc('x10'),
  })
  const first = installZip(buf, { zipName: 'Armor.zip', modsDir, vanilla })
  assert.deepEqual(first.variants.map(v => v.name).sort(), ['Armor x10', 'Armor x2'])
  const r = installZip(buf, { zipName: 'Armor.zip', modsDir, vanilla, variant: 'Armor x10' })
  assert.deepEqual(r.installed, ['armor-armor-x10'])
  const manifest = JSON.parse(fs.readFileSync(path.join(modsDir, 'armor-armor-x10', 'mod.json'), 'utf8'))
  assert.equal(manifest.name, 'Armor (Armor x10)')
  assert.equal(manifest.patches[CONFIG][0].value, 'x10')
})

test('installZip: zip con mod.json se copia tal cual', () => {
  const { vanilla, modsDir } = setup()
  const buf = zip({ 'armor-x10/mod.json': JSON.stringify({ name: 'Armor', patches: {} }) })
  const r = installZip(buf, { zipName: 'x.zip', modsDir, vanilla })
  assert.deepEqual(r.installed, ['armor-x10'])
  assert.ok(fs.existsSync(path.join(modsDir, 'armor-x10', 'mod.json')))
})

test('installZip: rechaza rutas que salen de la carpeta', () => {
  const { vanilla, modsDir } = setup()
  const buf = zip({ '../../evil.SGO': 'x' })
  assert.throws(() => installZip(buf, { modsDir, vanilla }), /insegura/)
})

test('API: token, estado, orden, aplicar y restaurar', async () => {
  const { game, configFile, modsDir } = setup()
  write(path.join(modsDir, 'armor', 'mod.json'), JSON.stringify({
    name: 'Armor', patches: { [CONFIG]: [{ op: 'mul', path: 'SoldierInit/*/3/1', value: 10 }] },
  }))
  write(path.join(modsDir, 'fija', 'mod.json'), JSON.stringify({
    name: 'Fija', patches: { [CONFIG]: [{ op: 'set', path: 'SoldierInit/0/3/1', value: 1 }] },
  }))
  const srv = await startServer({ configFile })
  const base = srv.url.split('?')[0]
  const call = async (method, p, body, token = srv.token) => {
    const res = await fetch(base + p.replace(/^\//, ''), {
      method, headers: { 'x-token': token, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    })
    return { status: res.status, data: await res.json() }
  }
  try {
    assert.equal((await fetch(base)).status, 403)
    assert.equal((await fetch(srv.url)).status, 200)
    assert.equal((await call('GET', '/api/state', null, 'malo')).status, 403)

    let { data } = await call('GET', '/api/state')
    assert.deepEqual(data.mods.map(m => m.id), ['armor', 'fija'])
    assert.equal(data.preview.pending, 0)

    ;({ data } = await call('POST', '/api/load', { load: ['armor', 'fija'] }))
    assert.deepEqual(data.load, ['armor', 'fija'])
    assert.equal(data.preview.conflicts.length, 1)
    assert.equal(data.preview.pending, 1)
    assert.equal((await call('POST', '/api/load', { load: ['no-existe'] })).status, 400)

    ;({ data } = await call('POST', '/api/apply'))
    assert.ok(data.ok)
    assert.ok(fs.existsSync(path.join(game, 'Mods', CONFIG)))
    assert.equal(data.state.preview.pending, 0)

    ;({ data } = await call('POST', '/api/restore'))
    assert.ok(!fs.existsSync(path.join(game, 'Mods', CONFIG)))

    ;({ data } = await call('POST', '/api/remove', { id: 'fija' }))
    assert.deepEqual(data.load, ['armor'])
    assert.ok(!fs.existsSync(path.join(modsDir, 'fija')))
  } finally {
    await srv.close()
  }
})

test('API: importar zip con variantes', async () => {
  const { configFile } = setup()
  const srv = await startServer({ configFile })
  const base = srv.url.split('?')[0]
  try {
    const buf = zip({
      'DEFAULTPACKAGE/A/CONFIG.SGO': variantDoc('a'),
      'DEFAULTPACKAGE/B/CONFIG.SGO': variantDoc('b'),
    })
    let res = await fetch(base + 'api/import?name=Var.zip', { method: 'POST', headers: { 'x-token': srv.token }, body: buf })
    let data = await res.json()
    assert.equal(data.variants.length, 2)
    res = await fetch(base + 'api/import/choose', {
      method: 'POST', headers: { 'x-token': srv.token }, body: JSON.stringify({ importId: data.importId, variant: 'B' }),
    })
    data = await res.json()
    assert.deepEqual(data.installed, ['var-b'])
    assert.ok(data.state.mods.some(m => m.id === 'var-b'))
  } finally {
    await srv.close()
  }
})
