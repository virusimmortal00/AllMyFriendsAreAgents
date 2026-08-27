// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomConfigurationDialog } from "./room-configuration-dialog";

afterEach(() => vi.unstubAllGlobals());

describe("RoomConfigurationDialog", () => {
  it("separates base prompt, summarizer, and feature flags and saves only changed fields", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        settings: {
          basePromptRevision: 0,
          basePromptText: "Default merit rule",
          summarizerModel: { providerId: "opencode", modelId: "muse-spark-1.2-contributor-free", variant: "minimal" },
          summarizerPromptText: "Summarize {{transcript}}",
          summarizerPromptRevision: 0,
          featureFlags: { preflightInvocationGating: false },
          updatedAt: null,
        },
        defaults: { basePromptText: "Default merit rule" },
        modelDiscovery: { status: "available", discoveredAt: "2026-08-27T00:00:00Z", models: [] },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { basePromptRevision: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<RoomConfigurationDialog returnFocusTo={null} onClose={onClose} />);
    expect(await screen.findByRole("heading", { name: "Base Prompt" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Summarizer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Feature Flags" })).toBeTruthy();
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Prompt", { selector: "textarea" }));
    await user.type(screen.getByLabelText("Prompt", { selector: "textarea" }), "Custom merit rule");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[1][0]).toBe("/api/room/settings");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ basePromptText: "Custom merit rule" });
  });
});
