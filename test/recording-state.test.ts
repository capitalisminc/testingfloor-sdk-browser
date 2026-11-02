import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '../src/client.ts'
import { RecordingState } from '../src/recording-state.ts'

const URL = 'https://api.testingfloor.com/telemetry/recording_state'
const HANDOFF = JSON.stringify({ recording_uuid: 'example-recording' })

function endpoint (answers: Array<number | Record<string, unknown> | Error>): { send: typeof fetch, calls: string[] } {
  const calls: string[] = []
  const send = (async (_url: string, init: RequestInit) => {
    calls.push(init.body as string)
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    if (typeof answer === 'number') return new Response('{}', { status: answer })
    return new Response(JSON.stringify(answer), { status: 200 })
  }) as unknown as typeof fetch
  return { send, calls }
}

test('an open answer becomes a lease on the handoff', async () => {
  const { send, calls } = endpoint([{ closed: false, lease_expires_at_unix_ms: 20_000 }])
  const state = new RecordingState(HANDOFF, 'example-key', URL, send)
  assert.equal(state.source(0)?.leaseVersion, 1, 'startup uses a bounded grace lease')
  await state.poll(0)
  assert.deepEqual(JSON.parse(calls[0]), { $write_key: 'example-key', recording_uuid: 'example-recording' })
  const recording = state.source(0)
  assert.equal(recording?.leaseVersion, 1)
  assert.equal(recording?.telemetryRequested, true)
  assert.equal(recording?.leaseExpiresAtUnixMs, 20_000)
  assert.equal(recording?.telemetryDirectory, URL)
  assert.equal(state.store.isClosed(recording!), false)
})

test('an unknown recording retains bounded startup grace, and a failed poll keeps the last answer', async () => {
  const { send } = endpoint([404, { closed: false, lease_expires_at_unix_ms: 20_000 }, new Error('offline'), 503])
  const state = new RecordingState(HANDOFF, 'example-key', URL, send)
  await state.poll(0)
  assert.equal(state.source(0)?.leaseVersion, 1)
  await state.poll(0)
  await state.poll(0)
  await state.poll(0)
  assert.equal(state.source(0)?.leaseExpiresAtUnixMs, 20_000, 'failures do not renew or drop the lease')
})

test('a closed answer completes the recording, and an expired lease suspends it first', async () => {
  let nowMs = 0
  let seconds = 0
  const bodies: string[] = []
  const { send } = endpoint([{ closed: false, lease_expires_at_unix_ms: 20_000 }, { closed: true }])
  const state = new RecordingState(HANDOFF, 'example-key', URL, send)
  const client = new Client({
    writeKey: 'test-only-never-transmitted',
    flushIntervalSeconds: 1e9,
    clockMs: () => nowMs,
    transport: (body, done) => { bodies.push(body); done(200) },
    recordingSource: now => state.source(now),
    recordingStore: state.store
  })
  const advance = (ms: number): void => { nowMs += ms; seconds += ms / 1000; client.tick(seconds) }
  client.start(0)
  assert.equal(client.getRecording()?.recordingUuid, 'example-recording', 'events carry the recording before the first answer')
  await state.poll(nowMs)
  advance(300)
  client.track('during_lease')
  advance(21_000)
  assert.equal(client.getRecording(), null, 'a lease that runs out suspends the association')
  client.track('without_lease')
  await state.poll(nowMs)
  advance(300)
  client.flush()
  for (let attempt = 0; attempt < 5; attempt++) advance(10)
  const events = bodies.flatMap(body => JSON.parse(body).events)
  const named = (name: string) => events.find((event: { $name: string }) => event.$name === name)
  assert.equal(named('during_lease').$tf.recording_uuid, 'example-recording')
  assert.equal(named('without_lease').$tf.recording_uuid, undefined)
  const marker = named('$tf_telemetry_complete')
  assert.equal(marker.$tf.recording_uuid, 'example-recording')
  assert.equal(marker.interrupted, true, 'the lost lease is reported')
})


test('unknown answers cannot extend startup grace or revive an expired live lease', async () => {
  let nowMs = 0
  const { send } = endpoint([404, 404, { closed: false, lease_expires_at_unix_ms: 41_000 }, 404])
  const state = new RecordingState(HANDOFF, 'example-key', URL, send)
  const client = new Client({
    writeKey: 'test-only-never-transmitted', clockMs: () => nowMs,
    transport: (_body, done) => done(200),
    recordingSource: now => state.source(now), recordingStore: state.store
  })
  client.start(0)
  await state.poll(0)
  assert.equal(client.getRecording()?.recordingUuid, 'example-recording')
  nowMs = 21_000
  await state.poll(nowMs)
  client.tick(21)
  assert.equal(client.getRecording(), null, 'startup association ends without confirmation')
  await state.poll(nowMs)
  nowMs = 22_000
  client.tick(22)
  assert.equal(client.getRecording()?.recordingUuid, 'example-recording', 'confirmation resumes the run')
  nowMs = 42_000
  await state.poll(nowMs)
  client.tick(42)
  assert.equal(client.getRecording(), null, '404 cannot turn an expired confirmed lease into an unbounded handoff')
})
