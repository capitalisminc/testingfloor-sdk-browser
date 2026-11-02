# Changelog

## 0.1.0 — unreleased

- First version: events, session state, tracked objects, movement and teleports, delivery with the contract's batching, retry and drop rules, and recording association, following the shared Testing Floor SDK contract and running its scenarios.
- Reads the recording handoff from the `#testing-floor=` fragment or the `tf_recording_uuid` query parameter the desktop app adds, and keeps it for reloads of the same tab.
- Sends as `text/plain` and hands what is left to `sendBeacon` when the page is hidden for good.
