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
function event(record: ContinuationRecord, fromStatus: ContinuationRecord["status"] | null, action: ContinuationAuditAction): ContinuationAuditEvent { return { schemaVersion: 1, eventId: `event-${record.jobId}-${record.jobRevision}-${action.toLowerCase()}`, jobId: record.jobId, jobRevision: record.jobRevision, attempt: record.usage.attempts, trigger: record.trigger, policyRevision: record.policyRevision, at: record.updatedAt, action, fromStatus, toStatus: record.status, usage: record.usage, attemptUsage: { elapsedMs: 0, tokens: 0, toolCalls: 0 }, result: null, nextEligibilityAt: record.nextEligibilityAt }; }

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
});
