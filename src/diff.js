// Generates patch operations from two documents: the original and a modified one.
// Used to turn "whole file" mods into patches that can be combined.
//
// Rules:
//   - different leaves                       -> set
//   - a list that only grew at the end       -> append of the new elements
//   - a list with other length and content   -> set of the whole node (coarse, but correct)
//   - a type change                          -> set of the whole node
//
// Shared DSGO nodes that hold formulas or node ids (see codec.js) are only meaningful inside
// their own file. They are compared by content, and if a change would have to copy one of them
// into another file, the difference can't be expressed as a patch: a warning is returned and the
// caller uses the modified file whole instead.

const { join, same } = require('./path')
const { isFileSpecific } = require('./codec')

function stripName(node) {
  const { name, ...rest } = node
  return rest
}

// Follows a heap reference to the node it points to (for comparing content, not names).
function deref(node, heap) {
  let seen = 0
  while (node && node.type === 'heap' && heap && heap[node.value] && seen++ < 64) node = heap[node.value]
  return node
}

function sameContent(a, aHeap, b, bHeap) {
  a = deref(a, aHeap)
  b = deref(b, bHeap)
  if (!a || !b || a.type !== b.type) return false
  if (a.type === 'ptr' && Array.isArray(a.value) && Array.isArray(b.value)) {
    return a.value.length === b.value.length && a.value.every((n, i) => sameContent(n, aHeap, b.value[i], bHeap))
  }
  const { name: _a, id: _ai, ...ra } = a
  const { name: _b, id: _bi, ...rb } = b
  return same(ra, rb)
}

function diffNode(base, mod, path, ops, ctx) {
  if (base.type === 'heap' || mod.type === 'heap') {
    if (!sameContent(base, ctx.baseHeap, mod, ctx.modHeap)) {
      ops.push({ op: 'set', path: join(path), node: stripName(mod) })
    }
    return
  }
  if (same(base, mod)) return
  if (base.type !== mod.type) {
    ops.push({ op: 'set', path: join(path), node: stripName(mod) })
    return
  }
  if (base.type === 'ptr' && Array.isArray(base.value) && Array.isArray(mod.value)) {
    const a = base.value
    const b = mod.value
    if (a.length === b.length) {
      a.forEach((node, i) => diffNode(node, b[i], [...path, i], ops, ctx))
      return
    }
    if (b.length > a.length && a.every((node, i) => sameContent(node, ctx.baseHeap, b[i], ctx.modHeap))) {
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
  const ctx = { baseHeap: baseDoc.heap || {}, modHeap: modDoc.heap || {} }
  const baseByName = new Map(baseDoc.variables.map(v => [v.name, v]))
  const warnings = []
  for (const v of modDoc.variables) {
    const b = baseByName.get(v.name)
    if (!b) {
      warnings.push(`Variable "${v.name}" does not exist in the original; it can't be expressed as a patch`)
      continue
    }
    diffNode(b, v, [v.name], ops, ctx)
  }
  const modNames = new Set(modDoc.variables.map(v => v.name))
  for (const name of baseByName.keys()) {
    if (!modNames.has(name)) warnings.push(`The modified file lacks variable "${name}"; ignored`)
  }
  // New nodes copied from the modified file must not carry references that only make sense
  // inside it (shared heap nodes, formulas, node ids).
  const carried = ops.find(op => [op.node, ...(op.nodes || [])].some(n => n && isFileSpecific(n, {})))
  if (carried) {
    warnings.push(`the change at "${carried.path}" involves shared nodes or formulas that only work inside their own file`)
  }
  return { ops, warnings }
}

module.exports = { diff }
