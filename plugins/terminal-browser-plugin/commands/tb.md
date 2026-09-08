---
description: Operate a live terminal browser, capture visual evidence, inspect diagnostics, or manage recording jobs.
argument-hint: "[status|open <url>|ls|snapshot|screenshot <path>|responsive|record start|done]"
skills: terminal-browser
---

Parse `$ARGUMENTS` and call this plugin's matching MCP tool. Slash commands
are model-mediated; preserve quoted arguments and report the actual tool result.

- Bare `/tb` or `ls`: `browser_list {}`.
- `status`: `browser_status {}`.
- `open <url-or-path>`: `browser_open { url }`. Reuse is the default.
- `split <url-or-path>`: `browser_open { url, direction: "right" }`.
- `nav <url>`: `browser_navigate { url }`.
- `back`, `forward`, `reload`: `browser_navigate` with that flag set to true.
- `read`, `snapshot`: `browser_read`, `browser_snapshot`.
- `screenshot [path]`: `browser_screenshot` with optional `outputPath`.
- `responsive`: `browser_responsive` with `viewports`
  `[{ "width": 390, "height": 844 }, { "width": 1280, "height": 800 }]`.
- `diff <baseline-path>`: `browser_diff { baselinePath }`.
- `console`, `errors`, `network`: the corresponding read tool.
- `a11y`: `browser_accessibility {}`.
- `record start`: `browser_record { action: "start" }`; retain and report its ID.
- `record status|stop|cancel <id>`: `browser_record { action, id }`.
  Stop requests finalization; report a completed artifact only after status
  confirms completion.
- `record list`: `browser_record { action: "list" }`.
- `pause`, `resume`, `handoff`, `release`: `browser_session { action }`.
- `download ref=<ref> [outputPath=<path>]`: `browser_download` with
  `target: { ref }` and optional output path.
- `done`: `browser_done {}`.

For action commands such as `click ref=e6` or `fill label=Name value=Alice`,
map the provided key=value arguments to the matching tool. `@e6` means
`ref: "e6"`. Carry explicit `browserId` and numeric `tabId` through.
Choose IDs from a fresh list when ambiguous; choose targets from observations.

$ARGUMENTS
