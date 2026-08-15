import { describe, expect, test } from "bun:test";
import {
  encryptValue,
  loadCredentials,
  resolveCredentialsPath,
  CredentialStoreError,
} from "../src/credentials.ts";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV = { HOME: "/tmp/fake-home", ZCODE_CREDENTIAL_SECRET: "test-secret" };

function encryptWithSecret(secret: string, plaintext: string): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const { createCipheriv } = require("node:crypto") as typeof import("node:crypto");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["enc:v1:", iv.toString("base64url"), ".", tag.toString("base64url"), ".", data.toString("base64url")].join("");
}

test("resolveCredentialsPath honors ZCODE_DATA_BASE_DIR", () => {
  const path = resolveCredentialsPath({ ...ENV, ZCODE_DATA_BASE_DIR: "/data/dir" });
  expect(path).toBe(join("/data/dir", ".zcode", "v2", "credentials.json"));
});

test("encryptValue/decrypt roundtrip via loadCredentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-cred-"));
  const credentialsPath = join(dir, "credentials.json");
  const record = {
    "oauth:active_provider": encryptValue("zai", ENV),
    "oauth:zai:access_token": encryptValue("access-token", ENV),
    zcodejwttoken: encryptValue("jwt-token", ENV),
  };
  await writeFile(credentialsPath, JSON.stringify(record, null, 2));
  const credentials = await loadCredentials({ env: ENV, filePath: credentialsPath });
  expect(credentials.activeProvider).toBe("zai");
  expect(credentials.zaiAccessToken).toBe("access-token");
  expect(credentials.zcodeJwtToken).toBe("jwt-token");
});

test("decrypts values produced by the runtime cipher", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-cred-"));
  const credentialsPath = join(dir, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ zcodejwttoken: encryptWithSecret("test-secret", "jwt-from-runtime") }));
  const credentials = await loadCredentials({ env: ENV, filePath: credentialsPath });
  expect(credentials.zcodeJwtToken).toBe("jwt-from-runtime");
});

test("missing file raises CredentialStoreError with guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-cred-"));
  await expect(loadCredentials({ env: ENV, filePath: join(dir, "none.json") })).rejects.toBeInstanceOf(
    CredentialStoreError,
  );
});
