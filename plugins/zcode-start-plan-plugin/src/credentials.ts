import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  CIPHER_ALGO,
  CIPHER_PREFIX,
  CREDENTIAL_SECRET_ENV,
  CREDENTIALS_PATH_KEYS,
} from "./constants.ts";

export class CredentialStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialStoreError";
  }
}

export function resolveCredentialsPath(env: Record<string, string | undefined> = process.env): string {
  const baseDir = env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return join(resolvePath(baseDir), ".zcode", "v2", "credentials.json");
}

function resolvePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return resolve(input);
}

function credentialFallbackSeed(env: Record<string, string | undefined>): string {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // keep "unknown"
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function deriveCipherKey(env: Record<string, string | undefined>): Buffer {
  const secret = env[CREDENTIAL_SECRET_ENV]?.trim() || credentialFallbackSeed(env);
  return createHash("sha256").update(secret).digest();
}

function decryptValue(encrypted: string, key: Buffer): string {
  if (!encrypted.startsWith(CIPHER_PREFIX)) return encrypted;
  const parts = encrypted.slice(CIPHER_PREFIX.length).split(".");
  if (parts.length !== 3) {
    throw new CredentialStoreError("Credential decrypt failed: invalid ciphertext format");
  }
  const [ivPart, tagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const data = Buffer.from(dataPart, "base64url");
  if (iv.length !== 12) throw new CredentialStoreError("Credential decrypt failed: invalid IV length");
  if (tag.length !== 16) throw new CredentialStoreError("Credential decrypt failed: invalid auth tag length");
  try {
    const decipher = createDecipheriv(CIPHER_ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
  } catch (error) {
    throw new CredentialStoreError("Credential decrypt failed: key mismatch or corrupted ciphertext", {
      cause: error,
    });
  }
}

export function encryptValue(plaintext: string, env: Record<string, string | undefined> = process.env): string {
  const key = deriveCipherKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER_ALGO, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CIPHER_PREFIX, iv.toString("base64url"), ".", tag.toString("base64url"), ".", data.toString("base64url")].join("");
}

export interface ZcodeCredentials {
  activeProvider: string | null;
  zaiAccessToken: string | null;
  zcodeJwtToken: string | null;
  zaiUserInfo: string | null;
}

export async function loadCredentials(
  options: { env?: Record<string, string | undefined>; filePath?: string } = {},
): Promise<ZcodeCredentials> {
  const env = options.env ?? process.env;
  const filePath = options.filePath ?? resolveCredentialsPath(env);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new CredentialStoreError(
      `Unable to read ZCode credentials at ${filePath}. Run \`zcode login\` first.`,
      { cause: error },
    );
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new CredentialStoreError("ZCode credentials file is not valid JSON", { cause: error });
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new CredentialStoreError("ZCode credentials file has an unexpected shape");
  }
  const key = deriveCipherKey(env);
  const read = (field: string): string | null => {
    const value = record[field];
    if (typeof value !== "string" || value.length === 0) return null;
    return decryptValue(value, key);
  };
  return {
    activeProvider: read(CREDENTIALS_PATH_KEYS.activeProvider),
    zaiAccessToken: read(CREDENTIALS_PATH_KEYS.zaiAccessToken),
    zcodeJwtToken: read(CREDENTIALS_PATH_KEYS.zcodeJwtToken),
    zaiUserInfo: read(CREDENTIALS_PATH_KEYS.zaiUserInfo),
  };
}

export async function loadStartPlanBearerToken(
  options: { env?: Record<string, string | undefined>; filePath?: string } = {},
): Promise<string> {
  const credentials = await loadCredentials(options);
  const token = credentials.zcodeJwtToken?.trim();
  if (!token) {
    throw new CredentialStoreError(
      "No ZCode JWT token found in credentials. Run `zcode login` (OAuth) first; the Start Plan endpoint authenticates with the shared ZCode JWT.",
    );
  }
  return token;
}
