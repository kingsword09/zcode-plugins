import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConfigFileInfo, ConfigScope, ModelConfigFile } from "../shared/types.ts";

export class ConfigPathError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigPathError";
  }
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ZCODE_CONFIG_DIR ?? env.ZCODE_HOME ?? env.HOME ?? os.homedir();
  if (!home) throw new ConfigPathError("Cannot determine home directory for user config");
  return path.join(home, ".zcode", "cli", "config.json");
}

export interface ProjectPaths {
  /** Preferred editable project file: .zcode/config.json */
  editable: string;
  /** Alternate project file the runtime also reads. */
  alternate: string;
}

export function projectPaths(projectRoot: string, env: NodeJS.ProcessEnv = process.env): ProjectPaths {
  const root = env.ZCODE_PROJECT_ROOT && path.isAbsolute(env.ZCODE_PROJECT_ROOT)
    ? env.ZCODE_PROJECT_ROOT
    : projectRoot;
  return {
    editable: path.join(root, ".zcode", "config.json"),
    alternate: path.join(root, "zcode.json"),
  };
}

function info(
  scope: ConfigScope,
  filePath: string,
  kind: ConfigFileInfo["kind"],
  readFile: (p: string) => string | null,
): ConfigFileInfo {
  const exists = readFile(filePath) !== null;
  let config: ModelConfigFile | null = null;
  let parseError: string | null = null;
  if (exists) {
    try {
      config = JSON.parse(readFile(filePath) as string) as ModelConfigFile;
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }
  return { scope, path: filePath, exists, kind, config: parseError ? null : config, parseError };
}

export interface ReadFileFn {
  (filePath: string): string | null;
}

/**
 * Resolve user + project config files for a given working directory.
 * The project scope prefers an existing file (zcode.json wins if it exists),
 * otherwise points at the editable .zcode/config.json for creation on save.
 */
export function resolveConfigInfos(
  projectRoot: string,
  deps: { env?: NodeJS.ProcessEnv; readFile?: ReadFileFn } = {},
): {
  user: ConfigFileInfo;
  project: ConfigFileInfo;
} {
  const readFile = deps.readFile ?? ((p: string) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  });
  const env = deps.env ?? process.env;

  const user = info("user", userConfigPath(env), "user", readFile);
  const paths = projectPaths(projectRoot, env);

  if (readFile(paths.editable) !== null) {
    return { user, project: info("project", paths.editable, ".zcode/config.json", readFile) };
  }
  if (readFile(paths.alternate) !== null) {
    return { user, project: info("project", paths.alternate, "zcode.json", readFile) };
  }
  return { user, project: info("project", paths.editable, ".zcode/config.json", readFile) };
}
