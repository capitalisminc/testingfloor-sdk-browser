const { createTestingFloor } = await import(new URL(location.href).searchParams.get('sdk'))
const bodies = []
const client = createTestingFloor({
  writeKey: 'test-only-never-transmitted', autoTick: false,
  fetch: async (_url, init) => { bodies.push(init.body); return new Response('{}') }
})
client.track('worker_event')
const result = await client.close()
postMessage({ result, events: bodies.flatMap(body => JSON.parse(body).events) })
