import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchTransport } from '../src/transport.ts'

test('browser keepalive uses UTF-8 bytes and is absent from server requests', async () => {
  const requests: Array<{ keepalive?: boolean }> = []
  const environment = { fetch: async (_url: string, init: { keepalive?: boolean }) => { requests.push(init); return new Response('{}') } }
  for (const [body, keepalive] of [['hello', true], ['é'.repeat(31_000), true], ['hello', false]] as const) {
    await new Promise<void>(resolve => fetchTransport('https://collector.invalid', environment, keepalive)(body, () => resolve()))
  }
  assert.deepEqual(requests.map(request => request.keepalive), [true, undefined, undefined])
})

test('synchronous fetch failures and cancellation finish a request once', async () => {
  const statuses: number[] = []
  fetchTransport('https://collector.invalid', { fetch: () => { throw new Error('example network failure') } })('{}', status => statuses.push(status))
  let respond: (response: Response) => void = () => {}
  const transport = fetchTransport('https://collector.invalid', { fetch: async () => await new Promise<Response>(resolve => { respond = resolve }) })
  transport('{}', status => statuses.push(status))
  transport.cancel()
  respond(new Response('{}'))
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(statuses, [0, 0])
})
