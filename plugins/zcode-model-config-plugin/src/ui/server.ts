import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { WEB_HTML } from "./assets.ts";
import { resolveConfigInfos, userConfigPath, projectPaths } from "../config/paths.ts";
import { readConfigFile, saveModelConfig, ConfigStoreError } from "../config/store.ts";
import { ConfigValidationError } from "../config/schema.ts";
import { GatewayClient, GatewayError } from "../modelsdev/gateway.ts";
import type { ConfigScope, ModelConfigFile } from "../shared/types.ts";

export const DEFAULT_UI_PORT = 47810;

export class UiServerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UiServerError";
  }
}

export interface UiServerHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

interface Running {
  server: Server;
  handle: UiServerHandle;
}

let running: Running | null = null;
let exitHandlerInstalled = false;

function installExitHandlers(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  const cleanup = (): void => {
    const current = running;
    if (!current) return;
    running = null;
    try {
      current.server.close();
    } catch {
      // ignore
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

function log(message: string): void {
  process.stderr.write(`[model-config] ${message}\n`);
}

interface JsonBody {
  [key: string]: unknown;
}

async function readJsonBody(request: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new UiServerError("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonBody;
  } catch {
    throw new UiServerError("Request body is not valid JSON");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return cryptoSubtleEqual(bufA, bufB);
}

function cryptoSubtleEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface StartUiOptions {
  port?: number;
  projectRoot: string;
  openBrowser?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * UI locale follows the CLI: the `ui.locale` key of the user config wins
 * (e.g. "zh-CN" / "en-US"), falling back to the environment LANG, then "en".
 */
function detectLocale(env: NodeJS.ProcessEnv, userConfig: Record<string, unknown> | null): "zh-CN" | "en" {
  const uiLocale = (userConfig as { ui?: { locale?: unknown } } | null)?.ui?.locale;
  if (typeof uiLocale === "string" && uiLocale.length > 0) {
    return uiLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }
  const lang = `${env.LANG ?? ""} ${env.LANGUAGE ?? ""}`.toLowerCase();
  return lang.startsWith("zh") ? "zh-CN" : "en";
}

function buildState(projectRoot: string, env: NodeJS.ProcessEnv) {
  const { user, project } = resolveConfigInfos(projectRoot, {
    env,
    readFile: (p) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs") as typeof import("node:fs");
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
  });
  const paths = projectPaths(projectRoot, env);
  return {
    user,
    project,
    projectRoot,
    alternateProjectPath: paths.alternate,
    userModelPath: userConfigPath(env),
    locale: detectLocale(env, user.config as Record<string, unknown> | null),
  };
}

/**
 * Start (or reuse) the single local web UI server bound to 127.0.0.1.
 * A random token is generated per server instance; the page embeds it and
 * every mutating request must echo it via the x-config-token header.
 */
export async function startUiServer(options: StartUiOptions): Promise<UiServerHandle> {
  if (running) return running.handle;

  const env = options.env ?? process.env;
  const token = randomBytes(24).toString("hex");
  const gateway = new GatewayClient();
  const preferredPort = options.port ?? (env.ZCODE_MODEL_CONFIG_PORT ? Number(env.ZCODE_MODEL_CONFIG_PORT) : DEFAULT_UI_PORT);

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(WEB_HTML.replace("__CONFIG_TOKEN__", token));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(response, 200, { ok: true, state: buildState(options.projectRoot, env) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/gateway-models") {
        try {
          const models = await gateway.models({ force: url.searchParams.get("refresh") === "1" });
          sendJson(response, 200, { ok: true, models });
        } catch (error) {
          const message =
            error instanceof GatewayError ? error.message : "failed to fetch AI Gateway catalog";
          sendJson(response, 502, { ok: false, error: message });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/save") {
        const headerToken = String(request.headers["x-config-token"] ?? "");
        if (!timingSafeEqual(headerToken, token)) {
          sendJson(response, 403, { ok: false, error: "invalid config token" });
          return;
        }
        const body = await readJsonBody(request);
        const scope = body.scope as ConfigScope;
        const config = body.config as ModelConfigFile;
        if (scope !== "user" && scope !== "project") {
          sendJson(response, 400, { ok: false, error: "scope must be 'user' or 'project'" });
          return;
        }
        const state = buildState(options.projectRoot, env);
        const target = scope === "user" ? state.user.path : state.project.path;
        const result = saveModelConfig(target, config);
        log(`saved ${scope} config to ${result.path}`);
        sendJson(response, 200, { ok: true, path: result.path, backupPath: result.backupPath });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/shutdown") {
        sendJson(response, 200, { ok: true });
        setTimeout(() => {
          void closeUiServer();
        }, 100).unref();
        return;
      }
      sendJson(response, 404, { ok: false, error: "not found" });
    } catch (error) {
      const message =
        error instanceof ConfigValidationError
          ? `validation failed: ${error.issues.join("; ")}`
          : error instanceof ConfigStoreError || error instanceof UiServerError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
      const status = error instanceof ConfigValidationError ? 422 : 500;
      log(`request error on ${request.method ?? ""} ${url.pathname}: ${message}`);
      sendJson(response, status, { ok: false, error: message });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && preferredPort !== 0) {
        // Preferred port taken — fall back to an ephemeral one (port 0).
        log(`port ${preferredPort} in use, falling back to an ephemeral port`);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : 0);
        });
      } else {
        reject(new UiServerError(error.message, { cause: error }));
      }
    });
    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : preferredPort);
    });
  });

  const handle: UiServerHandle = {
    port,
    token,
    close: () => closeUiServer(),
  };
  running = { server, handle };
  installExitHandlers();
  log(`web UI listening on http://127.0.0.1:${port}`);
  return handle;
}

export async function closeUiServer(): Promise<void> {
  const current = running;
  running = null;
  if (!current) return;
  await new Promise<void>((resolve) => {
    current.server.close(() => resolve());
    setTimeout(resolve, 2000).unref();
  });
  log("web UI stopped");
}

export function openBrowserAt(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (error) {
    log(`failed to open browser: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function runningUi(): UiServerHandle | null {
  return running ? running.handle : null;
}

export { readConfigFile, path };
