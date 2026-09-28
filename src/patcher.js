// Memory patches for the Patcher plugin (Mods/Patches/*.txt).
//
// Patcher applies every .txt in Mods/Patches when the game starts. Each line is
//   Address: data ; comment
// where Address is a hex offset, a LABEL, or LABEL+hex / LABEL-hex, and lines without an
// address continue right after the previous write. Data is hex bytes, a typed value
// ("u32! 100", "float! 1.5", ...), or a command: "aob LABEL pattern" (the label becomes the
// address where that byte pattern is found in the game) or "alloc LABEL size [target]".
//
// The ModKit can't merge memory patches: they overwrite raw game code. What it can do is notice
// when two patch files write to the same bytes, which makes Patcher apply both and the file
// loaded last win (often crashing the game). Locations are comparable when both files use a
// plain hex address, or an aob label with the same byte pattern.

const fs = require('fs')
const path = require('path')
const { fileKey } = require('./mods')
const { readManifest } = require('./deploy')

const TYPE_SIZES = { float: 4, f32: 4, double: 8, f64: 8, rel32: 4, rel64: 8, abs64: 8 }
const INT_SIZES = { 8: 1, 16: 2, 32: 4, 64: 8 }

function typeSize(type) {
  if (TYPE_SIZES[type]) return TYPE_SIZES[type]
  const m = /^[usnp](8|16|32|64)$/.exec(type)
  return m ? INT_SIZES[m[1]] : null
}

// Parses a patch file. Returns { writes: [{ base, offset, length, line, where }], problems }.
//   base: 'abs' for hex addresses, 'aob:<PATTERN>' for aob labels; anything else ('alloc:…',
//   'unknown:…') is specific to this file and never compared with others.
function parsePatch(text, name = 'patch') {
  const writes = []
  const problems = []
  const labels = new Map() // label -> { base, offset }
  let cursor = { base: 'abs', offset: 0, label: null }

  function address(str, lineNo) {
    const m = /^([^+-]+?)\s*(?:([+-])\s*([0-9a-f]+))?$/i.exec(str)
    if (!m) {
      problems.push(`${name} line ${lineNo}: can't read the address "${str}"`)
      return { base: `unknown:${name}:${str}`, offset: 0, label: str }
    }
    const [, baseStr, sign, offStr] = m
    const delta = offStr ? parseInt(offStr, 16) * (sign === '-' ? -1 : 1) : 0
    if (labels.has(baseStr)) {
      const l = labels.get(baseStr)
      return { base: l.base, offset: l.offset + delta, label: baseStr }
    }
    if (/^[0-9a-f]+$/i.test(baseStr)) return { base: 'abs', offset: parseInt(baseStr, 16) + delta, label: null }
    problems.push(`${name} line ${lineNo}: label "${baseStr}" is not defined`)
    return { base: `unknown:${name}:${baseStr}`, offset: delta, label: baseStr }
  }

  function where(at) {
    if (at.label) {
      const start = labels.get(at.label)?.offset ?? 0
      const rel = at.offset - start
      return rel ? `${at.label}${rel > 0 ? '+' : '-'}${Math.abs(rel).toString(16).toUpperCase()}` : at.label
    }
    return `offset ${at.offset.toString(16).toUpperCase()}`
  }

  function write(length, lineNo) {
    writes.push({ base: cursor.base, offset: cursor.offset, length, line: lineNo, where: where(cursor) })
    cursor = { ...cursor, offset: cursor.offset + length }
  }

  text.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1
    let line = raw
    const semi = line.indexOf(';')
    if (semi !== -1) line = line.slice(0, semi)
    line = line.trim()
    if (!line) return

    let data = line
    const colon = line.indexOf(':')
    if (colon !== -1) {
      const addr = line.slice(0, colon).trimEnd()
      if (!/\s/.test(addr)) {
        data = line.slice(colon + 1).trimStart()
        cursor = address(addr, lineNo)
      }
    }
    if (!data) return

    const [command, ...args] = data.split(/\s+/)
    if (command === 'aob') {
      if (args.length < 2) return problems.push(`${name} line ${lineNo}: aob needs a label and a pattern`)
      labels.set(args[0], { base: `aob:${args.slice(1).join('').toUpperCase()}`, offset: 0 })
      return
    }
    if (command === 'alloc') {
      if (!args.length) return problems.push(`${name} line ${lineNo}: alloc needs a label`)
      labels.set(args[0], { base: `alloc:${name}:${args[0]}`, offset: 0 })
      return
    }

    const bang = data.indexOf('!')
    if (bang !== -1) {
      const type = data.slice(0, bang).trim()
      const size = typeSize(type)
      if (!size) return problems.push(`${name} line ${lineNo}: unknown value type "${type}"`)
      return write(size, lineNo)
    }

    const hex = data.replace(/\s+/g, '')
    if (!/^([0-9a-f]{2})+$/i.test(hex)) return problems.push(`${name} line ${lineNo}: can't read "${data}"`)
    write(hex.length / 2, lineNo)
  })

  return { writes, problems, labels: labels.size }
}

