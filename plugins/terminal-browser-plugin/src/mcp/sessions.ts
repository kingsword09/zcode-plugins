import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserError } from "./errors.ts";
import type { PageCall } from "./runtime.ts";
import { writeJsonAtomic } from "./artifacts.ts";

interface Claim {
  owner: string;
  pid: number;
  browserId: string;
  tabId: number;
  targetId: string;
  state: "claimed" | "paused" | "handoff";
}
type TabIdentity = Pick<PageCall, "browser" | "tab">;

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export class SessionClaims {
  readonly owner = process.env.ZCODE_SESSION_ID ?? randomUUID();
  private readonly held = new Map<string, Claim>();

  constructor(private readonly directory = path.join(os.tmpdir(), `zcode-terminal-browser-${process.getuid?.() ?? "user"}`, "claims")) {}

  private async file(call: TabIdentity) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(`${call.browser.key}:${call.browser.pid}:${call.tab.targetId ?? `tab-${call.tab.id}`}`).digest("hex");
    return path.join(this.directory, `${key}.json`);
  }

  async status(call: TabIdentity): Promise<Claim | null> {
    const file = await this.file(call);
    try {
      const claim = JSON.parse(await fs.readFile(file, "utf8")) as Claim;
      if (!alive(claim.pid)) {
        await fs.unlink(file).catch(() => {});
        return null;
      }
      return claim;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async claim(call: TabIdentity, state: Claim["state"] = "claimed"): Promise<Claim> {
    const file = await this.file(call);
    const current = await this.status(call);
    if (current && (current.owner !== this.owner || current.pid !== process.pid)) {
      throw new BrowserError("tab_claimed", `Tab ${call.tab.id} is being controlled by another plugin session.`, "Use a separate tab or wait for that session to release it.");
    }
    const claim: Claim = { owner: this.owner, pid: process.pid, browserId: call.browser.key, tabId: call.tab.id, targetId: call.tab.targetId ?? `tab-${call.tab.id}`, state };
    if (current) await writeJsonAtomic(file, claim);
    else {
      const temporary = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(claim), { flag: "wx", mode: 0o600 });
      try {
        await fs.link(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new BrowserError("tab_claimed", "Another session just claimed this tab.");
        throw error;
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
    }
    this.held.set(file, claim);
    return claim;
  }

  async beforeAction(call: TabIdentity): Promise<void> {
    const current = await this.status(call);
    if (current?.owner === this.owner && current.state === "paused") {
      throw new BrowserError("session_paused", "Automation is paused for manual interaction.", "Use browser_session action resume to continue.");
    }
    await this.claim(call, current?.state === "handoff" ? "handoff" : "claimed");
  }

  async release(call: TabIdentity): Promise<void> {
    const file = await this.file(call);
    const current = await this.status(call);
    if (current && (current.owner !== this.owner || current.pid !== process.pid)) throw new BrowserError("tab_claimed", "Only the owning plugin session can release this tab.");
    await fs.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    this.held.delete(file);
  }

  async releaseAll(keepHandoffs = false): Promise<void> {
    for (const [file, claim] of this.held) {
      if (keepHandoffs && claim.state === "handoff") continue;
      await fs.unlink(file).catch(() => {});
      this.held.delete(file);
    }
  }
}
