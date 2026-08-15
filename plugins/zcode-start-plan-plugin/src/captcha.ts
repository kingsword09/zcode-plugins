import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ALIYUN_CAPTCHA_SDK_URL,
  CAPTCHA_INTERACTIVE_TIMEOUT_MS,
} from "./constants.ts";
import type { CaptchaConfig } from "./client.ts";

export type { CaptchaConfig };

export interface CaptchaBridgeOptions {
  config: CaptchaConfig;
  timeoutMs?: number;
  openBrowser?: boolean;
  language?: "cn" | "en";
  logger?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

export interface CaptchaVerification {
  param: string;
  region: string;
  interactive: boolean;
}

export class CaptchaBridgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CaptchaBridgeError";
  }
}

export function buildCaptchaPage(config: CaptchaConfig, options: { language: "cn" | "en"; postUrl: string }): string {
  return `<!doctype html>
<html lang="${options.language === "cn" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ZCode Start Plan captcha</title>
<style>
  body { font-family: -apple-system, "SF Pro Text", sans-serif; margin: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; background: #0f1117; color: #e6e8ef; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
  p { font-size: 13px; color: #9aa1b2; margin: 0 0 18px; text-align: center; padding: 0 24px; }
  #captcha-element { min-height: 60px; }
  #captcha-button { visibility: hidden; position: absolute; }
  #status { margin-top: 18px; font-size: 13px; color: #6ee7a8; }
</style>
</head>
<body>
<h1>ZCode Start Plan &mdash; human verification</h1>
<p id="hint">This one-time Aliyun captcha lets the ZCode CLI use your free Start Plan trial quota. It closes itself when done.</p>
<div id="captcha-element"></div>
<button id="captcha-button" type="button">verify</button>
<div id="status"></div>
<script src="${ALIYUN_CAPTCHA_SDK_URL}"></script>
<script>
(function () {
  var postUrl = ${JSON.stringify(options.postUrl)};
  var cfg = ${JSON.stringify({ region: config.region, prefix: config.prefix, sceneId: config.sceneId, language: options.language })};
  var statusEl = document.getElementById("status");
  var settled = false;
  function setStatus(text) { statusEl.textContent = text; }
  window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };
  var instance = null;
  function challenge() {
    try {
      if (instance && typeof instance.show === "function") { instance.show(); return; }
      document.getElementById("captcha-button").click();
    } catch (error) {
      setStatus("Captcha failed to display; press reload.");
      setStatus("Captcha failed to display; reload this page.");
      void error;
    }
  }
  function report(param) {
    if (settled) return;
    settled = true;
    setStatus("Verification complete. You can close this tab.");
    fetch(postUrl, { method: "POST", body: param })
      .catch(function () { setStatus("Failed to deliver result; please retry."); settled = false; });
  }
  function init() {
    if (typeof window.initAliyunCaptcha !== "function") {
      setStatus("Captcha SDK failed to load; check your network and reload.");
      return;
    }
    window.initAliyunCaptcha({
      SceneId: cfg.sceneId,
      mode: "popup",
      language: cfg.language,
      showErrorTip: false,
      element: "#captcha-element",
      button: "#captcha-button",
      getInstance: function (captured) {
        instance = captured;
        try {
          if (typeof captured.startTracelessVerification === "function") {
            captured.startTracelessVerification();
            return;
          }
        } catch (error) { void error; }
        challenge();
      },
      success: function (param) { report(typeof param === "string" ? param : String(param ?? "")); },
      fail: function () { if (!settled) challenge(); },
      onError: function () { if (!settled) challenge(); }
    });
  }
  init();
})();
</script>
</body>
</html>`;
}

function openInBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // The URL is printed as a fallback.
  }
}

export async function acquireCaptchaParam(options: CaptchaBridgeOptions): Promise<CaptchaVerification> {
  const timeoutMs = options.timeoutMs ?? CAPTCHA_INTERACTIVE_TIMEOUT_MS;
  const logger = options.logger ?? (() => {});
  const config = options.config;
  if (!config.enabled || !config.region || !config.prefix || !config.sceneId) {
    throw new CaptchaBridgeError(
      "Aliyun captcha is not enabled for the Start Plan endpoint; the server should accept requests without a captcha param.",
    );
  }

  let server: Server | null = null;
  let resolved: ((value: CaptchaVerification) => void) | null = null;
  let rejected: ((error: Error) => void) | null = null;
  const result = new Promise<CaptchaVerification>((resolve, reject) => {
    resolved = resolve;
    rejected = reject;
  });
  const resultPromise = result;
  let settledFlag = false;

  const finish = (fn: () => void) => {
    if (settledFlag) return;
    settledFlag = true;
    fn();
    if (server) {
      server.close();
      server = null;
    }
  };

  try {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = buildCaptchaPage(config, {
          language: options.language ?? "cn",
          postUrl: "/callback",
        });
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      if (request.method === "POST" && url.pathname === "/callback") {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const param = Buffer.concat(chunks).toString("utf-8").trim();
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: Boolean(param) }));
          if (param) {
            finish(() => {
              (resolved as unknown as ((v: CaptchaVerification) => void))?.({
                param,
                region: config.region,
                interactive: true,
              });
            });
          }
        });
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
    });

    await new Promise<void>((resolve, reject) => {
      const created = server as Server;
      created.once("error", reject);
      created.listen(0, "127.0.0.1", () => resolve());
    });

    const address = (server as Server).address();
    if (typeof address !== "object" || address === null) {
      throw new CaptchaBridgeError("Failed to bind the local captcha bridge server.");
    }
    const url = `http://127.0.0.1:${address.port}/`;
    logger(`captcha bridge listening at ${url}`);
    if (options.openBrowser !== false) {
      openInBrowser(url);
    } else {
      logger(`open ${url} in a browser to complete verification`);
    }

    const timer = setTimeout(() => {
      finish(() => {
        (rejected as unknown as ((e: Error) => void))?.(
          new CaptchaBridgeError(
            `Captcha verification timed out after ${timeoutMs} ms. Re-run the tool and complete the challenge in the opened browser tab.`,
          ),
        );
      });
    }, timeoutMs);
    timer.unref?.();

    return await resultPromise;
  } finally {
    if (server) server.close();
    await sleep(0);
  }
}
