import { describe, expect, it } from "vitest";
import { OpenRouterSpendTracker } from "./openrouter-spend.js";

describe("OpenRouterSpendTracker", () => {
  it("accumulates cost and both usage shapes per agent and room", () => {
    const tracker = new OpenRouterSpendTracker();
    tracker.record("codex-sol", { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, totalTokens: 128 }, 0.01);
    tracker.record("codex-sol", { input: 40, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, 0.002);
    tracker.record("claude-sonnet", undefined, 0.5);

    const snapshot = tracker.snapshot();
    expect(snapshot.room).toEqual({ generations: 3, costUsd: 0.512, inputTokens: 140, outputTokens: 30, reasoningTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 });
    expect(snapshot.agents["codex-sol"]).toEqual({ generations: 2, costUsd: 0.012, inputTokens: 140, outputTokens: 30, reasoningTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 });
    expect(snapshot.agents["claude-sonnet"]).toEqual({ generations: 1, costUsd: 0.5, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("ignores a record with neither usage nor cost", () => {
    const tracker = new OpenRouterSpendTracker();
    tracker.record("codex-sol", undefined, undefined);
    tracker.record("codex-sol", undefined, "not-a-number");
    tracker.record("codex-sol", undefined, -1);
    tracker.record("codex-sol", undefined, Number.NaN);
    expect(tracker.snapshot()).toEqual({ room: { generations: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, agents: {} });
  });

  it("treats a free (zero-cost) generation as a recorded generation", () => {
    const tracker = new OpenRouterSpendTracker();
    tracker.record("codex-sol", { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 }, 0);
    expect(tracker.snapshot().agents["codex-sol"]).toMatchObject({ generations: 1, costUsd: 0, inputTokens: 10 });
  });
});
