// Installing mods from a .zip, as they come from Nexus or other sites.
//
// Three cases:
//   - the zip has one or more mod.json files: they are ModKit mods and are copied as is
//   - it has a DLL in a Plugins folder: an EDFModLoader plugin, laid out like the game's Mods
//     folder (Mods/Plugins/X.dll + Mods/X/...); everything under that folder is installed as is
//   - otherwise it's a "whole file" mod: we have to work out which game file each entry maps
//     to, skipping wrapper folders ("MyMod/", "Mods/") and detecting variants ("Armor x2/",
//     "Armor x10/"), which are offered so the user picks one
//
// Each file is located using the index of the game's CPKs (vanilla.relOf / topDirs).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { unzipSync } = require('fflate')
const { fileKey, uniqueId } = require('./mods')
const { importFolder } = require('./importer')
const { looksLikePatch, patchInfo } = require('./patcher')
const { PATCHER_DLL } = require('./loader')
const { gameTopDirs, isUserData } = require('./vanilla')

// Files a plugin zip must not replace: they come with EDFModLoader (see loader.js).
const LOADER_FILES = new Set([fileKey(PATCHER_DLL.replace(/^Mods\//, ''))])

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
  // 3. a Patcher memory patch: MyMod/Mods/Patches/Something.txt. Patcher only reads that folder
  //    (not ExtraPatches, which holds optional presets).
  if (n >= 2 && /\.txt$/i.test(segs[n - 1]) && segs[n - 2].toLowerCase() === 'patches') {
    return { gameRel: `Patches/${segs[n - 1]}`, label: segs.slice(0, n - 2).join('/') }
  }
  // 4. a new file inside a game folder: MyMod/UI/new.dds. Only with extensions the game uses in
  //    that folder, so readmes or sgott's .json files don't get installed.
  const ext = /\.[^.]+$/.exec(segs[n - 1])
  const top = segs.findIndex((s, i) => i < n - 1 && topDirs.has(s.toUpperCase()))
  if (top === -1 || !ext || !exts.get(segs[top].toUpperCase())?.has(ext[0].toUpperCase())) return null
  return { gameRel: segs.slice(top).join('/'), label: segs.slice(0, top).join('/') }
}

// A plugin zip: the files in folders under root (the folder that holds Plugins/), at their path
// inside Mods/. Loose files in root and anything outside it (readmes) are ignored.
function analyzePlugin(entries, root) {
  const prefix = fileKey(root.join('/'))
  const files = []
  const ignored = []
  const skipped = []
  for (const e of entries) {
    if (e.segs.length < root.length + 2 || fileKey(e.segs.slice(0, root.length).join('/')) !== prefix) {
      ignored.push(e.segs.join('/'))
      continue
    }
    const rel = e.segs.slice(root.length).join('/')
    if (LOADER_FILES.has(fileKey(rel))) skipped.push(rel)
    else files.push({ rel, data: e.data })
  }
  return { kind: 'plugin', files, ignored, skipped }
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

  // Patch packs often bundle the loader's own Patcher.dll: that alone doesn't make a plugin.
  const dll = entries.find(e => e.segs.length >= 2 && /\.dll$/i.test(e.segs.at(-1)) &&
    e.segs.at(-2).toLowerCase() === 'plugins' && !LOADER_FILES.has(fileKey(e.segs.slice(-2).join('/'))))
  if (dll) return analyzePlugin(entries, dll.segs.slice(0, -2))

  const topDirs = vanilla.topDirs()
  const exts = vanilla.extensions()
  const groups = new Map()
  const ignored = []
  for (const e of entries) {
    let at = locate(e.segs, vanilla, topDirs, exts)
    // Patch packs often ship their Patcher .txt files loose, outside any Patches folder: they
    // are recognized by their content (readmes don't parse as patches).
    // ExtraPatches holds optional presets that Patcher never loads, so those stay out.
    const inExtras = e.segs.slice(0, -1).some(s => s.toLowerCase() === 'extrapatches')
    if (!at && !inExtras && /\.txt$/i.test(e.segs.at(-1)) && looksLikePatch(e.data.toString('utf8'))) {
      at = { gameRel: `Patches/${e.segs.at(-1)}`, label: e.segs.slice(0, -1).join('/') }
    }
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

function writeFiles(dir, files) {
  for (const f of files) {
    const abs = path.join(dir, f.rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, f.data)
  }
}

// Readable mod name from a download: "Moist Patches v1.2-71-v1-2-1728004564.zip" (Nexus adds the
// mod id, version and a timestamp; browsers add "(1)" to repeated downloads) -> "Moist Patches v1.2".
function cleanZipName(zipName) {
  return path.basename(zipName)
    .replace(/\.zip$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/-\d+(?:-[a-z0-9.]+)*-\d{9,}$/i, '')
    .trim() || 'mod'
}

const PATCH_REL = /^Patches\/[^/]+\.txt$/i

// A group made only of Patcher patches is a pack of independent tweaks: each patch becomes its
// own mod, so the player enables just the ones they want.
function installPatchMods(files, { modsDir, packName }) {
  const installed = []
  for (const f of files) {
    const patchName = path.basename(f.rel, path.extname(f.rel))
    const name = files.length > 1 ? `${packName}: ${patchName}` : packName
    const id = uniqueId(modsDir, slug(name))
    const info = patchInfo(f.data.toString('utf8'))
    const dir = path.join(modsDir, id)
    writeFiles(path.join(dir, 'files'), [f])
    const manifest = {
      name,
      version: '',
      author: info.author,
      description: info.description || `Memory patch from ${packName}`,
      patches: {},
    }
    fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify(manifest, null, 2) + '\n')
    installed.push(id)
  }
  return installed
}

// Readable name for a variant: the last folder of its label.
function variantName(label) {
  return label ? label.split('/').at(-1) : '(base)'
}

// Builds a folder with the game's structure and imports it like any old-style mod.
function importFiles(files, { modsDir, vanilla, name, source }) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'edfmk-zip-'))
  try {
    writeFiles(staging, files)
    const id = uniqueId(modsDir, slug(name))
    const result = importFolder(staging, path.join(modsDir, id), { vanilla, id, name, source })
    return { id, notes: result.notes }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

function installPlugin(analysis, { zipName, modsDir, vanilla }) {
  if (!analysis.files.length) throw new Error('The plugin zip has nothing to install besides EDFModLoader files')
  const { id, notes } = importFiles(analysis.files, {
    modsDir, vanilla, name: cleanZipName(zipName), source: path.basename(zipName),
  })
  const dirs = gameTopDirs(vanilla)
  const dataDirs = [...new Set(analysis.files.filter(f => isUserData(f.rel, dirs)).map(f => f.rel.split('/')[0] + '/'))]
  if (dataDirs.length) {
    notes.push(`Your settings and progress in ${dataDirs.join(', ')} are kept when you turn it off or update it.`)
  }
  if (analysis.skipped.length) {
    notes.push(`Skipped ${analysis.skipped.join(', ')}: it comes with EDFModLoader, which the ModKit installs and updates.`)
  }
  if (analysis.ignored.length) {
    notes.push(`Ignored ${analysis.ignored.length} file(s) outside the Mods folder: ${analysis.ignored.slice(0, 3).join(', ')}`)
  }
  return { installed: [id], notes }
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
  if (analysis.kind === 'plugin') return installPlugin(analysis, { zipName, modsDir, vanilla })

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

  const files = analysis.groups.get(label)
  const suffix = labels.length > 1 ? ` (${variantName(label)})` : ''
  const name = cleanZipName(zipName) + suffix
  const source = path.basename(zipName) + suffix
  const ignoredNote = analysis.ignored.length
    ? [`Ignored ${analysis.ignored.length} file(s) that are not game files: ${analysis.ignored.slice(0, 3).join(', ')}`]
    : []

  if (files.every(f => PATCH_REL.test(f.rel))) {
    const installed = installPatchMods(files, { modsDir, packName: name })
    const notes = installed.length > 1
      ? [`Each of the ${installed.length} patches was installed as its own mod, so you can enable only the ones you want.`]
      : []
    return { installed, notes: [...notes, ...ignoredNote] }
  }

  const { id, notes } = importFiles(files, { modsDir, vanilla, name, source })
  return { installed: [id], notes: [...notes, ...ignoredNote] }
}

module.exports = { analyzeZip, installZip, locate, slug, cleanZipName }
