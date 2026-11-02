import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestingFloor, languageTag, readHandoff } from '../src/browser.ts'

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
  assert.equal(readHandoff(url, environment), handoff)
  assert.deepEqual(replaced, ['/play/?level=2'])
  assert.equal(readHandoff('https://game.example/play/?level=2', environment), handoff, 'a reload in the same tab keeps it')
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
  const client = createTestingFloor({ writeKey: 'test-only-never-transmitted', engine: 'Phaser 3.80.1' }, environment)
  assert.equal(client.getRecording()?.recordingUuid, 'example-recording')
  assert.equal(client.track('level_started'), true)
  client.flush()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(requests[0].url, 'https://dataentry.testingfloor.com/v1/batch')
  assert.equal((requests[0].init.headers as Record<string, string>)['Content-Type'], 'text/plain;charset=UTF-8')
  const event = JSON.parse(requests[0].init.body as string).events.find((item: { $name: string }) => item.$name === 'level_started')
  assert.equal(event.$tf.recording_uuid, 'example-recording')
  assert.equal(event.$tf.os, 'Web')
  assert.equal(event.$tf.engine, 'Phaser 3.80.1')
  assert.equal(event.$tf.locale, 'en-GB')
  assert.equal(event.$tf.screen_width, 1280)
  assert.ok(event.$user_id && event.$device_id && event.$user_id !== event.$device_id, 'separate profile and installation IDs')
})
