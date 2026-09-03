# zcode-plugins

Unofficial community plugins for the [ZCode CLI](https://github.com/kingsword09/zcode-cli) runtime.

| Plugin | Description |
| --- | --- |
| [`zcode-model-config`](./plugins/zcode-model-config-plugin) | Local web UI (React + StyleX) to edit ZCode CLI model / provider config, with a models.dev catalog for one-click import. |

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

A local marketplace stays linked to that directory — after editing plugin source there, `zcode plugins marketplace update zcode-plugins` picks up your changes (see [Update](#update)).

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

No `bun install` / `bun run build` is needed on the consuming side: each plugin's `dist/mcp/server.js` bundle and its dependencies are committed and installed as-is.

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
│       └── dist/                    # build output (committed; the runtime runs this)
└── package.json                     # bun workspace root
```

The CLI looks for the marketplace manifest only at `<repo>/.claude-plugin/marketplace.json` or `<repo>/marketplace.json`; per-plugin manifests live in each plugin's `.zcode-plugin/plugin.json` (`.claude-plugin/plugin.json` also works).

Adding a new plugin: create `plugins/<name>-plugin/` with a `.zcode-plugin/plugin.json`, register it in `.claude-plugin/marketplace.json`, and add the directory to the workspace (already covered by `plugins/*`).

## License

MIT
