import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeUrl } from "../src/mcp/urls.ts";
import { ArtifactStore } from "../src/mcp/artifacts.ts";
import { parseBrowsers, selectBrowser, findReusableTab, type BrowserInfo } from "../src/mcp/terminal.ts";
import { selectTab } from "../src/mcp/runtime.ts";
import { recordingTimeline } from "../src/mcp/encoding.ts";

const browser: BrowserInfo = { key: "pane-a", pid: 123, cdpPort: 9000, socket: "/tmp/a.sock", splitDir: "right", inCurrentTab: true, tabs: [
  { id: 1, url: "https://example.com", title: "First", targetId: "first", active: false },
  { id: 2, url: "https://example.com", title: "Second", targetId: "second", active: true },
] };

describe("explicit identities", () => {
  test("never selects an arbitrary pane when several share a terminal", () => {
    const other = { ...browser, key: "pane-b" };
    expect(() => selectBrowser([browser, other])).toThrow(/Multiple browsers/);
    expect(selectBrowser([browser, other], "pane-b")).toBe(other);
    expect(() => selectBrowser([browser], "missing")).toThrow(/unavailable/);
    expect(() => selectBrowser([{ ...browser, inCurrentTab: false }])).toThrow(/No browser/);
  });
  test("missing tab IDs never fall through to active tabs", () => {
    expect(selectTab(browser, 1).targetId).toBe("first");
    expect(selectTab(browser).id).toBe(2);
    expect(() => selectTab(browser, 99)).toThrow(/unavailable/);
  });
  test("reuse prefers the current same-site tab and rejects unresolved ambiguity", () => {
    expect(findReusableTab(browser, "https://example.com/next")?.id).toBe(2);
    expect(() => findReusableTab({ ...browser, tabs: browser.tabs.map((tab) => ({ ...tab, active: false })) }, "https://example.com/next")).toThrow(/Multiple same-site/);
  });
  test("malformed registries are rejected rather than silently inventing IDs", () => {
    expect(parseBrowsers({ browsers: [browser] })).toHaveLength(1);
    expect(() => parseBrowsers({ browsers: [{ tabs: [{}] }] })).toThrow(/incompatible/);
  });
});

describe("URL normalization", () => {
  test.each([
    ["localhost:3000", "http://localhost:3000/"],
    ["127.0.0.1:8080/a", "http://127.0.0.1:8080/a"],
    ["[::1]:3000", "http://[::1]:3000/"],
    ["3000", "http://localhost:3000/"],
    ["example.com/docs", "https://example.com/docs"],
    ["devbox:8080", "http://devbox:8080/"],
    ["about:blank", "about:blank"],
  ])("%s", (input, expected) => expect(normalizeUrl(input)).toBe(expected));
  test("encodes local paths correctly and rejects executable schemes", () => {
    expect(normalizeUrl("./demo page.html", "/tmp/project")).toBe("file:///tmp/project/demo%20page.html");
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow(/Only http/);
    expect(() => normalizeUrl("about:config")).toThrow(/Only http/);
  });
});

test("artifacts remain inside the workspace and do not overwrite existing files", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "tb-path-test-"));
  try {
    const root = path.join(temporary, "workspace");
    const outside = path.join(temporary, "outside");
    await mkdir(root);
    await mkdir(outside);
    const artifacts = new ArtifactStore(root);
    const saved = await artifacts.write("evidence/file.txt", "first");
    expect(await readFile(saved, "utf8")).toBe("first");
    await expect(artifacts.write("evidence/file.txt", "second")).rejects.toThrow();
    await expect(artifacts.write("../outside/file.txt", "bad")).rejects.toThrow(/workspace/);
    await symlink(outside, path.join(root, "linked"));
    await expect(artifacts.write("linked/file.txt", "bad")).rejects.toThrow(/symlinks/);
    await writeFile(path.join(outside, "input.txt"), "secret");
    await symlink(path.join(outside, "input.txt"), path.join(root, "input.txt"));
    await expect(artifacts.read("input.txt")).rejects.toThrow(/symlinks/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("recording timelines preserve static duration and variable frame intervals", () => {
  expect(recordingTimeline([{ file: "frame-00000.jpg", at: 0 }], 5_000)[0]!.durationMs).toBe(5_000);
  const timeline = recordingTimeline([{ file: "frame-00000.jpg", at: 0 }, { file: "frame-00001.jpg", at: 700 }], 1_500);
  expect(timeline.map((frame) => frame.durationMs)).toEqual([700, 800]);
});
