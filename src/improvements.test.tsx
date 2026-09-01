// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Improvements, ImprovementsMenuControl, improvementsRoute, resolveImprovementsAlias } from "./improvements";
import { emergencyStopHeartbeat, loadHeartbeat, loadImprovement, loadImprovements } from "./api";

vi.mock("./api", () => ({
  loadImprovements: vi.fn(async (scope: string) => ({ scope, items: [{ canonicalId: "known-id", revisionLabel: "r2", state: "IN_PROGRESS", risk: "GUARDED", updatedAt: "2026-08-21T12:00:00Z" }] })),
  loadImprovement: vi.fn(async () => ({ canonicalId: "known-id", revisionLabel: "r2", state: "IN_PROGRESS", risk: "GUARDED", updatedAt: "2026-08-21T12:00:00Z", status: { schemaVersion: 1, implementation: { state: "IMPLEMENTED", codeLocation: { immutableRevision: "abc", repository: "repo", branch: "main", worktree: null } }, deployment: { state: "DEPLOYED", generation: "g1", environment: "test" }, developerTeamEvidence: { state: "AVAILABLE", evidence: [{ id: "e1", uri: "https://example.test/e1" }] }, independentAcceptance: { state: "ACCEPTED", assessedBy: "QA", assessedAt: "2026-08-21T12:00:00Z", evidence: [{ id: "e2", uri: "https://example.test/e2" }] }, upstreamPublication: { state: "UNPUBLISHED" }, nextAction: { state: "ACTION_REQUIRED", action: "Review" } }, evidence: [{ id: "e1", introducedRevision: 2, revisionLabel: "r2", sourceClass: "DEVELOPER_TEAM", kind: "test", uri: "https://example.test/e1", summary: "Passing test", recordedAt: "2026-08-21T12:00:00Z" }], revisions: [], milestones: [{ id: "m1", introducedRevision: 2, revisionLabel: "r2", state: "ACHIEVED", summary: "UI complete", recordedAt: "2026-08-21T12:00:00Z" }] })),
  loadHeartbeat: vi.fn(async () => ({ configured: true, active: false, runtime: { revision: 0, enabled: false, emergencyStopped: false, changedBy: null, changedAt: null, reason: null }, policy: { version: "heartbeat-policy-v1", cadenceMs: 30000, maxConcurrency: 1, maxSelectedPerRun: 5, maxDispatchedPerRun: 2, maxAttemptsPerRevision: 3, retryAfterMs: 120000, timeBudgetMs: 60000, permittedCapabilities: ["ANALYZE", "EDIT_SANDBOX", "RUN_TESTS"], prohibitedCapabilities: ["COMMIT"], eligibleStates: ["APPROVED", "IN_PROGRESS"], governedProposalRequired: true }, audit: [] })),
  authorizeHeartbeat: vi.fn(async () => ({ configured: true, active: false, runtime: { revision: 1, enabled: true, emergencyStopped: false }, policy: { version: "heartbeat-policy-v1", cadenceMs: 30000, maxConcurrency: 1, maxAttemptsPerRevision: 3, timeBudgetMs: 60000, permittedCapabilities: [] }, audit: [] })),
  emergencyStopHeartbeat: vi.fn(async () => ({ configured: true, active: false, runtime: { revision: 1, enabled: false, emergencyStopped: true }, policy: { version: "heartbeat-policy-v1", cadenceMs: 30000, maxConcurrency: 1, maxAttemptsPerRevision: 3, timeBudgetMs: 60000, permittedCapabilities: [] }, audit: [] })),
}));

afterEach(() => cleanup());

