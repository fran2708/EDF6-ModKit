const test = require('node:test')
const assert = require('node:assert/strict')
const { resolve } = require('../src/path')
const { apply } = require('../src/patch')
const { configDoc, f, i, s } = require('./helpers')

test('resolve: by name, index, wildcard and negative index', () => {
  const doc = configDoc()
  assert.equal(resolve(doc, 'SoldierInit/1/0')[0].node.value, 'WingDiver')
  assert.equal(resolve(doc, 'name.en')[0].node.value, 'Config')
  assert.deepEqual(resolve(doc, 'SoldierInit/*/3/1').map(a => a.path), ['SoldierInit/0/3/1', 'SoldierInit/1/3/1'])
  assert.equal(resolve(doc, 'SoldierInit/-1/0')[0].path, 'SoldierInit/1/0')
})

test('resolve: clear errors', () => {
  const doc = configDoc()
  assert.throws(() => resolve(doc, 'NoSuchVar'), /Variable "NoSuchVar" does not exist/)
  assert.throws(() => resolve(doc, 'SoldierInit/5'), /out of range/)
  assert.throws(() => resolve(doc, 'PackageName/0'), /is not a list/)
})

test('set keeps the type; int rounds', () => {
  const doc = configDoc()
  apply(doc, { op: 'set', path: 'SoldierInit/0/2/1', value: 6.7 })
  assert.deepEqual(resolve(doc, 'SoldierInit/0/2/1')[0].node, i(7))
  assert.throws(() => apply(doc, { op: 'set', path: 'PackageName', value: 3 }), /text/)
  assert.throws(() => apply(doc, { op: 'set', path: 'SoldierInit/0', value: 3 }), /use "node"/)
})

test('set with node on a variable keeps its name', () => {
  const doc = configDoc()
  apply(doc, { op: 'set', path: 'PackageName', node: s('MODP') })
  assert.equal(doc.variables[0].name, 'PackageName')
  assert.equal(doc.variables[0].value, 'MODP')
})

test('mul and add compose', () => {
  const doc = configDoc()
  apply(doc, { op: 'mul', path: 'SoldierInit/*/3/1', value: 10 })
  apply(doc, { op: 'add', path: 'SoldierInit/0/3/1', value: 1 })
  assert.equal(resolve(doc, 'SoldierInit/0/3/1')[0].node.value, 6)
  assert.equal(resolve(doc, 'SoldierInit/1/3/1')[0].node.value, 2.5)
  assert.throws(() => apply(doc, { op: 'mul', path: 'PackageName', value: 2 }), /not a number/)
})

test('append, insert and remove', () => {
  const doc = configDoc()
  apply(doc, { op: 'append', path: 'SoldierInit/0/2', nodes: [i(2), i(3)] })
  apply(doc, { op: 'insert', path: 'SoldierInit/0/2', index: 0, node: i(-1) })
  assert.deepEqual(resolve(doc, 'SoldierInit/0/2')[0].node.value.map(x => x.value), [-1, 0, 1, 2, 3])
  apply(doc, { op: 'remove', path: 'SoldierInit/0/2/*' })
  assert.deepEqual(resolve(doc, 'SoldierInit/0/2')[0].node.value, [])
  assert.throws(() => apply(doc, { op: 'remove', path: 'PackageName' }), /cannot be removed/)
})

test('invalid operations', () => {
  const doc = configDoc()
  assert.throws(() => apply(doc, { op: 'boom', path: 'x' }), /Unknown operation/)
  assert.throws(() => apply(doc, { op: 'mul', path: 'x', value: '2' }), /numeric/)
  assert.throws(() => apply(doc, { op: 'append', path: 'SoldierInit', node: 3 }), /shape/)
  assert.throws(() => apply(doc, { op: 'insert', path: 'SoldierInit', index: 9, node: f(1) }), /out of range/)
})
