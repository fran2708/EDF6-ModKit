const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const codec = require('../src/codec')
const { loadMods } = require('../src/mods')
const { vanillaProvider } = require('../src/vanilla')
const { build } = require('../src/build')
const { deploy, clean, pendingChanges, unmanagedFiles, displacedNotes } = require('../src/deploy')
const { importInstalled } = require('../src/importer')
const { resolve } = require('../src/path')
const { configDoc, tmpdir, write } = require('./helpers')

const CONFIG = 'DEFAULTPACKAGE/CONFIG.SGO'

// A game whose Mods/ already has a mod installed by hand (renames Config) plus a texture, and a
// ModKit mod that multiplies the Ranger's armor.
function setup() {
  const dir = tmpdir()
  const vanilla = path.join(dir, 'vanilla')
  const out = path.join(dir, 'Mods')
  write(path.join(vanilla, CONFIG), codec.encode(configDoc()))
  const hand = configDoc()
  hand.variables[2].value = 'By hand'
  write(path.join(out, CONFIG), codec.encode(hand))
  write(path.join(out, 'DEFAULTPACKAGE', 'SKIN.DDS'), 'texture')
  write(path.join(out, 'Plugins', 'Patcher.dll'), 'dll')
  write(path.join(out, 'Patches', 'fov.txt'), '')
  write(path.join(dir, 'ModKit', 'mods', 'armor', 'mod.json'), JSON.stringify({
    patches: { [CONFIG]: [{ op: 'mul', path: 'SoldierInit/0/3/0', value: 10 }] },
  }))
  return {
    dir, out, modsDir: path.join(dir, 'ModKit', 'mods'), vanilla: vanillaProvider({ vanillaDir: vanilla }),
    original: fs.readFileSync(path.join(out, CONFIG)),
  }
}

function apply(t, ids) {
  const all = loadMods(t.modsDir)
  const result = build(ids.map(id => all.find(m => m.id === id)), { vanilla: t.vanilla })
  assert.deepEqual(result.errors, [])
  return { result, log: deploy(t.out, result.outputs) }
}

const value = (file, p) => resolve(codec.readDoc(file), p)[0].node.value

test('unmanagedFiles: files installed by hand, not the loader or the ModKit ones', () => {
  const t = setup()
  assert.deepEqual(unmanagedFiles(t.out).sort(), [CONFIG, 'DEFAULTPACKAGE/SKIN.DDS'])
  apply(t, ['armor'])
  assert.deepEqual(unmanagedFiles(t.out), ['DEFAULTPACKAGE/SKIN.DDS'])
})

test('displacedNotes: warns before a hand-installed file gets replaced', () => {
  const t = setup()
  const all = loadMods(t.modsDir)
  const { outputs } = build([all.find(m => m.id === 'armor')], { vanilla: t.vanilla })
  const notes = displacedNotes(t.out, outputs)
  assert.equal(notes.length, 1)
  assert.match(notes[0], /CONFIG\.SGO was installed by hand/)
})

test('importInstalled: the old mod combines with ModKit mods, and can be turned off and restored', () => {
  const t = setup()
  const r = importInstalled({ outDir: t.out, modsDir: t.modsDir, vanilla: t.vanilla })
  assert.equal(r.id, 'previously-installed')
  assert.deepEqual(r.patched, [CONFIG])
  assert.deepEqual(r.copied, ['DEFAULTPACKAGE/SKIN.DDS'])
  assert.deepEqual(unmanagedFiles(t.out), [])
  assert.equal(importInstalled({ outDir: t.out, modsDir: t.modsDir, vanilla: t.vanilla }), null)

  // Both mods together: the hand-installed change and the ModKit one.
  apply(t, ['previously-installed', 'armor'])
  const config = path.join(t.out, CONFIG)
  assert.equal(value(config, 'name.en'), 'By hand')
  assert.equal(value(config, 'SoldierInit/0/3/0'), 2000)
  assert.equal(fs.readFileSync(path.join(t.out, 'DEFAULTPACKAGE', 'SKIN.DDS'), 'utf8'), 'texture')

  // Disabling the imported mod removes it instead of bringing the backup back.
  const { result } = apply(t, ['armor'])
  assert.equal(value(config, 'name.en'), 'Config')
  assert.equal(value(config, 'SoldierInit/0/3/0'), 2000)
  assert.equal(fs.existsSync(path.join(t.out, 'DEFAULTPACKAGE', 'SKIN.DDS')), false)
  assert.equal(pendingChanges(t.out, result.outputs), 0)
  apply(t, [])
  assert.equal(fs.existsSync(config), false)

  // Restore original puts Mods/ back the way it was before the ModKit.
  clean(t.out)
  assert.deepEqual(fs.readFileSync(config), t.original)
  assert.equal(fs.readFileSync(path.join(t.out, 'DEFAULTPACKAGE', 'SKIN.DDS'), 'utf8'), 'texture')
})

