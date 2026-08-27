import { describe, expect, it } from "vitest";
import { validCommandReassignment, validPoll, validSubmission } from "./command-storage.js";

describe("command storage validation", () => {
  const createdAt = "2026-08-27T12:00:00.000Z";
  const submission = { submissionId: "submission", roomId: "room", clientSubmissionId: "client", command: "task" as const, invocation: { command: "task" as const, prompt: "work", selection: { kind: "round-robin" as const } }, invoker: { kind: "human" as const, id: "human", displayName: "Ada" }, createdAt };

  it("requires persisted display names and poll timestamps", () => {
    expect(validSubmission(submission)).toBe(true);
    expect(validSubmission({ ...submission, invoker: { ...submission.invoker, displayName: "" } })).toBe(false);
    expect(validPoll({ pollId: "poll", roomId: "room", submissionId: "submission", question: "Choose", options: ["A", "B"], createdAt })).toBe(true);
    expect(validPoll({ pollId: "poll", roomId: "room", submissionId: "submission", question: "Choose", options: ["A", "B"], createdAt: "" })).toBe(false);
  });

  it("rejects a malformed reassignment without dereferencing a missing pointer", () => {
    const current = { attemptId: "one", roomId: "room", submissionId: "submission", attempt: 1, agentId: "codex-sol" as const, generationId: null, status: "superseded" as const, reason: "stalled", createdAt, updatedAt: "2026-08-27T12:01:00.000Z" };
    const next = { ...current, attemptId: "two", attempt: 2, status: "queued" as const, reason: null };
    expect(() => validCommandReassignment({ expectedUpdatedAt: createdAt, current, next } as never)).not.toThrow();
    expect(validCommandReassignment({ expectedUpdatedAt: createdAt, current, next } as never)).toBe(false);
  });
});
