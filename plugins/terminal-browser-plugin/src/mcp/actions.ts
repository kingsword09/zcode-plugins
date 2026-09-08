import type { Page } from "playwright-core";
import { z } from "zod";
import { BrowserError } from "./errors.ts";
import { ACTION_TIMEOUT } from "./runtime.ts";
import { targetSchema, uniqueTarget, resolveTarget, type TargetSpec } from "./targets.ts";

export const pointSchema = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() });
export const modifiersSchema = z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).max(5);
export const actionSchema = z.object({
  type: z.enum(["click", "dblclick", "fill", "type", "press", "hover", "check", "uncheck", "select", "scroll", "drag", "wait"]),
  target: targetSchema.optional(),
  to: targetSchema.optional(),
  x: z.number().finite().nonnegative().optional(),
  y: z.number().finite().nonnegative().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  keys: z.array(z.string().min(1)).min(1).max(6).optional(),
  value: z.union([z.string(), z.object({ label: z.string().optional(), value: z.string().optional(), index: z.number().int().nonnegative().optional() }), z.array(z.string())]).optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  modifiers: modifiersSchema.optional(),
  deltaX: z.number().finite().optional(),
  deltaY: z.number().finite().optional(),
  path: z.array(pointSchema).min(2).max(500).optional(),
  durationMs: z.number().int().min(0).max(10_000).optional(),
  state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
});
export type BrowserAction = z.infer<typeof actionSchema>;

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new BrowserError("invalid_arguments", `${name} is required for this action.`);
  return value;
}

function keyCombination(keys: string[]): string {
  return keys.map((key) => ({ CMD: "Meta", META: "Meta", CTRL: "Control", ALT: "Alt", SHIFT: "Shift", ENTER: "Enter", ESC: "Escape" })[key.toUpperCase()] ?? key).join("+");
}

export async function withModifiers<T>(page: Page, keys: string[], action: () => Promise<T>): Promise<T> {
  const held: string[] = [];
  try {
    for (const key of keys) {
      await page.keyboard.down(key);
      held.push(key);
    }
    return await action();
  } finally {
    for (const key of held.reverse()) await page.keyboard.up(key).catch(() => {});
  }
}

export async function executeAction(page: Page, action: BrowserAction): Promise<void> {
  const locator = () => uniqueTarget(page, required(action.target, "target"));
  switch (action.type) {
    case "click":
    case "dblclick": {
      const options = { button: action.button, modifiers: action.modifiers, timeout: ACTION_TIMEOUT };
      if (action.target) {
        const target = await locator();
        await (action.type === "click" ? target.click(options) : target.dblclick(options));
      } else {
        const x = required(action.x, "x");
        const y = required(action.y, "y");
        await withModifiers(page, action.modifiers ?? [], () => action.type === "click" ? page.mouse.click(x, y, { button: action.button }) : page.mouse.dblclick(x, y, { button: action.button }));
      }
      return;
    }
    case "fill": await (await locator()).fill(required(action.text, "text")); return;
    case "type": {
      const text = required(action.text, "text");
      if (action.target) await (await locator()).pressSequentially(text);
      else await page.keyboard.type(text);
      return;
    }
    case "press": {
      const key = action.keys ? keyCombination(action.keys) : required(action.key, "key");
      if (action.target) await (await locator()).press(key);
      else await page.keyboard.press(key);
      return;
    }
    case "hover":
      if (action.target) await (await locator()).hover({ modifiers: action.modifiers });
      else await withModifiers(page, action.modifiers ?? [], () => page.mouse.move(required(action.x, "x"), required(action.y, "y")));
      return;
    case "check": await (await locator()).setChecked(true); return;
    case "uncheck": await (await locator()).setChecked(false); return;
    case "select": await (await locator()).selectOption(required(action.value, "value")); return;
    case "scroll": {
      let x = action.x;
      let y = action.y;
      if (action.target) {
        const box = await (await locator()).boundingBox();
        if (!box) throw new BrowserError("target_not_visible", "Scroll target has no visible bounding box.");
        x = box.x + box.width / 2;
        y = box.y + box.height / 2;
      }
      if (x === undefined && y === undefined) {
        const viewport = await page.evaluate("({ width: innerWidth, height: innerHeight })") as { width: number; height: number };
        x = viewport.width / 2;
        y = viewport.height / 2;
      }
      await withModifiers(page, action.modifiers ?? [], async () => {
        await page.mouse.move(required(x, "x"), required(y, "y"));
        await page.mouse.wheel(action.deltaX ?? 0, action.deltaY ?? 0);
      });
      return;
    }
    case "drag": {
      if (action.path) {
        const points = action.path;
        await withModifiers(page, action.modifiers ?? [], async () => {
          await page.mouse.move(points[0]!.x, points[0]!.y);
          await page.mouse.down({ button: action.button });
          try {
            for (const point of points.slice(1)) {
              await page.mouse.move(point.x, point.y);
              if (action.durationMs) await page.waitForTimeout(action.durationMs / (points.length - 1));
            }
          } finally {
            await page.mouse.up({ button: action.button }).catch(() => {});
          }
        });
      } else {
        const from = await locator();
        const to = await uniqueTarget(page, required(action.to, "to"));
        await withModifiers(page, action.modifiers ?? [], () => from.dragTo(to));
      }
      return;
    }
    case "wait":
      if (action.target) await resolveTarget(page, action.target).waitFor({ state: action.state ?? "visible", timeout: ACTION_TIMEOUT });
      else await page.waitForTimeout(required(action.durationMs, "durationMs"));
  }
}

export function targetFromFlat(input: TargetSpec & { target?: TargetSpec }): TargetSpec {
  if (input.target) return input.target;
  return input;
}
