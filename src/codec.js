// Reading and writing SGO/DSGO. The heavy lifting is done by sgott; this module just builds the
// "state" it expects and picks the converter from the file's magic.
const fs = require('fs')
const globals = require('sgott/globals.js')
const compiler = require('sgott/converters/compiler.js')
const decompiler = require('sgott/converters/decompiler.js')

const MAGICS = {
  'SGO\0': 'sgo',
  '\0OGS': 'sgo',
  'DSGO': 'dsgo',
  'OGSD': 'dsgo',
}

function state() {
  return {
    opts: {},
    compiler,
    decompiler,
    compilers: globals.compilers,
    decompilers: globals.decompilers,
  }
}

function formatOf(buffer) {
  return MAGICS[buffer.subarray(0, 4).toString('latin1')] || null
}

function isPatchable(buffer) {
  return formatOf(buffer) !== null
}

// DSGO files can store a node once in a "heap" and point to it from several places; sgott shows
// those pointers as { type: 'heap', value: 'node112' }. Heap names are numbered per file, so a
// reference copied from one file into another points at nothing (or at the wrong node).
//
// References to plain data (numbers, text and lists of them) are replaced by a copy of the node
// they point to, so those parts of the document are self-contained and paths, diffs and patches
// work the same whether a value was shared or not. Nodes that contain formulas (`calc`) or node
// ids stay shared: formulas point at other nodes by id ("@node168"), and duplicating an id would
// make those references ambiguous.
function isFileSpecific(node, heap, seen = new Set()) {
  if (node.id !== undefined || node.type === 'calc') return true
  if (node.type === 'heap') {
    if (seen.has(node.value)) return true // circular: leave it alone
    const target = heap[node.value]
    return !target || isFileSpecific(target, heap, new Set([...seen, node.value]))
  }
  if (node.type === 'ptr' && Array.isArray(node.value)) return node.value.some(n => isFileSpecific(n, heap, seen))
  return false
}

function expandHeap(doc) {
  const heap = doc.heap || {}
  function expand(node) {
    if (node.type === 'heap') {
      if (isFileSpecific(node, heap)) return node
      const copy = expand(heap[node.value])
      const { name } = node
      return name === undefined ? copy : { name, ...copy }
    }
    if (node.type === 'ptr' && Array.isArray(node.value)) {
      return { ...node, value: node.value.map(expand) }
    }
    return node
  }
  doc.variables = doc.variables.map(expand)
  // Only the shared nodes that are still referenced stay in the heap, with plain-data references
  // inside them expanded too.
  const kept = {}
  const collect = node => {
    if (node.type === 'heap' && !(node.value in kept) && heap[node.value]) {
      const target = heap[node.value]
      kept[node.value] = target.type === 'ptr' && Array.isArray(target.value)
        ? { ...target, value: target.value.map(expand) }
        : target
      collect(kept[node.value])
    } else if (node.type === 'ptr' && Array.isArray(node.value)) {
      node.value.forEach(collect)
    }
  }
  doc.variables.forEach(collect)
  if (Object.keys(kept).length) doc.heap = kept
  else delete doc.heap
  return doc
}

// sgott names node ids and heap entries after the node's position in the file ("node168"), so
// adding one node anywhere renames everything after it. They get stable names instead, numbered
// in the order they are first reached ("id1", "h1", ...), and formula references ("@node168")
// are rewritten to match. The same structure then gets the same names in the original and in a
// mod, and only real differences show up. The names mean nothing to the game: sgott turns them
// back into positions when writing the file.
function canonicalizeNames(doc) {
  const heap = doc.heap || {}
  const ids = new Map()
  const heapNames = new Map()
  const visit = node => {
    if (node.id !== undefined && !ids.has(node.id)) ids.set(node.id, `id${ids.size + 1}`)
    if (node.type === 'heap' && heap[node.value] && !heapNames.has(node.value)) {
      heapNames.set(node.value, `h${heapNames.size + 1}`)
      visit(heap[node.value])
    } else if (node.type === 'ptr' && Array.isArray(node.value)) {
      node.value.forEach(visit)
    }
  }
  doc.variables.forEach(visit)

  const rename = node => {
    const out = { ...node }
    if (out.id !== undefined && ids.has(out.id)) out.id = ids.get(out.id)
    if (out.type === 'heap' && heapNames.has(out.value)) out.value = heapNames.get(out.value)
    else if (out.type === 'calc' && Array.isArray(out.value)) {
      out.value = out.value.map(v => (typeof v === 'string' && v.startsWith('@') && ids.has(v.slice(1)) ? '@' + ids.get(v.slice(1)) : v))
    } else if (out.type === 'ptr' && Array.isArray(out.value)) out.value = out.value.map(rename)
    return out
  }
  doc.variables = doc.variables.map(rename)
  if (doc.heap) {
    const renamed = {}
    for (const [old, name] of heapNames) renamed[name] = rename(heap[old])
    doc.heap = renamed
  }
  return doc
}

// Runs fn with console.warn silenced: sgott prints diagnostics ("Orphan nodes counted: ...")
// that mean nothing to players.
function quiet(fn) {
  const warn = console.warn
  console.warn = () => {}
  try {
    return fn()
  } finally {
    console.warn = warn
  }
}

function decode(buffer) {
  const format = formatOf(buffer)
  if (!format) throw new Error('Not an SGO/DSGO file')
  const doc = quiet(() => format === 'dsgo'
    ? globals.decompilers.dsgo(buffer, state())
    : globals.decompilers.sgo(decompiler, buffer, state()))
  // sgott returns some objects with their own prototypes; normalize them to plain JSON.
  const plain = canonicalizeNames(expandHeap(JSON.parse(JSON.stringify(doc))))
  plain.format = format.toUpperCase()
  return plain
}

function encode(doc) {
  const out = /^dsgo$/i.test(doc.format)
    ? globals.compilers.dsgo(doc, state(), globals)
    : globals.compilers.sgo(compiler, doc, state(), globals)
  return Buffer.from(out)
}

function readDoc(file) {
  return decode(fs.readFileSync(file))
}

module.exports = { decode, encode, readDoc, formatOf, isPatchable, isFileSpecific }
