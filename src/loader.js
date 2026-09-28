// EDFModLoader and the Patcher plugin: detection, and install/update from the official release.
//
// The game only reads the Mods folder when EDFModLoader (winmm.dll + ModLoader.ini, next to
// EDF6.exe) is installed, and memory patches in Mods/Patches only work with Patcher
// (Mods/Plugins/Patcher.dll). Both come from github.com/BlueAmulet/EDFModLoader releases
// (EDFModLoader.zip and Plugins6.zip). Nothing is bundled with the ModKit: the latest release is
// downloaded when the user asks, and every zip is checked against the SHA-256 GitHub publishes.
//
// What gets installed (anything else in the zips is ignored):
//   winmm.dll, Mods/Plugins/*.dll                       always written (that's the update)
//   ModLoader.ini, Mods/Patches/*.txt, Mods/ExtraPatches/*.txt
//                                                        only if missing (keeps the user's
//                                                        settings and edited/removed patches)
// Replaced DLLs are backed up to Mods/.modkit/loader-backup/<date>/ and the installed version is
// recorded in Mods/.modkit/loader.json.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { unzipSync } = require('fflate')

const REPO = 'BlueAmulet/EDFModLoader'
const ASSETS = ['EDFModLoader.zip', 'Plugins6.zip']
const ALWAYS = /^(winmm\.dll|Mods\/Plugins\/[^/]+\.dll)$/i
const IF_MISSING = /^(ModLoader\.ini|Mods\/(Patches|ExtraPatches)\/[^/]+\.txt)$/i
const LOADER_DLL = 'winmm.dll'
const PATCHER_DLL = 'Mods/Plugins/Patcher.dll'
const SIGNATURE = Buffer.from('EDFModLoader', 'latin1')
const CACHE_MS = 60 * 60 * 1000

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function stateFile(gameDir) {
  return path.join(gameDir, 'Mods', '.modkit', 'loader.json')
}

function readRecord(gameDir) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(gameDir), 'utf8'))
  } catch {
    return null
  }
}

function hashOf(file) {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null
}

// Entries of a release zip that the ModKit is allowed to install, as rel path -> Buffer.
function releaseFiles(buffer) {
  const out = new Map()
  for (const [name, data] of Object.entries(unzipSync(new Uint8Array(buffer)))) {
    const rel = name.replace(/\\/g, '/')
    if (rel.endsWith('/')) continue
    if (rel.split('/').some(s => s === '..' || s === '') || /^[a-z]:/i.test(rel)) {
      throw new Error(`The release zip contains an unsafe path: ${name}`)
    }
    if (ALWAYS.test(rel) || IF_MISSING.test(rel)) out.set(rel, Buffer.from(data))
  }
  return out
}

function busy(e) {
  return e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')
}

