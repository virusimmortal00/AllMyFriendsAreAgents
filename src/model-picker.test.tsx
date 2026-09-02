// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RichModelPicker } from "./model-picker";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const models = [
  { providerId: "openrouter", modelId: "google/gemini-3.7-flash", displayName: "Gemini 3.7 Flash", description: "Fast multimodal model", authorId: "google", authorDisplayName: "Google", accessProviderDisplayName: "OpenRouter", pricing: { inputPerMillion: 0.375, outputPerMillion: 1.875 }, limits: { context: 1_048_576 }, popularity: { rank: 3, window: "weekly" as const, source: "openrouter" as const }, capabilities: { reasoning: true, toolCall: true, inputModalities: ["text", "image"] }, provenance: "opencode-catalog" as const },
  { providerId: "openrouter", modelId: "z-ai/glm-5.3-flash", displayName: "GLM-5.3-Flash", authorId: "z-ai", authorDisplayName: "Z.AI", accessProviderDisplayName: "OpenRouter", capabilities: { reasoning: true, toolCall: true }, provenance: "opencode-catalog" as const },
  { providerId: "anthropic", modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5", authorId: "anthropic", authorDisplayName: "Anthropic", pricing: { inputPerMillion: 3, outputPerMillion: 15 }, limits: { context: 200_000 }, capabilities: { reasoning: true, toolCall: true }, provenance: "opencode-catalog" as const },
] as const;

describe("rich model picker", () => {
  it("keeps the compact dropdown and wide-screen filter buttons synchronized", async () => {
    const user = userEvent.setup();
    render(<RichModelPicker models={models} providerId="" modelId="" onChange={vi.fn()} />);
    const compactFilter = screen.getByRole("combobox", { name: "Filter models" });
    await user.selectOptions(compactFilter, "vision");
    expect(screen.getByRole("button", { name: "Images" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Gemini 3.7 Flash/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Claude Sonnet 5/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect((compactFilter as HTMLSelectElement).value).toBe("all");
    expect(screen.getByRole("button", { name: /Claude Sonnet 5/ })).toBeTruthy();
  });

  it("searches friendly metadata, selects a model, explains routing, and shows a live sale", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ providerId: "openrouter", modelId: "google/gemini-3.7-flash", fetchedAt: "2026-08-26T00:00:00.000Z", offers: [{ providerName: "Google Vertex", providerId: "google-vertex", inputPerMillion: 0.3, outputPerMillion: 1.5, discount: 0.2 }] }), { status: 200 })));
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(<RichModelPicker models={models} providerId="" modelId="" onChange={onChange} />);

    expect(screen.getByText("Popular #3")).toBeTruthy();
    expect(screen.getByText("1M")).toBeTruthy();
    await user.type(screen.getByRole("searchbox", { name: "Search models or paste OpenRouter link" }), "gemini");
    expect(screen.getByRole("button", { name: /Gemini 3.7 Flash/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Claude Sonnet 5/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Gemini 3.7 Flash/ }));
    expect(onChange).toHaveBeenCalledWith(models[0]);

    view.rerender(<RichModelPicker models={models} providerId="openrouter" modelId="google/gemini-3.7-flash" onChange={onChange} />);
    expect(screen.getByText(/Built by Google · accessed through OpenRouter/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Save 20%")).toBeTruthy());
    expect(screen.getByText("Google Vertex")).toBeTruthy();
  });

  it("resolves a pasted retired OpenRouter model page to its available replacement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      status: "available", requestedModelId: "stealth/ox-alpha", resolvedModelId: "z-ai/glm-5.3-flash", revealedReplacement: true,
    })));
    const user = userEvent.setup();
    render(<RichModelPicker models={models} providerId="" modelId="" onChange={vi.fn()} />);

    await user.type(screen.getByRole("searchbox", { name: "Search models or paste OpenRouter link" }), "https://openrouter.ai/stealth/ox-alpha");
    await user.click(screen.getByRole("button", { name: "Find link" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("was revealed as GLM-5.3-Flash"));
    expect(screen.getByRole("button", { name: /GLM-5.3-Flash/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Gemini 3.7 Flash/ })).toBeNull();
  });
});
