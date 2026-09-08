# AGENTS.md — zcode-plugins

Agent instructions for working in this repository: a workspace of unofficial
community plugins for the [ZCode CLI](https://github.com/kingsword09/zcode-cli).
Read this before creating or modifying a plugin.

## Repository layout

```
.
├── .claude-plugin/marketplace.json  # marketplace manifest — the ONLY manifest the CLI discovers
├── plugins/<name>-plugin/           # one directory per plugin (bun workspace member)
│   ├── .zcode-plugin/plugin.json    # per-plugin manifest (read by the runtime)
│   ├── commands/*.md                # slash commands
│   ├── skills/<name>/SKILL.md       # agent skills
│   ├── src/                         # TypeScript sources
│   └── dist/                        # runtime build output; see distribution rules below
├── package.json                     # bun workspace root ("workspaces": ["plugins/*"])
└── tsconfig.base.json               # shared strict TS config (ES2023, Bundler resolution)
```

Two manifest layers, do not confuse them:

| File | Read by | Purpose |
| --- | --- | --- |
| `.claude-plugin/marketplace.json` (repo root) | `zcode plugins marketplace add` | Declares the marketplace name and plugins with directory or verified release ZIP sources. |
| `plugins/<dir>/.zcode-plugin/plugin.json` | plugin runtime at load time | Declares the plugin name, version, MCP servers, commands and skills directories. |

The CLI looks for the marketplace manifest only at
`<root>/.claude-plugin/marketplace.json` or `<root>/marketplace.json`. A
`.zcode-plugin/marketplace.json` is **not** recognized — that directory only
holds per-plugin `plugin.json` files (`.claude-plugin/plugin.json` also works,
but `.zcode-plugin/plugin.json` is the primary location).

## Toolchain

- **Node.js >= 24**, **Bun** (dependency manager + test runner), TypeScript 7 (`tsc --noEmit` via the workspace `typecheck` scripts).
- Root scripts: `bun install`, `bun run build`, `bun run typecheck`, `bun test` (root scripts fan out with `bun run --filter '*' <cmd>`).
- MCP server bundles are ESM for `platform: "node"`, `target: "node24"`, entry `src/mcp/server.ts` → `dist/mcp/server.js`.

## Creating a new plugin

Run these steps in order. The plugin name convention is `<name>-plugin` for the
directory, `<name>` for the plugin id.

### 1. Scaffold the directory

```
plugins/<name>-plugin/
├── .zcode-plugin/plugin.json
├── package.json
├── tsconfig.json
├── src/mcp/server.ts      # if the plugin has an MCP server
└── README.md
```

### 2. package.json

Model it on `plugins/zcode-model-config-plugin/package.json`:

- `name`: `@zcode-plugins/<name>-plugin`, `"private": true`, `"type": "module"`, `"license": "MIT"`.
- `main`: `./dist/mcp/server.js` (if there is an MCP server).
- Scripts: `"build"` (bundle to `dist/mcp/server.js`), `"typecheck": "tsc --noEmit"`, `"test": "bun test"`.
- `tsconfig.json` extends `../../tsconfig.base.json` and includes `src/**/*.ts`, `test/**/*.ts`, and the build config file.

### 3. Per-plugin manifest `.zcode-plugin/plugin.json`

Minimum required fields: `name` (the plugin id used in `<plugin>@<marketplace>`),
`version`, `description`, `author`, `license`. Optional component declarations:

- `mcpServers`: stdio servers to launch, e.g.
  `"mcpServers": { "<plugin-name>": { "type": "stdio", "command": "node", "args": ["${ZCODE_PLUGIN_ROOT}/dist/mcp/server.js"], "env": {} } }`.
  `${ZCODE_PLUGIN_ROOT}` expands to the installed plugin directory at runtime —
  always reference built files through it, never relative paths.
- `commands`: directory of slash commands (`"commands": "commands"`).
- `skills`: directory of agent skills (`"skills": "skills"`).

### 4. Register in the marketplace manifest

For a directory source, commit the complete runtime. For a Release ZIP source,
publish and verify the archive before adding the catalog entry. terminal-browser
uses the release workflow described below; its unpublished listing metadata
lives in `plugins/terminal-browser-plugin/marketplace-entry.json`.

Add an entry to `plugins` in `.claude-plugin/marketplace.json`:

```json
{
  "name": "<name>",
  "source": "./plugins/<name>-plugin",
  "description": "...",
  "description_i18n": { "en": "...", "zh-CN": "..." },
  "version": "0.1.0",
  "author": { "name": "kingsword09" },
  "category": "provider",
  "keywords": ["..."]
}
```

The workspace glob `plugins/*` in the root `package.json` picks the new
directory up automatically — no other registration needed. Run `bun install`
once so Bun links the new workspace member.

### 5. Build an MCP server (optional)

Pattern used by both existing plugins (`src/mcp/server.ts`):

- `@modelcontextprotocol/sdk` `McpServer` + `StdioServerTransport`, tools
  registered with `server.registerTool(name, { description, inputSchema }, handler)`
  using zod schemas.
- Keep the bundle **self-contained**: bundle npm dependencies or include their
  required runtime files in the release ZIP. The CLI does not run npm install
  or build steps. Only Node built-ins can be assumed available. Nothing outside
  `dist/`, `node_modules/`, and the manifest needs to exist on a user machine.
- If the plugin ships a web UI, inline it: build the UI to a single HTML/JS/CSS
  string module (see `plugins/zcode-model-config-plugin/scripts/build.ts` and
  `src/ui/assets.ts`, which is generated and git-ignored) so the MCP server can
  serve it from one bundle.

### 6. Add a slash command (optional)

`commands/<name>.md` — markdown with frontmatter:

```markdown
---
description: One-line description shown in the command list.
argument-hint: "[args]"        # optional; shown as the TUI parameter hint
skills: <skill-name>           # optional; skills to load before the body
---

Command body. $ARGUMENTS expands to what the user typed after the command.
```

Slash commands are **always model-mediated**: the body is injected as a prompt.
To make a command feel mechanical (e.g. `/model-config start`), write the body
so it names the exact MCP tool and arguments to call — the model then just
relays instead of deciding. `$ARGUMENTS` is the only supported placeholder.

### 7. Add an agent skill (optional)

`skills/<name>/SKILL.md` — markdown with frontmatter:

```markdown
---
name: <name>
description: When to use this skill — write concrete triggers (user phrases,
  error codes, tool names). This is what the agent matches against.
---

# Title
Instructions for the agent: workflow steps, failure handling, constraints.
```

### 8. Build and validate

```bash
bun install
bun run build                        # or cd plugins/<name>-plugin && bun run build
bun run typecheck && bun test
zcode plugins validate <name>@zcode-plugins   # after installing once (see below)
```

### 9. Test the full install flow locally

Use the local zcode-cli checkout, not the global install:

For terminal-browser, use its isolated ZIP verification and development catalog:

```bash
bun run package:terminal-browser
bun plugins/terminal-browser-plugin/scripts/verify-package.ts --cli ../zcode-cli/bin/zcode.js
bun run marketplace:dev
node ../zcode-cli/bin/zcode.js plugins marketplace add "$PWD/.cache/marketplace" --yes
node ../zcode-cli/bin/zcode.js plugins install terminal-browser@zcode-plugins-dev --yes
```

For legacy directory-source plugins:

```bash
# from this repo root; ../zcode-cli must exist
node ../zcode-cli/bin/zcode.js plugins marketplace update zcode-plugins
node ../zcode-cli/bin/zcode.js plugins install <name>@zcode-plugins --yes
```

Installed plugins are **copied** (not symlinked) to
`~/.zcode/cli/plugins/cache/zcode-plugins/<name>/<version>/` and auto-enabled
(`plugins.enabledPlugins` in `~/.zcode/cli/config.json`). Start a **new** zcode
session to load it — running sessions keep old MCP server processes.

## Modifying an existing plugin

terminal-browser: rebuild, run `package` and `verify:package`, and use
`marketplace:dev` for local installation under `zcode-plugins-dev`. Bump its
package/manifest versions together before release. After merging to `main`,
the `release-terminal-browser.yml` workflow publishes a verified versioned ZIP
and opens a marketplace update PR. Never insert an unavailable release URL or
overwrite existing release assets. The workflow must be allowed to create PRs.

For legacy directory-source plugins:

After editing plugin source, the full update flow is three steps (markdown-only
changes to `commands/` or `skills/` skip step 1):

```bash
cd plugins/<dir> && bun run build                             # 1. rebuild
zcode plugins marketplace update zcode-plugins                # 2. sync the marketplace copy
zcode plugins update <name>@zcode-plugins                     # 3. refresh the installed cache
```

(With the local zcode-cli checkout: `node ../zcode-cli/bin/zcode.js ...`.)
Then start a new zcode session.

## Conventions and gotchas

- terminal-browser's `dist/` and release ZIPs are ignored; CI builds and verifies
  them. zcode-model-config retains its committed bundle and directory source.
  Generated web assets (`plugins/*/src/ui/assets.ts`) stay ignored.
- `.zcode-plugin/plugin.json` and the plugin `package.json` versions move
  together. For directory sources the marketplace version moves with them;
  for ZIP sources it changes only after publication and checksum verification.
  The install cache path is keyed by the plugin.json version. Commands and skills
  inside a ZIP also require a new release to reach consumers.
- Plugin ids are `<name>@zcode-plugins` — the marketplace half comes from the
  top-level `name` in `.claude-plugin/marketplace.json` (`zcode-plugins`).
- `bun run --filter '*' build` at the root is the supported fan-out; `bun
  workspaces run` does not exist. Repeated `$ cmd` lines in `bun run --filter`
  output are TTY redraw noise, not repeated executions.
- Unofficial plugins that touch Z.ai internal endpoints must carry the warning
  block (see the root README) and state the risk in their own README.
- Validate a plugin with `zcode plugins validate <name>@zcode-plugins`
  (by id). `--source <plugin-dir>` expects a *marketplace* manifest and will
  fail on a bare plugin directory.
