import type { Transport } from './client.ts'

/** The subset of fetch used by the SDK. Native fetch satisfies this interface. */
export type Fetch = (url: string, init: {
  method: string
  headers: Record<string, string>
  body: string
  keepalive?: boolean
}) => Promise<{
  status: number
  ok: boolean
  json (): Promise<unknown>
  body?: { cancel (): Promise<void> } | null
}>

export interface TransportEnvironment { fetch?: Fetch }
export interface FetchTransport extends Transport { cancel (): void }

/** A bounded HTTP transport. Browser callers can enable page-lifetime keepalive. */
export function fetchTransport (endpoint: string, environment: TransportEnvironment = globalThis, keepalive = false): FetchTransport {
  const url = `${endpoint.trim().replace(/\/+$/, '')}/v1/batch`
  const requests = new Set<() => void>()
  const transport: FetchTransport = (body, done) => {
    const send = environment.fetch
    if (!send) { done(0); return }
    const controller = new AbortController()
    let finished = false
    const finish = (status: number): void => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      requests.delete(cancel)
      done(status)
    }
    const cancel = (): void => { controller.abort(); finish(0) }
    const timeout = setTimeout(cancel, 10_000)
    requests.add(cancel)
    const request = {
      method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      signal: controller.signal,
      ...(keepalive && new TextEncoder().encode(body).length < 60_000 ? { keepalive: true } : {})
    }
    try {
      void send(url, request).then(async response => {
        // Release the response stream so server connection pools can reuse the socket.
        try { await response.body?.cancel() } catch {}
        finish(response.status)
      }, () => finish(0))
    } catch {
      finish(0)
    }
  }
  transport.cancel = () => { for (const cancel of requests) cancel() }
  return transport
}
