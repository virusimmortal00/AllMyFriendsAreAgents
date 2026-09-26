import { describe, expect, it } from "vitest";
import { generationFailureDiagnostic } from "./generation-failure-diagnostic.js";
import { providerFailuresFromOpenCodeOutput } from "./provider-failure.js";

function fakeCliError(statusCode: number, code?: string) {
  const stdout = JSON.stringify({ type: "error", error: { name: "APIError", data: {
    statusCode, isRetryable: statusCode >= 500 || statusCode === 429,
    message: "private prompt and credential should never appear",
    responseBody: JSON.stringify({ error: { code } }),
  } } });
  return providerFailuresFromOpenCodeOutput(stdout)[0]!;
}

describe("closed generation failure diagnostics", () => {
  it.each([
    [401, undefined, "authentication", "authentication"],
    [402, "insufficient_quota", "quota", "usage_exhausted"],
    [402, undefined, "provider-other", "unknown"],
    [429, undefined, "rate-limit", "rate_limit"],
    [503, undefined, "server", "transient_provider"],
    [404, undefined, "provider-other", "unknown"],
  ] as const)("classifies fake OpenCode %i without copying its output", (statusCode, code, category, healthReason) => {
    const diagnostic = generationFailureDiagnostic({ provider: fakeCliError(statusCode, code), process: { exitCode: 1, timedOut: false }, durationMs: 17 });
    expect(diagnostic).toMatchObject({ origin: "provider", category, statusCode, healthReason, exitCode: 1, durationMs: 17 });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|prompt|credential|message|responseBody/);
  });

  it("distinguishes a process watchdog from an ordinary failed exit", () => {
    expect(generationFailureDiagnostic({ process: { exitCode: null, timedOut: true }, durationMs: 90_000 })).toMatchObject({ origin: "process", category: "timeout", healthReason: "timeout" });
    expect(generationFailureDiagnostic({ process: { exitCode: 7, timedOut: false }, durationMs: 4 })).toMatchObject({ origin: "process", category: "process-exit", healthReason: "unknown" });
  });

  it("distinguishes malformed structured output, local launch denial, and unknown failure", () => {
    expect(generationFailureDiagnostic({ structuredInvalid: true, durationMs: 12 }).category).toBe("schema");
    expect(generationFailureDiagnostic({ launchFailed: true, durationMs: 1 }).category).toBe("local-launch");
    expect(generationFailureDiagnostic({ durationMs: Number.NaN })).toEqual({ origin: "unknown", category: "unknown", statusCode: null, providerCode: null, retryable: null, exitCode: null, durationMs: null, healthReason: "unknown" });
  });
});
