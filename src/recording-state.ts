import type { RecordingStore } from './client.ts'
import { parseRecording } from './recording.ts'
import type { Recording } from './recording.ts'

export const RECORDING_STATE_URL = 'https://api.testingfloor.com/telemetry/recording_state'
export const RECORDING_STATE_POLL_MS = 5000
const STARTUP_GRACE_MS = 20_000

interface Answer { closed: boolean, leaseExpiresAtUnixMs: number, telemetryRequested?: boolean }

/**
 * A browser game's view of the desktop recording it was opened for. Testing
 * Floor's recording-state endpoint stands in for the lease file and closed.json
 * a desktop SDK reads: poll() asks it, source() gives the client the handoff
 * with the latest lease, and store answers whether the recording closed.
 * Until confirmation, a fixed startup grace lease bounds the association.
 * Unknown answers never restart that grace or revive an expired live lease.
 */
export class RecordingState {
  readonly handoff: string | null
  readonly writeKey: string
  readonly url: string
  readonly send: typeof fetch | undefined
  readonly store: RecordingStore
  #answer: Answer | null = null
  #polling = false
  #startedAt: number | null = null

  constructor (handoff: string | null, writeKey: string, url: string = RECORDING_STATE_URL, send: typeof fetch | undefined = globalThis.fetch?.bind(globalThis)) {
    this.handoff = handoff
    this.writeKey = writeKey
    this.url = url
    this.send = send
    this.store = {
      isOpen: () => this.#answer?.closed !== true,
      isClosed: () => this.#answer?.closed === true,
      // A browser run does not register or write a status file; consumers find it by the recording UUID on its events.
      register: () => true,
      writeStatus: () => {}
    }
  }

  /** The handoff for the client, with the endpoint's latest lease. */
  source (nowMs: number): Recording | null {
    const recording = parseRecording(this.handoff, nowMs)
    if (!recording) return null
    this.#startedAt ??= nowMs
    const lease = this.#answer ?? { closed: false, leaseExpiresAtUnixMs: this.#startedAt + STARTUP_GRACE_MS }
    return {
      ...recording,
      telemetryDirectory: this.url,
      leaseVersion: lease.closed ? recording.leaseVersion : 1,
      telemetryRequested: lease.telemetryRequested ?? true,
      leaseExpiresAtUnixMs: lease.closed ? recording.leaseExpiresAtUnixMs : lease.leaseExpiresAtUnixMs
    }
  }

  /** Asks the endpoint once. A failure keeps the last answer, so its lease runs out. */
  async poll (nowMs: number): Promise<void> {
    const recording = parseRecording(this.handoff, nowMs)
    if (!recording || !this.send || !this.writeKey || this.#polling || this.#answer?.closed) return
    this.#polling = true
    try {
      const response = await this.send(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ $write_key: this.writeKey, recording_uuid: recording.recordingUuid })
      })
      if (response.status === 404) return
      if (!response.ok) return
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object') return
      const { closed, state, lease_expires_at_unix_ms: lease } = body as Record<string, unknown>
      if (closed === true) this.#answer = { closed: true, leaseExpiresAtUnixMs: 0 }
      else if (closed === false && typeof lease === 'number' && Number.isFinite(lease)) this.#answer = { closed: false, leaseExpiresAtUnixMs: lease, telemetryRequested: typeof state === 'string' ? state === 'recording' : true }
    } catch {
      // Keep the last answer; an unreachable endpoint lets the lease run out.
    } finally {
      this.#polling = false
    }
  }
}

