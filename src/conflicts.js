// Detecta choques entre mods a partir de los eventos que registró el build, en orden de carga.
//
// Qué se considera conflicto (el build sigue igual; el último en el orden gana):
//   - dos mods hacen `set` sobre la misma ruta con valores distintos
//   - un mod hace `set` sobre algo que otro mod anterior escaló con mul/add (se pierde el escalado)
//   - un mod reemplaza un nodo o lista entera (set/override) que tiene cambios de otro mod anterior
//   - un mod inserta o elimina elementos de una lista y otro mod toca esa lista por índice
//   - dos mods reemplazan el mismo archivo completo (archivos que no se pueden parchear)
//
// Eventos: { mod, file, path, kind, value? } con kind en set | scale | append | reshape | override

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
        message: `Varios mods reemplazan el archivo completo; queda el de "${overrideMods.at(-1)}"`,
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
            message: `"${later.mod}" reemplaza el archivo completo y descarta los cambios de "${mod}"`,
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
              message: `"${e.mod}" y "${later.mod}" ponen valores distintos; queda el de "${later.mod}"`,
            })
          } else if (e.path === later.path && e.kind === 'scale') {
            conflicts.push({
              file, path: later.path, mods: [e.mod, later.mod],
              message: `"${later.mod}" fija un valor que "${e.mod}" multiplica o suma; se pierde el escalado de "${e.mod}"`,
            })
          } else if (e.path === later.path && (e.kind === 'append' || e.kind === 'reshape')) {
            conflicts.push({
              file, path: later.path, mods: [e.mod, later.mod],
              message: `"${later.mod}" reemplaza la lista y descarta los elementos que agregó o quitó "${e.mod}"`,
            })
          } else if (isAncestor(later.path, e.path)) {
            conflicts.push({
              file, path: later.path, mods: [e.mod, later.mod],
              message: `"${later.mod}" reemplaza "${later.path}" entero y descarta el cambio de "${e.mod}" en "${e.path}"`,
            })
          }
        }
      }
    }

    // Cambios de forma en listas (insert/remove) contra rutas por índice de otros mods.
    const reshapes = list.filter(e => e.kind === 'reshape')
    for (const r of reshapes) {
      const touched = list.filter(e => e.mod !== r.mod && e.kind !== 'override' && isAncestor(r.path, e.path))
      const mods = [...new Set(touched.map(e => e.mod))]
      for (const mod of mods) {
        conflicts.push({
          file, path: r.path, mods: [r.mod, mod],
          message: `"${r.mod}" inserta o elimina elementos en "${r.path}" y "${mod}" apunta a elementos por índice; pueden quedar corridos`,
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
