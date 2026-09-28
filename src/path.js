// Rutas dentro de un documento SGO/DSGO.
//
//   "SoldierInit/3/2"  -> variable SoldierInit, elemento 3, elemento 2
//   "name.en"          -> variable name.en (los nombres pueden tener puntos, por eso el separador es /)
//   "WeaponTable/*/2"  -> el elemento 2 de todos los elementos de WeaponTable
//   "ModeList/-1"      -> último elemento
//
// El primer segmento es el nombre de una variable (o su índice si es numérico y no hay una
// variable con ese nombre). Los siguientes son índices dentro de listas `ptr`.

function split(path) {
  if (Array.isArray(path)) return path.map(String)
  if (typeof path !== 'string' || path === '') throw new Error('Ruta vacía')
  return path.split('/')
}

function join(segments) {
  return segments.join('/')
}

function variableIndex(doc, seg) {
  const byName = doc.variables.findIndex(v => v.name === seg)
  if (byName !== -1) return byName
  if (/^\d+$/.test(seg) && +seg < doc.variables.length) return +seg
  return -1
}

function listIndex(list, seg) {
  if (!/^-?\d+$/.test(seg)) return -1
  const i = +seg < 0 ? list.length + +seg : +seg
  return i >= 0 && i < list.length ? i : -1
}

// Devuelve todas las ubicaciones que matchean la ruta:
// [{ node, list, index, path }] donde list[index] === node y path es la ruta concreta.
function resolve(doc, path) {
  const segs = split(path)
  const [head, ...rest] = segs
  let found = []
  if (head === '*') {
    found = doc.variables.map((node, index) => ({ node, list: doc.variables, index, path: [node.name] }))
  } else {
    const index = variableIndex(doc, head)
    if (index === -1) throw new PathError(`No existe la variable "${head}"`, segs, 0)
    const node = doc.variables[index]
    found = [{ node, list: doc.variables, index, path: [node.name] }]
  }

  rest.forEach((seg, depth) => {
    const next = []
    for (const at of found) {
      if (at.node.type !== 'ptr' || !Array.isArray(at.node.value)) {
        throw new PathError(`"${join(at.path)}" no es una lista (es ${at.node.type})`, segs, depth + 1)
      }
      const list = at.node.value
      if (seg === '*') {
        list.forEach((node, index) => next.push({ node, list, index, path: [...at.path, String(index)] }))
        continue
      }
      const index = listIndex(list, seg)
      if (index === -1) {
        throw new PathError(`Índice ${seg} fuera de rango en "${join(at.path)}" (tiene ${list.length})`, segs, depth + 1)
      }
      next.push({ node: list[index], list, index, path: [...at.path, String(index)] })
    }
    found = next
  })

  return found.map(at => ({ ...at, path: join(at.path) }))
}

class PathError extends Error {
  constructor(message, segments, depth) {
    super(message)
    this.segments = segments
    this.depth = depth
  }
}

// Recorre todas las hojas (valores que no son ptr) con su ruta. Útil para buscar qué tocar.
function* leaves(doc) {
  function* walk(node, path) {
    if (node.type === 'ptr' && Array.isArray(node.value)) {
      for (let i = 0; i < node.value.length; i++) yield* walk(node.value[i], [...path, i])
      if (node.value.length === 0) yield { path: join(path), node }
      return
    }
    yield { path: join(path), node }
  }
  for (const v of doc.variables) yield* walk(v, [v.name])
}

// true si `a` es ancestro estricto de `b` ("X/1" es ancestro de "X/1/3").
function isAncestor(a, b) {
  return b.startsWith(a + '/')
}

module.exports = { split, join, resolve, leaves, isAncestor, PathError }
