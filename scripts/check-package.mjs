import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const scratch = mkdtempSync(join(tmpdir(), 'testingfloor-js-package-'))
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], {
    env: { ...process.env, npm_config_cache: join(scratch, 'cache') }
  }))[0]
  assert.equal(packed.name, '@testingfloor/js')
  assert.ok(packed.files.every(file => /^(dist\/|README\.md$|CHANGELOG\.md$|LICENSE\.md$|package\.json$)/.test(file.path)), 'only public package files may be packed')
  const installed = join(scratch, 'node_modules/@testingfloor/js')
  mkdirSync(installed, { recursive: true })
  run('tar', ['-xzf', join(scratch, packed.filename), '--strip-components=1', '-C', installed])
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@testingfloor/js': packed.version } }))
  copyFileSync('test/package/smoke.mjs', join(scratch, 'smoke.mjs'))
  run(process.execPath, ['smoke.mjs'], { cwd: scratch })

  const sideEffects = `
    for (const key of ['window', 'document', 'location', 'localStorage', 'sessionStorage', 'navigator', 'crypto']) {
      Object.defineProperty(globalThis, key, { get () { throw new Error('Unexpected access to ' + key) } })
    }
    globalThis.setInterval = () => { throw new Error('Import started a timer') }
    globalThis.fetch = () => { throw new Error('Import made a request') }
    await import('@testingfloor/js')
    await import('@testingfloor/js/browser')
  `
  run(process.execPath, ['--input-type=module', '-e', sideEffects], { cwd: scratch })
  run(process.execPath, ['-e', `
    const sdk = require('@testingfloor/js')
    const browser = require('@testingfloor/js/browser')
    if (typeof browser.createTestingFloor !== 'function') throw new Error('Missing browser export')
    const client = sdk.createTestingFloor({ writeKey: 'test-only-never-transmitted', transport: (body, done) => done(200) })
    client.track('jumped')
    client.close().then(result => { if (result.status !== 'flushed') process.exitCode = 1 })
  `], { cwd: scratch })
  // A background client must allow a command-line process to exit without calling close.
  run(process.execPath, ['--input-type=module', '-e', `
    import { createTestingFloor } from '@testingfloor/js'
    createTestingFloor({ writeKey: 'test-only-never-transmitted', transport: (body, done) => done(200) })
  `], { cwd: scratch, timeout: 3000 })

  const typeSource = `
    import { createTestingFloor, type FlushResult } from '@testingfloor/js'
    const client = createTestingFloor({ writeKey: 'test-only-never-transmitted', autoTick: false, sessionId: 'example-session' })
    const result: Promise<FlushResult> = client.close()
    void result
  `
  for (const extension of ['mts', 'cts']) writeFileSync(join(scratch, `consumer.${extension}`), typeSource)
  writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', lib: ['ES2022'], types: [] },
    include: ['consumer.mts', 'consumer.cts']
  }))
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(scratch, 'tsconfig.json')])
  const metadata = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  const sdk = await import(pathToFileURL(join(installed, metadata.exports['.'].import.default)))
  assert.equal(sdk.SDK_VERSION, metadata.version)

  // CI installs these runtimes explicitly. Local runs check whichever ones are available.
  for (const [runtime, args] of [
    ['bun', ['smoke.mjs']],
    ['deno', ['run', '--no-config', '--cached-only', '--node-modules-dir=manual', '--allow-read', 'smoke.mjs']]
  ]) {
    const available = spawnSync(runtime, ['--version'], { encoding: 'utf8' })
    if (available.error?.code === 'ENOENT') { console.log(`${runtime}: unavailable locally; covered by CI`); continue }
    assert.equal(available.status, 0, available.stderr)
    run(runtime, args, { cwd: scratch })
    console.log(`${runtime}: packed package checked`)
  }
  console.log('Node.js ESM/CommonJS, import isolation, process exit, and DOM-free declarations checked')
  if (process.argv.includes('--browser')) {
    const { checkBrowser } = await import('./check-browser.mjs')
    await checkBrowser(installed, join(scratch, 'smoke.mjs'))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
