import { randomUUID } from "node:crypto";
import type { CDPSession, Dialog, Page } from "playwright-core";
import { BrowserError, withTimeout } from "./errors.ts";
import { ACTION_TIMEOUT } from "./runtime.ts";
import { repaintCanvases } from "./rendering.ts";
import { resolveTarget, targetRoot, type TargetSpec } from "./targets.ts";

export { resolveTarget, type TargetSpec } from "./targets.ts";

export interface SnapshotOptions {
  frame?: string[];
  target?: TargetSpec;
  maxChars?: number;
}

export async function snapshot(page: Page, options: SnapshotOptions = {}): Promise<string> {
  const locator = options.target ? resolveTarget(page, options.target) : targetRoot(page, options.frame).locator("body");
  const text = await locator.ariaSnapshot({ mode: "ai", timeout: ACTION_TIMEOUT });
  const limit = options.maxChars ?? 32_000;
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated; narrow the snapshot target]` : text;
}

export interface ScreenshotOptions extends SnapshotOptions {
  full?: boolean;
  annotate?: boolean;
  repaintCanvases?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
}

export async function captureScreenshot(page: Page, options: ScreenshotOptions = {}) {
  if (options.full && options.clip) throw new BrowserError("invalid_arguments", "full and clip cannot be combined.");
  const snapshotText = options.annotate ? await snapshot(page, options) : undefined;
  const overlayId = `tb-annotation-${randomUUID()}`;
  const canvasRepaint = options.repaintCanvases ? await repaintCanvases(page) : undefined;
  try {
    if (snapshotText) {
      const refs = [...new Set([...snapshotText.matchAll(/ref=(e\d+)/g)].map((match) => match[1]!))];
      const root = targetRoot(page, options.target?.frame ?? options.frame);
      const boxes = [];
      for (const ref of refs.slice(0, 200)) {
        const box = await root.locator(`aria-ref=${ref}`).boundingBox({ timeout: 300 }).catch(() => null);
        if (box && box.width >= 4 && box.height >= 4) boxes.push({ ref, ...box });
      }
      await page.evaluate(`(({ id, boxes }) => {
        const overlay = document.createElement('div');
        overlay.id = id;
        overlay.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2147483647;';
        for (const b of boxes) {
          const box = document.createElement('div');
          box.style.cssText = 'position:absolute;border:2px solid #dc2626;box-sizing:border-box;left:' + (b.x + scrollX) + 'px;top:' + (b.y + scrollY) + 'px;width:' + b.width + 'px;height:' + b.height + 'px;';
          const label = document.createElement('span');
          label.textContent = b.ref;
          label.style.cssText = 'background:#dc2626;color:white;font:11px monospace;padding:0 3px;';
          box.appendChild(label);
          overlay.appendChild(box);
        }
        document.documentElement.appendChild(overlay);
      })(${JSON.stringify({ id: overlayId, boxes })})`);
    }
    const bytes = options.target && !options.annotate && !options.clip && !options.full
      ? await resolveTarget(page, options.target).screenshot({ scale: "css", timeout: 10_000 })
      : await page.screenshot({ fullPage: options.full ?? false, clip: options.clip, scale: "css", timeout: 10_000 });
    return { bytes, base64: bytes.toString("base64"), snapshotText, canvasRepaint };
  } finally {
    if (snapshotText) await page.evaluate(`document.getElementById(${JSON.stringify(overlayId)})?.remove()`).catch(() => {});
  }
}

export async function runAccessibility(page: Page, axeSource: string, tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]): Promise<unknown> {
  // CDP evaluation works even when the page's CSP disallows inline scripts.
  await page.evaluate(axeSource);
  return withTimeout(page.evaluate(`window.axe.run(document, { resultTypes: ['violations', 'incomplete'], runOnly: { type: 'tag', values: ${JSON.stringify(tags)} } })`), 20_000, "Accessibility audit");
}

export interface DialogRecord {
  id: string;
  type: string;
  message: string;
  defaultValue: string;
  at: number;
  state: "pending" | "accepted" | "dismissed" | "closed";
  closedAt?: number;
  accepted?: boolean;
  error?: string;
}

interface DialogState {
  records: DialogRecord[];
  pending: Map<string, { dialog: Dialog; record: DialogRecord }>;
  policy: "accept" | "dismiss" | "manual";
  listeners: Set<(record: DialogRecord) => void>;
  cdp?: CDPSession;
  ready?: Promise<void>;
}

const dialogs = new WeakMap<Page, DialogState>();

export function watchDialogs(page: Page, policy?: DialogState["policy"]): DialogState {
  const existing = dialogs.get(page);
  if (existing) {
    if (policy) existing.policy = policy;
    return existing;
  }
  const state: DialogState = { records: [], pending: new Map(), policy: policy ?? "manual", listeners: new Set() };
  dialogs.set(page, state);
  page.on("dialog", (dialog) => {
    const record: DialogRecord = { id: randomUUID(), type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue(), at: Date.now(), state: "pending" };
    state.records.push(record);
    if (state.records.length > 100) state.records.shift();
    state.pending.set(record.id, { dialog, record });
    for (const listener of state.listeners) listener(record);
    if (state.policy !== "manual") void respondToDialog(page, state.policy, record.id).catch(() => {});
  });
  page.once("close", () => {
    for (const entry of state.pending.values()) entry.record.state = "closed";
    state.pending.clear();
  });
  return state;
}

export async function prepareDialogs(page: Page): Promise<void> {
  const state = watchDialogs(page);
  // Native user answers bypass Playwright's Dialog API, so observe CDP closure.
  state.ready ??= (async () => {
    const session = await page.context().newCDPSession(page);
    state.cdp = session;
    session.on("Page.javascriptDialogClosed", (event) => {
      for (const { record } of state.pending.values()) {
        record.state = "closed";
        record.closedAt = Date.now();
        record.accepted = event.result;
      }
      state.pending.clear();
    });
    page.once("close", () => { void session.detach().catch(() => {}); });
    await session.send("Page.enable");
  })();
  await state.ready;
}

export function readDialogs(page: Page, clear = false): DialogRecord[] {
  const state = watchDialogs(page);
  const records = state.records.map((record) => ({ ...record }));
  if (clear) state.records = state.records.filter((record) => record.state === "pending");
  return records;
}

export async function respondToDialog(page: Page, action: "accept" | "dismiss", id?: string, promptText?: string): Promise<DialogRecord> {
  const state = watchDialogs(page);
  const pending = id ? state.pending.get(id) : state.pending.values().next().value;
  if (!pending && id && state.records.some((record) => record.id === id && record.state !== "pending")) {
    throw new BrowserError("dialog_closed", "The dialog was already closed by the browser or another actor.", "Inspect the page's resulting state. Electron offscreen dialogs may close before an agent can respond.");
  }
  if (!pending) throw new BrowserError("dialog_not_found", "No matching pending dialog.");
  if (promptText !== undefined && pending.record.type !== "prompt") throw new BrowserError("invalid_arguments", "promptText can only answer a prompt dialog.");
  try {
    if (action === "accept") await pending.dialog.accept(promptText ?? pending.record.defaultValue);
    else await pending.dialog.dismiss();
    pending.record.state = action === "accept" ? "accepted" : "dismissed";
  } catch (error) {
    pending.record.state = "closed";
    pending.record.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    state.pending.delete(pending.record.id);
  }
  return { ...pending.record };
}

export async function dialogAwareAction<T>(page: Page, action: () => Promise<T>): Promise<{ value?: T; dialog?: DialogRecord }> {
  const state = watchDialogs(page);
  if (state.pending.size && state.policy === "manual") {
    throw new BrowserError("dialog_pending", "Answer the pending dialog before another action.", "Use browser_dialogs with action accept or dismiss.");
  }
  let listener: ((record: DialogRecord) => void) | undefined;
  const opened = new Promise<{ dialog: DialogRecord }>((resolve) => {
    listener = (dialog) => { if (state.policy === "manual") resolve({ dialog: { ...dialog } }); };
    state.listeners.add(listener);
  });
  try {
    return await Promise.race([action().then((value) => ({ value })), opened]);
  } finally {
    if (listener) state.listeners.delete(listener);
  }
}
