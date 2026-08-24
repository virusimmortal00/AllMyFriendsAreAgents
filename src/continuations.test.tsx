// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acknowledgeContinuationInbox, continuationAction, loadContinuationInbox, loadContinuations, setContinuationPolicy } from "./api";
import { Continuations, ContinuationsMenuControl } from "./continuations";

vi.mock("./api", async (original) => { const actual = await original<typeof import("./api")>(); return { ...actual,
  loadContinuations: vi.fn(async () => ({ policy: { revision: 2, enabled: true, policyVersion: "continuation-policy-v1", updatedAt: "2026-08-24T12:00:00Z", defaultBudget: { timeMs: 1000, tokenLimit: 10, toolCallLimit: 2, retryLimit: 1 } }, jobs: [{ jobId: "job-1", jobRevision: 3, owner: "codex-sol", task: { roomId: "room", taskId: "task-1" }, taskRevision: 5, assignmentId: "assignment-1", objective: "Finish bounded work", trigger: "Explicit request", status: "BLOCKED", resultDisposition: "PENDING", resultSummary: null, blocker: "Waiting for retry", nextEligibilityAt: null, updatedAt: "2026-08-24T12:00:00Z", usage: { elapsedMs: 50, tokens: 2, toolCalls: 1, attempts: 1 } }] })),
  loadContinuationInbox: vi.fn(async () => [{ inboxEntryId: "inbox-1", inboxRevision: 1, owner: "codex-sol", jobId: "job-1", task: { taskId: "task-1" }, assignmentId: "assignment-1", status: "UNREAD", summary: "A bounded public result", createdAt: "2026-08-24T12:00:00Z", expiresAt: "2026-08-25T12:00:00Z" }]),
  setContinuationPolicy: vi.fn(async () => ({})), continuationAction: vi.fn(async () => ({})), acknowledgeContinuationInbox: vi.fn(async () => ({})) }; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("continuation status and inbox UI", () => {
  it("is discoverable and exposes responsive human policy, cancel/resume, ack, and close controls", async () => {
    const user = userEvent.setup(); const onOpen = vi.fn(); render(<ContinuationsMenuControl active={false} onOpen={onOpen} />); await user.click(screen.getByRole("button", { name: "Continuations" })); expect(onOpen).toHaveBeenCalledOnce(); cleanup();
    render(<Continuations refreshKey={0} />); expect(await screen.findByText(/Finish bounded work/)).toBeTruthy(); expect(screen.getByText("A bounded public result")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: "Initiative enabled" })); await user.click(screen.getByRole("button", { name: "Cancel" })); await user.click(screen.getByRole("button", { name: "Resume" })); await user.click(screen.getByRole("button", { name: "Acknowledge" })); await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => { expect(setContinuationPolicy).toHaveBeenCalledWith(2, false); expect(continuationAction).toHaveBeenCalledWith("job-1", "cancel"); expect(continuationAction).toHaveBeenCalledWith("job-1", "resume"); expect(acknowledgeContinuationInbox).toHaveBeenCalledWith("inbox-1", false); expect(acknowledgeContinuationInbox).toHaveBeenCalledWith("inbox-1", true); });
    expect(loadContinuations).toHaveBeenCalled(); expect(loadContinuationInbox).toHaveBeenCalledWith("codex-sol");
  });
});
