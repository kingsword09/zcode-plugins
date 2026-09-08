import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { archiveInfo, marketplaceEntry, packPlugin, pluginRoot, promoteArchive, promoteEntry, releaseUrl } from "../scripts/release.ts";

let root: string;
let archive: Awaited<ReturnType<typeof packPlugin>>;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "tb-packaging-"));
  archive = await packPlugin(path.join(root, "first"));
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test("release bytes are reproducible and contain only the runnable plugin", async () => {
  const second = await packPlugin(path.join(root, "second"));
  expect(second.sha256).toBe(archive.sha256);
  const { files, metadata } = archiveInfo(await readFile(archive.archive));
  expect(Object.keys(files).some((file) => /^(src|test|scripts|node_modules)\//.test(file))).toBe(false);
  expect(Object.keys(files).some((file) => /\/types\/|\/lib\/vite\//.test(file))).toBe(false);
  expect(metadata.unpackedBytes).toBeLessThan(8 * 1024 * 1024);
  expect(await readFile(`${archive.archive}.sha256`, "utf8")).toBe(`${archive.sha256}  ${archive.file}\n`);
  expect(releaseUrl(metadata)).toBe(`https://github.com/kingsword09/zcode-plugins/releases/download/terminal-browser-v${metadata.version}/${metadata.file}`);
});

test("unsafe paths and incomplete runtime archives are rejected", async () => {
  const { files } = archiveInfo(await readFile(archive.archive));
  expect(() => archiveInfo(zipSync({ "../escape": new Uint8Array([1]) }))).toThrow("Unsafe ZIP path");
  delete files["dist/mcp/recording-worker.js"];
  expect(() => archiveInfo(zipSync(files))).toThrow("missing dist/mcp/recording-worker.js");
});

test("large ZIP entries use STORE for the Node 26 ZCode installer", async () => {
  let largeEntries = 0;
  unzipSync(await readFile(archive.archive), { filter: (entry) => {
    if (entry.originalSize > 65_536) { expect(entry.compression).toBe(0); largeEntries++; }
    return false;
  } });
  expect(largeEntries).toBeGreaterThan(0);
});

test("packaging rejects mismatched versions and source symlinks", async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, ".zcode-plugin/plugin.json"), "utf8"));
  const fixture = path.join(root, "fixture");
  await mkdir(path.join(fixture, ".zcode-plugin"), { recursive: true });
  await writeFile(path.join(fixture, ".zcode-plugin/plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ version: "0.0.0" }));
  await expect(packPlugin(path.join(root, "invalid"), fixture)).rejects.toThrow("versions must match");
  await writeFile(path.join(fixture, "package.json"), JSON.stringify({ version: manifest.version }));
  await writeFile(path.join(fixture, "README.md"), "fixture");
  await writeFile(path.join(fixture, "LICENSE"), "fixture");
  await symlink(path.join(pluginRoot, "dist"), path.join(fixture, "dist"), "dir");
  await expect(packPlugin(path.join(root, "invalid"), fixture)).rejects.toThrow("symlinks");
});

test("marketplace promotion preserves other plugins and prevents replacement or downgrade", async () => {
  const data = await readFile(archive.archive);
  const entry = await marketplaceEntry(data, { source: "url", type: "zip", url: releaseUrl(archive), sha256: archive.sha256, stripRoot: false });
  const legacy = { name: "zcode-model-config", source: "./plugins/zcode-model-config-plugin", version: "0.1.0" };
  const catalog = { name: "zcode-plugins", owner: { name: "kingsword09" }, plugins: [legacy] };
  const promoted = promoteEntry(catalog, entry);
  expect(promoted.plugins[0]).toEqual(legacy);
  expect(promoted.plugins[1]).toEqual(entry);
  expect(promoteEntry(promoted, entry)).toEqual(promoted);
  expect(() => promoteEntry(promoted, { ...entry, source: { ...entry.source, sha256: "0".repeat(64) } })).toThrow("cannot be replaced");
  expect(() => promoteEntry(promoted, { ...entry, version: "0.0.0" })).toThrow("downgrade");
});

test("promotion changes the catalog only after verifying the published bytes", async () => {
  const catalog = path.join(root, "marketplace.json");
  const original = JSON.stringify({ name: "zcode-plugins", plugins: [] });
  await writeFile(catalog, original);
  const download = spyOn(globalThis, "fetch");
  try {
    download.mockResolvedValueOnce(new Response("not published", { status: 404 }));
    await expect(promoteArchive(archive.archive, catalog, catalog)).rejects.toThrow("unavailable");
    expect(await readFile(catalog, "utf8")).toBe(original);
    download.mockResolvedValueOnce(new Response("wrong archive"));
    await expect(promoteArchive(archive.archive, catalog, catalog)).rejects.toThrow("SHA-256");
    expect(await readFile(catalog, "utf8")).toBe(original);
    download.mockResolvedValueOnce(new Response(await readFile(archive.archive)));
    await promoteArchive(archive.archive, catalog, catalog);
    const updated = JSON.parse(await readFile(catalog, "utf8"));
    expect(updated.plugins[0].source).toEqual({ source: "url", type: "zip", url: releaseUrl(archive), sha256: archive.sha256, stripRoot: false });
  } finally { download.mockRestore(); }
});