describe("Improvements interface", () => {
  it("switches Active and All list views with mobile-ready tab controls", async () => {
    const user = userEvent.setup(); const navigate = vi.fn();
    render(<Improvements route={{ view: "list", scope: "active" }} onNavigate={navigate} />);
    await waitFor(() => expect(screen.getByText("known-id")).toBeTruthy());
    expect(screen.getByText("1 active improvement shown")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Active" }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("tab", { name: "All" }));
    expect(navigate).toHaveBeenCalledWith({ view: "list", scope: "all" });
  });

  it("uses arrow keys, Home, and End for roving Improvements tabs", async () => {
    const user = userEvent.setup(); const navigate = vi.fn();
    render(<Improvements route={{ view: "list", scope: "active" }} onNavigate={navigate} />);
    const active = screen.getByRole("tab", { name: "Active" });
    const all = screen.getByRole("tab", { name: "All" });
    active.focus();
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(all);
    expect(navigate).toHaveBeenLastCalledWith({ view: "list", scope: "all" });
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(active);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(all);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(active);
  });

  it("confirms emergency stop, cancels safely, and records only an explicit confirmed action", async () => {
    const user = userEvent.setup();
    render(<Improvements route={{ view: "list", scope: "active" }} onNavigate={() => undefined} />);
    const stop = await screen.findByRole("button", { name: "Emergency stop heartbeat" });
    await user.click(stop);
    const dialog = screen.getByRole("alertdialog", { name: "Emergency stop heartbeat?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(emergencyStopHeartbeat).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(stop);
    expect(emergencyStopHeartbeat).not.toHaveBeenCalled();
    await user.click(stop);
    await user.click(within(screen.getByRole("alertdialog", { name: "Emergency stop heartbeat?" })).getByRole("button", { name: "Emergency stop heartbeat" }));
    await waitFor(() => expect(screen.getByText("EMERGENCY STOPPED")).toBeTruthy());
    expect(emergencyStopHeartbeat).toHaveBeenCalledOnce();
    expect(stop.hasAttribute("disabled")).toBe(true);
  });

  it("reports an unavailable heartbeat and can reload it", async () => {
    const user = userEvent.setup();
    vi.mocked(loadHeartbeat).mockRejectedValueOnce(new Error("Heartbeat connection failed"));
    render(<Improvements route={{ view: "list", scope: "active" }} onNavigate={() => undefined} />);
    expect(await screen.findByRole("button", { name: "Try heartbeat again" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try heartbeat again" }));
    expect(await screen.findByRole("button", { name: "Emergency stop heartbeat" })).toBeTruthy();
    expect(screen.queryByText(/Heartbeat controls are unavailable/)).toBeNull();
  });

  it("shows canonical identity, all six status fields, qualified evidence, and milestones", async () => {
    render(<Improvements route={{ view: "detail", id: "known-id" }} onNavigate={() => undefined} />);
    await waitFor(() => expect(screen.getByText("Canonical ID:")).toBeTruthy());
    expect(screen.getByText("Implementation")).toBeTruthy(); expect(screen.getByText("Deployment")).toBeTruthy();
    expect(screen.getByText("Developer team evidence")).toBeTruthy(); expect(screen.getByText("Independent acceptance")).toBeTruthy();
    expect(screen.getByText("Upstream publication")).toBeTruthy(); expect(screen.getByText("Next action")).toBeTruthy();
    expect(screen.getByText("Passing test")).toBeTruthy(); expect(screen.getByText(/UI complete/)).toBeTruthy();
    expect(screen.getByText("Immutable Revision")).toBeTruthy();
    expect(screen.getByText("Repository")).toBeTruthy();
    expect(screen.getByText("repo")).toBeTruthy();
    expect(screen.getByText("https://example.test/e2")).toBeTruthy();
    expect(screen.queryByText(/\{"immutableRevision"/)).toBeNull();
    expect(screen.getByRole("link", { name: "Permanent link to this improvement" }).getAttribute("href")).toBe("/improvements/known-id");
  });

  it("gives stale links a way back to both lists", async () => {
    const user = userEvent.setup(); const navigate = vi.fn();
    render(<Improvements route={{ view: "missing", id: "gone" }} onNavigate={navigate} />);
    expect(screen.queryByRole("region", { name: "Bounded heartbeat controls" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "View Active improvements" }));
    await user.click(screen.getByRole("button", { name: "View All improvements" }));
    expect(navigate).toHaveBeenNthCalledWith(1, { view: "list", scope: "active" });
    expect(navigate).toHaveBeenNthCalledWith(2, { view: "list", scope: "all" });
  });

  it("turns a direct detail 404 into missing guidance", async () => {
    const navigate = vi.fn();
    vi.mocked(loadImprovement).mockRejectedValueOnce(Object.assign(new Error("Improvement not found"), { status: 404 }));
    render(<Improvements route={{ view: "detail", id: "gone" }} onNavigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "missing", id: "gone" }));
  });

  it("distinguishes a load failure from an empty list and offers a retry", async () => {
    const user = userEvent.setup();
    vi.mocked(loadImprovements).mockRejectedValueOnce(new Error("Connection interrupted"));
    render(<Improvements route={{ view: "list", scope: "active" }} onNavigate={() => undefined} />);
    expect(await screen.findByRole("heading", { name: "Could not load improvements" })).toBeTruthy();
    expect(screen.queryByText("No improvements are available in this view.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("known-id")).toBeTruthy();
  });

  it("recognizes only formal Improvements paths; hashes remain aliases to verify", () => {
    window.history.replaceState({}, "", "/improvements/known-id");
    expect(improvementsRoute()).toEqual({ view: "detail", id: "known-id" });
    window.history.replaceState({}, "", "/#unknown-id");
    expect(improvementsRoute()).toBeNull();
  });

  it("verifies known hash aliases exactly and never creates or redirects unknown aliases", async () => {
    const read = vi.fn(async (id: string) => ({ canonicalId: id }));
    await expect(resolveImprovementsAlias("known-id", read)).resolves.toEqual({ view: "detail", id: "known-id" });
    expect(read).toHaveBeenCalledWith("known-id");
    await expect(resolveImprovementsAlias("unknown-id", async () => { throw new Error("404"); })).resolves.toEqual({ view: "missing", id: "unknown-id" });
    await expect(resolveImprovementsAlias("alias", async () => ({ canonicalId: "different-id" }))).resolves.toEqual({ view: "missing", id: "alias" });
  });

  it.each([1024, 390])("offers the exact Improvements control at %ipx", async (width) => {
    const user = userEvent.setup(); const onOpen = vi.fn();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    render(<ImprovementsMenuControl onOpen={onOpen} />);
    await user.click(screen.getByRole("button", { name: "Improvements" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("keeps its label stable and exposes the active destination semantically", async () => {
    const user = userEvent.setup(); const onOpen = vi.fn();
    render(<ImprovementsMenuControl active onOpen={onOpen} />);
    const control = screen.getByRole("button", { name: "Improvements" });
    expect(control.getAttribute("aria-current")).toBe("page");
    await user.click(control);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
