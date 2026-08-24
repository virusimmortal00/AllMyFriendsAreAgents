import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentId } from "../types.js";
import { CONTINUATION_POLICY_VERSION, projectPathHash, type ContinuationInboxEntry, type ContinuationPolicy, type ContinuationRecord, type ContinuationRecordStore } from "../continuation-record.js";
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

describe("continuation repository contract", () => {
  it("has JSON/SQLite parity for policy CAS, one-slot races, job CAS, and atomic inbox completion", async () => {
    for (const [backend, store] of await fixtures()) {
      expect(await store.compareAndSetContinuationPolicy(0, policy()), backend).toMatchObject({ kind: "accepted" });
      expect(await store.compareAndSetContinuationPolicy(0, policy()), backend).toMatchObject({ kind: "conflict", actualRevision: 1 });
      const first = job("job-1"); const second = job("job-2");
      const raced = await Promise.all([store.createContinuation(first), store.createContinuation(second)]);
      expect(raced.map((result) => result.kind).sort(), backend).toEqual(["accepted", "conflict"]);
      const winner = (await store.listContinuations())[0]!;
      const running = { ...winner, jobRevision: 2, status: "RUNNING" as const, startedAt: now, usage: { ...winner.usage, attempts: 1 } };
      expect(await store.compareAndSetContinuation(1, running), backend).toMatchObject({ kind: "accepted" });
      expect(await store.compareAndSetContinuation(1, running), backend).toMatchObject({ kind: "conflict", actualRevision: 2 });
      const done = completed(running, 3); const inbox = entry("inbox-1", done);
      expect(await store.completeContinuation(2, done, inbox, 1), backend).toMatchObject({ kind: "accepted" });
      expect(await store.getContinuationInboxEntry("inbox-1"), backend).toMatchObject({ status: "UNREAD", jobId: winner.jobId });
      expect(await store.completeContinuation(2, done, inbox, 1), backend).toMatchObject({ kind: "conflict" });
      expect(await store.compareAndSetContinuation(3, { ...done, jobRevision: 4, status: "FAILED" }), backend).toMatchObject({ kind: "conflict", actualRevision: 3 });
      const closed = { ...inbox, inboxRevision: 2, status: "CLOSED" as const, updatedAt: "2026-08-24T12:01:00.000Z", acknowledgedAt: "2026-08-24T12:01:00.000Z", closedAt: "2026-08-24T12:01:00.000Z" };
      expect(await store.compareAndSetContinuationInbox(1, closed), backend).toMatchObject({ kind: "accepted" });
      expect(await store.compareAndSetContinuationInbox(2, { ...closed, inboxRevision: 3, status: "UNREAD", closedAt: null }), backend).toMatchObject({ kind: "conflict", actualRevision: 2 });
    }
  });
});
