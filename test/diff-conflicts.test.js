const test = require('node:test')
const assert = require('node:assert/strict')
const { diff } = require('../src/diff')
const { apply } = require('../src/patch')
const { analyze } = require('../src/conflicts')
const { configDoc, f, i, s, ptr } = require('./helpers')

function clone(x) {
  return JSON.parse(JSON.stringify(x))
}

test('diff: hojas, listas que crecen y listas reemplazadas', () => {
  const base = configDoc()
  const mod = clone(base)
  mod.variables[1].value[0].value[3].value[1].value = 5 // armadura Ranger
  mod.variables[1].value[0].value[2].value.push(i(2)) // lista que crece al final
  mod.variables[1].value[1].value[2].value = [i(9)] // lista reemplazada
  const { ops, warnings } = diff(base, mod)
  assert.deepEqual(warnings, [])
  assert.deepEqual(ops, [
    { op: 'append', path: 'SoldierInit/0/2', nodes: [i(2)] },
    { op: 'set', path: 'SoldierInit/0/3/1', value: 5 },
    { op: 'set', path: 'SoldierInit/1/2', node: ptr(i(9)) },
  ])
  const rebuilt = clone(base)
  for (const op of ops) apply(rebuilt, op)
  assert.deepEqual(rebuilt, mod)
})

test('diff: variable nueva no se puede expresar', () => {
  const base = configDoc()
  const mod = clone(base)
  mod.variables.push({ name: 'Extra', ...s('x') })
  assert.match(diff(base, mod).warnings[0], /Extra/)
})

const ev = (mod, path, kind, value) => ({ mod, file: 'A.SGO', path, kind, value })

test('conflictos: mul de dos mods no choca', () => {
  assert.deepEqual(analyze([ev('a', 'X/1', 'scale'), ev('b', 'X/1', 'scale')]), [])
})

test('conflictos: set distinto, set sobre escalado, set de ancestro', () => {
  const c = analyze([
    ev('a', 'X/1', 'set', 1),
    ev('b', 'X/1', 'set', 2),
    ev('c', 'Y/0', 'scale'),
    ev('d', 'Y/0', 'set', 3),
    ev('e', 'Z/0/1', 'set', 1),
    ev('f', 'Z/0', 'set', [f(1)]),
  ])
  assert.equal(c.length, 3)
  assert.match(c[0].message, /valores distintos/)
  assert.match(c[1].message, /escalado/)
  assert.match(c[2].message, /entero/)
})

test('conflictos: mismo valor o mismo mod no es conflicto', () => {
  assert.deepEqual(analyze([ev('a', 'X/1', 'set', 1), ev('b', 'X/1', 'set', 1)]), [])
  assert.deepEqual(analyze([ev('a', 'X/1', 'set', 1), ev('a', 'X/1', 'set', 7)]), [])
})

test('conflictos: insert/remove contra índices de otro mod', () => {
  const c = analyze([ev('a', 'L/3', 'set', 1), ev('b', 'L', 'reshape')])
  assert.equal(c.length, 1)
  assert.match(c[0].message, /corridos/)
})

test('conflictos: reemplazos de archivo completo', () => {
  const c = analyze([
    ev('a', 'X/1', 'set', 1),
    { mod: 'b', file: 'A.SGO', path: null, kind: 'override' },
    { mod: 'c', file: 'A.SGO', path: null, kind: 'override' },
  ])
  assert.ok(c.some(x => /Varios mods/.test(x.message)))
  assert.ok(c.some(x => /descarta los cambios de "a"/.test(x.message)))
})
