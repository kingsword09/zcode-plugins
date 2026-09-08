#!/usr/bin/env node
import { promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { Page } from "playwright-core";
import { INSTALL_HINT, isSpawnNotFound, run } from "./cli.ts";
import { selectBrowser, parseTabs, findReusableTab } from "./terminal.ts";
import { BrowserRuntime, ACTION_TIMEOUT, NAVIGATION_TIMEOUT, type PageCall, type PageOptions, type RuntimeOptions } from "./runtime.ts";
import { BrowserError, errorDetails, withTimeout } from "./errors.ts";
import { normalizeUrl } from "./urls.ts";
import { targetFields, targetSchema, hasTarget, resolveTarget, uniqueTarget, targetRoot } from "./targets.ts";
import { actionSchema, executeAction, modifiersSchema, pointSchema, targetFromFlat } from "./actions.ts";
import { captureScreenshot, snapshot, readDialogs, respondToDialog, watchDialogs, prepareDialogs, dialogAwareAction, runAccessibility } from "./playwright.ts";
import { readConsole, readErrors, readNetwork, watchPage, startHar, stopHar, performanceMetrics, startProfile, stopProfile } from "./diagnostics.ts";
import { ArtifactStore } from "./artifacts.ts";
import { PageEnvironment } from "./environment.ts";
import { repaintCanvases } from "./rendering.ts";
import { SessionClaims } from "./sessions.ts";
import { RecordingManager, recordingOptionsSchema } from "./recording.ts";
import { codecPaths } from "./codec-assets.ts";

export const VERSION = "0.6.0";
const pageFields = {
  browserId: z.string().min(1).optional().describe("Exact browser key from browser_list. Required when multiple panes match."),
  tabId: z.number().int().positive().optional().describe("Exact tab ID in that browser. Defaults to its current visible tab."),
  focus: z.boolean().optional().describe("Activate this tab before an action. Default true for actions; false for reads."),
};
const commonTarget = { ...targetFields, target: targetSchema.optional() };
const viewportFields = { width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2160) };
const viewportSchema = z.object(viewportFields);
const screenshotFields = {
  full: z.boolean().optional(), annotate: z.boolean().optional(), target: targetSchema.optional(),
  frame: z.array(z.string().min(1)).max(8).optional(),
  clip: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive(), height: z.number().positive() }).optional(),
  outputPath: z.string().min(1).optional().describe("Save PNG inside the workspace. Existing files are never overwritten."),
  repaintCanvases: z.boolean().optional().describe("Opt in to refreshing static 2D canvas layers while preserving bitmap pixels; works around Electron offscreen viewport loss. Skips WebGL and tainted canvases."),
};

function reply(data: Record<string, unknown>, images: Buffer[] = []): CallToolResult {
  return {
    structuredContent: data,
    content: [
      { type: "text", text: JSON.stringify(data, null, 2) },
      ...images.map((image) => ({ type: "image" as const, data: image.toString("base64"), mimeType: "image/png" })),
    ],
  };
}

