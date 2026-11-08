import type { RecordingStore } from './client.ts'
import { parseRecording } from './recording.ts'
import type { Recording } from './recording.ts'
import type { Fetch } from './transport.ts'

export const RECORDING_STATE_URL = 'https://api.testingfloor.com/telemetry/recording_state'
export const RECORDING_STATE_POLL_MS = 5000

interface Answer { closed: boolean, leaseExpiresAtUnixMs: number }

/**
 * A JavaScript session's view of its attached recording. Testing
 * Floor's recording-state endpoint stands in for the lease file and closed.json
 * a desktop SDK reads: poll() asks it, source() gives the client the handoff
 * with the latest lease, and store answers whether the recording closed.
 * Until the first answer, and for a recording the endpoint does not know, the
 * handoff carries no lease, so events keep the recording.
 */
export class RecordingState {
  readonly handoff: string | null
  readonly writeKey: string
  readonly url: string
  readonly send: Fetch | undefined
  readonly store: RecordingStore
  #answer: Answer | null = null
  #polling = false
  #disposed = false
  #cancel: (() => void) | null = null

  constructor (handoff: string | null, writeKey: string, url: string = RECORDING_STATE_URL, send: Fetch | undefined = globalThis.fetch?.bind(globalThis)) {
    this.handoff = handoff
    this.writeKey = writeKey
    this.url = url
    this.send = send
    this.store = {
      isOpen: () => this.#answer?.closed !== true,
      isClosed: () => this.#answer?.closed === true,
      // HTTP runs are found by the recording UUID on their events, without status files.
      register: () => true,
      writeStatus: () => {}
    }
  }

  /** Stops polling and cancels an outstanding request. */
  dispose (): void {
    this.#disposed = true
    this.#cancel?.()
  }

  /** The handoff for the client, with the endpoint's latest lease. */
  source (nowMs: number): Recording | null {
    const recording = parseRecording(this.handoff, nowMs)
    if (!recording || !this.#answer) return recording
    return {
      ...recording,
      telemetryDirectory: this.url,
      leaseVersion: this.#answer.closed ? recording.leaseVersion : 1,
      telemetryRequested: true,
      leaseExpiresAtUnixMs: this.#answer.closed ? recording.leaseExpiresAtUnixMs : this.#answer.leaseExpiresAtUnixMs
    }
  }

  /** Asks the endpoint once. A failure keeps the last answer, so its lease runs out. */
  async poll (nowMs: number): Promise<void> {
    const recording = parseRecording(this.handoff, nowMs)
    if (!recording || !this.send || !this.writeKey || this.#polling || this.#disposed || this.#answer?.closed) return
    this.#polling = true
    const controller = new AbortController()
    const cancelled = new Promise<null>(resolve => {
      this.#cancel = () => { controller.abort(); resolve(null) }
    })
    const timeout = setTimeout(() => this.#cancel?.(), 10_000)
    try {
      const request = {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ $write_key: this.writeKey, recording_uuid: recording.recordingUuid }),
        signal: controller.signal
      }
      const response = await Promise.race([this.send(this.url, request), cancelled])
      if (!response || this.#disposed) return
      if (response.status === 404) {
        await Promise.race([response.body?.cancel(), cancelled])
        if (!this.#disposed) this.#answer = null
        return
      }
      if (!response.ok) {
        await Promise.race([response.body?.cancel(), cancelled])
        return
      }
      const body: unknown = await Promise.race([response.json(), cancelled])
      if (this.#disposed || !body || typeof body !== 'object') return
      const { closed, lease_expires_at_unix_ms: lease } = body as Record<string, unknown>
      if (closed === true) this.#answer = { closed: true, leaseExpiresAtUnixMs: 0 }
      else if (closed === false && typeof lease === 'number' && Number.isFinite(lease)) this.#answer = { closed: false, leaseExpiresAtUnixMs: lease }
    } catch {
      // Keep the last answer; an unreachable endpoint lets the lease run out.
    } finally {
      clearTimeout(timeout)
      this.#cancel = null
      this.#polling = false
    }
  }
}
