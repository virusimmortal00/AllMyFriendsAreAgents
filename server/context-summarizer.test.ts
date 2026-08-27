import { describe, expect, it, vi } from "vitest";
import { OpenCodeContextSummarizer } from "./context-summarizer.js";

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
});
