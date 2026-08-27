import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandSubmission } from "../command-record.js";
import { RoomStore } from "../room-store.js";
import type { RoomRepository } from "./room-repository.js";
import { DEFAULT_ROOM_ID, SqliteRoomRepository } from "./sqlite-room-repository.js";

const temporaryDirectories: string[] = [];
const factories: ReadonlyArray<readonly [string, (root: string) => Promise<{ repository: RoomRepository; reopen(): Promise<RoomRepository>; close(): void }>]> = [
  ["JSON", async (root) => { const directory = path.join(root, "json"); let repository: RoomRepository = await RoomStore.open(root, directory); return { get repository() { return repository; }, async reopen() { repository = await RoomStore.open(root, directory); return repository; }, close() {} }; }],
  ["SQLite", async (root) => { const database = path.join(root, "sqlite", "room.sqlite"); let repository: RoomRepository = await SqliteRoomRepository.open(root, database); return { get repository() { return repository; }, async reopen() { (repository as SqliteRoomRepository).close(); repository = await SqliteRoomRepository.open(root, database); return repository; }, close() { (repository as SqliteRoomRepository).close(); } }; }],
];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function submission(): CommandSubmission { return { submissionId: "submission-1", roomId: DEFAULT_ROOM_ID, clientSubmissionId: "client-1", command: "poll", invocation: { command: "poll", question: "Choose", options: ["A", "B"] }, invoker: { kind: "human", id: "human-1", displayName: "Human" }, createdAt: "2026-08-27T12:00:00.000Z" }; }

