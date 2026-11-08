import { BrowserClient } from './browser-internal.ts'
import type { BrowserOptions, BrowserTestingFloorClient } from './browser-internal.ts'

/** Starts one browser session with game-scoped IDs and URL recording handoffs. */
export function createTestingFloor (options: BrowserOptions): BrowserTestingFloorClient {
  return new BrowserClient(options)
}

export { SDK_VERSION, vectorProperties } from './client.ts'
export type { BrowserOptions, BrowserTestingFloorClient as TestingFloorClient } from './browser-internal.ts'
export type { FlushOptions, FlushResult, RecordingInfo } from './runtime.ts'
export type { Activity, CollectionMode, DeliveryState, Properties, Value, Vector } from './client.ts'
export type { CoordinateTransform, SignedAxis } from './coordinates.ts'
