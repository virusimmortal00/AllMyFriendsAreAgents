import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRoomAgentRoster, roomAgentProviderScope } from "../shared/roster.js";
import { ProviderInvocationError } from "./provider-failure.js";
import { classifyProviderScopedFailure, isProviderUsageExhaustion, providerActionRequiredReason, ProviderHealthRegistry } from "./provider-health.js";

const providerError = (message: string, details: Partial<ConstructorParameters<typeof ProviderInvocationError>[0]> = {}) => new ProviderInvocationError({
  source: "opencode",
  name: "APIError",
  message,
  ...details,
});

describe("provider usage exhaustion classification", () => {
  it("recognizes the observed Cursor-style exhaustion instruction", () => {
    const observed = providerError("Increase limits for faster responses. You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.", { retryable: false });
    expect(isProviderUsageExhaustion(observed, "cursor")).toBe(true);
    expect(isProviderUsageExhaustion(observed, "unrelated-provider")).toBe(false);
  });

  it("uses allowlisted OpenCode provider codes without retaining raw response data", () => {
    expect(isProviderUsageExhaustion(providerError("Quota exceeded. Check your plan and billing details.", { code: "insufficient_quota", retryable: false }), "openai")).toBe(true);
    expect(isProviderUsageExhaustion(providerError("Free usage exceeded", { code: "free_tier_limit", statusCode: 429, retryable: true }), "opencode")).toBe(true);
    expect(providerActionRequiredReason(providerError("Upgrade required", { code: "usage_not_included", retryable: false }), "openai")).toBe("usage_not_included");
  });

  it("separates account-scoped cooldowns from generic transient and participant-local failures", () => {
    expect(isProviderUsageExhaustion(providerError("HTTP 429 rate limit; retry-after 20 seconds", { statusCode: 429, retryable: true }), "cursor")).toBe(false);
    const accountLimit = providerError("Subscription quota exceeded", { code: "account_rate_limit", statusCode: 429, retryable: true, retryAfterMs: 120_000 });
    expect(isProviderUsageExhaustion(accountLimit, "opencode")).toBe(false);
    expect(classifyProviderScopedFailure(accountLimit, "opencode", 1_000)).toEqual({
      status: "cooldown",
      reason: "account_rate_limit",
      retryAt: new Date(121_000).toISOString(),
      retrySource: "provider",
    });
    expect(classifyProviderScopedFailure(providerError("HTTP 429", { statusCode: 429, retryable: true }), "cursor", 1_000)).toBeUndefined();
    expect(isProviderUsageExhaustion(providerError("Quota exceeded temporarily; try again in 2 minutes", { retryable: true }), "cursor")).toBe(false);
    expect(isProviderUsageExhaustion(new Error("Provider returned an empty response"), "cursor")).toBe(false);
    expect(isProviderUsageExhaustion(new Error(""), "cursor")).toBe(false);
  });
});

