import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { ArtifactStore, writeJsonAtomic } from "./artifacts.ts";
import { BrowserError, withTimeout } from "./errors.ts";
import { pageByTarget, preserveBrowserDialogs } from "./runtime.ts";
import { executeAction } from "./actions.ts";
import { dialogAwareAction, prepareDialogs } from "./playwright.ts";
import type { RecordingConfig } from "./recording.ts";
import { codecPaths } from "./codec-assets.ts";
import { encodeRecording, type RecordingFrame } from "./encoding.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runRecording(config: RecordingConfig) {
  const { directory, options, job } = config;
  const jobFile = path.join(directory, "job.json");
  job.pid = process.pid;
  const update = async () => { job.updatedAt = Date.now(); await writeJsonAtomic(jobFile, job); };
  const control = async () => JSON.parse(await fs.readFile(path.join(directory, "control.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "{}"; throw error; })) as { command?: "stop" | "cancel"; outputPath?: string };
  const lockDirectory = path.join(os.tmpdir(), `zcode-terminal-browser-${process.getuid?.() ?? "user"}`, "recordings");
  await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const lock = path.join(lockDirectory, `${createHash("sha256").update(`${config.ws}:${job.targetId}`).digest("hex")}.lock`);
  let locked = false;
  let browser;
  let cdp;
  let page;
  let originalViewport: { width: number; height: number; deviceScaleFactor: number } | undefined;
  let running = true;
  let terminate = false;
  process.once("SIGTERM", () => { terminate = true; });
  const cursorId = `tb-record-cursor-${job.id}`;
  let removeCursor: (() => Promise<unknown>) | undefined;
  try {
    await update();
    try { await fs.writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 }); locked = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await fs.readFile(lock, "utf8"));
      let alive = true;
      try { if (Number.isSafeInteger(owner) && owner > 0) process.kill(owner, 0); else alive = false; } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
      if (alive) throw new BrowserError("recording_running", "Another recording worker is capturing this tab.");
      await fs.unlink(lock);
      await fs.writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      locked = true;
    }
    browser = await chromium.connectOverCDP(config.ws, { timeout: 5_000 });
    preserveBrowserDialogs(browser);
    page = await pageByTarget(browser, job.targetId);
    page.setDefaultTimeout(3_000);
    await prepareDialogs(page);
    cdp = await page.context().newCDPSession(page);
    originalViewport = await page.evaluate("({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })");
    if (options.viewport) await cdp.send("Emulation.setDeviceMetricsOverride", { ...options.viewport, deviceScaleFactor: 1, mobile: false });
    const viewport = options.viewport ?? originalViewport!;
    const width = Math.max(2, Math.floor(Math.min(options.maxWidth ?? viewport.width, viewport.width) / 2) * 2);
    const height = Math.max(2, Math.floor(viewport.height * width / viewport.width / 2) * 2);
    if (options.showCursor) {
      await page.evaluate(`(() => {
        const cursor = document.createElement('div'); cursor.id = ${JSON.stringify(cursorId)};
        cursor.textContent = '+'; cursor.style.cssText = 'position:fixed;left:0;top:0;color:#dc2626;font:bold 24px monospace;pointer-events:none;z-index:2147483647;display:none;';
        const move = e => { cursor.style.display = 'block'; cursor.style.left = (e.clientX - 7) + 'px'; cursor.style.top = (e.clientY - 14) + 'px'; };
        document.addEventListener('mousemove', move); document.documentElement.appendChild(cursor);
        cursor.addEventListener('tb-cleanup', () => { document.removeEventListener('mousemove', move); cursor.remove(); });
      })()`);
      const targetPage = page;
      removeCursor = () => targetPage.evaluate(`document.getElementById(${JSON.stringify(cursorId)})?.dispatchEvent(new Event('tb-cleanup'))`).catch(() => {});
    }
    let latest = "";
    cdp.on("Page.screencastFrame", (frame) => {
      latest = frame.data;
      void cdp!.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: options.quality, maxWidth: width, maxHeight: height });
    const seed = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: options.quality, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: width / viewport.width }, captureBeyondViewport: false });
    latest ||= seed.data;
    const frames: RecordingFrame[] = [{ file: "frame-00000.jpg", at: 0 }];
    const initialFrame = Buffer.from(latest, "base64");
    await fs.writeFile(path.join(directory, frames[0]!.file), initialFrame, { flag: "wx", mode: 0o600 });
    const start = Date.now();
    let lastFrame = latest;
    let bytesWritten = initialFrame.byteLength;
    let actionsFinished: number | undefined;
    let actionError: unknown;
    const actionTask = options.actions ? (async () => {
      try {
        for (const action of options.actions!) {
          if (!running) break;
          const result = await dialogAwareAction(page!, () => executeAction(page!, action));
          if (result.dialog) throw new BrowserError("dialog_pending", "A recording action opened a dialog requiring manual input.");
        }
      } catch (error) { if (running) actionError = error; }
      finally { actionsFinished = Date.now(); }
    })() : undefined;
    job.phase = "capturing";
    await update();
    let instruction: Awaited<ReturnType<typeof control>> = {};
    while (true) {
      instruction = await control();
      const elapsed = Date.now() - start;
      if (latest && latest !== lastFrame) {
        const data = Buffer.from(latest, "base64");
        bytesWritten += data.byteLength;
        if (bytesWritten > 256 * 1024 * 1024) throw new BrowserError("recording_limit", "Recording exceeded the 256 MB capture limit.");
        const file = `frame-${String(frames.length).padStart(5, "0")}.jpg`;
        await fs.writeFile(path.join(directory, file), data, { flag: "wx", mode: 0o600 });
        frames.push({ file, at: frames.length ? elapsed : 0 });
        lastFrame = latest;
      }
      job.frameCount = frames.length;
      job.durationMs = elapsed;
      job.progress = Math.min(0.9, elapsed / options.maxDurationMs * 0.9);
      if (Date.now() - job.updatedAt >= 500) await update();
      if (terminate || instruction.command || elapsed >= options.maxDurationMs || page.isClosed() || actionError || (actionsFinished !== undefined && Date.now() - actionsFinished >= options.settleMs)) break;
      await delay(1000 / options.fps);
    }
    running = false;
    await cdp.send("Page.stopScreencast").catch(() => {});
    await removeCursor?.();
    if (options.viewport && originalViewport && !page.isClosed()) {
      if (config.restoreViewport) await cdp.send("Emulation.setDeviceMetricsOverride", { mobile: false, deviceScaleFactor: 1, ...config.restoreViewport }).catch(() => {});
      else await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
    await cdp.detach().catch(() => {});
    cdp = undefined;
    await browser.close();
    browser = undefined;
    await actionTask;
    if (actionError) throw actionError;
    if (terminate || instruction.command === "cancel") { job.status = "cancelled"; job.phase = "cancelled"; await update(); return; }
    if (!frames.length) throw new BrowserError("recording_empty", "No frames were captured.");
    job.durationMs = Math.max(job.durationMs, 1000 / options.fps, frames.at(-1)!.at + 1);
    job.phase = "finalizing";
    await update();
    await fs.writeFile(path.join(directory, "frames.json"), JSON.stringify({ durationMs: job.durationMs, fps: options.fps, frames }, null, 2), { mode: 0o600 });
    const artifacts = new ArtifactStore(config.root);
    const output = path.join(directory, "capture.webm");
    const deadline = Date.now() + 60_000;
    await encodeRecording({ directory, outputPath: output, frames, durationMs: job.durationMs, width, height, quality: options.quality, assets: codecPaths(import.meta.url),
      check: async () => {
        instruction = await control();
        if (terminate || instruction.command === "cancel") throw new BrowserError("recording_cancelled", "Recording was cancelled.");
        if (Date.now() >= deadline) throw new BrowserError("encoding_timeout", "Recording exceeded the 60 second encoding limit; captured frames were retained.");
      },
      onProgress: async (progress) => { job.progress = 0.9 + progress * 0.09; if (Date.now() - job.updatedAt >= 500) await update(); },
    });
    instruction = await control();
    if (terminate || instruction.command === "cancel") throw new BrowserError("recording_cancelled", "Recording was cancelled.");
    let destination = instruction.outputPath ?? config.outputPath ?? `browser-artifacts/recordings/${job.id}.webm`;
    if (!destination.endsWith(".webm")) destination += ".webm";
    const saved = await artifacts.copy(destination, output);
    job.artifact = { path: saved, mimeType: "video/webm", width, height, fps: options.fps };
    await fs.unlink(output).catch(() => {});
    for (const frame of frames) await fs.unlink(path.join(directory, frame.file));
    await fs.unlink(path.join(directory, "frames.json"));
    job.status = "completed";
    job.phase = "completed";
    job.progress = 1;
    await update();
  } catch (error) {
    const cancelled = terminate || (await control().catch(() => ({} as { command?: string }))).command === "cancel";
    job.status = cancelled ? "cancelled" : "failed";
    job.phase = job.status;
    job.error = cancelled ? undefined : error instanceof Error ? error.message : String(error);
    await update();
  } finally {
    running = false;
    await removeCursor?.();
    if (cdp) {
      await cdp.send("Page.stopScreencast").catch(() => {});
      if (options.viewport) {
        if (config.restoreViewport) await cdp.send("Emulation.setDeviceMetricsOverride", { mobile: false, deviceScaleFactor: 1, ...config.restoreViewport }).catch(() => {});
        else await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      }
      await cdp.detach().catch(() => {});
    }
    await browser?.close().catch(() => {});
    if (locked) await fs.unlink(lock).catch(() => {});
  }
}

if (process.argv[1]?.endsWith("recording-worker.js") || process.argv[1]?.endsWith("recording-worker.ts")) {
  const input = process.argv[2];
  if (!input) throw new Error("Recording worker requires a job configuration path.");
  const config = JSON.parse(await fs.readFile(input, "utf8")) as RecordingConfig;
  await withTimeout(runRecording(config), 180_000, "Recording worker");
}
