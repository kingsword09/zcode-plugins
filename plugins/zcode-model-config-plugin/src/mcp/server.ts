#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeUiServer, openBrowserAt, runningUi, startUiServer } from "../ui/server.ts";

const server = new McpServer({ name: "zcode-model-config", version: "0.1.0" });

/**
 * The command file (`/model-config [start|stop|status]`) calls this tool
 * directly without model reasoning, so the UI lifecycle stays under the
 * user's control: start opens a browser tab, stop tears the server down,
 * status reports whether it is running. The server also auto-shuts when the
 * zcode process exits (exit/SIGINT/SIGTERM hooks in ui/server.ts).
 */
server.registerTool(
  "model_config",
  {
    description:
      "Manage the local ZCode model config web UI. Actions: `start` (default) opens the UI in the default browser on http://127.0.0.1 — reuses the running server if already up; `stop` shuts the server down; `status` reports the running state without side effects. Edits providers, models, multimodal capabilities, and main/lite model roles for both the user config (~/.zcode/cli/config.json) and project config (zcode.json / .zcode/config.json). Ships with a models.dev (Vercel AI SDK) catalog for one-click import.",
    inputSchema: {
      action: z
        .enum(["start", "stop", "status"])
        .optional()
        .describe("Lifecycle action: start (default), stop, or status."),
    } as unknown as Record<string, never>,
  },
  async (args: unknown) => {
    const params = (args ?? {}) as { action?: "start" | "stop" | "status" };
    const action = params.action ?? "start";
    try {
      if (action === "status") {
        const handle = runningUi();
        return {
          content: [
            {
              type: "text" as const,
              text: handle
                ? `running on http://127.0.0.1:${handle.port}/`
                : "not running",
            },
          ],
        };
      }
      if (action === "stop") {
        const was = runningUi();
        await closeUiServer();
        return {
          content: [
            { type: "text" as const, text: was ? "Model config web UI stopped." : "Web UI was not running." },
          ],
        };
      }
      // start (default)
      const handle = await startUiServer({
        projectRoot: process.cwd(),
        openBrowser: true,
      });
      openBrowserAt(`http://127.0.0.1:${handle.port}/`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                url: `http://127.0.0.1:${handle.port}/`,
                userConfig: "~/.zcode/cli/config.json",
                note: "Edit config in the browser, then save from the UI. Changes apply to new zcode sessions. Run /model-config stop when done, or the server exits with this process.",
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(`[model-config] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