// sources: [{ owner, rel, text }]. Returns conflicts shaped like src/conflicts.js, one per pair of
// files that write overlapping bytes.
function patchConflicts(sources) {
  const writes = []
  sources.forEach((s, index) => {
    for (const w of parsePatch(s.text, s.rel).writes) {
      if (w.base === 'abs' || w.base.startsWith('aob:')) writes.push({ ...w, index })
    }
  })
  writes.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : a.offset - b.offset))

  const seen = new Set()
  const conflicts = []
  for (let i = 0; i < writes.length; i++) {
    const a = writes[i]
    for (let j = i + 1; j < writes.length && writes[j].base === a.base && writes[j].offset < a.offset + a.length; j++) {
      const b = writes[j]
      if (a.index === b.index) continue
      const [x, y] = a.index < b.index ? [a, b] : [b, a]
      const key = `${x.index}|${y.index}`
      if (seen.has(key)) continue
      seen.add(key)
      const sx = sources[x.index]
      const sy = sources[y.index]
      conflicts.push({
        file: `Patches/${sx.rel} + Patches/${sy.rel}`,
        path: `${x.where} (line ${x.line}) / ${y.where} (line ${y.line})`,
        mods: [sx.owner, sy.owner],
        message: `"${sx.owner}" (${sx.rel}) and "${sy.owner}" (${sy.rel}) both patch the same game code; ` +
          'Patcher applies both and the file loaded last wins, which can crash the game. Enable only one.',
      })
    }
  }
  return conflicts
}

const PATCH_REL = /^Patches\/[^/]+\.txt$/i

// Collects the patch files that will be active after deploying `outputs` to `outDir`: the ones
// the build produces plus the ones already in Mods/Patches that the ModKit didn't write.
function patchSources(outputs, outDir) {
  const sources = []
  for (const out of outputs.values()) {
    if (PATCH_REL.test(out.rel)) {
      sources.push({ owner: out.mods.at(-1), rel: path.basename(out.rel), text: out.buffer.toString('utf8') })
    }
  }
  const dir = outDir && path.join(outDir, 'Patches')
  if (dir && fs.existsSync(dir)) {
    const managed = readManifest(outDir).files
    for (const name of fs.readdirSync(dir)) {
      if (!/\.txt$/i.test(name)) continue
      const key = fileKey(`Patches/${name}`)
      if (managed[key] || outputs.has(key)) continue
      sources.push({ owner: 'installed manually', rel: name, text: fs.readFileSync(path.join(dir, name), 'utf8') })
    }
  }
  return sources
}

// Patch clashes and unreadable lines for a build result, ready to merge into it.
function checkPatches(outputs, outDir) {
  const sources = patchSources(outputs, outDir)
  const notes = []
  for (const s of sources) {
    for (const p of parsePatch(s.text, s.rel).problems) notes.push(`${s.owner}: ${p}`)
  }
  return { conflicts: patchConflicts(sources), notes }
}

// true if a loose .txt (not inside a Patches folder) is a Patcher patch rather than a readme:
// every line must read as patch syntax and it must define or write something.
function looksLikePatch(text) {
  const r = parsePatch(text)
  return r.problems.length === 0 && r.writes.length + r.labels > 0
}

// Author and a one-line description from a patch's leading comments, e.g.
//   ; Author: MoistGoat
//   ; Removes Crosshair and Laser. Laser commented out by default
function patchInfo(text) {
  let author = ''
  let description = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith(';')) {
      if (line) break
      continue
    }
    const comment = line.replace(/^;+\s*/, '')
    const m = /^author\s*:\s*(.*)$/i.exec(comment)
    if (m) author = author || m[1].trim()
    else if (!description && comment && !/^(remark|added offset|for earth defense force)/i.test(comment)) description = comment
  }
  return { author, description }
}

module.exports = { parsePatch, patchConflicts, patchSources, checkPatches, looksLikePatch, patchInfo }
