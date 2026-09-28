// Loader install/status against a fake GitHub (no network).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { zipSync, strToU8 } = require('fflate')
const { createLoader } = require('../src/loader')
const { startServer } = require('../src/server')
const { tmpdir, write } = require('./helpers')

const sha = b => crypto.createHash('sha256').update(b).digest('hex')

function release(tag, { dll = `EDFModLoader ${tag}`, patcher = `Patcher ${tag}`, badDigest = false } = {}) {
  const loaderZip = Buffer.from(zipSync({
    'ModLoader.ini': strToU8('[ModLoader]\nLoadPlugins=True\n'),
    'Mods/Plugins/': new Uint8Array(0),
    'winmm.dll': strToU8(`MZ...${dll}...`),
  }))
  const pluginsZip = Buffer.from(zipSync({
    'Mods/Plugins/Patcher.dll': strToU8(`MZ...${patcher}`),
    'Mods/Patches/EOSLauncherBypass.txt': strToU8('aob A 1122\nA: 90\n'),
    'Mods/ExtraPatches/ChangeFOV.txt': strToU8('; optional\n'),
    'README.md': strToU8('not installed'),
  }))
  const files = { 'EDFModLoader.zip': loaderZip, 'Plugins6.zip': pluginsZip }
  const api = {
    tag_name: tag,
    html_url: `https://github.com/x/releases/${tag}`,
    assets: Object.entries(files).map(([name, buf]) => ({
      name,
      size: buf.length,
      browser_download_url: `https://download/${tag}/${name}`,
      digest: `sha256:${badDigest ? '0'.repeat(64) : sha(buf)}`,
    })),
  }
  return { api, files }
}

// A fetch that serves one release; counts calls.
function fakeFetch(rel) {
  const calls = []
  const fetch = async url => {
    calls.push(url)
    if (url.includes('api.github.com')) return { ok: true, status: 200, json: async () => rel.api }
    const name = url.split('/').pop()
    const buf = rel.files[name]
    if (!buf) return { ok: false, status: 404 }
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
  }
  fetch.calls = calls
  return fetch
}

function fakeGame() {
  const game = tmpdir()
  write(path.join(game, 'EDF6.exe'), '')
  fs.mkdirSync(path.join(game, 'Mods'))
  return game
}

test('status: missing, then installed and up to date after install', async () => {
  const game = fakeGame()
  const loader = createLoader({ fetch: fakeFetch(release('v1.0.10')) })
  const before = await loader.status(game, { check: true })
  assert.deepEqual([before.loader, before.patcher, before.latestTag, before.upToDate], ['missing', 'missing', 'v1.0.10', false])

  const r = await loader.install(game)
  assert.equal(r.tag, 'v1.0.10')
  assert.deepEqual(r.written.sort(), [
    'ModLoader.ini', 'Mods/ExtraPatches/ChangeFOV.txt', 'Mods/Patches/EOSLauncherBypass.txt',
    'Mods/Plugins/Patcher.dll', 'winmm.dll',
  ])
  assert.ok(!fs.existsSync(path.join(game, 'README.md')))
  const after = await loader.status(game, { check: true })
  assert.deepEqual([after.loader, after.patcher, after.installedTag, after.upToDate], ['installed', 'installed', 'v1.0.10', true])
  assert.equal(JSON.parse(fs.readFileSync(path.join(game, 'Mods', '.modkit', 'loader.json'), 'utf8')).tag, 'v1.0.10')
})

