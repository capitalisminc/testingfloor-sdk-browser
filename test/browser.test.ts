import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestingFloorForEnvironment as createTestingFloor, languageTag, readHandoff } from '../src/browser-internal.ts'

class MemoryStorage {
  values = new Map<string, string>()
  getItem (key: string): string | null { return this.values.get(key) ?? null }
  setItem (key: string, value: string): void { this.values.set(key, value) }
}

test('the fragment handoff is read, kept for reloads and removed from the address bar', () => {
  const sessionStorage = new MemoryStorage() as unknown as Storage
  const replaced: string[] = []
  const environment = { sessionStorage, history: { replaceState: (_data: unknown, _unused: string, url?: string) => { replaced.push(url ?? '') } } }
  const handoff = JSON.stringify({ recording_uuid: 'example-recording', playtest_id: 42 })
  const url = `https://game.example/play/?level=2#testing-floor=${encodeURIComponent(handoff)}`
  assert.equal(readHandoff(url, environment, 'example-game'), handoff)
  assert.deepEqual(replaced, ['/play/?level=2'])
  assert.equal(readHandoff('https://game.example/play/?level=2', environment, 'example-game'), handoff, 'a reload in the same tab keeps it')
})

test('the desktop app query handoff is read', () => {
  const handoff = readHandoff('https://game.example/?tf_recording_uuid=example-recording&tf_suppress_qr=false', {})
  assert.deepEqual(JSON.parse(handoff ?? 'null'), { recording_uuid: 'example-recording', suppress_qr: false })
})

test('a page without a handoff has none', () => {
  assert.equal(readHandoff('https://game.example/', { sessionStorage: new MemoryStorage() as unknown as Storage }), null)
})

test('browser languages become BCP 47 tags', () => {
  assert.equal(languageTag('en-us'), 'en-US')
  assert.equal(languageTag('zh-Hans-CN'), 'zh-Hans-CN')
  assert.equal(languageTag(''), '')
  assert.equal(languageTag('not a language'), '')
})

test('a browser client attaches the handoff recording and sends text/plain', async () => {
  const requests: Array<{ url: string, init: RequestInit }> = []
  const environment = {
    location: { href: 'https://game.example/?tf_recording_uuid=example-recording' },
    localStorage: new MemoryStorage() as unknown as Storage,
    sessionStorage: new MemoryStorage() as unknown as Storage,
    navigator: { language: 'en-GB' },
    innerWidth: 1280,
    innerHeight: 720,
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
  }
  const client = createTestingFloor({ gameId: 'example-game', writeKey: 'test-only-never-transmitted', engine: 'Phaser 3.80.1' }, environment)
  assert.equal(client.getRecording()?.recordingUuid, 'example-recording')
  assert.equal(client.track('level_started'), true)
  client.flush()
  await new Promise(resolve => setTimeout(resolve, 0))
  const state = requests.find(request => request.url === 'https://api.testingfloor.com/telemetry/recording_state')
  assert.deepEqual(JSON.parse(state?.init.body as string), { $write_key: 'test-only-never-transmitted', recording_uuid: 'example-recording' })
  const batch = requests.find(request => request.url === 'https://dataentry.testingfloor.com/v1/batch')
  assert.ok(batch, 'the batch was sent')
  assert.equal((batch.init.headers as Record<string, string>)['Content-Type'], 'text/plain;charset=UTF-8')
  const event = JSON.parse(batch.init.body as string).events.find((item: { $name: string }) => item.$name === 'level_started')
  assert.equal(event.$tf.recording_uuid, 'example-recording')
  assert.equal(event.$tf.os, 'Web')
  assert.equal(event.$tf.engine, 'Phaser 3.80.1')
  assert.equal(event.$tf.locale, 'en-GB')
  assert.equal(event.$tf.screen_width, 1280)
  assert.ok(event.$user_id && event.$device_id && event.$user_id !== event.$device_id, 'separate profile and installation IDs')
})

function unloadingPage (fetchResponds: boolean) {
  const listeners = new Map<string, () => void>()
  const fetched: string[] = []
  const beacons: Blob[] = []
  const replies: Array<() => void> = []
  const environment = {
    location: { href: 'https://game.example/?tf_recording_uuid=example-recording' },
    localStorage: new MemoryStorage() as unknown as Storage,
    sessionStorage: new MemoryStorage() as unknown as Storage,
    navigator: { sendBeacon: (_url: string, data: BodyInit) => { beacons.push(data as Blob); return true } },
    addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener) },
    fetch: (async (url: string, init: RequestInit) => {
      if (url.endsWith('/v1/batch')) fetched.push(init.body as string)
      if (fetchResponds) return new Response('{}', { status: 200 })
      return await new Promise<Response>(resolve => { replies.push(() => resolve(new Response('{}', { status: 200 }))) })
    }) as unknown as typeof fetch
  }
  const names = async (): Promise<string[][]> => await Promise.all(beacons.map(async beacon => JSON.parse(await beacon.text()).events.map((event: { $name: string }) => event.$name)))
  return { environment, listeners, fetched, beacons, names, respond: () => { for (const reply of replies) reply() } }
}

