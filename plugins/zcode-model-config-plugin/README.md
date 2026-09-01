# zcode-model-config-plugin

Unofficial ZCode plugin that opens a **local web UI** for editing the ZCode CLI
model / provider configuration — no more hand-editing JSON.

- `/model-config` command or the `open_model_config` MCP tool starts a local
  server on `127.0.0.1` and opens your browser.
- Two scopes in one UI: **user** (`~/.zcode/cli/config.json`) and **project**
  (`zcode.json` / `.zcode/config.json`; project overrides user).
- Providers: add / edit / delete with kind (`anthropic` / `openai` /
  `openai-compatible`), baseURL, API key.
- Models: per-model editing of context / output limits, reasoning, and
  **multimodal** (the master toggle writes `attachment` +
  `supportsImages`/`supportsPdf`/`supportsVideo` + `modalities.input` together,
  as the official docs recommend), plus a raw-JSON escape hatch.
- **models.dev catalog** (the same Vercel AI SDK model database the runtime
  uses): search, filter (multimodal / reasoning), multi-select import with full
  metadata (limits, modalities, cost).
- main / lite model role selectors (`provider/model` format enforced).
- Saving: zod validation (mirrors the runtime schema), `.bak` backup, atomic
  write, 0600 permissions, 2-space indent. Only `provider` / `model` /
  `modelCatalog` keys are touched — the rest of your config is preserved.
- `close_model_config` stops the server when you're done.

## Development

```bash
bun install
bun run build:web   # bundle web/ (React + StyleX) into src/ui/assets.ts (generated, git-ignored)
bun run build       # build:web + tsdown → dist/mcp/server.js
bun run typecheck   # tsc for node + web configs
bun test            # unit tests (store / schema / paths / models.dev mapping)
```

The web build runs `@stylexjs/babel-plugin` through a custom esbuild plugin
(`esbuild.stylex.ts`) that collects the emitted CSS and inlines both JS and CSS
into a single HTML string module, so the final MCP bundle stays self-contained.
