import type { ProviderFailureDetails } from "./provider-failure.js";

export type GenerationFailureOrigin = "provider" | "process" | "structured-output" | "local-launch" | "unknown";
export type GenerationFailureCategory = "authentication" | "rate-limit" | "quota" | "model" | "timeout" | "server" | "transport" | "schema" | "process-exit" | "local-launch" | "provider-other" | "unknown";
export type GenerationFailureHealthReason = "authentication" | "rate_limit" | "timeout" | "transient_provider" | "configuration" | "provider_error" | "usage_exhausted" | "usage_not_included" | "account_rate_limit" | "unknown";
export interface GenerationFailureDiagnostic {
  origin: GenerationFailureOrigin;
  category: GenerationFailureCategory;
  statusCode: number | null;
  providerCode: ProviderFailureDetails["code"] | null;
  retryable: boolean | null;
  exitCode: number | null;
  durationMs: number | null;
  healthReason: GenerationFailureHealthReason;
}

/** Only typed facts cross the private runner-to-scalar boundary; never error text or output. */
export function generationFailureDiagnostic(input: {
  provider?: ProviderFailureDetails;
  process?: { exitCode: number | null; timedOut: boolean };
  structuredInvalid?: boolean;
  structuredTimedOut?: boolean;
  launchFailed?: boolean;
  durationMs: number;
}): GenerationFailureDiagnostic {
  const provider = input.provider;
  const statusCode = provider?.statusCode;
  const code = provider?.code;
  let origin: GenerationFailureOrigin = "unknown";
  let category: GenerationFailureCategory = "unknown";
  let healthReason: GenerationFailureHealthReason = "unknown";
  if (provider) {
    origin = "provider";
    if (code === "insufficient_quota" || code === "free_tier_limit") {
      category = "quota";
      healthReason = "usage_exhausted";
    } else if (code === "usage_not_included") {
      category = "quota";
      healthReason = "usage_not_included";
    } else if (code === "account_rate_limit" || statusCode === 429) {
      category = "rate-limit";
      healthReason = code === "account_rate_limit" ? "account_rate_limit" : "rate_limit";
    } else if (statusCode === 401) {
      category = "authentication";
      healthReason = "authentication";
    } else if (statusCode === 408) {
      category = "timeout";
      healthReason = "timeout";
    } else if (statusCode !== undefined && statusCode >= 500) {
      category = "server";
      healthReason = "transient_provider";
    } else {
      category = "provider-other";
      healthReason = "unknown";
    }
  } else if (input.process) {
    origin = "process";
    category = input.process.timedOut ? "timeout" : "process-exit";
    healthReason = input.process.timedOut ? "timeout" : "unknown";
  } else if (input.structuredTimedOut) {
    origin = "structured-output";
    category = "timeout";
    healthReason = "timeout";
  } else if (input.structuredInvalid) {
    origin = "structured-output";
    category = "schema";
  } else if (input.launchFailed) {
    origin = "local-launch";
    category = "local-launch";
    healthReason = "configuration";
  }
  return {
    origin, category,
    statusCode: statusCode !== undefined && Number.isSafeInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : null,
    providerCode: code ?? null,
    retryable: typeof provider?.retryable === "boolean" ? provider.retryable : null,
    exitCode: input.process?.exitCode !== null && input.process?.exitCode !== undefined && Number.isSafeInteger(input.process.exitCode) ? input.process.exitCode : null,
    durationMs: Number.isSafeInteger(input.durationMs) && input.durationMs >= 0 ? input.durationMs : null,
    healthReason,
  };
}
