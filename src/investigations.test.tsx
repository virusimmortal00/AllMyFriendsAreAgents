// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeInvestigationInbox, investigationAction, loadInvestigationInbox, loadInvestigations, setInvestigationPolicy } from "./api";
import { Investigations } from "./investigations";

vi.mock("./api", () => ({
  loadInvestigations: vi.fn(async () => ({ policy: { revision: 2, enabled: true, policyVersion: "investigation-policy-v1", maxConcurrentGlobal: 2, updatedAt: "2026-08-25T00:00:00Z", defaultBudget: { timeMs: 60_000, tokenLimit: 6_000, toolCallLimit: 16, retryLimit: 1 } }, jobs: [{ investigationId: "investigation-1", revision: 4, owner: "codex-sol", objective: "Corroborate identity mismatch", trigger: "Unexpected label", signal: "AGENT_DECISION", evidenceRefs: [], status: "CHECKPOINTED", usage: { elapsedMs: 20, tokens: 3, toolCalls: 1, attempts: 1 }, providerSessionEstablished: true, checkpoint: { attempt: 1, summary: "Checked the mapping", createdAt: "2026-08-25T00:00:00Z" }, resultSummary: null, unresolvedQuestions: [], resultWaiting: false, blocker: "Ready to resume", createdAt: "2026-08-25T00:00:00Z", updatedAt: "2026-08-25T00:00:00Z", completedAt: null }] })),
  loadInvestigationInbox: vi.fn(async () => [{ inboxEntryId: "inbox-1", revision: 1, investigationId: "investigation-1", owner: "codex-sol", status: "UNREAD", summary: "Bounded finding", evidenceRefs: [], unresolvedQuestions: ["One question"], createdAt: "2026-08-25T00:00:00Z", updatedAt: "2026-08-25T00:00:00Z", expiresAt: "2026-09-01T00:00:00Z" }]),
  setInvestigationPolicy: vi.fn(async () => ({})), investigationAction: vi.fn(async () => ({})), acknowledgeInvestigationInbox: vi.fn(async () => ({})),
}));

describe("investigation visibility and controls", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);
  it("shows bounded state and exposes policy, cancel, resume, acknowledge, and close controls", async () => {
    render(<Investigations refreshKey={0} />); await screen.findByText(/Corroborate identity mismatch/); expect(screen.getByText(/Checked the mapping/)).toBeTruthy(); expect(screen.getByText(/Bounded finding/)).toBeTruthy(); fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(screen.getByRole("button", { name: "Cancel" })); fireEvent.click(screen.getByRole("button", { name: "Resume" })); fireEvent.click(screen.getByRole("button", { name: "Acknowledge" })); fireEvent.click(screen.getByRole("button", { name: "Close" })); await waitFor(() => { expect(setInvestigationPolicy).toHaveBeenCalledWith(2, false); expect(investigationAction).toHaveBeenCalledWith("investigation-1", "cancel"); expect(investigationAction).toHaveBeenCalledWith("investigation-1", "resume"); expect(acknowledgeInvestigationInbox).toHaveBeenCalledWith("inbox-1", false); expect(acknowledgeInvestigationInbox).toHaveBeenCalledWith("inbox-1", true); }); expect(loadInvestigations).toHaveBeenCalled(); expect(loadInvestigationInbox).toHaveBeenCalledWith("codex-sol", expect.any(AbortSignal));
  });
});
