// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contributionGate, loadContribution, loadContributions } from "./api";
import { Contributions } from "./contributions";

vi.mock("./api", () => ({ loadContributions: vi.fn(), loadContribution: vi.fn(), contributionGate: vi.fn() }));
const base = { contributionId: "contribution-1", revision: 2, stage: "REVIEW_ACCEPTED", title: "Reviewed change", description: "Bounded exact work", blockedReason: null, updatedAt: "2026-08-24T20:00:00Z",
  source: { repository: "owner/repo", branch: "amfaa/assignment-one-12345678", baseSha: "a".repeat(40), headSha: "b".repeat(40), taskId: "task", taskRevision: 4, assignmentId: "assignment", assignmentRevision: 2, manifestRevision: 3 },
  review: { reviewerId: "reviewer", decision: "ACCEPTED", summary: "looks good", at: "2026-08-24T20:00:00Z" }, pullRequest: null, merged: null, deployed: null, approvals: [] };

describe("reviewed contribution UI", () => {
  afterEach(() => cleanup());
  beforeEach(() => { vi.mocked(loadContributions).mockResolvedValue({ items: [base] } as never); vi.mocked(loadContribution).mockResolvedValue({ contribution: base, audit: [{ eventId: "event", action: "REVIEW_ACCEPTED", actorId: "reviewer", at: "now", outcome: "ACCEPTED", detail: "looks good", externalResultId: null }] } as never); vi.mocked(contributionGate).mockResolvedValue(base as never); });
  it("distinguishes lifecycle states and keeps approval separate from execution", async () => {
    render(<Contributions />); fireEvent.click(await screen.findByText("Reviewed change"));
    expect(await screen.findByText(/Work completed/)).toBeTruthy(); expect(screen.getAllByText(/Review accepted/).length).toBeGreaterThan(0); expect(screen.getByText(/PR published/)).toBeTruthy(); expect(screen.getByText(/Merged/)).toBeTruthy(); expect(screen.getByText(/Deployed/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve exact publication" })); await waitFor(() => expect(contributionGate).toHaveBeenCalledWith("contribution-1", "approve", "publication", { expectedRevision: 2 }));
    expect(screen.queryByRole("button", { name: /merge approved/i })).toBeNull(); expect(screen.getByText(/amfaa\/assignment/)).toBeTruthy();
  });

  it("renders blocked evidence prominently", async () => {
    const blocked = { ...base, stage: "BLOCKED", blockedReason: "Head changed after review" }; vi.mocked(loadContributions).mockResolvedValue({ items: [blocked] } as never); vi.mocked(loadContribution).mockResolvedValue({ contribution: blocked, audit: [] } as never);
    render(<Contributions />); fireEvent.click(await screen.findByText("Reviewed change")); expect((await screen.findByRole("alert")).textContent).toContain("Head changed after review");
  });
});
