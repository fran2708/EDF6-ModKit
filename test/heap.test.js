// Shared DSGO nodes ("heap") and formulas (calc) must never leak file-specific names into
// patches. Regression tests for "Heap node not found" when combining More Weapon Slots.
const test = require('node:test')
const assert = require('node:assert/strict')
const codec = require('../src/codec')
const { diff } = require('../src/diff')

// A DSGO document where one string is shared through the heap, like sgott produces for
// "weapon" in the soldier object files.
function sharedStringDoc(heapName) {
  return {
    format: 'DSGO',
    endian: 'LE',
    variables: [
      { name: 'slots', type: 'ptr', value: [{ type: 'double', value: 0 }, { type: 'heap', value: heapName }] },
      { name: 'sub_slots', type: 'ptr', value: [{ type: 'double', value: 4 }, { type: 'heap', value: heapName }] },
    ],
    heap: { [heapName]: { type: 'string', value: 'weapon' } },
  }
}

// A DSGO document with a formula pointing at another node by id.
function formulaDoc(extraNodes = 0) {
  const padding = Array.from({ length: extraNodes }, (_, i) => ({ name: `pad${i}`, type: 'double', value: i }))
  return {
    format: 'DSGO',
    endian: 'LE',
    variables: [
      ...padding,
      { name: 'base', type: 'double', id: `node${40 + extraNodes}`, value: 24 },
      { name: 'scaled', type: 'calc', value: [`@node${40 + extraNodes}`, 2, '/'] },
    ],
  }
}

test('heap: references to plain data are expanded inline', () => {
  const doc = codec.decode(codec.encode(sharedStringDoc('node112')))
  assert.equal(doc.heap, undefined)
  assert.deepEqual(doc.variables[0].value[1], { type: 'string', value: 'weapon' })
  assert.deepEqual(doc.variables[1].value[1], { type: 'string', value: 'weapon' })
})

test('heap: the same content under different heap names produces no patch', () => {
  const a = codec.decode(codec.encode(sharedStringDoc('node112')))
  const b = codec.decode(codec.encode(sharedStringDoc('node99')))
  assert.deepEqual(diff(a, b), { ops: [], warnings: [] })
})

test('calc: ids get stable names and formula references follow them', () => {
  const doc = codec.decode(codec.encode(formulaDoc()))
  const base = doc.variables.find(v => v.name === 'base')
  const scaled = doc.variables.find(v => v.name === 'scaled')
  assert.equal(base.id, 'id1')
  assert.deepEqual(scaled.value, ['@id1', 2, '/'])
  // Same structure with extra nodes before it: sgott would number it differently, the ModKit doesn't.
  const shifted = codec.decode(codec.encode(formulaDoc(3)))
  assert.equal(shifted.variables.find(v => v.name === 'base').id, 'id1')
  assert.deepEqual(codec.decode(codec.encode(doc)), doc)
})

test('calc: a change that would copy a formula into another file falls back to the whole file', () => {
  const base = codec.decode(codec.encode(formulaDoc()))
  const mod = codec.decode(codec.encode(formulaDoc()))
  mod.variables.push({ name: 'extra', type: 'ptr', value: [] })
  base.variables.push({ name: 'extra', type: 'ptr', value: [] })
  mod.variables.at(-1).value.push({ type: 'calc', value: ['@id1', 3, '/'] })
  const r = diff(base, mod)
  assert.equal(r.ops.length, 1)
  assert.match(r.warnings.join(), /only work inside their own file/)
})

test('calc: changing a plain value next to a formula is still a normal patch', () => {
  const base = codec.decode(codec.encode(formulaDoc()))
  const mod = codec.decode(codec.encode(formulaDoc()))
  mod.variables.find(v => v.name === 'base').value = 48
  assert.deepEqual(diff(base, mod), { ops: [{ op: 'set', path: 'base', value: 48 }], warnings: [] })
})
