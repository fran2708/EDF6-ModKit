// Generates patch operations from two documents: the original and a modified one.
// Used to turn "whole file" mods into patches that can be combined.
//
// Rules:
//   - different leaves                       -> set
//   - a list that only grew at the end       -> append of the new elements
//   - a list with other length and content   -> set of the whole node (coarse, but correct)
//   - a type change                          -> set of the whole node

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
      warnings.push(`Variable "${v.name}" does not exist in the original; it can't be expressed as a patch`)
      continue
    }
    diffNode(b, v, [v.name], ops)
  }
  const modNames = new Set(modDoc.variables.map(v => v.name))
  for (const name of baseByName.keys()) {
    if (!modNames.has(name)) warnings.push(`The modified file lacks variable "${name}"; ignored`)
  }
  return { ops, warnings }
}

module.exports = { diff }
