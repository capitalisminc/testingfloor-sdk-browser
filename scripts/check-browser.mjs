import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve, sep } from 'node:path'
import { chromium } from 'playwright'
import { pathToFileURL } from 'node:url'

export async function checkBrowser (installed, smoke) {
  const received = []
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    if (path === '/v1/batch' || path === '/recording-state') {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        if (path === '/v1/batch') received.push(JSON.parse(body))
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(path === '/recording-state' ? { closed: false, lease_expires_at_unix_ms: Date.now() + 20_000 } : {}))
      })
      return
    }
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end(`<script type="importmap">${JSON.stringify({ imports: {
        '@testingfloor/js': '/sdk/dist/esm/index.js', '@testingfloor/js/browser': '/sdk/dist/esm/browser.js'
      } })}</script>`)
      return
    }
    const file = path === '/smoke.mjs' ? smoke : path === '/worker.mjs' ? resolve('test/package/worker.mjs') : resolve(installed, '.' + path.slice('/sdk'.length))
    if (!['/smoke.mjs', '/worker.mjs'].includes(path) && (!path.startsWith('/sdk/') || !file.startsWith(installed + sep))) {
      response.writeHead(404).end(); return
    }
    try {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(readFileSync(file))
    } catch { response.writeHead(404).end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  let browser
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    const { createTestingFloor } = await import(pathToFileURL(resolve(installed, 'dist/esm/index.js')))
    const backend = createTestingFloor({ writeKey: 'test-only-never-transmitted', endpoint: origin, autoTick: false })
    backend.track('native_backend_event')
    assert.equal((await backend.close()).status, 'flushed')
    assert.equal(received[0].events[0].$name, 'native_backend_event')
    browser = await chromium.launch()
    const page = await browser.newPage()
    await page.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }) })
    await page.goto(`${origin}/?tf_recording_uuid=example-recording`)
    await page.evaluate(async () => { await import('/smoke.mjs') })
    const result = await page.evaluate(async () => {
      const { createTestingFloor } = await import('@testingfloor/js/browser')
      const requests = []
      const timers = new Set()
      const originalSet = globalThis.setInterval
      const originalClear = globalThis.clearInterval
      globalThis.setInterval = (callback, ms) => { const timer = originalSet(callback, ms); timers.add(timer); return timer }
      globalThis.clearInterval = timer => { timers.delete(timer); originalClear(timer) }
      try {
        const client = createTestingFloor({
          gameId: 'example-game', writeKey: 'test-only-never-transmitted',
          endpoint: location.origin, recordingStateUrl: location.origin + '/recording-state',
          fetch: async (url, init) => { requests.push({ url, body: init.body }); return await fetch(url, init) }
        })
        client.track('automatic_event')
        await new Promise(resolve => setTimeout(resolve, 450))
        const deliveredAutomatically = requests.some(request => request.url.endsWith('/v1/batch'))
        const closing = await client.close()
        const events = requests.filter(request => request.url.endsWith('/v1/batch')).flatMap(request => JSON.parse(request.body).events)
        return { deliveredAutomatically, closing, timers: timers.size, event: events.find(event => event.$name === 'automatic_event') }
      } finally {
        for (const timer of timers) originalClear(timer)
        globalThis.setInterval = originalSet
        globalThis.clearInterval = originalClear
      }
    })
    assert.equal(result.deliveredAutomatically, true)
    assert.equal(result.closing.status, 'flushed')
    assert.equal(result.timers, 0)
    assert.equal(result.event.$tf.recording_uuid, 'example-recording')
    assert.ok(result.event.$user_id && result.event.$device_id)
    const worker = await page.evaluate(async () => await new Promise((resolve, reject) => {
      const worker = new Worker('/worker.mjs?sdk=/sdk/dist/esm/index.js', { type: 'module' })
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Worker smoke check timed out')) }, 10_000)
      worker.onmessage = event => { clearTimeout(timeout); worker.terminate(); resolve(event.data) }
      worker.onerror = event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)) }
    }))
    assert.equal(worker.result.status, 'flushed')
    assert.equal(worker.events[0].$name, 'worker_event')
    console.log('Native Node.js/browser HTTP, Chromium automatic batching, cleanup, and Web Worker checked')
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}
