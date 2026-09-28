// modkit.json: dónde está el juego, los originales, los mods y en qué orden se cargan.
//
//   {
//     "gameDir": "D:/Juegos/EARTH DEFENSE FORCE 6",
//     "vanillaDir": "vanilla",
//     "modsDir": "mods",
//     "load": ["more-slots", "armor-x10"]
//   }
//
// Las rutas relativas se resuelven desde la carpeta del modkit.json. `load` es la lista de mods
// activos en orden de carga: si dos chocan, gana el que está más abajo. `outDir` es opcional
// (por defecto <gameDir>/Mods).

const fs = require('fs')
const path = require('path')

const FILE = 'modkit.json'

function load(configPath) {
  const file = path.resolve(configPath || FILE)
  if (!fs.existsSync(file)) {
    throw new Error(`No se encontró ${file}. Creá uno con "edfmk init".`)
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const base = path.dirname(file)
  const at = p => (p ? path.resolve(base, p) : null)
  const gameDir = at(raw.gameDir)
  return {
    file,
    raw,
    gameDir,
    vanillaDir: at(raw.vanillaDir || 'vanilla'),
    modsDir: at(raw.modsDir || 'mods'),
    outDir: at(raw.outDir) || (gameDir && path.join(gameDir, 'Mods')),
    load: raw.load || [],
  }
}

function save(config) {
  fs.writeFileSync(config.file, JSON.stringify(config.raw, null, 2) + '\n')
}

module.exports = { load, save, FILE }
