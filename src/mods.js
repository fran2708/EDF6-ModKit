// Carga de mods desde disco.
//
// Un mod es una carpeta:
//   mods/<id>/mod.json      metadatos + parches
//   mods/<id>/files/...     archivos completos, con la misma estructura que la carpeta Mods del juego
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

// Clave para comparar rutas de archivos del juego: Windows no distingue mayúsculas.
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
    throw new Error(`${manifestPath}: JSON inválido (${e.message})`)
  }
  const id = manifest.id || path.basename(dir)
  const patches = manifest.patches || {}
  for (const [file, ops] of Object.entries(patches)) {
    if (!Array.isArray(ops)) throw new Error(`${id}: los parches de "${file}" tienen que ser una lista`)
    ops.forEach((op, i) => {
      try {
        validate(op)
      } catch (e) {
        throw new Error(`${id}: ${file} operación #${i + 1}: ${e.message}`)
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

// Índice de una carpeta con archivos del juego: clave normalizada -> { rel, abs }.
function indexDir(dir) {
  const index = new Map()
  for (const rel of listFiles(dir)) index.set(fileKey(rel), { rel, abs: path.join(dir, rel) })
  return index
}

module.exports = { fileKey, listFiles, loadMod, loadMods, indexDir }
