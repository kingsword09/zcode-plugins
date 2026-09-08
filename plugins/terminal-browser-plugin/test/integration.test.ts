/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as netServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";
import { createBrowserServer } from "../src/mcp/server.ts";
import { pageTargetId } from "../src/mcp/runtime.ts";
import type { BrowserInfo } from "../src/mcp/terminal.ts";
import { RecordingManager, type RecordingJob } from "../src/mcp/recording.ts";

const executable = process.env.TB_TEST_BROWSER ?? chromium.executablePath();
const available = existsSync(executable);
const testDist = process.env.TB_TEST_DIST ? path.resolve(process.env.TB_TEST_DIST) : undefined;
if (testDist && !available) throw new Error("ZIP verification requires Chromium; install it or set TB_TEST_BROWSER.");
const suite = available ? describe : describe.skip;
if (!available) console.warn("Chromium integration tests skipped: run bunx playwright-core install chromium.");

const fixture = `<!doctype html><html lang="en"><title>Browser integration</title><body style="margin:20px;font:16px sans-serif;background:#fff;color:#111">
<h1>Browser integration</h1><section id="one"><button onclick="window.clicked='one'">Save</button></section><section id="two"><button onclick="window.clicked='two'">Save</button></section>
<label>Name<input id="name"></label><label><input id="checked" type="checkbox">Enabled</label>
<select id="select"><option value="a">Alpha</option><option value="b">Beta</option></select>
<input id="file" type="file" hidden onchange="window.uploaded=this.files[0]?.name">
<button id="chooser" onclick="document.querySelector('#file').click()">Upload</button>
<button id="prompt" onclick="window.answer=prompt('Your name', 'default')">Prompt</button>
<button id="console" onclick="console.log('integration log'); fetch('/failure')">Log</button>
<a id="download" href="/download">Download</a><a id="popup" target="_blank" href="/popup">Popup</a>
<div id="scroller" style="margin-top:20px;width:180px;height:100px;overflow:auto;border:1px solid #333"><div style="height:500px;background:#99d6b3">Scroll region</div></div>
<iframe id="embedded" title="Embedded" src="/frame"></iframe>
</body></html>`;

