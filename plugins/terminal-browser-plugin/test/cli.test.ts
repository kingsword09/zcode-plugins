import { describe, expect, test } from "bun:test";
import { INSTALL_HINT, isSpawnNotFound, run, TERMINAL_BROWSER } from "../src/mcp/cli.ts";

describe("isSpawnNotFound", () => {
  test("detects posix command-not-found", () => {
    expect(
      isSpawnNotFound({ ok: false, code: 127, stdout: "", stderr: "zsh: command not found: terminal-browser", timedOut: false }),
    ).toBe(true);
  });

  test("detects node ENOENT spawn error", () => {
    expect(
      isSpawnNotFound({ ok: false, code: -1, stdout: "", stderr: "spawn terminal-browser ENOENT", timedOut: false }),
    ).toBe(true);
  });

  test("a real CLI failure is not treated as missing binary", () => {
    expect(
      isSpawnNotFound({ ok: false, code: 1, stdout: "", stderr: "no terminal browser in this terminal tab", timedOut: false }),
    ).toBe(false);
  });

  test("timeout is not treated as missing binary", () => {
    expect(
      isSpawnNotFound({ ok: false, code: -1, stdout: "", stderr: "", timedOut: true }),
    ).toBe(false);
  });

  test("success is not treated as missing binary", () => {
    expect(
      isSpawnNotFound({ ok: true, code: 0, stdout: "ok", stderr: "", timedOut: false }),
    ).toBe(false);
  });
});

describe("run", () => {
  // run() targets the real `terminal-browser` binary, which may or may not be
  // installed in the environment running the tests. These tests assert the
  // resolution contract, not the environment.

  test("resolves (never rejects), success or failure", async () => {
    const result = await run(["--version"], { timeoutMs: 10_000 });
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    if (result.ok) {
      // installed: --version exits 0 with a version line on stdout
      expect(result.code).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    } else {
      // not installed: must be classified as missing-binary so tools route
      // the user to the install instructions
      expect(isSpawnNotFound(result)).toBe(true);
    }
  });

  test("not-found classification is consistent with the binary's presence", async () => {
    const result = await run(["ls"], { timeoutMs: 10_000 });
    // `ls` fails when the daemon is absent even with the binary installed;
    // only a missing binary may be classified as not-found.
    if (!result.ok) {
      const binaryExists = process.env.PATH?.split(":").some((dir) => {
        try {
          const fs = require("node:fs");
          return fs.existsSync(`${dir}/terminal-browser`);
        } catch {
          return false;
        }
      });
      if (!binaryExists) {
        expect(isSpawnNotFound(result)).toBe(true);
      }
      // no assertion when the binary exists: `ls` may fail for other reasons
    }
  });
});

describe("constants", () => {
  test("binary name", () => {
    expect(TERMINAL_BROWSER).toBe("terminal-browser");
  });

  test("install hint mentions the install one-liner and repo", () => {
    expect(INSTALL_HINT).toContain("terminal-browser.sh/install");
    expect(INSTALL_HINT).toContain("zenbu-labs/terminal-browser");
  });
});
