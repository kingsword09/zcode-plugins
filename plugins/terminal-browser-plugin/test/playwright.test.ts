import { describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { resolveTarget } from "../src/mcp/playwright.ts";
import { findReusableTab, type BrowserInfo } from "../src/mcp/terminal.ts";

/**
 * resolveTarget maps a structured spec onto a playwright locator builder.
 * The calls are recorded, then asserted — no real browser involved.
 */
function recorderPage(): { page: unknown; calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const locator = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === "count" || prop === "first") {
          return () => {
            calls.push({ method: prop, args: [] });
            return locator;
          };
        }
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return locator;
        };
      },
    },
  );
  const page = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === "locator") return (...args: unknown[]) => {
          calls.push({ method: "locator", args });
          return locator;
        };
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return locator;
        };
      },
    },
  );
  return { page, calls };
}

describe("resolveTarget", () => {
  test("no specifiers throws", () => {
    expect(() => resolveTarget(recorderPage().page as unknown as Page, {})).toThrow(
      /requires exactly one of/i,
    );
  });

  test("ref maps to aria-ref engine", () => {
    const { page, calls } = recorderPage();
    resolveTarget(page as unknown as Page, { ref: "e6" });
    expect(calls).toEqual([{ method: "locator", args: ["aria-ref=e6"] }]);
  });

  test("role without name", () => {
    const { page, calls } = recorderPage();
    resolveTarget(page as unknown as Page, { role: "link" });
    expect(calls).toEqual([{ method: "getByRole", args: ["link", {}] }]);
  });

  test("role with name", () => {
    const { page, calls } = recorderPage();
    resolveTarget(page as unknown as Page, { role: "link", name: "Learn more" });
    expect(calls).toEqual([
      { method: "getByRole", args: ["link", { name: "Learn more" }] },
    ]);
  });

  test("text/label/placeholder/testId map to their builders", () => {
    const a = recorderPage();
    resolveTarget(a.page as unknown as Page, { text: "hello" });
    expect(a.calls).toEqual([{ method: "getByText", args: ["hello", {}] }]);

    const b = recorderPage();
    resolveTarget(b.page as unknown as Page, { label: "Name" });
    expect(b.calls).toEqual([{ method: "getByLabel", args: ["Name", {}] }]);

    const c = recorderPage();
    resolveTarget(c.page as unknown as Page, { placeholder: "you@example.com" });
    expect(c.calls).toEqual([{ method: "getByPlaceholder", args: ["you@example.com", {}] }]);

    const d = recorderPage();
    resolveTarget(d.page as unknown as Page, { testId: "submit" });
    expect(d.calls).toEqual([{ method: "getByTestId", args: ["submit"] }]);
  });

  test("selector maps to page.locator", () => {
    const { page, calls } = recorderPage();
    resolveTarget(page as unknown as Page, { selector: "#pet" });
    expect(calls).toEqual([{ method: "locator", args: ["#pet"] }]);
  });

  test("multiple target specifiers are rejected before querying the page", () => {
    const { page, calls } = recorderPage();
    expect(() => resolveTarget(page as unknown as Page, { ref: "e2", selector: "div" })).toThrow(/exactly one/);
    expect(calls).toEqual([]);
  });
});

describe("findReusableTab", () => {
  const browser: BrowserInfo = {
    key: "1-1",
    pid: 1,
    cdpPort: 9222,
    socket: "",
    splitDir: "right",
    inCurrentTab: true,
    tabs: [
      { id: 1, url: "https://example.com/page", title: "Example", active: false, targetId: "a" },
      { id: 2, url: "https://iana.org/", title: "IANA", active: true, targetId: "b" },
      { id: 3, url: "about:blank", title: "", active: false, targetId: null },
    ],
  };

  test("same hostname reuses", () => {
    expect(findReusableTab(browser, "https://example.com/other")?.id).toBe(1);
  });

  test("different hostname does not reuse", () => {
    expect(findReusableTab(browser, "https://mozilla.org/")).toBeUndefined();
  });

  test("about:blank tabs never match", () => {
    expect(findReusableTab(browser, "about:blank")).toBeUndefined();
  });

  test("invalid url never reuses", () => {
    expect(findReusableTab(browser, "not a url")).toBeUndefined();
  });
});
