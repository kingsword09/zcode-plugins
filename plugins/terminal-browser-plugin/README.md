# terminal-browser-plugin

A live Chromium pane beside your ZCode CLI conversation, with direct MCP
control, visual regression evidence, network diagnostics, and durable recording
jobs. Wraps [terminal-browser](https://github.com/zenbu-labs/terminal-browser)
using Playwright over CDP. Unofficial; independent of ZCode and terminal-browser.

## What Changed in 0.6

- Exact browser/tab/target routing, including multiple panes sharing one Chromium
  endpoint and tabs with identical URLs. Ambiguous panes or locators fail clearly.
- Scoped and iframe locators, queries, checkbox state, select-by-label, real
  keyboard events, anchored scrolling, and complete drag paths with modifiers.
- `browser_act` performs one action and returns its resulting semantic snapshot.
  Results carry structured tab identity, active-tab context, and newly opened tabs.
- Element/full/clip/annotated PNGs, saved artifacts, pixel diffs, and a responsive
  viewport matrix with overflow checks and viewport restoration.
- Hidden file inputs and custom file choosers, downloads saved into the workspace,
  and JS dialog events with controls for dialogs that the host keeps pending.
- Console/error/network history, metadata HAR, axe accessibility reports,
  performance timings, CPU profiles, and page-scoped environment controls.
- Session claim/pause/resume/handoff, plus asynchronous recording
  start/status/stop/cancel. Recording jobs survive MCP process restarts.

## Compared With Desktop IAB

The desktop browser-use plugin provides a visible, interactive in-app browser.
Its desktop IAB mode is **not headless**. Its CLI fallback is a separate runtime.
This plugin uses a terminal pane rather than the desktop application's host.

| Workflow | Desktop IAB baseline | This plugin |
| --- | --- | --- |
| Visible user interaction | In-app pane with host visibility integration | Live terminal pane; no desktop host integration |
| Browser control | Session browser API through `node_repl` | Typed MCP actions with structured observations |
| Locators and CUA | Scoped/frame locators, DOM and coordinate actions | Explicit frame paths, scoped locators, queries, pointer paths |
| Uploads | Unsupported in the inspected IAB runtime | Exact input and custom chooser support |
| Visual QA | Screenshot and recording APIs | Saved PNGs, pixel diffs, responsive capture matrix |
| Diagnostics | Runtime-provided inspection | Console/network history, metadata HAR, axe, CPU profiles |
| Recording | Asynchronous WebM jobs | Durable disk-backed jobs, static-frame timing, stop/cancel, optional action scripts |

The additions focus on frontend testing and debugging. Desktop pane visibility,
host-level ambient events, and browser ownership integration are not reproduced.
Do not assume full API equivalence or that a visible browser bypasses anti-bot
checks. Keep the official plugin available for desktop IAB or its CLI fallback;
select terminal-browser explicitly when both plugins are installed.

## Requirements

- Node.js 24 or later.
- [terminal-browser](https://github.com/zenbu-labs/terminal-browser) on PATH.
  Development targets terminal-browser 0.8.x on macOS/Linux.
- A terminal supporting **both** kitty graphics and terminal-browser pane
  splitting. Check upstream's current support matrix; tmux alone does not supply
  graphics. Plain Apple Terminal is insufficient for the visible-pane workflow.

No separate FFmpeg, ffprobe, Chromium, Bun, or npm installation is needed to use
the plugin. terminal-browser supplies Chromium; the Release ZIP supplies the
JavaScript dependencies and portable WebAssembly recording codecs. Node and a
supported terminal remain required because this plugin controls terminal-browser.

Install terminal-browser using its upstream instructions:

```bash
curl -fsSL https://terminal-browser.sh/install | bash
```

Kitty requires remote control for splitting. For a persistent setup:

```conf
allow_remote_control socket-only
listen_on unix:/tmp/kitty-remote.sock
```

Restart the terminal after changing its configuration. `/tb status` reports
binary availability and observed panes; it cannot prove that graphics are
visible on a particular display.

## Install and Update

The public marketplace lists a version only after its Release ZIP has been
published and verified. Until the first release is published, use the
development marketplace below. For a published version:

```bash
zcode plugins marketplace add kingsword09/zcode-plugins
zcode plugins install terminal-browser@zcode-plugins
```

Consumers do not need Bun or a dependency install. The marketplace downloads a
versioned ZIP and verifies its SHA-256 before installation. It contains the MCP
bundles and required Playwright runtime; Chromium comes from terminal-browser.
A local checkout of the public marketplace still points at published ZIPs.

After updating:

```bash
zcode plugins marketplace update zcode-plugins
zcode plugins update terminal-browser@zcode-plugins
```

Start a **new ZCode session** to load the refreshed MCP process.
Restart other sessions still running the old browser plugin as well: older CDP
clients can automatically dismiss dialogs on tabs they did not explicitly select.

## Daily Use

```text
/tb status
/tb open localhost:3000
/tb open ./report.html
/tb ls
/tb snapshot
/tb click ref=e6
/tb fill label=Name value=Alice
/tb screenshot evidence/page.png
/tb responsive
/tb console
/tb a11y
/tb record start
/tb record status rec-<id>
/tb done
```

`browser_open` reuses a current pane by default. `direction`, `size`,
`newPane`, `profile`, or `ssh` explicitly requests a new pane. A profile is a
persistent terminal-browser partition. Passing `browserId` selects an existing
pane. Reads default to its current active tab; specify `tabId` to keep operating
on another tab. Actions normally bring that tab forward unless `focus: false`.

Examples of direct MCP arguments:

```json
{
  "browserId": "<key from browser_list>",
  "tabId": 2,
  "target": {
    "frame": ["iframe#checkout"],
    "role": "button",
    "name": "Pay",
    "exact": true,
    "within": { "selector": "form#order" }
  }
}
```

Targets come from current observations. Exactly one primary selector is allowed;
ambiguity is an error. Use `browser_frames`, `browser_inspect`, and
`browser_query` to narrow a target before acting. CUA coordinates use CSS pixels.

All outputs include JSON in `structuredContent` and a text content block.
Page results include `context.browserId`, `tabId`, `targetId`, `url`,
`userActiveTab`, `newTabs`, and an observation timestamp. Errors include a
stable code and a recovery hint. Registry refresh is deferred while a modal
dialog is pending.

## Artifacts and Recording

Screenshot, download, HAR, profile, storage, and recording outputs stay inside
the MCP process's working directory, normally the active workspace. Relative
paths are resolved there; existing files and symlink destinations are rejected.
Use a new output name for each run. Storage exports can contain credentials.

`browser_record { action: "start" }` returns a job ID immediately.
Poll `status` until `completed`, `failed`, or `cancelled`; `stop` requests
finalization and does not mean the artifact is already available. Job metadata
lives under `.zcode/terminal-browser/recordings/`. A new MCP process in the same
workspace can inspect or stop those jobs. Takes are bounded to 90 seconds and
256 MB of captured frames; encoding is bounded to 60 seconds.

Optional `actions` use the same data-only action schema as `browser_act`.
Reserve scripts for known, repeatable test flows. Normal exploratory interaction
should continue one action and one observation at a time. Static pages still
produce video with the real elapsed duration.

WebM encoding runs locally in the detached recording worker using bundled
JPEG/VP8 codecs and a WebM muxer. It uses no external encoder executable, network
download, or page-side script. Frames preserve their capture timestamps; static
frames remain visible for their full duration. Encoding is limited to 60 seconds,
16 megapixels per output frame, and a 256 MB video. It may be slower and produce
larger videos than a native interframe encoder. A cancelled or failed encoding
retains captured JPEGs and their timestamp manifest in the recording directory.

## Operational Limits

- Claims coordinate this plugin's MCP processes, not human input or other tools.
  `pause` blocks automation until `resume`; `done` releases ordinary claims
  and clears the activity indicator. Handoff claims remain until release or
  process exit. Tabs stay open.
- Diagnostics begin when a tab is first inspected. Buffers are bounded; HAR
  contains request metadata, not response bodies or replay data. Console/HAR
  buffers do not survive a process restart.
- Viewport overrides emulate page dimensions; they do not resize the terminal's
  outer window. Offline, headers, media, and URL blocks target the selected page.
  Cookies and storage are shared according to Chromium's origin/partition rules.
- terminal-browser 0.8.x offscreen rendering can lose a static canvas layer after a
  viewport change. Screenshots and responsive captures accept an explicit
  `repaintCanvases: true` workaround that refreshes standard 2D canvases using
  their unchanged pixel data. Results report repainted/skipped counts. WebGL,
  tainted, extended-color, and oversized canvases are skipped; verify their
  actual screenshots instead of assuming success.
- Download capture temporarily configures the target browser context's download
  behavior and restores Chromium's default afterward. Avoid simultaneous downloads
  in tabs sharing that context. Electron may retain its original Downloads copy.
- JavaScript evaluation has a response deadline; timing out does not roll back
  page-side effects. Native permission dialogs and OS file pickers are not a
  general desktop automation surface.
- On the verified macOS terminal-browser 0.8.0 runtime, native confirmations
  are cancelled by the host before an MCP response, including with a preset
  accept policy. Dialog events remain observable, but answering those closed
  dialogs is unsupported. Electron also does not implement `window.prompt()`.
  The generic CDP adapter can answer pending dialogs on supporting Chromium
  engines, as covered by the separate integration suite. The live verifier
  reports the host limitation as unsupported, never as a passing dialog test.
- Separate terminals and operating systems need their own visible-rendering
  verification; headless integration tests do not establish terminal support.

## Development and Verification

```bash
bun install
bun run build
bun run typecheck
bunx playwright-core install chromium
bun test
bun run package
bun run verify:package
# Full ZIP download/checksum/install verification with the local CLI checkout:
bun run verify:package --cli ../../../zcode-cli/bin/zcode.js
# Inside a supported terminal, opens one dedicated split:
node scripts/verify.mjs dist/mcp/server.js
```

Set `TB_TEST_BROWSER` to an existing compatible Chromium executable to run
integration tests without downloading an engine. Without an available executable,
the suite reports a skip. CI installs Chromium so these tests are required there.
`verify:package` requires a browser and runs all 20 integration scenarios against
the ZIP's MCP server in a temporary directory outside the checkout. With `--cli`,
it also tests rejection of an incorrect SHA-256, installs through the real CLI,
checks every installed file, and tests the installed server. Its child processes
use an isolated configuration and cache. Set `TB_KEEP_RELEASE_TEST=1` to retain
the temporary verification directory for debugging.
Packaged MCP tests provide only Node and the browser protocol fixture on PATH,
so recording tests cannot fall back to a system encoder. Chromium decodes and
seeks the resulting WebM to verify dimensions, duration, and changing pixels.

The live verifier uses a unique local fixture workspace, real MCP initialization,
the actual terminal-browser daemon, desktop/mobile PNG pixel checks, uploads,
downloads, dialogs, diagnostics, and recording across an MCP process restart.
It writes a JSON report and artifacts, leaves its created pane visible, and
does not shut down the shared daemon. Other connected clients may affect dialogs.
For a fully isolated run, launch a dedicated terminal with matching private
`XDG_RUNTIME_DIR`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`,
`TERMINAL_BROWSER_INTEROP_DIR`, and `TERMINAL_BROWSER_APPDATA` directories;
the terminal process must inherit them so newly created splits do too.
`TB_VERIFY_RUNTIME_DIR` selects that private runtime root for the verifier.
`TB_VERIFY_REPORT` and `TB_VERIFY_ROOT`
can select report/artifact locations.

`dist/` is ignored by Git. The build preserves Playwright's runtime-relative
imports while omitting its types and Trace Viewer web assets. It includes the
official axe script unchanged because it serializes its own source, and copies
dependency licenses. `bun run package` creates a deterministic ZIP and SHA-256
sidecar in the repository's `.cache/releases/`, without source, tests, build
tools, or workspace dependencies.
Only the recording codecs' required WASM files are included, alongside their
license notices. They load from the installed plugin directory without downloads.
ZIP entries larger than 64 KiB use STORE (no compression) to avoid the ZCode
3.11.2 installer's large deflate-stream failure under Node 26. Smaller files
remain compressed. The resulting archive is compatible with Node 24 and 26.

To install local changes, from the repository root:

```bash
bun run build
bun run marketplace:dev
node ../zcode-cli/bin/zcode.js plugins marketplace add "$PWD/.cache/marketplace" --yes
node ../zcode-cli/bin/zcode.js plugins install terminal-browser@zcode-plugins-dev --yes
```

For subsequent edits, rebuild and regenerate the development marketplace, then
run `plugins marketplace update zcode-plugins-dev` and
`plugins update terminal-browser@zcode-plugins-dev`. Start a new ZCode session.
Use one terminal-browser plugin at a time when development and released copies
are both installed.

For publication, bump `package.json` and `.zcode-plugin/plugin.json` together,
merge into `main`, and run the **Release terminal-browser** Actions workflow
with that version. The workflow verifies the published ZIP before opening a
marketplace update PR. The catalog keeps the last published version until that
PR is merged; release assets are never overwritten. Listing descriptions live
in `marketplace-entry.json`.

## License

MIT. Dependency notices are included in `dist/licenses/` and the vendored
Playwright package.
This software is based in part on the work of the Independent JPEG Group.
