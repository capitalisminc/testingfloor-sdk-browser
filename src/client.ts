import { hasActiveLease, hasLiveLease } from './recording.ts'
import type { Recording } from './recording.ts'

export type Value = string | number | boolean | string[] | number[]
export type Properties = Record<string, unknown>
export interface Vector { x: number, y: number, z?: number }
/** Sends one request body and calls done(httpStatus) once; 0 means a network failure. */
export type Transport = (body: string, done: (status: number) => void) => void

/**
 * Player and camera at one moment. Positions are in the game's own units. A 2D
 * position has no z. Leave out what the game does not have.
 */
export interface Activity {
  playerPosition?: Vector
  cameraPosition?: Vector
  /** Unit vector the camera looks along. */
  cameraForward?: Vector
  /** Unit vector toward the top of the view. */
  cameraUp?: Vector
  /** The engine's own Euler angles, in degrees. */
  cameraEuler?: Vector
  /** Field of view of a perspective camera, in degrees. */
  cameraFov?: number
  /** Width of an orthographic camera's view, in world units. Sent instead of cameraFov. */
  cameraOrthoWidth?: number
  /** World point at the center of the view, such as a strategy camera's pivot. */
  cameraFocus?: Vector
  viewportSize?: { width: number, height: number }
}

/**
 * Where a recording's runs register and report, and how the SDK learns that it
 * closed. Desktop SDKs use the recording's telemetry folder; the browser SDK
 * uses Testing Floor's recording endpoint.
 */
export interface RecordingStore {
  /** The recording is ready for this run: its place exists and it has not closed. */
  isOpen (recording: Recording): boolean
  isClosed (recording: Recording): boolean
  /** Registers the run. False when it cannot; events still carry the recording. */
  register (recording: Recording, sessionId: string): boolean
  writeStatus (recording: Recording, sessionId: string, status: Record<string, unknown>): void
}

export const SDK_VERSION = '0.1.0'
const COMPLETION_RECORD = '$tf_telemetry_complete'
const STATE_RECORD = '$tf_state'
const OBJECTS_RECORD = '$tf_objects'
const EVENT_BYTES = 32768
/** Below the collector's 1 MiB request limit, with room for the envelope. */
const REQUEST_BYTES = 1048576 - 8192
const OBJECT_SAMPLES_PER_RECORD = 300
const OBJECT_RECORD_BYTES = 20480
const KEYFRAME_SECONDS = 300
const STATE_POLL_SECONDS = 1
const RECORDING_POLL_MS = 250
const STATUS_CAPABILITIES = ['recording_lease_v1', 'dynamic_recording_attachment']

export type DeliveryState = 'disabled' | 'not_configured' | 'ok' | 'network_down' | 'rejected'

interface Queued { event: Record<string, unknown>, recording: string, gameplay: boolean }
interface TrackedObject {
  kind: string
  source: () => Vector | null | undefined
  known: Vector3 | null
  sent: Vector3 | null
  state: Record<string, Value>
  sentState: Record<string, Value>
}
interface ObjectRow { id: string, kind: string, position: Vector3 | null, state: Record<string, Value>, reason: string }
type Vector3 = [number, number, number]
type Totals = Record<string, number>

/** Configuration and seams. Set before start(); the browser entry point fills engine-backed ones. */
export interface ClientOptions {
  writeKey?: string
  endpoint?: string
  enabled?: boolean
  enableInEditor?: boolean
  enableInEditorWhileRecording?: boolean
  batchMaxEvents?: number
  flushIntervalSeconds?: number
  queueMaxEvents?: number
  maxTrackedObjects?: number
  objectChecksPerSecond?: number
  objectMinDistance?: number
  movementTracking?: boolean
  appVersion?: string
  engine?: string
  os?: string
  locale?: string
  deviceModel?: string
  deviceId?: string
  userId?: string
  isEditor?: boolean
  isAutomation?: boolean
  clockMs?: () => number
  transport?: Transport
  recordingSource?: (nowMs: number) => Recording | null
  recordingStore?: RecordingStore
}

/**
 * Testing Floor's client: gameplay events, session state, tracked objects,
 * movement and recording delivery, following the shared SDK contract. Call
 * start() once, then tick() every frame with monotonic real time in seconds.
 */
export class Client {
  writeKey = ''
  endpoint = 'https://dataentry.testingfloor.com'
  enabled = true
  enableInEditor = false
  enableInEditorWhileRecording = true
  batchMaxEvents = 50
  flushIntervalSeconds = 0.25
  queueMaxEvents = 4096
  maxTrackedObjects = 256
  objectChecksPerSecond = 4
  objectMinDistance = 0.25
  movementTracking = false
  movementMinPingDistance = 0.5
  movementMinPingInterval = 0.5
  movementStartGrace = 0.05
  movementStopGrace = 0.25
  movementMinStep = 0.005
  movementMinPingRotation = 5
  movementMinStepRotation = 0.1
  movementMinPingFov = 2
  movementMinStepFov = 0.05
  movementMinPingCameraDistance = 0.5
  movementMinStepCameraDistance = 0.005
  movementMinPingOrthoWidth = 0.5
  movementMinStepOrthoWidth = 0.005

