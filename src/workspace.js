// Encuentra (o crea) el workspace sin que el usuario tenga que configurar nada.
//
// Orden:
//   1. --config explícito
//   2. un modkit.json en la carpeta actual
//   3. la carpeta del juego (donde está EDF6.exe): la del .exe, la actual o la de arriba de la
//      actual (por si se corre desde ModKit/). Usa <juego>/ModKit y lo crea si no existe.

const fs = require('fs')
const path = require('path')
const config = require('./config')
const { vanillaProvider } = require('./vanilla')

const GAME_EXE = 'EDF6.exe'

function isPackaged() {
  try {
    return require('node:sea').isSea()
  } catch {
    return false
  }
}

function isGameDir(dir) {
  return !!dir && fs.existsSync(path.join(dir, GAME_EXE))
}

function findGameDir({ cwd = process.cwd(), exeDir } = {}) {
  const candidates = [exeDir, cwd, path.dirname(cwd)]
  return candidates.find(isGameDir) || null
}

function ensureWorkspace({ configPath, cwd = process.cwd(), exeDir } = {}) {
  if (configPath) return { cfg: config.load(configPath), created: false }

  const local = path.join(cwd, config.FILE)
  if (fs.existsSync(local)) return { cfg: config.load(local), created: false }

  if (exeDir === undefined && isPackaged()) exeDir = path.dirname(process.execPath)
  const gameDir = findGameDir({ cwd, exeDir })
  if (!gameDir) {
    throw new Error(
      `No encontré el juego. Poné EDF6-ModKit.exe en la carpeta de Earth Defense Force 6 (donde está ${GAME_EXE}) ` +
      'y abrilo desde ahí.',
    )
  }
  const file = path.join(gameDir, config.WORKSPACE, config.FILE)
  let created = false
  if (!fs.existsSync(file)) {
    config.init(gameDir)
    created = true
  }
  return { cfg: config.load(file), created }
}

function vanillaFor(cfg) {
  return vanillaProvider({ vanillaDir: cfg.vanillaDir, gameDir: cfg.gameDir })
}

module.exports = { ensureWorkspace, findGameDir, isPackaged, vanillaFor }