suite("MCP through real Chromium/CDP", () => {
  let root: string;
  let browser: Browser;
  let context: BrowserContext;
  let page1: Page;
  let page2: Page;
  let page3: Page;
  let closeApplication: (() => Promise<void>) | undefined;
  let client: Client;
  let port: number;
  let url: string;
  let shimDirectory: string;
  let sockets: ReturnType<typeof netServer>[] = [];
  const panes: Array<{ key: string; current: boolean; active: number; tabs: Array<{ id: number; page: Page }> }> = [];
  const web = httpServer((request, response) => {
    if (request.url === "/registry") {
      void discover().then((browsers) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ browsers })); }).catch((error) => { response.writeHead(500); response.end(String(error)); });
    }
    else if (request.url === "/download") { response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=fixture.txt" }); response.end("download payload"); }
    else if (request.url === "/frame") { response.writeHead(200, { "content-type": "text/html" }); response.end('<button onclick="this.textContent=\'Frame clicked\'">Frame button</button>'); }
    else if (request.url === "/failure") { response.writeHead(503); response.end("unavailable"); }
    else if (request.url === "/popup") { response.writeHead(200, { "content-type": "text/html" }); response.end("<h1>Popup result</h1>"); }
    else if (request.url === "/csp") { response.writeHead(200, { "content-type": "text/html", "content-security-policy": "script-src 'none'" }); response.end('<html lang="en"><title>Restricted page</title><h1>Restricted page</h1></html>'); }
    else { response.writeHead(200, { "content-type": "text/html" }); response.end(fixture); }
  });

  async function discover(): Promise<BrowserInfo[]> {
    return Promise.all(panes.map(async (pane) => ({
      key: pane.key, pid: process.pid, cdpPort: port, socket: path.join(root, `${pane.key}.sock`), splitDir: "right", inCurrentTab: pane.current,
      tabs: await Promise.all(pane.tabs.filter((tab) => !tab.page.isClosed()).map(async (tab) => ({ id: tab.id, url: tab.page.url(), title: "Browser integration", active: tab.id === pane.active, targetId: await pageTargetId(tab.page) }))),
    })));
  }

  async function control<T = unknown>(socket: string, request: Record<string, unknown>): Promise<T> {
    const pane = panes.find((pane) => path.join(root, `${pane.key}.sock`) === socket)!;
    let openedTab: number | undefined;
    if (request.cmd === "open-tab") {
      const page = await context.newPage();
      page.on("dialog", () => {});
      openedTab = Math.max(...pane.tabs.map((tab) => tab.id), 0) + 1;
      pane.tabs.push({ id: openedTab, page });
      pane.active = openedTab;
      await page.goto(String(request.url));
    } else if (request.cmd === "activate-tab") pane.active = Number(request.tab);
    else if (request.cmd === "close-tab") {
      const tab = pane.tabs.find((tab) => tab.id === request.tab);
      await tab?.page.close();
      pane.tabs = pane.tabs.filter((tab) => tab.id !== request.tab);
      pane.active = pane.tabs[0]?.id ?? 0;
    }
    const registry = await discover();
    return { ...registry.find((browser) => browser.key === pane.key), openedTab } as T;
  }

  async function connectClient(name: string, dist = testDist) {
    const connected = new Client({ name, version: "1" });
    if (dist) {
      const transport = new StdioClientTransport({ command: path.join(shimDirectory, "node"), args: [path.join(dist, "mcp", "server.js")], cwd: root, env: { PATH: shimDirectory }, stderr: "pipe" });
      await connected.connect(transport);
      return { client: connected, close: async () => { await connected.close(); } };
    }
    const application = createBrowserServer({ root, discover, control });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await application.server.connect(serverTransport);
    await connected.connect(clientTransport);
    return { client: connected, close: async () => { await connected.close(); await application.close(); } };
  }

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content));
    return result.structuredContent as Record<string, any>;
  }

  async function inspectVideo(file: string, at = 0.5) {
    const probe = await context.newPage();
    try {
      const data = (await readFile(file)).toString("base64");
      return await probe.evaluate(async ({ data, at }) => {
        const video = document.createElement("video");
        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], { type: "video/webm" }));
        try {
          video.src = url;
          document.body.append(video);
          await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("WebM could not be decoded")); });
          const seeked = new Promise<void>((resolve) => { video.onseeked = () => resolve(); });
          video.currentTime = Math.min(at, video.duration - 0.01);
          await seeked;
          const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          const drawing = canvas.getContext("2d")!; drawing.drawImage(video, 0, 0);
          const pixels = drawing.getImageData(0, 0, canvas.width, canvas.height).data;
          return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, colors: new Set(pixels).size, pixel: Array.from(drawing.getImageData(Math.floor(canvas.width * 0.9), Math.floor(canvas.height * 0.9), 1, 1).data) };
        } finally { video.remove(); URL.revokeObjectURL(url); }
      }, { data, at });
    } finally { await probe.close(); }
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "tb-integration-"));
    await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(web.address() as { port: number }).port}`;
    const listener = netServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    browser = await chromium.launch({ executablePath: executable, headless: true, args: [`--remote-debugging-port=${port}`] });
    context = await browser.newContext({ viewport: null, acceptDownloads: true });
    page1 = await context.newPage(); page2 = await context.newPage(); page3 = await context.newPage();
    for (const page of [page1, page2, page3]) page.on("dialog", () => {});
    await Promise.all([page1.goto(url), page2.goto(url), page3.goto(url)]);
    panes.push({ key: "pane-a", current: true, active: 1, tabs: [{ id: 1, page: page1 }, { id: 2, page: page2 }] }, { key: "pane-b", current: false, active: 1, tabs: [{ id: 1, page: page3 }] });
    shimDirectory = path.join(root, "bin");
    await mkdir(shimDirectory);
    await symlink(execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim(), path.join(shimDirectory, "node"));
    await writeFile(path.join(shimDirectory, "terminal-browser"), `#!/usr/bin/env node\nif(process.argv.includes('--version')) console.log('terminal-browser v0.8.0'); else fetch(${JSON.stringify(`${url}/registry`)}).then(r=>{if(!r.ok)throw new Error('registry unavailable');return r.text()}).then(text=>process.stdout.write(text));\n`, { mode: 0o755 });
    for (const pane of panes) {
      const socketPath = path.join(root, `${pane.key}.sock`);
      const socket = netServer((connection) => {
        let buffer = "";
        connection.on("data", (data) => {
          buffer += data.toString();
          if (!buffer.includes("\n")) return;
          const request = JSON.parse(buffer.split("\n")[0]!);
          void control(socketPath, request).then((data) => connection.end(`${JSON.stringify({ id: request.id, ok: true, data })}\n`)).catch((error) => connection.end(`${JSON.stringify({ id: request.id, ok: false, error: String(error) })}\n`));
        });
      });
      await new Promise<void>((resolve) => socket.listen(socketPath, resolve));
      sockets.push(socket);
    }
    const connected = await connectClient("integration");
    client = connected.client;
    closeApplication = connected.close;
  }, 30_000);

  afterAll(async () => {
    await closeApplication?.();
    await browser?.close();
    await Promise.all(sockets.map((socket) => new Promise<void>((resolve) => socket.close(() => resolve()))));
    await new Promise<void>((resolve) => web.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  }, 20_000);

  test("schema discovery exposes typed features without recursive-schema failures", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("browser_record");
    expect(tools.tools.map((tool) => tool.name)).toContain("browser_diff");
    expect(tools.tools.length).toBeGreaterThan(30);
    const status = await call("browser_status");
    expect(status.capabilities.recording.webm).toBe(true);
    expect(status.capabilities.recording.externalEncoderRequired).toBe(false);
  });

  test("duplicate URLs and shared CDP endpoints resolve exact browser and tab", async () => {
    await page1.evaluate("window.identity='a1'"); await page2.evaluate("window.identity='a2'"); await page3.evaluate("window.identity='b1'");
    expect((await call("browser_evaluate", { browserId: "pane-a", tabId: 2, code: "window.identity" })).value).toBe("a2");
    expect((await call("browser_evaluate", { browserId: "pane-b", tabId: 1, code: "window.identity" })).value).toBe("b1");
    const missing = await client.callTool({ name: "browser_evaluate", arguments: { browserId: "pane-a", tabId: 99, code: "window.clicked='wrong'" } });
    expect(missing.isError).toBe(true);
    panes[1]!.current = true;
    const ambiguous = await client.callTool({ name: "browser_snapshot", arguments: {} });
    expect(ambiguous.isError).toBe(true);
    panes[1]!.current = false;
    panes[0]!.active = 1;
    expect((await call("browser_evaluate", { code: "window.identity" })).value).toBe("a1");
  });

  test("ambiguous locators have no effects; scoped locators act on the intended element", async () => {
    const result = await client.callTool({ name: "browser_click", arguments: { browserId: "pane-a", tabId: 1, role: "button", name: "Save" } });
    expect(result.isError).toBe(true);
    expect(await page1.evaluate("window.clicked")).toBeUndefined();
    await call("browser_click", { browserId: "pane-a", tabId: 1, target: { role: "button", name: "Save", within: { selector: "#two" } } });
    expect(await page1.evaluate<string>("window.clicked")).toBe("two");
  });

  test("frame locators, checkbox state, and label-based selection work through MCP", async () => {
    await call("browser_check", { selector: "#checked", checked: true });
    expect(await page1.locator("#checked").isChecked()).toBe(true);
    await call("browser_select", { selector: "#select", value: { label: "Beta" } });
    expect(await page1.locator("#select").inputValue()).toBe("b");
    const frameSnapshot = await call("browser_snapshot", { frame: ["#embedded"] });
    expect(frameSnapshot.snapshot).toContain("Frame button");
    await call("browser_click", { target: { frame: ["#embedded"], role: "button", name: "Frame button" } });
    expect(await page1.frameLocator("#embedded").getByRole("button").innerText()).toBe("Frame clicked");
  });

  test("scroll coordinates anchor the intended nested scroller", async () => {
    const box = (await page1.locator("#scroller").boundingBox())!;
    await call("browser_cua", { action: "scroll", x: box.x + 50, y: box.y + 50, deltaY: 180 });
    await page1.waitForFunction("document.querySelector('#scroller').scrollTop > 0");
    expect(await page1.evaluate<number>("scrollY")).toBe(0);
  });

  test("hidden-input uploads and downloads create real file evidence", async () => {
    await writeFile(path.join(root, "upload.txt"), "upload payload");
    await call("browser_upload", { selector: "#file", filePaths: ["upload.txt"] });
    expect(await page1.evaluate<string>("window.uploaded")).toBe("upload.txt");
    const download = await call("browser_download", { target: { selector: "#download" }, outputPath: "downloads/fixture.txt" });
    expect(await readFile(download.path, "utf8")).toBe("download payload");
  });

  test("prompt dialogs can be answered after the opening tool returns", async () => {
    const clicked = await call("browser_click", { selector: "#prompt" });
    expect(clicked.dialog.type).toBe("prompt");
    await call("browser_dialogs", { action: "accept", id: clicked.dialog.id, promptText: "MCP user" });
    await page1.waitForFunction("window.answer === 'MCP user'");
  });

  test("manual dialog closure clears pending state and policy can return to manual", async () => {
    const session = await context.newCDPSession(page1);
    await session.send("Page.enable");
    const opened = await call("browser_click", { selector: "#prompt" });
    await session.send("Page.handleJavaScriptDialog", { accept: false });
    await session.detach();
    await page1.waitForFunction("window.answer === null");
    const dialogs = await call("browser_dialogs");
    expect(dialogs.dialogs.find((dialog: any) => dialog.id === opened.dialog.id).state).toBe("closed");
    await call("browser_dialogs", { action: "policy", defaultAction: "accept" });
    await call("browser_click", { selector: "#prompt" });
    await page1.waitForFunction("window.answer === 'default'");
    await call("browser_dialogs", { action: "policy", defaultAction: "manual" });
    const next = await call("browser_click", { selector: "#prompt" });
    expect(next.dialog.type).toBe("prompt");
    await call("browser_dialogs", { action: "dismiss", id: next.dialog.id });
  });

  test("custom choosers, full pointer paths, and modifiers reach the intended controls", async () => {
    await call("browser_upload", { selector: "#chooser", mode: "chooser", filePaths: ["upload.txt"] });
    expect(await page1.evaluate<string>("window.uploaded")).toBe("upload.txt");
    await page1.evaluate(`window.pointerEvents=[]; window.capturePointer=e=>window.pointerEvents.push({type:e.type,x:e.clientX,y:e.clientY,shift:e.shiftKey,buttons:e.buttons}); for(const name of ['mousedown','mousemove','mouseup']) document.addEventListener(name,window.capturePointer)`);
    await call("browser_cua", { action: "drag", path: [{ x: 600, y: 50 }, { x: 620, y: 90 }, { x: 650, y: 50 }], modifiers: ["Shift"] });
    await call("browser_cua", { action: "click", x: 650, y: 60 });
    const events = await page1.evaluate<Array<{ type: string; x: number; y: number; shift: boolean; buttons: number }>>("window.pointerEvents");
    expect(events.some((event) => event.type === "mousemove" && event.x === 620 && event.y === 90 && event.shift && event.buttons === 1)).toBe(true);
    expect(events.at(-1)?.shift).toBe(false);
    expect(events.at(-1)?.buttons).toBe(0);
    await page1.evaluate(`for(const name of ['mousedown','mousemove','mouseup']) document.removeEventListener(name,window.capturePointer)`);
    await call("browser_act", { action: { type: "wait", target: { selector: "#not-present" }, state: "detached" } });
  });

  test("offline and URL blocking affect only the selected tab", async () => {
    await call("browser_environment", { browserId: "pane-a", tabId: 1, offline: true });
    try {
      expect(await page1.evaluate<boolean>("fetch('/offline-check').then(()=>false,()=>true)")).toBe(true);
      expect(await page2.evaluate<boolean>("fetch('/online-check').then(r=>r.ok)")).toBe(true);
    } finally { await call("browser_environment", { browserId: "pane-a", tabId: 1, reset: true }); }
    await call("browser_network", { action: "block", pattern: "**/blocked-check" });
    try {
      expect(await page1.evaluate<boolean>("fetch('/blocked-check').then(()=>false,()=>true)")).toBe(true);
      expect(await page2.evaluate<boolean>("fetch('/blocked-check').then(r=>r.ok)")).toBe(true);
    } finally { await call("browser_network", { action: "unblock", pattern: "**/blocked-check" }); }
  });

  test("viewport validation, saved screenshots, pixel diffs, and responsive restore", async () => {
    const invalid = await client.callTool({ name: "browser_viewport", arguments: { width: 10, height: 400 } });
    expect(invalid.isError).toBe(true);
    await call("browser_viewport", { width: 1000, height: 700 });
    const shot = await call("browser_screenshot", { outputPath: "screenshots/baseline.png" });
    const image = PNG.sync.read(await readFile(shot.path));
    expect([image.width, image.height]).toEqual([1000, 700]);
    expect(new Set(image.data).size).toBeGreaterThan(3);
    const identical = await call("browser_diff", { baselinePath: "screenshots/baseline.png" });
    expect(identical.changedPixels).toBe(0);
    await page1.evaluate("document.body.style.background='#ff0000'");
    const changed = await call("browser_diff", { baselinePath: "screenshots/baseline.png" });
    expect(changed.changedRatio).toBeGreaterThan(0.3);
    await page1.evaluate("document.body.style.background='#ffffff'");
    const responsive = await call("browser_responsive", { viewports: [{ width: 390, height: 844 }, { width: 1280, height: 720 }] });
    expect(responsive.captures).toHaveLength(2);
    expect((await call("browser_viewport")).viewport.width).toBe(1000);
    const annotated = await call("browser_screenshot", { annotate: true, outputPath: "screenshots/annotated.png" });
    expect(annotated.snapshot).toContain("ref=");
    expect(await page1.locator('[id^="tb-annotation-"]').count()).toBe(0);
  }, 20_000);

  test("console/network/HAR and CPU profiles return verifiable evidence", async () => {
    await call("browser_network", { action: "har_start" });
    await call("browser_click", { selector: "#console" });
    await page1.waitForTimeout(100);
    expect((await call("browser_console")).entries.some((entry: any) => entry.text === "integration log")).toBe(true);
    expect((await call("browser_network", { filter: "/failure" })).entries.some((entry: any) => entry.status === 503)).toBe(true);
    const har = await call("browser_network", { action: "har_stop" });
    expect(JSON.parse(await readFile(har.path, "utf8")).log.entries.length).toBeGreaterThan(0);
    await call("browser_performance", { action: "profile_start" });
    const profile = await call("browser_performance", { action: "profile_stop" });
    expect(JSON.parse(await readFile(profile.path, "utf8")).nodes.length).toBeGreaterThan(0);
  });

  test("optional 2D canvas repaint preserves pixels and drawing state", async () => {
    const before = await page1.evaluate(`(()=>{const c=document.createElement('canvas');c.id='repaint-test';c.width=32;c.height=32;document.body.append(c);const ctx=c.getContext('2d');ctx.fillStyle='#157a62';ctx.fillRect(0,0,32,32);ctx.scale(2,2);ctx.globalAlpha=0.5;return Array.from(ctx.getImageData(0,0,32,32).data)})()`);
    try {
      const screenshot = await call("browser_screenshot", { repaintCanvases: true });
      expect(screenshot.canvasRepaint.repainted).toBe(1);
      const after = await page1.evaluate(`(()=>{const ctx=document.querySelector('#repaint-test').getContext('2d');return {pixels:Array.from(ctx.getImageData(0,0,32,32).data),alpha:ctx.globalAlpha,scale:ctx.getTransform().a}})()`) as { pixels: unknown; alpha: number; scale: number };
      expect(after.pixels).toEqual(before);
      expect(after.alpha).toBe(0.5);
      expect(after.scale).toBe(2);
    } finally { await page1.evaluate("document.querySelector('#repaint-test').remove()"); }
  });

  test("pause prevents actions until resumed; storage exports stay private", async () => {
    await call("browser_session", { action: "pause" });
    const paused = await client.callTool({ name: "browser_fill", arguments: { selector: "#name", value: "blocked" } });
    expect(paused.isError).toBe(true);
    await call("browser_session", { action: "resume" });
    await call("browser_fill", { selector: "#name", value: "resumed" });
    expect(await page1.locator("#name").inputValue()).toBe("resumed");
    await call("browser_storage", { area: "local", action: "set", key: "check", value: "passed" });
    const exported = await call("browser_storage", { area: "local", action: "export" });
    expect(JSON.parse(await readFile(exported.path, "utf8")).value.check).toBe("passed");
  });

  test("a second MCP session cannot mutate a tab already claimed by the first", async () => {
    const other = await connectClient("other-session");
    const otherClient = other.client;
    try {
      const result = await otherClient.callTool({ name: "browser_fill", arguments: { browserId: "pane-a", tabId: 1, selector: "#name", value: "stolen" } });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as any).error.code).toBe("tab_claimed");
      expect(await page1.locator("#name").inputValue()).toBe("resumed");
      const opened = await call("browser_click", { selector: "#prompt" });
      expect(opened.dialog.type).toBe("prompt");
      await call("browser_dialogs", { action: "dismiss", id: opened.dialog.id });
      await call("browser_session", { action: "release" });
      const released = await otherClient.callTool({ name: "browser_fill", arguments: { browserId: "pane-a", tabId: 1, selector: "#name", value: "released" } });
      expect(released.isError).not.toBe(true);
    } finally { await other.close(); }
  });

  test("static recordings preserve elapsed duration and survive manager recreation", async () => {
    await page1.evaluate("document.activeElement?.blur()");
    const start = await call("browser_record", { action: "start", maxDurationMs: 1_400, fps: 8, showCursor: false });
    const id = start.recording.id;
    const manager = new RecordingManager(root, "unused-after-recreation");
    let job: RecordingJob = await manager.status(id);
    const deadline = Date.now() + 25_000;
    while (job.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      job = await manager.status(id);
    }
    expect(job.error).toBeUndefined();
    expect(job.status).toBe("completed");
    expect(job.durationMs).toBeGreaterThanOrEqual(1_300);
    expect(job.frameCount).toBeGreaterThan(0);
    expect(existsSync(job.artifact!.path)).toBe(true);
    expect(job.artifact!.mimeType).toBe("video/webm");
    expect((await readFile(job.artifact!.path)).subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    const video = await inspectVideo(job.artifact!.path, 1.2);
    expect(video.duration).toBeGreaterThan(1.2);
    expect(video.width).toBe(1000);
    expect(video.height).toBe(700);
    expect(video.colors).toBeGreaterThan(3);
  }, 30_000);

  test("bundled video encoding preserves frame changes and timing without external tools", async () => {
    await page1.evaluate(`(()=>{const layer=document.createElement('div');layer.id='recording-colors';layer.style.cssText='position:fixed;inset:0;background:#e02b37;z-index:2147483647';document.body.append(layer)})()`);
    let id: string | undefined;
    try {
      const start = await call("browser_record", { action: "start", maxDurationMs: 1_600, fps: 8, showCursor: false, viewport: { width: 320, height: 320 } });
      id = start.recording.id;
      const ready = Date.now() + 10_000;
      while ((await call("browser_record", { action: "status", id })).recording.phase === "preparing" && Date.now() < ready) await new Promise((resolve) => setTimeout(resolve, 50));
      await new Promise((resolve) => setTimeout(resolve, 250));
      await page1.evaluate("document.querySelector('#recording-colors').style.background='#2176dd'");
      let job: RecordingJob;
      const deadline = Date.now() + 20_000;
      do {
        await new Promise((resolve) => setTimeout(resolve, 100));
        job = (await call("browser_record", { action: "status", id })).recording;
      } while (job.status === "running" && Date.now() < deadline);
      expect(job.error).toBeUndefined();
      expect(job.status).toBe("completed");
      expect(job.frameCount).toBeGreaterThan(1);
      const before = await inspectVideo(job.artifact!.path, 0.05);
      const after = await inspectVideo(job.artifact!.path, job.durationMs / 1000 - 0.05);
      expect([before.width, before.height]).toEqual([320, 320]);
      expect(before.pixel[0]).toBeGreaterThan(180);
      expect(before.pixel[2]).toBeLessThan(90);
      expect(after.pixel[2]).toBeGreaterThan(180);
      expect(after.pixel[0]).toBeLessThan(90);
      expect(after.duration).toBeGreaterThan(1.5);
    } finally {
      if (id) await call("browser_record", { action: "cancel", id });
      await page1.evaluate("document.querySelector('#recording-colors')?.remove()");
    }
  }, 30_000);

  test("recording cancellation is recoverable without resolving a live tab", async () => {
    const start = await call("browser_record", { action: "start", browserId: "pane-a", tabId: 2, maxDurationMs: 10_000, showCursor: false });
    const readyDeadline = Date.now() + 10_000;
    while ((await call("browser_record", { action: "status", id: start.recording.id })).recording.phase === "preparing" && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const opened = await call("browser_click", { browserId: "pane-a", tabId: 1, selector: "#prompt" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const dialogs = await call("browser_dialogs", { browserId: "pane-a", tabId: 1 });
    expect(dialogs.dialogs.find((dialog: any) => dialog.id === opened.dialog.id)?.state).toBe("pending");
    await call("browser_dialogs", { action: "dismiss", id: opened.dialog.id });
    await call("browser_record", { action: "cancel", id: start.recording.id });
    const deadline = Date.now() + 15_000;
    let result;
    do {
      await new Promise((resolve) => setTimeout(resolve, 200));
      result = await call("browser_record", { action: "status", id: start.recording.id });
    } while (result.recording.status === "running" && Date.now() < deadline);
    expect(result.recording.status).toBe("cancelled");
  }, 20_000);

  test("scripted recording captures actions and restores the prior viewport", async () => {
    const start = await call("browser_record", { action: "start", maxDurationMs: 3_000, viewport: { width: 640, height: 480 }, actions: [{ type: "fill", target: { selector: "#name" }, text: "recorded" }], settleMs: 400, showCursor: false });
    const deadline = Date.now() + 15_000;
    let recording: RecordingJob;
    do {
      await new Promise((resolve) => setTimeout(resolve, 200));
      recording = (await call("browser_record", { action: "status", id: start.recording.id })).recording;
    } while (recording.status === "running" && Date.now() < deadline);
    expect(recording.error).toBeUndefined();
    expect(recording.status).toBe("completed");
    expect(recording.frameCount).toBeGreaterThan(1);
    expect(await page1.locator("#name").inputValue()).toBe("recorded");
    expect((await call("browser_viewport")).viewport.width).toBe(1000);
  }, 20_000);

  test("packaged MCP server runs with only copied dist and a protocol fixture", async () => {
    const dist = testDist ?? path.resolve(import.meta.dir, "../dist");
    expect(existsSync(path.join(dist, "mcp", "recording-worker.js"))).toBe(true);
    const packaged = path.join(root, "packaged");
    await cp(dist, packaged, { recursive: true, dereference: false });
    const connection = await connectClient("packaging", packaged);
    const packagedClient = connection.client;
    try {
      expect((await packagedClient.listTools()).tools.length).toBeGreaterThan(30);
      const result = await packagedClient.callTool({ name: "browser_snapshot", arguments: { browserId: "pane-a", tabId: 1 } });
      expect(result.isError).not.toBe(true);
      const audit = await packagedClient.callTool({ name: "browser_accessibility", arguments: { browserId: "pane-a", tabId: 1 } });
      expect(audit.isError).not.toBe(true);
      expect(Array.isArray((audit.structuredContent as any).violations)).toBe(true);
      await page2.goto(`${url}/csp`);
      const restricted = await packagedClient.callTool({ name: "browser_accessibility", arguments: { browserId: "pane-a", tabId: 2 } });
      expect(restricted.isError).not.toBe(true);
    } finally { await connection.close(); }
  }, 20_000);
});
