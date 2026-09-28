// Combina los mods activos, en orden de carga, sobre los archivos originales del juego.
//
// Para cada archivo del juego que algún mod toca se arma una lista de pasos en orden:
//   override  el mod trae el archivo completo
//   patch     el mod trae operaciones (propias, o generadas comparando su archivo con el original)
// y se ejecutan sobre el original. Un archivo completo SGO/DSGO que se puede comparar contra el
// original se convierte solo en parche, así los mods viejos también se combinan.

const fs = require('fs')
const codec = require('./codec')
const { apply } = require('./patch')
const { diff } = require('./diff')
const { analyze } = require('./conflicts')
const { fileKey, indexDir } = require('./mods')

function collectSteps(mods, vanilla, notes) {
  const steps = new Map() // key -> { rel, steps: [] }
  const add = (rel, step) => {
    const key = fileKey(rel)
    if (!steps.has(key)) steps.set(key, { rel: vanilla.get(key)?.rel || rel.replace(/\\/g, '/'), steps: [] })
    steps.get(key).steps.push(step)
  }

  for (const mod of mods) {
    for (const file of mod.files) {
      const buffer = fs.readFileSync(file.abs)
      const base = vanilla.get(fileKey(file.rel))
      if (codec.isPatchable(buffer) && base) {
        const { ops, warnings } = diff(codec.readDoc(base.abs), codec.decode(buffer))
        if (warnings.length === 0) {
          add(file.rel, { type: 'patch', mod: mod.id, ops, auto: true })
          continue
        }
        notes.push(`${mod.id}: ${file.rel} no se pudo convertir a parche (${warnings[0]}); se usa completo`)
      } else if (codec.isPatchable(buffer)) {
        notes.push(`${mod.id}: ${file.rel} no está en la carpeta de originales; se usa completo y no se combina`)
      }
      add(file.rel, { type: 'override', mod: mod.id, buffer })
    }
    for (const [rel, ops] of Object.entries(mod.patches)) {
      add(rel, { type: 'patch', mod: mod.id, ops, auto: false })
    }
  }
  return steps
}

function buildFile(key, entry, vanilla, events, errors) {
  let doc = null
  let raw = null
  let changed = false // si hubo parches hay que recompilar; si no, se copia el archivo tal cual

  for (const step of entry.steps) {
    if (step.type === 'override') {
      events.push({ mod: step.mod, file: entry.rel, path: null, kind: 'override' })
      raw = step.buffer
      doc = codec.isPatchable(raw) ? codec.decode(raw) : null
      changed = false
      continue
    }

    if (!doc) {
      if (raw) {
        errors.push({ mod: step.mod, file: entry.rel, message: 'el archivo no es SGO/DSGO, no se puede parchear' })
        return null
      }
      const base = vanilla.get(key)
      if (!base) {
        errors.push({
          mod: step.mod,
          file: entry.rel,
          message: 'falta el archivo original en la carpeta de originales (extraelo de Root.cpk)',
        })
        return null
      }
      doc = codec.readDoc(base.abs)
    }

    step.ops.forEach((op, i) => {
      try {
        for (const e of apply(doc, op)) events.push({ mod: step.mod, file: entry.rel, ...e })
        changed = true
      } catch (e) {
        const where = step.auto ? 'parche generado' : `operación #${i + 1}`
        errors.push({ mod: step.mod, file: entry.rel, message: `${where} (${op.op} ${op.path}): ${e.message}` })
      }
    })
  }

  return changed ? codec.encode(doc) : raw
}

// mods: lista de mods ya cargados, en orden de carga (el último gana).
function build(mods, { vanillaDir }) {
  const vanilla = vanillaDir ? indexDir(vanillaDir) : new Map()
  const notes = []
  const events = []
  const errors = []
  const outputs = new Map()

  const steps = collectSteps(mods, vanilla, notes)
  for (const [key, entry] of steps) {
    const buffer = buildFile(key, entry, vanilla, events, errors)
    if (buffer) {
      outputs.set(key, {
        rel: entry.rel,
        buffer,
        mods: [...new Set(entry.steps.map(s => s.mod))],
      })
    }
  }

  return { outputs, conflicts: analyze(events), notes, errors }
}

module.exports = { build }
