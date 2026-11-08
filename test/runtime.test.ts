import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTestingFloor, TestingFloorClient } from '../src/runtime.ts'
import type { Transport } from '../src/client.ts'

const writeKey = 'test-only-never-transmitted'

test('manual mode drains every batch and keeps player, state, and recording context separate', async () => {
  const bodies: string[] = []
  const transport: Transport = (body, done) => { bodies.push(body); queueMicrotask(() => done(200)) }
  const first = createTestingFloor({ writeKey, transport, autoTick: false, userId: 'example-player-a', sessionId: 'example-session-a', recordingUuid: 'example-recording-a', batchMaxEvents: 1 })
  const second = createTestingFloor({ writeKey, transport, autoTick: false, userId: 'example-player-b', recordingUuid: 'example-recording-b' })
  first.setState('mode', 'first')
  second.setState('mode', 'second')
  first.track('jumped')
  first.track('landed')
  second.track('jumped')
  const results = await Promise.all([first.close(), second.close()])
  assert.ok(results.every(result => result.status === 'flushed' && result.pendingEvents === 0))
  const events = bodies.flatMap(body => JSON.parse(body).events)
  const a = events.filter(event => event.$user_id === 'example-player-a')
  const b = events.filter(event => event.$user_id === 'example-player-b')
  assert.ok(a.length > 0 && b.length > 0)
  assert.ok(a.every(event => event.$session_id === 'example-session-a' && event.$tf.recording_uuid === 'example-recording-a'))
  assert.ok(b.every(event => event.$session_id !== 'example-session-a' && event.$tf.recording_uuid === 'example-recording-b'))
  assert.equal(a.find(event => event.$name === '$tf_state').mode, 'first')
  assert.equal(b.find(event => event.$name === '$tf_state').mode, 'second')
  assert.equal(a.at(-1).$name, '$tf_telemetry_complete')
  assert.equal(b.at(-1).$name, '$tf_telemetry_complete')
  assert.ok(bodies.filter(body => JSON.parse(body).events.some((event: { $name: string }) => event.$name === '$tf_telemetry_complete')).every(body => JSON.parse(body).events.length === 1))
})

test('flush drives retries without background scheduling and preserves event IDs', async () => {
  const bodies: string[] = []
  const client = createTestingFloor({ writeKey, autoTick: false, transport: (body, done) => { bodies.push(body); done(bodies.length === 1 ? 503 : 200) } })
  client.track('jumped')
  assert.equal((await client.flush({ timeoutMs: 2000 })).status, 'flushed')
  assert.equal(bodies.length, 2)
  assert.deepEqual(JSON.parse(bodies[0]).events, JSON.parse(bodies[1]).events)
  await client.close()
})

test('a timed-out flush can be retried, and close is idempotent and refuses new events', async () => {
  let respond: (status: number) => void = () => {}
  const client = createTestingFloor({ writeKey, autoTick: false, transport: (_body, done) => { respond = done } })
  client.track('jumped')
  const result = await client.flush({ timeoutMs: 5 })
  assert.equal(result.status, 'timeout')
  assert.equal(result.pendingEvents, 1)
  respond(200)
  assert.equal((await client.flush()).status, 'flushed')
  const closing = client.close()
  assert.equal(client.close(), closing)
  assert.equal(client.shutdown(), closing)
  assert.equal(client.track('too_late'), false)
  assert.equal((await closing).status, 'flushed')
})

test('close aborts stalled HTTP work and clears both scheduling timers', async () => {
  const scheduled = new Set<unknown>()
  let signal: AbortSignal | undefined
  const client = new TestingFloorClient({
    writeKey, recordingUuid: 'example-recording',
    fetch: async (_url, init) => {
      signal = (init as typeof init & { signal: AbortSignal }).signal
      return await new Promise<Response>(() => {})
    }
  }, {
    setInterval: callback => { scheduled.add(callback); return callback },
    clearInterval: handle => { scheduled.delete(handle) }
  })
  assert.equal(scheduled.size, 2)
  client.track('jumped')
  const result = await client.close({ timeoutMs: 5 })
  assert.equal(result.status, 'timeout')
  assert.ok(result.pendingEvents > 0)
  assert.equal(scheduled.size, 0)
  assert.equal(signal?.aborted, true)
})

test('flush reports rejection, discarded records, and missing configuration', async () => {
  for (const [httpStatus, expected] of [[401, 'rejected'], [400, 'dropped']] as const) {
    const client = createTestingFloor({ writeKey, autoTick: false, transport: (_body, done) => done(httpStatus) })
    client.track('jumped')
    const result = await client.close()
    assert.equal(result.status, expected)
    assert.equal(result.pendingEvents, 0)
    assert.equal(result.droppedEvents, 1)
  }
  assert.equal((await createTestingFloor({ autoTick: false }).close()).status, 'not_configured')
  assert.equal((await createTestingFloor({ enabled: false, autoTick: false }).close()).status, 'disabled')
})

test('invalid deadlines do not end the session', async () => {
  const client = createTestingFloor({ writeKey, autoTick: false, transport: (_body, done) => done(200) })
  for (const timeoutMs of [-1, Infinity, NaN]) assert.throws(() => client.close({ timeoutMs }), RangeError)
  assert.equal(client.track('jumped'), true)
  await client.close()
})

test('a late failure and manual ticks cannot restart delivery after close times out', async () => {
  let requests = 0
  let respond: (status: number) => void = () => {}
  const client = createTestingFloor({ writeKey, autoTick: false, transport: (_body, done) => { requests++; respond = done } })
  client.track('jumped')
  assert.equal((await client.close({ timeoutMs: 0 })).status, 'timeout')
  respond(503)
  client.tick(1e9)
  assert.equal(requests, 1)
  assert.equal((await client.flush()).status, 'timeout')
})
