// Compares what the client sends with test/contract/telemetry_contract.json:
// the request and event envelope, $tf keys, record names, tracked-object
// fields, the SDK's own properties and limits.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Client } from '../src/client.ts'
import type { Recording } from '../src/recording.ts'

type Json = any
const contract: Json = JSON.parse(readFileSync(new URL('./contract/telemetry_contract.json', import.meta.url), 'utf8'))
const keys = (rows: Json[], field = 'key'): string[] => rows.map(row => row[field])
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

test('everything sent uses declared names', () => {
  let nowMs = 1767225600000
  let seconds = 0
  let closed = false
  const bodies: string[] = []
  const recording: Recording = {
    recordingUuid: 'example-recording', telemetryDirectory: 'https://testingfloor.invalid/recordings/example', playtestId: 42,
    suppressQr: true, leaseVersion: 0, telemetryRequested: false, leaseExpiresAtUnixMs: 0, editorPid: 0
  }
  let player = { x: 0, y: 0 }
  const client = new Client({
    writeKey: 'test-only-never-transmitted',
    flushIntervalSeconds: 1e9,
    movementTracking: true,
    appVersion: '1.2.3',
    engine: 'Phaser 3.80.1',
    os: 'Web',
    locale: 'en-US',
    deviceId: 'example-device',
    userId: 'example-profile',
    clockMs: () => nowMs,
    transport: (body, done) => { bodies.push(body); done(200) },
    recordingSource: () => recording,
    recordingStore: { isOpen: () => true, isClosed: () => closed, register: () => true, writeStatus: () => {} }
  })
  client.screenSize = { width: 1280, height: 720 }
  client.stateProvider = () => ({ difficulty: 'hard' })
  client.activitySource = () => ({
    playerPosition: player, cameraPosition: { x: player.x, y: 0 }, cameraOrthoWidth: 480,
    cameraFocus: player, viewportSize: { width: 1280, height: 720 }
  })
  client.start(seconds)
  client.trackObject('enemy', () => ({ x: player.x + 10, y: 5 }), 'enemy-1')
  const advance = (ms: number): void => { nowMs += ms; seconds += ms / 1000; client.tick(seconds) }
  for (let step = 0; step < 10; step++) {
    player = { x: player.x + 0.2, y: 0 }
    advance(100)
  }
  client.recordTeleport({ x: 0, y: 0 }, { x: 5, y: 0 }, 'respawn')
  client.track('level_started', { 'game_level.id': 'forest' })
  closed = true
  advance(300)
  client.shutdown()
  for (let attempt = 0; attempt < 10; attempt++) advance(10)

  const required = contract.event_fields.filter((field: Json) => field.required).map((field: Json) => field.key)
  const sdkRecords = new Map<string, string[]>()
  for (const record of contract.platform_records) {
    if (record.sent_by === 'sdk' && record.status === 'current') sdkRecords.set(record.name, keys(record.fields ?? []))
  }
  // Properties the SDK writes, plus ones the game passes through it, such as teleport.reason.
  const conventional = keys(contract.conventional_properties.filter((field: Json) => field.status === 'current'))
  const eventBytes = contract.limits.find((row: Json) => row.key === 'event_bytes').value
  const seen = new Set<string>()
  for (const body of bodies) {
    const request = JSON.parse(body)
    assert.deepEqual(Object.keys(request).filter(key => !keys(contract.request_fields).includes(key)), [], 'request envelope')
    assert.match(request.$sent_at, TIME)
    for (const event of request.events) {
      const name: string = event.$name
      seen.add(name)
      for (const key of required) assert.ok(key in event, `${name} has ${key}`)
      for (const key of Object.keys(event).filter(key => key.startsWith('$'))) assert.ok(keys(contract.event_fields).includes(key), `${name}: ${key} is declared`)
      assert.equal(event.$schema, 2)
      assert.match(event.$time, TIME)
      for (const key of Object.keys(event.$tf)) assert.ok(keys(contract.context_fields).includes(key), `${name}: $tf.${key} is declared`)
      assert.ok(new TextEncoder().encode(JSON.stringify(event)).length <= eventBytes, `${name} fits the event limit`)
      const properties = Object.keys(event).filter(key => !key.startsWith('$'))
      if (name === '$tf_objects') {
        for (const key of properties) assert.ok(keys(contract.tracked_object_fields).includes(key) || key.startsWith('game_level.'), `$tf_objects field ${key}`)
      } else if (name === '$tf_state') {
        for (const key of properties) assert.ok(key === 'difficulty' || conventional.includes(key), `$tf_state field ${key}`)
      } else if (sdkRecords.has(name)) {
        for (const key of properties) assert.ok(sdkRecords.get(name)?.includes(key), `${name} field ${key}`)
      } else {
        assert.ok(!name.startsWith('$'), `${name} is a game or SDK event`)
        for (const key of properties) {
          const sdkOwned = ['player.', 'camera.', 'movement.', 'teleport.'].some(prefix => key.startsWith(prefix))
          assert.ok(!sdkOwned || conventional.includes(key), `${name}: SDK property ${key} is declared`)
        }
      }
    }
  }
  for (const name of ['level_started', '$tf_state', '$tf_objects', '$tf_telemetry_complete', ...keys(contract.sdk_events, 'name')]) {
    assert.ok(seen.has(name), `the session sent ${name}`)
  }
})
