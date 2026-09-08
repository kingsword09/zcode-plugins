import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { z } from "zod";
import { codecAssets } from "../src/mcp/codec-assets.ts";

export const pluginRoot = path.resolve(import.meta.dir, "..");
export const repositoryRoot = path.resolve(pluginRoot, "../..");
export const releaseDirectory = path.join(repositoryRoot, ".cache", "releases");
const manifestSchema = z.object({
  name: z.literal("terminal-browser"),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  author: z.object({ name: z.string() }).passthrough(),
  commands: z.literal("commands"),
  skills: z.literal("skills"),
}).passthrough();
const listingSchema = z.object({
  description: z.string(),
  description_i18n: z.record(z.string(), z.string()),
  category: z.string(),
  keywords: z.array(z.string()),
}).strict();
const marketplaceSchema = z.object({
  name: z.string(),
  plugins: z.array(z.object({ name: z.string(), version: z.string().optional() }).passthrough()),
}).passthrough();
type Marketplace = z.infer<typeof marketplaceSchema>;

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function archiveInfo(data: Uint8Array) {
  if (data.byteLength > 100 * 1024 * 1024) throw new Error("Release ZIP exceeds 100 MB");
  let unpackedBytes = 0;
  let count = 0;
  const files = unzipSync(data, { filter: (entry) => {
    const segments = entry.name.split("/");
    if (entry.name.includes("\\") || segments.some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/.test(entry.name)) throw new Error(`Unsafe ZIP path: ${entry.name}`);
    unpackedBytes += entry.originalSize;
    if (++count > 20_000 || entry.originalSize > 50 * 1024 * 1024 || unpackedBytes > 500 * 1024 * 1024) throw new Error("Release ZIP exceeds extraction limits");
    return true;
  } });
  for (const required of [".zcode-plugin/plugin.json", "dist/package.json", "dist/mcp/server.js", "dist/mcp/recording-worker.js", "dist/node_modules/playwright-core/package.json", "dist/node_modules/playwright-core/LICENSE", "dist/assets/axe.min.js", "dist/licenses/packages.json", "commands/tb.md", "skills/terminal-browser/SKILL.md", "skills/web-gui-tester/SKILL.md", "README.md", "LICENSE"]) {
    if (!files[required]?.byteLength) throw new Error(`Release ZIP is missing ${required}`);
  }
  for (const asset of Object.values(codecAssets)) {
    if (!files[`dist/assets/recording/${asset.file}`]?.byteLength) throw new Error(`Release ZIP is missing recording codec ${asset.file}`);
  }
  for (const file of Object.keys(files)) {
    if (!/^(?:dist\/|commands\/|skills\/|\.zcode-plugin\/plugin\.json$|README\.md$|LICENSE$)/.test(file)) throw new Error(`Unexpected release file: ${file}`);
    if (/\.d\.ts$|^dist\/node_modules\/playwright-core\/(?:types|lib\/vite)\//.test(file)) throw new Error(`Unpruned Playwright asset: ${file}`);
  }
  const manifest = manifestSchema.parse(JSON.parse(Buffer.from(files[".zcode-plugin/plugin.json"]!).toString("utf8")));
  const file = `${manifest.name}-${manifest.version}.zip`;
  return {
    files,
    manifest,
    metadata: { name: manifest.name, version: manifest.version, tag: `${manifest.name}-v${manifest.version}`, file, sha256: sha256(data), bytes: data.byteLength, unpackedBytes, fileCount: count },
  };
}

export async function packPlugin(outputDirectory = releaseDirectory, root = pluginRoot) {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path.join(root, ".zcode-plugin/plugin.json"), "utf8")));
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (pkg.version !== manifest.version) throw new Error("package.json and plugin.json versions must match");
  const entries: Record<string, Uint8Array> = {};
  async function collect(relative: string) {
    const absolute = path.join(root, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Release inputs must not contain symlinks: ${relative}`);
    if (info.isDirectory()) {
      for (const child of (await readdir(absolute)).sort()) await collect(`${relative}/${child}`);
    } else if (info.isFile()) entries[relative] = await readFile(absolute);
    else throw new Error(`Unsupported release input: ${relative}`);
  }
  for (const name of [".zcode-plugin/plugin.json", "README.md", "LICENSE", "dist", manifest.commands, manifest.skills]) await collect(name);
  const zipEntries: Zippable = {};
  for (const name of Object.keys(entries).sort()) {
    const content = entries[name]!;
    // ZCode 3.11.2's ZIP stream can stall on large deflated entries in Node 26.
    zipEntries[name] = [content, { level: content.byteLength > 65_536 ? 0 : 9, mtime: new Date(1980, 0, 1), os: 3, attrs: 0o100644 << 16 }];
  }
  const data = zipSync(zipEntries, { level: 9 });
  const { metadata } = archiveInfo(data);
  await mkdir(outputDirectory, { recursive: true });
  const archive = path.join(outputDirectory, metadata.file);
  await writeFile(archive, data);
  await writeFile(`${archive}.sha256`, `${metadata.sha256}  ${metadata.file}\n`);
  await writeFile(path.join(outputDirectory, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return { archive, ...metadata };
}

export async function extractArchive(data: Uint8Array, destination: string) {
  const archive = archiveInfo(data);
  await mkdir(destination);
  for (const [name, content] of Object.entries(archive.files)) {
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx", mode: 0o644 });
  }
  return archive.metadata;
}

export function releaseUrl(metadata: ReturnType<typeof archiveInfo>["metadata"], repository = "kingsword09/zcode-plugins") {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid GitHub repository");
  return `https://github.com/${repository}/releases/download/${metadata.tag}/${metadata.file}`;
}

export async function marketplaceEntry(data: Uint8Array, source: Record<string, unknown>) {
  const { manifest } = archiveInfo(data);
  const listing = listingSchema.parse(JSON.parse(await readFile(path.join(pluginRoot, "marketplace-entry.json"), "utf8")));
  return { name: manifest.name, source, ...listing, version: manifest.version, author: manifest.author };
}

export function promoteEntry(catalog: Marketplace, entry: Awaited<ReturnType<typeof marketplaceEntry>>): Marketplace {
  const previous = catalog.plugins.filter((plugin) => plugin.name === entry.name);
  if (previous.length > 1) throw new Error(`Duplicate marketplace entry: ${entry.name}`);
  if (previous[0]) {
    const oldVersion = manifestSchema.shape.version.parse(previous[0].version);
    const oldParts = oldVersion.split(".").map(BigInt);
    const newParts = entry.version.split(".").map(BigInt);
    const difference = newParts.map((part, index) => part - oldParts[index]!).find((part) => part !== 0n) ?? 0n;
    if (difference < 0n) throw new Error(`Refusing marketplace downgrade from ${oldVersion} to ${entry.version}`);
    if (difference === 0n && !isDeepStrictEqual(previous[0].source, entry.source)) throw new Error("An existing release version cannot be replaced; bump the version");
  }
  const plugins = previous.length ? catalog.plugins.map((plugin) => plugin.name === entry.name ? entry : plugin) : [...catalog.plugins, entry];
  return { ...catalog, plugins };
}

export async function promoteArchive(archive: string, catalogPath: string, outputPath: string, repository?: string) {
  const data = await readFile(archive);
  const { metadata } = archiveInfo(data);
  const url = releaseUrl(metadata, repository);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Published release is unavailable: HTTP ${response.status} ${url}`);
  const published = new Uint8Array(await response.arrayBuffer());
  if (sha256(published) !== metadata.sha256) throw new Error("Published release SHA-256 does not match the verified local ZIP");
  const source = { source: "url", type: "zip", url, sha256: metadata.sha256, stripRoot: false };
  const entry = await marketplaceEntry(data, source);
  const catalog = marketplaceSchema.parse(JSON.parse(await readFile(catalogPath, "utf8")));
  const updated = promoteEntry(catalog, entry);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(updated, null, 2)}\n`);
  return { ...metadata, url, outputPath };
}

