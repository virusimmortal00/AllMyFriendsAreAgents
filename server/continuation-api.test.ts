import { describe, expect, it } from "vitest";
import { projectContinuationJob } from "./continuation-api.js";
import { CONTINUATION_POLICY_VERSION, projectPathHash, type ContinuationRecord } from "./continuation-record.js";

describe("continuation public projection", () => {
  it("excludes authority epoch, project hash, and executor capabilities", () => {
    const job: ContinuationRecord = { schemaVersion: 1, jobId: "job", jobRevision: 1, roomId: "room", projectPathHash: projectPathHash("secret/path"), owner: "codex-sol", task: { roomId: "room", taskId: "task" }, taskRevision: 1, assignmentReferenceId: "ref", authority: { assignmentId: "assignment", developerMemberId: "developer", developerMemberConfigRevision: 2, agent: "codex-sol", fencingToken: 4, manifestRevision: 3, pinnedBaseSha: "a".repeat(40) }, objective: "objective", trigger: "trigger", policyRevision: 1, policyVersion: CONTINUATION_POLICY_VERSION, capabilities: ["ANALYZE", "EDIT_ASSIGNMENT_WORKSPACE", "RUN_TESTS"], status: "QUEUED", budget: { timeMs: 1000, tokenLimit: 10, toolCallLimit: 2, retryLimit: 0 }, usage: { elapsedMs: 0, tokens: 0, toolCalls: 0, attempts: 0 }, cancellationRequested: false, resultDisposition: "PENDING", resultSummary: null, blocker: null, nextEligibilityAt: null, createdAt: "2026-08-24T00:00:00Z", startedAt: null, updatedAt: "2026-08-24T00:00:00Z", completedAt: null };
    const projection = projectContinuationJob(job) as unknown as Record<string, unknown>;
    expect(projection).not.toHaveProperty("authority"); expect(projection).not.toHaveProperty("projectPathHash"); expect(projection).not.toHaveProperty("capabilities"); expect(JSON.stringify(projection)).not.toContain("pinnedBaseSha"); expect(JSON.stringify(projection)).not.toMatch(/push|merge|deploy|publish/i);
  });
});
