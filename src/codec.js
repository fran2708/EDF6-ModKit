// Lectura y escritura de SGO/DSGO. El trabajo pesado lo hace sgott; este módulo solo
// le arma el "state" que espera y decide qué conversor usar según el magic del archivo.
const fs = require('fs')
const globals = require('sgott/globals.js')
const compiler = require('sgott/converters/compiler.js')
const decompiler = require('sgott/converters/decompiler.js')

const MAGICS = {
  'SGO\0': 'sgo',
  '\0OGS': 'sgo',
  'DSGO': 'dsgo',
  'OGSD': 'dsgo',
}

function state() {
  return {
    opts: {},
    compiler,
    decompiler,
    compilers: globals.compilers,
    decompilers: globals.decompilers,
  }
}

function formatOf(buffer) {
  return MAGICS[buffer.subarray(0, 4).toString('latin1')] || null
}

function isPatchable(buffer) {
  return formatOf(buffer) !== null
}

function decode(buffer) {
  const format = formatOf(buffer)
  if (!format) throw new Error('No es un archivo SGO/DSGO')
  const doc = format === 'dsgo'
    ? globals.decompilers.dsgo(buffer, state())
    : globals.decompilers.sgo(decompiler, buffer, state())
  // sgott devuelve algunos objetos con prototipos propios; los normalizamos a JSON plano.
  const plain = JSON.parse(JSON.stringify(doc))
  plain.format = format.toUpperCase()
  return plain
}

function encode(doc) {
  const out = /^dsgo$/i.test(doc.format)
    ? globals.compilers.dsgo(doc, state(), globals)
    : globals.compilers.sgo(compiler, doc, state(), globals)
  return Buffer.from(out)
}

function readDoc(file) {
  return decode(fs.readFileSync(file))
}

module.exports = { decode, encode, readDoc, formatOf, isPatchable }
