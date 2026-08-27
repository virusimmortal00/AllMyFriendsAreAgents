// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RosterManagerDialog } from "./roster-manager";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const catalog = [
  { agentId: "codex-sol", provider: "codex", displayName: "Codex", modelId: "gpt-5.6-sol", modelLabel: "gpt-5.6 Sol", conversationalName: "Sol", supportsProjectWrites: true },
  { agentId: "claude-opus", provider: "claude", displayName: "Claude", modelId: "claude-opus-5", modelLabel: "Claude Opus 5", conversationalName: "Opus", supportsProjectWrites: true },
] as const;

describe("roster manager", () => {
  it("honors an exact initial agent selection through the existing selected-agent flow", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 4, entries: [{ agentId: "codex-sol", enabled: true }, { agentId: "claude-opus", enabled: true }] }, catalog }), { status: 200 })));

    render(<RosterManagerDialog
      initialRoster={{ revision: 3, entries: [{ agentId: "codex-sol", enabled: true }, { agentId: "claude-opus", enabled: true }] }}
      initialSelectedAgentId="claude-opus"
      returnFocusTo={null}
      onSaved={() => undefined}
      onClose={() => undefined}
    />);

    expect((await screen.findByRole("button", { name: "View Opus configuration" })).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "View Sol configuration" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("switch", { name: "Active in room for Opus" })).toBeTruthy();
  });

  it("submits administrator sign-in when Enter is pressed in the password field", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "authentication required" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ claimed: true, bootstrapConfigured: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ principal: { id: "owner", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "csrf" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 4, entries: [{ agentId: "codex-sol", enabled: true }] }, catalog }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={() => undefined} onClose={() => undefined} />);
    await user.type(await screen.findByRole("textbox", { name: "Username" }), "owner");
    await user.type(screen.getByLabelText("Password"), "valid-password{enter}");

    await screen.findByText("Your agents");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/control/login");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ username: "owner", password: "valid-password" });
  });

  it("saves a model-centric revisioned roster without a harness selector", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 4, entries: [{ agentId: "codex-sol", enabled: true }] }, catalog }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { schemaVersion: 3, revision: 5, entries: [{ agentId: "codex-sol", enabled: false, providerId: "openai", modelId: "gpt-5.6-sol" }] }, catalog }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={onSaved} onClose={() => undefined} />);
    await screen.findByRole("button", { name: "View Sol configuration" });
    expect(screen.getAllByText("GPT 5.6 Sol · via OpenAI").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("OpenAI model").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("switch"));
    expect(screen.queryByLabelText("Harness")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save roster" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 3, revision: 5 })));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ expectedRevision: 4, entries: [{ agentId: "codex-sol", enabled: false }] });
  });

  it("preserves a local draft on conflict and requires loading the latest roster", async () => {
    const latest = { roster: { revision: 7, entries: [{ agentId: "claude-opus", enabled: true }] }, catalog };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 6, entries: [{ agentId: "codex-sol", enabled: true }] }, catalog }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "conflict", kind: "conflict", ...latest }), { status: 409 })));
    const user = userEvent.setup();
    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={() => undefined} onClose={() => undefined} />);
    await screen.findByRole("button", { name: "View Sol configuration" });
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: "Save roster" }));
    expect((await screen.findByRole("alert")).textContent).toContain("draft is preserved");
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Save roster" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Load latest roster" }));
    expect(screen.getByRole("button", { name: "View Opus configuration" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View Sol configuration" })).toBeNull();
    expect(screen.queryByLabelText("Harness")).toBeNull();
  });

  it("treats a matching configured default as available for explicit migration confirmation", async () => {
    const agentId = "agent-88888888-8888-4888-8888-888888888888";
    const entry = { agentId, conversationalName: "Alpha", providerId: "openai", modelId: "configured", enabled: true, supportsProjectWrites: true, configurationRevision: 1, selectionConfirmationRequired: true, sessionInvalidationReason: "Confirm this selection." };
    const discovery = { status: "discovery_unsupported", discoveredAt: new Date(0).toISOString(), models: [], configuredDefault: { providerId: "openai", modelId: "configured" } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { schemaVersion: 3, revision: 1, entries: [entry] }, catalog: [], modelDiscovery: discovery }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ principal: { id: "owner", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "csrf" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { schemaVersion: 3, revision: 2, entries: [{ ...entry, selectionConfirmationRequired: undefined, sessionInvalidationReason: "" }] }, catalog: [], modelDiscovery: discovery }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={() => undefined} onClose={() => undefined} />);
    await screen.findByRole("button", { name: "View Alpha configuration" });
    expect(screen.queryByRole("option", { name: /currently unavailable/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm selected OpenCode model" }));
    await user.click(screen.getByRole("button", { name: "Save roster" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).entries[0]).toMatchObject({ agentId, sessionInvalidationReason: "" });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).entries[0]).not.toHaveProperty("selectionConfirmationRequired");
  });

  it("keeps deactivation reversible and confirms configuration deletion separately", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 4, entries: [{ agentId: "codex-sol", enabled: true }] }, catalog }), { status: 200 })));
    const user = userEvent.setup();
    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={() => undefined} onClose={() => undefined} />);

    await screen.findByRole("button", { name: "View Sol configuration" });
    await user.click(screen.getByRole("switch", { name: "Active in room for Sol" }));
    expect(screen.getAllByText("Deactivated").length).toBeGreaterThanOrEqual(2);

    await user.click(screen.getByRole("button", { name: "Delete agent…" }));
    expect(screen.getByRole("alertdialog", { name: "Delete agent configuration?" })).toBeTruthy();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "View Sol configuration" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Delete agent…" }));
    await user.click(screen.getByRole("button", { name: "Delete configuration" }));
    expect(screen.queryByRole("button", { name: "View Sol configuration" })).toBeNull();
    expect(screen.getByText("Create your first agent")).toBeTruthy();
  });

  it("selects the nearest remaining agent after deleting one configuration", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 4, entries: [{ agentId: "codex-sol", enabled: true }, { agentId: "claude-opus", enabled: true }] }, catalog }), { status: 200 })));
    const user = userEvent.setup();
    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={() => undefined} onClose={() => undefined} />);

    await screen.findByRole("button", { name: "View Sol configuration" });
    await user.click(screen.getByRole("button", { name: "Delete agent…" }));
    await user.click(screen.getByRole("button", { name: "Delete configuration" }));

    expect(screen.queryByRole("button", { name: "View Sol configuration" })).toBeNull();
    expect(screen.getByRole("button", { name: "View Opus configuration" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("switch", { name: "Active in room for Opus" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Choose a model" })).toBeNull();
  });

  it("protects unsaved roster changes when closing the manager", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 4, entries: [{ agentId: "codex-sol", enabled: true }] }, catalog }), { status: 200 })));
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={() => undefined} onClose={onClose} />);

    await screen.findByRole("button", { name: "View Sol configuration" });
    await user.click(screen.getByRole("switch", { name: "Active in room for Sol" }));
    await user.keyboard("{Escape}");

    const confirmation = screen.getByRole("alertdialog", { name: "Discard roster changes?" });
    expect(onClose).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Unsaved roster changes")).toBeTruthy();
    expect((screen.getByRole("switch", { name: "Active in room for Sol" }) as HTMLInputElement).checked).toBe(false);

    await user.click(screen.getByRole("button", { name: "Close roster manager" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("guides an empty room from model choice to a reviewable roster draft", async () => {
    const discovery = {
      status: "available",
      discoveredAt: new Date(0).toISOString(),
      models: [{
        providerId: "openrouter",
        modelId: "google/gemini-3.7-flash",
        displayName: "Gemini 3.7 Flash",
        description: "Fast multimodal model",
        authorId: "google",
        authorDisplayName: "Google",
        accessProviderDisplayName: "OpenRouter",
        pricing: { inputPerMillion: 0.375, outputPerMillion: 1.875 },
        variants: [{ id: "low", displayName: "low" }, { id: "high", displayName: "high" }],
        capabilities: { reasoning: true, toolCall: true, reasoningEffort: ["low", "high"] },
        provenance: "opencode-catalog",
      }],
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 4, entries: [] }, catalog: [], modelDiscovery: discovery }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ principal: { id: "owner", username: "owner", role: "OWNER", capabilities: [], revision: 1 }, csrfToken: "csrf" }), { status: 200 })));
    const user = userEvent.setup();

    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={() => undefined} onClose={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "Choose a model" })).toBeTruthy();
    expect(screen.getByText("Create your first agent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Explore models/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Gemini 3.7 Flash/ }));
    expect(screen.getByRole("heading", { name: "Create your agent" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Variant / reasoning effort" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Search models" })).toBeNull();
    const alias = screen.getByRole("textbox", { name: "Agent alias" });
    expect(document.activeElement).toBe(alias);
    await user.type(alias, "Scout{enter}");

    expect(screen.getByRole("button", { name: "View Scout configuration" })).toBeTruthy();
    expect(screen.getByText("Scout is ready in this draft.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "＋ Add another agent" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "＋ Add another agent" }));
    expect(screen.getByRole("heading", { name: "Choose a model" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "← Back to your agents" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Gemini 3.7 Flash/ }));
    const duplicateAlias = screen.getByRole("textbox", { name: "Agent alias" });
    await user.type(duplicateAlias, "Scout");
    await user.click(screen.getByRole("button", { name: "Add agent to roster draft" }));
    expect(screen.getByRole("alert").textContent).toContain("aliases must be unique");
    await user.type(duplicateAlias, " 2");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(duplicateAlias.getAttribute("aria-invalid")).toBe("false");
  });

  it("retains the last valid roster revision when a refresh projection omits it", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { entries: [{ agentId: "codex-sol", enabled: true }] }, catalog }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { schemaVersion: 3, revision: 10, entries: [{ agentId: "codex-sol", enabled: false }] }, catalog }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<RosterManagerDialog initialRoster={{ schemaVersion: 3, revision: 9, entries: [] }} returnFocusTo={null} onSaved={() => undefined} onClose={() => undefined} />);
    await screen.findByRole("button", { name: "View Sol configuration" });
    expect((screen.getByRole("button", { name: "Save roster" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("switch", { name: "Active in room for Sol" }));
    expect(screen.getByText("Unsaved roster changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save roster" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ expectedRevision: 9, entries: [{ agentId: "codex-sol", enabled: false }] });
  });
});
