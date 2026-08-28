import { describe, expect, it, vi } from "vitest";
import { OpenCodeContextSummarizer } from "./context-summarizer.js";
import { ProviderHealthRegistry } from "./provider-health.js";

function protocolError(data: Record<string, unknown>) {
  return Object.assign(new Error("OpenCode failed"), {
    stdout: `${JSON.stringify({ type: "error", error: { name: "APIError", data } })}\n`,
  });
}

describe("OpenCode context summarizer", () => {
  it("falls through the configured model order without blocking on the unavailable primary", async () => {
    const execute = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("opencode/muse-spark-1.2-contributor-free")) throw new Error("primary unavailable");
      return { stdout: `${JSON.stringify({ type: "text", part: { type: "text", text: "Fallback summary" } })}\n`, stderr: "" };
    });
    const summarizer = new OpenCodeContextSummarizer("opencode", 1_000, execute);
    await expect(summarizer.summarize({
      transcript: "[YOU | one]\nExact text",
      tokenTarget: 200,
      promptTemplate: "Limit {{tokenTarget}}\n{{transcript}}",
      projectPath: "/tmp/project",
      models: [
        { providerId: "opencode", modelId: "muse-spark-1.2-contributor-free" },
        { providerId: "openrouter", modelId: "~deepseek/deepseek-v4-flash-latest" },
      ],
    })).resolves.toBe("Fallback summary");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][1]).toContain("openrouter/~deepseek/deepseek-v4-flash-latest");
  });

  it("coalesces simultaneous summaries for the same cold-start span", async () => {
    const execute = vi.fn(async () => ({ stdout: `${JSON.stringify({ type: "text", part: { type: "text", text: "Shared summary" } })}\n`, stderr: "" }));
    const summarizer = new OpenCodeContextSummarizer("opencode", 1_000, execute);
    const input = { transcript: "[YOU | one]\nExact text", tokenTarget: 200, promptTemplate: "{{transcript}}", projectPath: "/tmp/project", models: [{ providerId: "opencode", modelId: "muse-spark-1.2-contributor-free" }] } as const;
    await expect(Promise.all([summarizer.summarize(input), summarizer.summarize(input), summarizer.summarize(input)])).resolves.toEqual(["Shared summary", "Shared summary", "Shared summary"]);
    await expect(summarizer.summarize(input)).resolves.toBe("Shared summary");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("fans out account-scoped cooldowns while retaining an unrelated fallback", async () => {
    const providers = ProviderHealthRegistry.memory();
    const changed = vi.fn();
    const execute = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("opencode/muse-spark-1.2-contributor-free")) {
        throw protocolError({
          message: "Subscription quota exceeded",
          statusCode: 429,
          isRetryable: true,
          responseHeaders: { "retry-after": "120", authorization: "private" },
          responseBody: JSON.stringify({ type: "error", error: { type: "GoUsageLimitError" }, metadata: { workspace: "private" } }),
        });
      }
      return { stdout: `${JSON.stringify({ type: "text", part: { type: "text", text: "Fallback summary" } })}\n`, stderr: "" };
    });
    const summarizer = new OpenCodeContextSummarizer("opencode", 1_000, execute, { providers, onChange: changed });
    const models = [
      { providerId: "opencode", modelId: "muse-spark-1.2-contributor-free" },
      { providerId: "openrouter", modelId: "~deepseek/deepseek-v4-flash-latest" },
    ] as const;

    await expect(summarizer.summarize({ transcript: "first", tokenTarget: 200, promptTemplate: "{{transcript}}", projectPath: "/tmp/project", models })).resolves.toBe("Fallback summary");
    expect(providers.snapshot().opencode).toMatchObject({ status: "cooldown", reason: "account_rate_limit", retrySource: "provider" });
    expect(providers.snapshot().openrouter).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(1);

    await expect(summarizer.summarize({ transcript: "second", tokenTarget: 200, promptTemplate: "{{transcript}}", projectPath: "/tmp/project", models })).resolves.toBe("Fallback summary");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("keeps an unscoped 429 route-local and suppresses only that summarizer route", async () => {
    const providers = ProviderHealthRegistry.memory();
    const execute = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("cursor/summary-model")) throw protocolError({ message: "HTTP 429", statusCode: 429, isRetryable: true, responseHeaders: { "retry-after": "120" } });
      return { stdout: `${JSON.stringify({ type: "text", part: { type: "text", text: "Unrelated fallback" } })}\n`, stderr: "" };
    });
    const summarizer = new OpenCodeContextSummarizer("opencode", 1_000, execute, { providers });
    const models = [{ providerId: "cursor", modelId: "summary-model" }, { providerId: "openrouter", modelId: "fallback" }] as const;

    await summarizer.summarize({ transcript: "first", tokenTarget: 200, promptTemplate: "{{transcript}}", projectPath: "/tmp/project", models });
    await summarizer.summarize({ transcript: "second", tokenTarget: 200, promptTemplate: "{{transcript}}", projectPath: "/tmp/project", models });
    expect(providers.snapshot()).toEqual({});
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("clears action-required provider state after one explicit successful summarizer probe", async () => {
    const providers = ProviderHealthRegistry.memory();
    await providers.recordActionRequired("cursor", "usage_exhausted");
    await providers.requestRecovery("cursor");
    const changed = vi.fn();
    const execute = vi.fn(async () => ({ stdout: `${JSON.stringify({ type: "text", part: { type: "text", text: "Recovered summary" } })}\n`, stderr: "" }));
    const summarizer = new OpenCodeContextSummarizer("opencode", 1_000, execute, { providers, onChange: changed });

    await expect(summarizer.summarize({ transcript: "probe", tokenTarget: 200, promptTemplate: "{{transcript}}", projectPath: "/tmp/project", models: [{ providerId: "cursor", modelId: "summary-model" }] })).resolves.toBe("Recovered summary");
    expect(providers.snapshot()).toEqual({});
    expect(changed).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
