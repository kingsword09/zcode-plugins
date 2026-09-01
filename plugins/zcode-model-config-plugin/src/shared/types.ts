/**
 * Shared types for the zcode model-config config files, mirroring the zod
 * schema in src/config/schema.ts (which itself mirrors the ZCode CLI runtime).
 */

export type ProviderKind = "anthropic" | "openai" | "openai-compatible";

export type Modality = "text" | "audio" | "image" | "video" | "pdf";

export interface ProviderOptions {
  apiKey?: string;
  baseURL?: string;
  apiKeyRequired?: boolean;
  includeUsage?: boolean;
  timeout?: number | false;
  chunkTimeout?: number;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface ReasoningSpec {
  enabled?: boolean;
  levels?: string[];
  defaultLevel?: string;
  providerOptionsByLevel?: Record<string, Record<string, unknown>>;
}

export interface ModelEntry {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean | ReasoningSpec;
  temperature?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  supportsImages?: boolean;
  supportsPdf?: boolean;
  supportsVideo?: boolean;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
  supportsStructuredOutput?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  limit?: { context?: number; input?: number; output?: number };
  modalities?: { input?: Modality[]; output?: Modality[] };
  interleaved?: boolean | { field: string };
  reasoningContentField?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    [key: string]: unknown;
  };
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProviderEntry {
  api?: string;
  id?: string;
  kind?: ProviderKind;
  name?: string;
  options?: ProviderOptions;
  headers?: Record<string, string>;
  models?: Record<string, ModelEntry>;
  [key: string]: unknown;
}

/** The model-role block is strict in the runtime: only main / lite. */
export interface ModelRoles {
  main?: string;
  lite?: string;
}

export interface ModelCatalogOverrides {
  [providerSlashModel: string]: Record<string, unknown>;
}

/**
 * The subset of a zcode config file this editor owns. Everything else
 * (permission, storage, network, ...) is preserved verbatim on save.
 */
export interface ModelConfigFile {
  provider?: Record<string, ProviderEntry>;
  model?: ModelRoles;
  modelCatalog?: { overrides?: ModelCatalogOverrides };
  [key: string]: unknown;
}

export type ConfigScope = "user" | "project";

export interface ConfigFileInfo {
  scope: ConfigScope;
  path: string;
  exists: boolean;
  /** Which project file kind this is (user scope is always "user"). */
  kind: "user" | "zcode.json" | ".zcode/config.json";
  config: ModelConfigFile | null;
  parseError: string | null;
}

export interface ConfigState {
  user: ConfigFileInfo;
  project: ConfigFileInfo | null;
  projectRoot: string;
}
