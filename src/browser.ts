import { newUuid } from './client.ts'
import { TestingFloorClient } from './runtime.ts'
import type { SdkOptions, RuntimeEnvironment } from './runtime.ts'
import { fetchTransport } from './transport.ts'
import type { Fetch } from './transport.ts'
import type { Recording } from './recording.ts'

/** The fragment Testing Floor adds to a game URL: #testing-floor=<JSON handoff>. */
const FRAGMENT = 'testing-floor='
const HANDOFF_KEY = 'testingfloor.handoff'
const PROFILE_KEY = 'testingfloor.profile_id'
const INSTALLATION_KEY = 'testingfloor.installation_id'

export interface BrowserOptions extends SdkOptions {
  /** Read the recording handoff from this URL instead of the page's. */
  url?: string
  /** Send remaining events with sendBeacon on pagehide. Defaults to true. */
  closeOnPageHide?: boolean
}

export interface BrowserEnvironment extends RuntimeEnvironment {
  location?: { href: string }
  history?: { replaceState (data: unknown, unused: string, url?: string): void }
  sessionStorage?: Storage
  localStorage?: Storage
  navigator?: { language?: string, sendBeacon?: (url: string, data: BodyInit) => boolean, webdriver?: boolean }
  innerWidth?: number
  innerHeight?: number
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
  fetch?: Fetch
}

/** Browser identity, recording handoff, viewport, and pagehide delivery. */
export class BrowserClient extends TestingFloorClient {
  #environment: BrowserEnvironment
  #pagehide: (() => void) | null = null
  #unload: ((body: string) => boolean) | null
  #unloading = false

  constructor (options: BrowserOptions, environment: BrowserEnvironment = globalThis as unknown as BrowserEnvironment) {
    const endpoint = options.endpoint ?? 'https://dataentry.testingfloor.com'
    const { url, closeOnPageHide = true, ...clientOptions } = options
    const send = options.fetch ?? environment.fetch?.bind(environment)
    super({
      os: 'Web',
      locale: languageTag(environment.navigator?.language ?? ''),
      isAutomation: environment.navigator?.webdriver === true,
      userId: storedId(environment.localStorage, PROFILE_KEY),
      deviceId: storedId(environment.localStorage, INSTALLATION_KEY),
      ...clientOptions,
      fetch: send,
      recordingHandoff: options.recordingHandoff ?? (options.recordingUuid ? undefined : readHandoff(url ?? environment.location?.href ?? '', environment) ?? undefined),
      transport: options.transport ?? fetchTransport(endpoint, { fetch: send }, true)
    }, environment)
    this.#environment = environment
    this.#unload = beaconSender(endpoint, environment)
    this.#screenSize()
    if (closeOnPageHide) {
      this.#pagehide = () => this.closeForPage()
      environment.addEventListener?.('pagehide', this.#pagehide)
    }
  }

  override tick (nowSeconds: number): void {
    this.#screenSize()
    super.tick(nowSeconds)
  }

  #screenSize (): void {
    const environment = this.#environment
    this.screenSize = environment.innerWidth && environment.innerHeight ? { width: environment.innerWidth, height: environment.innerHeight } : null
  }

  /** Best-effort unload delivery. Beacon acceptance does not acknowledge delivery. */
  closeForPage (): void {
    this.#unloading = true
    void this.close({ timeoutMs: 0 })
    if (this.#unload) this.sendRemaining(this.#unload)
  }

  protected override onClose (): void {
    if (this.#pagehide) this.#environment.removeEventListener?.('pagehide', this.#pagehide)
    this.#pagehide = null
  }

  protected override cancelTransport (): void {
    if (!this.#unloading) super.cancelTransport()
  }
}

/** Starts one browser session with persistent IDs and URL recording handoffs. */
export function createTestingFloor (options: BrowserOptions, environment: BrowserEnvironment = globalThis as unknown as BrowserEnvironment): BrowserClient {
  return new BrowserClient(options, environment)
}

/**
 * The recording handoff for this page: the #testing-floor= fragment, the
 * tf_recording_uuid query parameter the desktop app adds, or the handoff an
 * earlier load of this tab saved. The fragment is removed from the address bar
 * and kept in session storage, so a reload keeps the recording.
 */
export function readHandoff (url: string, environment: BrowserEnvironment = globalThis as unknown as BrowserEnvironment): string | null {
  let handoff: string | null = null
  let parsed: URL | null = null
  try {
    parsed = new URL(url)
  } catch {
    parsed = null
  }
  if (parsed && parsed.hash.startsWith(`#${FRAGMENT}`)) {
    try {
      handoff = decodeURIComponent(parsed.hash.slice(FRAGMENT.length + 1))
    } catch {
      handoff = null
    }
    try {
      environment.history?.replaceState(null, '', parsed.pathname + parsed.search)
    } catch {
      // A sandboxed page may not change its URL.
    }
  } else if (parsed?.searchParams.get('tf_recording_uuid')) {
    handoff = JSON.stringify({
      recording_uuid: parsed.searchParams.get('tf_recording_uuid'),
      suppress_qr: parsed.searchParams.get('tf_suppress_qr') !== 'false'
    })
  }
  try {
    if (handoff) environment.sessionStorage?.setItem(HANDOFF_KEY, handoff)
    else handoff = environment.sessionStorage?.getItem(HANDOFF_KEY) ?? null
  } catch {
    // Storage can be unavailable, such as in a private window.
  }
  return handoff
}

/** A BCP 47 tag such as en-US from a browser language, or an empty string. */
export function languageTag (language: string): string {
  try {
    return language ? new Intl.Locale(language).toString() : ''
  } catch {
    return ''
  }
}

function storedId (storage: Storage | undefined, key: string): string {
  try {
    const existing = storage?.getItem(key)
    if (existing) return existing
    const id = newUuid()
    storage?.setItem(key, id)
    return storage ? id : ''
  } catch {
    return ''
  }
}

/** Sends one request body with sendBeacon, which outlives the page, or null where there is none. */
function beaconSender (endpoint: string, environment: BrowserEnvironment): ((body: string) => boolean) | null {
  const beacon = environment.navigator?.sendBeacon?.bind(environment.navigator)
  if (!beacon) return null
  const url = `${endpoint.trim().replace(/\/+$/, '')}/v1/batch`
  return body => beacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))
}

export type { Recording }

export { fetchTransport } from './transport.ts'
export type { FlushOptions, FlushResult } from './runtime.ts'
