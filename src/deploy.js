// Writes the build result into the game's Mods folder without breaking what was already there.
//
// <outDir>/.modkit/ holds:
//   manifest.json   which files the ModKit wrote and their hashes
//   backup/...      files that were there before (placed by hand) and had to be overwritten
//
// On the next build or clean, files no mod produces anymore are deleted and, if there was a
// backup, it is restored. If someone edited a ModKit file by hand, it is backed up before
// being overwritten.
//
// Files that were in Mods/ before the ModKit and got imported as a mod (importInstalled) are
// "adopted" by that mod (the entry's `adopted` is its id): they stay backed up so clean brings
// them back, but disabling the imported mod deletes them instead of restoring the backup, since
// the mod now lives in the ModKit. They stay adopted after a clean too, so the restored files
// aren't offered for import a second time.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { fileKey, listFiles } = require('./mods')
const { isGameRel } = require('./vanilla')

const STATE_DIR = '.modkit'
// Folders of Mods/ that belong to the ModKit or to EDFModLoader/Patcher rather than to a mod.
const RESERVED = /^(\.modkit|Plugins|Patches|ExtraPatches)(\/|$)/i

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

// An adopted file whose mod is no longer active: delete it but keep the backup for clean.
// Returns its new manifest entry, or null if it was edited by hand and is no longer ours.
function removeAdopted(outDir, entry, log) {
  const target = path.join(outDir, entry.rel)
  const current = hashOf(target)
  if (current && current !== entry.sha1) {
    log.push(`left ${entry.rel} alone: it was edited by hand after the last build`)
    return null
  }
  if (current) {
    fs.unlinkSync(target)
    log.push(`deleted ${entry.rel}`)
  }
  return { rel: entry.rel, sha1: null, mods: [], adopted: entry.adopted }
}

// Clean for an adopted file: puts the original back but keeps the backup and the entry, since
// the file still belongs to the mod it was imported into. Returns the new entry, or null.
function restoreAdopted(outDir, entry, log) {
  const target = path.join(outDir, entry.rel)
  const current = hashOf(target)
  if (current && current !== entry.sha1) {
    log.push(`left ${entry.rel} alone: it was edited by hand after the last build`)
    return null
  }
  const backup = path.join(statePaths(outDir).backup, entry.rel)
  if (!fs.existsSync(backup)) {
    if (current) fs.unlinkSync(target)
    return null
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(backup, target)
  log.push(`restored ${entry.rel}`)
  return { rel: entry.rel, sha1: hashOf(target), mods: [], adopted: entry.adopted }
}

// Nothing to do for an adopted file that is already gone.
function isSettled(outDir, entry) {
  return entry.adopted && !fs.existsSync(path.join(outDir, entry.rel))
}

// A plugin's data file (out.userData) that the player or the plugin changed: it's kept as is.
// That's when it differs from the build and either the ModKit never wrote it or it changed since.
function keepsUserFile(out, current, hash, prev) {
  return !!out.userData && !!current && current !== hash && (!prev || current !== prev.sha1)
}

// true for the errors Windows gives when a file is open elsewhere (a plugin DLL the game loaded).
function busy(e) {
  return e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')
}

function inUse(e, rel) {
  if (!busy(e) || !rel) return e
  return new Error(`The game seems to be running (${rel} is in use). Close the game and try again.`)
}

// outputs: Map key -> { rel, buffer, mods, userData? }
function deploy(outDir, outputs, { dryRun = false } = {}) {
  const log = []
  const old = readManifest(outDir)
  // Starts as the old manifest and is updated file by file, so if it stops halfway (the game
  // has a file open) what's saved still matches what's on disk.
  const next = { files: { ...old.files } }
  let at = null

  try {
    for (const [key, entry] of Object.entries(old.files)) {
      if (outputs.has(key)) continue
      at = entry.rel
      if (dryRun) {
        if (!isSettled(outDir, entry)) log.push(`would remove ${entry.rel}`)
      } else if (entry.adopted) {
        const kept = removeAdopted(outDir, entry, log)
        if (kept) next.files[key] = kept
        else delete next.files[key]
      } else {
        restoreOrDelete(outDir, entry.rel, entry, log)
        delete next.files[key]
      }
    }

    for (const [key, out] of outputs) {
      at = out.rel
      const target = path.join(outDir, out.rel)
      const hash = sha1(out.buffer)
      const current = hashOf(target)
      const prev = old.files[key]

      if (keepsUserFile(out, current, hash, prev)) {
        log.push(`${dryRun ? 'would keep' : 'kept'} your version of ${out.rel}`)
        continue
      }
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
      if (current !== hash) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, out.buffer)
        log.push(`wrote ${out.rel} (${out.mods.join(', ')})`)
      }
      next.files[key] = { rel: out.rel, sha1: hash, mods: out.mods, ...(prev?.adopted && { adopted: prev.adopted }) }
    }
  } catch (e) {
    throw inUse(e, at)
  } finally {
    if (!dryRun) writeManifest(outDir, next)
  }
  return log
}

