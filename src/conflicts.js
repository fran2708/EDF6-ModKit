// Detects clashes between mods from the events the build recorded, in load order.
//
// What counts as a conflict (the build still goes ahead; the last one in load order wins):
//   - two mods `set` the same path to different values
//   - a mod `set`s something an earlier mod scaled with mul/add (the scaling is lost)
//   - a mod replaces a whole node or list (set/override) that has changes from an earlier mod
//   - a mod inserts or removes list elements and another mod touches that list by index
//   - two mods replace the same whole file (files that can't be patched)
//
// Events: { mod, file, path, kind, value? } with kind in set | scale | append | reshape | override

const { isAncestor } = require('./path')

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function analyze(events) {
  const conflicts = []
  const byFile = new Map()
  for (const e of events) {
    if (!byFile.has(e.file)) byFile.set(e.file, [])
    byFile.get(e.file).push(e)
  }

  for (const [file, list] of byFile) {
    const overrides = list.filter(e => e.kind === 'override')
    const overrideMods = [...new Set(overrides.map(e => e.mod))]
    if (overrideMods.length > 1) {
      conflicts.push({
        file,
        path: null,
        mods: overrideMods,
        message: `Several mods replace the whole file; "${overrideMods.at(-1)}" wins`,
      })
    }

    for (let i = 0; i < list.length; i++) {
      const later = list[i]
      const earlierByOthers = list.slice(0, i).filter(e => e.mod !== later.mod)

      if (later.kind === 'override') {
        const lost = [...new Set(earlierByOthers.filter(e => e.kind !== 'override').map(e => e.mod))]
        for (const mod of lost) {
          conflicts.push({
            file, path: null, mods: [mod, later.mod],
            message: `"${later.mod}" replaces the whole file and discards the changes from "${mod}"`,
          })
        }
        continue
      }

      if (later.kind === 'set') {
        for (const e of earlierByOthers) {
          if (e.kind === 'override') continue
          if (e.path === later.path && e.kind === 'set' && !same(e.value, later.value)) {
            conflicts.push({
              file, path: later.path, mods: [e.mod, later.mod],
              message: `"${e.mod}" and "${later.mod}" set different values; "${later.mod}" wins`,
            })
          } else if (e.path === later.path && e.kind === 'scale') {
            conflicts.push({
              file, path: later.path, mods: [e.mod, later.mod],
              message: `"${later.mod}" sets a fixed value that "${e.mod}" multiplies or adds to; the scaling from "${e.mod}" is lost`,
            })
          } else if (e.path === later.path && (e.kind === 'append' || e.kind === 'reshape')) {
            conflicts.push({
              file, path: later.path, mods: [e.mod, later.mod],
              message: `"${later.mod}" replaces the list and discards the elements "${e.mod}" added or removed`,
            })
          } else if (isAncestor(later.path, e.path)) {
            conflicts.push({
              file, path: later.path, mods: [e.mod, later.mod],
              message: `"${later.mod}" replaces all of "${later.path}" and discards the change from "${e.mod}" at "${e.path}"`,
            })
          }
        }
      }
    }

    // Shape changes in lists (insert/remove) against other mods' index-based paths.
    const reshapes = list.filter(e => e.kind === 'reshape')
    for (const r of reshapes) {
      const touched = list.filter(e => e.mod !== r.mod && e.kind !== 'override' && isAncestor(r.path, e.path))
      const mods = [...new Set(touched.map(e => e.mod))]
      for (const mod of mods) {
        conflicts.push({
          file, path: r.path, mods: [r.mod, mod],
          message: `"${r.mod}" inserts or removes elements in "${r.path}" and "${mod}" points at elements by index; they may end up shifted`,
        })
      }
    }
  }

  return dedupe(conflicts)
}

function dedupe(conflicts) {
  const seen = new Set()
  return conflicts.filter(c => {
    const key = `${c.file}|${c.path}|${c.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

module.exports = { analyze }
