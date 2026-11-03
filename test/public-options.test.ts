import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '../src/client.ts'
import type { Recording } from '../src/recording.ts'
import { RecordingState } from '../src/recording-state.ts'

test('one coordinate transform covers events, objects, directions and lengths', () => {
  const bodies: string[] = []
  const client = new Client({
    writeKey: 'example-key', buildId: 'example-artifact', appVersion: '1.2.3',
    coordinateTransform: { axes: [1, -2, 3], scale: 2, offset: { x: 10, y: 20, z: 30 } },
    transport: (body, done) => { bodies.push(body); done(200) },
    clockMs: () => 1000, flushIntervalSeconds: 1e9, movementTracking: false
  })
  client.start(0)
  client.activitySource = () => ({ playerPosition: { x: 1, y: 2, z: 3 }, cameraForward: { x: 0, y: 1, z: 0 }, cameraOrthoWidth: 4 })
  client.trackObject('example-object', () => ({ x: 1, y: 2, z: 3 }))
  client.track('example-action')
  client.recordTeleport({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 })
  client.tick(1)
  client.flush()
  const events = bodies.flatMap(body => JSON.parse(body).events)
  const action = events.find(event => event.$name === 'example-action')
  assert.deepEqual([action['player.position.x'], action['player.position.y'], action['player.position.z']], [12, 16, 36])
  assert.deepEqual([action['camera.forward.x'], action['camera.forward.y'], action['camera.forward.z']], [0, -1, 0])
  assert.equal(action['camera.ortho_width'], 8)
  assert.equal(action.$tf.build_id, 'example-artifact')
  assert.equal(action.$tf.app_version, '1.2.3')
  const object = events.find(event => event.$name === '$tf_objects')
  assert.deepEqual([object['sample.x'][0], object['sample.y'][0], object['sample.z'][0]], [12, 16, 36])
  const teleport = events.find(event => event.$name === '$tf_player_teleported')
  assert.equal(teleport['teleport.distance'], 10)
  assert.deepEqual([teleport['teleport.start.position.x'], teleport['teleport.start.position.y'], teleport['teleport.start.position.z']], [10, 20, 30])
  assert.deepEqual([teleport['teleport.end.position.x'], teleport['teleport.end.position.y'], teleport['teleport.end.position.z']], [16, 12, 30])
  assert.equal(client.track('$tf_player_moved'), false, 'game code cannot impersonate automatic events')
  assert.equal(client.track('player_moved'), true, 'legacy game-owned names remain available')
})

test('recording-only packaged collection waits, pauses and resumes without stopping discovery', () => {
  let now = 1000
  let recording: Recording | null = null
  const client = new Client({
    writeKey: 'example-key', collectionMode: 'recording_only', clockMs: () => now,
    recordingSource: () => recording, transport: (_, done) => { done(200) }
  })
  client.start()
  assert.equal(client.track('before-recording'), false)
  assert.equal(client.collectionReason(), 'recording_required')
  const object = client.trackObject('example-object', () => ({ x: 0, y: 0 }))
  assert.ok(object, 'objects can register while waiting for a recording')
  recording = { recordingUuid: 'example-capture', telemetryDirectory: 'https://example.invalid/capture', playtestId: 0, suppressQr: true,
    leaseVersion: 1, telemetryRequested: true, leaseExpiresAtUnixMs: 6000, editorPid: 0 }
  now = 1500
  client.tick(0.5)
  assert.equal(client.track('during-recording'), true)
  recording = { ...recording, telemetryRequested: false }
  now = 2000
  client.tick(1)
  assert.equal(client.track('paused'), false)
  recording = { ...recording, telemetryRequested: true, leaseExpiresAtUnixMs: 8000 }
  now = 2500
  client.tick(1.5)
  assert.equal(client.track('resumed'), true)
})

test('browser recording state carries pause into the recording-only policy', async () => {
  const state = new RecordingState(JSON.stringify({ recording_uuid: 'example-capture' }), 'example-key', undefined,
    (async () => new Response(JSON.stringify({ closed: false, state: 'paused', lease_expires_at_unix_ms: 6000 }), { status: 200 })) as typeof fetch)
  await state.poll(1000)
  assert.equal(state.source(1000)?.telemetryRequested, false)
})

test('invalid transforms fail at configuration rather than corrupting queued coordinates', () => {
  assert.throws(() => new Client({ coordinateTransform: { axes: [1, 1, 3] } }), /distinct signed axes/)
  assert.throws(() => new Client({ coordinateTransform: { scale: 0 } }), /positive finite scale/)
})
