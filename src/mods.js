// Loading mods from disk.
//
// A mod is a folder:
//   mods/<id>/mod.json      metadata + patches
//   mods/<id>/files/...     whole files, with the same structure as the game's Mods folder
//
// mod.json:
//   {
//     "name": "Armor x10",
//     "version": "1.0.0",
//     "author": "...",
//     "description": "...",
//     "patches": {
//       "DEFAULTPACKAGE/CONFIG.SGO": [ { "op": "mul", "path": "SoldierInit/*/3/1", "value": 10 } ]
//     }
//   }

const fs = require('fs')
const path = require('path')
const { validate } = require('./patch')

// Key used to compare game file paths: Windows is case-insensitive.
function fileKey(rel) {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '').toUpperCase()
}

function listFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(d, entry.name), r)
      else out.push(r)
    }
  }
  walk(dir, '')
  return out
}

function loadMod(dir) {
  const manifestPath = path.join(dir, 'mod.json')
  if (!fs.existsSync(manifestPath)) return null
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    throw new Error(`${manifestPath}: invalid JSON (${e.message})`)
  }
  const id = manifest.id || path.basename(dir)
  const patches = manifest.patches || {}
  for (const [file, ops] of Object.entries(patches)) {
    if (!Array.isArray(ops)) throw new Error(`${id}: the patches for "${file}" must be a list`)
    ops.forEach((op, i) => {
      try {
        validate(op)
      } catch (e) {
        throw new Error(`${id}: ${file} operation #${i + 1}: ${e.message}`)
      }
    })
  }
  const filesDir = path.join(dir, 'files')
  return {
    id,
    dir,
    name: manifest.name || id,
    version: manifest.version || '',
    author: manifest.author || '',
    description: manifest.description || '',
    patches,
    files: listFiles(filesDir).map(rel => ({ rel, abs: path.join(filesDir, rel) })),
  }
}

function loadMods(modsDir) {
  if (!fs.existsSync(modsDir)) return []
  return fs.readdirSync(modsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => loadMod(path.join(modsDir, e.name)))
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id))
}

// Index of a folder with game files: normalized key -> { rel, abs }.
function indexDir(dir) {
  const index = new Map()
  for (const rel of listFiles(dir)) index.set(fileKey(rel), { rel, abs: path.join(dir, rel) })
  return index
}

// The mods `load` enables, in load order. strict: throw on ids that don't exist instead of
// skipping them.
function activeMods(modsDir, load, { strict = false } = {}) {
  const all = loadMods(modsDir)
  const byId = new Map(all.map(m => [m.id, m]))
  const missing = load.filter(id => !byId.has(id))
  if (strict && missing.length) throw new Error(`"load" lists mods that don't exist in ${modsDir}: ${missing.join(', ')}`)
  return { all, active: load.filter(id => byId.has(id)).map(id => byId.get(id)) }
}

// base, or base-2, base-3... whichever isn't taken in modsDir yet.
function uniqueId(modsDir, base) {
  let id = base
  for (let i = 2; fs.existsSync(path.join(modsDir, id)); i++) id = `${base}-${i}`
  return id
}

module.exports = { fileKey, listFiles, loadMods, activeMods, indexDir, uniqueId }
