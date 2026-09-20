import { describe, expect, it, vi } from "vitest";
import type { ModelDiscoveryResult } from "../shared/model-discovery.js";
import { OpenRouterCatalogService } from "./openrouter-catalog.js";

describe("OpenRouter catalog enrichment", () => {
  it("adds popularity, pricing, capabilities, benchmarks, and cached live offers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/endpoints")) return new Response(JSON.stringify({ data: { endpoints: [
        { provider_name: "Google Vertex", tag: "google-vertex/global", pricing: { prompt: "0.0000003", completion: "0.0000015", discount: 0.2 }, uptime_last_30m: 99.9, throughput_last_30m: 130 },
        { provider_name: "Google Vertex", tag: "google-vertex/us", pricing: { prompt: "0.0000004", completion: "0.0000018" } },
      ] } }), { status: 200 });
      return new Response(JSON.stringify({ data: [{
        id: "google/gemini-3.7-flash",
        name: "Google: Gemini 3.7 Flash",
        description: "Fast multimodal model.",
        context_length: 1_048_576,
        created: 1_787_184_000,
        pricing: { prompt: "0.000000375", completion: "0.000001875" },
        supported_parameters: ["tools", "reasoning"],
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
        benchmarks: { artificial_analysis: { intelligence_index: 47, coding_index: 51, agentic_index: 44 } },
      }] }), { status: 200 });
    });
    const service = new OpenRouterCatalogService(fetchMock, () => Date.UTC(2026, 7, 26));
    const discovery: ModelDiscoveryResult = { status: "available", discoveredAt: "2026-08-26T00:00:00.000Z", models: [{ providerId: "openrouter", modelId: "google/gemini-3.7-flash", displayName: "gemini-3.7-flash", authorId: "google", authorDisplayName: "Google", provenance: "opencode-catalog" }] };

    const enriched = await service.enrich(discovery);
    expect(enriched.models[0]).toMatchObject({
      displayName: "Gemini 3.7 Flash",
      description: "Fast multimodal model.",
      pricing: { inputPerMillion: 0.375, outputPerMillion: 1.875 },
      limits: { context: 1_048_576 },
      popularity: { rank: 1, window: "weekly", source: "openrouter" },
      benchmarks: { intelligence: 47, coding: 51, agentic: 44 },
      capabilities: { reasoning: true, toolCall: true, inputModalities: ["text", "image"] },
    });
    await service.enrich(discovery);
    const details = await service.details("openrouter", "google/gemini-3.7-flash");
    await service.details("openrouter", "google/gemini-3.7-flash");
    expect(details).toMatchObject({ offers: [{ providerName: "Google Vertex", providerId: "google-vertex", inputPerMillion: 0.3, outputPerMillion: 1.5, discount: 0.2, throughputTokensPerSecond: 130 }] });
    const offer=details?.offers[0];
    if(!offer)throw new Error("Expected the catalog offer fixture.");
    expect(offer.uptime).toBeCloseTo(0.999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves local discovery intact when catalog enrichment fails", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "google/model", name: "Recovered model" }] }), { status: 200 }));
    const service = new OpenRouterCatalogService(fetchMock);
    const discovery: ModelDiscoveryResult = { status: "available", discoveredAt: "2026-08-26T00:00:00.000Z", models: [{ providerId: "openrouter", modelId: "google/model", displayName: "Local name", provenance: "opencode-catalog" }] };
    await expect(service.enrich(discovery)).resolves.toEqual(discovery);
    await expect(service.enrich(discovery)).resolves.toMatchObject({ models: [{ displayName: "Recovered model" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves local optional metadata when remote fields are absent or malformed", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{
      id: "example/model", pricing: { prompt: "invalid" }, context_length: "invalid", created: Number.MAX_VALUE,
      architecture: { input_modalities: [], output_modalities: null },
    }] }), { status: 200 }));
    const service = new OpenRouterCatalogService(fetchMock);
    const localModel = {
      providerId: "openrouter", modelId: "example/model", displayName: "Local model", provenance: "opencode-catalog" as const,
      pricing: { cacheReadPerMillion: 0.1 }, limits: { input: 8_192 }, capabilities: { attachment: true, inputModalities: ["text"] },
    };
    const enriched = await service.enrich({ status: "available", discoveredAt: "2026-08-26T00:00:00.000Z", models: [localModel] });
    expect(enriched.models[0]).toEqual({
      ...localModel,
      popularity: { rank: 1, window: "weekly", source: "openrouter" },
      capabilities: { attachment: true, reasoning: false, toolCall: false, inputModalities: ["text"] },
    });
    expect(enriched.models[0]).not.toHaveProperty("releaseDate");
  });

  it("resolves current and revealed OpenRouter model pages against available OpenCode models", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      'This stealth model was revealed to be <a href="https://openrouter.ai/z-ai/glm-5.3-flash">GLM-5.3-Flash</a>.',
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
    ));
    const service = new OpenRouterCatalogService(fetchMock);
    const available = [{ providerId: "openrouter", modelId: "z-ai/glm-5.3-flash", displayName: "GLM-5.3-Flash", provenance: "opencode-catalog" as const }];

    await expect(service.resolveModelPage("https://openrouter.ai/z-ai/glm-5.3-flash?tab=providers", available)).resolves.toEqual({
      status: "available", requestedModelId: "z-ai/glm-5.3-flash", resolvedModelId: "z-ai/glm-5.3-flash", revealedReplacement: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(service.resolveModelPage("https://openrouter.ai/stealth/ox-alpha", available)).resolves.toEqual({
      status: "available", requestedModelId: "stealth/ox-alpha", resolvedModelId: "z-ai/glm-5.3-flash", revealedReplacement: true,
    });
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/stealth/ox-alpha", expect.objectContaining({ redirect: "error" }));
  });

  it("does not fetch a non-OpenRouter URL or select an unavailable revealed replacement", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      'Revealed to be <a href="https://openrouter.ai/z-ai/glm-5.3-flash">replacement</a>',
      { status: 200, headers: { "Content-Type": "text/html" } },
    ));
    const service = new OpenRouterCatalogService(fetchMock);
    await expect(service.resolveModelPage("https://openrouter.ai.evil.example/z-ai/glm-5.3-flash", [])).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(service.resolveModelPage("https://openrouter.ai/stealth/ox-alpha", [])).resolves.toEqual({
      status: "unavailable", requestedModelId: "stealth/ox-alpha", resolvedModelId: "z-ai/glm-5.3-flash", revealedReplacement: true,
    });
  });

  it("resolves the exact free variant without fetching its page", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = new OpenRouterCatalogService(fetchMock);
    const available = ["example/model", "example/model:free"].map((modelId) => ({
      providerId: "openrouter", modelId, displayName: modelId, provenance: "opencode-catalog" as const,
    }));

    await expect(service.resolveModelPage("https://openrouter.ai/example/model:free", available)).resolves.toEqual({
      status: "available", requestedModelId: "example/model:free", resolvedModelId: "example/model:free", revealedReplacement: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["model:free", "model%3Afree", "model:free?tab=providers#pricing"])("preserves the revealed free variant instead of selecting its paid base: %s", async (slug) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      `Revealed to be <a href="https://openrouter.ai/example/${slug}">replacement</a>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    ));
    const service = new OpenRouterCatalogService(fetchMock);
    const paidModel = { providerId: "openrouter", modelId: "example/model", displayName: "Model", provenance: "opencode-catalog" as const };
    const freeModel = { ...paidModel, modelId: "example/model:free" };

    await expect(service.resolveModelPage("https://openrouter.ai/stealth/example", [paidModel, freeModel])).resolves.toEqual({
      status: "available", requestedModelId: "stealth/example", resolvedModelId: "example/model:free", revealedReplacement: true,
    });
    await expect(service.resolveModelPage("https://openrouter.ai/stealth/example", [paidModel])).resolves.toEqual({
      status: "unavailable", requestedModelId: "stealth/example", resolvedModelId: "example/model:free", revealedReplacement: true,
    });
  });

  it.each(["model!invalid", "model:free/endpoints", "model%2Fother", "a".repeat(101)])("does not truncate an invalid replacement URL into an available model: %s", async (slug) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(
      `Revealed to be <a href="https://openrouter.ai/example/${slug}">replacement</a>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    ));
    const service = new OpenRouterCatalogService(fetchMock);
    const available = ["example/model", "example/model:free", `example/${"a".repeat(100)}`].map((modelId) => ({
      providerId: "openrouter", modelId, displayName: modelId, provenance: "opencode-catalog" as const,
    }));

    await expect(service.resolveModelPage("https://openrouter.ai/stealth/example", available)).resolves.toEqual({
      status: "unavailable", requestedModelId: "stealth/example", revealedReplacement: false,
    });
  });

  it("returns undefined without a fetch when no API key is configured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = new OpenRouterCatalogService(fetchMock, undefined, async () => undefined);
    await expect(service.credits()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches, caches, and computes the remaining balance from /api/v1/credits", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { total_credits: 50, total_usage: 12.5 } }), { status: 200 }));
    const service = new OpenRouterCatalogService(fetchMock, () => Date.UTC(2026, 7, 26), async () => "sk-or-v1-fixture");
    await expect(service.credits()).resolves.toEqual({ totalCreditsUsd: 50, totalUsageUsd: 12.5, remainingUsd: 37.5, fetchedAt: "2026-08-26T00:00:00.000Z" });
    await service.credits();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/credits", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sk-or-v1-fixture" }) }));
  });

  it("bypasses the cache for an explicit forceRefresh instead of returning the stale cached balance", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { total_credits: 50, total_usage: 12.5 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { total_credits: 50, total_usage: 20 } }), { status: 200 }));
    const service = new OpenRouterCatalogService(fetchMock, () => Date.UTC(2026, 7, 26), async () => "sk-or-v1-fixture");
    await expect(service.credits()).resolves.toMatchObject({ remainingUsd: 37.5 });
    await expect(service.credits()).resolves.toMatchObject({ remainingUsd: 37.5 }); // still within the TTL: cached
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(service.credits(true)).resolves.toMatchObject({ remainingUsd: 30 }); // forced: bypasses the cache
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears a rejected credits request so a later call can recover", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { total_credits: 50, total_usage: 20 } }), { status: 200 }));
    const service = new OpenRouterCatalogService(fetchMock, undefined, async () => "sk-or-v1-fixture");
    await expect(service.credits()).rejects.toThrow("offline");
    await expect(service.credits()).resolves.toMatchObject({ remainingUsd: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never reports negative remaining credits when usage exceeds the granted balance", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 25 } }), { status: 200 }));
    const service = new OpenRouterCatalogService(fetchMock, undefined, async () => "sk-or-v1-fixture");
    await expect(service.credits()).resolves.toMatchObject({ remainingUsd: 0 });
  });
});
