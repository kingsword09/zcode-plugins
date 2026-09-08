import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { archiveInfo, extractArchive, pluginRoot, releaseDirectory } from "./release.ts";
import { installArchive } from "./verify-install.ts";

const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { cli: { type: "string" } } });
const archive = positionals[0] ? path.resolve(positionals[0]) : path.join(releaseDirectory, JSON.parse(await readFile(path.join(releaseDirectory, "release.json"), "utf8")).file);
const data = await readFile(archive);
const { metadata } = archiveInfo(data);
assert.equal((await readFile(`${archive}.sha256`, "utf8")).trim(), `${metadata.sha256}  ${metadata.file}`);
const root = await mkdtemp(path.join(os.tmpdir(), "tb-release-"));
try {
  let installed: string;
  if (values.cli) installed = await installArchive(data, path.resolve(values.cli), root);
  else {
    installed = path.join(root, "plugin");
    await extractArchive(data, installed);
  }
  const child = spawn(process.execPath, ["test", "test/integration.test.ts"], { cwd: pluginRoot, env: { ...process.env, TB_TEST_DIST: path.join(installed, "dist") }, stdio: "inherit", timeout: 180_000 });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, "Browser integration suite failed against the release ZIP");
  console.log(`Verified ${metadata.file}: ${metadata.fileCount} files, SHA-256 ${metadata.sha256}`);
} finally {
  if (process.env.TB_KEEP_RELEASE_TEST === "1") console.log(`Verification workspace: ${root}`);
  else await rm(root, { recursive: true, force: true });
}
