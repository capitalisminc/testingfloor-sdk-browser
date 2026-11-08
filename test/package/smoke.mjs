// This file also runs in Bun, Deno, and a browser with an import map.
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const { createTestingFloor, SDK_VERSION } = await import('@testingfloor/js')
const { createTestingFloor: createBrowser } = await import('@testingfloor/js/browser')

const requests = []
const send = async (url, init) => {
  requests.push({ url, init })
  return new Response('{}', { status: 200 })
}
const client = createTestingFloor({
  writeKey: 'test-only-never-transmitted', autoTick: false, fetch: send,
  userId: 'example-player', sessionId: 'example-session', recordingUuid: 'example-recording', batchMaxEvents: 1
})
client.track('jumped')
client.track('landed')
const result = await client.close()
assert(result.status === 'flushed' && result.pendingEvents === 0, 'all batches must drain')
const events = requests.flatMap(request => JSON.parse(request.init.body).events)
assert(events.length === 3, 'two gameplay events and a completion marker')
assert(events.every(event => event.$user_id === 'example-player' && event.$session_id === 'example-session' && event.$tf.recording_uuid === 'example-recording'), 'explicit context must survive delivery')
assert(events.at(-1).$name === '$tf_telemetry_complete', 'completion must be last')
assert(events.every(event => event.$tf.sdk_version === SDK_VERSION), 'runtime and package versions must match')
assert(requests.every(request => request.init.keepalive === undefined), 'server delivery must not depend on keepalive')

const browser = createBrowser({
  gameId: 'example-game', writeKey: 'test-only-never-transmitted', autoTick: false, fetch: send, closeOnPageHide: false,
  url: 'https://game.example/?tf_recording_uuid=example-recording'
})
browser.track('browser_event')
assert((await browser.close()).status === 'flushed', 'browser adapter must drain')
const browserEvent = requests.flatMap(request => JSON.parse(request.init.body).events).find(event => event.$name === 'browser_event')
assert(browserEvent.$tf.os === 'Web', 'browser metadata must be preserved')
console.log('Package smoke checks passed')
