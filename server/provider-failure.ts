export type ProviderFailureCode = "insufficient_quota" | "free_tier_limit" | "account_rate_limit" | "usage_not_included";

export interface ProviderFailureDetails {
  source: "opencode";
  name: string;
  message: string;
  statusCode?: number;
  retryable?: boolean;
  code?: ProviderFailureCode;
  retryAfterMs?: number;
}

export const MAX_PROVIDER_RETRY_DELAY_MS = 2_147_483_647;

export class ProviderInvocationError extends Error {
  readonly failure!: ProviderFailureDetails;

  constructor(failure: ProviderFailureDetails) {
    super("Provider invocation failed.");
    this.name = "ProviderInvocationError";
    Object.defineProperty(this, "failure", { value: failure, enumerable: false });
  }
}

export function isProviderInvocationError(error: unknown): error is ProviderInvocationError {
  return error instanceof ProviderInvocationError;
}

/**
 * Reduce an opaque provider response to a small allowlist of non-sensitive
 * classification codes. The raw response never leaves the runner boundary.
 */
export function providerFailureCode(responseBody: unknown): ProviderFailureCode | undefined {
  if (typeof responseBody !== "string" || !responseBody) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(responseBody);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object") return undefined;
  const providerError = (body as { error?: unknown }).error;
  if (!providerError || typeof providerError !== "object") return undefined;
  const { code, type } = providerError as { code?: unknown; type?: unknown };
  if (code === "insufficient_quota" || code === "usage_not_included") return code;
  if (type === "FreeUsageLimitError") return "free_tier_limit";
  if (type === "GoUsageLimitError") return "account_rate_limit";
  return undefined;
}

/** Mirrors OpenCode's Retry-After handling while retaining no response headers. */
export function providerRetryAfterMs(responseHeaders: unknown, now = Date.now()): number | undefined {
  if (!responseHeaders || typeof responseHeaders !== "object") return undefined;
  const headers = Object.fromEntries(Object.entries(responseHeaders as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => [key.toLowerCase(), value]));
  const bounded = (milliseconds: number) => Math.min(MAX_PROVIDER_RETRY_DELAY_MS, Math.max(1_000, Math.ceil(milliseconds)));
  const retryAfterMs = Number.parseFloat(headers["retry-after-ms"] || "");
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return bounded(retryAfterMs);
  const retryAfter = headers["retry-after"];
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return bounded(seconds * 1_000);
  const absolute = Date.parse(retryAfter);
  if (!Number.isFinite(absolute) || absolute <= now) return undefined;
  return bounded(absolute - now);
}

function safeProviderMessage(value: unknown) {
  return String(value || "OpenCode reported an error.")
    .replace(/(?:sk-|key-|token-|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "[redacted]")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)=[^\s]+/gi, "[redacted]")
    .slice(0, 500);
}

/** Parse only OpenCode error events and retain only the safe classification contract. */
export function providerFailuresFromOpenCodeOutput(stdout: unknown, limit = 5): ProviderFailureDetails[] {
  if (typeof stdout !== "string") return [];
  const failures: ProviderFailureDetails[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim() || failures.length >= limit) continue;
    try {
      const event = JSON.parse(line) as {
        type?: unknown;
        error?: { name?: unknown; data?: { message?: unknown; statusCode?: unknown; isRetryable?: unknown; responseBody?: unknown; responseHeaders?: unknown } };
      };
      if (event.type !== "error" || !event.error) continue;
      const code = providerFailureCode(event.error.data?.responseBody);
      const retryAfterMs = providerRetryAfterMs(event.error.data?.responseHeaders);
      failures.push({
        source: "opencode",
        name: typeof event.error.name === "string" ? event.error.name.slice(0, 100) : "OpenCodeError",
        message: safeProviderMessage(event.error.data?.message),
        ...(Number.isSafeInteger(event.error.data?.statusCode) ? { statusCode: Number(event.error.data?.statusCode) } : {}),
        ...(typeof event.error.data?.isRetryable === "boolean" ? { retryable: event.error.data.isRetryable } : {}),
        ...(code ? { code } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    } catch {
      // Non-protocol output is deliberately ignored.
    }
  }
  return failures;
}
