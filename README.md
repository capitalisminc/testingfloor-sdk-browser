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
  import { createTestingFloor } from 'https://cdn.jsdelivr.net/npm/@testingfloor/browser@0.1.1/+esm'
</script>
```

The package is ES modules with TypeScript declarations and no dependencies.

## Start

```js
import { createTestingFloor } from '@testingfloor/browser'

const testingFloor = createTestingFloor({
  writeKey: 'tf_tel_…',          // the game's telemetry key
  engine: 'Phaser 3.80.1',       // optional, sent as $tf.engine
  appVersion: '1.4.0'
})

testingFloor.track('level_started', { 'game_level.id': 'forest' })
```

Property values can be strings, finite numbers, booleans, and arrays of strings or of integers. Other values, keys beginning with `$`, and event names beginning with `$tf_` are refused, as in every Testing Floor SDK. `track` returns `false` when the event was not queued.

```js
testingFloor.contextProvider = () => ({ 'game_level.id': level.id, 'player.health': player.health })
testingFloor.stateProvider = () => ({ 'settings.difficulty': difficulty })
testingFloor.activitySource = () => ({
  playerPosition: { x: player.x, y: player.y },
  cameraPosition: { x: camera.scrollX, y: camera.scrollY },
  cameraOrthoWidth: camera.width / camera.zoom,
  viewportSize: { width: window.innerWidth, height: window.innerHeight }
})

const id = testingFloor.trackObject('enemy', () => (enemy.active ? { x: enemy.x, y: enemy.y } : null))
testingFloor.setObjectState(id, 'health', enemy.health)
testingFloor.recordTeleport(from, to, 'respawn')
```

Positions are in the game's own units. A 2D position has no `z`. A tracked object whose position source returns `null` is removed as `gone`.

## Recordings

When Testing Floor opens a browser game for a recording, it adds the recording to the game's URL, and the SDK attaches every event to it:

- The desktop app adds `?tf_recording_uuid=<id>&tf_suppress_qr=<true|false>` today.
- A `#testing-floor=<JSON>` fragment with the full handoff is also read. The SDK removes it from the address bar.

The handoff is kept in session storage, so reloading the tab keeps the recording.

While a recording is attached, the SDK asks Testing Floor about every 5 seconds whether it is still open. An open recording renews a 20-second lease; if the game loses contact for longer, its events stop carrying the recording. When the recording ends, the SDK sends its completion marker. Until the first answer, events carry the recording without a lease.

## Closing

When the page is hidden for good (`pagehide`), the SDK closes the session: it completes the recording and hands everything still queued to `sendBeacon`, which outlives the page. A request already open is left to finish.

A game that sends its own final events on `pagehide`, such as how a run ended, turns this off and closes the session after them:

```js
const testingFloor = createTestingFloor({ writeKey: 'tf_tel_…', closeOnPageHide: false })

window.addEventListener('pagehide', () => {
  testingFloor.track('run_ended', { reason: 'page_hidden' })
  testingFloor.close()
})
```

Events tracked after `close()` are refused.

## Delivery

Events are sent in batches of up to 50, every quarter second, one request at a time, as `text/plain` so the browser sends them across origins without a preflight. Network failures and server errors are retried with the same event IDs. At most 4,096 events wait at once. Nothing is stored on disk.

The profile ID (sent as the player ID) and the installation ID are kept in local storage. Collection is off when the page is driven by automation (`navigator.webdriver`).

## Develop

```sh
npm test
```

Tests run the shared contract scenarios in `test/contract/scenarios`, check that everything the client sends is declared in the telemetry contract, and test the browser entry point with fakes. They need Node 22.18 or later, which runs TypeScript directly. `npm run typecheck` checks types and `npm run build` writes the package to `dist/`. `python3 scripts/update_contract.py` refreshes the contract copy; `--check` confirms it.

Pushing a `v<version>` tag that matches `package.json` publishes to npm from GitHub Actions, with provenance.

## License

MIT. See [LICENSE.md](LICENSE.md).