function createLoader({ fetch = globalThis.fetch, cacheDir = null } = {}) {
  let cached = null // { at, release }

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EDF6-ModKit' } })
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`)
    return res.json()
  }

  // Latest official release: { tag, url, assets: { name: { url, sha256, size } } }.
  async function latest({ refresh = false } = {}) {
    if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.release
    const data = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`)
    const assets = {}
    for (const name of ASSETS) {
      const a = (data.assets || []).find(x => x.name === name)
      if (!a) throw new Error(`The latest ${REPO} release (${data.tag_name}) has no ${name}`)
      const digest = typeof a.digest === 'string' && a.digest.startsWith('sha256:') ? a.digest.slice(7) : null
      assets[name] = { url: a.browser_download_url, sha256: digest, size: a.size }
    }
    const release = { tag: data.tag_name, url: data.html_url, assets }
    cached = { at: Date.now(), release }
    return release
  }

  async function download(release, name) {
    const asset = release.assets[name]
    const cacheFile = cacheDir && path.join(cacheDir, release.tag, name)
    if (cacheFile && fs.existsSync(cacheFile)) {
      const buf = fs.readFileSync(cacheFile)
      if (!asset.sha256 || sha256(buf) === asset.sha256) return buf
    }
    const res = await fetch(asset.url, { headers: { 'User-Agent': 'EDF6-ModKit' } })
    if (!res.ok) throw new Error(`Download of ${name} failed (${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (asset.sha256 && sha256(buf) !== asset.sha256) {
      throw new Error(`${name} doesn't match the checksum published on GitHub; not installing it`)
    }
    if (cacheFile) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.writeFileSync(cacheFile, buf)
    }
    return buf
  }

  // All installable files of a release: rel -> Buffer.
  async function files(release) {
    const all = new Map()
    for (const name of ASSETS) for (const [rel, buf] of releaseFiles(await download(release, name))) all.set(rel, buf)
    return all
  }

  function localStatus(gameDir) {
    const dll = path.join(gameDir, LOADER_DLL)
    let loader = 'missing'
    if (fs.existsSync(dll)) loader = fs.readFileSync(dll).includes(SIGNATURE) ? 'installed' : 'foreign'
    const patcher = fs.existsSync(path.join(gameDir, PATCHER_DLL)) ? 'installed' : 'missing'
    const record = readRecord(gameDir)
    return { loader, patcher, installedTag: record ? record.tag : null }
  }

  // check: also ask GitHub for the latest release and compare the installed DLLs with it.
  async function status(gameDir, { check = false } = {}) {
    const st = { ...localStatus(gameDir), latestTag: null, upToDate: null, offline: false, error: null }
    if (!check) return st
    try {
      const release = await latest()
      st.latestTag = release.tag
      const releaseDlls = [...(await files(release))].filter(([rel]) => ALWAYS.test(rel))
      const matches = releaseDlls.every(([rel, buf]) => hashOf(path.join(gameDir, rel)) === sha256(buf))
      st.upToDate = st.loader === 'installed' && st.patcher === 'installed' && matches
      // Installed by hand but identical to the latest release: that's its version.
      if (st.upToDate) st.installedTag = release.tag
    } catch (e) {
      st.offline = true
      st.error = e.message
    }
    return st
  }

  async function install(gameDir, { force = false } = {}) {
    const before = localStatus(gameDir)
    if (before.loader === 'foreign' && !force) {
      throw new Error(`${LOADER_DLL} in the game folder belongs to another program, not EDFModLoader. ` +
        'Remove or rename it first (or install with --force to replace it).')
    }
    const release = await latest()
    const all = await files(release)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = path.join(gameDir, 'Mods', '.modkit', 'loader-backup', stamp)
    const result = { tag: release.tag, written: [], kept: [], backedUp: [] }

    try {
      fs.mkdirSync(path.join(gameDir, 'Mods', 'Plugins'), { recursive: true })
      for (const [rel, buf] of all) {
        const target = path.join(gameDir, rel)
        const exists = fs.existsSync(target)
        if (IF_MISSING.test(rel) && exists) {
          result.kept.push(rel)
          continue
        }
        if (exists && hashOf(target) === sha256(buf)) {
          result.kept.push(rel)
          continue
        }
        if (exists) {
          const dst = path.join(backupDir, rel)
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          fs.copyFileSync(target, dst)
          result.backedUp.push(rel)
        }
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, buf)
        result.written.push(rel)
      }
    } catch (e) {
      if (busy(e)) throw new Error('The game seems to be running (a loader file is in use). Close the game and try again.')
      throw e
    }

    const record = { tag: release.tag, installedAt: new Date().toISOString(), files: {} }
    for (const [rel, buf] of all) if (ALWAYS.test(rel)) record.files[rel] = sha256(buf)
    fs.mkdirSync(path.dirname(stateFile(gameDir)), { recursive: true })
    fs.writeFileSync(stateFile(gameDir), JSON.stringify(record, null, 2))
    return result
  }

  return { latest, status, install }
}

module.exports = { createLoader, releaseFiles, REPO }
