/** A recording handoff from Testing Floor, as the SDK contract describes. */
export interface Recording {
  recordingUuid: string
  /** Where the run registers and reports; for browser games, Testing Floor's recording URL. */
  telemetryDirectory: string
  /** 0 when absent. */
  playtestId: number
  suppressQr: boolean
  leaseVersion: number
  telemetryRequested: boolean
  leaseExpiresAtUnixMs: number
  editorPid: number
}

const MAX_AGE_MS = 12 * 60 * 60 * 1000
/** Testing Floor renews a 5-second lease every second, so a later expiry comes from a broken handoff. */
const MAX_LEASE_AHEAD_MS = 30_000

/**
 * The handoff in `text`, or null when it is malformed, has no recording UUID,
 * or is older than 12 hours without a live lease.
 */
export function parseRecording (text: string | null | undefined, nowMs: number): Recording | null {
  if (!text || !text.trim()) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const object = value as Record<string, unknown>
  const uuid = typeof object.recording_uuid === 'string' ? object.recording_uuid.trim() : ''
  if (!uuid) return null
  const recording: Recording = {
    recordingUuid: uuid,
    telemetryDirectory: typeof object.telemetry_directory === 'string' ? object.telemetry_directory.trim() : '',
    playtestId: Math.max(0, integer(object.playtest_id)),
    suppressQr: typeof object.suppress_qr === 'boolean' ? object.suppress_qr : true,
    leaseVersion: integer(object.lease_version),
    telemetryRequested: object.telemetry_requested === true,
    leaseExpiresAtUnixMs: integer(object.lease_expires_at_unix_ms),
    editorPid: integer(object.editor_pid)
  }
  const created = integer(object.created_at_unix_ms)
  if (created > 0 && created < nowMs - MAX_AGE_MS && !hasActiveLease(recording, nowMs)) return null
  return recording
}

/**
 * Which recording a run belongs to. A lease handoff wins over the launch argument
 * even after its lease expires, so expiry suspends the association instead of
 * reviving an older launch. Otherwise a valid launch argument wins over a sidecar
 * without a lease. With an editor process ID, a handoff naming another editor is ignored.
 */
export function resolveRecording (sidecar: string | null, launchArgument: string | null, editorPid: number, nowMs: number): Recording | null {
  const fromSidecar = forEditor(parseRecording(sidecar, nowMs), editorPid)
  if (fromSidecar && fromSidecar.leaseVersion !== 0) return fromSidecar
  return forEditor(parseRecording(launchArgument, nowMs), editorPid) ?? fromSidecar
}

/** A capture is running: lease version 1 that expires after now and no more than 30 seconds later. */
export function hasLiveLease (recording: Recording, nowMs: number): boolean {
  return recording.leaseVersion === 1 && recording.leaseExpiresAtUnixMs > nowMs &&
    recording.leaseExpiresAtUnixMs <= nowMs + MAX_LEASE_AHEAD_MS
}

/** A live lease that also requests telemetry and names where to report, as recording-only collection needs. */
export function hasActiveLease (recording: Recording, nowMs: number): boolean {
  return recording.telemetryRequested && recording.telemetryDirectory !== '' && hasLiveLease(recording, nowMs)
}

function forEditor (recording: Recording | null, editorPid: number): Recording | null {
  if (editorPid === 0 || !recording || recording.editorPid <= 0 || recording.editorPid === editorPid) return recording
  return null
}

function integer (value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0
}
