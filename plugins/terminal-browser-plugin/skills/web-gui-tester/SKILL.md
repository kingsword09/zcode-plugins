---
name: web-gui-tester
description: Test web frontends through terminal-browser with real clicks, typing, scrolling, screenshots, and DOM observations. Use for GUI regression checks, frontend bug reproduction, or exploratory testing of a page, and report verified behavior with saved evidence.
---

## Core Principles

1. **Pure GUI black-box testing**: Interact only with elements that are
   visible and operable on the page, simulating real user behavior. During
   verification, annotated screenshots and/or read-only DOM inspection
   (snapshot, eval without side effects) are allowed, but injecting
   JavaScript to modify page state, trigger interactions, or bypass frontend
   logic is strictly prohibited.
2. **Faithful to the actual page**: All conclusions must be based on the
   page's actual behavior. Do not guess or speculate. If a normal GUI
   operation fails, stop and report it; do not use alternative methods to
   force progress.
3. **Separate testing from fixing**: Do not modify the code under test during
   testing. If a bug blocks the current path, record the issue, skip that
   path, and continue testing other unaffected points. Only begin fixing bugs
   after capturing the failing behavior and when the user has explicitly or
   implicitly requested fixes. Continue already-authorized fixes without a new
   approval ceremony.
4. **Cross-validate code and visuals**: Observations must include both
   read-only code verification (snapshot / targeted reads) and visual
   verification via screenshots. The two must corroborate each other and
   cannot replace one another. A test point without at least one screenshot
   you actually viewed (the image content block returned by
   `browser_screenshot { annotate: true }`) as evidence must be
   considered incomplete.
5. **The user can see the pane**: terminal-browser shows the live page next
   to the conversation. The user may interact with the pane at any time (or
   may have already set up login state). Screenshots are YOUR visual record;
   the pane itself is the user's. Say what you are doing, not what the page
   looks like — they can see it.

## Tooling

All interaction goes through the `terminal-browser` skill's MCP tools
(`browser_open`, `browser_list`, `browser_read`, `browser_snapshot`,
`browser_click`/`browser_fill`/`browser_select`/`browser_press`,
`browser_done`) — load that skill's workflow rules too; when the two
conflict, that skill's tooling rules win. Open the target with
`browser_open { url }` first if no pane is showing it. Preserve exact
`browserId`/`tabId` from the returned state throughout a test case.

## Phase One: Scenario Assessment and Test Planning

Choose strategy based on the completeness of the information provided:

### Complete information: explicit steps and expected results

→ Skip planning and proceed directly.

### Partial information: feature/bug description or requirements doc

→ Lightweight planning: clarify the test objective and acceptance criteria,
then execute directly without requesting confirmation.

### Insufficient information: only a URL or "please test it"

→ Complete planning:
1. **Explore the page**: open it, take an annotated screenshot for overview,
   identify the page type (form / list / detail / dashboard).
2. **Identify functionality**: list the core interactive elements from the
   snapshot.
3. **Create a test plan** by priority:
   - **P0 Main flow**: the normal path for core functionality (submit a
     form, search, switch tabs).
   - **P1 Interaction feedback**: loading states, success/failure messages,
     disabled states, navigation after actions.
   - **P2 Input boundaries**: empty input, long input, special characters,
     duplicate submissions.
   - **P3 Layout and styling**: overlap, text overflow, alignment, visual
     quality.
4. **Present the plan and begin immediately** with P0. Exception: if the
   page requires login credentials or testing writes real data (order,
   payment, deletion) outside the user's existing authorization, obtain the
   missing authorization before that action. Reuse authorization already given.

## Phase Two: Test Environment Preparation (when needed)

Before formal testing, any method may prepare the environment; black-box
restrictions do not apply during this phase.

- Start/restart dev servers and dependent services; modify configs; seed
  databases or test accounts.
- Ask the user to log in in the pane, or reuse an already-logged-in tab.

Constraints: (1) once preparation is complete, state "Environment preparation
is complete; formal testing is beginning" — black-box rules apply
immediately; (2) setup may only make the feature reachable, never pre-trigger
the behavior under test; (3) if an environment issue surfaces mid-test,
declare the current test point invalid, re-prepare, restart that point, and
report honestly; (4) record all setup operations for the final report.

## Phase Three: Test Execution — action → observation loop

Permitted: navigation, snapshot, read, clicks/typing/scrolling/keys, console
and errors reads (read-only), annotated screenshots.

**Prohibited**:
- Any JavaScript injection with side effects: assignments, dispatching
  events, programmatic clicks, DOM/storage modification, issuing requests
  (only side-effect-free `eval` reads are allowed).
- Bypassing page interactions by constructing/modifying URLs.
- Tab, keyboard shortcuts, force clicks, or other unconventional methods to
  bypass a failed operation.
- Refresh/back/forward/resize to escape a failed state (resetting to the
  entry page between test points is fine).

**When element location fails**: never retry unchanged. Take a fresh
`snapshot` (+ screenshot if needed), decide whether it is a page bug (element
genuinely missing — record and skip) or a locator issue (rebuild from the new
snapshot's `[ref=eN]` refs — pass `ref` to browser_click/fill).

**Observation — cross-validate code and visuals**:

For every new page state (initial load, after each interaction, end of each
test point, and whenever the page has canvas/SVG/chart/video content or an
issue is found):
- **Code verification (read-only)**: `snapshot` for structure; targeted
  `browser_read`/`browser_evaluate` reads for selected/checked/success state;
  `browser_console`/`browser_errors` for page error evidence. Capture begins on
  the first inspection; note the step where each error occurred.
- **Visual verification**: `browser_screenshot { annotate: true }` and
  actually inspect the returned image content block. The red labels on the
  image ARE the `[ref=eN]` ids (act with browser_click { ref }), so you can
  point at exactly what a finding refers to. Preserve evidence with
  `outputPath: "gui-test-screenshots/t1-before.png"`. The tool returns both the
  image and saved path. Use a new filename per capture; outputs stay inside
  the active workspace and do not overwrite existing files.
- **Transient states** (toasts, tooltips, loaders): capture before → act →
  wait for the target state → capture after, consecutively in one
  observation cycle; prefer `wait <selector>` over fixed delays.

| Dimension | Points of attention |
|---|---|
| Element presence | Key UI elements exist and are visible |
| Content correctness | Text/numbers match expectations |
| State changes | URL/element/text updates match the action |
| Layout and occlusion | Unexpected overlap, obstruction, truncation; distinguish legitimate overlays (sticky nav) from defects |
| Rendering and design | Long-text overflow, wrapping, design consistency |
| Visual quality | Contrast, colors, typography, spacing, alignment |

## Phase Four: Output Test Conclusions

Summarize from every recorded observation:
- Which test points passed; which failed (with reproduction steps and
  screenshots); which were blocked (and why).
- Console errors collected during testing, or observed error manifestations
  (error text, blank regions, broken layout) with the step each occurred at.

Every test point — passed or failed — must reference its corresponding
viewed screenshot. Save evidence with the screenshot tool's `outputPath` and
reference the returned absolute path in the report. For example:
`![login screenshot](/abs/path/gui-test-screenshots/t1-before.png)`. If a
screenshot was only viewed and not persisted, say so explicitly instead of
inventing a path.

Run `browser_done` when testing finishes to clear the agent indicator in the
user's pane.
