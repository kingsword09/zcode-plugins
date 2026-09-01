---
description: Start, stop, or check the local ZCode model config web UI.
argument-hint: "[start|stop|status]"
---

The `/model-config` command directly drives the local model config web UI via
the `model_config` MCP tool — **no model reasoning is needed**. Run the
matching subcommand:

- `/model-config` or `/model-config start` → call `model_config` with
  `action: "start"` (default). It starts (or reuses) the local server on
  `127.0.0.1` and opens the browser at the UI.
- `/model-config stop` → call `model_config` with `action: "stop"`. It shuts
  the server down.
- `/model-config status` → call `model_config` with `action: "status"`. It
  reports whether the UI is running and on which port.

The server auto-stops when the zcode process exits (exit / SIGINT / SIGTERM
hooks are installed by the plugin), so forgetting `/model-config stop` is
safe — it will not outlive this session.

Parse `$ARGUMENTS` as the action: empty means `start`; otherwise pass the
literal token (`start` / `stop` / `status`) through to the tool.

$ARGUMENTS
