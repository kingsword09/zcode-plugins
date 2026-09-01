export const CONFIG_TOKEN = "__CONFIG_TOKEN__";

export interface ApiError {
  ok: false;
  error: string;
  issues?: string[];
}

export function apiBase(): string {
  return window.location.origin;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-config-token": CONFIG_TOKEN,
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))) as unknown;
  if (!response.ok) {
    const err = body as ApiError;
    throw new Error(err.error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

export interface FileStateDto {
  scope: "user" | "project";
  path: string;
  exists: boolean;
  kind: "user" | "zcode.json" | ".zcode/config.json";
  config: import("@shared/types").ModelConfigFile | null;
  parseError: string | null;
}

export interface StateDto {
  ok: true;
  state: {
    user: FileStateDto;
    project: FileStateDto;
    projectRoot: string;
    alternateProjectPath: string;
    userModelPath: string;
    locale: "zh-CN" | "en";
  };
}

export function fetchState(): Promise<StateDto> {
  return request<StateDto>("/api/state");
}

export interface SaveResultDto {
  ok: true;
  path: string;
  backupPath: string | null;
}

export interface GatewayModelDto {
  id: string;
  name?: string;
  owner?: string;
  modelKey: string;
  contextWindow?: number;
  maxOutput?: number;
  image: boolean;
  reasoning: boolean;
  tools: boolean;
}

export function fetchGatewayModels(): Promise<{ ok: true; models: GatewayModelDto[] }> {
  return request("/api/gateway-models");
}

export function saveConfig(
  scope: "user" | "project",
  config: import("@shared/types").ModelConfigFile,
): Promise<SaveResultDto> {
  return request<SaveResultDto>("/api/save", {
    method: "POST",
    body: JSON.stringify({ scope, config }),
  });
}

export async function shutdownServer(): Promise<void> {
  await request("/api/shutdown", { method: "POST" }).catch(() => undefined);
}
