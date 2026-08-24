import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTask } from "../shared/task-domain.js";
import type { AssignmentLifecycleService } from "./assignment-lifecycle.js";
import type { AssignmentRecord } from "./assignment-record.js";
import { ContinuationService, type ContinuationExecutorResult } from "./continuation-service.js";
import { RoomStore } from "./room-store.js";
import { CANONICAL_ROOM_ID } from "./storage/room-repository.js";

const roots: string[] = []; const at = "2026-08-24T12:00:00.000Z";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function eventually(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 100; i += 1) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error("condition not reached"); }

async function fixture(dispatch: () => Promise<ContinuationExecutorResult>, now?: () => Date) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-service-")); roots.push(root); const store = await RoomStore.open(root, path.join(root, "state"));
  await store.updateSettings({ projectPath: root, writableAgent: "codex-sol" });
  const actor = { id: "human", roomRole: "owner" as const }; let task = createTask({ roomId: CANONICAL_ROOM_ID, taskId: "task-1", title: "Durable work", actor, now: at });
  expect((await store.createTask(task)).kind).toBe("created");
  for (const change of [{ kind: "append_reference", reference: { id: "assignment-ref", kind: "assignment", targetId: "assignment-1" } }, { kind: "transition", to: "proposed" }, { kind: "transition", to: "approved" }, { kind: "transition", to: "active" }] as const) { const result = await store.applyTaskChange({ roomId: task.roomId, taskId: task.taskId }, task.revision, change, actor, at); if (result.kind !== "accepted") throw new Error("task setup failed"); task = result.task; }
  const assignment: AssignmentRecord = { assignmentId: "assignment-1", improvementId: "improvement-1", developerMemberId: "dev-1", developerMemberConfigRevision: 1, agent: "codex-sol", fencingToken: 2, manifestRevision: 3, pinnedBaseSha: "a".repeat(40), branch: "work", observedHeadSha: "a".repeat(40), workspacePath: root, lifecycleStatus: "ACTIVE", recovery: { classification: "clean", reconciledAt: at, previousStatus: null, detail: "test" }, createdAt: at, updatedAt: at };
  const lifecycle = { authorityForContinuation: async (id: string, owner: string) => id === assignment.assignmentId && owner === assignment.agent ? { assignment, workspace: root } : undefined } as unknown as AssignmentLifecycleService;
  const service = new ContinuationService(store, store, lifecycle, { dispatch: async () => dispatch() }, { now }); await service.initialize();
  return { store, service, task, async enable() { const policy = await service.policy(); expect(policy).toBeTruthy(); expect((await service.updatePolicy(policy!.revision, { enabled: true }, "human")).kind).toBe("accepted"); }, create: () => service.create({ owner: "codex-sol", developerMemberId: "dev-1", developerMemberConfigRevision: 1, taskId: task.taskId, taskRevision: task.revision, assignmentReferenceId: "assignment-ref", objective: "Continue the approved task", trigger: "Explicit test trigger" }) };
}

