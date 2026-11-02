// Runs the shared SDK scenarios in test/contract/scenarios. The format is in
// test/contract/scenarios/README.md. When a scenario fails, fix the SDK, or have
// the contract changed and copy it again. Never edit the copy to make a test pass.
//
// A browser game has no telemetry folder. Testing Floor's recording endpoint
// plays that part, so the fake store here stands for both: a scenario's
// closed.json is the recording closing, a .session file is the run registering,
// and the status file is the last status the run reported.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { Client } from '../src/client.ts'
import type { RecordingStore } from '../src/client.ts'
import { resolveRecording } from '../src/recording.ts'
import type { Recording } from '../src/recording.ts'

const FOLDER = new URL('./contract/scenarios/', import.meta.url)
type Json = any

class FakeRecording implements RecordingStore {
  files = new Map<string, string>()
  writable = true
  isOpen (): boolean { return !this.files.has('closed.json') }
  isClosed (): boolean { return this.files.has('closed.json') }
  register (_recording: Recording, sessionId: string): boolean {
    if (!this.writable) return false
    this.files.set(`${sessionId}.session`, '')
    return true
  }

  writeStatus (_recording: Recording, sessionId: string, status: Record<string, unknown>): void {
    if (this.writable) this.files.set(`${sessionId}.status.json`, JSON.stringify(status))
  }
}

for (const file of readdirSync(FOLDER).filter(name => name.endsWith('.json')).sort()) {
  const scenario: Json = JSON.parse(readFileSync(new URL(file, FOLDER), 'utf8'))
  test(`scenario ${file.replace(/\.json$/, '')}`, () => {
    assert.equal(scenario.format, 1, 'This runner reads scenario format 1 only')
    const problems = scenario.kind === 'handoff' ? runHandoff(scenario) : runLifecycle(scenario)
    assert.deepEqual(problems, [])
  })
}

function runHandoff (scenario: Json): string[] {
  const problems: string[] = []
  for (const entry of scenario.cases) {
    const recording = resolveRecording(payloadText(entry.sidecar), payloadText(entry.launch_argument), entry.editor_process_id ?? 0, scenario.clock_unix_ms)
    const expect = entry.expect
    if (expect === null) {
      if (recording) problems.push(`${entry.name}: picked ${recording.recordingUuid}, expected none`)
      continue
    }
    if (!recording) {
      problems.push(`${entry.name}: picked none, expected ${expect.recording_uuid}`)
      continue
    }
    if (recording.recordingUuid !== expect.recording_uuid) problems.push(`${entry.name}: picked ${recording.recordingUuid}`)
    if ('playtest_id' in expect && recording.playtestId !== (expect.playtest_id ?? 0)) problems.push(`${entry.name}: playtest_id is ${recording.playtestId}`)
    if ('suppress_qr' in expect && recording.suppressQr !== expect.suppress_qr) problems.push(`${entry.name}: suppress_qr is ${recording.suppressQr}`)
  }
  return problems
}

function runLifecycle (scenario: Json): string[] {
  const problems: string[] = []
  const store = new FakeRecording()
  if ((scenario.requires ?? []).includes('unwritable_directory')) store.writable = false
  const directory = `https://testingfloor.invalid/recordings/${crypto.randomUUID()}`
  const editor = scenario.environment === 'editor'
  const manual = scenario.collector === 'manual'
  let nowMs: number = scenario.clock_start_unix_ms
  let seconds = 0
  let handoff: string | null = null
  const bodies: string[] = []
  const open: Array<(status: number) => void> = []
  const settings = scenario.settings ?? {}
  const client = new Client({
    writeKey: 'test-only-never-transmitted',
    endpoint: 'https://collector.invalid',
    // Records leave only on flush, shutdown, retries and the completion marker.
    flushIntervalSeconds: 1e9,
    isEditor: editor,
    queueMaxEvents: settings.queue_max_events ?? 4096,
    enableInEditor: settings.enable_in_editor ?? false,
    enableInEditorWhileRecording: settings.enable_in_editor_while_recording ?? true,
    clockMs: () => nowMs,
    transport: (body, done) => {
      bodies.push(body)
      if (manual) open.push(done)
      else done(200)
    },
    // Handoffs reach the client through the same resolution the browser entry point uses.
    recordingSource: now => handoff === null ? null : resolveRecording(editor ? handoff : null, editor ? null : handoff, 0, now),
    recordingStore: store
  })
  const substituted = (text: string): string =>
    text.replaceAll('{telemetry_directory}', JSON.stringify(directory).slice(1, -1)).replaceAll('{play_session_id}', client.playSessionId)
  let started = false
  for (const step of scenario.steps) {
    const action = Object.keys(step).find(key => key !== 'accepted') as string
    const value = step[action]
    if (!started && !['handoff', 'start', 'advance_ms', 'create_file'].includes(action)) {
      problems.push(`Step ${action} comes before start`)
      break
    }
    switch (action) {
      case 'handoff': handoff = value === null ? null : substituted(payloadText(value) as string); break
      case 'start': client.start(seconds); started = true; break
      case 'advance_ms': nowMs += value; seconds += value / 1000; break
      // Testing Floor can always change its own recording.
      case 'create_file': store.files.set(value, '{}'); store.writable = true; break
      case 'track': {
        const accepted = client.track(value)
        if ('accepted' in step && accepted !== step.accepted) problems.push(`track ${value} accepted ${accepted}`)
        break
      }
      case 'poll': client.tick(seconds); break
      case 'flush': client.flush(); break
      case 'respond': {
        const done = open.shift()
        if (!done) {
          problems.push(`respond ${value}: no request is waiting for an answer`)
          return problems
        }
        done(value)
        break
      }
      case 'shutdown':
        client.shutdown()
        for (let attempt = 0; attempt < 50 && client.pendingCount() > 0 && open.length === 0; attempt++) client.tick(seconds)
        break
      case 'check': check(client, store, value, substituted, problems); break
      default: problems.push(`Unknown step ${action}`)
    }
  }
  compare(scenario.expect, bodies, substituted, problems)
  return problems
}

