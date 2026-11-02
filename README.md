# Testing Floor SDK for browser games

Send gameplay telemetry from a browser game to [Testing Floor](https://testingfloor.com) and link it to playtest recordings. It works with any engine or framework that runs in a page, such as Phaser, PlayCanvas, Three.js or a Unity WebGL page's surrounding JavaScript. It has no dependencies.

The SDK follows the shared [Testing Floor SDK contract](https://github.com/capitalisminc/testingfloor-sdk-contract), like the Unity, Unreal and Godot SDKs.

## Install

```sh
npm install @testingfloor/browser
```

Without a bundler, import it from a CDN in a module script:

```html
<script type="module">
  import { createTestingFloor } from 'https://cdn.jsdelivr.net/npm/@testingfloor/browser@0.2.0/+esm'
</script>
```

The package is ES modules with TypeScript declarations and no dependencies.

## Start

```js
import { createTestingFloor } from '@testingfloor/browser'

const testingFloor = createTestingFloor({
  gameId: 'example-game',       // stable for this game, including after key rotation
  writeKey: 'tf_tel_…',          // the game's telemetry key
  engine: 'Phaser 3.80.1',       // optional, sent as $tf.engine
  appVersion: '1.4.0'
})

testingFloor.track('level_started', { 'game_level.id': 'forest' })
```

`gameId` is required. Use a stable identifier for the game, distinct from other games on the same origin; do not use a write key, build version, or level URL. Profile IDs, installation IDs, and recording handoffs are stored per game, so rotating a write key preserves identity and another game cannot inherit a recording. An empty game ID disables collection. Earlier unscoped generated identities are not imported automatically because the SDK cannot know which game owned them; IDs your game supplies still take precedence.

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

From the activity source, the SDK sends `$tf_player_moved` samples up to ten times a second while the player or camera moves, so a half-second jump gets several samples. Testing Floor draws player paths and position heatmaps from them, and hides them in event lists by default. Pass `movementMinPingInterval` (in seconds) to send fewer, for example in a slow-moving game, or `movementTracking: false` to turn them off. Without an activity source, nothing is sent. `recordTeleport` keeps a respawn or level restart from counting as movement.

## Recordings

When Testing Floor opens a browser game for a recording, it adds the recording to the game's URL, and the SDK attaches every event to it:

- The desktop app adds `?tf_recording_uuid=<id>&tf_suppress_qr=<true|false>` today.
- A `#testing-floor=<JSON>` fragment with the full handoff is also read. The SDK removes it from the address bar.

The handoff is kept in session storage, so reloading the tab keeps the recording.

While a recording is attached, the SDK asks Testing Floor about every 5 seconds whether it is still open. An open recording renews a 20-second lease; if the game loses contact for longer, its events stop carrying the recording. When the recording ends, the SDK sends its completion marker. Before the first answer, the recording has a fixed 20-second startup grace lease. An unknown recording or failed poll cannot restart that grace or revive an expired live lease. Events then continue without the recording until the server confirms an active lease.

## Closing

When the page is hidden for good (`pagehide`), the SDK closes the session and hands everything still queued to `sendBeacon`, which outlives the page. A completion marker sent this way is flagged as interrupted: beacon acceptance does not prove earlier requests reached the server. Normal acknowledged delivery retains its completion guarantee. A request already open is left to finish.

A game that sends its own final events on `pagehide`, such as how a run ended, turns this off and closes the session after them:

```js
const testingFloor = createTestingFloor({ gameId: 'example-game', writeKey: 'tf_tel_…', closeOnPageHide: false })

window.addEventListener('pagehide', () => {
  testingFloor.track('run_ended', { reason: 'page_hidden' })
  testingFloor.close()
})
```

Events tracked after `close()` are refused.

## Delivery

Events are sent in batches of up to 50, every quarter second, one request at a time, as `text/plain` so the browser sends them across origins without a preflight. Network failures and server errors are retried with the same event IDs. At most 4,096 events wait at once. Nothing is stored on disk.

The profile ID (sent as the player ID) and the installation ID are kept in local storage. Collection is off when the page is driven by automation (`navigator.webdriver`).

## Supported API

The package entrypoint exposes the game client, its options and gameplay types, the SDK version, and vector-property helpers. The game client includes recording identity and change notifications. Protocol parsers, polling state, custom transports, and the lower-level client are available only from `@testingfloor/browser/internal`; that entrypoint is intentionally unstable.

## Develop

```sh
npm test
```

Tests run the shared contract scenarios in `test/contract/scenarios`, check that everything the client sends is declared in the telemetry contract, and test the browser entry point with fakes. They need Node 22.18 or later, which runs TypeScript directly. `npm run typecheck` checks types and `npm run build` writes the package to `dist/`. `python3 scripts/update_contract.py` refreshes the contract copy; `--check` confirms it.

Pushing a `v<version>` tag that matches `package.json` publishes to npm from GitHub Actions, with provenance.

## License

MIT. See [LICENSE.md](LICENSE.md).


## Build identity and collection mode

Pass `buildId` for the immutable artifact identity also used by build upload and
map publication. It is separate from the readable `appVersion`. Changing the game
artifact requires a new ID; the SDK sends the configured value without guessing
one from a version label. Native coordinates and always-collect behavior remain the
defaults.

Set `collectionMode: 'recording_only'` to collect only with an active recording
handoff. Discovery continues while collection is dormant, so a later recording
can attach. Pause or lease expiry suspends collection; a fresh active lease
resumes it. Browser startup confirmation is bounded by the grace window above.

## Coordinate conversion

Supply one optional `coordinateTransform` instead of repeating conversion in an
event processor and each tracked-object source:

```ts
const tf = createTestingFloor({
  gameId: 'example-game',
  writeKey: 'your-game-write-key',
  buildId: 'example-artifact',
  coordinateTransform: { axes: [1, -2, 3], scale: 2, offset: { x: 10, y: 20, z: 30 } }
})
```

The signed axes choose native X/Y/Z as 1/2/3. Each axis appears once, and scale
must be positive and finite. Points include offset; directions omit offset and
scale. Player/camera event fields, focus points, teleport endpoints and distances,
movement lengths, orthographic widths and tracked objects use that same transform.
Sampling thresholds stay in native units; output lengths use the transformed
coordinate unit. Object quantization happens in native space before conversion.
Raw Euler metadata is omitted with a transform; provide forward/up for orientation.
Arbitrary game properties and object state are preserved. The event processor runs
after conversion; remove an old conversion hook when enabling this option.

Automatic movement and teleport helpers now emit `$tf_player_moved` and
`$tf_player_teleported`. Those names are reserved; game-owned names remain available,
and historical unprefixed SDK samples remain readable by the server.
