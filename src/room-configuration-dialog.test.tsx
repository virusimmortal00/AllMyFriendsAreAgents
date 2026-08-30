// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomConfigurationDialog, RoomPropertiesDialog } from "./room-configuration-dialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("RoomConfigurationDialog", () => {
  it("separates base prompt, summarizer, and feature flags and saves only changed fields", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        settings: {
          configurationRevision: 0,
          basePromptRevision: 0,
          basePromptText: "Default merit rule",
          summarizerModel: { providerId: "opencode", modelId: "muse-spark-1.2-contributor-free", variant: "minimal" },
          summarizerPromptText: "Summarize {{transcript}}",
          summarizerPromptRevision: 0,
          featureFlags: { preflightInvocationGating: false },
          preflightMode: "off",
          updatedAt: null,
        },
        defaults: { basePromptText: "Default merit rule" },
        routingEvidence: { recordedDecisions: 4, evaluatedShadowSuppressions: 3, falseSuppressionRate: 0, promotionEligible: false },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { basePromptRevision: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<RoomConfigurationDialog returnFocusTo={null} onClose={onClose} />);
    expect(await screen.findByRole("heading", { name: "Base Prompt" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Summarizer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Agent Routing" })).toBeTruthy();
    expect(screen.getByLabelText("Pre-flight mode")).toBeTruthy();
    expect(screen.getByTestId("preflight-evidence").textContent).toContain("3 evaluated shadow suppressions");
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Prompt", { selector: "textarea" }));
    await user.type(screen.getByLabelText("Prompt", { selector: "textarea" }), "Custom merit rule");
    await user.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[1][0]).toBe("/api/room/settings");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ basePromptText: "Custom merit rule" });
  });

  it("opens on General immediately and loads agent settings and models only when requested", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        settings: {
          configurationRevision: 0,
          basePromptRevision: 0,
          basePromptText: "Default merit rule",
          summarizerModel: null,
          summarizerPromptText: "Summarize {{transcript}}",
          summarizerPromptRevision: 0,
          featureFlags: {},
          preflightMode: "off",
          updatedAt: null,
        },
        defaults: { basePromptText: "Default merit rule" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "available", discoveredAt: "2026-08-27T00:00:00Z", models: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<RoomPropertiesDialog roomName="The Agent Room" topic="Open conversation" conversationEnergy="balanced" disabled={false} returnFocusTo={null} onSave={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "Room name" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Agent behavior" }));
    const dialog = screen.getByRole("dialog", { name: "Room Properties" });
    expect(await within(dialog).findByRole("heading", { name: "Summarizer" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: "Choose model…" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/room/settings/models");
  });
});
