# Testing Floor JavaScript SDK

Send gameplay telemetry to [Testing Floor](https://testingfloor.com) and link it to playtest recordings from a browser game, server backend, script, or worker. The package includes TypeScript declarations and has no runtime dependencies.

The SDK follows the shared [Testing Floor SDK contract](https://github.com/capitalisminc/testingfloor-sdk-contract), like the Unity, Unreal and Godot SDKs.

## Install

```sh
npm install @testingfloor/js
```

Both ES modules and CommonJS are supported:

```js
import { createTestingFloor } from '@testingfloor/js'
// CommonJS: const { createTestingFloor } = require('@testingfloor/js')
```

The main entry point uses standard JavaScript and HTTP APIs. Importing either entry point starts no timers, storage access, or network requests.

| Environment | Usage and checks |
| --- | --- |
| Node.js 22.18+ | ESM and CommonJS; CI runs Node 22.18, 24, and 26. |
| Bun 1+ | ESM package smoke checks in CI. |
| Deno 2+ | ESM package smoke checks in CI. After publication, it can also be imported as `npm:@testingfloor/js`. |
| Modern browsers | Use `/browser` for browser setup; Chromium package smoke checks in CI. |
| Web Workers | Use the main entry point with explicit flushing; Chromium worker smoke checks in CI. |
| Other fetch-based workers and serverless hosts | Use manual scheduling and await delivery within the host's request lifetime. Host-specific integrations are not included. |

The runtime needs `crypto.randomUUID`, `structuredClone`, `TextEncoder`, timers, and native `fetch`/`AbortController`. A custom `transport` can supply delivery in place of fetch. The main entry point's TypeScript declarations do not require DOM types.

## Node.js and backends

```js
import { createTestingFloor } from '@testingfloor/js'

const testingFloor = createTestingFloor({
  writeKey: 'your-telemetry-write-key',
  userId: 'example-player',
  appVersion: '1.2.3'
})

testingFloor.track('level_started', { 'game_level.id': 'forest' })

// When this player's session ends:
const delivery = await testingFloor.close({ timeoutMs: 2000 })
```

Each client represents one player/play session and owns its identity, state, tracked objects, and recording association. Keep a client for the lifetime of that session, and give concurrent players separate clients. `sessionId` can supply an existing play-session UUID; otherwise the SDK generates one. `userId` and `deviceId` are optional explicit IDs outside browsers. No anonymous player or installation ID is persisted by the main entry point.

Long-running clients update and send automatically. Background timers do not keep a Node.js process alive. Scripts should await `flush()` or `close()` before exiting; backend applications should await `close()` from their own session/shutdown hooks.

## Workers and serverless functions

Set `autoTick: false` when the host controls how long work may run. This starts no background updates or recording polls. An explicit flush still drives batch delivery and retries until its deadline.

```js
import { createTestingFloor } from '@testingfloor/js'

export async function handleRequest () {
  const testingFloor = createTestingFloor({
    writeKey: 'your-telemetry-write-key',
    userId: 'example-player',
    autoTick: false
  })
  testingFloor.track('request_completed')
  return await testingFloor.close({ timeoutMs: 2000 })
}
```

Await delivery before returning from the host's handler, or register the promise with its background-work API. Reuse an existing `sessionId` when a request belongs to an existing play session. A game with its own update loop can call `tick(performance.now() / 1000)` to drive movement, objects, and state in manual mode.

## Browsers

The browser entry point adds persistent profile/installation IDs, URL recording handoffs, viewport and language metadata, automation detection, and pagehide delivery:

```js
import { createTestingFloor } from '@testingfloor/js/browser'

const testingFloor = createTestingFloor({
  writeKey: 'your-telemetry-write-key',
  engine: 'Phaser 3.80.1',
  appVersion: '1.2.3'
})

testingFloor.track('level_started', { 'game_level.id': 'forest' })
```

Without a bundler, use a CDN module import after the package is published:

```html
<script type="module">
  import { createTestingFloor } from 'https://cdn.jsdelivr.net/npm/@testingfloor/js@0.3.0/dist/esm/browser.js'
</script>
```

Property values can be strings, finite numbers, booleans, and arrays of strings or of integers. Other values, keys beginning with `$`, and event names beginning with `$tf_` are refused, as in every Testing Floor SDK. `track` returns `false` when the event was not queued.

```js
testingFloor.contextProvider = () => ({ 'game_level.id': level.id, 'player.health': player.health })
testingFloor.stateProvider = () => ({ 'settings.difficulty': difficulty })
// Phaser's Y grows downward; Testing Floor's X/Y maps want +Y up, so Y is negated.
testingFloor.activitySource = () => ({
  playerPosition: { x: player.x, y: -player.y },
  // A 2D camera: orthographic, looking straight into the screen.
  cameraPosition: { x: camera.scrollX + camera.width / 2, y: -(camera.scrollY + camera.height / 2) },
  cameraForward: { x: 0, y: 0, z: -1 },
  cameraUp: { x: 0, y: 1, z: 0 },
  cameraOrthoWidth: camera.width / camera.zoom,
  viewportSize: { width: camera.width, height: camera.height }
})

const id = testingFloor.trackObject('enemy', () => (enemy.active ? { x: enemy.x, y: enemy.y } : null))
testingFloor.setObjectState(id, 'health', enemy.health)
testingFloor.recordTeleport(from, to, 'respawn')
```

Positions are in the game's own units. A 2D position has no `z`. A tracked object whose position source returns `null` is removed as `gone`.

Send the camera as well as the player. Testing Floor's map then draws the part of the level on screen as a rectangle that follows the camera, showing what the player could see at each moment. A 2D camera is an orthographic camera looking straight into the screen:

- `cameraPosition` is the center of the view.
- `cameraForward` points into the screen and `cameraUp` toward its top.
- `cameraOrthoWidth` is the view's width in world units, and `viewportSize` the visible area's size, which sets the rectangle's height.

If a HUD covers part of the screen, send the part of the world that stays visible.

From the activity source, the SDK sends `player_moved` samples up to ten times a second while the player or camera moves, so a half-second jump gets several samples. Testing Floor draws player paths and position heatmaps from them, and hides them in event lists by default. Pass `movementMinPingInterval` (in seconds) to send fewer, for example in a slow-moving game, or `movementTracking: false` to turn them off. Without an activity source, nothing is sent. `recordTeleport` keeps a respawn or level restart from counting as movement.

## Recordings

When Testing Floor opens a browser game for a recording, it adds the recording to the game's URL, and the SDK attaches every event to it:

- The desktop app adds `?tf_recording_uuid=<id>&tf_suppress_qr=<true|false>` today.
- A `#testing-floor=<JSON>` fragment with the full handoff is also read. The SDK removes it from the address bar.

The handoff is kept in session storage, so reloading the tab keeps the recording.

While a recording is attached, the SDK asks Testing Floor about every 5 seconds whether it is still open. An open recording renews a 20-second lease; if the game loses contact for longer, its events stop carrying the recording. When the recording ends, the SDK sends its completion marker. Until the first answer, events carry the recording without a lease.

Outside browsers, pass `recordingUuid` or a full JSON `recordingHandoff` explicitly. An explicit handoff takes precedence over a UUID and the browser URL. Recording leases and completion markers follow the same contract in every environment. With `autoTick: false`, call `await testingFloor.refreshRecording()` when the host permits a recording-state request; subsequent `tick()` calls apply that state.

## Flushing and closing

`await testingFloor.flush({ timeoutMs: 2000 })` drains queued batches without ending the session. `await testingFloor.close({ timeoutMs: 2000 })` refuses new events, sends final state and recording completion, releases background timers/listeners, and drains delivery. `shutdown()` is an alias for `close()` on the managed client. Repeated calls to `close()` return the same promise. The default deadline is 10 seconds.

Both methods resolve with `status`, `pendingEvents`, `droppedEvents`, and `deliveryState`:

| Status | Meaning |
| --- | --- |
| `flushed` | All queued events were acknowledged and this session has recorded no drops. |
| `dropped` | The queue drained, but events were dropped during this session. |
| `timeout` | Work is still pending when the deadline is reached. |
| `rejected` | The collector rejected the write key. |
| `disabled` / `not_configured` | Collection is disabled or configuration is missing. |

`droppedEvents` is cumulative for the session, including queue overflows and events refused before this flush. A timed-out flush leaves the client available for another attempt. A timed-out close stops delivery and cancels the built-in HTTP transport; its pending events remain in memory and are not persisted. Custom transports own cancellation of their own underlying requests.

When a browser page receives `pagehide`, the default handler calls `closeForPage()`: it ends collection and hands queued events to `sendBeacon`, leaving an existing keepalive request to finish. This is best-effort delivery; beacon acceptance is not a server acknowledgment. Use the awaitable `close()` for an explicit shutdown while the page is still running.

A game that sends its own final events on pagehide can take ownership of that handler:

```js
const testingFloor = createTestingFloor({ writeKey: 'your-telemetry-write-key', closeOnPageHide: false })

window.addEventListener('pagehide', () => {
  testingFloor.track('run_ended', { reason: 'page_hidden' })
  testingFloor.closeForPage()
})
```

## Delivery

Events are sent in batches of up to 50, every quarter second, one request at a time. Requests use `text/plain`, so browsers can send across origins without a preflight. Network failures and retryable responses are retried with the same event IDs. At most 4,096 events wait at once. Nothing is stored on disk.

Browser profile and installation IDs retain their existing local-storage keys. Collection is off by default when the browser is driven by automation (`navigator.webdriver`). Backend clients collect according to their explicit configuration.

## Migrating from @testingfloor/browser

- Install `@testingfloor/js` and change browser imports to `@testingfloor/js/browser`, including imports of `BrowserClient`, `readHandoff`, and `languageTag`.
- Use `@testingfloor/js` for the runtime-independent factory, low-level `Client`, and recording/transport utilities.
- Await `flush()`, `close()`, or `shutdown()` when delivery must finish before the host exits.
- Custom pagehide handlers should call `closeForPage()` to retain beacon delivery. The default handler still does this automatically.

Existing event fields, recording protocol, and browser storage keys are preserved. The new npm package needs to be created and configured for trusted publishing before its first release. Renaming the GitHub repository to `testingfloor-sdk-js` and updating the package's repository links are separate release steps; the links continue to point at the existing public repository until then. The old npm package remains available; maintainers can add a migration notice after the new package is published.

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run test:package
npx playwright install chromium
npm run test:browser
```

Tests run the shared contract scenarios and check event fields, delivery, concurrent sessions, and lifecycle cleanup. Package checks unpack the npm tarball and exercise ESM/CommonJS consumers, import isolation, process exit, and TypeScript consumers without DOM types. Bun and Deno are checked when installed locally and are installed explicitly in CI. The browser check runs the packed SDK in Chromium and a module worker. Playwright is a development-only dependency.

Development needs Node 22.18 or later to run TypeScript directly. `npm run build` writes ESM and CommonJS builds to `dist/`. `python3 scripts/update_contract.py` refreshes the contract copy; `--check` confirms it.

After npm trusted publishing is configured for the new package, a `v<version>` tag matching `package.json` publishes it from GitHub Actions with provenance.

## License

MIT. See [LICENSE.md](LICENSE.md).
