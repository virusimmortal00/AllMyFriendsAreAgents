// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARTICIPANT_STYLES } from "../shared/chat-style";
import type { RoomAgentRoster } from "../shared/roster";
import { RoomRoster } from "./components";

const roster: RoomAgentRoster = {
  schemaVersion: 3,
  revision: 8,
  entries: [
    { agentId: "codex-sol", conversationalName: "Meta Muse Spark 1.2 With A Very Long Alias", providerId: "openai", modelId: "gpt-5.6-sol", enabled: true },
    { agentId: "claude-opus", conversationalName: "Opus", providerId: "anthropic", modelId: "claude-opus-5", enabled: true },
  ],
};

afterEach(cleanup);

function renderRoster(onManageRoster = vi.fn()) {
  const view = render(<RoomRoster
    roster={roster}
    agents={["codex-sol", "claude-opus"]}
    activeAgents={new Set(["codex-sol"])}
    humans={[]}
    currentHumanId="alice-id"
    onManageRoster={onManageRoster}
  />);
  return { ...view, onManageRoster };
}

describe("presence roster rows", () => {
  it("keeps the same fixed row structure while preserving the active highlight and equalizer", () => {
    const { container } = renderRoster();
    const activeRow = screen.getByRole("button", { name: /Configure Meta Muse Spark 1\.2 With A Very Long Alias:/ });
    const inactiveRow = screen.getByRole("button", { name: /Configure Opus:/ });

    expect(activeRow.className).toContain("presence-row--active");
    expect(inactiveRow.className).not.toContain("presence-row--active");
    expect(activeRow.children).toHaveLength(4);
    expect(inactiveRow.children).toHaveLength(4);
    expect(activeRow.querySelectorAll(".agent-activity-indicator i")).toHaveLength(3);
    expect(inactiveRow.querySelector(".agent-activity-indicator")).toBeNull();
    expect(activeRow.querySelector(".presence-agent-actions")).toBeTruthy();
    expect(inactiveRow.querySelector(".presence-agent-actions")).toBeTruthy();
    expect(screen.queryByText("Generating a response…")).toBeNull();
    expect(container.querySelector(".presence-activity-label")).toBeNull();
    expect(container.querySelector(".agent-settings-button")).toBeNull();
  });

  it("keeps provider health copy alongside the model subtitle without adding a row line", () => {
    render(<RoomRoster
      roster={roster}
      agents={["claude-opus"]}
      agentHealth={{
        "claude-opus": {
          status: "cooldown",
          reason: "rate_limit",
          message: "Provider usage limit reached.",
          since: "2026-08-27T12:00:00.000Z",
        },
      }}
      humans={[]}
      currentHumanId="alice-id"
      onManageRoster={() => undefined}
    />);

    const row = screen.getByRole("button", { name: /Configure Opus:/ });
    const meta = row.querySelector(".presence-meta");
    expect(meta?.querySelector(".presence-model-label")?.textContent).toContain("Claude Opus 5");
    expect(meta?.querySelector(".presence-health")?.textContent).toBe("Cooling down");
    expect(meta?.querySelector(".presence-health")?.getAttribute("title")).toBe("Cooling down");
    expect(row.children).toHaveLength(4);
  });

  it("keeps the full long-alias tooltip on the single-line name hook", () => {
    renderRoster();
    const name = screen.getByText("Meta Muse Spark 1.2 With A Very Long Alias");

    expect(name.className).toContain("speaker");
    expect(name.getAttribute("title")).toBe("Meta Muse Spark 1.2 With A Very Long Alias");
  });

  it("opens an exact agent only on double-click or Enter/Space keyboard activation", async () => {
    const onManageRoster = vi.fn();
    const user = userEvent.setup();
    renderRoster(onManageRoster);
    const row = screen.getByRole("button", { name: /Configure Opus:/ });

    await user.click(row);
    expect(onManageRoster).not.toHaveBeenCalled();

    await user.dblClick(row);
    expect(onManageRoster).toHaveBeenLastCalledWith(row, "claude-opus");
    expect(document.activeElement).toBe(row);

    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onManageRoster).toHaveBeenLastCalledWith(row, "claude-opus");

    const spaceAllowed = fireEvent.keyDown(row, { key: " ", code: "Space" });
    expect(spaceAllowed).toBe(false);
    expect(onManageRoster).toHaveBeenLastCalledWith(row, "claude-opus");
    expect(onManageRoster).toHaveBeenCalledTimes(3);
  });

  it("keeps footer opening selection-neutral and human presence rows non-configurable", async () => {
    const onManageRoster = vi.fn();
    const user = userEvent.setup();
    render(<RoomRoster
      roster={roster}
      agents={["codex-sol"]}
      humans={[{ id: "alice-id", name: "Alice", style: DEFAULT_PARTICIPANT_STYLES.you }]}
      currentHumanId="alice-id"
      onManageRoster={onManageRoster}
    />);

    const humanRow = screen.getByText("Alice (You)").closest(".presence-row");
    expect(humanRow?.getAttribute("role")).toBe("listitem");
    expect(humanRow?.hasAttribute("tabindex")).toBe(false);

    const footer = screen.getByRole("button", { name: "Manage agents..." });
    await user.click(footer);
    expect(onManageRoster).toHaveBeenCalledOnce();
    expect(onManageRoster).toHaveBeenCalledWith(footer);
  });

  it("does not expose agent presence as a control without a configuration entry point", () => {
    render(<RoomRoster agents={["codex-sol"]} humans={[]} currentHumanId="alice-id" />);
    const row = screen.getByText("Sol").closest(".presence-row");

    expect(row?.getAttribute("role")).toBe("listitem");
    expect(row?.hasAttribute("tabindex")).toBe(false);
    expect(screen.queryByRole("button", { name: /Configure Sol/ })).toBeNull();
  });
});