  appVersion = ''
  engine = ''
  os = ''
  locale = ''
  deviceModel = ''
  screenSize: { width: number, height: number } | null = null
  deviceId = ''
  userId = ''

  isEditor = false
  isAutomation = false
  clockMs: () => number = () => Date.now()
  transport: Transport | null = null
  recordingSource: ((nowMs: number) => Recording | null) | null = null
  recordingStore: RecordingStore | null = null

  /** Small values that describe each moment, such as the level and health. Added to every event. */
  contextProvider: (() => Properties) | null = null
  /** Values that stay true until they change. Sent as session state. */
  stateProvider: (() => Properties) | null = null
  activitySource: (() => Activity | null | undefined) | null = null
  /** Runs last over each event's merged properties and may change them. */
  eventProcessor: ((properties: Properties) => Properties | void) | null = null

  playSessionId = ''
  droppedEvents = 0
  deliveryState: DeliveryState = 'disabled'

  #listeners: Array<(recording: Recording | null) => void> = []
  #started = false
  #shutdown = false
  #seconds = 0
  #seq = 0
  #queue: Queued[] = []
  #inFlight: Queued[] = []
  #requestOpen = false
  #request = 0
  #flushRequested = false
  #lastFlush = 0
  #nextRetry = 0
  #retryDelay = 1
  #warned = new Set<string>()

  #recording: Recording | null = null
  #exposed: Recording | null = null
  #admitted = false
  #closed = false
  #suspended = false
  #interrupted = false
  #completed = new Set<string>()
  #recordingDrops = new Map<string, number>()
  #nextRecordingPoll = 0
  #refreshing = false

  #directState: Record<string, Value> = {}
  #sentState: Record<string, Value> = {}
  #stateKeyframeDue = true
  #stateKeyframeAt = 0
  #nextStatePoll = 0
  #lastLevel: Record<string, Value> = {}

  #objects = new Map<string, TrackedObject>()
  #removals: ObjectRow[] = []
  #kindCounts = new Map<string, number>()
  #objectsKeyframeDue = true
  #objectsKeyframeAt = 0
  #nextObjectCheck = -1
  #lastObjectTime = 0

  #baseline: Metrics | null = null
  #moving = false
  #movementStarted = 0
  #lastMovement = 0
  #lastPing = 0
  #segment: Totals = {}
  #run: Totals = {}
  #runStarted = false
  #teleports = new Map<number, { reason: string, start: Vector3 | null, started: number }>()
  #nextTeleport = 0

  constructor (options: ClientOptions = {}) {
    Object.assign(this, options)
  }

  // Lifecycle

