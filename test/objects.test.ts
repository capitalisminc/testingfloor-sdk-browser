import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '../src/client.ts'

test('an ID tracked again is removed once, then starts in a later check', () => {
  let nowMs = 1767225600000
  let seconds = 0
  const bodies: string[] = []
  const client = new Client({
    writeKey: 'test-only-never-transmitted',
    flushIntervalSeconds: 1e9,
    clockMs: () => nowMs,
    transport: (body, done) => { bodies.push(body); done(200) }
  })
  client.start(0)
  const advance = (): void => { nowMs += 300; seconds += 0.3; client.tick(seconds) }
  client.trackObject('dog', () => ({ x: 0, y: 0 }), 'dog')
  advance()
  client.removeObject('dog', 'level_unloaded')
  client.trackObject('dog', () => ({ x: 5, y: 0 }), 'dog')
  for (let step = 0; step < 4; step++) advance()
  client.flush()
  const records = bodies.flatMap(body => JSON.parse(body).events).filter(event => event.$name === '$tf_objects')
  const removedAt = records.findIndex(record => (record['removed.id'] ?? []).includes('dog'))
  const resampledAt = records.findIndex(record => {
    const index = (record['sample.id'] ?? []).indexOf('dog')
    return index >= 0 && record['sample.x'][index] === 5
  })
  assert.equal(records.flatMap(record => record['removed.id'] ?? []).filter(id => id === 'dog').length, 1, 'the removal is sent once')
  assert.ok(removedAt >= 0 && resampledAt > removedAt, 'the new object starts after the removal, in a later record')
})

test('a gone object is reported after its record was dropped', () => {
  let nowMs = 1767225600000
  let seconds = 0
  const bodies: string[] = []
  const client = new Client({
    writeKey: 'test-only-never-transmitted',
    flushIntervalSeconds: 1e9,
    queueMaxEvents: 2,
    clockMs: () => nowMs,
    transport: (body, done) => { bodies.push(body); done(200) }
  })
  client.start(0)
  const advance = (): void => { nowMs += 300; seconds += 0.3; client.tick(seconds) }
  let crate: { x: number, y: number } | null = { x: 1, y: 2 }
  client.trackObject('crate', () => crate, 'crate')
  advance()
  client.track('fills_the_queue')
  crate = null
  advance()
  assert.ok(client.droppedEvents > 0, 'the removal\'s record was dropped while the queue was full')
  for (let step = 0; step < 6; step++) { client.flush(); advance() }
  const removed = bodies.flatMap(body => JSON.parse(body).events)
    .filter(event => event.$name === '$tf_objects')
    .flatMap(record => (record['removed.id'] ?? []).map((id: string, index: number) => [id, record['removed.reason'][index]]))
  assert.deepEqual(removed, [['crate', 'gone']], 'the removal is sent once the queue has room')
})
