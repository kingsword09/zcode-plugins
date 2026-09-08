import type { CDPSession, Page } from "playwright-core";

export interface Viewport {
  width: number;
  height: number;
  mobile?: boolean;
  deviceScaleFactor?: number;
}

export class PageEnvironment {
  private readonly sessions = new Map<Page, CDPSession>();
  private readonly viewports = new WeakMap<Page, Viewport>();

  async session(page: Page): Promise<CDPSession> {
    let session = this.sessions.get(page);
    if (!session) {
      session = await page.context().newCDPSession(page);
      this.sessions.set(page, session);
      page.once("close", () => this.sessions.delete(page));
    }
    return session;
  }

  override(page: Page) { return this.viewports.get(page); }

  async viewport(page: Page, viewport?: Viewport) {
    const cdp = await this.session(page);
    if (viewport) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, mobile: viewport.mobile ?? false, deviceScaleFactor: viewport.deviceScaleFactor ?? 1 });
      this.viewports.set(page, { ...viewport });
    } else {
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      this.viewports.delete(page);
    }
    return this.readViewport(page);
  }

  async readViewport(page: Page) {
    return page.evaluate("({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })") as Promise<{ width: number; height: number; deviceScaleFactor: number }>;
  }

  async configure(page: Page, options: {
    offline?: boolean;
    colorScheme?: "dark" | "light" | "no-preference";
    reducedMotion?: "reduce" | "no-preference";
    headers?: Record<string, string>;
    geolocation?: { latitude: number; longitude: number; accuracy?: number };
    reset?: boolean;
  }) {
    const cdp = await this.session(page);
    if (options.offline !== undefined || options.reset) {
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: options.reset ? false : options.offline!, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
    if (options.colorScheme || options.reducedMotion || options.reset) {
      await page.emulateMedia({ colorScheme: options.reset ? null : options.colorScheme, reducedMotion: options.reset ? null : options.reducedMotion });
    }
    if (options.headers || options.reset) await page.setExtraHTTPHeaders(options.reset ? {} : options.headers!);
    if (options.geolocation) await cdp.send("Emulation.setGeolocationOverride", { accuracy: 10, ...options.geolocation });
    if (options.reset) await cdp.send("Emulation.clearGeolocationOverride");
  }

  async close() {
    await Promise.all([...this.sessions.values()].map((session) => session.detach().catch(() => {})));
    this.sessions.clear();
  }
}
