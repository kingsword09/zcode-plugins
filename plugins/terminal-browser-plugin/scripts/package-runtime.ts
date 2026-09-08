import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codecAssets } from "../src/mcp/codec-assets.ts";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const source = path.dirname(require.resolve("playwright-core/package.json"));
const destination = path.join(root, "dist", "node_modules", "playwright-core");
await mkdir(path.dirname(destination), { recursive: true });
// Preserve runtime-relative imports; the MCP never serves Playwright's viewer UI.
await cp(source, destination, {
  recursive: true,
  dereference: true,
  filter: (file) => {
    const relative = path.relative(source, file).split(path.sep).join("/");
    return relative !== "types" && relative !== "lib/vite" && !relative.endsWith(".d.ts");
  },
});
await mkdir(path.join(root, "dist", "assets"), { recursive: true });
// Axe serializes its own function source; further bundler transforms break it.
await cp(require.resolve("axe-core/axe.min.js"), path.join(root, "dist", "assets", "axe.min.js"));
const codecDirectory = path.join(root, "dist", "assets", "recording");
await mkdir(codecDirectory, { recursive: true });
for (const asset of Object.values(codecAssets)) await cp(require.resolve(asset.module), path.join(codecDirectory, asset.file));
await writeFile(path.join(root, "dist", "package.json"), JSON.stringify({ type: "module", private: true }));
const licenseDirectory = path.join(root, "dist", "licenses");
await mkdir(licenseDirectory, { recursive: true });
const notices = new Map<string, { name: string; version: string; license?: string; files: string[] }>();
async function copyLicenses(name: string, importer: NodeJS.Require) {
  let entry: string;
  try { entry = importer.resolve(`${name}/package.json`); }
  catch { entry = importer.resolve(name === "@modelcontextprotocol/sdk" ? `${name}/server/mcp.js` : name); }
  let directory = path.dirname(entry);
  let manifest: { name: string; version: string; license?: string; dependencies?: Record<string, string> } | undefined;
  while (directory !== path.dirname(directory)) {
    manifest = await readFile(path.join(directory, "package.json"), "utf8").then((text) => JSON.parse(text)).catch(() => undefined);
    if (manifest?.name === name) break;
    directory = path.dirname(directory);
  }
  if (!manifest || manifest.name !== name) throw new Error(`Cannot locate license package: ${name}`);
  const key = `${name}@${manifest.version}`;
  if (notices.has(key)) return;
  const notice = { name, version: manifest.version, license: manifest.license, files: [] as string[] };
  notices.set(key, notice);
  for (const file of (await readdir(directory)).filter((file) => /^(?:licen[sc]e|notice|copying)(?:[.-].*)?$/i.test(file)).sort()) {
    const destination = `${key.replaceAll("/", "-")}-${file}`;
    await cp(path.join(directory, file), path.join(licenseDirectory, destination), { recursive: true });
    notice.files.push(destination);
  }
  const dependencyRequire = createRequire(path.join(directory, "package.json"));
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) await copyLicenses(dependency, dependencyRequire);
}
for (const name of ["@modelcontextprotocol/sdk", "zod", "axe-core", "pngjs", "pixelmatch", "@jsquash/jpeg", "@jsquash/webp", "@jsquash/resize", "mediabunny"]) await copyLicenses(name, require);
for (const [name, file] of Object.entries({ jpeg: "@jsquash/jpeg/codec/LICENSE.codec.md", webp: "@jsquash/webp/codec/LICENSE.codec.md", resize: "@jsquash/resize/lib/resize/LICENSE.codec.md" })) await cp(require.resolve(file), path.join(licenseDirectory, `${name}-codec-LICENSE.md`));
const mediaVersion = [...notices.values()].find((notice) => notice.name === "mediabunny")!.version;
await writeFile(path.join(licenseDirectory, "recording-NOTICE.md"), `This software is based in part on the work of the Independent JPEG Group.\n\nThe bundled JPEG, WebP, and resize codecs retain their original license notices.\nMediabunny ${mediaVersion} is distributed under MPL-2.0 without source modifications.\nIts corresponding source is included in https://registry.npmjs.org/mediabunny/-/mediabunny-${mediaVersion}.tgz (the src/ directory).\n`);
await writeFile(path.join(licenseDirectory, "packages.json"), JSON.stringify([...notices.values()].sort((a, b) => a.name.localeCompare(b.name)), null, 2));
