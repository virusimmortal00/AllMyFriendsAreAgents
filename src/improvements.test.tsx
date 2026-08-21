// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Improvements, improvementsRoute } from "./improvements";

vi.mock("./api", () => ({
  loadImprovements: vi.fn(async (scope: string) => ({ scope, items: [{ canonicalId: "known-id", revisionLabel: "r2", state: "IN_PROGRESS", risk: "GUARDED", updatedAt: "2026-08-21T12:00:00Z" }] })),
  loadImprovement: vi.fn(async () => ({ canonicalId: "known-id", revisionLabel: "r2", state: "IN_PROGRESS", risk: "GUARDED", updatedAt: "2026-08-21T12:00:00Z", status: { schemaVersion: 1, implementation: { state: "IMPLEMENTED", codeLocation: { immutableRevision: "abc", repository: "repo", branch: "main", worktree: null } }, deployment: { state: "DEPLOYED", generation: "g1", environment: "test" }, developerTeamEvidence: { state: "AVAILABLE", evidence: [{ id: "e1", uri: "https://example.test/e1" }] }, independentAcceptance: { state: "ACCEPTED", assessedBy: "QA", assessedAt: "2026-08-21T12:00:00Z", evidence: [{ id: "e2", uri: "https://example.test/e2" }] }, upstreamPublication: { state: "UNPUBLISHED" }, nextAction: { state: "ACTION_REQUIRED", action: "Review" } }, evidence: [{ id: "e1", introducedRevision: 2, revisionLabel: "r2", sourceClass: "DEVELOPER_TEAM", kind: "test", uri: "https://example.test/e1", summary: "Passing test", recordedAt: "2026-08-21T12:00:00Z" }], revisions: [], milestones: [{ id: "m1", introducedRevision: 2, revisionLabel: "r2", state: "ACHIEVED", summary: "UI complete", recordedAt: "2026-08-21T12:00:00Z" }] })),
}));

afterEach(() => cleanup());

describe("Improvements interface", () => {
  it("switches Active and All list views with mobile-ready tab controls", async () => {
    const user = userEvent.setup(); const navigate = vi.fn();
    render(<Improvements route={{ view: "list", scope: "active" }} onNavigate={navigate} />);
    await waitFor(() => expect(screen.getByText("known-id")).toBeTruthy());
    expect(screen.getByRole("tab", { name: "Active" }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: "All" }));
    expect(navigate).toHaveBeenCalledWith({ view: "list", scope: "all" });
  });

  it("shows canonical identity, all six status fields, qualified evidence, and milestones", async () => {
    render(<Improvements route={{ view: "detail", id: "known-id" }} onNavigate={() => undefined} />);
    await waitFor(() => expect(screen.getByText("Canonical ID:")).toBeTruthy());
    expect(screen.getByText("Implementation")).toBeTruthy(); expect(screen.getByText("Deployment")).toBeTruthy();
    expect(screen.getByText("Developer team evidence")).toBeTruthy(); expect(screen.getByText("Independent acceptance")).toBeTruthy();
    expect(screen.getByText("Upstream publication")).toBeTruthy(); expect(screen.getByText("Next action")).toBeTruthy();
    expect(screen.getByText("Passing test")).toBeTruthy(); expect(screen.getByText(/UI complete/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Permanent link to this improvement" }).getAttribute("href")).toBe("/improvements/known-id");
  });

  it("gives stale links a way back to both lists", async () => {
    const user = userEvent.setup(); const navigate = vi.fn();
    render(<Improvements route={{ view: "missing", id: "gone" }} onNavigate={navigate} />);
    await user.click(screen.getByRole("button", { name: "View Active improvements" }));
    await user.click(screen.getByRole("button", { name: "View All improvements" }));
    expect(navigate).toHaveBeenNthCalledWith(1, { view: "list", scope: "active" });
    expect(navigate).toHaveBeenNthCalledWith(2, { view: "list", scope: "all" });
  });

  it("recognizes only formal Improvements paths; hashes remain aliases to verify", () => {
    window.history.replaceState({}, "", "/improvements/known-id");
    expect(improvementsRoute()).toEqual({ view: "detail", id: "known-id" });
    window.history.replaceState({}, "", "/#unknown-id");
    expect(improvementsRoute()).toBeNull();
  });
});
