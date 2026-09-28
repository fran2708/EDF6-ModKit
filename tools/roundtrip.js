// Checks that every SGO/DSGO in a folder survives decode -> encode -> decode unchanged.
// It's the guarantee that the ModKit doesn't break files it doesn't touch.
//
//   node tools/roundtrip.js "D:/Juegos/EARTH DEFENSE FORCE 6/Mods"

const fs = require('fs')
const path = require('path')
const codec = require('../src/codec')
const { listFiles } = require('../src/mods')

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: node tools/roundtrip.js <folder>')
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
    else bad.push([rel, 'different after recompiling'])
  } catch (e) {
    bad.push([rel, e.message])
  }
}
for (const [rel, why] of bad) console.log(`FAIL ${rel}: ${why}`)
console.log(`${ok} ok, ${bad.length} with problems`)
process.exitCode = bad.length ? 1 : 0