function check (client: Client, store: FakeRecording, expected: Json, substituted: (text: string) => string, problems: string[]): void {
  if ('collecting' in expected && client.isCollecting() !== expected.collecting) problems.push(`check collecting is ${client.isCollecting()}`)
  if ('recording_uuid' in expected) {
    const attached = client.getRecording()?.recordingUuid ?? null
    if (attached !== expected.recording_uuid) problems.push(`check recording_uuid is ${attached}, expected ${expected.recording_uuid}`)
  }
  for (const name of expected.files_exist ?? []) if (!store.files.has(substituted(name))) problems.push(`check file exists: ${name}`)
  for (const name of expected.files_absent ?? []) if (store.files.has(substituted(name))) problems.push(`check file absent: ${name}`)
  if ('status' in expected) {
    const status = store.files.get(`${client.playSessionId}.status.json`)
    match(status ? JSON.parse(status) : {}, expected.status, 'status', substituted, problems)
  }
}

/** Every expected field must match. A null expectation means the field is absent, not present as JSON null. */
function match (actual: Json, expected: Json, path: string, substituted: (text: string) => string, problems: string[]): void {
  for (const [key, want] of Object.entries<Json>(expected)) {
    const name = `${path}.${key}`
    const present = actual !== null && typeof actual === 'object' && key in actual
    if (want === null) {
      if (present) problems.push(`${name} should be absent, but is ${JSON.stringify(actual[key])}`)
    } else if (!present) {
      problems.push(`${name} is missing`)
    } else if (typeof want === 'object') {
      match(actual[key], want, name, substituted, problems)
    } else if (actual[key] !== (typeof want === 'string' ? substituted(want) : want)) {
      problems.push(`${name} is ${JSON.stringify(actual[key])}, expected ${JSON.stringify(want)}`)
    }
  }
}

function compare (expect: Json, bodies: string[], substituted: (text: string) => string, problems: string[]): void {
  const named = new Set<string>()
  for (const request of expect.requests ?? []) for (const event of request.events) named.add(event.$name)
  for (const event of expect.events ?? []) named.add(event.$name)
  // Only the records a scenario names are compared.
  const received = bodies.map(body => JSON.parse(body).events as Json[])
    .map(all => ({ all, named: all.filter(event => named.has(event.$name)) }))
    .filter(request => request.named.length > 0)
  const describe = (events: Json[]): string => `[${events.map(event => event.$name).join(', ')}]`
  const compareEvents = (actual: Json[], expected: Json[], where: string): void => {
    if (actual.length !== expected.length) {
      problems.push(`${where}: received ${describe(actual)}, expected ${expected.length} events`)
      return
    }
    actual.forEach((event, index) => match(event, expected[index], `${where} event ${index + 1}`, substituted, problems))
  }
  if (expect.events) {
    compareEvents(received.flatMap(request => request.named), expect.events, 'events')
    return
  }
  if (received.length !== expect.requests.length) {
    problems.push(`received ${received.length} requests, expected ${expect.requests.length}: ${received.map(request => describe(request.all)).join(' ')}`)
    return
  }
  expect.requests.forEach((want: Json, index: number) => {
    const where = `request ${index + 1}`
    compareEvents(received[index].named, want.events, where)
    if (want.exclusive && received[index].all.length !== want.events.length) {
      problems.push(`${where} must hold only ${want.events.length} events, but held ${describe(received[index].all)}`)
    }
    if (want.repeats) {
      const original = received[want.repeats - 1].named
      const same = original.length === received[index].named.length &&
        original.every((event, position) => event.$id === received[index].named[position].$id && event.$time === received[index].named[position].$time)
      if (!same) problems.push(`${where} does not repeat request ${want.repeats} with the same $id and $time`)
    }
  })
}

/** A payload given as an object is passed as compact JSON; a string is passed as it is. */
function payloadText (value: unknown): string | null {
  if (value === undefined || value === null) return null
  return typeof value === 'string' ? value : JSON.stringify(value)
}
