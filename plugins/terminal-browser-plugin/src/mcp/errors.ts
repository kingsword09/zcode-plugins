export class BrowserError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly recovery?: string,
  ) {
    super(message);
    this.name = "BrowserError";
  }
}

export function errorDetails(error: unknown) {
  if (error instanceof BrowserError) {
    return { code: error.code, message: error.message, recovery: error.recovery };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = /timeout|timed out/i.test(message) ? "timeout"
    : /strict mode violation/i.test(message) ? "ambiguous_target"
    : /closed|disconnected/i.test(message) ? "target_closed"
    : "operation_failed";
  return { code, message, recovery: "Inspect browser_list and take a fresh browser_snapshot before acting again." };
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BrowserError("timeout", `${operation} timed out after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