test('install: an update replaces the DLLs (with backup) but keeps settings and patches', async () => {
  const game = fakeGame()
  await createLoader({ fetch: fakeFetch(release('v1.0.9')) }).install(game)
  write(path.join(game, 'ModLoader.ini'), '; my settings\n')
  fs.unlinkSync(path.join(game, 'Mods', 'Patches', 'EOSLauncherBypass.txt'))
  write(path.join(game, 'Mods', 'Patches', 'EOSLauncherBypass.txt'), '; edited by me\n')

  const loader = createLoader({ fetch: fakeFetch(release('v1.0.10')) })
  const st = await loader.status(game, { check: true })
  assert.deepEqual([st.installedTag, st.latestTag, st.upToDate], ['v1.0.9', 'v1.0.10', false])

  const r = await loader.install(game)
  assert.deepEqual(r.written.sort(), ['Mods/Plugins/Patcher.dll', 'winmm.dll'])
  assert.deepEqual(r.backedUp.sort(), ['Mods/Plugins/Patcher.dll', 'winmm.dll'])
  assert.equal(fs.readFileSync(path.join(game, 'ModLoader.ini'), 'utf8'), '; my settings\n')
  assert.equal(fs.readFileSync(path.join(game, 'Mods', 'Patches', 'EOSLauncherBypass.txt'), 'utf8'), '; edited by me\n')
  const backups = fs.readdirSync(path.join(game, 'Mods', '.modkit', 'loader-backup'))
  assert.equal(backups.length, 1)
  assert.match(fs.readFileSync(path.join(game, 'Mods', '.modkit', 'loader-backup', backups[0], 'winmm.dll'), 'utf8'), /v1\.0\.9/)
})

test('status: a loader installed by hand is recognized by its hashes', async () => {
  const game = fakeGame()
  const rel = release('v1.0.10')
  await createLoader({ fetch: fakeFetch(rel) }).install(game)
  fs.unlinkSync(path.join(game, 'Mods', '.modkit', 'loader.json'))
  const st = await createLoader({ fetch: fakeFetch(rel) }).status(game, { check: true })
  assert.deepEqual([st.installedTag, st.upToDate], ['v1.0.10', true])
})

test('install: refuses a winmm.dll from another program and a bad checksum', async () => {
  const game = fakeGame()
  write(path.join(game, 'winmm.dll'), 'some other program')
  const loader = createLoader({ fetch: fakeFetch(release('v1.0.10')) })
  assert.equal((await loader.status(game)).loader, 'foreign')
  await assert.rejects(loader.install(game), /belongs to another program/)
  assert.equal(fs.readFileSync(path.join(game, 'winmm.dll'), 'utf8'), 'some other program')

  const clean = fakeGame()
  const bad = createLoader({ fetch: fakeFetch(release('v1.0.10', { badDigest: true })) })
  await assert.rejects(bad.install(clean), /checksum/)
  assert.ok(!fs.existsSync(path.join(clean, 'winmm.dll')))
})

test('status: offline is reported, not thrown; the release is cached', async () => {
  const game = fakeGame()
  const offline = createLoader({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com') } })
  const st = await offline.status(game, { check: true })
  assert.equal(st.offline, true)
  assert.match(st.error, /ENOTFOUND/)

  const fetch = fakeFetch(release('v1.0.10'))
  const loader = createLoader({ fetch })
  await loader.status(game, { check: true })
  await loader.status(game, { check: true })
  assert.equal(fetch.calls.filter(u => u.includes('api.github.com')).length, 1)
})

test('API: loader status and install', async () => {
  const game = fakeGame()
  const ws = path.join(game, 'ModKit')
  fs.mkdirSync(path.join(ws, 'mods'), { recursive: true })
  const configFile = path.join(ws, 'modkit.json')
  write(configFile, JSON.stringify({ gameDir: '..', load: [] }))
  const srv = await startServer({ configFile, loader: createLoader({ fetch: fakeFetch(release('v1.0.10')) }) })
  const base = srv.url.split('?')[0]
  const call = (method, p) => fetch(base + p, { method, headers: { 'x-token': srv.token } }).then(r => r.json())
  try {
    let st = await call('GET', 'api/loader?check=1')
    assert.deepEqual([st.loader, st.latestTag], ['missing', 'v1.0.10'])
    const r = await call('POST', 'api/loader/install')
    assert.equal(r.result.tag, 'v1.0.10')
    assert.equal(r.status.upToDate, true)
    assert.ok(fs.existsSync(path.join(game, 'winmm.dll')))
  } finally {
    await srv.close()
  }
})
