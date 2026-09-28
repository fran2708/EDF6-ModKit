// Originales del juego a demanda.
//
// vanillaProvider() se usa igual que el Map de indexDir(): get(fileKey) -> { rel, abs }. Primero
// busca en la carpeta vanilla/ (así se pueden seguir poniendo archivos a mano) y, si no está, lo
// extrae de los CPK del juego a vanilla/<ruta> y devuelve esa copia.

const fs = require('fs')
const path = require('path')
const cpk = require('./cpk')
const { indexDir } = require('./mods')

// Root.cpk primero: es el que tiene los datos (SGO, armas, misiones). Los Chunk y DX11 son
// sobre todo mapas y shaders.
function cpkFiles(gameDir) {
  if (!gameDir || !fs.existsSync(gameDir)) return []
  const found = fs.readdirSync(gameDir).filter(f => /\.cpk$/i.test(f))
  found.sort((a, b) => (/^root\.cpk$/i.test(b) ? 1 : 0) - (/^root\.cpk$/i.test(a) ? 1 : 0) || a.localeCompare(b))
  return found.map(f => path.join(gameDir, f))
}

function vanillaProvider({ vanillaDir, gameDir }) {
  const local = vanillaDir ? indexDir(vanillaDir) : new Map()
  let archives = null // se leen recién cuando hace falta el primer archivo que no está en vanilla/

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

  // Carpetas de primer nivel conocidas (DEFAULTPACKAGE, WEAPON, ...), para reconocer mods en zips.
  function topDirs() {
    const dirs = new Set()
    const add = k => k.includes('/') && dirs.add(k.split('/')[0])
    for (const k of local.keys()) add(k)
    for (const { index } of loadArchives()) for (const k of index.keys()) add(k)
    return dirs
  }

  // Nombre real del archivo en el juego, sin extraerlo.
  function relOf(key) {
    if (local.has(key)) return local.get(key).rel
    for (const { index } of loadArchives()) if (index.has(key)) return index.get(key).rel
    return undefined
  }

  return { get, relOf, topDirs, archives: () => loadArchives() }
}

module.exports = { vanillaProvider, cpkFiles }
