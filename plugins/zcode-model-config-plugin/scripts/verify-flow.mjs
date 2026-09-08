import net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// isolated HOME so the real user config is never touched
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tb-mc-home-"));
process.env.HOME = fakeHome;
delete process.env.ZCODE_CONFIG_DIR;
delete process.env.ZCODE_HOME;

const { startUiServer, closeUiServer } = await import("../src/ui/server.ts");
const handle = await startUiServer({ port: 47931, projectRoot: fakeHome, openBrowser: false });

function raw(pathname, { method = "GET", host = "127.0.0.1:47931", origin, token, body } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(47931, "127.0.0.1");
    let buffer = "";
    socket.setEncoding("utf8");
    const finish = () => {
      socket.destroy();
      const status = Number((buffer.split("\r\n")[0] ?? "").split(" ")[1] ?? 0);
      const bodyPart = buffer.split("\r\n\r\n")[1] ?? "";
      resolve({ status, body: bodyPart });
    };
    socket.on("data", (chunk) => { buffer += chunk; if (buffer.includes("\r\n\r\n")) finish(); });
    socket.on("error", reject);
    setTimeout(finish, 3000);
    const headers = [`Host: ${host}`, "Connection: close"];
    if (origin) headers.push(`Origin: ${origin}`);
    if (token) headers.push(`x-config-token: ${token}`);
    const payload = body ? JSON.stringify(body) : "";
    headers.push(`Content-Length: ${Buffer.byteLength(payload)}`);
    socket.write(`${method} ${pathname} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n${payload}`);
  });
}

const results = [];
const check = (name, ok, detail = "") => { results.push([name, ok]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

// 1. guards
check("state without token → 403", (await raw("/api/state")).status === 403);
check("shutdown without token → 403", (await raw("/api/shutdown", { method: "POST" })).status === 403);
check("foreign Host → 403", (await raw("/api/state", { host: "evil.example", token: handle.token })).status === 403);

// 2. legit state
const state = await raw("/api/state", { token: handle.token });
check("state with token → 200", state.status === 200);

// 3. save valid config (user scope)
const goodConfig = {
  provider: { openrouter: { kind: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKey: "sk-test", models: { "gpt-x": { name: "GPT X", limitContext: 128000 } } } },
  model: { main: "openrouter/gpt-x" },
};
const save = await raw("/api/save", { method: "POST", token: handle.token, body: { scope: "user", config: goodConfig } });
check("save valid → 200 + path", save.status === 200, save.body.slice(0, 80));

// 4. schema rejection: bad modelRef
const badRef = await raw("/api/save", { method: "POST", token: handle.token, body: { scope: "user", config: { model: { main: "p/m/extra" }, provider: {} } } });
check("modelRef 'p/m/extra' → 422", badRef.status === 422);

// 5. second save → .bak of previous content exists and is 0600
const userCfgPath = path.join(fakeHome, ".zcode", "cli", "config.json");
const secondSave = await raw("/api/save", { method: "POST", token: handle.token, body: { scope: "user", config: { ...goodConfig, model: { main: "openrouter/gpt-x", lite: "openrouter/gpt-x" } } } });
check("second save → 200", secondSave.status === 200);
const bakMode = (fs.statSync(userCfgPath + ".bak").mode & 0o777).toString(8);
check("backup exists at 0600", bakMode === "600", bakMode);
const cfgMode = (fs.statSync(userCfgPath).mode & 0o777).toString(8);
check("config at 0600", cfgMode === "600", cfgMode);

// 6. saved content round-trips
const after = JSON.parse(fs.readFileSync(userCfgPath, "utf8"));
check("saved provider round-trips", after.provider?.openrouter?.apiKey === "sk-test");
check("saved model.main round-trips", after.model?.main === "openrouter/gpt-x");

// 7. shutdown with token works
const shutdown = await raw("/api/shutdown", { method: "POST", token: handle.token });
check("shutdown with token → 200", shutdown.status === 200);
await new Promise((r) => setTimeout(r, 300));

const pass = results.filter((r) => r[1]).length;
console.log(`\n===== model-config flow: ${pass}/${results.length} =====`);
fs.rmSync(fakeHome, { recursive: true, force: true });
process.exit(pass === results.length ? 0 : 1);
