// Local server for the UI. Listens only on 127.0.0.1 and requires a random token on every
// request, so other pages open in the browser can't send it commands.

const fs = require('fs')
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const config = require('./config')
const { loadMods } = require('./mods')
const { build } = require('./build')
const { deploy, clean, pendingChanges } = require('./deploy')
const { installZip } = require('./zipimport')
const { isPackaged, vanillaFor } = require('./workspace')

const MAX_BODY = 1024 * 1024 * 1024 // 1 GB: some texture mods are big

function page() {
  if (isPackaged()) return require('node:sea').getAsset('index.html', 'utf8')
  return fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8')
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('The file is too big'))
        req.destroy()
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function createApp(configFile) {
  const pendingZips = new Map() // id -> { buffer, zipName }, while the user picks a variant

  const cfg = () => config.load(configFile)

  function modsOf(c) {
    const all = loadMods(c.modsDir)
    const byId = new Map(all.map(m => [m.id, m]))
    return { all, active: c.load.filter(id => byId.has(id)).map(id => byId.get(id)) }
  }

  function preview(c = cfg()) {
    const { active } = modsOf(c)
    const result = build(active, { vanilla: vanillaFor(c) })
    return {
      result,
      summary: {
        conflicts: result.conflicts,
        errors: result.errors,
        notes: result.notes,
        files: [...result.outputs.values()].map(o => ({ rel: o.rel, mods: o.mods })),
        pending: result.errors.length ? null : pendingChanges(c.outDir, result.outputs),
      },
    }
  }

  function state() {
    const c = cfg()
    const { all } = modsOf(c)
    return {
      gameDir: c.gameDir,
      modsDir: c.modsDir,
      load: c.load.filter(id => all.some(m => m.id === id)),
      mods: all.map(m => ({
        id: m.id,
        name: m.name,
        version: m.version,
        author: m.author,
        description: m.description,
        operations: Object.values(m.patches).reduce((n, ops) => n + ops.length, 0),
        files: m.files.length,
      })),
      preview: preview(c).summary,
    }
  }

  const routes = {
    'GET /api/state': () => state(),

    'POST /api/load': async body => {
      const { load } = JSON.parse(body)
      const c = cfg()
      const ids = new Set(loadMods(c.modsDir).map(m => m.id))
      if (!Array.isArray(load) || load.some(id => !ids.has(id))) throw new Error('Invalid mod list')
      c.raw.load = [...new Set(load)]
      config.save(c)
      return state()
    },

    'POST /api/apply': () => {
      const c = cfg()
      const { result } = preview(c)
      if (result.errors.length) return { ok: false, log: [], state: state() }
      const log = deploy(c.outDir, result.outputs)
      return { ok: true, log, state: state() }
    },

    'POST /api/restore': () => {
      const log = clean(cfg().outDir)
      return { ok: true, log, state: state() }
    },

    'POST /api/import': async (body, url) => {
      const zipName = url.searchParams.get('name') || 'mod.zip'
      const c = cfg()
      const r = installZip(body, { zipName, modsDir: c.modsDir, vanilla: vanillaFor(c) })
      if (r.variants) {
        const importId = crypto.randomBytes(8).toString('hex')
        pendingZips.set(importId, { buffer: body, zipName })
        return { importId, variants: r.variants }
      }
      return { installed: r.installed, notes: r.notes, state: state() }
    },

    'POST /api/import/choose': async body => {
      const { importId, variant } = JSON.parse(body)
      const pending = pendingZips.get(importId)
      if (!pending) throw new Error('The import expired; drop the zip again')
      pendingZips.delete(importId)
      const c = cfg()
      const r = installZip(pending.buffer, {
        zipName: pending.zipName, modsDir: c.modsDir, vanilla: vanillaFor(c), variant,
      })
      return { installed: r.installed, notes: r.notes, state: state() }
    },

    'POST /api/remove': async body => {
      const { id } = JSON.parse(body)
      const c = cfg()
      const mod = loadMods(c.modsDir).find(m => m.id === id)
      if (!mod) throw new Error(`Mod "${id}" does not exist`)
      fs.rmSync(mod.dir, { recursive: true, force: true })
      c.raw.load = (c.raw.load || []).filter(x => x !== id)
      config.save(c)
      return state()
    },
  }

  return { routes, page }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function startServer({ configFile, port = 0, token = crypto.randomBytes(16).toString('hex') }) {
  const app = createApp(configFile)
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        if (url.searchParams.get('t') !== token) return send(res, 403, 'Open the ModKit from EDF6-ModKit.exe', 'text/plain; charset=utf-8')
        return send(res, 200, app.page(), 'text/html; charset=utf-8')
      }
      const handler = app.routes[`${req.method} ${url.pathname}`]
      if (!handler) return send(res, 404, { error: 'Not found' })
      if (req.headers['x-token'] !== token) return send(res, 403, { error: 'Invalid token' })
      const body = req.method === 'POST' ? await readBody(req) : null
      send(res, 200, await handler(body, url))
    } catch (e) {
      send(res, 400, { error: e.message })
    }
  })
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?t=${token}`
      resolve({ server, url, token, close: () => new Promise(r => server.close(r)) })
    })
  })
}

function openBrowser(url) {
  if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url.replace(/&/g, '^&')])
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url])
}

module.exports = { startServer, openBrowser }
