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

  it("briefly cools down timed-out providers", () => {
    expect(classifyAgentFailure(new Error("claude timed out after 90 seconds"), 1_000)).toMatchObject({
      status: "cooldown",
      reason: "timeout",
      retryAt: new Date(31_000).toISOString(),
    });
  });
});

describe("AgentHealthRegistry", () => {
  it("coalesces repeated failures and announces one recovery", () => {
    const registry = new AgentHealthRegistry();
    expect(registry.recordFailure("claude-opus", new Error("HTTP 429"), 1_000).announce).toBe(true);
    expect(registry.recordFailure("claude-opus", new Error("HTTP 429"), 2_000).announce).toBe(false);
    expect(registry.canAttempt("claude-opus", 2_001)).toBe(false);
    expect(registry.recordSuccess("claude-opus")).toBe(true);
    expect(registry.recordSuccess("claude-opus")).toBe(false);
    expect(registry.snapshot()).toEqual({});
  });

  it("allows one new attempt after a cooldown expires", () => {
    const registry = new AgentHealthRegistry();
    registry.recordFailure("codex-sol", new Error("request timed out"), 1_000);
    expect(registry.canAttempt("codex-sol", 30_999)).toBe(false);
    expect(registry.canAttempt("codex-sol", 31_000)).toBe(true);
  });
});
