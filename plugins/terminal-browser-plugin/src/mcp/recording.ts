import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ArtifactStore, writeJsonAtomic } from "./artifacts.ts";
import { actionSchema } from "./actions.ts";
import { BrowserError } from "./errors.ts";
import type { PageCall } from "./runtime.ts";
import type { Viewport } from "./environment.ts";

export const recordingOptionsSchema = z.object({
  fps: z.number().int().min(1).max(30).default(12),
  quality: z.number().int().min(1).max(100).default(80),
  maxDurationMs: z.number().int().min(500).max(90_000).default(20_000),
  maxWidth: z.number().int().min(320).max(3840).optional(),
  viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(320).max(2160) }).optional(),
  settleMs: z.number().int().min(0).max(5_000).default(500),
  showCursor: z.boolean().default(true),
  actions: z.array(actionSchema).max(100).optional(),
});

export interface RecordingJob {
  id: string;
  browserId: string;
  tabId: number;
  targetId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "preparing" | "capturing" | "finalizing" | "completed" | "failed" | "cancelled";
  startedAt: number;
  updatedAt: number;
  pid?: number;
  progress: number;
  frameCount: number;
  durationMs: number;
  artifact?: { path: string; mimeType: string; width: number; height: number; fps: number };
  error?: string;
}

export interface RecordingConfig {
  job: RecordingJob;
  ws: string;
  root: string;
  directory: string;
  outputPath?: string;
  options: z.infer<typeof recordingOptionsSchema>;
  restoreViewport?: Viewport;
}

function processAlive(pid?: number) {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class RecordingManager {
  private readonly artifacts: ArtifactStore;
  constructor(private readonly root: string, private readonly worker: string) {
    this.artifacts = new ArtifactStore(root);
  }

  async directory(id: string) {
    if (!/^rec-[0-9a-f-]{36}$/.test(id)) throw new BrowserError("invalid_recording_id", "Invalid recording ID.");
    return path.dirname(await this.artifacts.output(`.zcode/terminal-browser/recordings/${id}/job.json`));
  }

  async start(call: PageCall, input: z.input<typeof recordingOptionsSchema> & { outputPath?: string }, restoreViewport?: Viewport): Promise<RecordingJob> {
    const options = recordingOptionsSchema.parse(input);
    if (input.outputPath) await this.artifacts.output(input.outputPath);
    const active = (await this.list()).find((job) => job.targetId === call.tab.targetId && job.status === "running");
    if (active) throw new BrowserError("recording_running", `This tab already has recording ${active.id}.`);
    const id = `rec-${randomUUID()}`;
    const directory = await this.directory(id);
    const job: RecordingJob = { id, browserId: call.browser.key, tabId: call.tab.id, targetId: call.tab.targetId!, status: "running", phase: "preparing", startedAt: Date.now(), updatedAt: Date.now(), progress: 0, frameCount: 0, durationMs: 0 };
    await writeJsonAtomic(path.join(directory, "job.json"), job);
    const config: RecordingConfig = { job, ws: call.ws, root: this.root, directory, outputPath: input.outputPath, options, restoreViewport };
    await writeJsonAtomic(path.join(directory, "config.json"), config);
    const log = await fs.open(path.join(directory, "worker.log"), "a", 0o600);
    try {
      const worker = spawn(process.execPath, [this.worker, path.join(directory, "config.json")], { cwd: this.root, detached: true, stdio: ["ignore", log.fd, log.fd] });
      await new Promise<void>((resolve, reject) => { worker.once("spawn", resolve); worker.once("error", reject); });
      job.pid = worker.pid;
      // The worker is the only writer of job.json after spawn.
      worker.unref();
    } catch (error) {
      job.status = "failed";
      job.phase = "failed";
      job.error = String(error);
      await writeJsonAtomic(path.join(directory, "job.json"), job);
      throw error;
    } finally { await log.close(); }
    return job;
  }

  async status(id: string, outputPath?: string): Promise<RecordingJob> {
    const directory = await this.directory(id);
    let job: RecordingJob;
    try { job = JSON.parse(await fs.readFile(path.join(directory, "job.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BrowserError("recording_not_found", `No recording ${id}.`); throw error; }
    if (job.status === "running" && Date.now() - job.updatedAt > 5_000 && !processAlive(job.pid)) {
      job = { ...job, status: "failed", phase: "failed", error: "Recording worker exited before completing; captured frames remain in the job directory.", updatedAt: Date.now() };
      await writeJsonAtomic(path.join(directory, "job.json"), job);
    }
    if (outputPath && job.status === "completed" && job.artifact) {
      if (job.artifact.mimeType !== "video/webm") throw new BrowserError("legacy_recording", "This older recording contains a frame manifest. Create a new recording to export WebM.");
      if (!outputPath.endsWith(".webm")) outputPath += ".webm";
      if (path.resolve(this.root, outputPath) !== job.artifact.path) job = { ...job, artifact: { ...job.artifact, path: await this.artifacts.copy(outputPath, job.artifact.path) } };
    }
    return job;
  }

  async command(id: string, command: "stop" | "cancel", outputPath?: string) {
    const job = await this.status(id);
    if (job.status === "running") {
      if (outputPath) await this.artifacts.output(outputPath);
      const directory = await this.directory(id);
      await writeJsonAtomic(path.join(directory, "control.json"), { command, outputPath });
    }
    return job.status === "completed" ? this.status(id, outputPath) : { ...job, requested: command };
  }

  async list(): Promise<RecordingJob[]> {
    const directory = path.join(this.root, ".zcode", "terminal-browser", "recordings");
    const ids = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const results = await Promise.all(ids.filter((id) => /^rec-[0-9a-f-]{36}$/.test(id)).map((id) => this.status(id).catch(() => null)));
    return results.filter((job): job is RecordingJob => job !== null).sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
  }
}
