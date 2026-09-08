import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import { closeUiServer, startUiServer, type UiServerHandle } from "../src/ui/server.ts";

const PORT = 47913;

/**
 * Raw-socket HTTP client: bun's fetch honors proxy env vars, which would
 * route loopback traffic through a local proxy and mangle Host semantics.
 * The guard is about exact Host/Origin/token bytes, so we speak HTTP directly.
 */
function raw(
  path: string,
  options: {
    method?: string;
    host?: string;
    origin?: string;
    token?: string;
  } = {},
): Promise<{ statusLine: string; status: number; body: string }> {
  const { method = "GET", host = `127.0.0.1:${PORT}`, origin, token } = options;
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, "127.0.0.1");
    let buffer = "";
    socket.setEncoding("utf8");
    const finish = () => {
      socket.destroy();
      const statusLine = buffer.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? 0);
      const body = buffer.split("\r\n\r\n")[1] ?? "";
      resolve({ statusLine, status, body });
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.includes("\r\n\r\n")) finish();
    });
    socket.on("error", reject);
    setTimeout(finish, 3_000);
    const headers = [`Host: ${host}`, "Connection: close"];
    if (origin) headers.push(`Origin: ${origin}`);
    if (token) headers.push(`x-config-token: ${token}`);
    headers.push("Content-Length: 0");
    socket.write(`${method} ${path} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
  });
}

describe("UI server request guard (Host / Origin / token)", () => {
  let handle: UiServerHandle;

  beforeAll(async () => {
    await closeUiServer();
    handle = await startUiServer({
      port: PORT,
      projectRoot: import.meta.dir,
      openBrowser: false,
    });
  });
  afterAll(async () => {
    await closeUiServer();
  });

  test("legitimate request passes (token + loopback Host)", async () => {
    const r = await raw("/api/state", { token: handle.token });
    expect(r.status).toBe(200);
  });

  test("DNS rebinding: foreign Host rejected on / and /api/*", async () => {
    expect((await raw("/", { host: "attacker.example" })).status).toBe(403);
    expect(
      (await raw("/api/state", { host: "attacker.example", token: handle.token })).status,
    ).toBe(403);
  });

  test("API without token is rejected — /api/state and /api/shutdown were open", async () => {
    expect((await raw("/api/state")).status).toBe(403);
    expect((await raw("/api/shutdown", { method: "POST" })).status).toBe(403);
    // the server must still be alive after the rejected shutdown
    expect((await raw("/api/state", { token: handle.token })).status).toBe(200);
  });

  test("cross-site form post: foreign Origin rejected even with the token", async () => {
    const r = await raw("/api/shutdown", {
      method: "POST",
      origin: "http://attacker.example",
      token: handle.token,
    });
    expect(r.status).toBe(403);
    expect((await raw("/api/state", { token: handle.token })).status).toBe(200);
  });

  test("loopback Origin with token passes", async () => {
    const r = await raw("/api/state", {
      origin: `http://127.0.0.1:${PORT}`,
      token: handle.token,
    });
    expect(r.status).toBe(200);
  });

  test("wrong token value is rejected", async () => {
    const r = await raw("/api/state", { token: "0".repeat(48) });
    expect(r.status).toBe(403);
  });

  test("non-GET on / is method-rejected", async () => {
    const r = await raw("/", { method: "POST", token: handle.token });
    expect(r.status).toBe(405);
  });
});
