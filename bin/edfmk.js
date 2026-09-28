#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const config = require('../src/config')
const codec = require('../src/codec')
const { loadMods } = require('../src/mods')
const { build } = require('../src/build')
const { deploy, clean } = require('../src/deploy')
const { diff } = require('../src/diff')
const { leaves } = require('../src/path')
const { importFolder } = require('../src/importer')
const pkg = require('../package.json')

const HELP = `edfmk ${pkg.version} — framework de mods para EDF6

Uso:
  edfmk init [carpeta del juego]     crea modkit.json, mods/ y vanilla/ en la carpeta actual
  edfmk list                         mods encontrados y orden de carga
  edfmk build [--dry-run]            combina los mods activos y los escribe en Mods/
  edfmk clean                        quita lo que escribió el modkit y restaura respaldos
  edfmk paths <archivo.sgo> [texto]  lista las rutas y valores de un SGO/DSGO (filtra por texto)
  edfmk diff <original> <modificado> imprime las operaciones que llevan de uno al otro
  edfmk import <carpeta> <id>        convierte un mod de archivos completos en mods/<id>

Opciones:
  --config <modkit.json>             usar otro archivo de configuración
`

function parseArgs(argv) {
  const opts = {}
  const args = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') opts.config = argv[++i]
    else if (a.startsWith('--')) opts[a.slice(2)] = true
    else args.push(a)
  }
  return { opts, args }
}

function activeMods(cfg) {
  const all = loadMods(cfg.modsDir)
  const byId = new Map(all.map(m => [m.id, m]))
  const missing = cfg.load.filter(id => !byId.has(id))
  if (missing.length) throw new Error(`En "load" hay mods que no existen en ${cfg.modsDir}: ${missing.join(', ')}`)
  return { all, active: cfg.load.map(id => byId.get(id)) }
}

function printResult(result) {
  for (const n of result.notes) console.log(`nota: ${n}`)
  for (const c of result.conflicts) {
    console.log(`conflicto: ${c.file}${c.path ? ` [${c.path}]` : ''}: ${c.message}`)
  }
  for (const e of result.errors) console.log(`error: ${e.mod}: ${e.file}: ${e.message}`)
}

const commands = {
  init(args, opts) {
    const file = path.resolve(opts.config || config.FILE)
    if (fs.existsSync(file)) throw new Error(`${file} ya existe`)
    const gameDir = args[0] || 'D:/Juegos/EARTH DEFENSE FORCE 6'
    const raw = { gameDir, vanillaDir: 'vanilla', modsDir: 'mods', load: [] }
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
    const dir = path.dirname(file)
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'vanilla'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'vanilla', 'LEEME.txt'),
      'Poné acá los archivos originales del juego, extraídos de Root.cpk, con la misma\n' +
      'estructura de carpetas que Mods (por ejemplo DEFAULTPACKAGE/CONFIG.SGO, WEAPON/...).\n' +
      'El modkit aplica los parches sobre estos archivos.\n')
    console.log(`Creado ${file}`)
  },

  list(args, opts) {
    const cfg = config.load(opts.config)
    const all = loadMods(cfg.modsDir)
    if (!all.length) console.log(`No hay mods en ${cfg.modsDir}`)
    const order = new Map(cfg.load.map((id, i) => [id, i + 1]))
    for (const m of all) {
      const pos = order.get(m.id)
      const nPatches = Object.values(m.patches).reduce((n, ops) => n + ops.length, 0)
      console.log(`${pos ? String(pos).padStart(3) : '  -'}  ${m.id.padEnd(24)} ${m.name} ${m.version}`.trimEnd() +
        `  (${nPatches} operaciones, ${m.files.length} archivos)`)
    }
    for (const id of cfg.load.filter(id => !all.some(m => m.id === id))) console.log(`  !  ${id} (no encontrado)`)
  },

  build(args, opts) {
    const cfg = config.load(opts.config)
    if (!cfg.outDir) throw new Error('Falta "gameDir" u "outDir" en modkit.json')
    const { active } = activeMods(cfg)
    const result = build(active, { vanillaDir: cfg.vanillaDir })
    printResult(result)
    if (result.errors.length) {
      console.log(`\nNo se escribió nada: ${result.errors.length} error(es).`)
      process.exitCode = 1
      return
    }
    const log = deploy(cfg.outDir, result.outputs, { dryRun: !!opts['dry-run'] })
    for (const line of log) console.log(line)
    console.log(`\n${result.outputs.size} archivo(s) de ${active.length} mod(s), ${result.conflicts.length} conflicto(s)` +
      (opts['dry-run'] ? ' (dry-run: no se escribió nada)' : ` -> ${cfg.outDir}`))
  },

  clean(args, opts) {
    const cfg = config.load(opts.config)
    for (const line of clean(cfg.outDir)) console.log(line)
  },

  paths(args) {
    const [file, filter] = args
    if (!file) throw new Error('Uso: edfmk paths <archivo.sgo> [texto]')
    const doc = codec.readDoc(file)
    const needle = filter && filter.toLowerCase()
    for (const { path: p, node } of leaves(doc)) {
      const value = node.type === 'ptr' ? '[]' : JSON.stringify(node.value)
      const line = `${p} = ${value.length > 80 ? value.slice(0, 77) + '...' : value}  (${node.type})`
      if (!needle || line.toLowerCase().includes(needle)) console.log(line)
    }
  },

  diff(args) {
    const [a, b] = args
    if (!a || !b) throw new Error('Uso: edfmk diff <original> <modificado>')
    const { ops, warnings } = diff(codec.readDoc(a), codec.readDoc(b))
    for (const w of warnings) console.error(`aviso: ${w}`)
    console.log(JSON.stringify(ops, null, 2))
  },

  import(args, opts) {
    const [src, id] = args
    if (!src || !id) throw new Error('Uso: edfmk import <carpeta> <id>')
    const cfg = config.load(opts.config)
    const dest = path.join(cfg.modsDir, id)
    if (fs.existsSync(dest)) throw new Error(`${dest} ya existe`)
    const r = importFolder(path.resolve(src), dest, { vanillaDir: cfg.vanillaDir, id })
    for (const n of r.notes) console.log(`nota: ${n}`)
    for (const f of r.patched) console.log(`parche  ${f}`)
    for (const f of r.copied) console.log(`copia   ${f}`)
    for (const f of r.skipped) console.log(`igual   ${f} (idéntico al original, se omite)`)
    console.log(`\nCreado ${dest}. Agregá "${id}" a "load" en modkit.json para activarlo.`)
  },
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { opts, args } = parseArgs(rest)
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP)
  if (cmd === '--version' || cmd === '-v') return console.log(pkg.version)
  const fn = commands[cmd]
  if (!fn) {
    console.error(`Comando desconocido: ${cmd}\n\n${HELP}`)
    process.exitCode = 1
    return
  }
  try {
    fn(args, opts)
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exitCode = 1
  }
}

main()
