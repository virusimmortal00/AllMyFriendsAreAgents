import { describe, expect, it } from "vitest";
import { normalizeJsonCommandState, validCommandReassignment, validPoll, validSubmission } from "./command-storage.js";

describe("command storage validation", () => {
  const createdAt = "2026-08-27T12:00:00.000Z";
  const submission = { submissionId: "submission", roomId: "room", clientSubmissionId: "client", command: "task" as const, invocation: { command: "task" as const, prompt: "work", selection: { kind: "round-robin" as const } }, invoker: { kind: "human" as const, id: "human", displayName: "Ada" }, createdAt };
  const poll={pollId:"poll",roomId:"room",submissionId:"submission",question:"Choose",options:["A","B"] as [string,string],creatorKind:"human" as const,creatorId:"human",state:"OPEN" as const,revision:1,closedAt:null,closerKind:null,closerId:null,closeMutationId:null,finalTallies:null,finalTotalVotes:null,createdAt};

  it("requires persisted display names and poll timestamps", () => {
    expect(validSubmission(submission)).toBe(true);
    expect(validSubmission({ ...submission, invoker: { ...submission.invoker, displayName: "" } })).toBe(false);
    expect(validPoll(poll)).toBe(true);
    expect(validPoll({ ...poll, createdAt: "" })).toBe(false);
  });

  it("namespaces legacy human voter IDs during JSON normalization", () => {
    const vote={roomId:"room",pollId:"poll",voterId:"legacy-human",mutationId:"legacy-vote",optionIndex:1,createdAt};
    expect(normalizeJsonCommandState({votes:[vote]}).votes).toEqual([{...vote,voterId:"human:legacy-human"}]);
    expect(normalizeJsonCommandState({votes:[{...vote,voterId:"agent:codex-sol"}]}).votes[0]?.voterId).toBe("agent:codex-sol");
    expect(normalizeJsonCommandState({votes:[vote,{...vote,voterId:"human:legacy-human",mutationId:"new-vote"}]}).votes).toHaveLength(1);
  });

  it("rejects a malformed reassignment without dereferencing a missing pointer", () => {
    const current = { attemptId: "one", roomId: "room", submissionId: "submission", attempt: 1, agentId: "codex-sol" as const, generationId: null, status: "superseded" as const, reason: "stalled", createdAt, updatedAt: "2026-08-27T12:01:00.000Z" };
    const next = { ...current, attemptId: "two", attempt: 2, status: "queued" as const, reason: null };
    expect(() => validCommandReassignment({ expectedUpdatedAt: createdAt, current, next } as never)).not.toThrow();
    expect(validCommandReassignment({ expectedUpdatedAt: createdAt, current, next } as never)).toBe(false);
  });
});
