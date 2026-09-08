/** Run inside a supported terminal: node scripts/verify.mjs dist/mcp/server.js. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";
import { BufferSource, Input, WEBM } from "mediabunny";

if (!process.argv[2]) throw new Error("Usage: node scripts/verify.mjs <dist/mcp/server.js>");
const serverPath = path.resolve(process.argv[2]);
const root = process.env.TB_VERIFY_ROOT ?? await mkdtemp(path.join(os.tmpdir(), "tb-live-verify-"));
await mkdir(root, { recursive: true });
const reportPath = process.env.TB_VERIFY_REPORT ?? path.join(root, "report.json");
await mkdir(path.dirname(reportPath), { recursive: true });
const runtimeDirectory = process.env.TB_VERIFY_RUNTIME_DIR;
const browserEnvironment = {
  ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  ...(runtimeDirectory ? {
    XDG_RUNTIME_DIR: runtimeDirectory,
    XDG_STATE_HOME: path.join(runtimeDirectory, "state"),
    XDG_DATA_HOME: path.join(runtimeDirectory, "data"),
    XDG_CACHE_HOME: path.join(runtimeDirectory, "cache"),
    TERMINAL_BROWSER_INTEROP_DIR: path.join(runtimeDirectory, "interop"),
    TERMINAL_BROWSER_APPDATA: path.join(runtimeDirectory, "profile"),
  } : {}),
};
const report = { root, serverPath, runtimeDirectory, terminal: process.env.TERM_PROGRAM ?? process.env.TERM, startedAt: new Date().toISOString(), results: [], panes: [], stderr: "" };
const fixture = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terminal Browser Verification</title>
<style>*{box-sizing:border-box}body{margin:0;padding:24px;background:#f5f6f8;color:#17212b;font:16px system-ui}main{max-width:960px;margin:auto}h1{font-size:24px;margin:0 0 24px}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:8px;max-width:100%}button{margin-right:8px}canvas{display:block;width:100%;max-width:560px;height:auto;margin:24px 0}iframe{width:100%;height:64px;border:1px solid #d4d6da}#output{min-height:24px;color:#126045}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}</style></head><body><main>
<h1>Terminal Browser Verification</h1><form onsubmit="return false">
<label>Name <input id="name" autocomplete="off"></label>
<label>Mode <select id="mode"><option value="basic">Basic</option><option value="pro">Pro</option></select></label>
<label><input type="checkbox" id="enabled"> Enabled</label>
<div class="actions"><button id="save" type="button">Save</button><button id="confirm" type="button" onclick="document.querySelector('#output').textContent=window.confirm('Verification confirmation')?'Dialog verified':'Dialog cancelled'">Confirm</button><button id="upload" type="button" onclick="document.querySelector('#file').click()">Upload</button><a id="download" href="/download">Download</a><a id="popup" target="_blank" href="/popup">New tab</a></div>
<input id="file" type="file" hidden onchange="document.querySelector('#output').textContent='Uploaded: '+this.files[0].name"></form>
<p id="output" role="status">Ready</p><canvas id="scene" width="560" height="180" aria-label="Interactive color grid"></canvas><iframe title="Embedded controls" id="frame" src="/frame"></iframe>
<script>document.querySelector('#save').onclick=()=>{document.querySelector('#output').textContent='Saved: '+document.querySelector('#name').value+'/'+document.querySelector('#mode').value;console.log('verification saved');fetch('/health')};const canvas=document.querySelector('#scene'),ctx=canvas.getContext('2d');ctx.fillStyle='#157a62';ctx.fillRect(0,0,280,180);ctx.fillStyle='#ef4665';ctx.fillRect(280,0,280,180);canvas.onpointerdown=e=>{ctx.fillStyle='#ffda45';ctx.fillRect(0,0,560,180);document.querySelector('#output').textContent='Canvas clicked'};</script>
</main></body></html>`;
const web = createServer((request, response) => {
  if (request.url === "/download") { response.writeHead(200, { "content-type": "text/plain", "content-disposition": "attachment; filename=tb-verification.txt" }); response.end("terminal-browser download verified"); }
  else if (request.url === "/frame") { response.writeHead(200, { "content-type": "text/html" }); response.end('<button onclick="this.textContent=\'Frame verified\'">Frame control</button>'); }
  else if (request.url === "/popup") { response.writeHead(200, { "content-type": "text/html" }); response.end("<h1>Created tab verified</h1>"); }
  else if (request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); }
  else { response.writeHead(200, { "content-type": "text/html" }); response.end(fixture); }
});
await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${web.address().port}`;
await writeFile(path.join(root, "upload.txt"), "terminal-browser upload verified");
let client;
let selected = {};
let recordingId;
const createdTabs = [];
class UnsupportedRuntime extends Error {}

async function connect() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: root, env: browserEnvironment, stderr: "pipe" });
  transport.stderr?.on("data", (data) => { report.stderr = (report.stderr + data.toString()).slice(-12_000); });
  client = new Client({ name: "terminal-browser-live-verifier", version: "0.6.0" });
  await client.connect(transport);
}

async function call(name, args = {}, targeted = true) {
  const result = await client.callTool({ name, arguments: { ...(targeted ? selected : {}), ...args } }, undefined, { timeout: 120_000 });
  if (result.isError) throw Object.assign(new Error(`${name}: ${JSON.stringify(result.structuredContent ?? result.content)}`), { code: result.structuredContent?.error?.code });
  assert(result.structuredContent, `${name} must return structuredContent`);
  return result.structuredContent;
}

async function step(name, action, required = false) {
  const started = Date.now();
  try {
    const evidence = await action();
    report.results.push({ name, passed: true, ms: Date.now() - started, evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    const unsupported = error instanceof UnsupportedRuntime;
    report.results.push({ name, passed: false, status: unsupported ? "unsupported" : "failed", ms: Date.now() - started, error: String(error) });
    console.error(`${unsupported ? "UNSUPPORTED" : "FAIL"} ${name}: ${error}`);
    if (!unsupported) process.exitCode = 1;
    if (required) throw error;
  } finally { await writeFile(reportPath, JSON.stringify(report, null, 2)); }
}

async function waitRecording(id) {
  const deadline = Date.now() + 30_000;
  do {
    const { recording } = await call("browser_record", { action: "status", id }, false);
    if (recording.status !== "running") {
      assert.equal(recording.status, "completed", recording.error);
      return recording;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error("Recording did not complete in 30 seconds");
}

try {
  await connect();
  await step("protocol discovery and installed capabilities", async () => {
    const tools = await client.listTools();
    assert(tools.tools.length > 30);
    const status = await call("browser_status", {}, false);
    assert(status.terminalBrowser.installed);
    assert.equal(status.capabilities.recording.externalEncoderRequired, false);
    return { tools: tools.tools.map((tool) => tool.name), terminalBrowser: status.terminalBrowser.version, encoder: status.capabilities.recording.encoder };
  }, true);
  await step("visible split with exact browser and tab identity", async () => {
    const opened = await call("browser_open", { url, direction: "right", size: 0.55 }, false);
    assert.equal(opened.panes.length, 1);
    const pane = opened.panes[0];
    selected = { browserId: pane.key, tabId: pane.tabs.find((tab) => tab.active).id };
    report.panes.push(pane.key);
    await call("browser_wait", { target: { role: "heading", name: "Terminal Browser Verification" } });
    return selected;
  }, true);
  await step("semantic actions, state queries, and iframe controls", async () => {
    assert((await call("browser_snapshot")).snapshot.includes("ref="));
    await call("browser_fill", { label: "Name", value: "Kitty" });
    await call("browser_type", { target: { label: "Name" }, text: " verified" });
    await call("browser_select", { selector: "#mode", value: { label: "Pro" } });
    await call("browser_check", { selector: "#enabled", checked: true });
    const action = await call("browser_act", { action: { type: "click", target: { role: "button", name: "Save", exact: true } } });
    assert(action.snapshot.includes("Saved: Kitty verified/pro"));
    await call("browser_click", { target: { frame: ["#frame"], role: "button", name: "Frame control" } });
    assert((await call("browser_snapshot", { frame: ["#frame"] })).snapshot.includes("Frame verified"));
  });
  await step("desktop/mobile screenshots and canvas pixels", async () => {
    const result = await call("browser_responsive", { viewports: [{ width: 1280, height: 800 }, { width: 390, height: 844 }], repaintCanvases: true });
    for (const capture of result.captures) {
      const png = PNG.sync.read(await readFile(capture.path));
      assert.equal(png.width, capture.width);
      assert.equal(png.height, capture.height);
      assert.equal(capture.horizontalOverflow, false);
      let green = 0; let red = 0;
      for (let offset = 0; offset < png.data.length; offset += 4) {
        if (png.data[offset] === 21 && png.data[offset + 1] === 122 && png.data[offset + 2] === 98) green++;
        if (png.data[offset] === 239 && png.data[offset + 1] === 70 && png.data[offset + 2] === 101) red++;
      }
      assert(green > 2000 && red > 2000, "Canvas must contain both rendered color regions");
      capture.canvasPixels = { green, red };
    }
    return result.captures;
  });
  await step("coordinate canvas interaction and visual difference", async () => {
    await call("browser_screenshot", { outputPath: "evidence/baseline.png" });
    const { value: box } = await call("browser_query", { target: { selector: "#scene" }, property: "box" });
    await call("browser_cua", { action: "click", x: box.x + box.width / 2, y: box.y + box.height / 2 });
    assert.equal((await call("browser_query", { target: { selector: "#output" }, property: "text" })).value, "Canvas clicked");
    const diff = await call("browser_diff", { baselinePath: "evidence/baseline.png" });
    assert(diff.changedPixels > 2000);
    return { path: diff.path, changedPixels: diff.changedPixels };
  });
  await step("custom file chooser and completed download", async () => {
    await call("browser_upload", { target: { role: "button", name: "Upload" }, mode: "chooser", filePaths: ["upload.txt"] });
    assert.equal((await call("browser_query", { target: { selector: "#output" }, property: "text" })).value, "Uploaded: upload.txt");
    const download = await call("browser_download", { target: { role: "link", name: "Download" }, outputPath: "evidence/download.txt" });
    assert.equal(await readFile(download.path, "utf8"), "terminal-browser download verified");
    return download.path;
  });
  await step("native confirmation dialog across tool calls", async () => {
    const opened = await call("browser_click", { selector: "#confirm" });
    assert.equal(opened.dialog.type, "confirm");
    const state = await call("browser_dialogs");
    const dialog = state.dialogs.find((dialog) => dialog.id === opened.dialog.id);
    if (dialog && dialog.state !== "pending") {
      throw new UnsupportedRuntime(`Host closed native confirm before follow-up: ${JSON.stringify(dialog)}`);
    }
    try { await call("browser_dialogs", { action: "accept", id: opened.dialog.id }); }
    catch (error) { if (error.code === "dialog_closed") throw new UnsupportedRuntime(error.message); throw error; }
    await call("browser_wait", { target: { text: "Dialog verified", exact: true } });
  });
  await step("network, accessibility, and CPU evidence", async () => {
    await call("browser_network", { action: "har_start" });
    await call("browser_click", { selector: "#save" });
    const har = await call("browser_network", { action: "har_stop" });
    assert(JSON.parse(await readFile(har.path, "utf8")).log);
    const audit = await call("browser_accessibility");
    assert(Array.isArray(audit.violations));
    await call("browser_performance", { action: "profile_start" });
    const profile = await call("browser_performance", { action: "profile_stop" });
    assert(JSON.parse(await readFile(profile.path, "utf8")).nodes.length);
    return { har: har.path, audit: audit.path, profile: profile.path };
  });
  await step("new and blank tabs close by returned IDs", async () => {
    for (const destination of [`${url}/popup`, "about:blank"]) {
      const created = await call("browser_tab", { action: "new", url: destination });
      createdTabs.push(created.tabId);
      await call("browser_tab", { action: "close", tabId: created.tabId });
      createdTabs.pop();
    }
    await call("browser_tab", { action: "switch", tabId: selected.tabId });
  });
  await step("recording survives the actual MCP process exiting", async () => {
    const { recording } = await call("browser_record", { action: "start", maxDurationMs: 1800, showCursor: false, outputPath: "evidence/recording.webm" });
    recordingId = recording.id;
    await client.close();
    await connect();
    const completed = await waitRecording(recordingId);
    recordingId = undefined;
    const content = await readFile(completed.artifact.path);
    assert(content.length > 0);
    assert.equal(completed.artifact.mimeType, "video/webm");
    assert.equal(content.subarray(0, 4).toString("hex"), "1a45dfa3");
    const media = new Input({ source: new BufferSource(content), formats: [WEBM] });
    try { completed.encodedDuration = await media.getDurationFromMetadata(); assert(completed.encodedDuration >= 1.5); }
    finally { media.dispose(); }
    return completed;
  });
  await step("final visible screenshot and activity release", async () => {
    const screenshot = await call("browser_screenshot", { annotate: true, outputPath: "evidence/final.png" });
    await call("browser_done", {}, false);
    return screenshot.path;
  });
} catch (error) {
  process.exitCode = 1;
  report.error = String(error);
} finally {
  if (recordingId) await call("browser_record", { action: "cancel", id: recordingId }, false).catch(() => {});
  for (const tabId of createdTabs) await call("browser_tab", { action: "close", tabId }).catch(() => {});
  await call("browser_done", {}, false).catch(() => {});
  await client?.close().catch(() => {});
  await new Promise((resolve) => web.close(resolve));
  report.completedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report: ${reportPath}`);
  console.log(`Artifacts: ${root}`);
}
