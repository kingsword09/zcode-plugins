import { spawn } from "node:child_process";

/**
 * Discovery and pane creation use short-lived terminal-browser processes.
 * Browser tabs live in its daemon; cached CDP connections and diagnostics
 * live in this MCP process, while recording jobs persist on disk.
 */
export const TERMINAL_BROWSER = "terminal-browser";

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function run(
  args: string[],
  options: { timeoutMs?: number; binary?: string } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const binary = options.binary ?? TERMINAL_BROWSER;
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        ok: false,
        code: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = code ?? -1;
      resolve({ ok: !timedOut && exitCode === 0, code: exitCode, stdout, stderr, timedOut });
    });
  });
}

/**
 * terminal-browser splits panes relative to the terminal tab it was invoked
 * from, so stdout of the MCP process must stay protocol-clean — never forward
 * its output to the zcode TUI directly. Tools return it as text content and
 * the model relays what matters.
 */
export function description(
  result: RunResult,
  fallback: string,
): string {
  const err = result.stderr.trim();
  if (err) return err;
  const out = result.stdout.trim();
  if (out) return out;
  return fallback;
}

export const INSTALL_HINT = [
  "terminal-browser is not installed or not on PATH.",
  "Install it first (macOS & Linux):",
  "  curl -fsSL https://terminal-browser.sh/install | bash",
  "then open a NEW terminal so PATH updates apply, and make sure the current",
  "terminal supports pane splitting (ghostty, kitty, tmux, wezterm, vscode, cmux).",
  "Docs: https://github.com/zenbu-labs/terminal-browser",
].join("\n");

/**
 * Detect the classic "command not found" shapes across platforms so callers
 * can route the user to the install instructions instead of a raw error.
 */
export function isSpawnNotFound(result: RunResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (result.code === 127) return true; // posix shell: command not found
  return (
    text.includes("enoent") ||
    text.includes("command not found") ||
    text.includes("not found in $path") ||
    text.includes("not found: terminal-browser") ||
    text.includes("no such file")
  );
}
