// Patch operations on SGO/DSGO documents (sgott's JSON).
//
// Every operation is { op, path, ... }:
//   set     { value }   replaces the value, keeping the node's type
//           { node }    replaces the whole node ({ type, value }), to change types or lists
//   mul     { value }   multiplies a number
//   add     { value }   adds to a number
//   append  { node | nodes }  appends to a ptr list
//   insert  { index, node | nodes }  inserts into a ptr list
//   remove  {}          removes the list element
//
// `mul` and `add` compose across mods (x10 from one mod and x1.2 from another give x12), unlike
// `set`, where the last one wins. That's why they're the better choice for balance changes.
//
// apply() returns { path, kind } events that conflicts.js later uses to report clashes.

const { resolve } = require('./path')

const NUMERIC = new Set(['int', 'float', 'double'])
const OPS = new Set(['set', 'mul', 'add', 'append', 'insert', 'remove'])

function validate(op) {
  if (!op || typeof op !== 'object') throw new Error('An operation must be an object')
  if (!OPS.has(op.op)) throw new Error(`Unknown operation "${op.op}" (valid: ${[...OPS].join(', ')})`)
  if (op.path === undefined) throw new Error(`"${op.op}" needs a "path"`)
  if ((op.op === 'mul' || op.op === 'add') && typeof op.value !== 'number') {
    throw new Error(`"${op.op}" needs a numeric "value"`)
  }
  if (op.op === 'set' && op.value === undefined && op.node === undefined) {
    throw new Error('"set" needs a "value" or a "node"')
  }
  if ((op.op === 'append' || op.op === 'insert') && !op.node && !op.nodes) {
    throw new Error(`"${op.op}" needs a "node" or "nodes"`)
  }
  if (op.op === 'insert' && !Number.isInteger(op.index)) throw new Error('"insert" needs an integer "index"')
}

function checkNode(node) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string' || !('value' in node)) {
    throw new Error('A node must have the shape { "type": ..., "value": ... }')
  }
  return node
}

function clone(x) {
  return JSON.parse(JSON.stringify(x))
}

function coerce(node, value) {
  if (NUMERIC.has(node.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Expected a number for a ${node.type} node`)
    }
    return node.type === 'int' ? Math.round(value) : value
  }
  if (node.type === 'string') {
    if (typeof value !== 'string') throw new Error('Expected text for a string node')
    return value
  }
  throw new Error(`To change a ${node.type} node use "node" instead of "value"`)
}

function numeric(at, opName) {
  if (!NUMERIC.has(at.node.type)) {
    throw new Error(`"${opName}" at "${at.path}": the node is ${at.node.type}, not a number`)
  }
}

function listOf(at, opName) {
  if (at.node.type !== 'ptr' || !Array.isArray(at.node.value)) {
    throw new Error(`"${opName}" at "${at.path}": the node is ${at.node.type}, not a list`)
  }
  return at.node.value
}

function newNodes(op) {
  const nodes = op.nodes || [op.node]
  return nodes.map(n => clone(checkNode(n)))
}

function apply(doc, op) {
  validate(op)
  const targets = resolve(doc, op.path)
  const events = []

  // remove on several elements of the same list: back to front, so the indexes still to be
  // removed don't shift.
  if (op.op === 'remove') {
    targets.sort((a, b) => b.index - a.index)
  }

  for (const at of targets) {
    switch (op.op) {
      case 'set':
        if (op.node !== undefined) {
          at.list[at.index] = clone(checkNode(op.node))
          if (at.list === doc.variables && at.node.name) at.list[at.index].name = at.node.name
        } else {
          at.node.value = coerce(at.node, op.value)
        }
        events.push({ path: at.path, kind: 'set', value: at.list[at.index].value })
        break
      case 'mul':
        numeric(at, 'mul')
        at.node.value = coerce(at.node, at.node.value * op.value)
        events.push({ path: at.path, kind: 'scale' })
        break
      case 'add':
        numeric(at, 'add')
        at.node.value = coerce(at.node, at.node.value + op.value)
        events.push({ path: at.path, kind: 'scale' })
        break
      case 'append': {
        const list = listOf(at, 'append')
        list.push(...newNodes(op))
        events.push({ path: at.path, kind: 'append' })
        break
      }
      case 'insert': {
        const list = listOf(at, 'insert')
        if (op.index < 0 || op.index > list.length) {
          throw new Error(`"insert" at "${at.path}": index ${op.index} out of range (it has ${list.length})`)
        }
        list.splice(op.index, 0, ...newNodes(op))
        events.push({ path: at.path, kind: 'reshape' })
        break
      }
      case 'remove': {
        if (at.list === doc.variables) throw new Error(`Variable "${at.path}" cannot be removed`)
        at.list.splice(at.index, 1)
        const parent = at.path.slice(0, at.path.lastIndexOf('/'))
        events.push({ path: parent, kind: 'reshape' })
        break
      }
    }
  }
  return events
}

module.exports = { apply, validate }
