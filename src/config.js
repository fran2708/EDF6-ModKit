// modkit.json: where the game, the originals and the mods are, and the order mods load in.
//
//   {
//     "gameDir": "..",
//     "vanillaDir": "vanilla",
//     "modsDir": "mods",
//     "load": ["more-slots", "armor-x10"]
//   }
//
// Relative paths are resolved from the folder containing modkit.json. `load` lists the active
// mods in load order: when two conflict, the one further down wins. `outDir` is optional
// (defaults to <gameDir>/Mods).
//
// The output folder (the game's Mods) must not overlap with the mods or originals folders: on
// Windows "mods" and "Mods" are the same folder, and build/clean would end up writing or
// deleting inside the sources.

const fs = require('fs')
const path = require('path')

const FILE = 'modkit.json'
const WORKSPACE = 'ModKit'

function load(configPath) {
  const file = path.resolve(configPath || FILE)
  if (!fs.existsSync(file)) {
    throw new Error(`${file} not found. Create one with "edfmk init".`)
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const base = path.dirname(file)
  const at = p => (p ? path.resolve(base, p) : null)
  const gameDir = at(raw.gameDir)
  const cfg = {
    file,
    raw,
    gameDir,
    vanillaDir: at(raw.vanillaDir || 'vanilla'),
    modsDir: at(raw.modsDir || 'mods'),
    outDir: at(raw.outDir) || (gameDir && path.join(gameDir, 'Mods')),
    load: raw.load || [],
  }
  checkLayout(cfg)
  return cfg
}

function save(config) {
  fs.writeFileSync(config.file, JSON.stringify(config.raw, null, 2) + '\n')
}

// Comparable form of a path: absolute, no trailing slash and, on Windows, case-insensitive.
function norm(p, platform = process.platform) {
  const abs = path.resolve(p).replace(/[\\/]+$/, '')
  return platform === 'win32' ? abs.toLowerCase() : abs
}

// true if a and b are the same folder or one is inside the other.
function overlaps(a, b, platform) {
  const x = norm(a, platform)
  const y = norm(b, platform)
  return x === y || x.startsWith(y + path.sep) || y.startsWith(x + path.sep)
}

function checkLayout(cfg, platform) {
  const dirs = [
    ['modsDir', cfg.modsDir],
    ['vanillaDir', cfg.vanillaDir],
  ]
  if (cfg.outDir) {
    for (const [name, dir] of dirs) {
      if (overlaps(dir, cfg.outDir, platform)) {
        throw new Error(
          `"${name}" (${dir}) overlaps with the game's Mods folder (${cfg.outDir}). ` +
          'Build writes to and deletes from Mods, so the sources must live somewhere else. ' +
          `Use a separate workspace, for example <game>/${WORKSPACE} with "gameDir": "..".`,
        )
      }
    }
  }
  if (overlaps(cfg.modsDir, cfg.vanillaDir, platform)) {
    throw new Error(`"modsDir" (${cfg.modsDir}) and "vanillaDir" (${cfg.vanillaDir}) overlap`)
  }
}

function looksLikeGameDir(dir) {
  return fs.existsSync(path.join(dir, 'EDF6.exe')) || fs.existsSync(path.join(dir, 'Mods'))
}

// Creates modkit.json, mods/ and vanilla/. If `dir` is the game folder, the workspace goes in
// <game>/ModKit instead of mixing with the game's Mods folder.
function init(dir, gameDirArg) {
  let workspace = path.resolve(dir)
  let gameDir = gameDirArg
  if (looksLikeGameDir(workspace)) {
    gameDir = gameDir || '..'
    workspace = path.join(workspace, WORKSPACE)
  }
  if (!gameDir) throw new Error('Specify the game folder: edfmk init "<game folder>"')

  const file = path.join(workspace, FILE)
  if (fs.existsSync(file)) throw new Error(`${file} already exists`)
  const raw = { gameDir, vanillaDir: 'vanilla', modsDir: 'mods', load: [] }
  // Validate before creating anything.
  const at = p => path.resolve(workspace, p)
  checkLayout({
    modsDir: at(raw.modsDir),
    vanillaDir: at(raw.vanillaDir),
    outDir: path.join(at(gameDir), 'Mods'),
  })

  fs.mkdirSync(path.join(workspace, 'mods'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'vanilla'), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
  fs.writeFileSync(path.join(workspace, 'vanilla', 'README.txt'),
    'Original game files go here, with the same folder structure as Mods (for example\n' +
    'DEFAULTPACKAGE/CONFIG.SGO, WEAPON/...). The ModKit extracts them from Root.cpk on its own\n' +
    'when a mod needs them; you can also place files here by hand. Patches are applied on top\n' +
    'of these files.\n')
  return { file, workspace }
}

module.exports = { load, save, init, checkLayout, overlaps, FILE, WORKSPACE }
