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
      .mockResolvedValueOnce(Response.json({ principal: { role: "OWNER" }, csrfToken: "control-proof" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { basePromptRevision: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<RoomConfigurationDialog returnFocusTo={null} onClose={onClose} />);
    expect(await screen.findByRole("heading", { name: "Base Prompt" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Summarizer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Agent Routing" })).toBeTruthy();
    expect(screen.getByLabelText("Pre-flight mode")).toBeTruthy();
    expect(screen.getByTestId("preflight-evidence").textContent).toContain("3 evaluated shadow suppressions");
    expect(screen.getByRole("region", { name: "Base Prompt" }).classList.contains("classic-property-section")).toBe(true);
    expect(screen.getByRole("checkbox", { name: "Include a room base prompt" }).closest("label")?.classList.contains("classic-check")).toBe(true);
    expect(screen.getByRole("button", { name: "Use built-in default" }).closest("label")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Pre-flight mode" }).classList.contains("classic-select")).toBe(true);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Prompt", { selector: "textarea" }));
    await user.type(screen.getByLabelText("Prompt", { selector: "textarea" }), "Temporary prompt");
    await user.click(screen.getByRole("button", { name: "Use built-in default" }));
    expect((screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).value).toBe("Default merit rule");
    await user.click(screen.getByRole("checkbox", { name: "Include a room base prompt" }));
    expect((screen.getByRole("textbox", { name: "Prompt" }) as HTMLTextAreaElement).disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Include a room base prompt" }));
    await user.clear(screen.getByLabelText("Prompt", { selector: "textarea" }));
    await user.type(screen.getByLabelText("Prompt", { selector: "textarea" }), "Custom merit rule");
    await user.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[1][0]).toBe("/api/control/me");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/room/settings");
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("X-AMFAA-CSRF")).toBe("control-proof");
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ basePromptText: "Custom merit rule" });
  });

  it.each([true, false])("preserves drafts through administrator recovery (claimed=%s)", async (claimed) => {
    const settings = { configurationRevision: 0, basePromptRevision: 0, basePromptText: "Default rule", summarizerModel: null, summarizerPromptText: "Summarize {{transcript}}", summarizerPromptRevision: 0, featureFlags: {}, preflightMode: "off", updatedAt: null };
    let authenticated = false;
    let loginAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/control/me") return authenticated ? Response.json({ principal: { role: "OWNER" }, csrfToken: "fresh-control-proof" }) : Response.json({ error: "Authentication required" }, { status: 401 });
      if (url === "/api/control/status") return Response.json({ claimed, bootstrapConfigured: true });
      if (url === "/api/control/login" || url === "/api/control/bootstrap") {
        if (++loginAttempts === 1) return Response.json({ error: "Invalid administrator credentials" }, { status: 401 });
        authenticated = true;
        return Response.json({ principal: { role: "OWNER" }, csrfToken: "login-control-proof" });
      }
      if (url === "/api/control/integrations/github") return Response.json({ connections: [] });
      if (url === "/api/control/projects/current/repository") return Response.json({ error: "Not configured" }, { status: 404 });
      if (url === "/api/room/settings") return Response.json({ settings: init?.method === "PUT" ? { ...settings, ...JSON.parse(String(init.body)) } : settings });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<RoomPropertiesDialog roomName="The Agent Room" topic="Open conversation" conversationEnergy="balanced" disabled={false} returnFocusTo={null} onSave={vi.fn()} onClose={onClose} />);
    await user.click(screen.getByRole("tab", { name: "Agent behavior" }));
    const prompt = await screen.findByLabelText("Prompt", { selector: "textarea" });
    await user.clear(prompt);
    await user.type(prompt, "Draft room rule");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    const signIn = await screen.findByRole("button", { name: "Administrator sign-in…" });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    await user.click(signIn);
    await screen.findByRole("heading", { name: claimed ? "Server administrator sign in" : "Claim server owner" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "GitHub" })).toBeNull();
    expect(document.activeElement).toBe(signIn);
    expect((prompt as HTMLTextAreaElement).value).toBe("Draft room rule");
    expect(onClose).not.toHaveBeenCalled();
    await user.click(signIn);
    const username = await screen.findByLabelText("Username");
    await user.type(username, "test-admin");
    await user.type(screen.getByLabelText("Password"), "synthetic-test-password");
    if (!claimed) await user.type(screen.getByLabelText("Local bootstrap secret"), "synthetic-bootstrap-secret");
    await user.click(screen.getByRole("button", { name: claimed ? "Sign in" : "Claim owner" }));
    expect(await screen.findByText("Invalid administrator credentials")).toBeTruthy();
    expect((prompt as HTMLTextAreaElement).value).toBe("Draft room rule");
    await user.click(screen.getByRole("button", { name: claimed ? "Sign in" : "Claim owner" }));
    await screen.findByRole("heading", { name: "Connect GitHub" });
    await user.click(screen.getByRole("button", { name: "Close GitHub integration" }));
    expect(document.activeElement).toBe(signIn);
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
    const saved = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(JSON.parse(String(saved?.[1]?.body))).toEqual({ basePromptText: "Draft room rule" });
    expect(new Headers(saved?.[1]?.headers).get("X-AMFAA-CSRF")).toBe("fresh-control-proof");
    expect(onClose).not.toHaveBeenCalled();
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

    const roomName = screen.getByRole("textbox", { name: "Room name" });
    expect(roomName).toBeTruthy();
    expect(roomName.closest(".room-properties-page-content")?.classList.contains("classic-property-section")).toBe(true);
    expect(roomName.closest(".room-properties-page-content")?.classList.contains("room-properties-general-content")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Agent behavior" }));
    const dialog = screen.getByRole("dialog", { name: "Room Properties" });
    expect(await within(dialog).findByRole("heading", { name: "Summarizer" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: "Choose model…" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/room/settings/models");
    await user.click(await screen.findByRole("button", { name: "Back to agent behavior" }));
    const chooseModels = screen.getByRole("button", { name: "Choose model…" });
    expect(document.activeElement).toBe(chooseModels);
    expect(screen.queryByRole("button", { name: "Back to agent behavior" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a General draft open when OK is used from Agent behavior", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
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
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<RoomPropertiesDialog roomName="The Agent Room" topic="Open conversation" conversationEnergy="balanced" disabled={false} returnFocusTo={null} onSave={vi.fn()} onClose={onClose} />);

    const roomName = screen.getByRole("textbox", { name: "Room name" });
    await user.clear(roomName);
    await user.type(roomName, "Draft room name");
    await user.click(screen.getByRole("tab", { name: "Agent behavior" }));
    expect(await screen.findByRole("heading", { name: "Summarizer" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByRole("textbox", { name: "Room name" }) as HTMLInputElement).value).toBe("Draft room name");
  });

  it("keeps an Agent behavior draft open when OK is used from General", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
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
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<RoomPropertiesDialog roomName="The Agent Room" topic="Open conversation" conversationEnergy="balanced" disabled={false} returnFocusTo={null} onSave={vi.fn()} onClose={onClose} />);

    await user.click(screen.getByRole("tab", { name: "Agent behavior" }));
    const prompt = await screen.findByLabelText("Prompt", { selector: "textarea" });
    await user.clear(prompt);
    await user.type(prompt, "Draft merit rule");
    await user.click(screen.getByRole("tab", { name: "General" }));
    await user.click(screen.getByRole("button", { name: "OK" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Agent behavior" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("Prompt", { selector: "textarea" }) as HTMLTextAreaElement).value).toBe("Draft merit rule");
  });

  it("retries a failed model catalog request without closing the chooser", async () => {
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
      .mockRejectedValueOnce(new Error("Catalog unavailable"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "available", discoveredAt: "2026-08-30T00:00:00Z", models: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<RoomConfigurationDialog returnFocusTo={null} onClose={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Summarizer" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Choose model…" }));
    expect((await screen.findByRole("alert")).textContent).toContain("connection was interrupted");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][0]).toBe("/api/room/settings/models");
    expect(screen.getByRole("button", { name: "Hide models" })).toBeTruthy();
    expect(await screen.findByText("0 available")).toBeTruthy();
  });
});
