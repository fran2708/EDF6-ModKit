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
const { ensureWorkspace, isPackaged, vanillaFor } = require('../src/workspace')
const { fileKey } = require('../src/mods')
const { startServer, openBrowser } = require('../src/server')
const { checkPatches } = require('../src/patcher')
const { createLoader } = require('../src/loader')
const pkg = require('../package.json')

const HELP = `edfmk ${pkg.version} — mod framework for EDF6

Usage:
  edfmk                              (or double-click the .exe) sets everything up and opens the UI
  edfmk ui [--no-browser] [--port N] opens the UI in the browser
  edfmk status                       game folder and number of mods
  edfmk init [game folder]           creates modkit.json, mods/ and vanilla/ (in the game folder
                                     it creates them in ModKit/ so they don't mix with Mods/)
  edfmk list                         mods found and load order
  edfmk build [--dry-run]            combines the active mods and writes them to Mods/
  edfmk clean                        removes what the ModKit wrote and restores backups
  edfmk paths <file.sgo> [text]      lists the paths and values of an SGO/DSGO (filter by text)
  edfmk diff <original> <modified>   prints the operations that turn one into the other
  edfmk import <folder> <id>         turns a whole-file mod into mods/<id>
  edfmk extract <path> [...]         extracts original files from Root.cpk into vanilla/
  edfmk loader                       EDFModLoader/Patcher status and latest official version
  edfmk loader install [--force]     installs or updates them from the official GitHub release

Without --config, it looks for modkit.json in the current folder or uses <game>/ModKit
(creating it if needed).

Options:
  --config <modkit.json>             use another configuration file
`

function parseArgs(argv) {
  const opts = {}
  const args = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--config') opts.config = argv[++i]
    else if (a === '--port') opts.port = argv[++i]
    else if (a.startsWith('--')) opts[a.slice(2)] = true
    else args.push(a)
  }
  return { opts, args }
}

function workspace(opts) {
  const { cfg, created } = ensureWorkspace({ configPath: opts.config })
  if (created) console.log(`Created the workspace in ${path.dirname(cfg.file)}`)
  return cfg
}

function activeMods(cfg) {
  const all = loadMods(cfg.modsDir)
  const byId = new Map(all.map(m => [m.id, m]))
  const missing = cfg.load.filter(id => !byId.has(id))
  if (missing.length) throw new Error(`"load" lists mods that don't exist in ${cfg.modsDir}: ${missing.join(', ')}`)
  return { all, active: cfg.load.map(id => byId.get(id)) }
}

function printResult(result) {
  for (const n of result.notes) console.log(`note: ${n}`)
  for (const c of result.conflicts) {
    console.log(`conflict: ${c.file}${c.path ? ` [${c.path}]` : ''}: ${c.message}`)
  }
  for (const e of result.errors) console.log(`error: ${e.mod}: ${e.file}: ${e.message}`)
}

