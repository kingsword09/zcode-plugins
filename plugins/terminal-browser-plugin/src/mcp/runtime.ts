import { chromium, type Browser, type Page } from "playwright-core";
import { BrowserError, withTimeout } from "./errors.ts";
import { control, listBrowsers, parseTabs, selectBrowser, type BrowserInfo, type TabInfo } from "./terminal.ts";

export const ACTION_TIMEOUT = 3_000;
export const NAVIGATION_TIMEOUT = 30_000;

export interface PageOptions {
  browserId?: string;
  tabId?: number;
  focus?: boolean;
}

export interface PageCall {
  page: Page;
  browser: BrowserInfo;
  tab: TabInfo;
  ws: string;
}

export interface RuntimeOptions {
  discover?: () => Promise<BrowserInfo[]>;
  control?: typeof control;
  connect?: (ws: string) => Promise<Browser>;
}

const targetIds = new WeakMap<Page, string>();

export async function pageTargetId(page: Page): Promise<string> {
  const cached = targetIds.get(page);
  if (cached) return cached;
  const session = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await withTimeout(session.send("Target.getTargetInfo"), ACTION_TIMEOUT, "Read page identity");
    targetIds.set(page, targetInfo.targetId);
    return targetInfo.targetId;
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function pageByTarget(browser: Browser, targetId: string): Promise<Page> {
  const pages = browser.contexts().flatMap((context) => context.pages()).filter((page) => !page.isClosed());
  // Pane and tab order need not match CDP order. All panes can share this endpoint.
  const matches = await Promise.all(pages.map(async (page) => {
    const id = await pageTargetId(page).catch(() => null);
    return id === targetId ? page : undefined;
  }));
  const found = matches.filter((page) => page !== undefined);
  if (found.length !== 1) {
    throw new BrowserError("tab_not_ready", `CDP target '${targetId}' is not an available page.`, "Refresh browser_list. The tab may have closed or may still be opening.");
  }
  return found[0]!;
}

export function selectTab(info: BrowserInfo, tabId?: number): TabInfo {
  const matches = info.tabs.filter((tab) => tabId === undefined ? tab.active : tab.id === tabId);
  if (matches.length !== 1) {
    throw new BrowserError("tab_not_found", tabId === undefined ? "No unique active tab." : `Tab ${tabId} is unavailable in browser '${info.key}'.`, "Pass browserId and tabId from a fresh browser_list.");
  }
  return matches[0]!;
}

export function preserveBrowserDialogs(browser: Browser): void {
  // Unobserved pages must not be auto-dismissed by a second CDP connection.
  for (const context of browser.contexts()) {
    const preserveDialog = (page: Page) => page.on("dialog", () => {});
    for (const page of context.pages()) preserveDialog(page);
    context.on("page", preserveDialog);
  }
}

export class BrowserRuntime {
  readonly discover: () => Promise<BrowserInfo[]>;
  readonly control: typeof control;
  private readonly connector: (ws: string) => Promise<Browser>;
  private readonly connections = new Map<string, Browser>();

  constructor(options: RuntimeOptions = {}) {
    this.discover = options.discover ?? listBrowsers;
    this.control = options.control ?? control;
    this.connector = options.connect ?? ((ws) => chromium.connectOverCDP(ws, { timeout: 5_000 }));
  }

  async info(browserId?: string): Promise<BrowserInfo> {
    const info = selectBrowser(await this.discover(), browserId);
    return this.refresh(info);
  }

  async refresh(info: BrowserInfo): Promise<BrowserInfo> {
    const state = await this.control(info.socket, { cmd: "targets" });
    return { ...info, tabs: parseTabs(state) };
  }

  async endpoint(info: BrowserInfo): Promise<string> {
    if (info.cdpPort === null) throw new BrowserError("cdp_unavailable", `Browser '${info.key}' has no CDP endpoint.`);
    const response = await fetch(`http://127.0.0.1:${info.cdpPort}/json/version`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new BrowserError("cdp_unavailable", `CDP discovery returned HTTP ${response.status}.`);
    const data = await response.json() as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) throw new BrowserError("cdp_unavailable", "CDP discovery did not return a WebSocket URL.");
    const ws = new URL(data.webSocketDebuggerUrl);
    if (!["ws:", "wss:"].includes(ws.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(ws.hostname)) {
      throw new BrowserError("invalid_endpoint", "Expected a loopback CDP endpoint.");
    }
    return ws.href;
  }

  async connection(ws: string): Promise<Browser> {
    const cached = this.connections.get(ws);
    if (cached?.isConnected()) return cached;
    const browser = await this.connector(ws);
    preserveBrowserDialogs(browser);
    this.connections.set(ws, browser);
    browser.once("disconnected", () => {
      if (this.connections.get(ws) === browser) this.connections.delete(ws);
    });
    return browser;
  }

  async resolve(options: PageOptions = {}): Promise<PageCall> {
    let info = await this.info(options.browserId);
    const tab = selectTab(info, options.tabId);
    if (!tab.targetId) throw new BrowserError("tab_not_ready", `Tab ${tab.id} has no CDP target yet.`, "Wait for the tab to open and refresh browser_list.");
    const ws = await this.endpoint(info);
    const page = await pageByTarget(await this.connection(ws), tab.targetId);
    if (options.focus === true && !tab.active) {
      const state = await this.control(info.socket, { cmd: "activate-tab", tab: tab.id });
      info = { ...info, tabs: parseTabs(state) };
    }
    page.setDefaultTimeout(ACTION_TIMEOUT);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    return { page, browser: info, tab: selectTab(info, tab.id), ws };
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.values()].map((browser) => browser.close().catch(() => {})));
    this.connections.clear();
  }
}