export function createBrowserServer(options: RuntimeOptions & { root?: string; claimsDirectory?: string } = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const axePath = import.meta.url.endsWith(".ts") ? createRequire(import.meta.url).resolve("axe-core/axe.min.js") : fileURLToPath(new URL("../assets/axe.min.js", import.meta.url));
  let axeSource: Promise<string> | undefined;
  const server = new McpServer({ name: "terminal-browser", version: VERSION });
  const runtime = new BrowserRuntime(options);
  const artifacts = new ArtifactStore(root);
  const environment = new PageEnvironment();
  const claims = new SessionClaims(options.claimsDirectory);
  const worker = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./recording-worker.ts" : "./recording-worker.js", import.meta.url));
  const recordings = new RecordingManager(root, worker);
  const touched = new Map<string, PageCall>();
  const blockedRoutes = new WeakMap<Page, Set<string>>();
  let queue: Promise<unknown> = Promise.resolve();

  function tool<S extends Record<string, z.ZodType>>(name: string, description: string, fields: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>, readOnly = false) {
    const schema = z.object(fields);
    // The SDK's Zod 3/4 callback conditional cannot infer this generic shape.
    server.registerTool(name, { description, inputSchema: fields as ZodRawShapeCompat, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true } }, async (input: unknown) => {
      const task = queue.then(async () => {
        try { return await handler(schema.parse(input)); }
        catch (error) {
          const details = errorDetails(error);
          return { ...reply({ error: details }), isError: true };
        }
      });
      queue = task.catch(() => {});
      return task;
    });
  }

  async function pageCall(params: PageOptions, action = false): Promise<PageCall> {
    const call = await runtime.resolve({ ...params, focus: false });
    touched.set(`${call.browser.key}/${call.tab.id}`, call);
    watchPage(call.page);
    await prepareDialogs(call.page);
    if (action) {
      await claims.beforeAction(call);
      if (params.focus !== false && !call.tab.active) {
        const state = await runtime.control(call.browser.socket, { cmd: "activate-tab", tab: call.tab.id });
        call.browser.tabs = parseTabs(state);
      }
      await runtime.control(call.browser.socket, { cmd: "agent-touch", tab: call.tab.id });
    }
    return call;
  }

  async function observed(call: PageCall, data: Record<string, unknown>, images: Buffer[] = []) {
    const pending = readDialogs(call.page).filter((dialog) => dialog.state === "pending");
    let state = call.browser;
    let stateError: string | undefined;
    if (!pending.length) {
      try { state = await runtime.refresh(call.browser); }
      catch (error) { stateError = error instanceof Error ? error.message : String(error); }
    }
    const active = state.tabs.find((tab) => tab.active);
    const before = new Set(call.browser.tabs.map((tab) => tab.id));
    return reply({
      ...data,
      context: {
        browserId: state.key, tabId: call.tab.id, targetId: call.tab.targetId, url: call.page.url(),
        userActiveTab: active, observedAt: new Date().toISOString(),
        newTabs: state.tabs.filter((tab) => !before.has(tab.id)),
        ...(pending.length ? { pendingDialogs: pending, registryRefresh: "deferred while a dialog is open" } : {}),
        ...(stateError ? { registryError: stateError } : {}),
      },
    }, images);
  }

  tool("browser_status", "Check terminal-browser installation, instance discovery, bundled recording codecs, and implemented capabilities before opening a pane.", {}, async () => {
    const version = await run(["--version"]);
    let browsers: Awaited<ReturnType<BrowserRuntime["discover"]>> | undefined;
    let discoveryError;
    try { browsers = await runtime.discover(); } catch (error) { discoveryError = errorDetails(error); }
    const encoderReady = (await Promise.all(Object.values(codecPaths(import.meta.url)).map((file) => fs.access(file).then(() => true, () => false)))).every(Boolean);
    return reply({
      version: VERSION, terminalBrowser: { installed: version.ok, version: version.stdout.trim(), ...(isSpawnNotFound(version) ? { install: INSTALL_HINT } : {}), error: version.ok ? undefined : version.stderr.trim() },
      terminal: { program: process.env.TERM_PROGRAM ?? null, term: process.env.TERM ?? null, currentPaneObserved: Boolean(browsers?.some((browser) => browser.inCurrentTab)), graphics: browsers?.some((browser) => browser.inCurrentTab) ? "live pane registered in current terminal tab" : "not verified in current terminal; kitty graphics and split support required" },
      browsers, discoveryError,
      capabilities: {
        exactTabIdentity: true, frames: true, scopedLocators: true, cua: true, domCua: true, uploads: true, downloads: true,
        dialogs: { observe: true, answer: "only while still pending; the tested macOS Electron host auto-closes native confirms", prompt: "unsupported by Electron" },
        screenshots: ["viewport", "full", "clip", "element", "annotate", "save", "diff", "responsive", "optional-2d-canvas-repaint"],
        diagnostics: ["console", "errors", "network", "har-metadata", "axe", "performance", "cpu-profile"],
        recording: { persistentJobs: true, status: true, cancel: true, webm: encoderReady, encoder: "bundled-vp8-wasm", externalEncoderRequired: false, maxDurationMs: 90_000 },
        sessionClaims: true,
        limitations: ["No desktop IAB host integration", "Human interaction is not locked", "No pane visibility API in terminal-browser 0.8", "Diagnostics begin when the tab is first inspected", "Static canvas layers may need repaint after Electron viewport emulation", "Native confirms auto-close on the tested macOS terminal-browser 0.8.0 host"],
      },
    });
  }, true);

  tool("browser_list", "List all visible terminal-browser panes and tabs. Select exact browserId/tabId from these current facts.", {}, async () => reply({ browsers: await runtime.discover() }), true);

  tool("browser_open", "Open a URL, localhost port, or local HTML path. Reuse a current pane by default; direction or newPane requests a new split. Return exact browser and tab IDs.", {
    url: z.string().min(1), browserId: pageFields.browserId, direction: z.enum(["left", "right", "up", "down"]).optional(),
    size: z.number().min(0.2).max(0.95).optional(), newPane: z.boolean().optional(), newTab: z.boolean().optional(),
    profile: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional().describe("Persistent browser partition for a new pane."),
    ssh: z.string().regex(/^(?:[\w.-]+@)?[\w.-]+$/).optional().describe("Optional SSH destination for a new pane's network traffic."),
  }, async (params) => {
    const url = normalizeUrl(params.url, root);
    const browsers = await runtime.discover();
    const wantsPane = params.newPane || params.direction || params.size !== undefined || params.profile || params.ssh;
    if (params.browserId && wantsPane) throw new BrowserError("invalid_arguments", "browserId selects an existing pane; omit new-pane options.");
    const candidates = browsers.filter((browser) => browser.inCurrentTab);
    if (!wantsPane && (params.browserId || candidates.length)) {
      const info = selectBrowser(browsers, params.browserId);
      const reusable = params.newTab ? undefined : findReusableTab(info, url);
      if (reusable) {
        const call = await pageCall({ browserId: info.key, tabId: reusable.id }, true);
        await dialogAwareAction(call.page, () => call.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT }));
        return observed(call, { opened: url, reused: true });
      }
      const state = await runtime.control(info.socket, { cmd: "open-tab", url }) as { openedTab: number };
      return reply({ opened: url, browserId: info.key, tabId: state.openedTab, tabs: parseTabs(state) });
    }
    const args = ["open", "--split", params.direction ?? "right", "--no-merge"];
    if (params.size !== undefined) args.push("--size", String(params.size));
    if (params.profile) args.push(`--partition=${params.profile}`);
    if (params.ssh) args.push(`--ssh=${params.ssh}`);
    args.push(url);
    const result = await run(args, { timeoutMs: 60_000 });
    if (!result.ok) throw new BrowserError(isSpawnNotFound(result) ? "not_installed" : "pane_open_failed", isSpawnNotFound(result) ? INSTALL_HINT : result.stderr.trim() || result.stdout.trim());
    const current = await runtime.discover();
    return reply({ opened: url, panes: current.filter((browser) => !browsers.some((old) => old.key === browser.key)), output: result.stdout.trim() });
  });

  tool("browser_navigate", "Navigate once, or go back/forward/reload. Reuse same-site tabs only when exactly identified. Navigation waits for domcontentloaded.", { ...pageFields, url: z.string().optional(), back: z.boolean().optional(), forward: z.boolean().optional(), reload: z.boolean().optional() }, async (params) => {
    if ([params.url, params.back, params.forward, params.reload].filter(Boolean).length !== 1) throw new BrowserError("invalid_arguments", "Provide exactly one of url, back, forward, reload.");
    const url = params.url ? normalizeUrl(params.url, root) : undefined;
    if (url && params.tabId === undefined) {
      const info = await runtime.info(params.browserId);
      params.browserId = info.key;
      params.tabId = findReusableTab(info, url)?.id;
    }
    const call = await pageCall(params, true);
    const result = await dialogAwareAction(call.page, () => {
      const options = { waitUntil: "domcontentloaded" as const, timeout: NAVIGATION_TIMEOUT };
      if (url) return call.page.goto(url, options);
      if (params.back) return call.page.goBack(options);
      if (params.forward) return call.page.goForward(options);
      return call.page.reload(options);
    });
    return observed(call, { navigated: !result.dialog, dialog: result.dialog });
  });

  tool("browser_snapshot", "Read a bounded AI/ARIA snapshot with refs. Use frame or a target to inspect an iframe or a specific region.", { ...pageFields, target: targetSchema.optional(), frame: z.array(z.string()).max(8).optional(), maxChars: z.number().int().min(500).max(100_000).optional() }, async (params) => {
    const call = await pageCall(params);
    return observed(call, { snapshot: await snapshot(call.page, params), frame: params.target?.frame ?? params.frame });
  }, true);

  tool("browser_read", "Read rendered text from the page or a known target.", { ...pageFields, target: targetSchema.optional(), maxChars: z.number().int().min(500).max(100_000).default(32_000) }, async (params) => {
    const call = await pageCall(params);
    const locator = params.target ? await uniqueTarget(call.page, params.target) : call.page.locator("body");
    const value = await locator.innerText();
    return observed(call, { text: value.slice(0, params.maxChars), truncated: value.length > params.maxChars });
  }, true);

  tool("browser_click", "Click one unique snapshot-proven target. Ambiguous targets fail before clicking. expectedUrl can verify source-page navigation.", { ...pageFields, ...commonTarget, double: z.boolean().optional(), button: z.enum(["left", "right", "middle"]).optional(), modifiers: modifiersSchema.optional(), expectedUrl: z.string().optional() }, async (params) => {
    const call = await pageCall(params, true);
    const result = await dialogAwareAction(call.page, async () => {
      const action = executeAction(call.page, { type: params.double ? "dblclick" : "click", target: targetFromFlat(params), button: params.button, modifiers: params.modifiers });
      if (params.expectedUrl) await Promise.all([action, call.page.waitForURL(params.expectedUrl, { timeout: ACTION_TIMEOUT, waitUntil: "domcontentloaded" })]);
      else await action;
    });
    return observed(call, { action: "click", ...result });
  });
  tool("browser_fill", "Clear and fill one unique input or textarea.", { ...pageFields, ...commonTarget, value: z.string() }, async (params) => {
    const call = await pageCall(params, true);
    return observed(call, { action: "fill", ...await dialogAwareAction(call.page, () => executeAction(call.page, { type: "fill", text: params.value, target: targetFromFlat(params) })) });
  });
  tool("browser_type", "Type through real keyboard events into a unique target, or the focused element when no target is given.", { ...pageFields, ...commonTarget, text: z.string() }, async (params) => {
    const call = await pageCall(params, true);
    return observed(call, { action: "type", ...await dialogAwareAction(call.page, () => executeAction(call.page, { type: "type", text: params.text, target: params.target ?? (hasTarget(params) ? params : undefined) })) });
  });
  tool("browser_select", "Select by value, label, index, or multiple values on a unique select element.", { ...pageFields, ...commonTarget, value: actionSchema.shape.value.unwrap() }, async (params) => {
    const call = await pageCall(params, true);
    return observed(call, { action: "select", ...await dialogAwareAction(call.page, () => executeAction(call.page, { type: "select", value: params.value, target: targetFromFlat(params) })) });
  });
  tool("browser_check", "Set a unique checkbox or radio to the requested checked state.", { ...pageFields, ...commonTarget, checked: z.boolean().default(true) }, async (params) => {
    const call = await pageCall(params, true);
    return observed(call, { action: "check", ...await dialogAwareAction(call.page, () => executeAction(call.page, { type: params.checked ? "check" : "uncheck", target: targetFromFlat(params) })) });
  });
  tool("browser_press", "Press a keyboard key or combination; optionally focus an exact target first.", { ...pageFields, key: z.string().min(1), target: targetSchema.optional() }, async (params) => {
    const call = await pageCall(params, true);
    return observed(call, { action: "press", ...await dialogAwareAction(call.page, () => executeAction(call.page, { type: "press", key: params.key, target: params.target })) });
  });
  tool("browser_hover", "Hover one unique target to reveal a tooltip or menu.", { ...pageFields, ...commonTarget, modifiers: modifiersSchema.optional() }, async (params) => {
    const call = await pageCall(params, true);
    await executeAction(call.page, { type: "hover", target: targetFromFlat(params), modifiers: params.modifiers });
    return observed(call, { action: "hover" });
  });

  tool("browser_act", "Perform ONE structured action and return a fresh semantic observation in one call. Useful for fast action-observation loops without bootstrap code.", { ...pageFields, action: actionSchema, observe: z.enum(["snapshot", "none"]).default("snapshot") }, async (params) => {
    const call = await pageCall(params, true);
    const result = await dialogAwareAction(call.page, () => executeAction(call.page, params.action));
    return observed(call, { action: params.action.type, ...result, snapshot: !result.dialog && params.observe === "snapshot" ? await snapshot(call.page) : undefined });
  });

  tool("browser_query", "Query a known locator's count, text, value, attributes, visibility, enabled/checked state, or bounding box.", { ...pageFields, target: targetSchema, property: z.enum(["count", "text", "textContent", "allText", "value", "attribute", "visible", "enabled", "checked", "box"]), attribute: z.string().optional() }, async (params) => {
    const call = await pageCall(params);
    const target = params.property === "count" || params.property === "allText" ? resolveTarget(call.page, params.target) : await uniqueTarget(call.page, params.target);
    let value: unknown;
    switch (params.property) {
      case "count": value = await target.count(); break;
      case "text": value = await target.innerText(); break;
      case "textContent": value = await target.textContent(); break;
      case "allText": value = (await target.allTextContents()).slice(0, 200); break;
      case "value": value = await target.inputValue(); break;
      case "attribute": if (!params.attribute) throw new BrowserError("invalid_arguments", "attribute is required."); value = await target.getAttribute(params.attribute); break;
      case "visible": value = await target.isVisible(); break;
      case "enabled": value = await target.isEnabled(); break;
      case "checked": value = await target.isChecked(); break;
      case "box": value = await target.boundingBox();
    }
    return observed(call, { value });
  }, true);

  tool("browser_frames", "List frames, URLs, and observed iframe selectors for constructing frame paths.", pageFields, async (params) => {
    const call = await pageCall(params);
    const frames = await Promise.all(call.page.frames().map(async (frame) => {
      const selectors: string[] = [];
      let cursor = frame;
      while (cursor.parentFrame()) {
        const element = await cursor.frameElement();
        const selector = await element.evaluate((node) => {
          const el = node as Element;
          return el.id ? `[id=${JSON.stringify(el.id)}]` : el.getAttribute("name") ? `iframe[name=${JSON.stringify(el.getAttribute("name"))}]` : el.getAttribute("src") ? `iframe[src=${JSON.stringify(el.getAttribute("src"))}]` : "iframe";
        });
        await element.dispose();
        selectors.unshift(String(selector));
        cursor = cursor.parentFrame()!;
      }
      return { name: frame.name(), url: frame.url(), frame: selectors };
    }));
    return observed(call, { frames });
  }, true);

  tool("browser_inspect", "Inspect the visible DOM element at CSS viewport coordinates and return its actual selector candidates and geometry.", { ...pageFields, ...pointSchema.shape }, async (params) => {
    const call = await pageCall(params);
    const element = await call.page.evaluate(`(({ x, y }) => {
      let el = document.elementFromPoint(x, y);
      while (el?.shadowRoot?.elementFromPoint(x, y)) el = el.shadowRoot.elementFromPoint(x, y);
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const candidates = [];
      if (el.id) candidates.push('#' + CSS.escape(el.id));
      if (el.getAttribute('data-testid')) candidates.push('[data-testid=' + JSON.stringify(el.getAttribute('data-testid')) + ']');
      return { tag: el.tagName.toLowerCase(), text: (el.innerText || '').slice(0, 1000), role: el.getAttribute('role'), label: el.getAttribute('aria-label'), selectors: candidates, box: { x: box.x, y: box.y, width: box.width, height: box.height }, iframe: el.tagName === 'IFRAME' };
    })(${JSON.stringify({ x: params.x, y: params.y })})`);
    return observed(call, { element });
  }, true);

  tool("browser_evaluate", "Run a focused page-side JavaScript expression or IIFE. Code may mutate the page; prefer structured actions for normal interaction.", { ...pageFields, code: z.string().min(1) }, async (params) => {
    const call = await pageCall(params, true);
    const result = await dialogAwareAction(call.page, () => withTimeout(call.page.evaluate(params.code), ACTION_TIMEOUT, "Page evaluation"));
    return observed(call, result);
  });

  tool("browser_wait", "Wait for a unique target state, a URL glob, or a load state. Routine waits are capped at 3 seconds.", { ...pageFields, ...commonTarget, state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"), url: z.string().optional(), loadState: z.enum(["load", "domcontentloaded"]).optional(), ms: z.number().int().min(0).max(10_000).optional() }, async (params) => {
    const call = await pageCall(params);
    const target = params.target ?? (hasTarget(params) ? params : undefined);
    if ([Boolean(target), Boolean(params.url), Boolean(params.loadState), params.ms !== undefined].filter(Boolean).length !== 1) throw new BrowserError("invalid_arguments", "Provide exactly one wait condition.");
    if (params.url) await call.page.waitForURL(params.url, { timeout: ACTION_TIMEOUT, waitUntil: "domcontentloaded" });
    else if (params.loadState) await call.page.waitForLoadState(params.loadState, { timeout: ACTION_TIMEOUT });
    else if (params.ms !== undefined) await call.page.waitForTimeout(params.ms);
    else await resolveTarget(call.page, target!).waitFor({ state: params.state, timeout: ACTION_TIMEOUT });
    return observed(call, { reached: true });
  }, true);

  tool("browser_screenshot", "Capture CSS-pixel PNG evidence, optionally annotated, clipped, element-scoped, or saved in the workspace.", { ...pageFields, ...screenshotFields }, async (params) => {
    const call = await pageCall(params);
    const shot = await captureScreenshot(call.page, params);
    const savedPath = params.outputPath ? await artifacts.write(params.outputPath, shot.bytes) : undefined;
    return observed(call, { path: savedPath, snapshot: shot.snapshotText, frame: params.target?.frame ?? params.frame, canvasRepaint: shot.canvasRepaint }, [shot.bytes]);
  }, true);

  tool("browser_diff", "Compare a fresh screenshot with a saved PNG baseline using pixelmatch and save the visual difference. Never overwrites the baseline.", { ...pageFields, baselinePath: z.string().min(1), outputPath: z.string().optional(), threshold: z.number().min(0).max(1).default(0.1), maxChangedRatio: z.number().min(0).max(1).default(0), full: z.boolean().optional() }, async (params) => {
    const call = await pageCall(params);
    const baseline = PNG.sync.read(await artifacts.read(params.baselinePath));
    const shot = await captureScreenshot(call.page, { full: params.full });
    const current = PNG.sync.read(shot.bytes);
    if (baseline.width !== current.width || baseline.height !== current.height) throw new BrowserError("image_size_mismatch", `Baseline ${baseline.width}x${baseline.height}; current ${current.width}x${current.height}. Set matching viewports first.`);
    const diff = new PNG({ width: current.width, height: current.height });
    const changedPixels = pixelmatch(baseline.data, current.data, diff.data, current.width, current.height, { threshold: params.threshold });
    const bytes = PNG.sync.write(diff);
    const changedRatio = changedPixels / (current.width * current.height);
    return observed(call, { changedPixels, changedRatio, matches: changedRatio <= params.maxChangedRatio, path: await artifacts.write(params.outputPath ?? artifacts.name("diff", "png"), bytes) }, [bytes]);
  }, true);

  tool("browser_viewport", "Set or read CSS viewport dimensions and DPR. Reset clears the plugin's CDP viewport override.", { ...pageFields, width: viewportFields.width.optional(), height: viewportFields.height.optional(), reset: z.boolean().optional(), mobile: z.boolean().optional(), deviceScaleFactor: z.number().min(1).max(3).optional() }, async (params) => {
    if ((params.width === undefined) !== (params.height === undefined) || (params.reset && params.width !== undefined)) throw new BrowserError("invalid_arguments", "Provide width and height together, or reset.");
    const call = await pageCall(params, params.reset || params.width !== undefined);
    const viewport = params.reset ? await environment.viewport(call.page) : params.width !== undefined ? await environment.viewport(call.page, { width: params.width, height: params.height!, mobile: params.mobile, deviceScaleFactor: params.deviceScaleFactor }) : await environment.readViewport(call.page);
    return observed(call, { viewport });
  });

  tool("browser_responsive", "Capture a bounded desktop/mobile viewport matrix, save PNG evidence, report horizontal overflow, and restore the prior viewport override.", { ...pageFields, viewports: z.array(viewportSchema).min(1).max(6), outputDirectory: z.string().default("browser-artifacts/responsive"), repaintCanvases: screenshotFields.repaintCanvases }, async (params) => {
    const call = await pageCall(params, true);
    const original = environment.override(call.page);
    const captures = [];
    const images = [];
    try {
      for (const viewport of params.viewports) {
        await environment.viewport(call.page, viewport);
        await call.page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        const shot = await captureScreenshot(call.page, { repaintCanvases: params.repaintCanvases });
        const overflow = await call.page.evaluate("document.documentElement.scrollWidth > innerWidth");
        const saved = await artifacts.write(`${params.outputDirectory}/${viewport.width}x${viewport.height}-${Date.now()}.png`, shot.bytes);
        captures.push({ ...viewport, horizontalOverflow: overflow, path: saved, canvasRepaint: shot.canvasRepaint });
        images.push(shot.bytes);
      }
    } finally {
      await environment.viewport(call.page, original);
      if (params.repaintCanvases) await repaintCanvases(call.page);
    }
    return observed(call, { captures }, images);
  });

  tool("browser_tab", "List, create, close, or switch an exact browser/tab. New tabs return IDs; no URL-based or positional fallback is used.", { ...pageFields, action: z.enum(["list", "new", "close", "switch"]), url: z.string().optional() }, async (params) => {
    const info = await runtime.info(params.browserId);
    if (params.action === "list") return reply({ browserId: info.key, tabs: info.tabs });
    if (params.action === "new") {
      const state = await runtime.control(info.socket, { cmd: "open-tab", url: normalizeUrl(params.url ?? "about:blank", root) }) as { openedTab: number };
      return reply({ browserId: info.key, tabId: state.openedTab, tabs: parseTabs(state) });
    }
    if (params.tabId === undefined) throw new BrowserError("invalid_arguments", "tabId is required.");
    const tab = info.tabs.find((tab) => tab.id === params.tabId);
    if (!tab) throw new BrowserError("tab_not_found", "The requested tab no longer exists.");
    if (params.action === "close") {
      const identity = { browser: info, tab };
      await claims.beforeAction(identity);
      await claims.release(identity);
    }
    const state = await runtime.control(info.socket, { cmd: params.action === "close" ? "close-tab" : "activate-tab", tab: params.tabId });
    return reply({ browserId: info.key, tabs: parseTabs(state) });
  });

  tool("browser_cua", "Coordinate actions for canvas/custom controls: anchored scroll, full drag paths, keyboard combinations, and modifiers. Aim from CSS-pixel screenshots.", { ...pageFields, action: z.enum(["click", "dblclick", "move", "scroll", "wheel", "type", "keypress", "drag"]), x: pointSchema.shape.x.optional(), y: pointSchema.shape.y.optional(), deltaX: z.number().optional(), deltaY: z.number().optional(), text: z.string().optional(), keys: actionSchema.shape.keys, button: actionSchema.shape.button, modifiers: modifiersSchema.optional(), path: actionSchema.shape.path, durationMs: actionSchema.shape.durationMs }, async (params) => {
    const call = await pageCall(params, true);
    const type = params.action === "move" ? "hover" : params.action === "wheel" ? "scroll" : params.action === "keypress" ? "press" : params.action;
    return observed(call, { action: params.action, ...await dialogAwareAction(call.page, () => executeAction(call.page, { ...params, type })) });
  });
  tool("browser_dom_cua", "DOM CUA compatibility: visible DOM snapshot, ref clicks, anchored node scrolling, typing, and key combinations. node_id is a fresh snapshot ref.", { ...pageFields, action: z.enum(["get_visible_dom", "click", "double_click", "scroll", "keypress", "type"]), node_id: z.string().optional(), frame: targetFields.frame, x: z.number().optional(), y: z.number().optional(), keys: actionSchema.shape.keys, text: z.string().optional() }, async (params) => {
    const call = await pageCall(params, params.action !== "get_visible_dom");
    if (params.action === "get_visible_dom") return observed(call, { snapshot: await snapshot(call.page, { frame: params.frame }) });
    const type = params.action === "double_click" ? "dblclick" : params.action === "keypress" ? "press" : params.action;
    return observed(call, { action: params.action, ...await dialogAwareAction(call.page, () => executeAction(call.page, { type, target: params.node_id ? { ref: params.node_id, frame: params.frame } : undefined, deltaX: params.x, deltaY: params.y, keys: params.keys, text: params.text })) });
  });
  tool("browser_drag", "Drag between unique elements or through a complete coordinate path. Supports modifiers and always releases held mouse buttons on failure.", { ...pageFields, ...commonTarget, source: z.string().optional(), targetSelector: z.string().optional(), to: targetSchema.optional(), path: actionSchema.shape.path, modifiers: modifiersSchema.optional(), durationMs: actionSchema.shape.durationMs, fromX: z.number().optional(), fromY: z.number().optional(), toX: z.number().optional(), toY: z.number().optional() }, async (params) => {
    const call = await pageCall(params, true);
    const points = params.path ?? (params.fromX !== undefined && params.fromY !== undefined && params.toX !== undefined && params.toY !== undefined ? [{ x: params.fromX, y: params.fromY }, { x: params.toX, y: params.toY }] : undefined);
    await executeAction(call.page, { type: "drag", path: points, target: params.source ? { selector: params.source } : params.target ?? (hasTarget(params) ? params : undefined), to: params.to ?? (params.targetSelector ? { selector: params.targetSelector } : undefined), modifiers: params.modifiers, durationMs: params.durationMs });
    return observed(call, { action: "drag" });
  });

  tool("browser_upload", "Upload files to one exact file input, including hidden inputs, or through a custom chooser button. Never guesses the first input.", { ...pageFields, ...commonTarget, filePaths: z.array(z.string().min(1)).max(30), mode: z.enum(["input", "chooser"]).default("input") }, async (params) => {
    const call = await pageCall(params, true);
    const files = params.filePaths.map((file) => path.resolve(root, file));
    for (const file of files) if (!(await fs.stat(file)).isFile()) throw new BrowserError("invalid_upload", `Not a regular file: ${file}`);
    const target = await uniqueTarget(call.page, targetFromFlat(params));
    if (params.mode === "input") await target.setInputFiles(files);
    else {
      const [chooser] = await Promise.all([call.page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT }), target.click()]);
      await chooser.setFiles(files);
    }
    return observed(call, { uploaded: files.map((file) => path.basename(file)) });
  });

  tool("browser_download", "Arm the download listener, click one verified target, and save the received file inside the workspace.", { ...pageFields, target: targetSchema, outputPath: z.string().optional(), timeoutMs: z.number().int().min(1000).max(120_000).default(30_000) }, async (params) => {
    const call = await pageCall(params, true);
    const target = await uniqueTarget(call.page, params.target);
    if (params.outputPath) await artifacts.output(params.outputPath);
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "zcode-browser-download-"));
    const browser = call.page.context().browser();
    const browserSession = browser ? await browser.newBrowserCDPSession() : undefined;
    const pageSession = browser ? await call.page.context().newCDPSession(call.page) : undefined;
    const frameIds = new Set<string>();
    const downloadGuids = new Set<string>();
    let browserPath: string | undefined;
    let downloadDone: Promise<void> | undefined;
    let resolveDownload: (() => void) | undefined;
    let contextId: string | undefined;
    let configured = false;
    try {
    if (browserSession && pageSession) {
      const tree = await pageSession.send("Page.getFrameTree");
      type FrameNode = { frame: { id: string }; childFrames?: FrameNode[] };
      const collect = (frame: FrameNode) => {
        frameIds.add(frame.frame.id);
        for (const child of frame.childFrames ?? []) collect(child);
      };
      collect(tree.frameTree as FrameNode);
      downloadDone = new Promise<void>((resolve) => { resolveDownload = resolve; });
      browserSession.on("Browser.downloadWillBegin", (event: { guid: string; frameId?: string }) => {
        if (event.frameId && frameIds.has(event.frameId)) downloadGuids.add(event.guid);
      });
      browserSession.on("Browser.downloadProgress", (event: { guid: string; state: string; filePath?: string }) => {
        if (!downloadGuids.has(event.guid)) return;
        if (event.state === "completed") { browserPath = event.filePath ?? path.join(temporaryDirectory, event.guid); resolveDownload?.(); }
        if (event.state === "canceled") resolveDownload?.();
      });
      const targetInfo = await pageSession.send("Target.getTargetInfo");
      const { browserContextIds } = await browserSession.send("Target.getBrowserContexts");
      const targetContext = targetInfo.targetInfo.browserContextId;
      contextId = targetContext && browserContextIds.includes(targetContext) ? targetContext : undefined;
      await browserSession.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName", downloadPath: temporaryDirectory, eventsEnabled: true,
        ...(contextId ? { browserContextId: contextId } : {}),
      });
      configured = true;
    }
      const [download] = await Promise.all([call.page.waitForEvent("download", { timeout: params.timeoutMs }), target.click()]);
      const failure = await withTimeout(download.failure(), params.timeoutMs, "Download");
      if (failure) throw new BrowserError("download_failed", failure);
      if (downloadDone) await withTimeout(downloadDone, params.timeoutMs, "Download file path");
      const temporary = (browserPath && await fs.stat(browserPath).then((stat) => stat.isFile() ? browserPath : undefined).catch(() => undefined))
        ?? await download.path();
      if (!temporary) throw new BrowserError("download_failed", "The browser did not provide a downloaded file.");
      const filename = path.basename(download.suggestedFilename()).replace(/[^\w. -]/g, "_") || "download.bin";
      const saved = await artifacts.copy(params.outputPath ?? `browser-artifacts/downloads/${Date.now()}-${filename}`, temporary);
      return observed(call, { path: saved, suggestedFilename: filename });
    } finally {
      if (configured) await browserSession?.send("Browser.setDownloadBehavior", { behavior: "default", ...(contextId ? { browserContextId: contextId } : {}), eventsEnabled: false }).catch(() => {});
      await pageSession?.detach().catch(() => {});
      await browserSession?.detach().catch(() => {});
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  });

  tool("browser_dialogs", "Read dialog events or answer dialogs still pending. Electron offscreen may auto-close native dialogs; closed records are not actionable. Policy changes apply to future dialogs on supporting engines.", { ...pageFields, action: z.enum(["list", "accept", "dismiss", "policy"]).default("list"), id: z.string().optional(), promptText: z.string().optional(), clear: z.boolean().optional(), defaultAction: z.enum(["accept", "dismiss", "manual"]).optional() }, async (params) => {
    const retained = [...touched.values()].filter((call) => !call.page.isClosed() && (!params.browserId || params.browserId === call.browser.key) && (!params.tabId || params.tabId === call.tab.id) && readDialogs(call.page).some((dialog) => dialog.state === "pending" && (!params.id || dialog.id === params.id)));
    if (retained.length > 1) throw new BrowserError("ambiguous_dialog", "Pass browserId, tabId, or a specific dialog id.");
    const call = retained[0] ?? await pageCall(params);
    if (params.action === "accept" || params.action === "dismiss") {
      await claims.beforeAction(call);
      return reply({ dialog: await respondToDialog(call.page, params.action, params.id, params.promptText), browserId: call.browser.key, tabId: call.tab.id });
    }
    if (params.defaultAction) watchDialogs(call.page, params.defaultAction);
    return reply({ dialogs: readDialogs(call.page, params.clear), policy: watchDialogs(call.page).policy, browserId: call.browser.key, tabId: call.tab.id });
  });

  tool("browser_console", "Read recent console messages with timestamps. Capture starts when the tab is first inspected.", { ...pageFields, clear: z.boolean().optional() }, async (params) => { const call = await pageCall(params); return observed(call, readConsole(call.page, params.clear)); }, true);
  tool("browser_errors", "Read recent uncaught exceptions and failed network requests, optionally clearing them.", { ...pageFields, clear: z.boolean().optional() }, async (params) => { const call = await pageCall(params); return observed(call, readErrors(call.page, params.clear)); }, true);
  tool("browser_accessibility", "Run axe-core WCAG 2.0/2.1/2.2 A/AA checks. Save the complete audit as JSON and report violations plus checks requiring manual review.", { ...pageFields, outputPath: z.string().optional() }, async (params) => {
    const call = await pageCall(params);
    axeSource ??= fs.readFile(axePath, "utf8");
    const audit = await runAccessibility(call.page, await axeSource) as { violations: unknown[]; incomplete: unknown[] };
    const saved = await artifacts.write(params.outputPath ?? artifacts.name("accessibility", "json"), JSON.stringify(audit, null, 2));
    return observed(call, { violations: audit.violations, manualReviewCount: audit.incomplete.length, path: saved });
  }, true);

  tool("browser_network", "Inspect request status/timing/failures, capture metadata HAR, or block a URL glob on this tab only.", { ...pageFields, action: z.enum(["list", "clear", "har_start", "har_stop", "block", "unblock"]).default("list"), filter: z.string().optional(), pattern: z.string().optional(), outputPath: z.string().optional() }, async (params) => {
    const call = await pageCall(params, params.action === "block" || params.action === "unblock");
    if (params.action === "har_start") return observed(call, startHar(call.page));
    if (params.action === "har_stop") return observed(call, { path: await artifacts.write(params.outputPath ?? artifacts.name("network", "har"), JSON.stringify(stopHar(call.page), null, 2)) });
    if (params.action === "block" || params.action === "unblock") {
      if (!params.pattern) throw new BrowserError("invalid_arguments", "pattern is required.");
      const patterns = blockedRoutes.get(call.page) ?? new Set<string>();
      if (params.action === "block" && !patterns.has(params.pattern)) { await call.page.route(params.pattern, (route) => route.abort()); patterns.add(params.pattern); }
      if (params.action === "unblock" && patterns.has(params.pattern)) { await call.page.unroute(params.pattern); patterns.delete(params.pattern); }
      blockedRoutes.set(call.page, patterns);
      return observed(call, { blocked: [...patterns] });
    }
    return observed(call, readNetwork(call.page, params.filter, params.action === "clear"));
  });

  tool("browser_performance", "Read browser timing/heap metrics or capture a tab-scoped Chrome CPU profile.", { ...pageFields, action: z.enum(["metrics", "profile_start", "profile_stop"]).default("metrics"), outputPath: z.string().optional() }, async (params) => {
    const call = await pageCall(params);
    if (params.action === "profile_start") { await startProfile(call.page); return observed(call, { profiling: true }); }
    if (params.action === "profile_stop") return observed(call, { path: await artifacts.write(params.outputPath ?? artifacts.name("cpu", "cpuprofile"), JSON.stringify(await stopProfile(call.page))) });
    return observed(call, await performanceMetrics(call.page));
  }, true);

  tool("browser_environment", "Configure page-scoped offline, media preferences, extra headers, and geolocation. Other panes are not reconfigured.", { ...pageFields, offline: z.boolean().optional(), colorScheme: z.enum(["dark", "light", "no-preference"]).optional(), reducedMotion: z.enum(["reduce", "no-preference"]).optional(), headers: z.record(z.string(), z.string()).optional(), geolocation: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracy: z.number().nonnegative().optional() }).optional(), reset: z.boolean().optional() }, async (params) => {
    const call = await pageCall(params, true);
    await environment.configure(call.page, params);
    return observed(call, { configured: true });
  });

  tool("browser_storage", "Inspect or change local/session storage or cookies scoped to the current origin. Export to a private workspace file.", { ...pageFields, area: z.enum(["local", "session", "cookies"]), action: z.enum(["list", "set", "remove", "clear", "export"]).default("list"), key: z.string().optional(), value: z.string().optional(), outputPath: z.string().optional() }, async (params) => {
    const call = await pageCall(params, !["list", "export"].includes(params.action));
    const url = new URL(call.page.url());
    if (!["https:", "http:"].includes(url.protocol)) throw new BrowserError("invalid_origin", "Storage operations require an HTTP(S) origin.");
    let value: unknown;
    if (params.area === "cookies") {
      if (params.action === "set") {
        if (!params.key || params.value === undefined) throw new BrowserError("invalid_arguments", "key and value are required.");
        await call.page.context().addCookies([{ name: params.key, value: params.value, url: url.origin }]);
      } else if (params.action === "remove" || params.action === "clear") {
        if (params.action === "remove" && !params.key) throw new BrowserError("invalid_arguments", "key is required.");
        const cookies = await call.page.context().cookies(url.href);
        for (const cookie of cookies.filter((cookie) => params.action === "clear" || cookie.name === params.key)) await call.page.context().clearCookies({ domain: cookie.domain, path: cookie.path, name: cookie.name });
      }
      value = await call.page.context().cookies(url.href);
    } else {
      if (params.action === "set" && (params.key === undefined || params.value === undefined)) throw new BrowserError("invalid_arguments", "key and value are required.");
      if (params.action === "remove" && params.key === undefined) throw new BrowserError("invalid_arguments", "key is required.");
      value = await call.page.evaluate(`(({ area, action, key, value }) => { const store = area === 'local' ? localStorage : sessionStorage; if (action === 'set') store.setItem(key, value); if (action === 'remove') store.removeItem(key); if (action === 'clear') store.clear(); return Object.fromEntries(Array.from({length: store.length}, (_, i) => { const key = store.key(i); return [key, store.getItem(key)]; })); })(${JSON.stringify(params)})`);
    }
    if (params.action === "export") return observed(call, { path: await artifacts.write(params.outputPath ?? artifacts.name("storage", "json"), JSON.stringify({ origin: url.origin, area: params.area, value }, null, 2)) });
    return observed(call, { origin: url.origin, value });
  });

  tool("browser_session", "Claim, pause for human input, resume, release, or mark a tab for handoff. Claims prevent other plugin processes from acting on the same tab.", { ...pageFields, action: z.enum(["status", "claim", "pause", "resume", "release", "handoff"]) }, async (params) => {
    const call = await pageCall(params);
    if (params.action === "release") await claims.release(call);
    else if (params.action !== "status") await claims.claim(call, params.action === "pause" ? "paused" : params.action === "handoff" ? "handoff" : "claimed");
    if (params.action === "pause" || params.action === "release") await runtime.control(call.browser.socket, { cmd: "agent-release" });
    return observed(call, { claim: await claims.status(call) });
  });

  tool("browser_record", "Record to a durable asynchronous job. Supports static pages, real elapsed time, status/stop/cancel, actions, and a hard 90-second limit. IDs survive MCP restarts.", { ...pageFields, action: z.enum(["start", "status", "stop", "cancel", "list"]), id: z.string().optional(), outputPath: z.string().optional(), ...recordingOptionsSchema.shape }, async (params) => {
    if (params.action === "list") return reply({ recordings: await recordings.list() });
    if (params.action === "start") {
      const call = await pageCall(params, true);
      return observed(call, { recording: await recordings.start(call, params, environment.override(call.page)) });
    }
    if (!params.id) throw new BrowserError("invalid_arguments", "id is required.");
    return reply({ recording: params.action === "status" ? await recordings.status(params.id, params.outputPath) : await recordings.command(params.id, params.action, params.outputPath) });
  });

  tool("browser_done", "Release this session's ordinary claims and clear its touched panes' activity indicators. Handoff claims remain; tabs stay open.", {}, async () => {
    await claims.releaseAll(true);
    const sockets = new Set([...touched.values()].map((call) => call.browser.socket));
    const results = await Promise.allSettled([...sockets].map((socket) => runtime.control(socket, { cmd: "agent-release" })));
    return reply({ released: true, indicatorErrors: results.filter((result) => result.status === "rejected").map((result) => String((result as PromiseRejectedResult).reason)) });
  });

  const close = async () => {
    await claims.releaseAll();
    await environment.close();
    await runtime.close();
    await server.close();
  };
  return { server, runtime, close };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const application = createBrowserServer();
  const stop = () => { void application.close().finally(() => process.exit(0)); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.stdin.once("end", stop);
  application.server.connect(new StdioServerTransport()).catch((error: unknown) => { process.stderr.write(`${JSON.stringify(errorDetails(error))}\n`); process.exitCode = 1; });
}
