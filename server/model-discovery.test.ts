import { describe, expect, it, vi } from "vitest";
import { selectedModelAvailability } from "../shared/model-discovery.js";
import { DISCOVERY_OUTPUT_LIMIT, ModelDiscoveryService, parseCursorModelCatalog, parseOpenCodeModelCatalog, type DiscoveryExecutor } from "./model-discovery.js";

describe("model discovery adapters", () => {
  it("parses Cursor ANSI catalogs, rejects invalid IDs, and deduplicates IDs", () => {
    expect(parseCursorModelCatalog("\u001b[36msonnet\u001b[0m - Sonnet\nsonnet - Duplicate\n--bad - Unsafe\n")).toEqual([
      expect.objectContaining({ harness: "cursor", modelId: "sonnet", displayName: "Sonnet", provenance: "harness-catalog" }),
    ]);
  });

  it("preserves OpenCode provider/model and variant identities", () => {
    expect(parseOpenCodeModelCatalog('anthropic/claude-sonnet\n{"variants":{"high":{},"max":{}}}\nopenai/gpt-5.6\nanthropic/claude-sonnet\n')).toEqual([
      expect.objectContaining({ providerId: "anthropic", modelId: "claude-sonnet", variants: [{ id: "high", displayName: "high" }, { id: "max", displayName: "max" }] }),
      expect.objectContaining({ providerId: "openai", modelId: "gpt-5.6" }),
    ]);
  });

  it("rejects oversized adapter output instead of parsing a truncated catalog", () => {
    expect(() => parseCursorModelCatalog(`model - ${"x".repeat(DISCOVERY_OUTPUT_LIMIT)}`)).toThrow(/output limit/);
    expect(() => parseOpenCodeModelCatalog(`provider/${"x".repeat(DISCOVERY_OUTPUT_LIMIT)}`)).toThrow(/output limit/);
  });

  it("fails selected variants and reasoning capabilities closed when they disappear", () => {
    const result = { status: "available" as const, discoveredAt: new Date(0).toISOString(), models: [{ harness: "opencode" as const, providerId: "provider", modelId: "model", displayName: "Model", provenance: "harness-catalog" as const, variants: [{ id: "fast", displayName: "Fast" }], capabilities: { reasoningEffort: ["high"] } }] };
    expect(selectedModelAvailability({ harness: "opencode", providerId: "provider", modelId: "model", variant: "removed" }, result)).toMatchObject({ available: false, reason: "variant_removed" });
    expect(selectedModelAvailability({ harness: "opencode", providerId: "provider", modelId: "model", reasoningEffort: "removed" }, result)).toMatchObject({ available: false, reason: "reasoning_effort_removed" });
  });

  it("keeps unsupported discovery honest for Codex and Claude", async () => {
    const execute = vi.fn<DiscoveryExecutor>(async (_command, args) => ({ stdout: args[0] === "auth" ? '{"loggedIn":true}' : "1.0", stderr: "" }));
    const service = new ModelDiscoveryService(execute);
    await expect(service.discover("codex")).resolves.toMatchObject({ status: "discovery_unsupported", models: expect.arrayContaining([expect.objectContaining({ provenance: "documented-alias" })]) });
    await expect(service.discover("claude")).resolves.toMatchObject({ status: "discovery_unsupported", models: expect.arrayContaining([expect.objectContaining({ modelId: "claude-sonnet-5" })]) });
  });

  it("discovers Cursor and OpenCode independently", async () => {
    const execute = vi.fn<DiscoveryExecutor>(async (_command, args) => args[0] === "--list-models"
      ? { stdout: "cursor-a - Cursor A\n", stderr: "" }
      : { stdout: "provider/model variants:fast\n", stderr: "" });
    const service = new ModelDiscoveryService(execute);
    await expect(service.discover("cursor")).resolves.toMatchObject({ status: "available", models: [expect.objectContaining({ modelId: "cursor-a" })] });
    await expect(service.discover("opencode")).resolves.toMatchObject({ status: "available", models: [expect.objectContaining({ providerId: "provider", modelId: "model" })] });
  });

  it("distinguishes CLI, authentication, configuration, and malformed output errors", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    await expect(new ModelDiscoveryService(async () => { throw missing; }).discover("cursor")).resolves.toMatchObject({ status: "cli_missing" });
    await expect(new ModelDiscoveryService(async () => { throw new Error("Not authenticated bearer-secret-value"); }).discover("opencode")).resolves.toMatchObject({ status: "authentication_required", diagnostic: "The harness requires authentication." });
    await expect(new ModelDiscoveryService(async () => ({ stdout: "not a catalog", stderr: "" })).discover("cursor")).resolves.toMatchObject({ status: "error" });
  });

  it("classifies missing CLI and authentication failures for every adapter without returning raw output", async () => {
    for (const harness of ["codex", "claude", "cursor", "opencode"] as const) {
      const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      await expect(new ModelDiscoveryService(async () => { throw missing; }).discover(harness)).resolves.toMatchObject({ status: "cli_missing" });
      await expect(new ModelDiscoveryService(async () => { throw new Error("Not authenticated with secret-token-value"); }).discover(harness)).resolves.toEqual(expect.objectContaining({ status: "authentication_required", diagnostic: "The harness requires authentication." }));
      await expect(new ModelDiscoveryService(async () => { throw new Error("Provider configuration required"); }).discover(harness)).resolves.toEqual(expect.objectContaining({ status: "configuration_required", diagnostic: "The harness requires provider or model configuration." }));
    }
  });

  it("honors cancellation signals and never converts an aborted request into catalog data", async () => {
    const controller = new AbortController();
    const execute = vi.fn<DiscoveryExecutor>(async (_command, _args, signal) => {
      expect(signal).toBe(controller.signal);
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    });
    controller.abort();
    await expect(new ModelDiscoveryService(execute).discover("cursor", false, controller.signal)).resolves.toMatchObject({ status: "error", models: [] });
  });

  it("coalesces fresh requests and refreshes stale or explicitly refreshed entries", async () => {
    let now = 0;
    const execute = vi.fn<DiscoveryExecutor>(async () => ({ stdout: "model - Model\n", stderr: "" }));
    const service = new ModelDiscoveryService(execute, () => now, 30);
    await Promise.all([service.discover("cursor"), service.discover("cursor")]);
    expect(execute).toHaveBeenCalledTimes(1);
    now = 31; await service.discover("cursor"); expect(execute).toHaveBeenCalledTimes(2);
    await service.discover("cursor", true); expect(execute).toHaveBeenCalledTimes(3);
  });
});
