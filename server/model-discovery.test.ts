import { describe, expect, it, vi } from "vitest";
import { selectedModelAvailability } from "../shared/model-discovery.js";
import { APPROVED_DOWNSTREAM_OPENCODE_VERSION, DISCOVERY_OUTPUT_LIMIT, MAXIMUM_AUDITED_OPENCODE_VERSION, MINIMUM_OPENCODE_VERSION, ModelDiscoveryService, parseOpenCodeModelCatalog, parseOpenCodeRuntimeVersion, type DiscoveryExecutor } from "./model-discovery.js";

describe("OpenCode model discovery", () => {
  it("preserves provider/model and variant identities", () => {
    expect(parseOpenCodeModelCatalog('anthropic/claude-sonnet\n{"variants":{"high":{},"max":{}}}\nopenai/gpt-5.6\nopenrouter/~openai/gpt-latest\nanthropic/claude-sonnet\n')).toEqual([
      expect.objectContaining({ providerId: "anthropic", modelId: "claude-sonnet", variants: [{ id: "high", displayName: "high" }, { id: "max", displayName: "max" }] }),
      expect.objectContaining({ providerId: "openai", modelId: "gpt-5.6" }),
      expect.objectContaining({ providerId: "openrouter", modelId: "~openai/gpt-latest" }),
    ]);
  });

  it("preserves friendly catalog metadata used by the model picker", () => {
    const [model] = parseOpenCodeModelCatalog(`openrouter/google/gemini-3.7-flash
{"name":"Gemini 3.7 Flash","family":"gemini","release_date":"2026-08-20","cost":{"input":0.375,"output":1.875,"cache":{"read":0.04}},"limit":{"context":1048576,"output":65536},"capabilities":{"reasoning":true,"toolcall":true,"attachment":true,"input":{"text":true,"image":true},"output":{"text":true}},"variants":{"high":{"reasoningEffort":"high"}}}
`);

    expect(model).toMatchObject({
      providerId: "openrouter",
      modelId: "google/gemini-3.7-flash",
      displayName: "Gemini 3.7 Flash",
      authorId: "google",
      authorDisplayName: "Google",
      accessProviderDisplayName: "OpenRouter",
      pricing: { inputPerMillion: 0.375, outputPerMillion: 1.875, cacheReadPerMillion: 0.04 },
      limits: { context: 1_048_576, output: 65_536 },
      capabilities: { reasoning: true, toolCall: true, attachment: true, inputModalities: ["text", "image"], outputModalities: ["text"], reasoningEffort: ["high"] },
    });
  });

  it("accepts a bounded OpenRouter-sized verbose catalog", () => {
    const verboseCatalog = `${Array.from({ length: 410 }, () => `# ${"x".repeat(1_000)}`).join("\n")}\nopenrouter/openai/gpt-5.2\n`;
    expect(Buffer.byteLength(verboseCatalog)).toBeGreaterThan(256_000);
    expect(parseOpenCodeModelCatalog(verboseCatalog)).toEqual([
      expect.objectContaining({ providerId: "openrouter", modelId: "openai/gpt-5.2" }),
    ]);
  });

  it("rejects oversized output instead of parsing a truncated catalog", () => {
    expect(() => parseOpenCodeModelCatalog(`provider/${"x".repeat(DISCOVERY_OUTPUT_LIMIT)}`)).toThrow(/output limit/);
  });

  it("fails selected variants and reasoning capabilities closed when they disappear", () => {
    const result = { status: "available" as const, discoveredAt: new Date(0).toISOString(), models: [{ providerId: "provider", modelId: "model", displayName: "Model", provenance: "opencode-catalog" as const, variants: [{ id: "fast", displayName: "Fast" }], capabilities: { reasoningEffort: ["high"] } }] };
    expect(selectedModelAvailability({ providerId: "provider", modelId: "model", variant: "removed" }, result)).toMatchObject({ available: false, reason: "variant_removed" });
    expect(selectedModelAvailability({ providerId: "provider", modelId: "model", reasoningEffort: "removed" }, result)).toMatchObject({ available: false, reason: "reasoning_effort_removed" });
    expect(selectedModelAvailability({ providerId: "provider", modelId: "model", variant: "fast", reasoningEffort: "high" }, result)).toMatchObject({ available: false, reason: "variant_conflict" });
  });

  it("discovers OpenCode models with their provider identity", async () => {
    const execute = vi.fn<DiscoveryExecutor>(async (_command, args) => ({ stdout: args[0] === "--version" ? `${MINIMUM_OPENCODE_VERSION}\n` : "provider/model variants:fast\n", stderr: "" }));
    await expect(new ModelDiscoveryService(execute).discover()).resolves.toMatchObject({
      status: "available",
      runtime: { version: MINIMUM_OPENCODE_VERSION, compatible: true, distribution: "upstream", protocol: "opencode-cli-jsonl-v1", capabilities: ["verbose-model-catalog", "jsonl-events", "variant-selection"] },
      models: [expect.objectContaining({ providerId: "provider", modelId: "model" })],
    });
    expect(execute).toHaveBeenNthCalledWith(1, expect.any(String), ["--version"], undefined);
    expect(execute).toHaveBeenNthCalledWith(2, expect.any(String), ["models", "--verbose"], undefined);
  });

  it("fails closed before catalog discovery for unsupported or malformed versions", async () => {
    expect(parseOpenCodeRuntimeVersion("1.18.17\n")).toMatchObject({ compatible: false, distribution: "unrecognized" });
    expect(parseOpenCodeRuntimeVersion("1.18.18-rc.1\n")).toMatchObject({ version: "1.18.18-rc.1", compatible: false, distribution: "unrecognized" });
    expect(parseOpenCodeRuntimeVersion("1.18.18\n")).toMatchObject({ compatible: true, distribution: "upstream" });
    expect(parseOpenCodeRuntimeVersion("1.18.18+build.1\n")).toMatchObject({ version: "1.18.18+build.1", compatible: false, distribution: "unrecognized" });
    expect(parseOpenCodeRuntimeVersion(`${MAXIMUM_AUDITED_OPENCODE_VERSION}\n`)).toMatchObject({ compatible: true, distribution: "upstream" });
    expect(parseOpenCodeRuntimeVersion(`${APPROVED_DOWNSTREAM_OPENCODE_VERSION}\n`)).toMatchObject({ compatible: true, distribution: "downstream" });
    expect(parseOpenCodeRuntimeVersion("1.18.25-amfaa.2\n")).toMatchObject({ compatible: false, distribution: "unrecognized", capabilities: [] });
    expect(parseOpenCodeRuntimeVersion("1.18.25-local.1\n")).toMatchObject({ compatible: false, distribution: "unrecognized", capabilities: [] });
    expect(parseOpenCodeRuntimeVersion("01.18.25-amfaa.1\n")).toMatchObject({ compatible: false, distribution: "unrecognized", capabilities: [] });
    expect(parseOpenCodeRuntimeVersion("1.18.26-rc.1\n")).toMatchObject({ compatible: false, capabilities: [] });
    expect(parseOpenCodeRuntimeVersion("1.18.26\n")).toMatchObject({ compatible: false, capabilities: [] });
    expect(parseOpenCodeRuntimeVersion("1.99.0\n")).toMatchObject({ compatible: false, capabilities: [] });
    expect(parseOpenCodeRuntimeVersion("2.0.0\n")).toMatchObject({ compatible: false });
    expect(parseOpenCodeRuntimeVersion("unexpected")).toBeUndefined();
    const execute = vi.fn<DiscoveryExecutor>(async () => ({ stdout: "1.18.17\n", stderr: "" }));
    await expect(new ModelDiscoveryService(execute).discover()).resolves.toMatchObject({ status: "runtime_incompatible", runtime: { version: "1.18.17", compatible: false }, models: [] });
    expect(execute).toHaveBeenCalledTimes(1);
    const future = vi.fn<DiscoveryExecutor>(async () => ({ stdout: "1.18.26\n", stderr: "" }));
    await expect(new ModelDiscoveryService(future).discover()).resolves.toMatchObject({ status: "runtime_incompatible", diagnostic: expect.stringContaining("not an approved runtime identity"), models: [] });
    expect(future).toHaveBeenCalledTimes(1);
    const malformed = vi.fn<DiscoveryExecutor>(async () => ({ stdout: "unexpected\n", stderr: "" }));
    await expect(new ModelDiscoveryService(malformed).discover()).resolves.toMatchObject({
      status: "runtime_incompatible",
      diagnostic: `OpenCode returned an unrecognized version; install an exact release from ${MINIMUM_OPENCODE_VERSION} through ${MAXIMUM_AUDITED_OPENCODE_VERSION}, or the approved downstream build ${APPROVED_DOWNSTREAM_OPENCODE_VERSION}.`,
      models: [],
    });
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it("distinguishes CLI, authentication, configuration, and malformed output errors", async () => {
    const missing = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    await expect(new ModelDiscoveryService(async () => { throw missing; }).discover()).resolves.toMatchObject({ status: "cli_missing" });
    const afterVersion = (failure: Error) => new ModelDiscoveryService(async (_command, args) => {
      if (args[0] === "--version") return { stdout: `${MINIMUM_OPENCODE_VERSION}\n`, stderr: "" };
      throw failure;
    });
    await expect(afterVersion(new Error("Not authenticated bearer-secret-value")).discover()).resolves.toMatchObject({ status: "authentication_required", diagnostic: "OpenCode requires authentication.", runtime: { version: MINIMUM_OPENCODE_VERSION } });
    await expect(afterVersion(new Error("Provider configuration required")).discover()).resolves.toMatchObject({ status: "configuration_required", runtime: { version: MINIMUM_OPENCODE_VERSION } });
    await expect(new ModelDiscoveryService(async (_command, args) => ({ stdout: args[0] === "--version" ? `${MINIMUM_OPENCODE_VERSION}\n` : "not a catalog", stderr: "" })).discover()).resolves.toMatchObject({ status: "error", runtime: { version: MINIMUM_OPENCODE_VERSION } });
  });

  it("honors cancellation signals without caching the aborted caller's result", async () => {
    const controller = new AbortController();
    const execute = vi.fn<DiscoveryExecutor>(async (_command, args, signal) => {
      if (signal) {
        expect(signal).toBe(controller.signal);
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      }
      return { stdout: args[0] === "--version" ? `${MINIMUM_OPENCODE_VERSION}\n` : "provider/model\n", stderr: "" };
    });
    controller.abort();
    const service = new ModelDiscoveryService(execute);
    await expect(service.discover(false, controller.signal)).resolves.toMatchObject({ status: "error", models: [] });
    await expect(service.discover()).resolves.toMatchObject({ status: "available", models: [expect.objectContaining({ modelId: "model" })] });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("coalesces fresh requests and refreshes stale or explicitly refreshed entries", async () => {
    let now = 0;
    const execute = vi.fn<DiscoveryExecutor>(async (_command, args) => ({ stdout: args[0] === "--version" ? `${MINIMUM_OPENCODE_VERSION}\n` : "provider/model\n", stderr: "" }));
    const service = new ModelDiscoveryService(execute, () => now, 30);
    await Promise.all([service.discover(), service.discover()]);
    expect(execute).toHaveBeenCalledTimes(2);
    now = 31; await service.discover(); expect(execute).toHaveBeenCalledTimes(4);
    await service.discover(true); expect(execute).toHaveBeenCalledTimes(6);
  });
});
