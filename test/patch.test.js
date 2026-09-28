const test = require('node:test')
const assert = require('node:assert/strict')
const { resolve } = require('../src/path')
const { apply } = require('../src/patch')
const { configDoc, f, i, s } = require('./helpers')

test('resolve: por nombre, índice, comodín y negativo', () => {
  const doc = configDoc()
  assert.equal(resolve(doc, 'SoldierInit/1/0')[0].node.value, 'WingDiver')
  assert.equal(resolve(doc, 'name.en')[0].node.value, 'Config')
  assert.deepEqual(resolve(doc, 'SoldierInit/*/3/1').map(a => a.path), ['SoldierInit/0/3/1', 'SoldierInit/1/3/1'])
  assert.equal(resolve(doc, 'SoldierInit/-1/0')[0].path, 'SoldierInit/1/0')
})

test('resolve: errores claros', () => {
  const doc = configDoc()
  assert.throws(() => resolve(doc, 'NoExiste'), /No existe la variable/)
  assert.throws(() => resolve(doc, 'SoldierInit/5'), /fuera de rango/)
  assert.throws(() => resolve(doc, 'PackageName/0'), /no es una lista/)
})

test('set mantiene el tipo; int redondea', () => {
  const doc = configDoc()
  apply(doc, { op: 'set', path: 'SoldierInit/0/2/1', value: 6.7 })
  assert.deepEqual(resolve(doc, 'SoldierInit/0/2/1')[0].node, i(7))
  assert.throws(() => apply(doc, { op: 'set', path: 'PackageName', value: 3 }), /texto/)
  assert.throws(() => apply(doc, { op: 'set', path: 'SoldierInit/0', value: 3 }), /usá "node"/)
})

test('set con node sobre una variable conserva el nombre', () => {
  const doc = configDoc()
  apply(doc, { op: 'set', path: 'PackageName', node: s('MODP') })
  assert.equal(doc.variables[0].name, 'PackageName')
  assert.equal(doc.variables[0].value, 'MODP')
})

test('mul y add se componen', () => {
  const doc = configDoc()
  apply(doc, { op: 'mul', path: 'SoldierInit/*/3/1', value: 10 })
  apply(doc, { op: 'add', path: 'SoldierInit/0/3/1', value: 1 })
  assert.equal(resolve(doc, 'SoldierInit/0/3/1')[0].node.value, 6)
  assert.equal(resolve(doc, 'SoldierInit/1/3/1')[0].node.value, 2.5)
  assert.throws(() => apply(doc, { op: 'mul', path: 'PackageName', value: 2 }), /no un número/)
})

test('append, insert y remove', () => {
  const doc = configDoc()
  apply(doc, { op: 'append', path: 'SoldierInit/0/2', nodes: [i(2), i(3)] })
  apply(doc, { op: 'insert', path: 'SoldierInit/0/2', index: 0, node: i(-1) })
  assert.deepEqual(resolve(doc, 'SoldierInit/0/2')[0].node.value.map(x => x.value), [-1, 0, 1, 2, 3])
  apply(doc, { op: 'remove', path: 'SoldierInit/0/2/*' })
  assert.deepEqual(resolve(doc, 'SoldierInit/0/2')[0].node.value, [])
  assert.throws(() => apply(doc, { op: 'remove', path: 'PackageName' }), /variable/)
})

test('operaciones inválidas', () => {
  const doc = configDoc()
  assert.throws(() => apply(doc, { op: 'boom', path: 'x' }), /desconocida/)
  assert.throws(() => apply(doc, { op: 'mul', path: 'x', value: '2' }), /numérico/)
  assert.throws(() => apply(doc, { op: 'append', path: 'SoldierInit', node: 3 }), /forma/)
  assert.throws(() => apply(doc, { op: 'insert', path: 'SoldierInit', index: 9, node: f(1) }), /fuera de rango/)
})
