/**
 * Vercel AI Gateway model catalog (https://ai-gateway.vercel.sh/v1/models).
 * Same source aicode uses: OpenAI list shape, `id` is "owner/model",
 * capabilities come straight from `supported_parameters` / `tags` /
 * `modalities` — no inference required.
 */

export interface GatewayModel {
  /** "owner/model" as exposed by the gateway. */
  id: string;
  name?: string;
  owner?: string;
  /** Model part of the id (after the first "/"), suitable as a config key. */
  modelKey: string;
  contextWindow?: number;
  maxOutput?: number;
  image: boolean;
  reasoning: boolean;
  tools: boolean;
}

export interface GatewayRawModel {
  id?: string;
  name?: string;
  owned_by?: string;
  context_window?: number;
  max_tokens?: number;
  type?: string;
  tags?: string[];
  supported_parameters?: string[];
  modalities?: { input?: string[]; output?: string[] };
}

export class GatewayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GatewayError";
  }
}

export const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_MODELS = 10_000;

function bool(list: string[] | undefined, ...names: string[]): boolean {
  if (!list) return false;
  return names.some((n) => list.includes(n));
}

export function normalizeGatewayModel(raw: GatewayRawModel): GatewayModel | null {
  if (!raw.id || raw.id.length === 0 || raw.id.length > 256) return null;
  if (raw.type !== undefined && raw.type !== "language") return null;
  if ((raw.context_window ?? 1) === 0 || (raw.max_tokens ?? 1) === 0) return null;
  const slash = raw.id.indexOf("/");
  const owner = raw.owned_by ?? (slash > 0 ? raw.id.slice(0, slash) : undefined);
  const modelKey = slash > 0 ? raw.id.slice(slash + 1) : raw.id;
  const params = raw.supported_parameters;
  const tags = raw.tags;
  const inputModality = raw.modalities?.input;
  return {
    id: raw.id,
    name: raw.name || undefined,
    owner,
    modelKey,
    contextWindow: raw.context_window,
    maxOutput: raw.max_tokens,
    image:
      bool(inputModality, "image") ||
      bool(tags, "vision", "file-input") ||
      bool(params, "file-input", "image-input"),
    reasoning: bool(params, "reasoning", "include_reasoning") || bool(tags, "reasoning"),
    tools: bool(params, "tools", "tool_choice") || bool(tags, "tool-use"),
  };
}

export function parseGatewayModels(payload: unknown): GatewayModel[] {
  if (!payload || typeof payload !== "object" || (payload as { object?: string }).object !== "list") {
    throw new GatewayError("unexpected gateway response shape");
  }
  const data = (payload as { data?: GatewayRawModel[] }).data ?? [];
  const out: GatewayModel[] = [];
  for (const raw of data.slice(0, MAX_MODELS)) {
    const normalized = normalizeGatewayModel(raw);
    if (normalized) out.push(normalized);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export class GatewayClient {
  private cache: { models: GatewayModel[]; fetchedAt: number } | null = null;
  private inflight: Promise<GatewayModel[]> | null = null;

  constructor(
    private readonly deps: {
      url?: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
      ttlMs?: number;
    } = {},
  ) {}

  async models(options: { force?: boolean } = {}): Promise<GatewayModel[]> {
    const now = this.deps.now ?? Date.now;
    const ttl = this.deps.ttlMs ?? CACHE_TTL_MS;
    if (!options.force && this.cache && now() - this.cache.fetchedAt < ttl) {
      return this.cache.models;
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const fetchImpl = this.deps.fetchImpl ?? fetch;
      const response = await fetchImpl(this.deps.url ?? GATEWAY_MODELS_URL, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new GatewayError(`AI Gateway request failed: HTTP ${response.status}`);
      }
      const models = parseGatewayModels(await response.json());
      this.cache = { models, fetchedAt: now() };
      return models;
    })();

    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }
}
