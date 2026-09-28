// Turns a "whole file" mod (a folder with the Mods structure) into a ModKit mod: SGO/DSGO files
// that can be compared with the original become patches, everything else is copied to files/
// as is.

const fs = require('fs')
const path = require('path')
const codec = require('./codec')
const { diff } = require('./diff')
const { fileKey, listFiles, indexDir } = require('./mods')

function importFolder(srcDir, destDir, { vanilla, vanillaDir, id, name, source } = {}) {
  vanilla = vanilla || (vanillaDir ? indexDir(vanillaDir) : new Map())
  const patches = {}
  const copied = []
  const skipped = []
  const notes = []

  for (const rel of listFiles(srcDir)) {
    const abs = path.join(srcDir, rel)
    const buffer = fs.readFileSync(abs)
    const base = codec.isPatchable(buffer) ? vanilla.get(fileKey(rel)) : undefined
    if (base) {
      const { ops, warnings } = diff(codec.readDoc(base.abs), codec.decode(buffer))
      if (warnings.length === 0) {
        if (ops.length === 0) skipped.push(rel)
        else patches[base.rel] = ops
        continue
      }
      notes.push(`${rel}: ${warnings[0]}; copied as a whole file`)
    } else if (codec.isPatchable(buffer)) {
      notes.push(`${rel}: not among the originals; copied as a whole file`)
    }
    const dst = path.join(destDir, 'files', rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(abs, dst)
    copied.push(rel)
  }

  const manifest = {
    name: name || id || path.basename(srcDir),
    version: '1.0.0',
    author: '',
    description: `Imported from ${source || path.basename(srcDir)}`,
    patches,
  }
  fs.mkdirSync(destDir, { recursive: true })
  fs.writeFileSync(path.join(destDir, 'mod.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { patched: Object.keys(patches), copied, skipped, notes }
}

module.exports = { importFolder }
