// Paths inside an SGO/DSGO document.
//
//   "SoldierInit/3/2"  -> variable SoldierInit, element 3, element 2
//   "name.en"          -> variable name.en (names can contain dots, hence the / separator)
//   "WeaponTable/*/2"  -> element 2 of every element of WeaponTable
//   "ModeList/-1"      -> last element
//
// The first segment is a variable name (or its index if it's numeric and no variable has that
// name). The following ones are indexes into `ptr` lists.

function split(path) {
  if (Array.isArray(path)) return path.map(String)
  if (typeof path !== 'string' || path === '') throw new Error('Empty path')
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

// Returns every location matching the path:
// [{ node, list, index, path }] where list[index] === node and path is the concrete path.
function resolve(doc, path) {
  const segs = split(path)
  const [head, ...rest] = segs
  let found = []
  if (head === '*') {
    found = doc.variables.map((node, index) => ({ node, list: doc.variables, index, path: [node.name] }))
  } else {
    const index = variableIndex(doc, head)
    if (index === -1) throw new Error(`Variable "${head}" does not exist`)
    const node = doc.variables[index]
    found = [{ node, list: doc.variables, index, path: [node.name] }]
  }

  for (const seg of rest) {
    const next = []
    for (const at of found) {
      if (at.node.type !== 'ptr' || !Array.isArray(at.node.value)) {
        throw new Error(`"${join(at.path)}" is not a list (it is ${at.node.type})`)
      }
      const list = at.node.value
      if (seg === '*') {
        list.forEach((node, index) => next.push({ node, list, index, path: [...at.path, String(index)] }))
        continue
      }
      const index = listIndex(list, seg)
      if (index === -1) {
        throw new Error(`Index ${seg} out of range in "${join(at.path)}" (it has ${list.length})`)
      }
      next.push({ node: list[index], list, index, path: [...at.path, String(index)] })
    }
    found = next
  }

  return found.map(at => ({ ...at, path: join(at.path) }))
}

// Walks every leaf (non-ptr value) with its path. Handy for finding what to change.
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

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

// true if `a` is a strict ancestor of `b` ("X/1" is an ancestor of "X/1/3").
function isAncestor(a, b) {
  return b.startsWith(a + '/')
}

module.exports = { join, resolve, leaves, isAncestor, same }
