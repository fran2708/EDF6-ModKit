// Installing mods from a .zip, as they come from Nexus or other sites.
//
// Two cases:
//   - the zip has one or more mod.json files: they are ModKit mods and are copied as is
//   - otherwise it's a "whole file" mod: we have to work out which game file each entry maps
//     to, skipping wrapper folders ("MyMod/", "Mods/") and detecting variants ("Armor x2/",
//     "Armor x10/"), which are offered so the user picks one
//
// Each file is located using the index of the game's CPKs (vanilla.relOf / topDirs).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { unzipSync } = require('fflate')
const { fileKey } = require('./mods')
const { importFolder } = require('./importer')

const IGNORED = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$)/i

// Safe paths inside the zip: no absolute paths, no "..", / as separator.
function safeEntries(buffer) {
  const raw = unzipSync(new Uint8Array(buffer))
  const out = []
  for (const [name, data] of Object.entries(raw)) {
    const rel = name.replace(/\\/g, '/')
    if (rel.endsWith('/') || IGNORED.test(rel)) continue
    const segs = rel.split('/').filter(s => s && s !== '.')
    if (segs.some(s => s === '..') || /^[a-z]:/i.test(segs[0] || '')) {
      throw new Error(`The zip contains an unsafe path: ${name}`)
    }
    out.push({ segs, data: Buffer.from(data) })
  }
  return out
}

// Locates a file in the game. Returns { gameRel, label } or null.
//   gameRel: path in the game (DEFAULTPACKAGE/CONFIG.SGO)
//   label:   whatever is left over (wrappers + variant folder), used to group variants
function locate(segs, vanilla, topDirs, exts = vanilla.extensions()) {
  const n = segs.length
  // 1. a suffix of the path is a known file: MyMod/WEAPON/A.SGO
  for (let k = 0; k < n; k++) {
    const rel = vanilla.relOf(fileKey(segs.slice(k).join('/')))
    if (rel) return { gameRel: rel, label: segs.slice(0, k).join('/') }
  }
  // 2. dropping one inner folder gives a known file: DEFAULTPACKAGE/Armor x10/CONFIG.SGO
  for (let k = 0; k < n; k++) {
    for (let j = k + 1; j < n - 1; j++) {
      const rest = [...segs.slice(k, j), ...segs.slice(j + 1)]
      const rel = vanilla.relOf(fileKey(rest.join('/')))
      if (rel) return { gameRel: rel, label: [...segs.slice(0, k), segs[j]].join('/') }
    }
  }
  // 3. a new file inside a game folder: MyMod/UI/new.dds. Only with extensions the game uses in
  //    that folder, so readmes or sgott's .json files don't get installed.
  const ext = /\.[^.]+$/.exec(segs[n - 1])
  const top = segs.findIndex((s, i) => i < n - 1 && topDirs.has(s.toUpperCase()))
  if (top === -1 || !ext || !exts.get(segs[top].toUpperCase())?.has(ext[0].toUpperCase())) return null
  return { gameRel: segs.slice(top).join('/'), label: segs.slice(0, top).join('/') }
}

// Analyzes the zip without installing anything.
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
  if (!groups.size) throw new Error('No game files found in the zip')
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

// Readable name for a variant: the last folder of its label.
function variantName(label) {
  return label ? label.split('/').at(-1) : '(base)'
}

// Installs the zip. If it's an old-style mod with several variants and none was picked, returns
// { variants } so the user can choose and call again with `variant`.
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
    if (!analysis.groups.has(variant)) throw new Error(`Variant "${variant}" does not exist`)
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

  // Build a folder with the game's structure and import it like any old-style mod.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'edfmk-zip-'))
  try {
    writeFiles(staging, analysis.groups.get(label))
    const suffix = labels.length > 1 ? ` (${variantName(label)})` : ''
    const name = path.basename(zipName).replace(/\.zip$/i, '') + suffix
    const id = uniqueId(modsDir, slug(name))
    const source = path.basename(zipName) + suffix
    const result = importFolder(staging, path.join(modsDir, id), { vanilla, id, name, source })
    const notes = [...result.notes]
    if (analysis.ignored.length) {
      notes.push(`Ignored ${analysis.ignored.length} file(s) that are not game files: ${analysis.ignored.slice(0, 3).join(', ')}`)
    }
    return { installed: [id], notes }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

module.exports = { analyzeZip, installZip, locate, slug }
