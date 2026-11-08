# Changelog

## 0.3.0 — Unreleased

- Renames the package to `@testingfloor/js`, with a runtime-independent main entry point for Node.js, Bun, Deno, and workers, and browser setup at `@testingfloor/js/browser`.
- Adds ESM and CommonJS builds, with main-entry TypeScript declarations that do not need DOM types.
- Adds awaitable `flush()`, `close()`, and `shutdown()` with deadlines and delivery results. Closing releases managed timers and listeners and cancels unfinished built-in HTTP requests.
- Supports explicit user/session IDs and recording handoffs outside browsers. Each client owns one play session.
- Retains browser storage keys, URL handoffs, and automatic pagehide beacon delivery. Custom pagehide handlers use `closeForPage()`; explicit `close()` now waits for HTTP delivery.

## 0.2.0 — 2026-11-02

- Movement samples (`player_moved`) are on by default and come up to ten times a second while the player moves. They used to be off, and two a second once turned on, which drew a half-second jump as a straight line. `movementMinPingInterval` is now a documented option.

## 0.1.1 — 2026-11-02

- An object tracked again under a removed object's ID sends the removal once, and its own first sample in a later check. Before, the removal was sent again with every check.
- A `gone` removal waits until its record is queued, like one from `removeObject()`, so a full queue no longer loses it.

## 0.1.0 — 2026-11-02

- First version: events, session state, tracked objects, movement and teleports, delivery with the contract's batching, retry and drop rules, and recording association, following the shared Testing Floor SDK contract and running its scenarios.
- Reads the recording handoff from the `#testing-floor=` fragment or the `tf_recording_uuid` query parameter the desktop app adds, and keeps it for reloads of the same tab.
- Asks Testing Floor's recording-state endpoint whether the recording is still open, uses its answers as the recording's lease, and sends the completion marker when the recording ends.
- Sends as `text/plain`. When the page is hidden for good, closes the session and hands everything still queued to `sendBeacon`, even while a request is open. `closeOnPageHide: false` and `close()` let a game send its own final events first.
