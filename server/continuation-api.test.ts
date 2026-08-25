import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { continuationCreateValidationError, projectContinuationAudit, projectContinuationJob, registerContinuationRoutes, roomContinuationRequestValidationError, roomContinuationRequestsMatch } from "./continuation-api.js";
import { CONTINUATION_POLICY_VERSION, projectPathHash, type ContinuationAuditEvent, type ContinuationRecord } from "./continuation-record.js";
import type { ContinuationService } from "./continuation-service.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import type { HumanSessions } from "./human-session.js";

describe("continuation public projection", () => {
  it("excludes authority epoch, project hash, and executor capabilities", () => {
    const job: ContinuationRecord = { schemaVersion: 1, jobId: "job", jobRevision: 1, roomId: "room", projectPathHash: projectPathHash("secret/path"), owner: "codex-sol", task: { roomId: "room", taskId: "task" }, taskRevision: 1, assignmentReferenceId: "ref", authority: { assignmentId: "assignment", developerMemberId: "developer", developerMemberConfigRevision: 2, agent: "codex-sol", fencingToken: 4, manifestRevision: 3, pinnedBaseSha: "a".repeat(40) }, objective: "objective", trigger: "trigger", policyRevision: 1, policyVersion: CONTINUATION_POLICY_VERSION, capabilities: ["ANALYZE", "EDIT_ASSIGNMENT_WORKSPACE", "RUN_TESTS"], status: "QUEUED", budget: { timeMs: 1000, tokenLimit: 10, toolCallLimit: 2, retryLimit: 0 }, usage: { elapsedMs: 0, tokens: 0, toolCalls: 0, attempts: 0 }, cancellationRequested: false, auditHeadHash: "a".repeat(64), auditEventCount: 1, resultDisposition: "PENDING", resultSummary: null, blocker: null, nextEligibilityAt: null, createdAt: "2026-08-24T00:00:00Z", startedAt: null, updatedAt: "2026-08-24T00:00:00Z", completedAt: null };
    const projection = projectContinuationJob(job) as unknown as Record<string, unknown>;
    expect(projection).not.toHaveProperty("authority"); expect(projection).not.toHaveProperty("projectPathHash"); expect(projection).not.toHaveProperty("capabilities"); expect(JSON.stringify(projection)).not.toContain("pinnedBaseSha"); expect(JSON.stringify(projection)).not.toMatch(/push|merge|deploy|publish/i);
  });
  it("rejects malformed create shapes before service dispatch", () => {
    const valid = { owner: "codex-sol", taskId: "task", taskRevision: 1, assignmentReferenceId: "ref", objective: "bounded", trigger: "explicit", budget: { timeMs: 1000, tokenLimit: 10, toolCallLimit: 1, retryLimit: 0 } };
    expect(continuationCreateValidationError(valid)).toBeNull();
    for (const body of [{ ...valid, objective: 42 }, { ...valid, trigger: "" }, { ...valid, taskRevision: "1" }, { ...valid, budget: [] }, { ...valid, budget: { timeMs: "lots" } }, { ...valid, budget: { unknown: 1 } }]) expect(continuationCreateValidationError(body)).toMatch(/Bounded owner/);
  });
  it("requires exact bounded room-request provenance without accepting client authority fields", () => {
    const valid = { taskId: "task", taskRevision: 3, assignmentReferenceId: "assignment-ref", objective: "Continue bounded work" };
    expect(roomContinuationRequestValidationError(valid)).toBeNull();
    expect(roomContinuationRequestValidationError({ ...valid, taskRevision: 2.5 })).toMatch(/exact task revision/);
    expect(roomContinuationRequestValidationError({ ...valid, owner: "codex-sol" })).toMatch(/exact task revision/);
    expect(roomContinuationRequestValidationError({ ...valid, budget: { tokenLimit: -1 } })).toMatch(/exact task revision/);
    expect(roomContinuationRequestsMatch(valid, structuredClone(valid))).toBe(true);
    expect(roomContinuationRequestsMatch(valid, { ...valid, objective: "substituted" })).toBe(false);
    expect(roomContinuationRequestsMatch(undefined, valid)).toBe(false);
  });
  it("returns 400 for malformed developer create bodies without dispatching the service", async () => {
    const create = vi.fn(); const app = express(); app.use(express.json());
    registerContinuationRoutes({ app, service: { create } as unknown as ContinuationService, humans: {} as HumanPresenceRegistry, sessions: { humanId: () => undefined } as unknown as HumanSessions,
      developers: { authenticate: () => ({ member: { memberId: "developer", revision: 1 } }) } as unknown as DeveloperTeamRegistry, broadcast() {} });
    const server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
    try { const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/developer/continuations`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test" }, body: JSON.stringify({ objective: 7, budget: [] }) }); expect(response.status).toBe(400); expect(create).not.toHaveBeenCalled(); }
    finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
  it("projects bounded audit data with per-attempt usage and defense-in-depth redaction", () => {
    const event: ContinuationAuditEvent = { schemaVersion: 1, eventId: "event", jobId: "job", jobRevision: 2, attempt: 1, trigger: "explicit <analysis>hidden", policyRevision: 1, provenanceHash: "a".repeat(64), previousEventHash: "b".repeat(64), projectionHash: "c".repeat(64), eventHash: "d".repeat(64), at: "2026-08-24T00:00:00Z", action: "FAILED", fromStatus: "RUNNING", toStatus: "FAILED", usage: { elapsedMs: 12, tokens: 3, toolCalls: 1, attempts: 1 }, attemptUsage: { elapsedMs: 12, tokens: 3, toolCalls: 1 }, result: "public <reasoning>secret", nextEligibilityAt: null };
    const projection = projectContinuationAudit(event); expect(projection).toMatchObject({ attemptUsage: { elapsedMs: 12, tokens: 3, toolCalls: 1 }, trigger: "explicit [REDACTED]", result: "public [REDACTED]" }); expect(JSON.stringify(projection)).not.toMatch(/hidden|secret/);
  });
});
