import { Client } from './client.ts'
import type { ClientOptions, DeliveryState } from './client.ts'
import { RECORDING_STATE_POLL_MS, RecordingState } from './recording-state.ts'
import { fetchTransport } from './transport.ts'
import type { Fetch, FetchTransport } from './transport.ts'

export interface SdkOptions extends ClientOptions {
  /** An existing play session ID. Otherwise a new UUID is generated for this client. */
  sessionId?: string
  /** Run background updates. Set false in request-scoped or manually ticked environments. */
  autoTick?: boolean
  /** A recording UUID, supplied explicitly outside a browser. */
  recordingUuid?: string
  /** A full JSON recording handoff. Takes precedence over recordingUuid. */
  recordingHandoff?: string
  recordingStateUrl?: string
  fetch?: Fetch
}

export interface FlushOptions {
  /** Maximum time to wait, including retries. Defaults to 10 seconds. */
  timeoutMs?: number
}

export interface FlushResult {
  status: 'flushed' | 'timeout' | 'dropped' | 'disabled' | 'not_configured' | 'rejected'
  pendingEvents: number
  /** Total events dropped during this session, including before this flush. */
  droppedEvents: number
  deliveryState: DeliveryState
}

/** Scheduling seam used by the browser adapter and embedders. */
export interface RuntimeEnvironment {
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

const scheduling: RuntimeEnvironment = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>)
}

/** One player/session, with HTTP delivery and an awaitable lifecycle. */
export class TestingFloorClient extends Client {
  #timers: unknown[] = []
  #environment: RuntimeEnvironment
  #state: RecordingState | null
  #closing: Promise<FlushResult> | null = null
  #disposed = false

  constructor (options: SdkOptions = {}, environment: RuntimeEnvironment = scheduling) {
    if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('Testing Floor requires crypto.randomUUID().')
    const send = options.fetch ?? globalThis.fetch?.bind(globalThis)
    if (!options.transport && (!send || typeof AbortController === 'undefined')) {
      throw new Error('Testing Floor requires fetch and AbortController, or a custom transport.')
    }
    const { autoTick = true, sessionId, recordingUuid, recordingHandoff, recordingStateUrl, fetch: _fetch, ...clientOptions } = options
    const handoff = recordingHandoff ?? (recordingUuid ? JSON.stringify({ recording_uuid: recordingUuid }) : null)
    const state = handoff && !options.recordingSource
      ? new RecordingState(handoff, options.writeKey ?? '', recordingStateUrl, send)
      : null
    super({
      ...clientOptions,
      transport: options.transport ?? fetchTransport(options.endpoint ?? 'https://dataentry.testingfloor.com', { fetch: send }),
      ...(state ? { recordingSource: now => state.source(now), recordingStore: options.recordingStore ?? state.store } : {})
    })
    this.#environment = environment
    this.#state = state
    this.playSessionId = sessionId ?? ''
    this.start(monotonicSeconds())
    if (autoTick) {
      this.#schedule(() => this.tick(monotonicSeconds()), 100)
      if (state) {
        void state.poll(this.clockMs())
        this.#schedule(() => { void state.poll(this.clockMs()) }, RECORDING_STATE_POLL_MS)
      }
    }
  }

  #schedule (callback: () => void, ms: number): void {
    if (!this.#environment.setInterval || !this.#environment.clearInterval) return
    const timer = this.#environment.setInterval(callback, ms)
    // Background telemetry must not keep a Node.js process alive. Explicit flushes do.
    ;(timer as { unref?: () => void } | null)?.unref?.()
    this.#timers.push(timer)
  }

  /** Polls recording state explicitly when automatic scheduling is disabled. */
  async refreshRecording (): Promise<void> {
    if (!this.#closing) {
      await this.#state?.poll(this.clockMs())
      if (!this.#closing) this.tick(monotonicSeconds())
    }
  }

  override tick (nowSeconds: number): void {
    if (!this.#disposed) super.tick(nowSeconds)
  }

  /** Drains batches and retries until acknowledged, rejected, or the deadline is reached. */
  override flush (options: FlushOptions = {}): Promise<FlushResult> {
    if (this.#closing) return this.#closing
    return this.#drain(options)
  }

  #drain (options: FlushOptions): Promise<FlushResult> {
    const timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('timeoutMs must be a finite, non-negative number.')
    const deadline = monotonicSeconds() + timeoutMs / 1000
    super.flush()
    return new Promise(resolve => {
      const check = (): void => {
        const now = monotonicSeconds()
        if (!this.#disposed) this.tick(now)
        const pendingEvents = this.pendingCount()
        const status = this.deliveryState === 'disabled' || this.deliveryState === 'not_configured' || this.deliveryState === 'rejected'
          ? this.deliveryState
          : pendingEvents === 0 ? (this.droppedEvents > 0 ? 'dropped' : 'flushed')
            : now >= deadline || this.#disposed ? 'timeout' : null
        if (status) {
          resolve({ status, pendingEvents, droppedEvents: this.droppedEvents, deliveryState: this.deliveryState })
        } else {
          setTimeout(check, Math.min(10, Math.max(1, (deadline - now) * 1000)))
        }
      }
      check()
    })
  }

  /** Ends this session, releases background work, and drains within the deadline. Safe to call twice. */
  close (options: FlushOptions = {}): Promise<FlushResult> {
    if (this.#closing) return this.#closing
    // Validate before ending the session so a caller can correct an invalid timeout.
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new RangeError('timeoutMs must be a finite, non-negative number.')
    }
    for (const timer of this.#timers) this.#environment.clearInterval?.(timer)
    this.#timers = []
    this.#state?.dispose()
    this.onClose()
    super.shutdown()
    this.#closing = this.#drain(options).then(result => {
      this.#disposed = true
      this.cancelTransport()
      return result
    })
    return this.#closing
  }

  /** Alias for close for hosts that use a shutdown lifecycle hook. */
  override shutdown (): Promise<FlushResult> { return this.close() }

  /** Adapter cleanup, called once before the final drain. */
  protected onClose (): void {}

  protected cancelTransport (): void {
    ;(this.transport as Partial<FetchTransport> | null)?.cancel?.()
  }
}

function monotonicSeconds (): number { return (globalThis.performance?.now() ?? Date.now()) / 1000 }

/** Starts one Testing Floor session in Node.js, browsers, Bun, Deno, or a worker. */
export function createTestingFloor (options: SdkOptions = {}): TestingFloorClient {
  return new TestingFloorClient(options)
}