  /** Starts the play session: resolves the recording and begins accepting events. */
  start (nowSeconds = 0): void {
    if (this.#started) return
    if (!this.playSessionId) this.playSessionId = newUuid()
    this.#seconds = nowSeconds
    this.#lastFlush = nowSeconds
    this.#stateKeyframeAt = nowSeconds
    this.#objectsKeyframeAt = nowSeconds
    if (!this.enabled || this.isAutomation) this.deliveryState = 'disabled'
    else if (!this.writeKey.trim() || !this.endpoint.trim() || !this.transport) this.deliveryState = 'not_configured'
    else this.deliveryState = 'ok'
    this.#started = true
    this.#refreshRecording(true)
  }

  /** One update with monotonic real time in seconds: recording, state, objects, movement, flush timer and retries. */
  tick (nowSeconds: number): void {
    this.#seconds = nowSeconds
    if (!this.#started) return
    this.#refreshRecording(false)
    if (this.isCollecting()) {
      const sample = this.#activity()
      if (this.movementTracking && this.#teleports.size === 0) this.#sampleMovement(nowSeconds, sample)
      if (nowSeconds - this.#stateKeyframeAt >= KEYFRAME_SECONDS) this.#stateKeyframeDue = true
      if (nowSeconds >= this.#nextStatePoll) {
        this.#nextStatePoll = nowSeconds + STATE_POLL_SECONDS
        this.#pollState(sample)
      }
      if (nowSeconds - this.#objectsKeyframeAt >= KEYFRAME_SECONDS) this.#objectsKeyframeDue = true
      if (nowSeconds >= this.#nextObjectCheck) {
        const checks = Number.isFinite(this.objectChecksPerSecond) ? this.objectChecksPerSecond : 4
        this.#nextObjectCheck = nowSeconds + 1 / Math.min(10, Math.max(1, checks))
        this.#checkObjects()
      }
    }
    if (this.#queue.length > 0 && !this.#requestOpen && nowSeconds >= this.#nextRetry && (this.#flushRequested ||
        this.#queue.length >= Math.max(1, this.batchMaxEvents) || nowSeconds - this.#lastFlush >= Math.max(0, this.flushIntervalSeconds))) {
      this.#sendNext()
    }
  }

  /** Sends queued records now, one request at a time. */
  flush (): void {
    this.#flushRequested = true
    this.#sendNext()
  }

  /** Ends the play session: sends pending state and object changes, completes an attached recording and flushes. */
  shutdown (): void {
    if (!this.#started || this.#shutdown) return
    if (this.isCollecting()) this.#sendBufferedRecords()
    this.#shutdown = true
    this.#finishRecording('play_exit')
    this.flush()
  }

  /** For a game's own automated tests: collects even in an automated run and sends to a fake transport instead of the network. */
  useTestTransport (fake: Transport): void {
    this.transport = fake
    this.isAutomation = false
    if (!this.writeKey.trim()) this.writeKey = 'test-only-never-transmitted'
    if (this.#started && !this.#shutdown && this.enabled) this.deliveryState = 'ok'
  }

  /** Whether the SDK accepts events now, including the editor recording policy. */
  isCollecting (): boolean {
    return this.#started && !this.#shutdown && this.enabled && !this.isAutomation &&
      (this.deliveryState === 'ok' || this.deliveryState === 'network_down') && this.#policyPermits()
  }

  /** Why collection is inactive, or an empty string while collecting. */
  collectionReason (): string {
    if (this.isCollecting()) return ''
    if (this.#shutdown) return 'shutdown'
    if (this.isAutomation) return 'automation'
    if (!this.enabled) return 'master_disabled'
    if (this.deliveryState === 'not_configured') return 'missing_configuration'
    if (this.deliveryState === 'rejected') return 'collector_rejected'
    return 'editor_policy_disabled'
  }

  /** The attached recording, or null while none is attached, suspended or closed. */
  getRecording (): Recording | null {
    return this.#exposed ? { ...this.#exposed } : null
  }

  /** The live handoff, even when collection is off. QR suppression follows it. */
  getRecordingHandoff (): Recording | null {
    const recording = this.#recording
    if (!recording || this.#closed) return null
    if (recording.leaseVersion !== 0 && !hasLiveLease(recording, this.clockMs())) return null
    return { ...recording }
  }

  /** Calls listener when a recording attaches, suspends, resumes, is replaced or closes. Returns a function that stops it. */
  onRecordingChanged (listener: (recording: Recording | null) => void): () => void {
    this.#listeners.push(listener)
    return () => { this.#listeners = this.#listeners.filter(other => other !== listener) }
  }

  pendingCount (): number {
    return this.#queue.length + this.#inFlight.length
  }

  #policyPermits (): boolean {
    if (!this.isEditor || this.enableInEditor) return true
    return this.enableInEditorWhileRecording && this.#exposed !== null && hasActiveLease(this.#exposed, this.clockMs())
  }

  #changed (recording: Recording | null): void {
    for (const listener of this.#listeners) {
      try {
        listener(recording ? { ...recording } : null)
      } catch (error) {
        this.#warnOnce('listener', `Testing Floor recording listener threw: ${String(error)}`)
      }
    }
  }

  // Recording

  #refreshRecording (force: boolean): void {
    if (this.#shutdown || this.#refreshing) return
    this.#refreshing = true
    try {
      const now = this.clockMs()
      const current = this.#recording
      const leaseRanOut = current !== null && !this.#closed && !this.#suspended && current.leaseVersion !== 0 && !hasActiveLease(current, now)
      const poll = force || now >= this.#nextRecordingPoll || leaseRanOut
      let candidate: Recording | null = null
      if (poll) {
        this.#nextRecordingPoll = now + RECORDING_POLL_MS
        candidate = this.recordingSource ? this.recordingSource(now) : null
        if (candidate && this.#completed.has(candidate.recordingUuid)) candidate = null
        if (candidate && this.#recording && !this.#closed && candidate.recordingUuid === this.#recording.recordingUuid) this.#recording = candidate
      }
      this.#checkRecordingClosed()
      if (!poll) return
      const recording = this.#recording
      if (candidate && (!recording || this.#closed || candidate.recordingUuid !== recording.recordingUuid)) {
        if (recording && !this.#closed) {
          this.#interrupted = true
          if (this.isCollecting()) this.#sendBufferedRecords()
          this.#finishRecording('recording_replaced')
        }
        this.#attach(candidate)
      } else if (recording && !this.#closed && recording.leaseVersion !== 0) {
        if (!hasActiveLease(recording, now)) {
          if (!this.#suspended) {
            this.#suspended = true
            this.#interrupted = true
            this.#exposed = null
            this.resetMovement()
            this.#writeStatus('suspended', 'lease_expired')
            this.#changed(null)
          }
        } else if (this.#suspended) {
          this.#suspended = false
          this.#exposed = { ...recording }
          this.#resetBaselines()
          this.#writeStatus('attached', 'none')
          this.#changed(this.#exposed)
          this.#sendKeyframes()
        } else {
          this.#exposed = { ...recording }
        }
      }
    } finally {
      this.#refreshing = false
    }
  }

  #attach (recording: Recording): void {
    this.#recording = recording
    this.#closed = false
    this.#suspended = false
    this.#interrupted = false
    this.#admitted = false
    this.#exposed = null
    const store = this.recordingStore
    if (recording.telemetryDirectory && store && !store.isOpen(recording)) {
      // Testing Floor closed this recording, or never prepared it: admit nothing.
      this.#closed = true
      this.#completed.add(recording.recordingUuid)
      return
    }
    this.#admitted = true
    if (recording.telemetryDirectory && store && !store.register(recording, this.playSessionId)) {
      this.#warnOnce('registration', 'Testing Floor could not register this run with the recording; events still carry the recording.')
    }
    if (recording.leaseVersion !== 0 && !hasActiveLease(recording, this.clockMs())) {
      this.#suspended = true
      this.#interrupted = true
      this.#writeStatus('suspended', 'lease_expired')
      return
    }
    this.#exposed = { ...recording }
    this.#resetBaselines()
    this.#writeStatus('attached', 'none')
    this.#changed(this.#exposed)
    this.#sendKeyframes()
  }

  #checkRecordingClosed (): void {
    const recording = this.#recording
    if (!recording || this.#closed || !recording.telemetryDirectory || !this.recordingStore?.isClosed(recording)) return
    if (recording.leaseVersion !== 0 && !hasActiveLease(recording, this.clockMs())) this.#interrupted = true
    if (this.isCollecting()) this.#sendBufferedRecords()
    this.#finishRecording('closed')
  }

  #finishRecording (reason: string): void {
    const recording = this.#recording
    if (!recording || this.#closed) return
    this.#closed = true
    const wasExposed = this.#exposed !== null
    this.#exposed = null
    this.#completed.add(recording.recordingUuid)
    this.resetMovement()
    this.#writeStatus('closed', reason)
    if (wasExposed) this.#changed(null)
    if (this.#admitted) {
      // The completion marker bypasses the gameplay queue's capacity.
      this.#enqueue(COMPLETION_RECORD, { interrupted: this.#interrupted }, false, true, recording, this.clockMs())
      this.#flushRequested = true
    }
  }

  #writeStatus (status: string, reason: string): void {
    const recording = this.#recording
    if (!recording || !recording.telemetryDirectory || !this.recordingStore) return
    try {
      this.recordingStore.writeStatus(recording, this.playSessionId, {
        recording_uuid: recording.recordingUuid,
        session_id: this.playSessionId,
        engine: this.engine,
        sdk_version: SDK_VERSION,
        state: status,
        reason,
        interrupted: this.#interrupted,
        capabilities: STATUS_CAPABILITIES,
        updated_at_unix_ms: this.clockMs()
      })
    } catch (error) {
      this.#warnOnce('status', `Testing Floor could not report the run's status: ${String(error)}`)
    }
  }

  #resetBaselines (): void {
    this.#stateKeyframeDue = true
    this.#objectsKeyframeDue = true
    this.resetMovement()
  }

  #sendKeyframes (): void {
    if (!this.isCollecting()) return
    this.#pollState(this.#activity())
    this.#checkObjects()
  }

  /** Sends state and object changes that would wait for the next check, before a completion marker. */
  #sendBufferedRecords (): void {
    this.#pollState(this.#activity())
    this.#checkObjects()
  }

  // Events

  /**
   * Queues a gameplay event. Returns false when it was not queued: while not
   * collecting, for an empty name, or for a name beginning with $tf_, which the
   * SDK's own records use.
   */
  track (name: string, properties: Properties = {}): boolean {
    if (name.toLowerCase().startsWith('$tf_')) {
      this.#warnOnce(`name:${name}`, `Testing Floor refused the event name ${name}: names beginning with $tf_ are reserved for its own records.`)
      if (this.isCollecting()) this.droppedEvents += 1
      return false
    }
    if (!this.isCollecting() || !name.trim()) return false
    const sample = this.#activity()
    this.#pollState(sample)
    let values: Properties = {}
    merge(values, this.#properties(this.contextProvider))
    merge(values, activityProperties(sample))
    merge(values, properties)
    if (this.eventProcessor) {
      try {
        const processed = this.eventProcessor(values)
        if (processed && typeof processed === 'object') {
          values = {}
          merge(values, processed)
        } else {
          const cleaned: Properties = {}
          merge(cleaned, values)
          values = cleaned
        }
      } catch (error) {
        this.#warnOnce('processor', `Testing Floor event processor threw: ${String(error)}`)
      }
    }
    this.#lastLevel = {}
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith('game_level.')) this.#lastLevel[key] = value as Value
    }
    return this.#enqueue(name, values, false, false, this.#exposed, this.clockMs())
  }

  /** Sets one session-state value, overriding the state provider's value for the key. */
  setState (key: string, value: Value): void {
    if (key && supported(value)) this.#directState[key] = normalized(value)
  }

  /** Removes a value set with setState. A key no source supplies any more is sent as null. */
  clearState (key: string): void {
    delete this.#directState[key]
  }

  #enqueue (name: string, properties: Properties, keyframe: boolean, control: boolean, recording: Recording | null, timeMs: number): boolean {
    const uuid = recording?.recordingUuid ?? ''
    const gameplay = name !== COMPLETION_RECORD
    if (!control && this.pendingCount() >= Math.max(1, this.queueMaxEvents)) {
      this.#noteDropped(1, uuid ? 1 : 0, uuid)
      return false
    }
    const event: Record<string, unknown> = structuredClone(properties)
    event.$id = newUuid()
    event.$name = name
    event.$time = isoTime(timeMs)
    event.$schema = 2
    event.$session_id = this.playSessionId
    if (this.deviceId) event.$device_id = this.deviceId
    if (this.userId) event.$user_id = this.userId
    const context = this.#recordContext()
    context.seq = this.#seq + 1
    if (keyframe) context.keyframe = true
    if (recording) {
      context.recording_uuid = recording.recordingUuid
      if (recording.playtestId > 0) context.playtest_id = recording.playtestId
    }
    event.$tf = context
    if (utf8Length(JSON.stringify(event)) > EVENT_BYTES) {
      this.#noteDropped(1, uuid && gameplay ? 1 : 0, uuid)
      return false
    }
    this.#seq += 1
    this.#queue.push({ event, recording: uuid, gameplay })
    return true
  }

  #recordContext (): Record<string, unknown> {
    const context: Record<string, unknown> = { sdk_version: SDK_VERSION, editor: this.isEditor }
    for (const [key, value] of [['engine', this.engine], ['os', this.os], ['locale', this.locale], ['app_version', this.appVersion], ['device_model', this.deviceModel]]) {
      if (value) context[key] = value
    }
    const size = this.screenSize
    if (size && size.width > 0 && size.height > 0) {
      context.screen_width = Math.round(size.width)
      context.screen_height = Math.round(size.height)
    }
    return context
  }

  #noteDropped (count: number, recordingCount: number, uuid: string): void {
    if (recordingCount > 0 && uuid) this.#recordingDrops.set(uuid, (this.#recordingDrops.get(uuid) ?? 0) + recordingCount)
    if (count > 0) {
      this.droppedEvents += count
      // Keyframes let a reader recover from any lost record.
      this.#stateKeyframeDue = true
      this.#objectsKeyframeDue = true
    }
  }

  #countLost (items: Queued[]): void {
    for (const item of items) this.#noteDropped(1, item.gameplay && item.recording ? 1 : 0, item.recording)
  }

  // Delivery

  #sendNext (): void {
    if (this.#requestOpen || this.#queue.length === 0 || this.#seconds < this.#nextRetry || !this.transport) return
    if (this.deliveryState !== 'ok' && this.deliveryState !== 'network_down') return
    const batch: Queued[] = []
    const first = this.#queue[0]
    if (first.event.$name === COMPLETION_RECORD) {
      first.event.dropped_events = this.#recordingDrops.get(first.recording) ?? 0
      batch.push(this.#queue.shift() as Queued)
    } else {
      let bytes = 64 + this.writeKey.length
      while (this.#queue.length > 0 && batch.length < Math.min(2000, Math.max(1, this.batchMaxEvents))) {
        const next = this.#queue[0]
        if (next.event.$name === COMPLETION_RECORD || next.recording !== first.recording) break
        const size = utf8Length(JSON.stringify(next.event)) + 1
        if (batch.length > 0 && bytes + size > REQUEST_BYTES) break
        bytes += size
        batch.push(this.#queue.shift() as Queued)
      }
    }
    this.#inFlight = batch
    this.#requestOpen = true
    this.#lastFlush = this.#seconds
    const request = ++this.#request
    const body = JSON.stringify({ $write_key: this.writeKey, $sent_at: isoTime(this.clockMs()), events: batch.map(item => item.event) })
    this.transport(body, status => this.#completeSend(request, status))
  }

  #completeSend (request: number, status: number): void {
    if (request !== this.#request || !this.#requestOpen) return
    this.#requestOpen = false
    const batch = this.#inFlight
    this.#inFlight = []
    if (status >= 200 && status < 300) {
      this.deliveryState = 'ok'
      this.#retryDelay = 1
      this.#nextRetry = 0
      this.#flushRequested = this.#queue.length > 0
    } else if (status === 401 || status === 403) {
      this.deliveryState = 'rejected'
      this.#warnOnce('rejected', 'Testing Floor rejected the write key. Collection stops for this play session.')
      this.#countLost(batch)
      this.#countLost(this.#queue)
      this.#queue = []
    } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
      this.deliveryState = 'ok'
      this.#retryDelay = 1
      this.#nextRetry = 0
      this.#countLost(batch)
      this.#flushRequested = this.#queue.length > 0
    } else {
      this.deliveryState = 'network_down'
      this.#queue = batch.concat(this.#queue)
      this.#nextRetry = this.#seconds + this.#retryDelay
      this.#retryDelay = Math.min(30, this.#retryDelay * 2)
    }
  }

  // Session state

  #pollState (sample: Activity): void {
    if (!this.isCollecting()) return
    const current: Record<string, Value> = {}
    const viewport = sample.viewportSize
    if (viewport && viewport.width > 0 && viewport.height > 0) {
      current['viewport.width'] = Math.round(viewport.width)
      current['viewport.height'] = Math.round(viewport.height)
    }
    if (isNumber(sample.cameraOrthoWidth)) {
      current['camera.projection'] = 'orthographic'
    } else if (isNumber(sample.cameraFov)) {
      current['camera.projection'] = 'perspective'
      current['camera.fov_axis'] = 'vertical'
    }
    for (const [key, value] of Object.entries(this.#properties(this.stateProvider))) {
      if (validKey(key) && supported(value)) current[key] = normalized(value as Value)
    }
    Object.assign(current, this.#directState)
    const keyframe = this.#stateKeyframeDue
    const changes: Record<string, Value | null> = {}
    if (keyframe) {
      Object.assign(changes, current)
    } else {
      for (const [key, value] of Object.entries(current)) {
        if (!(key in this.#sentState) || !same(this.#sentState[key], value)) changes[key] = value
      }
      for (const key of Object.keys(this.#sentState)) {
        if (!(key in current)) changes[key] = null
      }
    }
    if (Object.keys(changes).length === 0) return
    if (this.#enqueue(STATE_RECORD, changes, keyframe, false, this.#exposed, this.clockMs())) {
      this.#sentState = current
      if (keyframe) {
        this.#stateKeyframeDue = false
        this.#stateKeyframeAt = this.#seconds
      }
    }
  }

  // Tracked objects

  /**
   * Tracks an object's path. `position` returns its position, or null once it is
   * gone. Without an id the SDK assigns kind#n. Returns the id, or an empty
   * string when collection is disabled or the limit is reached.
   */
  trackObject (kind: string, position: () => Vector | null | undefined, id = ''): string {
    if (!this.#started || !this.enabled || this.isAutomation || this.deliveryState === 'not_configured' || !kind) return ''
    if (!id) {
      const count = (this.#kindCounts.get(kind) ?? 0) + 1
      this.#kindCounts.set(kind, count)
      id = `${kind}#${count}`
    }
    if (this.#objects.has(id)) return id
    if (this.#objects.size >= Math.max(0, this.maxTrackedObjects)) {
      this.#warnOnce('objects', `Testing Floor is already tracking ${this.maxTrackedObjects} objects; further objects are ignored.`)
      return ''
    }
    this.#objects.set(id, { kind, source: position, known: null, sent: null, state: {}, sentState: {} })
    return id
  }

  /** Sets a scalar state value for a tracked object. Only changed values are sent. */
  setObjectState (id: string, key: string, value: string | number | boolean): void {
    const object = this.#objects.get(id)
    if (object && key && (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) {
      object.state[key] = value
    }
  }

  /** Sends the object's final position with a reason, such as destroyed or disabled. */
  removeObject (id: string, reason = 'removed'): void {
    const object = this.#objects.get(id)
    if (!object) return
    this.#objects.delete(id)
    if (!this.isCollecting()) return
    const final = vector3(safeCall(object.source)) ?? object.known
    this.#removals.push({ id, kind: object.kind, position: final, state: { ...object.state }, reason: reason || 'removed' })
  }

  get trackedObjectCount (): number {
    return this.#objects.size
  }

  #checkObjects (): void {
    if (!this.isCollecting()) return
    const keyframe = this.#objectsKeyframeDue
    const rows: ObjectRow[] = [...this.#removals]
    for (const [id, object] of this.#objects) {
      const point = vector3(safeCall(object.source))
      if (point === null) {
        this.#objects.delete(id)
        rows.push({ id, kind: object.kind, position: object.known, state: {}, reason: 'gone' })
        continue
      }
      object.known = point
      const row: ObjectRow = { id, kind: object.kind, position: null, state: {}, reason: '' }
      if (keyframe || object.sent === null || distance(point, object.sent) >= this.objectMinDistance) row.position = point
      for (const [key, value] of Object.entries(object.state)) {
        if (keyframe || !(key in object.sentState) || object.sentState[key] !== value) row.state[key] = value
      }
      if (row.position || Object.keys(row.state).length > 0) rows.push(row)
    }
    if (rows.length === 0) {
      this.#objectsKeyframeDue = false
      return
    }
    const time = Math.max(this.clockMs(), this.#lastObjectTime + 1)
    this.#lastObjectTime = time
    let allQueued = true
    let start = 0
    while (start < rows.length) {
      const group: ObjectRow[] = []
      let samples = 0
      let bytes = 0
      while (start < rows.length) {
        const row = rows[start]
        const rowSamples = row.position ? 1 : 0
        const rowBytes = 48 + row.id.length * 2 + row.kind.length + JSON.stringify(row.state).length * 2
        if (group.length > 0 && (samples + rowSamples > OBJECT_SAMPLES_PER_RECORD || bytes + rowBytes > OBJECT_RECORD_BYTES)) break
        group.push(row)
        samples += rowSamples
        bytes += rowBytes
        start++
      }
      if (this.#enqueue(OBJECTS_RECORD, this.#objectRecord(group), keyframe, false, this.#exposed, time)) {
        for (const row of group) {
          const object = this.#objects.get(row.id)
          if (object) {
            if (row.position) object.sent = row.position
            Object.assign(object.sentState, row.state)
          } else {
            this.#removals = this.#removals.filter(removal => removal !== row)
          }
        }
      } else {
        allQueued = false
      }
    }
    if (allQueued && keyframe) {
      this.#objectsKeyframeDue = false
      this.#objectsKeyframeAt = this.#seconds
    }
  }

  #objectRecord (group: ObjectRow[]): Properties {
    const columns: Record<string, unknown[]> = {
      'sample.id': [], 'sample.kind': [], 'sample.x': [], 'sample.y': [], 'sample.z': [],
      'removed.id': [], 'removed.reason': [], 'state.id': [], 'state.key': [], 'state.value': []
    }
    for (const row of group) {
      if (row.position) {
        columns['sample.id'].push(row.id)
        columns['sample.kind'].push(row.kind)
        columns['sample.x'].push(round(row.position[0]))
        columns['sample.y'].push(round(row.position[1]))
        columns['sample.z'].push(round(row.position[2]))
      }
      if (row.reason) {
        columns['removed.id'].push(row.id)
        columns['removed.reason'].push(row.reason)
      }
      for (const [key, value] of Object.entries(row.state)) {
        columns['state.id'].push(row.id)
        columns['state.key'].push(key)
        columns['state.value'].push(value)
      }
    }
    const record: Properties = {}
    for (const [key, values] of Object.entries(columns)) {
      if (values.length > 0) record[key] = values
    }
    return Object.assign(record, this.#lastLevel)
  }

  // Movement and teleports

  /** Starts a new movement baseline, such as after loading a save. */
  resetMovement (): void {
    this.#baseline = null
    this.#moving = false
    this.#runStarted = false
    this.#segment = {}
    this.#run = {}
  }

  /** Begins a teleport. Movement sampling stops until endTeleport or cancelTeleport. */
  beginTeleport (reason = ''): number {
    const token = ++this.#nextTeleport
    this.#teleports.set(token, { reason, start: vector3(this.#activity().playerPosition), started: this.#seconds })
    return token
  }

  /** Ends a teleport, sending player_teleported from where it began to where the player is now. */
  endTeleport (token: number): void {
    const teleport = this.#teleports.get(token)
    if (!teleport) return
    this.#teleports.delete(token)
    const finish = vector3(this.#activity().playerPosition)
    if (teleport.start && finish) this.#teleported(teleport.start, finish, teleport.reason, this.#seconds - teleport.started)
    else this.resetMovement()
  }

  /** Abandons a teleport without an event, resetting the movement baseline. */
  cancelTeleport (token: number): void {
    this.#teleports.delete(token)
    this.resetMovement()
  }

  /** Sends player_teleported for a jump that already happened, so paths break at it. */
  recordTeleport (start: Vector, finish: Vector, reason = '', durationSeconds = 0): void {
    const from = vector3(start)
    const to = vector3(finish)
    this.resetMovement()
    if (from && to) this.#teleported(from, to, reason, durationSeconds)
  }

  #teleported (from: Vector3, to: Vector3, reason: string, duration: number): void {
    this.resetMovement()
    const properties: Properties = {
      ...vectorProperties('teleport.start.position', from),
      ...vectorProperties('teleport.end.position', to),
      'teleport.kind': 'teleport',
      'teleport.distance': distance(from, to),
      'teleport.duration': Math.max(0, duration)
    }
    if (reason) properties['teleport.reason'] = reason
    this.track('player_teleported', properties)
  }

  #sampleMovement (now: number, sample: Activity): void {
    const metrics = movementMetrics(sample)
    if (!metrics) {
      this.resetMovement()
      return
    }
    const baseline = this.#baseline
    if (!baseline) {
      this.#baseline = metrics
      this.#lastPing = now
      return
    }
    const step: Totals = {
      distance: metrics.player && baseline.player ? distance(metrics.player, baseline.player) : 0,
      rotation_degrees: metrics.forward && baseline.forward ? angleDegrees(metrics.forward, baseline.forward) : 0,
      fov_delta: metrics.fov !== undefined && baseline.fov !== undefined ? Math.abs(metrics.fov - baseline.fov) : 0,
      camera_distance: metrics.camera && baseline.camera ? distance(metrics.camera, baseline.camera) : 0,
      ortho_width_delta: metrics.ortho !== undefined && baseline.ortho !== undefined ? Math.abs(metrics.ortho - baseline.ortho) : 0
    }
    const minimum: Totals = {
      distance: this.movementMinStep,
      rotation_degrees: this.movementMinStepRotation,
      fov_delta: this.movementMinStepFov,
      camera_distance: this.movementMinStepCameraDistance,
      ortho_width_delta: this.movementMinStepOrthoWidth
    }
    let moved = false
    for (const key of Object.keys(step)) {
      if (step[key] > 0 && step[key] >= minimum[key]) moved = true
      else step[key] = 0
    }
    if (moved) {
      this.#baseline = metrics
      this.#lastMovement = now
      if (!this.#moving) {
        this.#moving = true
        this.#runStarted = false
        this.#movementStarted = now
        this.#lastPing = now
        this.#segment = {}
        this.#run = {}
      }
      add(this.#segment, step)
      add(this.#run, step)
      if (!this.#runStarted && now - this.#movementStarted >= this.movementStartGrace) {
        this.#runStarted = true
        this.#emitMovement('start', {}, 0)
      }
    }
    if (this.#moving && now - this.#lastMovement >= this.movementStopGrace) {
      if (this.#runStarted) this.#emitMovement('stop', this.#run, now - this.#movementStarted)
      this.#moving = false
      this.#runStarted = false
      this.#segment = {}
      this.#run = {}
    } else if (this.#moving && this.#runStarted && now - this.#lastPing >= this.movementMinPingInterval && (
      (this.#segment.distance ?? 0) >= this.movementMinPingDistance ||
      (this.#segment.rotation_degrees ?? 0) >= this.movementMinPingRotation ||
      (this.#segment.fov_delta ?? 0) >= this.movementMinPingFov ||
      (this.#segment.camera_distance ?? 0) >= this.movementMinPingCameraDistance ||
      (this.#segment.ortho_width_delta ?? 0) >= this.movementMinPingOrthoWidth)) {
      this.#emitMovement('ping', this.#segment, now - this.#lastPing)
      this.#segment = {}
      this.#lastPing = now
    }
  }

  #emitMovement (reason: string, totals: Totals, duration: number): void {
    const properties: Properties = { 'movement.reason': reason, 'movement.duration': Math.max(0, duration) }
    for (const key of ['distance', 'rotation_degrees', 'fov_delta', 'camera_distance', 'ortho_width_delta']) {
      if ((totals[key] ?? 0) > 0) properties[`movement.${key}`] = totals[key]
    }
    this.track('player_moved', properties)
  }

  // Values

  #activity (): Activity {
    if (!this.activitySource) return {}
    try {
      return this.activitySource() ?? {}
    } catch (error) {
      this.#warnOnce('activity', `Testing Floor activity source threw: ${String(error)}`)
      return {}
    }
  }

  #properties (source: (() => Properties) | null): Properties {
    if (!source) return {}
    try {
      const value = source()
      return value && typeof value === 'object' ? value : {}
    } catch (error) {
      this.#warnOnce('provider', `Testing Floor provider threw: ${String(error)}`)
      return {}
    }
  }

  #warnOnce (key: string, message: string): void {
    if (this.#warned.has(key)) return
    this.#warned.add(key)
    console.warn(message)
  }
}

interface Metrics { player?: Vector3, camera?: Vector3, forward?: Vector3, fov?: number, ortho?: number }

function movementMetrics (sample: Activity): Metrics | null {
  const metrics: Metrics = {}
  const player = vector3(sample.playerPosition)
  if (player) metrics.player = player
  const camera = vector3(sample.cameraPosition)
  if (camera) metrics.camera = camera
  const forward = vector3(sample.cameraForward)
  if (forward) metrics.forward = forward
  if (isNumber(sample.cameraOrthoWidth)) metrics.ortho = sample.cameraOrthoWidth
  else if (isNumber(sample.cameraFov)) metrics.fov = sample.cameraFov
  return Object.keys(metrics).length > 0 ? metrics : null
}

/** Position fields for an event, such as vectorProperties('target.position', position). */
export function vectorProperties (prefix: string, value: Vector | Vector3 | null | undefined): Properties {
  const point = Array.isArray(value) ? (value.every(Number.isFinite) ? value : null) : vector3(value)
  if (!point) return {}
  return { [`${prefix}.x`]: point[0], [`${prefix}.y`]: point[1], [`${prefix}.z`]: point[2] }
}

function activityProperties (sample: Activity): Properties {
  const properties: Properties = {
    ...vectorProperties('player.position', sample.playerPosition),
    ...vectorProperties('camera.position', sample.cameraPosition),
    ...vectorProperties('camera.forward', sample.cameraForward),
    ...vectorProperties('camera.up', sample.cameraUp),
    ...vectorProperties('camera.euler', sample.cameraEuler)
  }
  if (isNumber(sample.cameraOrthoWidth)) properties['camera.ortho_width'] = sample.cameraOrthoWidth
  else if (isNumber(sample.cameraFov)) properties['camera.fov'] = sample.cameraFov
  Object.assign(properties, vectorProperties('camera.focus', sample.cameraFocus))
  return properties
}

/** Copies supported values; drops nulls, empty keys, keys beginning with $, and other types. */
function merge (into: Properties, values: Properties): void {
  for (const [key, value] of Object.entries(values)) {
    if (validKey(key) && supported(value)) into[key] = normalized(value as Value)
  }
}

function validKey (key: string): boolean {
  return key !== '' && !key.startsWith('$')
}

function supported (value: unknown): boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    return value.every(item => typeof item === 'string') || value.every(item => Number.isSafeInteger(item))
  }
  return false
}

function normalized (value: Value): Value {
  return Array.isArray(value) ? (value.slice() as Value) : value
}

function same (a: Value, b: Value): boolean {
  return Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((item, index) => item === b[index]) : a === b
}

function isNumber (value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function vector3 (value: unknown): Vector3 | null {
  if (!value || typeof value !== 'object') return null
  const { x, y, z } = value as Vector
  const third = z ?? 0
  return isNumber(x) && isNumber(y) && isNumber(third) ? [x, y, third] : null
}

function safeCall<T> (source: () => T): T | null {
  try {
    return source()
  } catch {
    return null
  }
}

function distance (a: Vector3, b: Vector3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function angleDegrees (a: Vector3, b: Vector3): number {
  const lengths = Math.hypot(...a) * Math.hypot(...b)
  if (lengths === 0) return 0
  const cosine = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / lengths
  return Math.acos(Math.min(1, Math.max(-1, cosine))) * 180 / Math.PI
}

function add (totals: Totals, step: Totals): void {
  for (const [key, value] of Object.entries(step)) totals[key] = (totals[key] ?? 0) + value
}

function round (value: number): number {
  return Math.round(value * 100) / 100
}

function utf8Length (text: string): number {
  return new TextEncoder().encode(text).length
}

export function newUuid (): string {
  return globalThis.crypto.randomUUID()
}

/** An ISO 8601 UTC time with exactly three fractional digits and a Z suffix. */
export function isoTime (unixMs: number): string {
  return new Date(unixMs).toISOString()
}
