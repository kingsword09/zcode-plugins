export const PRODUCTION_ORIGIN = "https://zcode.z.ai";
export const TEST_ORIGIN = "https://zcode.chatglm.site";

export const CREDENTIALS_PATH_KEYS = {
  activeProvider: "oauth:active_provider",
  zaiAccessToken: "oauth:zai:access_token",
  zaiRefreshToken: "oauth:zai:refresh_token",
  zaiUserInfo: "oauth:zai:user_info",
  zcodeJwtToken: "zcodejwttoken",
} as const;

export const CIPHER_PREFIX = "enc:v1:";
export const CIPHER_ALGO = "aes-256-gcm";
export const CREDENTIAL_SECRET_ENV = "ZCODE_CREDENTIAL_SECRET";

export const ALIYUN_CAPTCHA_SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
export const CAPTCHA_HEADER_PARAM = "x-aliyun-captcha-verify-param";
export const CAPTCHA_HEADER_REGION = "x-aliyun-captcha-verify-region";

export const CAPTCHA_CONFIG_CACHE_MS = 60_000;
export const CAPTCHA_INTERACTIVE_TIMEOUT_MS = 120_000;
export const BUSY_RETRY_DELAYS_MS = [1_000, 2_000];
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export const DEFAULT_START_PLAN_MODELS = ["GLM-5.3", "GLM-5-Turbo"] as const;

export function resolveOrigin(env: Record<string, string | undefined> = process.env): string {
  const override = env.ZCODE_BASE_URL?.trim() || env.ZCODE_ENDPOINT_ORIGIN?.trim();
  if (override) return override.replace(/\/+$/u, "");
  if ((env.ZCODE_ENV ?? "").trim().toLowerCase() === "test") return TEST_ORIGIN;
  return PRODUCTION_ORIGIN;
}

export function anthropicMessagesUrl(origin: string): string {
  return `${origin}/api/v1/zcode-plan/anthropic/v1/messages`;
}

export function billingBalanceUrl(origin: string): URL {
  return new URL(`${origin}/api/v1/zcode-plan/billing/balance`);
}

export function clientConfigsUrl(origin: string): URL {
  return new URL(`${origin}/api/v1/client/configs`);
}
