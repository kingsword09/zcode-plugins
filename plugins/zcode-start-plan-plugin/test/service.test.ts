import { describe, expect, test } from "bun:test";
import { resolveOrigin, anthropicMessagesUrl, billingBalanceUrl, clientConfigsUrl } from "../src/constants.ts";
import { StartPlanClient } from "../src/client.ts";
import { StartPlanService, ProviderBusinessError } from "../src/service.ts";

test("resolveOrigin honors env overrides", () => {
  expect(resolveOrigin({})).toBe("https://zcode.z.ai");
  expect(resolveOrigin({ ZCODE_ENV: "test" })).toBe("https://zcode.chatglm.site");
  expect(resolveOrigin({ ZCODE_BASE_URL: "https://example.com/" })).toBe("https://example.com");
});

test("url builders", () => {
  expect(anthropicMessagesUrl("https://zcode.z.ai")).toBe(
    "https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages",
  );
  expect(billingBalanceUrl("https://zcode.z.ai").href).toBe(
    "https://zcode.z.ai/api/v1/zcode-plan/billing/balance",
  );
  expect(clientConfigsUrl("https://zcode.z.ai").href).toBe("https://zcode.z.ai/api/v1/client/configs");
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

test("client parses balance models and entitlement", async () => {
  const client = new StartPlanClient({
    bearerToken: "jwt",
    fetchImpl: (async (url: string | URL | Request) =>
      jsonResponse({
        data: {
          plans: [{ name: "ZCode Start Plan", plan_id: "start-plan-monthly", status: "active" }],
          balances: [
            { show_name: "GLM-5.3", capabilities: [] },
            { show_name: "ignored", capabilities: ["model:GLM-5-Turbo", "other"] },
          ],
        },
      })) as unknown as typeof fetch,
  });
  const balance = await client.fetchBalance();
  expect(balance.models).toEqual(["GLM-5.3", "GLM-5-Turbo"]);
  expect(client.hasActiveStartPlan(balance)).toBe(true);
});

test("client reads captcha config with caching", async () => {
  let calls = 0;
  const client = new StartPlanClient({
    bearerToken: "jwt",
    fetchImpl: (async () => {
      calls += 1;
      return jsonResponse({ data: { configs: { captcha: { enabled: true, region: "cn", prefix: "x", sceneId: "s" } } } });
    }) as unknown as typeof fetch,
  });
  const first = await client.getCaptchaConfig();
  const second = await client.getCaptchaConfig();
  expect(first?.sceneId).toBe("s");
  expect(second?.sceneId).toBe("s");
  expect(calls).toBe(1);
});

test("service maps error envelope to ProviderBusinessError", async () => {
  const service = new StartPlanService({
    bearerToken: "jwt",
    fetchImpl: (async () =>
      jsonResponse({ error: { code: "3007", message: "captcha verify failed" } }, 200)) as unknown as typeof fetch,
  });
  try {
    await service.generate({ model: "GLM-5.3", prompt: "hi", captcha: null, maxBusyRetries: 0 });
    throw new Error("expected generate to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderBusinessError);
    expect((error as ProviderBusinessError).providerCode).toBe("3007");
  }
});

test("service returns text content on success", async () => {
  const service = new StartPlanService({
    bearerToken: "jwt",
    fetchImpl: (async () =>
      jsonResponse({
        model: "GLM-5.3",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hello" }],
        usage: { input_tokens: 3, output_tokens: 2 },
      })) as unknown as typeof fetch,
  });
  const result = await service.generate({ model: "GLM-5.3", prompt: "hi", maxBusyRetries: 0 });
  expect(result.text).toBe("hello");
  expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
});