test('importInstalled: a file edited by hand after being turned off is left alone', () => {
  const t = setup()
  importInstalled({ outDir: t.out, modsDir: t.modsDir, vanilla: t.vanilla })
  apply(t, ['previously-installed'])
  write(path.join(t.out, 'DEFAULTPACKAGE', 'SKIN.DDS'), 'new texture')
  const { log } = apply(t, [])
  assert.ok(log.some(l => /left DEFAULTPACKAGE\/SKIN\.DDS alone/.test(l)))
  assert.equal(fs.readFileSync(path.join(t.out, 'DEFAULTPACKAGE', 'SKIN.DDS'), 'utf8'), 'new texture')
  assert.deepEqual(unmanagedFiles(t.out), ['DEFAULTPACKAGE/SKIN.DDS'])
})

test('importInstalled: after Restore original the files are not offered again, and apply/restore repeat', () => {
  const t = setup()
  importInstalled({ outDir: t.out, modsDir: t.modsDir, vanilla: t.vanilla })
  const config = path.join(t.out, CONFIG)
  for (let round = 0; round < 2; round++) {
    apply(t, ['previously-installed', 'armor'])
    assert.equal(value(config, 'SoldierInit/0/3/0'), 2000)
    clean(t.out)
    assert.deepEqual(fs.readFileSync(config), t.original)
    assert.deepEqual(unmanagedFiles(t.out, new Set(['previously-installed', 'armor'])), [])
    assert.equal(importInstalled({ outDir: t.out, modsDir: t.modsDir, vanilla: t.vanilla }), null)
  }
  // Restored but the imported mod is off: applying takes the files out again.
  apply(t, ['armor'])
  assert.equal(value(config, 'name.en'), 'Config')
  assert.equal(fs.existsSync(path.join(t.out, 'DEFAULTPACKAGE', 'SKIN.DDS')), false)
})

test('importInstalled: once the imported mod is deleted, its restored files can be imported again', () => {
  const t = setup()
  importInstalled({ outDir: t.out, modsDir: t.modsDir, vanilla: t.vanilla })
  apply(t, ['previously-installed'])
  fs.rmSync(path.join(t.modsDir, 'previously-installed'), { recursive: true })
  clean(t.out)
  assert.deepEqual(unmanagedFiles(t.out, new Set(['armor'])).sort(), [CONFIG, 'DEFAULTPACKAGE/SKIN.DDS'])
  const r = importInstalled({ outDir: t.out, modsDir: t.modsDir, vanilla: t.vanilla })
  assert.equal(r.id, 'previously-installed')
  apply(t, ['previously-installed'])
  assert.equal(value(path.join(t.out, CONFIG), 'name.en'), 'By hand')
  clean(t.out)
  assert.deepEqual(fs.readFileSync(path.join(t.out, CONFIG)), t.original)
})

test('importInstalled: a deleted imported mod whose files still hold a build result is not offered', () => {
  const t = setup()
  importInstalled({ outDir: t.out, modsDir: t.modsDir, vanilla: t.vanilla })
  apply(t, ['previously-installed', 'armor'])
  fs.rmSync(path.join(t.modsDir, 'previously-installed'), { recursive: true })
  // CONFIG.SGO now mixes the old mod with armor: importing it would bake armor in.
  assert.deepEqual(unmanagedFiles(t.out, new Set(['armor'])), ['DEFAULTPACKAGE/SKIN.DDS'])
  apply(t, ['armor'])
  assert.deepEqual(unmanagedFiles(t.out, new Set(['armor'])), [])
})
