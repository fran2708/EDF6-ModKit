// Finds (or creates) the workspace without the user having to configure anything.
//
// Order:
//   1. an explicit --config
//   2. a modkit.json in the current folder
//   3. the game folder (where EDF6.exe is): the exe's folder, the current one or its parent
//      (in case it's run from ModKit/). Uses <game>/ModKit and creates it if it doesn't exist.

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
      `Game not found. Put EDF6-ModKit.exe in the Earth Defense Force 6 folder (where ${GAME_EXE} is) ` +
      'and open it from there.',
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