// How many files would change if deploy ran now (0 = Mods/ is up to date).
function pendingChanges(outDir, outputs) {
  const old = readManifest(outDir)
  let count = 0
  for (const [key, out] of outputs) {
    const hash = sha1(out.buffer)
    const current = hashOf(path.join(outDir, out.rel))
    if (current !== hash && !keepsUserFile(out, current, hash, old.files[key])) count++
  }
  for (const [key, entry] of Object.entries(old.files)) {
    if (!outputs.has(key) && !isSettled(outDir, entry)) count++
  }
  return count
}

// Files in Mods/ the ModKit didn't write (mods installed by hand), as rel paths.
// modIds: the mods that exist; a file adopted by a mod that has since been deleted counts as
// installed by hand again once it's back to the original (not while it holds a build result).
// dirs: the game's top folders (gameTopDirs); only files in them count, so a plugin's data folder
// (Compendium/...) or loose files in Mods/ are never taken for a mod.
function unmanagedFiles(outDir, modIds, dirs) {
  if (!outDir) return []
  const managed = readManifest(outDir).files
  const { backup } = statePaths(outDir)
  const orphan = entry => modIds && entry.adopted && !modIds.has(entry.adopted) &&
    hashOf(path.join(outDir, entry.rel)) === hashOf(path.join(backup, entry.rel))
  return listFiles(outDir).filter(rel => {
    const entry = managed[fileKey(rel)]
    return !RESERVED.test(rel) && (!dirs || isGameRel(rel, dirs)) && (!entry || orphan(entry))
  })
}

// Warnings for files installed by hand that deploying `outputs` would replace.
function displacedNotes(outDir, outputs, modIds, dirs) {
  return unmanagedFiles(outDir, modIds, dirs)
    .filter(rel => outputs.has(fileKey(rel)))
    .map(rel => `${rel} was installed by hand and applying will replace it; import it as a mod to keep it`)
}

// Hands files installed by hand over to the ModKit once they have been imported as mod `id`.
function adopt(outDir, rels, id) {
  const data = readManifest(outDir)
  const { backup } = statePaths(outDir)
  for (const rel of rels) {
    const src = path.join(outDir, rel)
    // Overwrites a leftover backup: what's in Mods/ now is what clean has to bring back.
    const dst = path.join(backup, rel)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    data.files[fileKey(rel)] = { rel, sha1: hashOf(src), mods: [], adopted: id }
  }
  writeManifest(outDir, data)
}

function clean(outDir) {
  const log = []
  const old = readManifest(outDir)
  const next = { files: { ...old.files } } // see deploy
  let at = null
  try {
    for (const [key, entry] of Object.entries(old.files)) {
      at = entry.rel
      const kept = entry.adopted ? restoreAdopted(outDir, entry, log) : restoreOrDelete(outDir, entry.rel, entry, log)
      if (kept) next.files[key] = kept
      else delete next.files[key]
    }
  } catch (e) {
    throw inUse(e, at)
  } finally {
    writeManifest(outDir, next)
  }
  return log
}

module.exports = { deploy, clean, readManifest, pendingChanges, unmanagedFiles, displacedNotes, adopt, busy }