describe("ProviderHealthRegistry", () => {
  it("fans out through provider identity while leaving unrelated providers available", async () => {
    const registry = ProviderHealthRegistry.memory();
    const roster = defaultRoomAgentRoster();
    await registry.recordActionRequired("cursor", "usage_exhausted", 1_000);

    for (const agent of ["cursor-grok", "cursor-composer", "cursor-gemini-flash", "cursor-glm"]) {
      const providerId = roomAgentProviderScope(roster, agent);
      expect(registry.snapshot()[providerId]).toMatchObject({ status: "action_required", reason: "usage_exhausted" });
      expect(registry.claimAttempt(providerId)).toBe("blocked");
    }
    expect(registry.snapshot().anthropic).toBeUndefined();
    expect(registry.canAttempt("cursor")).toBe(false);
    expect(registry.canAttempt("anthropic")).toBe(true);
    expect(registry.claimAttempt(roomAgentProviderScope(roster, "claude-sonnet"))).toBe("regular");
  });

  it("allows exactly one explicit recovery attempt and clears only after success", async () => {
    const registry = ProviderHealthRegistry.memory();
    await registry.recordActionRequired("cursor", "usage_exhausted", 1_000);

    expect(await registry.requestRecovery("cursor")).toBe(true);
    expect(registry.canAttempt("cursor")).toBe(true);
    expect(registry.claimAttempt("cursor")).toBe("recovery");
    expect(registry.canAttempt("cursor")).toBe(false);
    expect(registry.claimAttempt("cursor")).toBe("blocked");
    registry.recordRecoveryFailure("cursor");
    expect(registry.claimAttempt("cursor")).toBe("blocked");

    expect(await registry.requestRecovery("cursor")).toBe(true);
    expect(registry.claimAttempt("cursor")).toBe("recovery");
    expect(await registry.recordSuccess("cursor")).toBe(true);
    expect(registry.claimAttempt("cursor")).toBe("regular");
    expect(registry.snapshot()).toEqual({});
  });

  it("fans out a known account cooldown and expires it without enabling action recovery", async () => {
    const registry = ProviderHealthRegistry.memory();
    await registry.recordCooldown("opencode", {
      status: "cooldown",
      reason: "account_rate_limit",
      retryAt: new Date(121_000).toISOString(),
      retrySource: "provider",
    }, 1_000);

    expect(registry.snapshot(1_000).opencode).toEqual({
      status: "cooldown",
      reason: "account_rate_limit",
      message: "OpenCode Zen is temporarily rate limited.",
      since: new Date(1_000).toISOString(),
      retryAt: new Date(121_000).toISOString(),
      retrySource: "provider",
    });
    expect(registry.claimAttempt("opencode", 120_999)).toBe("blocked");
    expect(registry.canAttempt("opencode", 120_999)).toBe(false);
    expect(registry.canAttempt("opencode", 121_000)).toBe(true);
    expect(registry.claimAttempt("opencode", 121_000)).toBe("regular");
    expect(await registry.requestRecovery("opencode")).toBe(false);
    expect(registry.nextRetryAt(1_000)).toBe(121_000);
    expect(await registry.expire(121_000)).toBe(true);
    expect(registry.snapshot(121_000)).toEqual({});
  });

  it("persists only sanitized action-required state and not stale recovery grants", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-provider-health-"));
    try {
      const registry = await ProviderHealthRegistry.open(directory);
      await registry.recordActionRequired("cursor", "usage_exhausted", 1_000);
      await registry.requestRecovery("cursor");

      const persisted = await readFile(path.join(directory, "provider-health.json"), "utf8");
      expect(persisted).toContain('"reason": "usage_exhausted"');
      expect(persisted).not.toMatch(/increase|mode|raw|token|session|account/i);

      const reopened = await ProviderHealthRegistry.open(directory);
      expect(reopened.snapshot().cursor).toEqual({
        status: "action_required",
        reason: "usage_exhausted",
        message: "Cursor usage is exhausted; increase the limit or change provider mode.",
        since: new Date(1_000).toISOString(),
      });
      expect(reopened.claimAttempt("cursor")).toBe("blocked");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists only bounded provider cooldown state across restart", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-provider-cooldown-"));
    try {
      const registry = await ProviderHealthRegistry.open(directory);
      await registry.recordCooldown("opencode", {
        status: "cooldown",
        reason: "account_rate_limit",
        retryAt: new Date(121_000).toISOString(),
        retrySource: "provider",
      }, 1_000);

      const persisted = await readFile(path.join(directory, "provider-health.json"), "utf8");
      expect(persisted).toContain('"schemaVersion": 2');
      expect(persisted).toContain('"reason": "account_rate_limit"');
      expect(persisted).not.toMatch(/workspace|credential|session|response|header|raw/i);

      const reopened = await ProviderHealthRegistry.open(directory);
      expect(reopened.snapshot(1_000).opencode).toMatchObject({
        status: "cooldown",
        reason: "account_rate_limit",
        retryAt: new Date(121_000).toISOString(),
        retrySource: "provider",
      });
      expect(reopened.claimAttempt("opencode", 120_999)).toBe("blocked");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts with empty optional provider state when its cache is corrupt", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "amfaa-provider-health-corrupt-"));
    try {
      await writeFile(path.join(directory, "provider-health.json"), "{not-json", "utf8");
      const registry = await ProviderHealthRegistry.open(directory);
      expect(registry.snapshot()).toEqual({});
      expect(registry.claimAttempt("cursor")).toBe("regular");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
