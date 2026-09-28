// Genera operaciones de parche a partir de dos documentos: el original y uno modificado.
// Sirve para convertir mods "de archivo completo" en parches que se pueden combinar.
//
// Criterio:
//   - hojas distintas                        -> set
//   - lista que solo creció al final         -> append de lo nuevo
//   - lista con otro largo y otro contenido  -> set del nodo entero (grueso, pero correcto)
//   - cambio de tipo                          -> set del nodo entero

const { join } = require('./path')

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function stripName(node) {
  const { name, ...rest } = node
  return rest
}

function diffNode(base, mod, path, ops) {
  if (same(base, mod)) return
  if (base.type !== mod.type) {
    ops.push({ op: 'set', path: join(path), node: stripName(mod) })
    return
  }
  if (base.type === 'ptr' && Array.isArray(base.value) && Array.isArray(mod.value)) {
    const a = base.value
    const b = mod.value
    if (a.length === b.length) {
      a.forEach((node, i) => diffNode(node, b[i], [...path, i], ops))
      return
    }
    if (b.length > a.length && a.every((node, i) => same(node, b[i]))) {
      ops.push({ op: 'append', path: join(path), nodes: b.slice(a.length) })
      return
    }
    ops.push({ op: 'set', path: join(path), node: stripName(mod) })
    return
  }
  if (base.type === 'string' || base.type === 'int' || base.type === 'float' || base.type === 'double') {
    ops.push({ op: 'set', path: join(path), value: mod.value })
    return
  }
  ops.push({ op: 'set', path: join(path), node: stripName(mod) })
}

function diff(baseDoc, modDoc) {
  const ops = []
  const baseByName = new Map(baseDoc.variables.map(v => [v.name, v]))
  const warnings = []
  for (const v of modDoc.variables) {
    const b = baseByName.get(v.name)
    if (!b) {
      warnings.push(`La variable "${v.name}" no existe en el original; no se puede expresar como parche`)
      continue
    }
    diffNode(b, v, [v.name], ops)
  }
  const modNames = new Set(modDoc.variables.map(v => v.name))
  for (const name of baseByName.keys()) {
    if (!modNames.has(name)) warnings.push(`El modificado no tiene la variable "${name}"; se ignora`)
  }
  return { ops, warnings }
}

module.exports = { diff }
