import { describe, expect, it, vi } from "vitest";
import { selectedModelAvailability } from "../shared/model-discovery.js";
import { DISCOVERY_OUTPUT_LIMIT, ModelDiscoveryService, parseOpenCodeModelCatalog, type DiscoveryExecutor } from "./model-discovery.js";

describe("OpenCode model discovery", () => {
  it("preserves provider/model and variant identities", () => {
    expect(parseOpenCodeModelCatalog('anthropic/claude-sonnet\n{"variants":{"high":{},"max":{}}}\nopenai/gpt-5.6\nanthropic/claude-sonnet\n')).toEqual([
      expect.objectContaining({ providerId: "anthropic", modelId: "claude-sonnet", variants: [{ id: "high", displayName: "high" }, { id: "max", displayName: "max" }] }),
      expect.objectContaining({ providerId: "openai", modelId: "gpt-5.6" }),
    ]);
  });

  it("rejects oversized output instead of parsing a truncated catalog", () => {
    expect(() => parseOpenCodeModelCatalog(`provider/${"x".repeat(DISCOVERY_OUTPUT_LIMIT)}`)).toThrow(/output limit/);
  });

  it("fails selected variants and reasoning capabilities closed when they disappear", () => {
    const result = { status: "available" as const, discoveredAt: new Date(0).toISOString(), models: [{ providerId: "provider", modelId: "model", displayName: "Model", provenance: "opencode-catalog" as const, variants: [{ id: "fast", displayName: "Fast" }], capabilities: { reasoningEffort: ["high"] } }] };
    expect(selectedModelAvailability({ providerId: "provider", modelId: "model", variant: "removed" }, result)).toMatchObject({ available: false, reason: "variant_removed" });
    expect(selectedModelAvailability({ providerId: "provider", modelId: "model", reasoningEffort: "removed" }, result)).toMatchObject({ available: false, reason: "reasoning_effort_removed" });
  });

  it("discovers OpenCode models with their provider identity", async () => {
    const execute = vi.fn<DiscoveryExecutor>(async () => ({ stdout: "provider/model variants:fast\n", stderr: "" }));
    await expect(new ModelDiscoveryService(execute).discover()).resolves.toMatchObject({ status: "available", models: [expect.objectContaining({ providerId: "provider", modelId: "model" })] });
    expect(execute).toHaveBeenCalledWith(expect.any(String), ["models", "--verbose"], undefined);
  });

  it("distinguishes CLI, authentication, configuration, and malformed output errors", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    await expect(new ModelDiscoveryService(async () => { throw missing; }).discover()).resolves.toMatchObject({ status: "cli_missing" });
    await expect(new ModelDiscoveryService(async () => { throw new Error("Not authenticated bearer-secret-value"); }).discover()).resolves.toMatchObject({ status: "authentication_required", diagnostic: "OpenCode requires authentication." });
    await expect(new ModelDiscoveryService(async () => { throw new Error("Provider configuration required"); }).discover()).resolves.toMatchObject({ status: "configuration_required" });
    await expect(new ModelDiscoveryService(async () => ({ stdout: "not a catalog", stderr: "" })).discover()).resolves.toMatchObject({ status: "error" });
  });

  it("honors cancellation signals and never converts an aborted request into catalog data", async () => {
    const controller = new AbortController();
    const execute = vi.fn<DiscoveryExecutor>(async (_command, _args, signal) => {
      expect(signal).toBe(controller.signal);
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    });
    controller.abort();
    await expect(new ModelDiscoveryService(execute).discover(false, controller.signal)).resolves.toMatchObject({ status: "error", models: [] });
  });

  it("coalesces fresh requests and refreshes stale or explicitly refreshed entries", async () => {
    let now = 0;
    const execute = vi.fn<DiscoveryExecutor>(async () => ({ stdout: "provider/model\n", stderr: "" }));
    const service = new ModelDiscoveryService(execute, () => now, 30);
    await Promise.all([service.discover(), service.discover()]);
    expect(execute).toHaveBeenCalledTimes(1);
    now = 31; await service.discover(); expect(execute).toHaveBeenCalledTimes(2);
    await service.discover(true); expect(execute).toHaveBeenCalledTimes(3);
  });
});
