// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_BEHAVIOR_RULES } from "../shared/agent-behavior";
import { RoomConfigurationPanel, RoomPropertiesDialog } from "./room-configuration-dialog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function roomConfiguration() {
  return {
    settings: {
      configurationRevision: 0,
      basePromptRevision: 0,
      basePromptText: "Default merit rule",
      summarizerModel: { providerId: "opencode", modelId: "muse-spark-1.2-contributor-free", variant: "minimal" },
      summarizerPromptText: "Summarize {{transcript}}",
      summarizerPromptRevision: 0,
      featureFlags: { preflightInvocationGating: false },
      preflightMode: "enforce",
      intentClassifierEnabled: true,
      updatedAt: null,
    },
    defaults: { basePromptText: "Default merit rule" },
    routingEvidence: { recordedDecisions: 4, evaluatedShadowSuppressions: 3, falseSuppressionRate: 0 },
  };
}

describe("RoomConfigurationPanel", () => {
  it("separates base prompt, summarizer, and routing and saves only changed fields", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(roomConfiguration()))
      .mockResolvedValueOnce(Response.json({ expiresAt: "2099-01-01T00:00:00Z", principal: { id: "owner", username: "test-admin", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "control-proof" }))
      .mockResolvedValueOnce(Response.json({ settings: { basePromptRevision: 1 } }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<RoomConfigurationPanel active onClose={onClose} />);

    expect(await screen.findByRole("heading", { name: "Base Prompt" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Summarizer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Agent Routing" })).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Pre-flight mode" }) as HTMLSelectElement).value).toBe("enforce");
    expect((screen.getByRole("checkbox", { name: "Intent classifier (Jev via OpenRouter)" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("preflight-evidence").textContent).toContain("3 evaluated shadow suppressions");

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Additional room prompt", { selector: "textarea" }));
    await user.type(screen.getByLabelText("Additional room prompt", { selector: "textarea" }), "Custom merit rule");
    await user.click(screen.getByText("Shared behavior rules · always included"));
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(AGENT_BEHAVIOR_RULES);
    await user.click(screen.getByRole("button", { name: "OK" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const [, sessionCall, saveCall] = fetchMock.mock.calls;
    if (!sessionCall || !saveCall) throw new Error("Expected session recovery and settings save requests.");
    expect(sessionCall[0]).toBe("/api/control/me");
    expect(saveCall[0]).toBe("/api/room/settings");
    expect(new Headers(saveCall[1]?.headers).get("X-AMFAA-CSRF")).toBe("control-proof");
    expect(JSON.parse(String(saveCall[1]?.body))).toEqual({ basePromptText: "Custom merit rule" });
  });

  it("retries a failed model catalog request without closing the chooser", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(roomConfiguration()))
      .mockRejectedValueOnce(new Error("Catalog unavailable"))
      .mockResolvedValueOnce(Response.json({ status: "available", discoveredAt: "2026-08-30T00:00:00Z", models: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<RoomConfigurationPanel active onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Summarizer" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Choose model…" }));
    expect((await screen.findByRole("alert")).textContent).toContain("connection was interrupted");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const retryCall = fetchMock.mock.calls.at(2);
    if (!retryCall) throw new Error("Expected the retried room model request.");
    expect(retryCall[0]).toBe("/api/room/settings/models");
    expect(await screen.findByText("0 available")).toBeTruthy();
  });
});

describe("RoomPropertiesDialog", () => {
  it("contains only member-editable general room settings", async () => {
    const fetchMock = vi.fn();
    const onOpenRepositorySettings = vi.fn();
    const user = userEvent.setup();
    vi.stubGlobal("fetch", fetchMock);
    render(<RoomPropertiesDialog roomName="The Agent Room" topic="Open conversation" conversationEnergy="balanced" disabled={false} returnFocusTo={null} onOpenRepositorySettings={onOpenRepositorySettings} onSave={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "Room name" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Identity" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Conversation" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Repository" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Change in Rooms & repositories" }));
    expect(onOpenRepositorySettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("tab", { name: "Agent behavior" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Pre-flight mode" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Intent classifier (Jev via OpenRouter)" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
