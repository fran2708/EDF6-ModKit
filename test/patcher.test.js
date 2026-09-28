const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { zipSync, strToU8 } = require('fflate')
const { parsePatch, patchConflicts, patchSources } = require('../src/patcher')
const { installZip } = require('../src/zipimport')
const { deploy } = require('../src/deploy')
const { vanillaProvider } = require('../src/vanilla')
const codec = require('../src/codec')
const { configDoc, tmpdir, write } = require('./helpers')

const NO_SPLASH = `; Author: MoistGoat
aob NoSplashScreen C4705FC3CCCC488D05????F400C3CC
NoSplashScreen+6: 90 90 90 90 90 90 90
`

const FOV = `alloc vFOV 4
vFOV:
f32! 0.7853982 ; 45 vFOV (Default)
aob vFOVoff F30F1005????????F30F5E87
vFOVoff+4: rel32! vFOV
`

test('parsePatch: hex bytes, typed values, labels, continued writes and comments', () => {
  const r = parsePatch(`1000: 90 90 ; two nops
u32! 5
aob A 11 22 33
A+2: s16! -1
A-1: double! 2.5
`, 'x.txt')
  assert.deepEqual(r.problems, [])
  assert.deepEqual(r.writes.map(w => [w.base, w.offset, w.length, w.line, w.where]), [
    ['abs', 0x1000, 2, 1, 'offset 1000'],
    ['abs', 0x1002, 4, 2, 'offset 1002'],
    ['aob:112233', 2, 2, 4, 'A+2'],
    ['aob:112233', -1, 8, 5, 'A-1'],
  ])
})

test('parsePatch: real patches from the default Plugins6 set parse cleanly', () => {
  assert.deepEqual(parsePatch(NO_SPLASH).problems, [])
  const fov = parsePatch(FOV, 'ChangeFOV.txt')
  assert.deepEqual(fov.problems, [])
  assert.equal(fov.writes[0].base, 'alloc:ChangeFOV.txt:vFOV')
  assert.deepEqual([fov.writes[1].base, fov.writes[1].offset, fov.writes[1].length], ['aob:F30F1005????????F30F5E87', 4, 4])
})

test('parsePatch: reports lines it cannot read', () => {
  const r = parsePatch('Nope+4: 90\nu12! 3\nzz\n', 'bad.txt')
  assert.equal(r.problems.length, 3)
  assert.match(r.problems[0], /bad.txt line 1: label "Nope" is not defined/)
})

test('patchConflicts: overlapping writes on the same aob pattern clash', () => {
  const other = 'aob Splash C4705FC3 CCCC488D05????F400C3CC\nSplash+8: 90 90\n'
  const c = patchConflicts([
    { owner: 'splash-a', rel: 'NoSplashScreen.txt', text: NO_SPLASH },
    { owner: 'splash-b', rel: 'FastBoot.txt', text: other },
  ])
  assert.equal(c.length, 1)
  assert.deepEqual(c[0].mods, ['splash-a', 'splash-b'])
  assert.match(c[0].message, /both patch the same game code/)
  assert.equal(c[0].path, 'NoSplashScreen+6 (line 3) / Splash+8 (line 2)')
})

test('patchConflicts: no clash for other bytes, other patterns, or alloc memory', () => {
  const c = patchConflicts([
    { owner: 'a', rel: 'A.txt', text: 'aob X 1122\nX: 90\n1000: 90 90\n' + FOV },
    { owner: 'b', rel: 'B.txt', text: 'aob X 1122\nX+1: 90\naob Y 3344\nY: 90\n1002: 90\n' + FOV.replace('+4', '+8') },
  ])
  assert.deepEqual(c, [])
})

test('patchConflicts: absolute offsets clash too', () => {
  const c = patchConflicts([
    { owner: 'a', rel: 'A.txt', text: '1000: 90 90 90 90' },
    { owner: 'b', rel: 'B.txt', text: '1003: EB' },
  ])
  assert.equal(c.length, 1)
})

test('patchSources: build outputs plus patches installed by hand, minus ModKit-managed ones', () => {
  const outDir = tmpdir()
  write(path.join(outDir, 'Patches', 'Manual.txt'), NO_SPLASH)
  write(path.join(outDir, 'Patches', 'Replaced.txt'), 'old')
  deploy(outDir, new Map([['PATCHES/OLDMOD.TXT', { rel: 'Patches/OldMod.txt', buffer: Buffer.from('1000: 90'), mods: ['m'] }]]))
  const outputs = new Map([
    ['PATCHES/REPLACED.TXT', { rel: 'Patches/Replaced.txt', buffer: Buffer.from(NO_SPLASH), mods: ['mod-a'] }],
  ])
  const sources = patchSources(outputs, outDir)
  assert.deepEqual(sources.map(s => [s.owner, s.rel]).sort(), [['installed manually', 'Manual.txt'], ['mod-a', 'Replaced.txt']])
  assert.equal(patchConflicts(sources).length, 1)
})

test('installZip: keeps Mods/Patches/*.txt and ignores ExtraPatches and loader files', () => {
  const ws = tmpdir()
  write(path.join(ws, 'vanilla', 'DEFAULTPACKAGE', 'CONFIG.SGO'), codec.encode(configDoc()))
  const vanilla = vanillaProvider({ vanillaDir: path.join(ws, 'vanilla'), gameDir: null })
  const modsDir = path.join(ws, 'mods')
  fs.mkdirSync(modsDir)
  const buf = Buffer.from(zipSync({
    'Splash/Mods/Patches/NoSplashScreen.txt': strToU8(NO_SPLASH),
    'Splash/Mods/ExtraPatches/Other.txt': strToU8('1000: 90'),
    'Splash/Mods/Plugins/Patcher.dll': strToU8('dll'),
    'Splash/winmm.dll': strToU8('dll'),
  }))
  const r = installZip(buf, { zipName: 'Splash.zip', modsDir, vanilla })
  assert.deepEqual(r.installed, ['splash'])
  assert.match(r.notes.join(), /Ignored 3/)
  const copied = path.join(modsDir, 'splash', 'files', 'Patches', 'NoSplashScreen.txt')
  assert.equal(fs.readFileSync(copied, 'utf8'), NO_SPLASH)
})
