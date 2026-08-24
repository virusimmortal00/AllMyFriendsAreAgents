import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentHealthRegistry, classifyAgentFailure } from "./agent-health.js";

describe("agent failure classification", () => {
  it("holds authentication failures until an explicit successful attempt", () => {
    const health = classifyAgentFailure(new Error("Not logged in · Please run /login"), 1_000);
    expect(health).toMatchObject({
      status: "unavailable",
      reason: "authentication",
    });
    expect(health).not.toHaveProperty("retryAt");
  });

  it("uses provider retry guidance for rate limits", () => {
    expect(classifyAgentFailure(new Error("HTTP 429; retry-after 2 minutes"), 1_000)).toMatchObject({
      status: "cooldown",
      reason: "rate_limit",
      retryAt: new Date(121_000).toISOString(),
    });
  });

  it("understands Claude's absolute local reset time", () => {
    const now = new Date();
    now.setHours(13, 44, 0, 0);
    const expected = new Date(now);
    expected.setHours(17, 20, 0, 0);

    expect(classifyAgentFailure(new Error("HTTP 429: session limit · resets 5:20pm (America/New_York)"), now.getTime())).toMatchObject({
      status: "cooldown",
      reason: "rate_limit",
      retryAt: expected.toISOString(),
    });
  });

  it("briefly cools down timed-out providers", () => {
    expect(classifyAgentFailure(new Error("claude timed out after 90 seconds"), 1_000)).toMatchObject({
      status: "cooldown",
      reason: "timeout",
      retryAt: new Date(31_000).toISOString(),
    });
  });
});

describe("AgentHealthRegistry", () => {
  it("coalesces repeated failures and announces one recovery", async () => {
    const registry = AgentHealthRegistry.memory();
    await registry.recordFailure("claude-sonnet", new Error("HTTP 429"), 1_000);
    await registry.recordFailure("claude-sonnet", new Error("HTTP 429"), 2_000);
    expect(registry.canAttempt("claude-sonnet", 2_001)).toBe(false);
    expect(await registry.recordSuccess("claude-sonnet")).toBe(true);
    expect(await registry.recordSuccess("claude-sonnet")).toBe(false);
    expect(registry.snapshot()).toEqual({});
  });

  it("allows one new attempt after a cooldown expires", async () => {
    const registry = AgentHealthRegistry.memory();
    await registry.recordFailure("codex-sol", new Error("request timed out"), 1_000);
    expect(registry.canAttempt("codex-sol", 30_999)).toBe(false);
    expect(registry.canAttempt("codex-sol", 31_000)).toBe(true);
    expect(registry.snapshot(31_000)).toEqual({});
  });

  it("preserves cooldowns across server restarts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-agent-health-"));
    try {
      const now = Date.now();
      const registry = await AgentHealthRegistry.open(directory);
      await registry.recordFailure("claude-sonnet", new Error("HTTP 429 retry-after 2 minutes"), now);

      const reopened = await AgentHealthRegistry.open(directory);
      expect(reopened.snapshot()["claude-sonnet"]).toMatchObject({
        status: "cooldown",
        reason: "rate_limit",
        retryAt: new Date(now + 120_000).toISOString(),
      });
      expect(reopened.canAttempt("claude-sonnet", now + 119_999)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
