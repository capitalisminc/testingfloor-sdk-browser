# Changelog

## 0.1.0 — unreleased

- First version: events, session state, tracked objects, movement and teleports, delivery with the contract's batching, retry and drop rules, and recording association, following the shared Testing Floor SDK contract and running its scenarios.
- Reads the recording handoff from the `#testing-floor=` fragment or the `tf_recording_uuid` query parameter the desktop app adds, and keeps it for reloads of the same tab.
- Asks Testing Floor's recording-state endpoint whether the recording is still open, uses its answers as the recording's lease, and sends the completion marker when the recording ends.
- Sends as `text/plain`. When the page is hidden for good, closes the session and hands everything still queued to `sendBeacon`, even while a request is open. `closeOnPageHide: false` and `close()` let a game send its own final events first.
