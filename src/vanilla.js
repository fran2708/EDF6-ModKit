// Original game files on demand.
//
// vanillaProvider() has get(fileKey) -> { rel, abs }, like the Map from indexDir(). It looks in the vanilla/ folder first (so files can still be placed there by hand) and, if the
// file isn't there, extracts it from the game's CPKs into vanilla/<path> and returns that copy.

const fs = require('fs')
const path = require('path')
const cpk = require('./cpk')
const { indexDir } = require('./mods')

// Root.cpk first: it holds the data (SGO, weapons, missions). Chunk and DX11 are mostly maps
// and shaders.
function cpkFiles(gameDir) {
  if (!gameDir || !fs.existsSync(gameDir)) return []
  const found = fs.readdirSync(gameDir).filter(f => /\.cpk$/i.test(f))
  found.sort((a, b) => (/^root\.cpk$/i.test(b) ? 1 : 0) - (/^root\.cpk$/i.test(a) ? 1 : 0) || a.localeCompare(b))
  return found.map(f => path.join(gameDir, f))
}

function vanillaProvider({ vanillaDir, gameDir }) {
  const local = vanillaDir ? indexDir(vanillaDir) : new Map()
  let archives = null // only read once the first file missing from vanilla/ is needed

  function loadArchives() {
    if (archives) return archives
    archives = cpkFiles(gameDir).map(file => {
      try {
        return { file, index: cpk.readIndex(file) }
      } catch (e) {
        return { file, index: new Map(), error: e.message }
      }
    })
    return archives
  }

  function get(key) {
    if (local.has(key)) return local.get(key)
    if (!vanillaDir) return undefined
    for (const { file, index } of loadArchives()) {
      const entry = index.get(key)
      if (!entry) continue
      const abs = path.join(vanillaDir, entry.rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, cpk.extract(file, entry))
      const found = { rel: entry.rel, abs }
      local.set(key, found)
      return found
    }
    return undefined
  }

  // Extensions the game uses in each top-level folder, upper case:
  // Map('WEAPON' -> Set('.SGO', '.DDS', ...)). Per folder because, for example, MISSION has
  // .JSON files but DEFAULTPACKAGE doesn't.
  function extensions() {
    const exts = new Map()
    const add = k => {
      if (!k.includes('/')) return
      const top = k.split('/')[0]
      if (!exts.has(top)) exts.set(top, new Set())
      const m = /\.[^./]+$/.exec(k)
      if (m) exts.get(top).add(m[0])
    }
    for (const k of local.keys()) add(k)
    for (const { index } of loadArchives()) for (const k of index.keys()) add(k)
    return exts
  }

  // Known top-level folders (DEFAULTPACKAGE, WEAPON, ...), to recognize mods inside zips.
  const topDirs = () => new Set(extensions().keys())

  // The file's real name in the game, without extracting it.
  function relOf(key) {
    if (local.has(key)) return local.get(key).rel
    for (const { index } of loadArchives()) if (index.has(key)) return index.get(key).rel
    return undefined
  }

  return { get, relOf, topDirs, extensions }
}

// true if rel (a path inside Mods/) is in one of the game's folders, rather than a plugin's data
// folder or a loose file.
function isGameRel(rel, dirs) {
  const segs = rel.replace(/\\/g, '/').split('/')
  return segs.length > 1 && dirs.has(segs[0].toUpperCase())
}

// true for a plugin's data (Compendium/config.ini...): not a game file, and not in the folders
// EDFModLoader and Patcher read (Plugins, Patches, ExtraPatches). The player or the plugin may
// change these files, so deploy never overwrites or deletes an edited one.
function isUserData(rel, dirs) {
  return !isGameRel(rel, dirs) && !/^(Plugins|Patches|ExtraPatches)[\\/]/i.test(rel)
}

module.exports = { vanillaProvider, isGameRel, isUserData }
