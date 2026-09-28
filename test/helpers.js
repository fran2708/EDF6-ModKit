const fs = require('fs')
const os = require('os')
const path = require('path')

const n = (type, value) => ({ type, value })
const f = v => n('float', v)
const i = v => n('int', v)
const s = v => n('string', v)
const ptr = (...value) => n('ptr', value)

// A small document shaped like DEFAULTPACKAGE/CONFIG.SGO.
function configDoc() {
  return {
    format: 'SGO',
    endian: 'LE',
    variables: [
      { name: 'PackageName', ...s('DEFP') },
      {
        name: 'SoldierInit',
        ...ptr(
          ptr(s('Ranger'), f(1), ptr(i(0), i(1)), ptr(f(200), f(0.5))),
          ptr(s('WingDiver'), f(1), ptr(i(0), i(1)), ptr(f(150), f(0.25))),
        ),
      },
      { name: 'name.en', ...s('Config') },
    ],
  }
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'edfmk-'))
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
}

module.exports = { n, f, i, s, ptr, configDoc, tmpdir, write }
