const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { zipSync, strToU8 } = require('fflate')
const codec = require('../src/codec')
const { loadMods, fileKey } = require('../src/mods')
const { build } = require('../src/build')
const { deploy, clean, pendingChanges, unmanagedFiles, readManifest } = require('../src/deploy')
const { installZip } = require('../src/zipimport')
const { vanillaProvider, gameTopDirs } = require('../src/vanilla')
const { configDoc, tmpdir, write } = require('./helpers')

const DLL = 'Plugins/EDF6Compendium.dll'
const INI = 'Compendium/config.ini'
const TSV = 'Compendium/weapons.tsv'

// A game with a workspace and the Compendium plugin zip laid out like the game folder.
function setup() {
  const game = tmpdir()
  const ws = path.join(game, 'ModKit')
  write(path.join(ws, 'vanilla', 'DEFAULTPACKAGE', 'CONFIG.SGO'), codec.encode(configDoc()))
  fs.mkdirSync(path.join(ws, 'mods'), { recursive: true })
  const zip = Buffer.from(zipSync({
    'EDF6Compendium/Mods/Plugins/EDF6Compendium.dll': strToU8('dll v1'),
    'EDF6Compendium/Mods/Plugins/Patcher.dll': strToU8('patcher'),
    'EDF6Compendium/Mods/Compendium/config.ini': strToU8('tecla=0x70'),
    'EDF6Compendium/Mods/Compendium/weapons.tsv': strToU8('weapons v1'),
    'EDF6Compendium/Mods/readme.txt': strToU8('hello'),
    'EDF6Compendium/README.md': strToU8('hello'),
  }))
  return {
    out: path.join(game, 'Mods'),
    modsDir: path.join(ws, 'mods'),
    vanilla: vanillaProvider({ vanillaDir: path.join(ws, 'vanilla'), gameDir: null }),
    zip,
  }
}

function install(t) {
  return installZip(t.zip, { zipName: 'EDF6Compendium.zip', modsDir: t.modsDir, vanilla: t.vanilla })
}

function apply(t, ids) {
  const all = loadMods(t.modsDir)
  const { outputs, errors } = build(ids.map(id => all.find(m => m.id === id)), { vanilla: t.vanilla })
  assert.deepEqual(errors, [])
  return { outputs, log: deploy(t.out, outputs) }
}

const read = (t, rel) => fs.readFileSync(path.join(t.out, rel), 'utf8')
const exists = (t, rel) => fs.existsSync(path.join(t.out, rel))

test('installZip: a plugin zip installs its DLL and data folder, not the loader or readmes', () => {
  const t = setup()
  const r = install(t)
  assert.deepEqual(r.installed, ['edf6compendium'])
  const mod = loadMods(t.modsDir)[0]
  assert.deepEqual(mod.files.map(f => f.rel).sort(), [INI, TSV, DLL])
  const notes = r.notes.join('\n')
  assert.match(notes, /Skipped Plugins\/Patcher\.dll/)
  assert.match(notes, /Ignored 2 file/)
  assert.match(notes, /settings and progress in Compendium\//)
})

test('plugin: updates and on/off never touch the player\'s settings or progress', () => {
  const t = setup()
  install(t)
  apply(t, ['edf6compendium'])
  assert.equal(read(t, DLL), 'dll v1')
  assert.equal(read(t, INI), 'tecla=0x70')

  // The player changes the key, and the plugin saves progress.
  write(path.join(t.out, INI), 'tecla=0x71')
  write(path.join(t.out, 'Compendium', 'obtenidas.txt'), 'progress')

  // A new version of the plugin.
  const files = path.join(t.modsDir, 'edf6compendium', 'files')
  write(path.join(files, DLL), 'dll v2')
  write(path.join(files, TSV), 'weapons v2')
  write(path.join(files, INI), 'tecla=0x70\nnew=1')
  const { outputs, log } = apply(t, ['edf6compendium'])
  assert.equal(read(t, DLL), 'dll v2')
  assert.equal(read(t, TSV), 'weapons v2')
  assert.equal(read(t, INI), 'tecla=0x71')
  assert.ok(log.includes(`kept your version of ${INI}`))
  assert.equal(pendingChanges(t.out, outputs), 0)
  assert.equal(fs.existsSync(path.join(t.out, '.modkit', 'backup', 'Compendium')), false)

  // Off: the plugin goes, the player's files stay.
  apply(t, [])
  assert.equal(exists(t, DLL), false)
  assert.equal(exists(t, TSV), false)
  assert.equal(read(t, INI), 'tecla=0x71')
  assert.equal(read(t, 'Compendium/obtenidas.txt'), 'progress')

  // On again, then Restore original: same guarantees.
  apply(t, ['edf6compendium'])
  assert.equal(read(t, DLL), 'dll v2')
  assert.equal(read(t, INI), 'tecla=0x71')
  clean(t.out)
  assert.equal(exists(t, DLL), false)
  assert.equal(read(t, INI), 'tecla=0x71')
  assert.equal(read(t, 'Compendium/obtenidas.txt'), 'progress')
})

test('plugin: data the player already had from a manual install is kept on the first apply', () => {
  const t = setup()
  write(path.join(t.out, INI), 'tecla=0x72')
  install(t)
  const { outputs } = apply(t, ['edf6compendium'])
  assert.equal(read(t, INI), 'tecla=0x72')
  assert.equal(read(t, TSV), 'weapons v1')
  assert.equal(pendingChanges(t.out, outputs), 0)
  apply(t, [])
  assert.equal(read(t, INI), 'tecla=0x72')
})

test('unmanagedFiles: plugin data folders and loose files are not mods installed by hand', () => {
  const t = setup()
  write(path.join(t.out, INI), 'x')
  write(path.join(t.out, 'notes.txt'), 'x')
  write(path.join(t.out, 'DEFAULTPACKAGE', 'CONFIG.SGO'), codec.encode(configDoc()))
  assert.deepEqual(unmanagedFiles(t.out, new Set(), gameTopDirs(t.vanilla)), ['DEFAULTPACKAGE/CONFIG.SGO'])
})

test('deploy: a DLL in use stops with a clear message and keeps the manifest in step', t => {
  const g = setup()
  install(g)
  const all = loadMods(g.modsDir)
  const { outputs } = build(all, { vanilla: g.vanilla })
  const real = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', (file, ...rest) => {
    if (String(file).endsWith('.dll')) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    return real(file, ...rest)
  })
  assert.throws(() => deploy(g.out, outputs), /game seems to be running \(Plugins\/EDF6Compendium\.dll is in use\)/)
  t.mock.restoreAll()

  const files = readManifest(g.out).files
  assert.ok(files[fileKey(TSV)])
  assert.equal(files[fileKey(DLL)], undefined)
  // Once the game is closed, the files written before are not taken for hand-installed ones.
  const log = deploy(g.out, outputs)
  assert.ok(!log.some(l => l.startsWith('backed up')))
  assert.equal(read(g, DLL), 'dll v1')
})
