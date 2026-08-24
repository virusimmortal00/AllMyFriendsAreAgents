import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId } from "../types.js";
import { CONTINUATION_POLICY_VERSION, projectPathHash, type ContinuationAuditAction, type ContinuationAuditEvent, type ContinuationInboxEntry, type ContinuationPolicy, type ContinuationRecord, type ContinuationRecordStore } from "../continuation-record.js";
import { RoomStore } from "../room-store.js";
import { SqliteRoomRepository } from "./sqlite-room-repository.js";
import { CANONICAL_ROOM_ID } from "./room-repository.js";

const roots: string[] = []; const now = "2026-08-24T12:00:00.000Z";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixtures(): Promise<Array<[string, ContinuationRecordStore]>> { const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-continuations-")); roots.push(root); return [["json", await RoomStore.open(root, path.join(root, "json"))], ["sqlite", await SqliteRoomRepository.open(root, path.join(root, "room.sqlite"), { seedImprovements: false })]]; }
function policy(): ContinuationPolicy { return { schemaVersion: 1, policyVersion: CONTINUATION_POLICY_VERSION, revision: 1, roomId: CANONICAL_ROOM_ID, projectPathHash: projectPathHash("/project"), enabled: true, maxConcurrentPerAgent: 1, defaultBudget: { timeMs: 1000, tokenLimit: 10, toolCallLimit: 2, retryLimit: 1 }, maxInboxEntriesPerAgent: 1, inboxTtlMs: 1000, retryBackoffMs: 100, updatedAt: now, updatedBy: "human" }; }
function job(id: string, owner: AgentId = "codex-sol"): ContinuationRecord { return { schemaVersion: 1, jobId: id, jobRevision: 1, roomId: CANONICAL_ROOM_ID, projectPathHash: projectPathHash("/project"), owner, task: { roomId: CANONICAL_ROOM_ID, taskId: "task-1" }, taskRevision: 3, assignmentReferenceId: "assignment-ref", authority: { assignmentId: "assignment-1", developerMemberId: "dev-1", developerMemberConfigRevision: 1, agent: owner, fencingToken: 2, manifestRevision: 4, pinnedBaseSha: "a".repeat(40) }, objective: "Inspect the bounded change", trigger: "Explicit developer request", policyRevision: 1, policyVersion: CONTINUATION_POLICY_VERSION, capabilities: ["ANALYZE"], status: "QUEUED", budget: { timeMs: 1000, tokenLimit: 10, toolCallLimit: 2, retryLimit: 1 }, usage: { elapsedMs: 0, tokens: 0, toolCalls: 0, attempts: 0 }, cancellationRequested: false, resultDisposition: "PENDING", resultSummary: null, blocker: null, nextEligibilityAt: null, createdAt: now, startedAt: null, updatedAt: now, completedAt: null }; }
function completed(source: ContinuationRecord, revision: number): ContinuationRecord { return { ...source, jobRevision: revision, status: "COMPLETED", resultDisposition: "INBOX", resultSummary: "Public result", startedAt: now, completedAt: now }; }
function entry(id: string, source: ContinuationRecord): ContinuationInboxEntry { return { schemaVersion: 1, inboxEntryId: id, inboxRevision: 1, jobId: source.jobId, owner: source.owner, roomId: source.roomId, task: source.task, taskRevision: source.taskRevision, assignmentId: source.authority.assignmentId, status: "UNREAD", summary: "Public result", relevance: ["task-1"], createdAt: now, updatedAt: now, expiresAt: "2026-08-25T12:00:00.000Z", acknowledgedAt: null, closedAt: null }; }
function event(record: ContinuationRecord, fromStatus: ContinuationRecord["status"] | null, action: ContinuationAuditAction): ContinuationAuditEvent { const result = action === "CREATED" ? "Queued by authorized developer." : action === "DISPATCHED" ? "Executor dispatch started." : action === "RESUMED" ? "Retry/resume authorized." : action === "TOOL_RESUMED" ? "Tool work resumed." : action === "ACKNOWLEDGED" ? "Inbox entry closed." : action === "COMPLETED" ? record.resultSummary : action === "INBOX_ARCHIVED" ? "Inbox result archived by bounded retention policy." : record.blocker; return { schemaVersion: 1, eventId: `event-${record.jobId}-${record.jobRevision}-${action.toLowerCase()}`, jobId: record.jobId, jobRevision: record.jobRevision, attempt: record.usage.attempts, trigger: record.trigger, policyRevision: record.policyRevision, at: record.updatedAt, action, fromStatus, toStatus: record.status, usage: record.usage, attemptUsage: { elapsedMs: 0, tokens: 0, toolCalls: 0 }, result, nextEligibilityAt: record.nextEligibilityAt }; }

describe("continuation repository contract", () => {
  it("has JSON/SQLite parity for policy CAS, one-slot races, job CAS, and atomic inbox completion", async () => {
    for (const [backend, store] of await fixtures()) {
      expect(await store.compareAndSetContinuationPolicy(0, policy()), backend).toMatchObject({ kind: "accepted" });
      expect(await store.compareAndSetContinuationPolicy(0, policy()), backend).toMatchObject({ kind: "conflict", actualRevision: 1 });
      const first = job("job-1"); const second = job("job-2");
      const raced = await Promise.all([store.createContinuation(first, event(first, null, "CREATED")), store.createContinuation(second, event(second, null, "CREATED"))]);
      expect(raced.map((result) => result.kind).sort(), backend).toEqual(["accepted", "conflict"]);
      const winner = (await store.listContinuations())[0]!;
      const running = { ...winner, jobRevision: 2, status: "RUNNING" as const, startedAt: now, usage: { ...winner.usage, attempts: 1 } };
      expect(await store.compareAndSetContinuation(1, running, event(running, "QUEUED", "DISPATCHED")), backend).toMatchObject({ kind: "accepted" });
      expect(await store.compareAndSetContinuation(1, running, event(running, "QUEUED", "DISPATCHED")), backend).toMatchObject({ kind: "conflict", actualRevision: 2 });
      const done = completed(running, 3); const inbox = entry("inbox-1", done);
      expect(await store.completeContinuation(2, done, inbox, 1, event(done, "RUNNING", "COMPLETED")), backend).toMatchObject({ kind: "accepted" });
      expect(await store.getContinuationInboxEntry("inbox-1"), backend).toMatchObject({ status: "UNREAD", jobId: winner.jobId });
      expect(await store.completeContinuation(2, done, inbox, 1, event(done, "RUNNING", "COMPLETED")), backend).toMatchObject({ kind: "conflict" });
      const illegal = { ...done, jobRevision: 4, status: "FAILED" as const }; expect(await store.compareAndSetContinuation(3, illegal, event(illegal, "COMPLETED", "FAILED")), backend).toMatchObject({ kind: "conflict", actualRevision: 3 });
      expect((await store.listContinuationAudit(winner.jobId)).map(({ action }) => action), backend).toEqual(["CREATED", "DISPATCHED", "COMPLETED"]);
      const closed = { ...inbox, inboxRevision: 2, status: "CLOSED" as const, updatedAt: "2026-08-24T12:01:00.000Z", acknowledgedAt: "2026-08-24T12:01:00.000Z", closedAt: "2026-08-24T12:01:00.000Z" };
      expect(await store.compareAndSetContinuationInbox(1, closed), backend).toMatchObject({ kind: "accepted" });
      expect(await store.compareAndSetContinuationInbox(2, { ...closed, inboxRevision: 3, status: "UNREAD", closedAt: null }), backend).toMatchObject({ kind: "conflict", actualRevision: 2 });
    }
  });
  it("atomically archives capacity-evicted inbox and job projections while excluding CLOSED entries", async () => {
    for (const [backend, store] of await fixtures()) {
      await store.compareAndSetContinuationPolicy(0, policy());
      const finish = async (id: string, inboxId: string) => { const queued = job(id); await store.createContinuation(queued, event(queued, null, "CREATED")); const running = { ...queued, jobRevision: 2, status: "RUNNING" as const, startedAt: now, usage: { ...queued.usage, attempts: 1 } }; await store.compareAndSetContinuation(1, running, event(running, "QUEUED", "DISPATCHED")); const done = completed(running, 3); await store.completeContinuation(2, done, entry(inboxId, done), 1, event(done, "RUNNING", "COMPLETED")); return done; };
      const first = await finish("capacity-1", "capacity-inbox-1"); await finish("capacity-2", "capacity-inbox-2");
      expect(await store.getContinuationInboxEntry("capacity-inbox-1"), backend).toMatchObject({ status: "ARCHIVED" }); expect(await store.getContinuation(first.jobId), backend).toMatchObject({ jobRevision: 4, resultDisposition: "ARCHIVED" }); expect((await store.listContinuationAudit(first.jobId)).at(-1), backend).toMatchObject({ action: "INBOX_ARCHIVED", jobRevision: 4 });
      const secondEntry = (await store.getContinuationInboxEntry("capacity-inbox-2"))!; const closed = { ...secondEntry, inboxRevision: secondEntry.inboxRevision + 1, status: "CLOSED" as const, acknowledgedAt: now, closedAt: now, updatedAt: now }; await store.compareAndSetContinuationInbox(secondEntry.inboxRevision, closed); await finish("capacity-3", "capacity-inbox-3"); expect(await store.getContinuationInboxEntry("capacity-inbox-2"), backend).toMatchObject({ status: "CLOSED" });
      const unread = (await store.getContinuationInboxEntry("capacity-inbox-3"))!; expect(await store.compareAndSetContinuationInbox(unread.inboxRevision, { ...unread, inboxRevision: unread.inboxRevision + 1, status: "ARCHIVED", closedAt: now }), backend).toMatchObject({ kind: "conflict" });
    }
  });
  it("rejects cross-room, forged-audit, and immutable-provenance mutations with JSON/SQLite parity", async () => {
    for (const [backend, store] of await fixtures()) {
      await store.compareAndSetContinuationPolicy(0, policy());
      await expect(store.compareAndSetContinuationPolicy(1, { ...policy(), revision: 2, projectPathHash: "b".repeat(64) }), backend).rejects.toThrow(/provenance/);
      const foreign = { ...job(`foreign-${backend}`), roomId: "foreign-room", task: { roomId: "foreign-room", taskId: "task-1" } };
      await expect(store.createContinuation(foreign, event(foreign, null, "CREATED")), backend).rejects.toThrow(/initial continuation/);
      const queued = job(`adversarial-${backend}`); await store.createContinuation(queued, event(queued, null, "CREATED"));
      const running = { ...queued, jobRevision: 2, status: "RUNNING" as const, startedAt: now, usage: { ...queued.usage, attempts: 1 } }; const dispatched = event(running, "QUEUED", "DISPATCHED");
      for (const forged of [{ ...dispatched, action: "FAILED" as const }, { ...dispatched, attempt: 9 }, { ...dispatched, trigger: "forged trigger" }, { ...dispatched, policyRevision: 9 }, { ...dispatched, usage: { ...dispatched.usage, tokens: 1 } }, { ...dispatched, attemptUsage: { ...dispatched.attemptUsage, toolCalls: 1 } }, { ...dispatched, result: "forged" }, { ...dispatched, at: "2026-08-24T12:01:00.000Z" }, { ...dispatched, nextEligibilityAt: now }]) await expect(store.compareAndSetContinuation(1, running, forged), backend).rejects.toThrow(/audit event/);
      expect(await store.compareAndSetContinuation(1, running, dispatched), backend).toMatchObject({ kind: "accepted" });
      const blocked = { ...running, jobRevision: 3, status: "BLOCKED" as const, blocker: "retry", nextEligibilityAt: "2026-08-24T12:01:00.000Z", updatedAt: "2026-08-24T12:00:30.000Z" }; const blockedEvent = event(blocked, "RUNNING", "RETRY_BLOCKED");
      const mutations: ContinuationRecord[] = [
        { ...blocked, projectPathHash: "b".repeat(64) }, { ...blocked, owner: "claude-sonnet" as AgentId, authority: { ...blocked.authority, agent: "claude-sonnet" as AgentId } },
        { ...blocked, task: { ...blocked.task, taskId: "other-task" } }, { ...blocked, taskRevision: blocked.taskRevision + 1 }, { ...blocked, assignmentReferenceId: "other-ref" },
        { ...blocked, authority: { ...blocked.authority, fencingToken: blocked.authority.fencingToken + 1 } }, { ...blocked, createdAt: "2026-08-24T11:00:00.000Z" }, { ...blocked, policyRevision: blocked.policyRevision + 1 },
        { ...blocked, roomId: "foreign-room", task: { ...blocked.task, roomId: "foreign-room" } },
      ];
      for (const mutation of mutations) await expect(store.compareAndSetContinuation(2, mutation, { ...blockedEvent, jobId: mutation.jobId, trigger: mutation.trigger, policyRevision: mutation.policyRevision }), backend).rejects.toThrow(/provenance|audit/);
      expect(await store.compareAndSetContinuation(2, { ...blocked, jobId: "other-job" }, { ...blockedEvent, jobId: "other-job" }), backend).toMatchObject({ kind: "not_found" });
      expect(await store.compareAndSetContinuation(2, blocked, blockedEvent), backend).toMatchObject({ kind: "accepted" });
      const resumed = { ...blocked, jobRevision: 4, status: "QUEUED" as const, blocker: null, nextEligibilityAt: null, updatedAt: "2026-08-24T12:01:00.000Z" }; await store.compareAndSetContinuation(3, resumed, event(resumed, "BLOCKED", "RESUMED"));
      const rerun = { ...resumed, jobRevision: 5, status: "RUNNING" as const, usage: { ...resumed.usage, attempts: 2 }, updatedAt: "2026-08-24T12:01:01.000Z" }; await store.compareAndSetContinuation(4, rerun, event(rerun, "QUEUED", "DISPATCHED"));
      const done = { ...completed(rerun, 6), updatedAt: "2026-08-24T12:01:02.000Z", completedAt: "2026-08-24T12:01:02.000Z" }; const validInbox = { ...entry(`adversarial-inbox-${backend}`, done), createdAt: done.updatedAt, updatedAt: done.updatedAt };
      for (const mismatch of [{ ...validInbox, owner: "claude-sonnet" as AgentId }, { ...validInbox, task: { ...validInbox.task, taskId: "other-task" } }, { ...validInbox, taskRevision: validInbox.taskRevision + 1 }, { ...validInbox, assignmentId: "other-assignment" }, { ...validInbox, roomId: "foreign-room", task: { ...validInbox.task, roomId: "foreign-room" } }]) await expect(store.completeContinuation(5, done, mismatch, 2, event(done, "RUNNING", "COMPLETED")), backend).rejects.toThrow(/completion/);
      await store.completeContinuation(5, done, validInbox, 2, event(done, "RUNNING", "COMPLETED"));
      const acknowledged = { ...validInbox, inboxRevision: 2, status: "ACKNOWLEDGED" as const, acknowledgedAt: done.updatedAt };
      for (const mutation of [{ ...acknowledged, jobId: "other-job" }, { ...acknowledged, summary: "forged summary" }, { ...acknowledged, expiresAt: "2027-01-01T00:00:00.000Z" }, { ...acknowledged, assignmentId: "other-assignment" }]) await expect(store.compareAndSetContinuationInbox(1, mutation), backend).rejects.toThrow(/provenance/);
      await store.compareAndSetContinuationInbox(1, acknowledged); const archived = { ...acknowledged, inboxRevision: 3, status: "ARCHIVED" as const, closedAt: done.updatedAt };
      await expect(store.archiveContinuationInbox(2, { ...archived, taskRevision: archived.taskRevision + 1 }), backend).rejects.toThrow(/provenance/);
    }
  });
});
