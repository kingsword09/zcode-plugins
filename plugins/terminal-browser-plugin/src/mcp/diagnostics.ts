import { randomUUID } from "node:crypto";
import type { Page, Request, CDPSession } from "playwright-core";
import { BrowserError } from "./errors.ts";

export interface NetworkRecord {
  id: string;
  url: string;
  method: string;
  resourceType: string;
  startedAt: number;
  durationMs?: number;
  status?: number;
  mimeType?: string;
  failure?: string;
  requestBytes?: number;
  responseBytes?: number;
}

interface DiagnosticState {
  since: number;
  console: Array<{ at: number; type: string; text: string }>;
  errors: Array<{ at: number; text: string }>;
  network: NetworkRecord[];
  requests: WeakMap<Request, NetworkRecord>;
  har?: { since: number; entries: NetworkRecord[]; truncated: boolean };
  profiler?: CDPSession;
}

const states = new WeakMap<Page, DiagnosticState>();
function append<T>(list: T[], entry: T, limit = 500) {
  list.push(entry);
  if (list.length > limit) list.shift();
}

export function watchPage(page: Page): DiagnosticState {
  const existing = states.get(page);
  if (existing) return existing;
  const state: DiagnosticState = { since: Date.now(), console: [], errors: [], network: [], requests: new WeakMap() };
  states.set(page, state);
  page.on("console", (message) => append(state.console, { at: Date.now(), type: message.type(), text: message.text().slice(0, 8_000) }));
  page.on("pageerror", (error) => append(state.errors, { at: Date.now(), text: error.message.slice(0, 8_000) }));
  page.on("request", (request) => {
    const entry: NetworkRecord = { id: randomUUID(), url: request.url(), method: request.method(), resourceType: request.resourceType(), startedAt: Date.now() };
    state.requests.set(request, entry);
    append(state.network, entry);
    if (state.har) {
      if (state.har.entries.length < 5_000) state.har.entries.push(entry);
      else state.har.truncated = true;
    }
  });
  page.on("response", (response) => {
    const entry = state.requests.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    entry.mimeType = response.headers()["content-type"];
  });
  page.on("requestfinished", (request) => {
    const entry = state.requests.get(request);
    if (!entry) return;
    entry.durationMs = Date.now() - entry.startedAt;
    void request.sizes().then((sizes) => { entry.requestBytes = sizes.requestBodySize; entry.responseBytes = sizes.responseBodySize; }).catch(() => {});
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "Request failed";
    const entry = state.requests.get(request);
    if (entry) { entry.failure = failure; entry.durationMs = Date.now() - entry.startedAt; }
    append(state.errors, { at: Date.now(), text: `requestfailed ${request.url()}: ${failure}` });
  });
  return state;
}

export function readConsole(page: Page, clear = false) {
  const state = watchPage(page);
  const result = { capturedSince: state.since, entries: [...state.console] };
  if (clear) state.console.length = 0;
  return result;
}

export function readErrors(page: Page, clear = false) {
  const state = watchPage(page);
  const result = { capturedSince: state.since, entries: [...state.errors] };
  if (clear) state.errors.length = 0;
  return result;
}

export function readNetwork(page: Page, filter?: string, clear = false) {
  const state = watchPage(page);
  const entries = state.network.filter((entry) => !filter || entry.url.includes(filter)).map((entry) => ({ ...entry }));
  if (clear) state.network.length = 0;
  return { capturedSince: state.since, entries };
}

export function startHar(page: Page) {
  const state = watchPage(page);
  if (state.har) throw new BrowserError("capture_running", "A HAR capture is already running on this tab.");
  state.har = { since: Date.now(), entries: [], truncated: false };
  return { startedAt: state.har.since, note: "Metadata-only HAR: request/response bodies, headers, and cookies are not captured." };
}

export function stopHar(page: Page) {
  const state = watchPage(page);
  const capture = state.har;
  if (!capture) throw new BrowserError("capture_not_found", "No HAR capture is running.");
  state.har = undefined;
  return {
    log: {
      version: "1.2", creator: { name: "terminal-browser", version: "0.6.0" },
      comment: `Metadata-only capture; truncated=${capture.truncated}`,
      entries: capture.entries.map((entry) => ({
        startedDateTime: new Date(entry.startedAt).toISOString(), time: entry.durationMs ?? 0,
        request: { method: entry.method, url: entry.url, httpVersion: "", headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: entry.requestBytes ?? -1 },
        response: { status: entry.status ?? 0, statusText: "", httpVersion: "", headers: [], cookies: [], content: { size: entry.responseBytes ?? 0, mimeType: entry.mimeType ?? "" }, redirectURL: "", headersSize: -1, bodySize: entry.responseBytes ?? -1 },
        cache: {}, timings: { send: 0, wait: entry.durationMs ?? 0, receive: 0 },
        _failure: entry.failure,
      })),
    },
  };
}

export async function performanceMetrics(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Performance.enable");
    const metrics = await cdp.send("Performance.getMetrics");
    const navigation = await page.evaluate(`({ navigation: performance.getEntriesByType('navigation').map(e => e.toJSON()), paint: performance.getEntriesByType('paint').map(e => e.toJSON()), resources: performance.getEntriesByType('resource').length })`);
    return { ...metrics, navigation, note: "Browser timing and heap metrics; not a complete Core Web Vitals audit." };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export async function startProfile(page: Page) {
  const state = watchPage(page);
  if (state.profiler) throw new BrowserError("capture_running", "A CPU profile is already running on this tab.");
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    state.profiler = cdp;
  } catch (error) {
    await cdp.detach().catch(() => {});
    throw error;
  }
}

export async function stopProfile(page: Page) {
  const state = watchPage(page);
  const cdp = state.profiler;
  if (!cdp) throw new BrowserError("capture_not_found", "No CPU profile is running.");
  state.profiler = undefined;
  try {
    return (await cdp.send("Profiler.stop")).profile;
  } finally {
    await cdp.detach().catch(() => {});
  }
}
