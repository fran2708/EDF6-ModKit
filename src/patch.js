// Operaciones de parche sobre documentos SGO/DSGO (el JSON de sgott).
//
// Cada operación es { op, path, ... }:
//   set     { value }   reemplaza el valor, manteniendo el tipo del nodo
//           { node }    reemplaza el nodo entero ({ type, value }), para cambiar de tipo o listas
//   mul     { value }   multiplica un número
//   add     { value }   suma a un número
//   append  { node | nodes }  agrega al final de una lista ptr
//   insert  { index, node | nodes }  inserta en una lista ptr
//   remove  {}          elimina el elemento de una lista
//
// `mul` y `add` se componen entre mods (x10 de un mod y x1.2 de otro dan x12), a diferencia de
// `set`, donde el último gana. Por eso conviene usarlos para balance.
//
// apply() devuelve eventos { path, kind } que después usa conflicts.js para avisar de choques.

const { resolve } = require('./path')

const NUMERIC = new Set(['int', 'float', 'double'])
const OPS = new Set(['set', 'mul', 'add', 'append', 'insert', 'remove'])

function validate(op) {
  if (!op || typeof op !== 'object') throw new Error('La operación debe ser un objeto')
  if (!OPS.has(op.op)) throw new Error(`Operación desconocida "${op.op}" (válidas: ${[...OPS].join(', ')})`)
  if (op.path === undefined) throw new Error(`"${op.op}" necesita "path"`)
  if ((op.op === 'mul' || op.op === 'add') && typeof op.value !== 'number') {
    throw new Error(`"${op.op}" necesita un "value" numérico`)
  }
  if (op.op === 'set' && op.value === undefined && op.node === undefined) {
    throw new Error('"set" necesita "value" o "node"')
  }
  if ((op.op === 'append' || op.op === 'insert') && !op.node && !op.nodes) {
    throw new Error(`"${op.op}" necesita "node" o "nodes"`)
  }
  if (op.op === 'insert' && !Number.isInteger(op.index)) throw new Error('"insert" necesita un "index" entero')
}

function checkNode(node) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string' || !('value' in node)) {
    throw new Error('Un nodo debe tener la forma { "type": ..., "value": ... }')
  }
  return node
}

function clone(x) {
  return JSON.parse(JSON.stringify(x))
}

function coerce(node, value) {
  if (NUMERIC.has(node.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Se esperaba un número para un nodo ${node.type}`)
    }
    return node.type === 'int' ? Math.round(value) : value
  }
  if (node.type === 'string') {
    if (typeof value !== 'string') throw new Error('Se esperaba un texto para un nodo string')
    return value
  }
  throw new Error(`Para cambiar un nodo ${node.type} usá "node" en vez de "value"`)
}

function numeric(at, opName) {
  if (!NUMERIC.has(at.node.type)) {
    throw new Error(`"${opName}" en "${at.path}": el nodo es ${at.node.type}, no un número`)
  }
}

function listOf(at, opName) {
  if (at.node.type !== 'ptr' || !Array.isArray(at.node.value)) {
    throw new Error(`"${opName}" en "${at.path}": el nodo es ${at.node.type}, no una lista`)
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

  // remove sobre varios elementos de la misma lista: de atrás para adelante, así los índices
  // que faltan borrar no se corren.
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
          throw new Error(`"insert" en "${at.path}": índice ${op.index} fuera de rango (tiene ${list.length})`)
        }
        list.splice(op.index, 0, ...newNodes(op))
        events.push({ path: at.path, kind: 'reshape' })
        break
      }
      case 'remove': {
        if (at.list === doc.variables) throw new Error(`No se puede eliminar la variable "${at.path}"`)
        at.list.splice(at.index, 1)
        const parent = at.path.slice(0, at.path.lastIndexOf('/'))
        events.push({ path: parent, kind: 'reshape' })
        break
      }
    }
  }
  return events
}

module.exports = { apply, validate, NUMERIC, OPS }
