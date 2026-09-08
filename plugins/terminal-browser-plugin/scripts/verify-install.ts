import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { archiveInfo, marketplaceEntry } from "./release.ts";

async function runCli(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, expectedCode = 0) {
  const child = spawn("node", [cli, "plugins", ...args, "--json"], { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, expectedCode, `zcode plugins ${args.join(" ")}\n${stdout}\n${stderr}`);
  return { stdout, stderr };
}

export async function installArchive(data: Uint8Array, cli: string, root: string) {
  const { metadata, files } = archiveInfo(data);
  const configuration = path.join(root, ".zcode", "cli");
  await mkdir(configuration, { recursive: true });
  await writeFile(path.join(configuration, "config.json"), JSON.stringify({ storage: { dir: path.join(root, ".zcode") }, plugins: { enabled: true } }));
  const preload = path.join(root, "isolate-config.cjs");
  // The CLI has no user-config override. Isolate home resolution in test children.
  await writeFile(preload, `require('node:os').homedir=()=>process.env.TB_INSTALL_TEST_ROOT;require('node:module').syncBuiltinESMExports();\n`);
  const env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LANG: "en_US.UTF-8",
    NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
    TB_INSTALL_TEST_ROOT: root,
    ZCODE_STORAGE_DIR: path.join(root, ".zcode"),
  };
  const market = path.join(root, "marketplace");
  await mkdir(path.join(market, ".claude-plugin"), { recursive: true });
  const server = createServer((request, response) => {
    if (request.url !== `/${metadata.file}`) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/zip", "content-length": data.byteLength });
    response.end(data);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/${metadata.file}`;
  async function catalog(checksum: string) {
    const entry = await marketplaceEntry(data, { source: "url", type: "zip", url, sha256: checksum, stripRoot: false });
    await writeFile(path.join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "zcode-zip-test", owner: { name: "test" }, plugins: [entry] }));
  }
  const id = "terminal-browser@zcode-zip-test";
  try {
    await catalog("0".repeat(64));
    await runCli(cli, ["marketplace", "add", market, "--yes"], root, env);
    const rejected = await runCli(cli, ["install", id, "--yes"], root, env, 1);
    assert.match(rejected.stdout + rejected.stderr, /sha.?256|checksum/i);
    const before = JSON.parse((await runCli(cli, ["overview"], root, env)).stdout);
    assert.equal(before.installedPlugins.some((plugin: { id: string }) => plugin.id === id), false);
    await catalog(metadata.sha256);
    await runCli(cli, ["marketplace", "update", "zcode-zip-test"], root, env);
    await runCli(cli, ["install", id, "--yes"], root, env);
    const validation = JSON.parse((await runCli(cli, ["validate", id], root, env)).stdout);
    assert.equal(validation.ok, true);
    const overview = JSON.parse((await runCli(cli, ["overview"], root, env)).stdout);
    const installed = overview.installedPlugins.find((plugin: { id: string }) => plugin.id === id);
    assert.ok(installed, "Plugin must appear in installed state");
    assert.equal(installed.version, metadata.version);
    assert.equal(installed.enabled, true);
    assert.ok(typeof installed.installPath === "string" && installed.installPath.startsWith(`${root}${path.sep}`), "Cache must stay inside the isolated root");
    for (const [name, content] of Object.entries(files)) assert.deepEqual(await readFile(path.join(installed.installPath, name)), Buffer.from(content), `Installed file differs: ${name}`);
    console.log(`ZCode ZIP install passed: bad checksum rejected; ${metadata.fileCount} installed files verified; plugin enabled and valid.`);
    return installed.installPath as string;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
