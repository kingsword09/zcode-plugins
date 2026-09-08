import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveModelConfig } from "../src/config/store.ts";

describe("backup file permissions (P1: API key leak)", () => {
  test("pre-existing 0644 .bak gets replaced with 0600", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-bak-"));
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ provider: { p: { apiKey: "secret" } } }), { mode: 0o600 });
    // simulate a legacy world-readable backup
    fs.writeFileSync(`${cfg}.bak`, "old", { mode: 0o644 });
    fs.chmodSync(`${cfg}.bak`, 0o644);

    saveModelConfig(cfg, { provider: {}, model: {} } as never);
    const mode = (fs.statSync(`${cfg}.bak`).mode & 0o777).toString(8);
    expect(mode).toBe("600");
    const cfgMode = (fs.statSync(cfg).mode & 0o777).toString(8);
    expect(cfgMode).toBe("600");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("backup written to a symlinked path is replaced, not followed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-bak-sym-"));
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ provider: {} }), { mode: 0o600 });
    const victim = path.join(dir, "victim.json");
    fs.writeFileSync(victim, "do not touch", { mode: 0o600 });
    fs.symlinkSync(victim, `${cfg}.bak`);

    saveModelConfig(cfg, { provider: {}, model: {} } as never);
    // the victim file content must be untouched; the .bak path is now a regular 0600 file
    expect(fs.readFileSync(victim, "utf8")).toBe("do not touch");
    expect(fs.lstatSync(`${cfg}.bak`).isSymbolicLink()).toBe(false);
    expect((fs.statSync(`${cfg}.bak`).mode & 0o777).toString(8)).toBe("600");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