const commands = {
  init(args, opts) {
    const dir = opts.config ? path.dirname(path.resolve(opts.config)) : process.cwd()
    const { file, workspace } = config.init(dir, args[0])
    if (workspace !== dir) console.log(`This is the game folder: the workspace goes in ${workspace}`)
    console.log(`Created ${file}`)
  },

  list(args, opts) {
    const cfg = workspace(opts)
    const all = loadMods(cfg.modsDir)
    if (!all.length) console.log(`No mods in ${cfg.modsDir}`)
    const order = new Map(cfg.load.map((id, i) => [id, i + 1]))
    for (const m of all) {
      const pos = order.get(m.id)
      const nPatches = Object.values(m.patches).reduce((n, ops) => n + ops.length, 0)
      console.log(`${pos ? String(pos).padStart(3) : '  -'}  ${m.id.padEnd(24)} ${m.name} ${m.version}`.trimEnd() +
        `  (${nPatches} operations, ${m.files.length} files)`)
    }
    for (const id of cfg.load.filter(id => !all.some(m => m.id === id))) console.log(`  !  ${id} (not found)`)
  },

  build(args, opts) {
    const cfg = workspace(opts)
    if (!cfg.outDir) throw new Error('"gameDir" or "outDir" is missing in modkit.json')
    const { active } = activeMods(cfg)
    const result = build(active, { vanilla: vanillaFor(cfg) })
    const patches = checkPatches(result.outputs, cfg.outDir)
    result.conflicts.push(...patches.conflicts)
    result.notes.push(...patches.notes)
    printResult(result)
    if (result.errors.length) {
      console.log(`\nNothing was written: ${result.errors.length} error(s).`)
      process.exitCode = 1
      return
    }
    const log = deploy(cfg.outDir, result.outputs, { dryRun: !!opts['dry-run'] })
    for (const line of log) console.log(line)
    console.log(`\n${result.outputs.size} file(s) from ${active.length} mod(s), ${result.conflicts.length} conflict(s)` +
      (opts['dry-run'] ? ' (dry run: nothing was written)' : ` -> ${cfg.outDir}`))
  },

  clean(args, opts) {
    const cfg = workspace(opts)
    for (const line of clean(cfg.outDir)) console.log(line)
  },

  extract(args, opts) {
    if (!args.length) throw new Error('Usage: edfmk extract <path in the game> [...]')
    const cfg = workspace(opts)
    const vanilla = vanillaFor(cfg)
    for (const rel of args) {
      const found = vanilla.get(fileKey(rel))
      if (!found) throw new Error(`"${rel}" is not in the game's CPKs`)
      console.log(found.abs)
    }
  },

  async ui(args, opts) {
    const cfg = workspace(opts)
    const port = opts.port ? Number(opts.port) : 0
    const { url } = await startServer({ configFile: cfg.file, port })
    console.log(`EDF6 ModKit is open in your browser.\n${url}\n`)
    console.log("If it didn't open by itself, paste that address into your browser.")
    console.log('Close this window to quit the ModKit.')
    if (!opts['no-browser']) openBrowser(url)
  },

  async loader(args, opts) {
    const cfg = workspace(opts)
    if (!cfg.gameDir) throw new Error('"gameDir" is missing in modkit.json')
    const loader = createLoader({ cacheDir: path.join(path.dirname(cfg.file), '.cache', 'loader') })
    if (args[0] === 'install') {
      const r = await loader.install(cfg.gameDir, { force: !!opts.force })
      for (const rel of r.written) console.log(`installed ${rel}`)
      for (const rel of r.backedUp) console.log(`backed up the previous ${rel}`)
      if (r.kept.length) console.log(`kept ${r.kept.length} existing file(s) (settings and patches are never overwritten)`)
      console.log(`\nEDFModLoader ${r.tag} is installed in ${cfg.gameDir}`)
      return
    }
    if (args[0]) throw new Error('Usage: edfmk loader [install] [--force]')
    const s = await loader.status(cfg.gameDir, { check: true })
    const state = { missing: 'not installed', installed: 'installed', foreign: 'winmm.dll belongs to another program' }
    const version = s.installedTag ? ` (${s.installedTag})` : ''
    console.log(`EDFModLoader: ${state[s.loader]}${version}`)
    console.log(`Patcher:      ${s.patcher === 'installed' ? 'installed' : 'not installed'}`)
    if (s.offline) console.log(`Latest:       couldn't check (${s.error})`)
    else console.log(`Latest:       ${s.latestTag}${s.upToDate ? ' (up to date)' : ' — run "edfmk loader install"'}`)
  },

  status(args, opts) {
    const cfg = workspace(opts)
    const all = loadMods(cfg.modsDir)
    console.log(`Game:   ${cfg.gameDir}`)
    console.log(`Mods:   ${cfg.modsDir} (${all.length} installed, ${cfg.load.length} active)`)
    console.log('\nTo see the commands: edfmk help')
  },

  paths(args) {
    const [file, filter] = args
    if (!file) throw new Error('Usage: edfmk paths <file.sgo> [text]')
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
    if (!a || !b) throw new Error('Usage: edfmk diff <original> <modified>')
    const { ops, warnings } = diff(codec.readDoc(a), codec.readDoc(b))
    for (const w of warnings) console.error(`warning: ${w}`)
    console.log(JSON.stringify(ops, null, 2))
  },

  import(args, opts) {
    const [src, id] = args
    if (!src || !id) throw new Error('Usage: edfmk import <folder> <id>')
    const cfg = workspace(opts)
    const dest = path.join(cfg.modsDir, id)
    if (fs.existsSync(dest)) throw new Error(`${dest} already exists`)
    const r = importFolder(path.resolve(src), dest, { vanilla: vanillaFor(cfg), id })
    for (const n of r.notes) console.log(`note: ${n}`)
    for (const f of r.patched) console.log(`patch  ${f}`)
    for (const f of r.copied) console.log(`copy   ${f}`)
    for (const f of r.skipped) console.log(`same   ${f} (identical to the original, skipped)`)
    console.log(`\nCreated ${dest}. Add "${id}" to "load" in modkit.json to activate it.`)
  },
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { opts, args } = parseArgs(rest)
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP)
  if (cmd === '--version' || cmd === '-v') return console.log(pkg.version)
  // Double-clicking the .exe: no arguments.
  if (!cmd) return interactive(opts)
  const fn = commands[cmd]
  if (!fn) {
    console.error(`Unknown command: ${cmd}\n\n${HELP}`)
    process.exitCode = 1
    return
  }
  Promise.resolve()
    .then(() => fn(args, opts))
    .catch(e => {
      console.error(`error: ${e.message}`)
      process.exitCode = 1
    })
}

// Double-click: opens the UI. If something fails, the window waits for Enter so the error can be
// read before it closes.
async function interactive(opts) {
  try {
    await commands.ui([], opts)
  } catch (e) {
    console.error(`error: ${e.message}`)
    process.exitCode = 1
    if (isPackaged()) {
      console.log('\nPress Enter to exit.')
      process.stdin.once('data', () => process.exit())
    }
  }
}

main()
