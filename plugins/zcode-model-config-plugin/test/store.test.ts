import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readConfigFile, saveModelConfig } from "../src/config/store.ts";
import { ConfigValidationError } from "../src/config/schema.ts";

function tmpFile(initial?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-store-"));
  const file = path.join(dir, "config.json");
  if (initial !== undefined) fs.writeFileSync(file, initial);
  return file;
}

describe("readConfigFile", () => {
  test("returns empty config for missing file", () => {
    const result = readConfigFile("/nonexistent/path/config.json");
    expect(result.config).toEqual({});
    expect(result.raw).toBeNull();
  });

  test("parses existing JSON", () => {
    const file = tmpFile(JSON.stringify({ model: { main: "zai/glm-5.2" } }));
    const result = readConfigFile(file);
    expect(result.config.model?.main).toBe("zai/glm-5.2");
  });

  test("throws on invalid JSON", () => {
    const file = tmpFile("{not json");
    expect(() => readConfigFile(file)).toThrow(/not valid JSON/);
  });
});

describe("saveModelConfig", () => {
  test("writes a new file with only model keys, 0600, trailing newline", () => {
    const file = tmpFile();
    const result = saveModelConfig(file, {
      provider: { zai: { kind: "openai-compatible", options: { baseURL: "https://api.z.ai/api/paas/v4" }, models: { "glm-5.2": { name: "GLM-5.2" } } } },
      model: { main: "zai/glm-5.2", lite: "zai/glm-5-turbo" },
    });
    expect(result.backupPath).toBeNull();

    const raw = fs.readFileSync(file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(raw);
    expect(parsed.model.main).toBe("zai/glm-5.2");
    expect(Object.keys(parsed.provider.zai.models)).toEqual(["glm-5.2"]);
    expect((fs.statSync(file).mode & 0o777)).toBe(0o600);
  });

  test("preserves unrelated top-level keys and creates .bak backup", () => {
    const file = tmpFile(
      JSON.stringify({
        permission: { mode: "build" },
        provider: { old: { kind: "openai-compatible", options: { baseURL: "https://x/v1" } } },
      }),
    );
    saveModelConfig(file, {
      provider: { kimi: { kind: "openai-compatible", options: { baseURL: "https://x/v1" }, models: { "k2": {} } } },
      model: { main: "kimi/k2" },
    });

    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(parsed.permission).toEqual({ mode: "build" });
    expect(Object.keys(parsed.provider)).toEqual(["kimi"]);

    const backup = JSON.parse(fs.readFileSync(`${file}.bak`, "utf8"));
    expect(backup.provider.old).toBeDefined();
  });

  test("rejects invalid config before touching disk", () => {
    const file = tmpFile();
    expect(() =>
      saveModelConfig(file, {
        // model block is strict: unknown keys are rejected
        model: { main: "zai/glm-5.2", extra: "nope" } as never,
      }),
    ).toThrow(ConfigValidationError);
    expect(fs.existsSync(file)).toBe(false);
  });

  test("rejects model refs without provider/model format", () => {
    const file = tmpFile();
    expect(() => saveModelConfig(file, { model: { main: "glm-5.2" } })).toThrow(/provider\/model/);
    expect(fs.existsSync(file)).toBe(false);
  });

  test("rejects non-positive contextWindow / limit values", () => {
    const file = tmpFile();
    expect(() =>
      saveModelConfig(file, {
        provider: { p: { models: { m: { contextWindow: -5 } } } },
      }),
    ).toThrow(ConfigValidationError);
    expect(() =>
      saveModelConfig(file, {
        provider: { p: { models: { m: { limit: { context: 0 } } } } },
      }),
    ).toThrow(ConfigValidationError);
  });

  test("rejects provider.npm field (schema forbids it)", () => {
    const file = tmpFile();
    expect(() =>
      saveModelConfig(file, {
        provider: { p: { npm: "@ai-sdk/openai" } as never },
      }),
    ).toThrow(ConfigValidationError);
  });
});
