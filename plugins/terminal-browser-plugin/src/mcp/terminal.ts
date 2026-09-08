import { randomUUID } from "node:crypto";
import net from "node:net";
import { run, isSpawnNotFound, INSTALL_HINT } from "./cli.ts";
import { z } from "zod";
import { BrowserError } from "./errors.ts";

export interface TabInfo {
  id: number;
  url: string;
  title: string;
  active: boolean;
  targetId: string | null;
  agentControlled?: boolean;
}

export interface BrowserInfo {
  key: string;
  pid: number;
  cdpPort: number | null;
  socket: string;
  splitDir: string | null;
  inCurrentTab: boolean;
  tabs: TabInfo[];
  startedAt?: number;
}

const tabSchema = z.object({
  id: z.number().int().positive(),
  url: z.string(),
  title: z.string().default(""),
  active: z.boolean(),
  targetId: z.string().nullable().default(null),
  agentControlled: z.boolean().optional(),
});

const browserSchema = z.object({
  key: z.string().min(1),
  pid: z.number().int().positive(),
  cdpPort: z.number().int().min(1).max(65535).nullable().default(null),
  socket: z.string().min(1),
  splitDir: z.string().nullable().default(null),
  inCurrentTab: z.boolean().default(false),
  tabs: z.array(tabSchema),
  startedAt: z.number().optional(),
});

export function parseBrowsers(value: unknown): BrowserInfo[] {
  const parsed = z.object({ browsers: z.array(browserSchema) }).safeParse(value);
  if (!parsed.success) throw new BrowserError("incompatible_browser", "terminal-browser returned an incompatible instance registry.", "Run browser_status and update terminal-browser if necessary.");
  return parsed.data.browsers;
}

export function parseTabs(value: unknown): TabInfo[] {
  const parsed = z.object({ tabs: z.array(tabSchema) }).safeParse(value);
  if (!parsed.success) throw new BrowserError("incompatible_browser", "terminal-browser returned an incompatible tab registry.");
  return parsed.data.tabs;
}

export function selectBrowser(browsers: BrowserInfo[], browserId?: string): BrowserInfo {
  const candidates = browserId === undefined
    ? browsers.filter((browser) => browser.inCurrentTab)
    : browsers.filter((browser) => browser.key === browserId);
  if (candidates.length === 0) {
    throw new BrowserError("browser_not_found", browserId ? `Browser '${browserId}' is unavailable.` : "No browser in the current terminal tab.", "Use browser_list, then pass an exact browserId or open a pane with browser_open.");
  }
  if (candidates.length !== 1) {
    throw new BrowserError("ambiguous_browser", `Multiple browsers match: ${candidates.map((browser) => browser.key).join(", ")}.`, "Pass browserId from browser_list.");
  }
  return candidates[0]!;
}

/**
 * terminal-browser state discovery + instance control socket.
 *
 * Page interaction goes through playwright-core over the CDP endpoint
 * (playwright.ts); the control socket is only needed for what Electron's
 * CDP cannot do: creating/closing/activating tabs (Target.createTarget is
 * rejected) and the agent indicator. No agent-browser anywhere.
 */
export async function listBrowsers(): Promise<BrowserInfo[]> {
  const result = await run(["ls", "--all", "--json"], { timeoutMs: 15_000 });
  if (!result.ok) {
    if (isSpawnNotFound(result)) throw new BrowserError("not_installed", INSTALL_HINT);
    throw new BrowserError("discovery_failed", `terminal-browser ls failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
  }
  return parseBrowsers(JSON.parse(result.stdout));
}

export async function control<T = unknown>(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const connection = net.connect(socketPath);
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("control request timed out"));
    }, timeoutMs);
    let buffer = "";
    let settled = false;
    connection.setEncoding("utf8");
    connection.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        settled = true;
        clearTimeout(timer);
        connection.destroy();
        reject(new BrowserError("invalid_response", "Browser control response exceeded 4 MB."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as {
          id?: string | null;
          ok: boolean;
          data?: unknown;
          error?: string;
        };
        if (!response.ok) reject(new Error(response.error ?? "control request failed"));
        else if (response.id !== id) reject(new Error("response id mismatch"));
        else resolve(response.data as T);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    connection.on("close", () => {
      clearTimeout(timer);
      if (!settled) reject(new BrowserError("browser_disconnected", "Browser control socket closed before replying."));
    });
    connection.write(`${JSON.stringify({ id, ...request })}\n`);
  });
}

/**
 * Whether a same-site tab exists that the navigation should reuse.
 * Pure predicate over terminal-browser's authoritative tab list; the actual
 * navigation is performed by the caller (playwright page.goto).
 */
export function findReusableTab(
  browser: BrowserInfo,
  url: string,
): TabInfo | undefined {
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (!hostname) return undefined;
  const matches = browser.tabs.filter((t) => {
    try {
      return new URL(t.url).hostname === hostname;
    } catch {
      return false;
    }
  });
  const active = matches.find((tab) => tab.active);
  if (active) return active;
  if (matches.length > 1) throw new BrowserError("ambiguous_tab", "Multiple same-site tabs exist.", "Specify the intended tabId from browser_list.");
  return matches[0];
}
