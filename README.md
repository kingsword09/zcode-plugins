# zcode-plugins

Unofficial community plugins for the [ZCode CLI](https://github.com/kingsword09/zcode-cli) runtime.

| Plugin | Description |
| --- | --- |
| [`zcode-model-config`](./plugins/zcode-model-config-plugin) | Local web UI (React + StyleX) to edit ZCode CLI model / provider config, with a models.dev catalog for one-click import. |
| [`terminal-browser`](./plugins/terminal-browser-plugin) | Live Chromium pane with exact tab routing, scoped/iframe actions, uploads, visual diffs, responsive screenshots, network/axe/CPU diagnostics, and durable recording jobs. Distributed as a Release ZIP; the first public listing is added after publication. |

## Install

Plugins are installed from a **marketplace** (this repo). Two sources are supported: this GitHub repo, or a local checkout. Both go through the same two steps — register the marketplace, then install + enable the plugin you want.

### Option A: from GitHub (recommended)

Works from any directory; no clone needed. The CLI resolves `owner/repo` to `https://github.com/owner/repo.git` and reads the manifest at the repo root:

```bash
zcode plugins marketplace add kingsword09/zcode-plugins
```

### Option B: from a local checkout

Useful when developing the plugins or working offline. Point the CLI at the repo root (the directory containing `.claude-plugin/marketplace.json`):

```bash
git clone https://github.com/kingsword09/zcode-plugins.git
zcode plugins marketplace add /path/to/zcode-plugins
```

A local marketplace stays linked to that directory. Its catalog describes
published versions: a ZIP entry still downloads the published ZIP. To install
terminal-browser from local source, build the separate development marketplace
described below.

### Install and enable a plugin

List what the marketplace offers, then install by fully-qualified id (`<plugin>@<marketplace>`):

```bash
zcode plugins overview                 # see available plugins
zcode plugins install zcode-model-config@zcode-plugins
```

Installation copies the plugin into `~/.zcode/cli/plugins/cache/` and enables it by default. Verify with:

```bash
zcode plugins list
```

You can also manage enable/disable state interactively with the `/plugins` panel inside a ZCode session.

Consumers need no `bun install` or build step. `zcode-model-config` retains its
committed bundle. `terminal-browser` includes its runtime dependencies in a
versioned GitHub Release ZIP, verified by the SHA-256 in the marketplace entry.

## Uninstall

Remove a single plugin (keeps the marketplace registered):

```bash
zcode plugins uninstall zcode-model-config@zcode-plugins
```

Or remove everything this marketplace brought in at once — uninstalling the marketplace removes its installed plugins:

```bash
zcode plugins marketplace remove zcode-plugins
```

Both commands ask for confirmation; append `--yes` for non-interactive shells.

## Update

The marketplace caches a copy of the repo, so upstream changes don't apply automatically:

```bash
zcode plugins marketplace update zcode-plugins   # re-fetch the repo / re-read the local dir
zcode plugins update zcode-model-config@zcode-plugins   # refresh installed plugin cache
```

Then start a **new** ZCode session — running sessions keep the old MCP server process. For plugin authors iterating locally, see the plugin's own README for the full three-step flow (rebuild included).

## Development

Requirements: **Node.js >= 24**, **Bun** (dependency manager + test runner), **TypeScript 7** (`tsgo`), `tsdown` for bundling.

```bash
bun install        # install workspace deps
bun run build      # build all plugins (bundle dist/mcp/server.js)
bun run typecheck  # tsc --noEmit per workspace
bun test           # run unit tests
```

Per-plugin commands can be run inside `plugins/<name>`, e.g.:

```bash
cd plugins/zcode-model-config-plugin
bun run build
bun test
```

For terminal-browser, build and install a local release candidate under a
separate marketplace name:

```bash
bun run build
bun run marketplace:dev
node ../zcode-cli/bin/zcode.js plugins marketplace add "$PWD/.cache/marketplace" --yes
node ../zcode-cli/bin/zcode.js plugins install terminal-browser@zcode-plugins-dev --yes
```

The generated marketplace contains only packaged runtime files. Rebuild and
rerun `marketplace:dev`, then update `zcode-plugins-dev` and its installed plugin
to test another revision. Select one terminal-browser plugin in the ZCode
plugin panel when both development and published copies are installed.

### Release ZIPs

terminal-browser build output is ignored by Git. `bun run package:terminal-browser`
creates `.cache/releases/terminal-browser-<version>.zip`, its `.sha256` file,
and `release.json`. CI tests the source and the extracted ZIP with real Chromium.
The ZIP contains the server, worker, required Playwright runtime, axe script,
portable recording codecs, commands, skills, README, and licenses. Recording
requires no system FFmpeg or ffprobe. It excludes TypeScript declarations and
Playwright's Trace Viewer web assets.
Files larger than 64 KiB use uncompressed ZIP entries for compatibility with
the ZCode 3.11.2 installer on Node 26; smaller entries remain compressed.

After merging source changes into `main`, run the **Release terminal-browser**
workflow with the plugin version. It builds and verifies the ZIP, publishes
versioned assets, downloads them to verify their checksum, and opens a PR that
updates `.claude-plugin/marketplace.json`. Merge that PR to make the release
installable from the marketplace. The repository's Actions settings must allow
GitHub Actions to create pull requests.

Only published, verified ZIPs belong in the public catalog. Until the first
release is published, terminal-browser is available through the development
marketplace. `plugins/terminal-browser-plugin/marketplace-entry.json` stores
its pending listing metadata. Published versions and assets must not be replaced;
bump the plugin version for a changed runtime, command, or skill.

### Repository layout

```
.
├── .claude-plugin/marketplace.json  # marketplace manifest (this is the file the CLI discovers)
├── plugins/
│   └── zcode-model-config-plugin/   # one directory per plugin (bun workspace)
│       ├── .zcode-plugin/plugin.json  # per-plugin manifest (name, version, MCP server, commands, skills)
│       ├── commands/                # slash commands
│       ├── skills/                  # agent skills
│       ├── src/                     # TypeScript sources
│       └── dist/                    # build output (legacy plugin committed; ZIP plugin ignored)
└── package.json                     # bun workspace root
```

The CLI looks for the marketplace manifest only at `<repo>/.claude-plugin/marketplace.json` or `<repo>/marketplace.json`; per-plugin manifests live in each plugin's `.zcode-plugin/plugin.json` (`.claude-plugin/plugin.json` also works).

Adding a new plugin: create `plugins/<name>-plugin/` with a `.zcode-plugin/plugin.json`.
The `plugins/*` workspace glob discovers it automatically. Register a directory
source only when its runtime is committed; register a ZIP source after its
release is published and verified.

## License

MIT
