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
  it("adds a catalog agent and saves an ordered revisioned roster", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 4, entries: [{ agentId: "codex-sol", enabled: true }] }, catalog }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 5, entries: [{ agentId: "codex-sol", enabled: false }, { agentId: "claude-opus", enabled: true }] }, catalog }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={onSaved} onClose={() => undefined} />);
    await screen.findByText("Sol");
    await user.click(screen.getByRole("checkbox"));
    await user.selectOptions(screen.getByLabelText("Add a supported agent"), "claude-opus");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Save roster" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ revision: 5, entries: [{ agentId: "codex-sol", enabled: false }, { agentId: "claude-opus", enabled: true }] }));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ expectedRevision: 4, entries: [{ agentId: "codex-sol", enabled: false }, { agentId: "claude-opus", enabled: true }] });
  });

  it("preserves a local draft on conflict and requires loading the latest roster", async () => {
    const latest = { roster: { revision: 7, entries: [{ agentId: "claude-opus", enabled: true }] }, catalog };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ roster: { revision: 6, entries: [{ agentId: "codex-sol", enabled: true }] }, catalog }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "conflict", kind: "conflict", ...latest }), { status: 409 })));
    const user = userEvent.setup();
    render(<RosterManagerDialog initialRoster={{ revision: 1, entries: [] }} returnFocusTo={null} onSaved={() => undefined} onClose={() => undefined} />);
    await screen.findByText("Sol");
    await user.selectOptions(screen.getByLabelText("Add a supported agent"), "claude-opus");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Save roster" }));
    expect((await screen.findByRole("alert")).textContent).toContain("draft is preserved");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Save roster" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Load latest roster" }));
    expect(screen.getByText("Opus")).toBeTruthy();
    expect(screen.queryByText("Sol")).toBeNull();
    expect((screen.getByLabelText("Add a supported agent") as HTMLSelectElement).value).toBe("");
  });
});
