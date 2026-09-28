// Builds dist/EDF6-ModKit.exe: a single file that doesn't need Node installed.
//
//   1. esbuild bundles bin/edfmk.js, src/ and the parts of sgott it uses into dist/edfmk.bundle.js
//   2. Node SEA turns that JS (and ui/index.html as an asset) into a blob
//   3. postject injects the blob into a copy of node.exe
//
// Usage: npm run build:exe

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const BUNDLE = path.join(DIST, 'edfmk.bundle.js')
const BLOB = path.join(DIST, 'edfmk.blob')
const EXE = path.join(DIST, 'EDF6-ModKit.exe')
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

function step(msg) {
  console.log(`> ${msg}`)
}

async function main() {
  fs.mkdirSync(DIST, { recursive: true })

  step('bundle')
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'bin', 'edfmk.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: BUNDLE,
    logLevel: 'warning',
  })

  step('blob SEA')
  fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify({
    main: BUNDLE,
    output: BLOB,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets: { 'index.html': path.join(ROOT, 'ui', 'index.html') },
  }))
  execFileSync(process.execPath, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')], { stdio: 'inherit' })

  step('exe')
  fs.copyFileSync(process.execPath, EXE)
  execFileSync(process.execPath, [
    require.resolve('postject/dist/cli.js'),
    EXE, 'NODE_SEA_BLOB', BLOB,
    '--sentinel-fuse', FUSE,
  ], { stdio: 'inherit' })

  const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(1)
  console.log(`\nDone: ${EXE} (${mb} MB)`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