describe("ContinuationService", () => {
  it("is disabled by default and rejects stale task identity", async () => {
    const value = await fixture(async () => ({ summary: "done", usage: { tokens: 1, toolCalls: 0 } }));
    expect(await value.create()).toMatchObject({ kind: "rejected", reason: "Continuation policy is disabled." });
    await value.enable(); expect(await value.service.create({ owner: "codex-sol", developerMemberId: "dev-1", developerMemberConfigRevision: 1, taskId: value.task.taskId, taskRevision: value.task.revision - 1, assignmentReferenceId: "assignment-ref", objective: "Continue", trigger: "test" })).toMatchObject({ kind: "rejected", reason: "Task revision is stale or superseded." });
  });

  it("coexists with foreground messages, enforces one slot, and lands only in the inbox", async () => {
    const execution = deferred<ContinuationExecutorResult>(); const value = await fixture(() => execution.promise); await value.enable();
    const created = await value.create(); expect(created.kind).toBe("ok"); await eventually(async () => (await value.service.list())[0]?.status === "RUNNING");
    expect(await value.create()).toMatchObject({ kind: "conflict" });
    await value.store.addMessage("you", "An unrelated room message", "chat", undefined, undefined, { id: "human", name: "Human" });
    execution.resolve({ summary: "Public result without <thinking>hidden</thinking> ghp_abcdefghijklmnopqrstuvwxyz", relevance: ["task-1"], usage: { tokens: 3, toolCalls: 1 } });
    await eventually(async () => (await value.service.list())[0]?.status === "COMPLETED");
    expect((await value.service.inbox("codex-sol"))[0]).toMatchObject({ status: "UNREAD", summary: "Public result without [REDACTED] [REDACTED]" });
    expect(value.store.snapshot().messages.at(-1)?.text).toBe("An unrelated room message");
  });

  it("fences cancellation against a late executor result", async () => {
    const execution = deferred<ContinuationExecutorResult>(); const value = await fixture(() => execution.promise); await value.enable(); const created = await value.create(); if (created.kind !== "ok") throw new Error("create failed");
    await eventually(async () => (await value.service.list())[0]?.status === "RUNNING"); expect(await value.service.cancel(created.value.jobId)).toMatchObject({ kind: "ok", value: { status: "CANCELLED" } });
    execution.resolve({ summary: "too late", usage: { tokens: 1, toolCalls: 0 } }); await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await value.service.inbox("codex-sol")).toEqual([]); expect((await value.service.list())[0]?.status).toBe("CANCELLED");
  });

  it("reconciles orphaned running jobs to blocked, never running", async () => {
    const execution = deferred<ContinuationExecutorResult>(); const value = await fixture(() => execution.promise); await value.enable(); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "RUNNING");
    const restarted = new ContinuationService(value.store, value.store, { authorityForContinuation: async () => undefined } as unknown as AssignmentLifecycleService, { dispatch: async () => execution.promise });
    await restarted.reconcile(); expect((await restarted.list())[0]).toMatchObject({ status: "BLOCKED", blocker: expect.stringContaining("server restart") });
  });

  it("uses deterministic bounded retry/backoff and terminates after a successful retry", async () => {
    let clock = new Date("2026-08-24T12:00:00.000Z"); let attempts = 0;
    const value = await fixture(async () => { attempts += 1; if (attempts === 1) throw new Error("transient provider failure"); return { summary: "Recovered", usage: { tokens: 4, toolCalls: 1 } }; }, () => clock);
    await value.enable(); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "BLOCKED");
    const blocked = (await value.service.list())[0]!; expect(blocked).toMatchObject({ usage: { attempts: 1 }, nextEligibilityAt: "2026-08-24T12:00:05.000Z" }); expect(await value.service.resume(blocked.jobId)).toMatchObject({ kind: "conflict", reason: "Retry backoff has not elapsed." });
    clock = new Date("2026-08-24T12:00:05.000Z"); expect((await value.service.resume(blocked.jobId)).kind).toBe("ok"); await eventually(async () => (await value.service.list())[0]?.status === "COMPLETED"); expect((await value.service.list())[0]).toMatchObject({ usage: { attempts: 2, tokens: 4, toolCalls: 1 } });
  });

  it("fails closed on exact budget exhaustion and task supersession", async () => {
    const excessive = await fixture(async () => ({ summary: "over budget", usage: { tokens: 8_001, toolCalls: 0 } })); await excessive.enable(); await excessive.create(); await eventually(async () => (await excessive.service.list())[0]?.status === "FAILED"); expect((await excessive.service.list())[0]?.blocker).toBe("Continuation budget exhausted."); expect(await excessive.service.inbox("codex-sol")).toEqual([]);
    const execution = deferred<ContinuationExecutorResult>(); const superseded = await fixture(() => execution.promise); await superseded.enable(); await superseded.create(); await eventually(async () => (await superseded.service.list())[0]?.status === "RUNNING");
    expect((await superseded.store.applyTaskChange(superseded.task, superseded.task.revision, { kind: "set_description", description: "Superseded" }, { id: "human", roomRole: "owner" }, at)).kind).toBe("accepted"); execution.resolve({ summary: "stale", usage: { tokens: 1, toolCalls: 0 } }); await eventually(async () => (await superseded.service.list())[0]?.status === "FAILED"); expect((await superseded.service.list())[0]?.blocker).toBe("Task revision is stale or superseded.");
  });

  it("fences an emergency-stop race and rejects terminal task authority", async () => {
    const execution = deferred<ContinuationExecutorResult>(); const value = await fixture(() => execution.promise); await value.enable(); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "RUNNING");
    await value.store.updateEmergencyStop(0, { active: true, reason: "human halt" }, { id: "human", role: "OPERATOR", human: true }, at); execution.resolve({ summary: "too late", usage: { tokens: 1, toolCalls: 0 } }); await eventually(async () => (await value.service.list())[0]?.status === "CANCELLED"); expect(await value.service.inbox("codex-sol")).toEqual([]);
    const terminal = await fixture(async () => ({ summary: "unused", usage: { tokens: 1, toolCalls: 0 } })); await terminal.enable(); const changed = await terminal.store.applyTaskChange(terminal.task, terminal.task.revision, { kind: "transition", to: "abandoned" }, { id: "human", roomRole: "owner" }, at); if (changed.kind !== "accepted") throw new Error("terminal setup failed");
    expect(await terminal.service.create({ owner: "codex-sol", developerMemberId: "dev-1", developerMemberConfigRevision: 1, taskId: changed.task.taskId, taskRevision: changed.task.revision, assignmentReferenceId: "assignment-ref", objective: "Continue", trigger: "test" })).toMatchObject({ kind: "rejected", reason: "Task is not active continuation authority." });
  });

  it("injects bounded relevant context without consuming it, then explicitly acknowledges, closes, and TTL-archives", async () => {
    let clock = new Date("2026-08-24T12:00:00.000Z"); const value = await fixture(async () => ({ summary: "abcdefghij", relevance: ["task-1"], usage: { tokens: 1, toolCalls: 0 } }), () => clock); await value.enable(); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "COMPLETED");
    expect(await value.service.contextForAgent("codex-sol", { taskId: "other", characterBudget: 5 })).toEqual([]);
    const context = await value.service.contextForAgent("codex-sol", { taskId: "task-1", characterBudget: 5, limit: 1 }); expect(context).toMatchObject([{ summary: "abcde", taskId: "task-1" }]);
    let inbox = (await value.service.inbox("codex-sol"))[0]!; expect(inbox.status).toBe("UNREAD"); expect((await value.service.acknowledgeInbox(inbox.inboxEntryId)).kind).toBe("ok"); inbox = (await value.service.inbox("codex-sol"))[0]!; expect(inbox.status).toBe("ACKNOWLEDGED"); expect((await value.service.acknowledgeInbox(inbox.inboxEntryId, true)).kind).toBe("ok"); expect((await value.service.list())[0]?.status).toBe("ACKNOWLEDGED");
    await value.create(); await eventually(async () => (await value.service.list()).some((job) => job.status === "COMPLETED" && job.jobId !== inbox.jobId));
    clock = new Date("2026-09-01T12:00:00.000Z"); expect((await value.service.inbox("codex-sol")).map((entry) => entry.status).sort()).toEqual(["ARCHIVED", "CLOSED"]);
  });
});
