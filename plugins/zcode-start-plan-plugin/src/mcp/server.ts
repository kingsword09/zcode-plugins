#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadStartPlanBearerToken } from "../credentials.ts";
import { DEFAULT_START_PLAN_MODELS } from "../constants.ts";
import { StartPlanService, ProviderBusinessError } from "../service.ts";
import { acquireCaptchaParam } from "../captcha.ts";

const server = new McpServer({ name: "zcode-start-plan", version: "0.1.0" });

interface ServiceHolder {
  service: StartPlanService | null;
}

const holder: ServiceHolder = { service: null };

async function getService(logger?: (message: string) => void): Promise<StartPlanService> {
  if (holder.service) return holder.service;
  const bearerToken = await loadStartPlanBearerToken();
  holder.service = new StartPlanService({ bearerToken });
  logger?.("loaded ZCode JWT from ~/.zcode/v2/credentials.json");
  return holder.service;
}

function errorMessage(error: unknown): string {
  if (error instanceof ProviderBusinessError) {
    const code = error.providerCode ? ` (code ${error.providerCode})` : "";
    return `Start Plan request failed${code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

server.tool(
  "start_plan_status",
  "Check whether the logged-in ZCode account has an active free Start Plan trial, and list its usable models and quota plans.",
  {},
  async () => {
    try {
      const service = await getService();
      const status = await service.checkEntitlement();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                entitled: status.entitled,
                models: status.models.length > 0 ? status.models : [...DEFAULT_START_PLAN_MODELS],
                plans: status.plans,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: errorMessage(error) }], isError: true };
    }
  },
);

interface GenerateParams {
  prompt: string;
  model?: string;
  system?: string;
  max_tokens?: number;
}

server.registerTool(
  "start_plan_generate",
  {
    description:
      "Generate text with the free ZCode Start Plan trial quota (zcode-plan endpoint). Delegated generation only; the main conversation model is unaffected. May open a one-time browser captcha tab on first use.",
    inputSchema: {
      prompt: z.string().min(1).describe("The user prompt to send."),
      model: z
        .string()
        .optional()
        .describe(
          `Model id, e.g. ${[...DEFAULT_START_PLAN_MODELS].join(" or ")}. Defaults to ${DEFAULT_START_PLAN_MODELS[0]}.`,
        ),
      system: z.string().optional().describe("Optional system prompt."),
      max_tokens: z.number().int().positive().max(32768).optional().describe("Max output tokens (default 4096)."),
    } satisfies Record<string, import("zod").ZodType>,
  },
  async (args: unknown) => {
    const params = args as GenerateParams;
    try {
      const service = await getService();
      const result = await service.generate({
        model: params.model ?? DEFAULT_START_PLAN_MODELS[0],
        prompt: params.prompt,
        system: params.system,
        maxTokens: params.max_tokens,
        logger: (message) => process.stderr.write(`[start-plan] ${message}\n`),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { text: result.text, model: result.model, stop_reason: result.stopReason, usage: result.usage },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: errorMessage(error) }], isError: true };
    }
  },
);

server.tool(
  "start_plan_captcha",
  "Run the one-time Aliyun captcha bridge now so the next start_plan_generate call does not need to open a browser (useful right after login or after a 3007 captcha failure).",
  {},
  async () => {
    try {
      const service = await getService();
      const config = await service.client.getCaptchaConfig(true);
      if (!config || !config.enabled) {
        return { content: [{ type: "text" as const, text: "Captcha is not enabled for the Start Plan endpoint; nothing to do." }] };
      }
      const verification = await acquireCaptchaParam({ config, logger: (m) => process.stderr.write(`[start-plan] ${m}\n`) });
      return {
        content: [{ type: "text" as const, text: `Captcha acquired (${verification.param.length} chars). It is staged for the next generate call in this server process.` }],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: errorMessage(error) }], isError: true };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`[start-plan] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
