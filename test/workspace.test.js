const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { ensureWorkspace, findGameDir } = require('../src/workspace')
const { tmpdir, write } = require('./helpers')

function fakeGame() {
  const game = tmpdir()
  write(path.join(game, 'EDF6.exe'), '')
  fs.mkdirSync(path.join(game, 'Mods'))
  return game
}

test('findGameDir: la carpeta del exe, la actual o la de arriba', () => {
  const game = fakeGame()
  const other = tmpdir()
  assert.equal(findGameDir({ cwd: other, exeDir: game }), game)
  assert.equal(findGameDir({ cwd: game }), game)
  assert.equal(findGameDir({ cwd: path.join(game, 'ModKit') }), game)
  assert.equal(findGameDir({ cwd: other }), null)
})

test('ensureWorkspace: crea <juego>/ModKit la primera vez y lo reutiliza', () => {
  const game = fakeGame()
  const first = ensureWorkspace({ cwd: tmpdir(), exeDir: game })
  assert.equal(first.created, true)
  assert.equal(first.cfg.file, path.join(game, 'ModKit', 'modkit.json'))
  assert.equal(first.cfg.outDir, path.join(game, 'Mods'))
  const again = ensureWorkspace({ cwd: game })
  assert.equal(again.created, false)
  assert.equal(again.cfg.file, first.cfg.file)
})

test('ensureWorkspace: un modkit.json en la carpeta actual tiene prioridad', () => {
  const dir = tmpdir()
  write(path.join(dir, 'modkit.json'), JSON.stringify({ gameDir: 'juego', load: [] }))
  assert.equal(ensureWorkspace({ cwd: dir }).cfg.gameDir, path.join(dir, 'juego'))
})

test('ensureWorkspace: sin juego, un mensaje claro', () => {
  assert.throws(() => ensureWorkspace({ cwd: tmpdir(), exeDir: null }), /Poné EDF6-ModKit.exe/)
})