export async function developmentMarketplace(directory = path.join(repositoryRoot, ".cache", "marketplace")) {
  const { archive } = await packPlugin();
  const data = await readFile(archive);
  const target = path.join(directory, "plugins", "terminal-browser");
  await mkdir(path.dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await extractArchive(data, target);
  const entry = await marketplaceEntry(data, { source: "directory", path: target });
  const catalog = { name: "zcode-plugins-dev", owner: { name: "kingsword09" }, plugins: [entry] };
  await mkdir(path.join(directory, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(directory, ".claude-plugin", "marketplace.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  return { directory, plugin: "terminal-browser@zcode-plugins-dev" };
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { repository: { type: "string" } } });
  const [command, first, second] = positionals;
  if (command === "pack") console.log(JSON.stringify(await packPlugin(first), null, 2));
  else if (command === "local") console.log(JSON.stringify(await developmentMarketplace(first ? path.resolve(first) : undefined), null, 2));
  else if (command === "promote" && first) console.log(JSON.stringify(await promoteArchive(path.resolve(first), path.join(repositoryRoot, ".claude-plugin", "marketplace.json"), second ? path.resolve(second) : path.join(repositoryRoot, ".claude-plugin", "marketplace.json"), values.repository), null, 2));
  else throw new Error("Usage: release.ts pack [output-dir] | local [marketplace-dir] | promote <zip> [catalog-output] [--repository owner/repo]");
}
