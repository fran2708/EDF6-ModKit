// Instalar mods desde un .zip, tal como vienen de Nexus u otros sitios.
//
// Dos casos:
//   - el zip trae uno o más mod.json: son mods del ModKit y se copian tal cual
//   - si no, es un mod "de archivos completos": hay que averiguar a qué archivo del juego
//     corresponde cada cosa, saltando carpetas envoltorio ("MiMod/", "Mods/") y detectando
//     variantes ("Armor x2/", "Armor x10/"), que se ofrecen para elegir una
//
// Para ubicar cada archivo se usa el índice de los CPK del juego (vanilla.relOf / topDirs).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { unzipSync } = require('fflate')
const { fileKey } = require('./mods')
const { importFolder } = require('./importer')

const IGNORED = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/i

// Rutas seguras dentro del zip: sin absolutas, sin "..", con / como separador.
function safeEntries(buffer) {
  const raw = unzipSync(new Uint8Array(buffer))
  const out = []
  for (const [name, data] of Object.entries(raw)) {
    const rel = name.replace(/\\/g, '/')
    if (rel.endsWith('/') || IGNORED.test(rel)) continue
    const segs = rel.split('/').filter(s => s && s !== '.')
    if (segs.some(s => s === '..') || /^[a-z]:/i.test(segs[0] || '')) {
      throw new Error(`El zip tiene una ruta insegura: ${name}`)
    }
    out.push({ segs, data: Buffer.from(data) })
  }
  return out
}

// Ubica un archivo en el juego. Devuelve { gameRel, label } o null.
//   gameRel: ruta en el juego (DEFAULTPACKAGE/CONFIG.SGO)
//   label:   lo que sobra (envoltorios + carpeta de variante), para agrupar variantes
function locate(segs, vanilla, topDirs, exts = vanilla.extensions()) {
  const n = segs.length
  // 1. un sufijo de la ruta es un archivo conocido: MiMod/WEAPON/A.SGO
  for (let k = 0; k < n; k++) {
    const rel = vanilla.relOf(fileKey(segs.slice(k).join('/')))
    if (rel) return { gameRel: rel, label: segs.slice(0, k).join('/') }
  }
  // 2. sacando una carpeta intermedia es un archivo conocido: DEFAULTPACKAGE/Armor x10/CONFIG.SGO
  for (let k = 0; k < n; k++) {
    for (let j = k + 1; j < n - 1; j++) {
      const rest = [...segs.slice(k, j), ...segs.slice(j + 1)]
      const rel = vanilla.relOf(fileKey(rest.join('/')))
      if (rel) return { gameRel: rel, label: [...segs.slice(0, k), segs[j]].join('/') }
    }
  }
  // 3. archivo nuevo dentro de una carpeta del juego: MiMod/UI/nueva.dds. Solo con extensiones
  //    que el juego usa en esa carpeta, para no instalar readmes o los .json de sgott.
  const ext = /\.[^.]+$/.exec(segs[n - 1])
  const top = segs.findIndex((s, i) => i < n - 1 && topDirs.has(s.toUpperCase()))
  if (top === -1 || !ext || !exts.get(segs[top].toUpperCase())?.has(ext[0].toUpperCase())) return null
  return { gameRel: segs.slice(top).join('/'), label: segs.slice(0, top).join('/') }
}

// Analiza el zip sin instalar nada.
function analyzeZip(buffer, vanilla) {
  const entries = safeEntries(buffer)
  const manifests = entries.filter(e => e.segs.at(-1).toLowerCase() === 'mod.json')
  if (manifests.length) {
    return {
      kind: 'modkit',
      mods: manifests.map(m => {
        const dir = m.segs.slice(0, -1)
        const prefix = dir.join('/')
        return {
          dir: prefix,
          files: entries
            .filter(e => prefix === '' || e.segs.slice(0, dir.length).join('/') === prefix)
            .map(e => ({ rel: e.segs.slice(dir.length).join('/'), data: e.data })),
        }
      }),
    }
  }

  const topDirs = vanilla.topDirs()
  const exts = vanilla.extensions()
  const groups = new Map()
  const ignored = []
  for (const e of entries) {
    const at = locate(e.segs, vanilla, topDirs, exts)
    if (!at) {
      ignored.push(e.segs.join('/'))
      continue
    }
    if (!groups.has(at.label)) groups.set(at.label, [])
    groups.get(at.label).push({ rel: at.gameRel, data: e.data })
  }
  if (!groups.size) throw new Error('No encontré archivos del juego en el zip')
  return { kind: 'legacy', groups, ignored }
}

function slug(text) {
  const s = text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\.zip$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s || 'mod'
}

function uniqueId(modsDir, base) {
  let id = base
  for (let i = 2; fs.existsSync(path.join(modsDir, id)); i++) id = `${base}-${i}`
  return id
}

function writeFiles(dir, files) {
  for (const f of files) {
    const abs = path.join(dir, f.rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, f.data)
  }
}

// Nombre legible para una variante: la última carpeta de su etiqueta.
function variantName(label) {
  return label ? label.split('/').at(-1) : '(base)'
}

// Instala el zip. Si es un mod viejo con varias variantes y no se eligió una, devuelve
// { variants } para que el usuario elija y se vuelva a llamar con `variant`.
function installZip(buffer, { zipName = 'mod.zip', modsDir, vanilla, variant } = {}) {
  const analysis = analyzeZip(buffer, vanilla)
  const baseName = slug(path.basename(zipName))

  if (analysis.kind === 'modkit') {
    const installed = []
    for (const m of analysis.mods) {
      const id = uniqueId(modsDir, slug(m.dir ? m.dir.split('/').at(-1) : baseName))
      writeFiles(path.join(modsDir, id), m.files)
      installed.push(id)
    }
    return { installed, notes: [] }
  }

  const labels = [...analysis.groups.keys()]
  let label
  if (labels.length === 1) {
    label = labels[0]
  } else if (variant !== undefined) {
    if (!analysis.groups.has(variant)) throw new Error(`No existe la variante "${variant}"`)
    label = variant
  } else {
    return {
      variants: labels.map(l => ({
        label: l,
        name: variantName(l),
        files: analysis.groups.get(l).map(f => f.rel),
      })),
    }
  }

  // Se arma una carpeta con la estructura del juego y se importa como cualquier mod viejo.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'edfmk-zip-'))
  try {
    writeFiles(staging, analysis.groups.get(label))
    const suffix = labels.length > 1 ? ` (${variantName(label)})` : ''
    const name = path.basename(zipName).replace(/\.zip$/i, '') + suffix
    const id = uniqueId(modsDir, slug(name))
    const source = path.basename(zipName) + (labels.length > 1 ? ` (${variantName(label)})` : '')
    const result = importFolder(staging, path.join(modsDir, id), { vanilla, id, name, source })
    const notes = [...result.notes]
    if (analysis.ignored.length) notes.push(`Se ignoraron ${analysis.ignored.length} archivo(s) que no son del juego: ${analysis.ignored.slice(0, 3).join(', ')}`)
    return { installed: [id], notes }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

module.exports = { analyzeZip, installZip, locate, slug }
