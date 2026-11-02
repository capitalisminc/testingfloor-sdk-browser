import { Client, newUuid } from './client.ts'
import type { ClientOptions, Transport } from './client.ts'
import type { Recording } from './recording.ts'
import { RECORDING_STATE_POLL_MS, RECORDING_STATE_URL, RecordingState } from './recording-state.ts'

/** The fragment Testing Floor adds to a game URL: #testing-floor=<JSON handoff>. */
const FRAGMENT = 'testing-floor='
const HANDOFF_KEY = 'testingfloor.handoff'
const PROFILE_KEY = 'testingfloor.profile_id'
const INSTALLATION_KEY = 'testingfloor.installation_id'
const TICK_MS = 100

export interface BrowserOptions extends Omit<ClientOptions, 'transport' | 'recordingSource' | 'clockMs'> {
  /** The game's engine and version, such as "Phaser 3.80.1". Left out when not given. */
  engine?: string
  /** Read the recording handoff from this URL instead of the page's. */
  url?: string
  /** Testing Floor's recording-state endpoint. */
  recordingStateUrl?: string
}

interface Environment {
  location?: { href: string }
  history?: { replaceState (data: unknown, unused: string, url?: string): void }
  sessionStorage?: Storage
  localStorage?: Storage
  navigator?: { language?: string, sendBeacon?: (url: string, data: BodyInit) => boolean, webdriver?: boolean }
  innerWidth?: number
  innerHeight?: number
  addEventListener?: (type: string, listener: () => void) => void
  setInterval?: (handler: () => void, ms: number) => unknown
  fetch?: typeof fetch
}

/**
 * Starts Testing Floor in a browser game: reads the recording handoff from the
 * page URL, keeps player IDs in local storage, sends with fetch, ticks ten times
 * a second, and completes the session when the page is hidden for good.
 */
export function createTestingFloor (options: BrowserOptions, environment: Environment = globalThis as Environment): Client {
  const page = options.url ?? environment.location?.href ?? ''
  const handoff = readHandoff(page, environment)
  const state = new RecordingState(handoff, options.writeKey ?? '', options.recordingStateUrl ?? RECORDING_STATE_URL, environment.fetch?.bind(environment))
  const client = new Client({
    os: 'Web',
    locale: languageTag(environment.navigator?.language ?? ''),
    isAutomation: environment.navigator?.webdriver === true,
    userId: storedId(environment.localStorage, PROFILE_KEY),
    deviceId: storedId(environment.localStorage, INSTALLATION_KEY),
    ...options,
    transport: fetchTransport(options.endpoint ?? 'https://dataentry.testingfloor.com', environment),
    recordingSource: now => state.source(now),
    recordingStore: state.store
  })
  const now = (): number => globalThis.performance?.now() / 1000 || Date.now() / 1000
  client.screenSize = environment.innerWidth && environment.innerHeight ? { width: environment.innerWidth, height: environment.innerHeight } : null
  client.start(now())
  if (handoff) {
    void state.poll(Date.now())
    environment.setInterval?.(() => { void state.poll(Date.now()) }, RECORDING_STATE_POLL_MS)
  }
  environment.setInterval?.(() => {
    if (environment.innerWidth && environment.innerHeight) client.screenSize = { width: environment.innerWidth, height: environment.innerHeight }
    client.tick(now())
  }, TICK_MS)
  // pagehide is the last event a page reliably gets, including on mobile.
  environment.addEventListener?.('pagehide', () => {
    client.shutdown()
    beaconRemaining(client, options.endpoint ?? 'https://dataentry.testingfloor.com', environment)
  })
  return client
}

/**
 * The recording handoff for this page: the #testing-floor= fragment, the
 * tf_recording_uuid query parameter the desktop app adds, or the handoff an
 * earlier load of this tab saved. The fragment is removed from the address bar
 * and kept in session storage, so a reload keeps the recording.
 */
export function readHandoff (url: string, environment: Environment = globalThis as Environment): string | null {
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

/**
 * Sends as text/plain, which browsers send across origins without a preflight.
 * A response the page cannot read counts as a network failure, so the batch is
 * retried with the same event IDs.
 */
export function fetchTransport (endpoint: string, environment: Environment = globalThis as Environment): Transport {
  const url = `${endpoint.trim().replace(/\/+$/, '')}/v1/batch`
  return (body, done) => {
    const send = environment.fetch
    if (!send) {
      done(0)
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    send(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, keepalive: body.length < 60_000, signal: controller.signal })
      .then(response => done(response.status), () => done(0))
      .finally(() => clearTimeout(timeout))
  }
}

/** After shutdown, hands what is still queued to sendBeacon, which outlives the page. */
function beaconRemaining (client: Client, endpoint: string, environment: Environment): void {
  const beacon = environment.navigator?.sendBeacon?.bind(environment.navigator)
  if (!beacon) return
  const url = `${endpoint.trim().replace(/\/+$/, '')}/v1/batch`
  const original = client.transport
  client.transport = (body, done) => done(beacon(url, new Blob([body], { type: 'text/plain;charset=UTF-8' })) ? 200 : 0)
  for (let attempt = 0; attempt < 20 && client.pendingCount() > 0; attempt++) client.flush()
  client.transport = original
}

export type { Recording }
