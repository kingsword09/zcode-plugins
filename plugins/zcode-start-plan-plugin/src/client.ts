import {
  billingBalanceUrl,
  CAPTCHA_CONFIG_CACHE_MS,
  clientConfigsUrl,
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveOrigin,
} from "./constants.ts";

const APP_VERSION = "3.7.7";

function clientPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export interface CaptchaConfig {
  enabled: boolean;
  region: string;
  prefix: string;
  sceneId: string;
}

export interface StartPlanBalance {
  plans: Array<{ name: string | null; planId: string | null; status: string | null }>;
  models: string[];
  raw: unknown;
}

export class StartPlanHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Start Plan endpoint returned HTTP ${status}`);
    this.name = "StartPlanHttpError";
    this.status = status;
    this.body = body;
  }
}

export interface StartPlanClientOptions {
  env?: Record<string, string | undefined>;
  bearerToken?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class StartPlanClient {
  readonly origin: string;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private captchaConfigCache: { value: CaptchaConfig | null; expiresAt: number } | null = null;

  constructor(options: StartPlanClientOptions) {
    this.origin = resolveOrigin(options.env);
    this.bearerToken = options.bearerToken ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async fetchJson(url: string | URL, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const text = await response.text();
      if (!response.ok) throw new StartPlanHttpError(response.status, text);
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new Error(`Start Plan endpoint returned non-JSON body from ${url}`, { cause: error });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async getCaptchaConfig(forceRefresh = false): Promise<CaptchaConfig | null> {
    const now = Date.now();
    if (!forceRefresh && this.captchaConfigCache && this.captchaConfigCache.expiresAt > now) {
      return this.captchaConfigCache.value;
    }
    const url = clientConfigsUrl(this.origin);
    url.searchParams.set("app_version", APP_VERSION);
    url.searchParams.set("platform", clientPlatformKey());
    const payload = (await this.fetchJson(url, { headers: { Accept: "application/json" } })) as
      | Record<string, unknown>
      | null;
    const configs = readPath(payload, ["data", "configs", "captcha"]) as Record<string, unknown> | null;
    const value = configs && typeof configs === "object"
      ? {
          enabled: configs.enabled !== false,
          region: typeof configs.region === "string" ? configs.region : "",
          prefix: typeof configs.prefix === "string" ? configs.prefix : "",
          sceneId: typeof configs.sceneId === "string" ? configs.sceneId : "",
        }
      : null;
    this.captchaConfigCache = { value, expiresAt: now + CAPTCHA_CONFIG_CACHE_MS };
    return value;
  }

  async fetchBalance(bearerToken = this.bearerToken): Promise<StartPlanBalance> {
    const url = billingBalanceUrl(this.origin);
    url.searchParams.set("app_version", APP_VERSION);
    const payload = (await this.fetchJson(url, {
      headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" },
    })) as Record<string, unknown> | null;
    const data = readPath(payload, ["data"]) as Record<string, unknown> | null;
    const plansRaw = (data?.plans ?? []) as Array<Record<string, unknown>>;
    const balancesRaw = (data?.balances ?? []) as Array<Record<string, unknown>>;
    const models: string[] = [];
    const seen = new Set<string>();
    for (const balance of balancesRaw) {
      const capabilities = Array.isArray(balance.capabilities) ? (balance.capabilities as unknown[]) : [];
      const capabilityModels = capabilities
        .map((item) => (typeof item === "string" && item.toLowerCase().startsWith("model:") ? item.slice(6).trim() : ""))
        .filter(Boolean);
      const names = capabilityModels.length > 0
        ? capabilityModels
        : typeof balance.show_name === "string" ? [balance.show_name] : [];
      for (const name of names) {
        const key = name.toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          models.push(name);
        }
      }
    }
    return {
      plans: plansRaw.map((plan) => ({
        name: typeof plan.name === "string" ? plan.name : null,
        planId: typeof plan.plan_id === "string" ? plan.plan_id : null,
        status: typeof plan.status === "string" ? plan.status : null,
      })),
      models,
      raw: payload,
    };
  }

  hasActiveStartPlan(balance: StartPlanBalance): boolean {
    return balance.plans.some((plan) => {
      const status = plan.status?.trim().toLowerCase();
      const identity = plan.planId ?? plan.name ?? "";
      const isStartPlan = identity.includes("start-plan") || identity.includes("start plan");
      return status === "active" && isStartPlan;
    });
  }
}

export function readPath(source: unknown, path: Array<string | number>): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return null;
    current = (current as Record<string | number, unknown>)[segment] ?? null;
  }
  return current;
}
