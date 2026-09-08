# Advanced Browser Workflows

## Files and Dialogs

Upload through an exact file input, including hidden inputs:

```json
{ "selector": "input#attachment", "filePaths": ["fixtures/sample.csv"] }
```

For a custom chooser button, use `browser_upload` with
`mode: "chooser"` and a target for that button. Paths may reference files
available to the MCP process. Do not search for or select an arbitrary input.

`browser_download { target: { ref: "e8" }, outputPath: "evidence/export.csv" }`
arms the listener before clicking, waits for completion, and saves the actual
file. It temporarily configures downloads for the selected browser context,
then restores Chromium defaults. Avoid parallel downloads in shared partitions.
Downloads may also remain in Electron's native Downloads location.

Actions opening JS dialogs return a `dialog` record with a stable ID. Answer:

```json
{ "action": "accept", "id": "<dialog-id>", "promptText": "Example" }
```

Use `browser_dialogs`. `dismiss` cancels. For future dialogs,
`{ "action": "policy", "defaultAction": "accept" }` sets automatic handling;
`defaultAction: "manual"` restores manual answers. The user may also answer
in the pane; closed native dialogs are removed from pending state.

On the tested macOS terminal-browser 0.8.0 host, native confirms auto-close
before MCP can answer them, even with a preset policy. Treat `dialog_closed`
as a runtime limitation and inspect the resulting page state; do not retry
the action or claim an answer was accepted. Electron's `window.prompt()` is
also unsupported. Use promptText only for an actual pending prompt record on
an engine supporting it.

## Static Canvas Capture

After viewport emulation, terminal-browser 0.8.x can omit a static canvas layer
even though its bitmap still exists. For this observed issue, opt in with
`repaintCanvases: true` on `browser_screenshot` or `browser_responsive`.
This refreshes standard 2D canvases with their unchanged pixel data. Inspect the
returned repainted/skipped counts and actual image. WebGL, tainted, extended-color,
and oversized canvases are skipped; the option is not a universal canvas fix.

## Network and Performance

- `browser_network { action: "har_start" }` begins metadata capture;
  `har_stop` saves a HAR file. Response bodies and replay are not included.
- `browser_network { action: "block", pattern: "**/analytics/**" }` blocks
  that URL glob on this page. Undo with `unblock` and the same pattern.
- `browser_performance { action: "metrics" }` reads timings/heap data.
  `profile_start` and `profile_stop` capture a Chrome CPU profile.
- `browser_accessibility` saves the complete axe audit and reports violations
  plus a count of checks needing manual review. A clean audit is not proof of
  complete accessibility.
- `browser_environment` supports offline, headers, geolocation, colorScheme,
  and reducedMotion for the selected page. Use `reset: true` afterward.
  Geolocation emulation does not grant native permission.
- `browser_storage` supports `local`, `session`, or `cookies` and
  `list|set|remove|clear|export`. Origin/partition sharing still applies.
  Exports may contain credentials; retain only artifacts needed for the task.

## Recording Jobs

`browser_record` always returns structured job state. Start example:

```json
{
  "action": "start",
  "maxDurationMs": 10000,
  "fps": 12,
  "showCursor": true,
  "outputPath": "evidence/checkout.webm"
}
```

Retain `recording.id`. Status and cancellation do not require a live tab:

```json
{ "action": "status", "id": "rec-<uuid>" }
```

Poll until `completed`, `failed`, or `cancelled`; inspect `phase` and
`error`. `stop` requests finalization and `cancel` aborts capture/encoding.
The worker runs independently of the MCP process, with job metadata under
`.zcode/terminal-browser/recordings/`. Resume inspection from a new MCP
process in the same workspace with `list` or the stored ID.

Optional `actions` accept the data-only `browser_act` action schema. A known
flow can fill/check/click/drag/wait in sequence; no raw code is accepted.
After actions finish, `settleMs` controls the final hold. Each target must be
grounded in the page inspected before starting the script.

Capture limits: 90 seconds, 1-30 fps, 256 MB of frames. Static pages retain real
elapsed duration. Optional viewport overrides are restored after capture.
WebM uses the bundled WebAssembly encoder; no ffmpeg installation or download
is needed. Failed or cancelled encoding retains a JSON frame manifest with JPEG
files and timestamps for recovery. Only a completed WebM is video evidence.
The completed artifact is a path, not an embedded video content block.
