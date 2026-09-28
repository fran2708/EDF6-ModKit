// modkit.json: dónde está el juego, los originales, los mods y en qué orden se cargan.
//
//   {
//     "gameDir": "..",
//     "vanillaDir": "vanilla",
//     "modsDir": "mods",
//     "load": ["more-slots", "armor-x10"]
//   }
//
// Las rutas relativas se resuelven desde la carpeta del modkit.json. `load` es la lista de mods
// activos en orden de carga: si dos chocan, gana el que está más abajo. `outDir` es opcional
// (por defecto <gameDir>/Mods).
//
// La carpeta de salida (Mods del juego) no puede superponerse con la de mods ni con la de
// originales: en Windows "mods" y "Mods" son la misma carpeta, y el build/clean terminaría
// escribiendo o borrando adentro de las fuentes.

const fs = require('fs')
const path = require('path')

const FILE = 'modkit.json'
const WORKSPACE = 'ModKit'

function load(configPath) {
  const file = path.resolve(configPath || FILE)
  if (!fs.existsSync(file)) {
    throw new Error(`No se encontró ${file}. Creá uno con "edfmk init".`)
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

// Forma comparable de una ruta: absoluta, sin barra final y, en Windows, sin distinguir mayúsculas.
function norm(p, platform = process.platform) {
  const abs = path.resolve(p).replace(/[\\/]+$/, '')
  return platform === 'win32' ? abs.toLowerCase() : abs
}

// true si a y b son la misma carpeta o una está adentro de la otra.
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
          `"${name}" (${dir}) se superpone con la carpeta Mods del juego (${cfg.outDir}). ` +
          'El build escribe y borra en Mods, así que las fuentes tienen que estar en otro lado. ' +
          `Usá un workspace aparte, por ejemplo <juego>/${WORKSPACE} con "gameDir": "..".`,
        )
      }
    }
  }
  if (overlaps(cfg.modsDir, cfg.vanillaDir, platform)) {
    throw new Error(`"modsDir" (${cfg.modsDir}) y "vanillaDir" (${cfg.vanillaDir}) se superponen`)
  }
}

function looksLikeGameDir(dir) {
  return fs.existsSync(path.join(dir, 'EDF6.exe')) || fs.existsSync(path.join(dir, 'Mods'))
}

// Crea modkit.json, mods/ y vanilla/. Si `dir` es la carpeta del juego, el workspace va en
// <juego>/ModKit en vez de mezclarse con la carpeta Mods del juego.
function init(dir, gameDirArg) {
  let workspace = path.resolve(dir)
  let gameDir = gameDirArg
  if (looksLikeGameDir(workspace)) {
    gameDir = gameDir || '..'
    workspace = path.join(workspace, WORKSPACE)
  }
  if (!gameDir) throw new Error('Indicá la carpeta del juego: edfmk init "<carpeta del juego>"')

  const file = path.join(workspace, FILE)
  if (fs.existsSync(file)) throw new Error(`${file} ya existe`)
  const raw = { gameDir, vanillaDir: 'vanilla', modsDir: 'mods', load: [] }
  // Validar antes de crear nada.
  const at = p => path.resolve(workspace, p)
  checkLayout({
    modsDir: at(raw.modsDir),
    vanillaDir: at(raw.vanillaDir),
    outDir: path.join(at(gameDir), 'Mods'),
  })

  fs.mkdirSync(path.join(workspace, 'mods'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'vanilla'), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
  fs.writeFileSync(path.join(workspace, 'vanilla', 'LEEME.txt'),
    'Poné acá los archivos originales del juego, extraídos de Root.cpk, con la misma\n' +
    'estructura de carpetas que Mods (por ejemplo DEFAULTPACKAGE/CONFIG.SGO, WEAPON/...).\n' +
    'El modkit aplica los parches sobre estos archivos.\n')
  return { file, workspace }
}

module.exports = { load, save, init, checkLayout, overlaps, FILE, WORKSPACE }
