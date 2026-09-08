import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserError } from "./errors.ts";

export function normalizeUrl(input: string, cwd = process.cwd()): string {
  const value = input.trim();
  if (!value) throw new BrowserError("invalid_url", "A URL or local HTML path is required.");
  if (value === "about:blank") return value;
  if (/^(https?|file):/i.test(value)) {
    const url = new URL(value);
    if (url.protocol === "file:" && url.hostname && url.hostname !== "localhost") {
      throw new BrowserError("invalid_url", "Remote file URL hosts are not supported.");
    }
    return url.href;
  }
  const filePath = path.resolve(cwd, value);
  if (path.isAbsolute(value) || /^\.{1,2}[\\/]/.test(value) || existsSync(filePath) || /\.html?$/i.test(value)) {
    return pathToFileURL(filePath).href;
  }
  if (/^\d{2,5}$/.test(value)) return new URL(`http://localhost:${value}`).href;
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    return new URL(`http://${value}`).href;
  }
  if (/^[\w.-]+:\d+(?:[/?#]|$)/.test(value)) return new URL(`http://${value}`).href;
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    throw new BrowserError("invalid_url", "Only http:, https:, file:, and exact about:blank navigation is supported.");
  }
  if (/^[^\s/]+\.[^\s/]+(?:[/?#]|$)/.test(value)) return new URL(`https://${value}`).href;
  return pathToFileURL(filePath).href;
}