test('closing the page while a request is open hands everything else to sendBeacon, with the marker alone and last', async t => {
  const page = unloadingPage(false)
  t.after(page.respond)
  const client = createTestingFloor({ gameId: 'example-game', writeKey: 'test-only-never-transmitted' }, page.environment)
  for (let index = 0; index < 120; index++) client.track('jumped')
  client.flush()
  assert.equal(page.fetched.length, 1, 'the first batch is open')
  page.listeners.get('pagehide')?.()
  const beacons = await page.names()
  const marker = beacons.at(-1)
  assert.deepEqual(marker, ['$tf_telemetry_complete'])
  assert.equal(JSON.parse(await page.beacons.at(-1)!.text()).events[0].interrupted, true, 'beacons cannot confirm preceding delivery')
  assert.equal(JSON.parse(await page.beacons.at(-1)!.text()).events[0].dropped_events, 0)
  const sent = JSON.parse(page.fetched[0]).events.length + beacons.slice(0, -1).flat().filter(name => name === 'jumped').length
  assert.equal(sent, 120, 'every event left in a request')
  assert.equal(client.pendingCount(), JSON.parse(page.fetched[0]).events.length, 'only the open request remains')
})

test('a game that closes the session itself sends its final events before the marker', async () => {
  const page = unloadingPage(true)
  const client = createTestingFloor({ gameId: 'example-game', writeKey: 'test-only-never-transmitted', closeOnPageHide: false }, page.environment)
  assert.equal(page.listeners.has('pagehide'), false)
  client.track('jumped')
  client.flush()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(client.track('run_ended', { reason: 'page_hidden' }), true)
  const closing = client.close()
  assert.equal(client.track('too_late'), false)
  assert.equal((await closing).status, 'flushed')
  const sent = page.fetched.flatMap(body => JSON.parse(body).events.map((event: { $name: string }) => event.$name)).concat((await page.names()).flat())
  assert.ok(sent.indexOf('run_ended') >= 0 && sent.indexOf('run_ended') < sent.indexOf('$tf_telemetry_complete'), sent.join(', '))
})


test('game storage is isolated and survives write-key rotation', () => {
  const shared = {
    localStorage: new MemoryStorage() as unknown as Storage,
    sessionStorage: new MemoryStorage() as unknown as Storage,
    fetch: (async () => new Response('{}', { status: 404 })) as typeof fetch
  }
  const first = createTestingFloor({ gameId: 'game-a', writeKey: 'example-first-key', url: 'https://game.example/a?tf_recording_uuid=recording-a' }, shared)
  const second = createTestingFloor({ gameId: 'game-b', writeKey: 'example-other-key', url: 'https://game.example/b' }, shared)
  const rotated = createTestingFloor({ gameId: 'game-a', writeKey: 'example-rotated-key', url: 'https://game.example/a' }, shared)
  assert.notEqual(first.userId, second.userId)
  assert.notEqual(first.deviceId, second.deviceId)
  assert.equal(second.getRecording(), null)
  assert.equal(rotated.userId, first.userId)
  assert.equal(rotated.deviceId, first.deviceId)
  assert.equal(rotated.getRecording()?.recordingUuid, 'recording-a')
})

test('missing game configuration collects nothing and creates no shared identity', () => {
  const storage = new MemoryStorage()
  const client = createTestingFloor({ gameId: '', writeKey: 'example-key' }, { localStorage: storage as unknown as Storage })
  assert.equal(client.isCollecting(), false)
  assert.equal(client.track('not_collected'), false)
  assert.equal(storage.values.size, 0)
})

test('the supported entrypoint does not export protocol adapters', async () => {
  const gameApi = await import('../src/index.ts')
  const browserApi = await import('../src/browser.ts')
  assert.equal(typeof gameApi.createTestingFloor, 'function')
  for (const name of ['Client', 'BrowserClient', 'parseRecording', 'readHandoff', 'RecordingState', 'fetchTransport']) {
    assert.equal(name in gameApi, false, name)
    assert.equal(name in browserApi, false, name)
  }
  const internal = await import('../src/internal.ts')
  assert.equal(typeof internal.Client, 'function')
})

test('an explicit recording wins over the URL and close releases timers and pagehide', async () => {
  const timers = new Set<unknown>()
  const listeners = new Map<string, () => void>()
  const client = createTestingFloor({ gameId: 'example-game', writeKey: 'test-only-never-transmitted', recordingUuid: 'example-explicit-recording' }, {
    location: { href: 'https://game.example/?tf_recording_uuid=example-url-recording' },
    fetch: async () => new Response('{}'),
    setInterval: callback => { timers.add(callback); return callback },
    clearInterval: handle => { timers.delete(handle) },
    addEventListener: (type, listener) => { listeners.set(type, listener) },
    removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type) }
  })
  assert.equal(client.getRecording()?.recordingUuid, 'example-explicit-recording')
  assert.equal(timers.size, 2)
  assert.equal(listeners.size, 1)
  assert.equal((await client.close()).status, 'flushed')
  assert.equal(timers.size, 0)
  assert.equal(listeners.size, 0)
})
