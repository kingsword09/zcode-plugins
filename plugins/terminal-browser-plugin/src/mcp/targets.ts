import type { FrameLocator, Locator, Page } from "playwright-core";
import { z } from "zod";
import { BrowserError } from "./errors.ts";

export interface TargetSpec {
  ref?: string;
  role?: string;
  name?: string;
  nameRegex?: string;
  exact?: boolean;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  selector?: string;
  frame?: string[];
  within?: TargetSpec;
  hasText?: string;
  hasNotText?: string;
  visible?: boolean;
  has?: TargetSpec;
  hasNot?: TargetSpec;
  and?: TargetSpec;
  or?: TargetSpec;
}

export const targetFields = {
  ref: z.string().min(1).optional().describe("Ref from the latest snapshot, such as e6 or @e6."),
  role: z.string().min(1).optional(),
  name: z.string().optional(),
  nameRegex: z.string().max(500).optional().describe("Accessible-name regular expression, without slashes."),
  exact: z.boolean().optional(),
  text: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  placeholder: z.string().min(1).optional(),
  testId: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  frame: z.array(z.string().min(1)).min(1).max(8).optional().describe("Nested iframe selectors, outermost first."),
  within: z.lazy(() => targetSchema).optional(),
  hasText: z.string().optional(),
  hasNotText: z.string().optional(),
  visible: z.boolean().optional(),
  has: z.lazy(() => targetSchema).optional(),
  hasNot: z.lazy(() => targetSchema).optional(),
  and: z.lazy(() => targetSchema).optional(),
  or: z.lazy(() => targetSchema).optional(),
};

export const targetSchema: z.ZodType<TargetSpec> = z.object(targetFields);
const selectorKeys = ["ref", "role", "text", "label", "placeholder", "testId", "selector"] as const;

export function hasTarget(target: TargetSpec): boolean {
  return selectorKeys.some((key) => target[key] !== undefined);
}

export function targetRoot(page: Page, frames?: string[]): Page | FrameLocator {
  let root: Page | FrameLocator = page;
  for (const selector of frames ?? []) root = root.frameLocator(selector);
  return root;
}

export function resolveTarget(page: Page, target: TargetSpec, depth = 0, inheritedRoot?: Page | FrameLocator | Locator): Locator {
  if (depth > 8) throw new BrowserError("invalid_target", "Target nesting exceeds eight levels.");
  const keys = selectorKeys.filter((key) => target[key] !== undefined);
  if (keys.length !== 1 || !target[keys[0]!]?.trim()) {
    throw new BrowserError("invalid_target", "target requires exactly one of ref/role/text/label/placeholder/testId/selector.");
  }
  if ((target.name !== undefined || target.nameRegex !== undefined) && !target.role) throw new BrowserError("invalid_target", "name and nameRegex require role.");
  if (target.name !== undefined && target.nameRegex !== undefined) throw new BrowserError("invalid_target", "Use either name or nameRegex.");
  if (inheritedRoot && target.frame) throw new BrowserError("invalid_target", "Set frame only on the outermost target.");
  const frameRoot = inheritedRoot ?? targetRoot(page, target.frame);
  const root = target.within ? resolveTarget(page, target.within, depth + 1, frameRoot) : frameRoot;
  let locator: Locator;
  const matchOptions = target.exact === undefined ? {} : { exact: target.exact };
  if (target.ref) {
    const ref = target.ref.replace(/^@/, "");
    if (!/^e\d+$/.test(ref)) throw new BrowserError("invalid_target", "Invalid snapshot ref. Use a fresh eN ref and its frame path.");
    locator = root.locator(`aria-ref=${ref}`);
  } else if (target.role) {
    const name = target.nameRegex === undefined ? target.name : new RegExp(target.nameRegex);
    locator = root.getByRole(target.role as Parameters<Page["getByRole"]>[0], { ...matchOptions, ...(name === undefined ? {} : { name }) });
  } else if (target.text) locator = root.getByText(target.text, matchOptions);
  else if (target.label) locator = root.getByLabel(target.label, matchOptions);
  else if (target.placeholder) locator = root.getByPlaceholder(target.placeholder, matchOptions);
  else if (target.testId) locator = root.getByTestId(target.testId);
  else locator = root.locator(target.selector!);
  if (target.hasText !== undefined || target.hasNotText !== undefined || target.visible !== undefined || target.has || target.hasNot) {
    locator = locator.filter({
      hasText: target.hasText, hasNotText: target.hasNotText, visible: target.visible,
      has: target.has ? resolveTarget(page, target.has, depth + 1, frameRoot) : undefined,
      hasNot: target.hasNot ? resolveTarget(page, target.hasNot, depth + 1, frameRoot) : undefined,
    });
  }
  if (target.and) locator = locator.and(resolveTarget(page, target.and, depth + 1, frameRoot));
  if (target.or) locator = locator.or(resolveTarget(page, target.or, depth + 1, frameRoot));
  return locator;
}

export async function uniqueTarget(page: Page, target: TargetSpec): Promise<Locator> {
  const locator = resolveTarget(page, target);
  const count = await locator.count();
  if (count !== 1) throw new BrowserError(count ? "ambiguous_target" : "target_not_found", `Target matched ${count} elements. No action was performed.`, "Take a fresh snapshot and narrow the target with within, exact, or a specific ref.");
  return locator;
}
