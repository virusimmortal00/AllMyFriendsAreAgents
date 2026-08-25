// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RosterManagerDialog } from "./roster-manager";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const catalog = [
  { agentId: "codex-sol", provider: "codex", displayName: "Codex", modelId: "gpt-5.6-sol", modelLabel: "gpt-5.6 Sol", conversationalName: "Sol", supportsProjectWrites: true },
  { agentId: "claude-opus", provider: "claude", displayName: "Claude", modelId: "claude-opus-5", modelLabel: "Claude Opus 5", conversationalName: "Opus", supportsProjectWrites: true },
] as const;

describe("roster manager", () => {
  it("saves a model-centric revisioned roster without a harness selector", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 4, entries: [{ agentId: "codex-sol", enabled: true }] }, catalog }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { schemaVersion: 3, revision: 5, entries: [{ agentId: "codex-sol", enabled: false, providerId: "openai", modelId: "gpt-5.6-sol" }] }, catalog }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={onSaved} onClose={() => undefined} />);
    await screen.findByText("Sol");
    await user.click(screen.getByRole("checkbox"));
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
    await screen.findByText("Sol");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save roster" }));
    expect((await screen.findByRole("alert")).textContent).toContain("draft is preserved");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Save roster" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Load latest roster" }));
    expect(screen.getByText("Opus")).toBeTruthy();
    expect(screen.queryByText("Sol")).toBeNull();
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
    await screen.findByText("Alpha");
    await user.click(screen.getByText("Edit configuration"));
    expect(screen.queryByRole("option", { name: /currently unavailable/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Confirm selected OpenCode model" }));
    await user.click(screen.getByRole("button", { name: "Save roster" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).entries[0]).toMatchObject({ agentId, sessionInvalidationReason: "" });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).entries[0]).not.toHaveProperty("selectionConfirmationRequired");
  });
});