describe.each(factories)("%s command repository", (_backend, makeFixture) => {
  it("projects each accepted audit status node exactly once across replay and restart",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"amfaa-command-contract-"));temporaryDirectories.push(root);const fixture=await makeFixture(root);try{const first=await fixture.repository.addCommandAuditMessageOnce("audit-stable","— Ada ran /task — Target: Sol");const replay=await fixture.repository.addCommandAuditMessageOnce("audit-stable","different text must not replace it");expect(replay).toEqual(first);const reopened=await fixture.reopen();expect(reopened.snapshot().messages.filter(({id})=>id==="command-audit:audit-stable")).toEqual([first]);}finally{fixture.close();}});

  it("atomically accepts submission, pointer, attempt, and audit or leaves no partial records",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"amfaa-command-contract-"));temporaryDirectories.push(root);const fixture=await makeFixture(root);try{const createdAt="2026-08-27T12:00:00.000Z";const command={...submission(),command:"task" as const,invocation:{command:"task" as const,prompt:"ship",selection:{kind:"round-robin" as const}}};const audit={auditId:"atomic-audit",roomId:DEFAULT_ROOM_ID,submissionId:command.submissionId,command:"task" as const,invokerKind:"human" as const,invokerId:"human-1",targetAgentIds:["codex-sol" as const],createdAt};const attempt={attemptId:"atomic-attempt",roomId:DEFAULT_ROOM_ID,submissionId:command.submissionId,attempt:1,agentId:"codex-sol" as const,generationId:null,status:"queued" as const,reason:null,createdAt,updatedAt:createdAt};const acceptance={submission:command,audit,attempt,roundRobin:{expectedRevision:0,state:{roomId:DEFAULT_ROOM_ID,lastAssignedAgentId:"codex-sol" as const,revision:1,updatedAt:createdAt}}};expect(await fixture.repository.acceptCommand(acceptance)).toMatchObject({kind:"accepted"});expect(await fixture.repository.acceptCommand(acceptance)).toMatchObject({kind:"duplicate"});const reopened=await fixture.reopen();expect(await reopened.getCommandSubmission(DEFAULT_ROOM_ID,command.submissionId)).toEqual(command);expect(await reopened.getCommandAuditIdentity(DEFAULT_ROOM_ID,command.submissionId)).toEqual(audit);expect(await reopened.listCommandAttempts(DEFAULT_ROOM_ID,command.submissionId)).toEqual([attempt]);expect(await reopened.getRoundRobinState(DEFAULT_ROOM_ID)).toMatchObject({revision:1,lastAssignedAgentId:"codex-sol"});const conflicting={...command,submissionId:"conflicting",clientSubmissionId:"conflicting-client"};const rejected={...acceptance,submission:conflicting,audit:{...audit,auditId:"conflicting-audit",submissionId:"conflicting"},attempt:{...attempt,attemptId:"conflicting-attempt",submissionId:"conflicting"}};expect(await reopened.acceptCommand(rejected)).toMatchObject({kind:"conflict",actualRevision:1});expect(await reopened.getCommandSubmission(DEFAULT_ROOM_ID,"conflicting")).toBeUndefined();expect(await reopened.getCommandAuditIdentity(DEFAULT_ROOM_ID,"conflicting")).toBeUndefined();expect(await reopened.listCommandAttempts(DEFAULT_ROOM_ID,"conflicting")).toEqual([]);}finally{fixture.close();}});

  it("atomically supersedes ownership, advances the pointer, and creates the replacement",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"amfaa-command-contract-"));temporaryDirectories.push(root);const fixture=await makeFixture(root);try{const createdAt="2026-08-27T12:00:00.000Z";const command={...submission(),command:"task" as const,invocation:{command:"task" as const,prompt:"ship",selection:{kind:"round-robin" as const}}};const audit={auditId:"reassign-audit",roomId:DEFAULT_ROOM_ID,submissionId:command.submissionId,command:"task" as const,invokerKind:"human" as const,invokerId:"human-1",targetAgentIds:["codex-sol" as const],createdAt};const attempt={attemptId:"attempt-one",roomId:DEFAULT_ROOM_ID,submissionId:command.submissionId,attempt:1,agentId:"codex-sol" as const,generationId:null,status:"queued" as const,reason:null,createdAt,updatedAt:createdAt};await fixture.repository.acceptCommand({submission:command,audit,attempt,roundRobin:{expectedRevision:0,state:{roomId:DEFAULT_ROOM_ID,lastAssignedAgentId:"codex-sol",revision:1,updatedAt:createdAt}}});const current={...attempt,status:"superseded" as const,reason:"launch stalled",updatedAt:"2026-08-27T12:01:00.000Z"};const next={...attempt,attemptId:"attempt-two",attempt:2,agentId:"claude-sonnet" as const,createdAt:current.updatedAt,updatedAt:current.updatedAt};expect(await fixture.repository.reassignCommandAttempt({expectedUpdatedAt:attempt.updatedAt,current,next,roundRobin:{expectedRevision:1,state:{roomId:DEFAULT_ROOM_ID,lastAssignedAgentId:"claude-sonnet",revision:2,updatedAt:current.updatedAt}}})).toMatchObject({kind:"accepted"});const reopened=await fixture.reopen();expect((await reopened.listCommandAttempts(DEFAULT_ROOM_ID,command.submissionId)).map(({status,agentId})=>({status,agentId}))).toEqual([{status:"superseded",agentId:"codex-sol"},{status:"queued",agentId:"claude-sonnet"}]);expect(await reopened.getRoundRobinState(DEFAULT_ROOM_ID)).toMatchObject({revision:2,lastAssignedAgentId:"claude-sonnet"});}finally{fixture.close();}});

  it("persists room-scoped records across restart and deduplicates submissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-command-contract-")); temporaryDirectories.push(root); const fixture = await makeFixture(root);
    try {
      expect((await fixture.repository.createCommandSubmission(submission())).kind).toBe("created");
      expect((await fixture.repository.createCommandSubmission({ ...submission(), submissionId: "replayed" })).kind).toBe("duplicate");
      expect(await fixture.repository.getCommandSubmission("other-room", "submission-1")).toBeUndefined();
      expect(await fixture.repository.compareAndSetRoundRobinState(0, { roomId: DEFAULT_ROOM_ID, lastAssignedAgentId: "codex-sol", revision: 1, updatedAt: "2026-08-27T12:01:00.000Z" })).toMatchObject({ kind: "accepted" });
      const reopened = await fixture.reopen();
      expect(await reopened.getCommandSubmission(DEFAULT_ROOM_ID, "submission-1")).toMatchObject({ command: "poll" });
      expect(await reopened.getRoundRobinState(DEFAULT_ROOM_ID)).toMatchObject({ revision: 1, lastAssignedAgentId: "codex-sol" });
    } finally { fixture.close(); }
  });

  it("keeps polls authoritative and rejects duplicate or cross-room votes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-command-contract-")); temporaryDirectories.push(root); const fixture = await makeFixture(root);
    try {
      await fixture.repository.createCommandSubmission(submission());
      await fixture.repository.createCommandPoll({ pollId: "poll-1", roomId: DEFAULT_ROOM_ID, submissionId: "submission-1", question: "Choose", options: ["A", "B"], createdAt: submission().createdAt });
      const vote = { roomId: DEFAULT_ROOM_ID, pollId: "poll-1", voterId: "human-1", optionIndex: 1, createdAt: "2026-08-27T12:02:00.000Z" };
      expect((await fixture.repository.createCommandVote(vote)).kind).toBe("created");
      expect((await fixture.repository.createCommandVote({ ...vote, optionIndex: 0 })).kind).toBe("duplicate");
      expect((await fixture.repository.createCommandVote({ ...vote, roomId: "other-room", voterId: "other" })).kind).toBe("rejected");
      expect(await fixture.repository.listCommandVotes(DEFAULT_ROOM_ID, "poll-1")).toEqual([vote]);
      expect(await fixture.repository.listCommandVotes("other-room", "poll-1")).toEqual([]);
      expect(JSON.stringify(fixture.repository.snapshot())).not.toMatch(/submission-1|poll-1|client-1/);
    } finally { fixture.close(); }
  });

  it("atomically accepts a poll with its audit identity",async()=>{const root=await mkdtemp(path.join(os.tmpdir(),"amfaa-command-contract-"));temporaryDirectories.push(root);const fixture=await makeFixture(root);try{const value=submission();const poll={pollId:"poll-atomic",roomId:DEFAULT_ROOM_ID,submissionId:value.submissionId,question:"Choose",options:["A","B"] as const,createdAt:value.createdAt};const audit={auditId:"poll-audit",roomId:DEFAULT_ROOM_ID,submissionId:value.submissionId,command:"poll" as const,invokerKind:"human" as const,invokerId:"human-1",targetAgentIds:[] as const,createdAt:value.createdAt};expect(await fixture.repository.acceptCommand({submission:value,poll,audit})).toMatchObject({kind:"accepted"});const reopened=await fixture.reopen();expect(await reopened.getCommandPoll(DEFAULT_ROOM_ID,poll.pollId)).toEqual(poll);expect(await reopened.getCommandAuditIdentity(DEFAULT_ROOM_ID,value.submissionId)).toEqual(audit);}finally{fixture.close();}});

  it("persists attempts, audit identities, and bounded private diagnostics idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-command-contract-")); temporaryDirectories.push(root); const fixture = await makeFixture(root);
    try {
      await fixture.repository.createCommandSubmission(submission());
      const attempt = { attemptId: "attempt-1", roomId: DEFAULT_ROOM_ID, submissionId: "submission-1", attempt: 1, agentId: "codex-sol" as const, generationId: "generation-1", status: "active" as const, reason: null, createdAt: submission().createdAt, updatedAt: submission().createdAt };
      expect((await fixture.repository.createCommandAttempt(attempt)).kind).toBe("created");
      expect((await fixture.repository.createCommandAttempt(attempt)).kind).toBe("duplicate");
      const completed = { ...attempt, status: "completed" as const, updatedAt: "2026-08-27T12:03:00.000Z" };
      expect(await fixture.repository.compareAndSetCommandAttempt(attempt.updatedAt, completed)).toMatchObject({ kind: "accepted" });
      expect(await fixture.repository.compareAndSetCommandAttempt(attempt.updatedAt, { ...completed, status: "failed" })).toEqual({ kind: "conflict" });
      expect(await fixture.repository.listPendingCommandAttempts(DEFAULT_ROOM_ID)).toEqual([]);
      const audit = { auditId: "audit-1", roomId: DEFAULT_ROOM_ID, submissionId: "submission-1", command: "poll" as const, invokerKind: "human" as const, invokerId: "human-1", targetAgentIds: [] as const, createdAt: submission().createdAt };
      expect((await fixture.repository.createCommandAuditIdentity(audit)).kind).toBe("created");
      const diagnostic = { recordId: "diagnostic-1", roomId: DEFAULT_ROOM_ID, agentId: "codex-sol" as const, attemptId: "attempt-1", generationId: "generation-1", correlationId: "correlation-1", promptHead: "bounded", promptFingerprint: "sha256:prompt", reason: "stalled", metadata: { bytes: 7 }, diagnosticText: "safe partial", createdAt: submission().createdAt };
      expect((await fixture.repository.appendDiagnostic(diagnostic)).kind).toBe("created");
      expect((await fixture.repository.appendDiagnostic({ ...diagnostic, recordId: "replay" })).kind).toBe("duplicate");
      const reopened = await fixture.reopen();
      expect(await reopened.listCommandAttempts(DEFAULT_ROOM_ID, "submission-1")).toEqual([completed]);
      expect(await reopened.getCommandAuditIdentity(DEFAULT_ROOM_ID, "submission-1")).toEqual(audit);
      expect(await reopened.listDiagnostics(DEFAULT_ROOM_ID, "codex-sol")).toEqual([diagnostic]);
      expect(await reopened.getDiagnostic(DEFAULT_ROOM_ID, "codex-sol", "diagnostic-1")).toEqual(diagnostic);
      expect(await reopened.listDiagnostics(DEFAULT_ROOM_ID, { agentId: "codex-sol", search: "SAFE PARTIAL", reason: "stalled" })).toEqual([diagnostic]);
      expect(await reopened.listDiagnostics("other-room", "codex-sol")).toEqual([]);
    } finally { fixture.close(); }
  });
});
