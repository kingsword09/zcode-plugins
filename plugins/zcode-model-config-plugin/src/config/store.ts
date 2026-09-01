import * as fs from "node:fs";
import * as path from "node:path";
import { validateModelConfig } from "./schema.ts";
import type { ModelConfigFile } from "../shared/types.ts";

export interface SaveResult {
  ok: true;
  path: string;
  backupPath: string | null;
}

export class ConfigStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigStoreError";
  }
}

/** Keys this editor owns; everything else is preserved untouched on save. */
const MODEL_KEYS = new Set(["provider", "model", "modelCatalog"]);

/**
 * Merge the editor's model keys into an existing config file (or a fresh
 * object when the file does not exist yet). Keys outside MODEL_KEYS are kept
 * verbatim so we never clobber unrelated user settings.
 */
export function mergeIntoConfig(existing: unknown, modelConfig: ModelConfigFile): ModelConfigFile {
  const base = (existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}) as Record<
    string,
    unknown
  >;
  const merged: Record<string, unknown> = { ...base };
  for (const key of MODEL_KEYS) {
    if (modelConfig[key] !== undefined) {
      merged[key] = modelConfig[key];
    } else if (key === "model" || key === "provider" || key === "modelCatalog") {
      // Explicit deletion support: keep absent only when caller omitted key
      // *and* it was absent before; otherwise preserve prior value.
      if (key in base && modelConfig[key] === undefined && !(key in modelConfig)) continue;
    }
  }
  return merged as ModelConfigFile;
}

export interface ReadConfigResult {
  config: ModelConfigFile;
  raw: string | null;
}

export function readConfigFile(filePath: string): ReadConfigResult {
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { config: {}, raw: null };
  }
  try {
    return { config: JSON.parse(raw) as ModelConfigFile, raw };
  } catch (error) {
    throw new ConfigStoreError(
      `${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Atomically write the model keys into the config file at filePath.
 * - validates via zod before touching disk
 * - writes `<path>.bak` next to the original when it existed
 * - tmp-file + rename, 2-space indent, trailing newline, mode 0600
 */
export function saveModelConfig(
  filePath: string,
  modelConfig: ModelConfigFile,
  deps: { readConfig?: (p: string) => ReadConfigResult } = {},
): SaveResult {
  validateModelConfig(modelConfig);

  const read = deps.readConfig ?? readConfigFile;
  const existing = read(filePath);
  const merged = mergeIntoConfig(existing.config, modelConfig);

  let backupPath: string | null = null;
  if (existing.raw !== null) {
    backupPath = `${filePath}.bak`;
    fs.writeFileSync(backupPath, existing.raw, { mode: 0o600 });
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod can fail on exotic filesystems; rename already carried 0600.
  }

  return { ok: true, path: filePath, backupPath };
}
