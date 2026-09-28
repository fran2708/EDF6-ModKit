// Verifica que todos los SGO/DSGO de una carpeta sobreviven decode -> encode -> decode sin cambios.
// Es la garantía de que el modkit no rompe archivos que no toca.
//
//   node tools/roundtrip.js "D:/Juegos/EARTH DEFENSE FORCE 6/Mods"

const fs = require('fs')
const path = require('path')
const codec = require('../src/codec')
const { listFiles } = require('../src/mods')

const dir = process.argv[2]
if (!dir) {
  console.error('Uso: node tools/roundtrip.js <carpeta>')
  process.exit(1)
}

let ok = 0
const bad = []
for (const rel of listFiles(dir)) {
  const buffer = fs.readFileSync(path.join(dir, rel))
  if (!codec.isPatchable(buffer)) continue
  try {
    const doc = codec.decode(buffer)
    const again = codec.decode(codec.encode(doc))
    if (JSON.stringify(again) === JSON.stringify(doc)) ok++
    else bad.push([rel, 'distinto después de recompilar'])
  } catch (e) {
    bad.push([rel, e.message])
  }
}
for (const [rel, why] of bad) console.log(`FALLA ${rel}: ${why}`)
console.log(`${ok} ok, ${bad.length} con problemas`)
process.exitCode = bad.length ? 1 : 0
