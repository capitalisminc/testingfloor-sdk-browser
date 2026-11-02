# Testing Floor SDK for browser games

Send gameplay telemetry from a browser game to [Testing Floor](https://testingfloor.com) and link it to playtest recordings. It works with any engine or framework that runs in a page, such as Phaser, PlayCanvas, Three.js or a Unity WebGL page's surrounding JavaScript. It has no dependencies.

The SDK follows the shared [Testing Floor SDK contract](https://github.com/capitalisminc/testingfloor-sdk-contract), like the Unity, Unreal and Godot SDKs.

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

The handoff is kept in session storage, so reloading the tab keeps the recording. When the page is hidden for good, the SDK completes the session and hands what is still queued to `sendBeacon`.

## Delivery

Events are sent in batches of up to 50, every quarter second, one request at a time, as `text/plain` so the browser sends them across origins without a preflight. Network failures and server errors are retried with the same event IDs. At most 4,096 events wait at once. Nothing is stored on disk.

The profile ID (sent as the player ID) and the installation ID are kept in local storage. Collection is off when the page is driven by automation (`navigator.webdriver`).

## Develop

```sh
npm test
```

Tests run the shared contract scenarios in `test/contract/scenarios`, check that everything the client sends is declared in the telemetry contract, and test the browser entry point with fakes. They need Node 22.18 or later, which runs TypeScript directly. `python3 scripts/update_contract.py` refreshes the contract copy; `--check` confirms it.

## License

MIT. See [LICENSE.md](LICENSE.md).
