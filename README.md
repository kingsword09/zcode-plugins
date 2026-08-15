# zcode-plugins

Unofficial community plugins for the [ZCode CLI](https://github.com/kingsword09/zcode-cli) runtime.

> [!WARNING]
> `zcode-start-plan` is an unofficial, community implementation reverse-engineered from the ZCode desktop app. It uses internal `zcode-plan` endpoints that Z.ai has not officially opened to CLI clients, and it drives the Aliyun captcha web SDK outside its intended browser context. Use at your own risk; heavy or abusive usage may trigger risk control on your account. If you rely on ZCode for production work, subscribe to a Coding Plan instead.

## Plugins

| Plugin | Description |
| --- | --- |
| [`zcode-start-plan`](./plugins/zcode-start-plan-plugin) | Spend the free "ZCode Start Plan" trial quota from the CLI via an MCP tool, with one-time Aliyun captcha bridging. |

## Install (marketplace)

From any directory:

```bash
zcode plugins add kingsword09/zcode-plugins
```

Then open the `/plugins` panel (or run `zcode plugins`) and enable `zcode-start-plan`.

To install from a local checkout instead:

```bash
zcode plugins add /path/to/zcode-plugins
```

## Development

Requirements: **Node.js >= 24**, **Bun** (dependency manager + test runner), **TypeScript 7** (`tsgo`), `tsdown` for bundling.

```bash
bun install        # install workspace deps
bun run build      # build all plugins (tsdown bundles dist/mcp/server.js)
bun run typecheck  # tsgo --noEmit per workspace
bun test           # run unit tests
```

Per-plugin commands can be run inside `plugins/<name>`, e.g.:

```bash
cd plugins/zcode-start-plan-plugin
bun run build
bun test
```

### Repository layout

```
.
├── .zcode-plugin/marketplace.json   # marketplace manifest (name -> plugin source dirs)
├── plugins/
│   └── zcode-start-plan-plugin/     # one directory per plugin (bun workspace)
│       ├── .zcode-plugin/plugin.json
│       ├── commands/                # slash commands
│       ├── skills/                  # agent skills
│       ├── src/                     # TypeScript sources
│       └── dist/                    # build output (git-ignored)
└── package.json                     # bun workspace root
```

Adding a new plugin: create `plugins/<name>-plugin/` with a `.zcode-plugin/plugin.json`, register it in `.zcode-plugin/marketplace.json`, and add the directory to the workspace (already covered by `plugins/*`).

## License

MIT
