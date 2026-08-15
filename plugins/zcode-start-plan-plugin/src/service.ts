import {
  anthropicMessagesUrl,
  BUSY_RETRY_DELAYS_MS,
  CAPTCHA_HEADER_PARAM,
  CAPTCHA_HEADER_REGION,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "./constants.ts";
import { StartPlanClient, StartPlanHttpError, type StartPlanBalance } from "./client.ts";
import { acquireCaptchaParam, type CaptchaVerification } from "./captcha.ts";

export class ProviderBusinessError extends Error {
  readonly providerCode: string | null;
  readonly status: number | null;
  readonly bodySummary: string;
  constructor(options: { providerCode?: string | null; status?: number | null; bodySummary?: string; message: string }) {
    super(options.message);
    this.name = "ProviderBusinessError";
    this.providerCode = options.providerCode ?? null;
    this.status = options.status ?? null;
    this.bodySummary = options.bodySummary ?? "";
  }
}

export interface GenerateOptions {
  model: string;
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  captcha?: CaptchaVerification | null;
  maxBusyRetries?: number;
  timeoutMs?: number;
  logger?: (message: string) => void;
}

export interface GenerateResult {
  text: string;
  model: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface StartPlanServiceOptions {
  bearerToken: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export class StartPlanService {
  readonly client: StartPlanClient;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: StartPlanServiceOptions) {
    this.client = new StartPlanClient({ env: options.env, bearerToken: options.bearerToken, fetchImpl: options.fetchImpl });
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async checkEntitlement(): Promise<{ entitled: boolean; models: string[]; plans: StartPlanBalance["plans"] }> {
    const balance = await this.client.fetchBalance();
    return { entitled: this.client.hasActiveStartPlan(balance), models: balance.models, plans: balance.plans };
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const logger = options.logger ?? (() => {});
    let attempt = 0;
    let captcha = options.captcha ?? null;
    for (;;) {
      attempt += 1;
      try {
        return await this.generateOnce(options, captcha);
      } catch (error) {
        const busy = busyProviderCode(error);
        const busyDelays = BUSY_RETRY_DELAYS_MS.slice(
          0,
          Math.max(0, (options.maxBusyRetries ?? BUSY_RETRY_DELAYS_MS.length) ),
        );
        if (busy && attempt <= busyDelays.length) {
          const delay = busyDelays[attempt - 1];
          logger(`Start Plan busy (${busy}); retrying in ${delay} ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        if (error instanceof ProviderBusinessError && error.providerCode === "3007") {
          if (captcha || options.captcha === null) {
            logger("captcha verify failed (3007); acquiring a fresh captcha param via the local bridge");
            const config = await this.client.getCaptchaConfig(true);
            if (!config) {
              throw new ProviderBusinessError({
                providerCode: "3007",
                message:
                  "Start Plan rejected the request with captcha code 3007 and the captcha config endpoint returned no configuration.",
              });
            }
            captcha = await acquireCaptchaParam({ config, logger });
            continue;
          }
        }
        throw error;
      }
    }
  }

  private async generateOnce(options: GenerateOptions, captcha: CaptchaVerification | null): Promise<GenerateResult> {
    const url = anthropicMessagesUrl(this.client.origin);
    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: [{ role: "user", content: options.prompt }],
    };
    if (options.system) body.system = options.system;
    if (typeof options.temperature === "number") body.temperature = options.temperature;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${this.bearerToken}`,
      "anthropic-version": "2023-06-01",
    };
    if (captcha) {
      headers[CAPTCHA_HEADER_PARAM] = captcha.param;
      headers[CAPTCHA_HEADER_REGION] = captcha.region;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = null;
    }

    if (response.ok && payload) {
      const errorObj = payload.error as Record<string, unknown> | undefined;
      if (errorObj && typeof errorObj.message === "string") {
        throw toBusinessError(errorObj, response.status, text);
      }
      const content = Array.isArray(payload.content) ? (payload.content as Array<Record<string, unknown>>) : [];
      const textParts = content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string);
      const usage = payload.usage as Record<string, number> | undefined;
      if (textParts.length === 0) {
        // The desktop runtime treats empty streams with a captcha header as a 3007 captcha failure.
        if (captcha) {
          throw new ProviderBusinessError({
            providerCode: "3007",
            status: 403,
            bodySummary: summarize(text),
            message: "Captcha verification failed or the verify token was rejected.",
          });
        }
        throw new ProviderBusinessError({
          status: response.status,
          bodySummary: summarize(text),
          message: "Start Plan returned an empty completion.",
        });
      }
      return {
        text: textParts.join("\n"),
        model: typeof payload.model === "string" ? payload.model : options.model,
        stopReason: typeof payload.stop_reason === "string" ? payload.stop_reason : null,
        usage: usage
          ? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
          : null,
      };
    }

    throw toBusinessError(payload ?? {}, response.status, text);
  }
}

function toBusinessError(
  source: Record<string, unknown>,
  status: number,
  rawBody: string,
): ProviderBusinessError {
  const nested = typeof source.error === "object" && source.error !== null
    ? (source.error as Record<string, unknown>)
    : source;
  const code =
    typeof nested.providerCode === "string"
      ? nested.providerCode
      : typeof nested.code === "string" || typeof nested.code === "number"
        ? String(nested.code)
        : null;
  const message =
    typeof nested.message === "string"
      ? nested.message
      : typeof nested.msg === "string"
        ? nested.msg
        : `Start Plan request failed with HTTP ${status}`;
  return new ProviderBusinessError({
    providerCode: code,
    status,
    bodySummary: summarize(rawBody),
    message,
  });
}

function busyProviderCode(error: unknown): string | null {
  if (error instanceof ProviderBusinessError && error.providerCode) {
    return ["3008", "3009", "3010"].includes(error.providerCode) ? error.providerCode : null;
  }
  return null;
}

function summarize(body: string): string {
  return body.length > 500 ? `${body.slice(0, 500)}…` : body;
}
