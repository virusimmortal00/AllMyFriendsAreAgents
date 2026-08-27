// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PollCards } from "./components";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("actionable room polls", () => {
  it("shows the recorded choice, preserves settled errors, and requires confirmation before closure", async () => {
    const user = userEvent.setup();
    const onVote = vi.fn();
    const onClose = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<PollCards
      polls={[
        {
          pollId: "poll-open",
          question: "Choose a path",
          options: ["A", "B"],
          tallies: [1, 2],
          totalVotes: 3,
          state: "OPEN",
          revision: 4,
          closedAt: null,
          ownVote: 1,
          canClose: true,
        },
        {
          pollId: "poll-closed",
          question: "Finished poll",
          options: ["Yes", "No"],
          tallies: [2, 0],
          totalVotes: 2,
          state: "CLOSED",
          revision: 6,
          closedAt: "2026-08-27T12:00:00.000Z",
          ownVote: null,
          canClose: false,
        },
      ]}
      error="The poll changed before it could be ended."
      onVote={onVote}
      onClose={onClose}
    />);

    expect(screen.getByRole("button", { name: "Recorded choice: B" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("The poll changed before it could be ended.");
    expect(screen.queryByText("Finished poll")).toBeNull();

    const close = screen.getByRole("button", { name: "End poll" });
    await user.click(close);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(close);
    expect(onClose).toHaveBeenCalledWith("poll-open", 4);
  });
});
