// Writes the build result into the game's Mods folder without breaking what was already there.
//
// <outDir>/.modkit/ holds:
//   manifest.json   which files the ModKit wrote and their hashes
//   backup/...      files that were there before (placed by hand) and had to be overwritten
//
// On the next build or clean, files no mod produces anymore are deleted and, if there was a
// backup, it is restored. If someone edited a ModKit file by hand, it is backed up before
// being overwritten.

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
  log.push(`backed up ${rel}${suffix ? ` (${suffix.slice(1)})` : ''}`)
}

function restoreOrDelete(outDir, rel, entry, log) {
  const target = path.join(outDir, rel)
  const current = hashOf(target)
  if (current && current !== entry.sha1) {
    log.push(`left ${rel} alone: it was edited by hand after the last build`)
    return
  }
  const backup = path.join(statePaths(outDir).backup, rel)
  if (fs.existsSync(backup)) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(backup, target)
    log.push(`restored ${rel}`)
  } else if (current) {
    fs.unlinkSync(target)
    log.push(`deleted ${rel}`)
  }
}

// outputs: Map key -> { rel, buffer, mods }
function deploy(outDir, outputs, { dryRun = false } = {}) {
  const log = []
  const old = readManifest(outDir)
  const next = { files: {} }

  for (const [key, entry] of Object.entries(old.files)) {
    if (!outputs.has(key)) {
      if (dryRun) log.push(`would remove ${entry.rel}`)
      else restoreOrDelete(outDir, entry.rel, entry, log)
    }
  }

  for (const [key, out] of outputs) {
    const target = path.join(outDir, out.rel)
    const hash = sha1(out.buffer)
    const current = hashOf(target)
    const prev = old.files[key]

    if (dryRun) {
      if (current !== hash) log.push(`${current ? 'would replace' : 'would write'} ${out.rel} (${out.mods.join(', ')})`)
      continue
    }
    // A file the ModKit didn't write is backed up even if identical: a later clean has to be
    // able to bring it back.
    if (current && !prev) backupFile(outDir, out.rel, log)
    else if (current && current !== hash && current !== prev.sha1) {
      backupFile(outDir, out.rel, log, `.edited-${Date.now()}`)
    }
    if (current === hash) {
      next.files[key] = { rel: out.rel, sha1: hash, mods: out.mods }
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, out.buffer)
    next.files[key] = { rel: out.rel, sha1: hash, mods: out.mods }
    log.push(`wrote ${out.rel} (${out.mods.join(', ')})`)
  }

  if (!dryRun) writeManifest(outDir, next)
  return log
}

// How many files would change if deploy ran now (0 = Mods/ is up to date).
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
