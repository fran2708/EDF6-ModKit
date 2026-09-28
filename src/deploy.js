// Escribe el resultado del build en la carpeta Mods del juego sin romper lo que ya había.
//
// En <outDir>/.modkit/ se guarda:
//   manifest.json   qué archivos escribió el modkit y con qué hash
//   backup/...      los archivos que había antes (puestos a mano) y que el modkit tuvo que pisar
//
// Al volver a hacer build o clean, los archivos que ya no produce ningún mod se borran y, si
// había un respaldo, se restaura. Si alguien editó a mano un archivo del modkit, se respalda
// antes de pisarlo.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const STATE_DIR = '.modkit'

function sha1(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex')
}

function statePaths(outDir) {
  const dir = path.join(outDir, STATE_DIR)
  return { dir, manifest: path.join(dir, 'manifest.json'), backup: path.join(dir, 'backup') }
}

function readManifest(outDir) {
  const { manifest } = statePaths(outDir)
  if (!fs.existsSync(manifest)) return { files: {} }
  return JSON.parse(fs.readFileSync(manifest, 'utf8'))
}

function writeManifest(outDir, data) {
  const { dir, manifest } = statePaths(outDir)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(manifest, JSON.stringify(data, null, 2))
}

function hashOf(file) {
  return fs.existsSync(file) ? sha1(fs.readFileSync(file)) : null
}

function backupFile(outDir, rel, log, suffix = '') {
  const src = path.join(outDir, rel)
  const dst = path.join(statePaths(outDir).backup, rel + suffix)
  if (fs.existsSync(dst)) return
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.copyFileSync(src, dst)
  log.push(`respaldado ${rel}${suffix ? ` (${suffix.slice(1)})` : ''}`)
}

function restoreOrDelete(outDir, rel, entry, log) {
  const target = path.join(outDir, rel)
  const current = hashOf(target)
  if (current && current !== entry.sha1) {
    log.push(`no se toca ${rel}: fue editado a mano después del último build`)
    return
  }
  const backup = path.join(statePaths(outDir).backup, rel)
  if (fs.existsSync(backup)) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(backup, target)
    log.push(`restaurado ${rel}`)
  } else if (current) {
    fs.unlinkSync(target)
    log.push(`borrado ${rel}`)
  }
}

// outputs: Map key -> { rel, buffer, mods }
function deploy(outDir, outputs, { dryRun = false } = {}) {
  const log = []
  const old = readManifest(outDir)
  const next = { files: {} }

  for (const [key, entry] of Object.entries(old.files)) {
    if (!outputs.has(key)) {
      if (dryRun) log.push(`se quitaría ${entry.rel}`)
      else restoreOrDelete(outDir, entry.rel, entry, log)
    }
  }

  for (const [key, out] of outputs) {
    const target = path.join(outDir, out.rel)
    const hash = sha1(out.buffer)
    const current = hashOf(target)
    const prev = old.files[key]

    if (dryRun) {
      if (current !== hash) log.push(`${current ? 'se reemplazaría' : 'se escribiría'} ${out.rel} (${out.mods.join(', ')})`)
      continue
    }
    // Un archivo que el modkit no escribió se respalda aunque sea idéntico: un clean posterior
    // lo tiene que poder devolver.
    if (current && !prev) backupFile(outDir, out.rel, log)
    else if (current && current !== hash && current !== prev.sha1) {
      backupFile(outDir, out.rel, log, `.editado-${Date.now()}`)
    }
    if (current === hash) {
      next.files[key] = { rel: out.rel, sha1: hash, mods: out.mods }
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, out.buffer)
    next.files[key] = { rel: out.rel, sha1: hash, mods: out.mods }
    log.push(`escrito ${out.rel} (${out.mods.join(', ')})`)
  }

  if (!dryRun) writeManifest(outDir, next)
  return log
}

// Cuántos archivos cambiarían si se hiciera deploy ahora (0 = Mods/ ya está al día).
function pendingChanges(outDir, outputs) {
  const old = readManifest(outDir)
  let count = 0
  for (const out of outputs.values()) {
    if (hashOf(path.join(outDir, out.rel)) !== sha1(out.buffer)) count++
  }
  for (const key of Object.keys(old.files)) if (!outputs.has(key)) count++
  return count
}

function clean(outDir) {
  const log = []
  const old = readManifest(outDir)
  for (const entry of Object.values(old.files)) restoreOrDelete(outDir, entry.rel, entry, log)
  writeManifest(outDir, { files: {} })
  return log
}

module.exports = { deploy, clean, readManifest, pendingChanges }
