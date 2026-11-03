// Protocol adapters are intentionally unstable and are not the supported game API.
export { BrowserClient, createTestingFloorForEnvironment, fetchTransport, languageTag, readHandoff } from './browser.ts'
export { Client } from './client.ts'
export type { ClientOptions, RecordingStore, Transport } from './client.ts'
export { hasActiveLease, hasLiveLease, parseRecording, resolveRecording } from './recording.ts'
export { RECORDING_STATE_URL, RecordingState } from './recording-state.ts'
