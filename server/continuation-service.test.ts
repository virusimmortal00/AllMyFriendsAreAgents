import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTask } from "../shared/task-domain.js";
import type { AssignmentLifecycleService } from "./assignment-lifecycle.js";
import type { AssignmentRecord } from "./assignment-record.js";
import { ContinuationService, HttpContinuationExecutor, type ContinuationExecutor, type ContinuationExecutorInput, type ContinuationExecutorResult } from "./continuation-service.js";
import { registerContinuationRoutes } from "./continuation-api.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { HumanPresenceRegistry } from "./human-presence.js";
import type { HumanTaskSessions } from "./task-api.js";
import { RoomStore } from "./room-store.js";
import { CANONICAL_ROOM_ID } from "./storage/room-repository.js";

const roots: string[] = []; const at = "2026-08-24T12:00:00.000Z";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function eventually(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 100; i += 1) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); } throw new Error("condition not reached"); }

async function fixture(dispatch: ((input: ContinuationExecutorInput) => Promise<ContinuationExecutorResult>) | ContinuationExecutor, now?: () => Date) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-service-")); roots.push(root); const store = await RoomStore.open(root, path.join(root, "state"));
  await store.updateSettings({ projectPath: root, writableAgent: "codex-sol" });
  const actor = { id: "human", roomRole: "owner" as const }; let task = createTask({ roomId: CANONICAL_ROOM_ID, taskId: "task-1", title: "Durable work", actor, now: at });
  expect((await store.createTask(task)).kind).toBe("created");
  for (const change of [{ kind: "append_reference", reference: { id: "assignment-ref", kind: "assignment", targetId: "assignment-1" } }, { kind: "transition", to: "proposed" }, { kind: "transition", to: "approved" }, { kind: "transition", to: "active" }] as const) { const result = await store.applyTaskChange({ roomId: task.roomId, taskId: task.taskId }, task.revision, change, actor, at); if (result.kind !== "accepted") throw new Error("task setup failed"); task = result.task; }
  const assignment: AssignmentRecord = { assignmentId: "assignment-1", improvementId: "improvement-1", developerMemberId: "dev-1", developerMemberConfigRevision: 1, agent: "codex-sol", fencingToken: 2, manifestRevision: 3, pinnedBaseSha: "a".repeat(40), branch: "work", observedHeadSha: "a".repeat(40), workspacePath: root, lifecycleStatus: "ACTIVE", recovery: { classification: "clean", reconciledAt: at, previousStatus: null, detail: "test" }, createdAt: at, updatedAt: at };
  let authority = async (id: string, owner: string) => id === assignment.assignmentId && owner === assignment.agent ? { kind: "ok" as const, assignment, workspace: root } : { kind: "revoked" as const, reason: "Assignment mismatch." };
  const lifecycle = { authorityForContinuation: (id: string, owner: string) => authority(id, owner) } as unknown as AssignmentLifecycleService;
  const executor = typeof dispatch === "function" ? { dispatch } : dispatch; const service = new ContinuationService(store, store, lifecycle, executor, { now }); await service.initialize();
  return { store, service, task, assignment, setAuthority(next: typeof authority) { authority = next; }, async enable() { const policy = await service.policy(); expect(policy).toBeTruthy(); expect((await service.updatePolicy(policy!.revision, { enabled: true }, "human")).kind).toBe("accepted"); }, create: () => service.create({ owner: "codex-sol", developerMemberId: "dev-1", developerMemberConfigRevision: 1, taskId: task.taskId, taskRevision: task.revision, assignmentReferenceId: "assignment-ref", objective: "Continue the approved task", trigger: "Explicit test trigger" }) };
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
    execution.resolve({ summary: "Public result without ghp_abcdefghijklmnopqrstuvwxyz <thinking>hidden through end", relevance: ["task-1"], usage: { tokens: 3, toolCalls: 1 } });
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
    const restarted = new ContinuationService(value.store, value.store, { authorityForContinuation: async () => ({ kind: "revoked", reason: "Assignment missing." }) } as unknown as AssignmentLifecycleService, { dispatch: async () => execution.promise });
    await restarted.reconcile(); expect((await restarted.list())[0]).toMatchObject({ status: "BLOCKED", blocker: expect.stringContaining("server restart") });
  });

  it("persists pre-dispatch lifecycle rejection without an unhandled rejection", async () => {
    const unhandled: unknown[] = []; const listener = (error: unknown) => unhandled.push(error); process.on("unhandledRejection", listener);
    try {
      const value = await fixture(async () => ({ summary: "unused", usage: { tokens: 0, toolCalls: 0 } })); await value.enable(); let checks = 0; value.setAuthority(async () => { checks += 1; if (checks === 1) return { kind: "ok" as const, assignment: value.assignment, workspace: value.assignment.workspacePath }; throw new Error("revalidation unavailable <thinking>private"); }); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "FAILED"); expect((await value.service.list())[0]?.blocker).toBe("Continuation lifecycle failed: revalidation unavailable [REDACTED]");
      const storage = await fixture(async () => ({ summary: "unused", usage: { tokens: 0, toolCalls: 0 } })); await storage.enable(); vi.spyOn(storage.store, "getContinuation").mockRejectedValueOnce(new Error("storage unavailable <analysis>private")); await storage.create(); await eventually(async () => (await storage.service.list())[0]?.status === "FAILED"); expect((await storage.service.list())[0]?.blocker).toBe("Continuation lifecycle failed: storage unavailable [REDACTED]"); await new Promise((resolve) => setTimeout(resolve, 0)); expect(unhandled).toEqual([]);
    }
    finally { process.off("unhandledRejection", listener); }
  });

  it("fences real waiting-tool progress by attempt, cancellation, and restart", async () => {
    const gate = deferred<void>(); const waiting = deferred<void>(); let input!: ContinuationExecutorInput;
    const value = await fixture(async (next) => { input = next; expect(await next.progress("WAITING_TOOL", "Waiting on test tool")).toBe(true); waiting.resolve(); await gate.promise; expect(await next.progress("RUNNING", "Tool finished")).toBe(true); return { summary: "tool result", usage: { tokens: 2, toolCalls: 1 } }; }); await value.enable(); await value.create(); await waiting.promise; expect((await value.service.list())[0]?.status).toBe("WAITING_TOOL"); gate.resolve(); await eventually(async () => (await value.service.list())[0]?.status === "COMPLETED"); expect(await input.progress("WAITING_TOOL", "stale terminal event")).toBe(false); expect((await value.service.audit((await value.service.list())[0]!.jobId)).map(({ action }) => action)).toEqual(["CREATED", "DISPATCHED", "WAITING_TOOL", "TOOL_RESUMED", "COMPLETED"]);

    const cancelGate = deferred<void>(); let cancelledInput!: ContinuationExecutorInput; const cancelled = await fixture(async (next) => { cancelledInput = next; await next.progress("WAITING_TOOL", "waiting"); await cancelGate.promise; return { summary: "late", usage: { tokens: 1, toolCalls: 1 } }; }); await cancelled.enable(); const created = await cancelled.create(); if (created.kind !== "ok") throw new Error("create failed"); await eventually(async () => (await cancelled.service.list())[0]?.status === "WAITING_TOOL"); await cancelled.service.cancel(created.value.jobId); expect(await cancelledInput.progress("RUNNING", "late")).toBe(false); cancelGate.resolve(); expect((await cancelled.service.list())[0]?.status).toBe("CANCELLED");

    const restartGate = deferred<void>(); const restart = await fixture(async (next) => { await next.progress("WAITING_TOOL", "waiting"); await restartGate.promise; return { summary: "late", usage: { tokens: 1, toolCalls: 1 } }; }); await restart.enable(); await restart.create(); await eventually(async () => (await restart.service.list())[0]?.status === "WAITING_TOOL"); const restarted = new ContinuationService(restart.store, restart.store, { authorityForContinuation: async () => ({ kind: "revoked", reason: "missing" }) } as unknown as AssignmentLifecycleService, { dispatch: async () => ({ summary: "unused", usage: { tokens: 0, toolCalls: 0 } }) }); await restarted.reconcile(); expect((await restarted.list())[0]?.status).toBe("BLOCKED"); restartGate.resolve();
  });

  it("persists authenticated WAITING_TOOL progress from the production HTTP executor and fences stale/cancelled callbacks", async () => {
    const callbackApp = express(); callbackApp.use(express.json()); const callbackServer = callbackApp.listen(0); await new Promise<void>((resolve) => callbackServer.once("listening", resolve)); const callbackBase = `http://127.0.0.1:${(callbackServer.address() as AddressInfo).port}`;
    const secondWaiting = deferred<void>(); const releaseSecond = deferred<void>(); const callbackStatuses: number[] = []; let requests = 0; let receivedBody: Record<string, unknown> = {};
    const remoteApp = express(); remoteApp.use(express.json()); remoteApp.post("/execute", async (request, response) => { try { requests += 1; receivedBody = request.body as Record<string, unknown>; const progress = receivedBody.progress as { url: string; authorization: string }; callbackStatuses.push((await fetch(progress.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" }, body: JSON.stringify({ state: "WAITING_TOOL" }) })).status); callbackStatuses.push((await fetch(progress.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: progress.authorization }, body: JSON.stringify({ state: "WAITING_TOOL", detail: "Remote tool request" }) })).status); callbackStatuses.push((await fetch(progress.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: progress.authorization }, body: JSON.stringify({ state: "WAITING_TOOL" }) })).status); if (requests === 2) { secondWaiting.resolve(); await releaseSecond.promise; } callbackStatuses.push((await fetch(progress.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: progress.authorization }, body: JSON.stringify({ state: "RUNNING", detail: "Remote tool complete" }) })).status); response.json({ summary: requests === 1 ? "HTTP executor result" : "late HTTP result", usage: { tokens: 2, toolCalls: 1 } }); } catch (error) { response.status(500).json({ error: String(error) }); } });
    const remoteServer = remoteApp.listen(0); await new Promise<void>((resolve) => remoteServer.once("listening", resolve)); const remoteUrl = `http://127.0.0.1:${(remoteServer.address() as AddressInfo).port}/execute`;
    try {
      const executor = new HttpContinuationExecutor(remoteUrl, "Bearer executor-secret", callbackBase); const value = await fixture(executor); registerContinuationRoutes({ app: callbackApp, service: value.service, progressChannel: executor, humans: {} as HumanPresenceRegistry, sessions: { humanId: () => undefined } as unknown as HumanTaskSessions, developers: {} as DeveloperTeamRegistry, broadcast() {} }); await value.enable(); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "COMPLETED");
      expect(callbackStatuses.slice(0, 4)).toEqual([401, 202, 409, 202]); expect((await value.service.audit((await value.service.list())[0]!.jobId)).map(({ action }) => action)).toEqual(["CREATED", "DISPATCHED", "WAITING_TOOL", "TOOL_RESUMED", "COMPLETED"]); expect(JSON.stringify(receivedBody)).not.toContain("executor-secret"); expect(receivedBody).toMatchObject({ excludedCapabilities: expect.arrayContaining(["PUSH", "MERGE", "DEPLOY", "PUBLISH"]), capabilities: ["ANALYZE", "EDIT_ASSIGNMENT_WORKSPACE", "RUN_TESTS"] });
      const second = await value.create(); if (second.kind !== "ok") throw new Error("second create failed"); await secondWaiting.promise; await eventually(async () => (await value.service.list()).find((job) => job.jobId === second.value.jobId)?.status === "WAITING_TOOL"); await value.service.cancel(second.value.jobId); releaseSecond.resolve(); await eventually(() => callbackStatuses.length === 8); expect(callbackStatuses.slice(4)).toEqual([401, 202, 409, 409]); expect((await value.service.list()).find((job) => job.jobId === second.value.jobId)).toMatchObject({ status: "CANCELLED", cancellationRequested: true });
    } finally { releaseSecond.resolve(); await Promise.all([new Promise<void>((resolve) => callbackServer.close(() => resolve())), new Promise<void>((resolve) => remoteServer.close(() => resolve()))]); }
  });

  it("uses deterministic bounded retry/backoff and terminates after a successful retry", async () => {
    let clock = new Date("2026-08-24T12:00:00.000Z"); let attempts = 0;
    const value = await fixture(async () => { attempts += 1; if (attempts === 1) throw new Error("transient provider failure"); return { summary: "Recovered", usage: { tokens: 4, toolCalls: 1 } }; }, () => clock);
    await value.enable(); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "BLOCKED");
    const blocked = (await value.service.list())[0]!; expect(blocked).toMatchObject({ usage: { attempts: 1 }, nextEligibilityAt: "2026-08-24T12:00:05.000Z" }); const retryAudit = (await value.service.audit(blocked.jobId)).at(-1)!; expect(retryAudit).toMatchObject({ action: "RETRY_BLOCKED", attempt: 1, result: "transient provider failure", nextEligibilityAt: "2026-08-24T12:00:05.000Z", attemptUsage: { tokens: 0, toolCalls: 0 } }); expect(retryAudit.attemptUsage.elapsedMs).toBe(blocked.usage.elapsedMs); expect(await value.service.resume(blocked.jobId)).toMatchObject({ kind: "conflict", reason: "Retry backoff has not elapsed." });
    clock = new Date("2026-08-24T12:00:05.000Z"); expect((await value.service.resume(blocked.jobId)).kind).toBe("ok"); const resumedAudit = (await value.service.audit(blocked.jobId)).at(-1)!; expect(resumedAudit).toMatchObject({ action: "RESUMED", attempt: 1, result: "Retry/resume authorized.", nextEligibilityAt: null, attemptUsage: { elapsedMs: 0, tokens: 0, toolCalls: 0 } }); await eventually(async () => (await value.service.list())[0]?.status === "COMPLETED"); expect((await value.service.list())[0]).toMatchObject({ usage: { attempts: 2, tokens: 4, toolCalls: 1 } }); expect((await value.service.audit(blocked.jobId)).at(-1)).toMatchObject({ action: "COMPLETED", attempt: 2, result: "Recovered", attemptUsage: { tokens: 4, toolCalls: 1 } });
  });

  it("does not register an AbortController when cumulative time is already exhausted", async () => {
    let clock = new Date("2026-08-24T12:00:00.000Z"); let dispatches = 0; let monotonicNow = 0; const dateNow = vi.spyOn(Date, "now").mockImplementation(() => monotonicNow);
    try { const value = await fixture(async () => { dispatches += 1; monotonicNow = 60_000; throw new Error("first failure"); }, () => clock); await value.enable(); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "BLOCKED"); expect((await value.service.list())[0]?.usage.elapsedMs).toBe(60_000); clock = new Date("2026-08-24T12:00:05.000Z"); await value.service.resume((await value.service.list())[0]!.jobId); await eventually(async () => (await value.service.list())[0]?.status === "FAILED"); expect(dispatches).toBe(1); expect(value.service.activeExecutorCount()).toBe(0); }
    finally { dateNow.mockRestore(); }
  });

  it("fails closed on exact budget exhaustion and task supersession", async () => {
    const excessive = await fixture(async () => ({ summary: "over budget", usage: { tokens: 8_001, toolCalls: 0 } })); await excessive.enable(); await excessive.create(); await eventually(async () => (await excessive.service.list())[0]?.status === "FAILED"); expect((await excessive.service.list())[0]?.blocker).toBe("Continuation budget exhausted."); expect(await excessive.service.inbox("codex-sol")).toEqual([]);
    const execution = deferred<ContinuationExecutorResult>(); const superseded = await fixture(() => execution.promise); await superseded.enable(); await superseded.create(); await eventually(async () => (await superseded.service.list())[0]?.status === "RUNNING");
    expect((await superseded.store.applyTaskChange(superseded.task, superseded.task.revision, { kind: "set_description", description: "Superseded" }, { id: "human", roomRole: "owner" }, at)).kind).toBe("accepted"); execution.resolve({ summary: "stale", usage: { tokens: 1, toolCalls: 0 } }); await eventually(async () => (await superseded.service.list())[0]?.status === "CANCELLED"); expect((await superseded.service.list())[0]).toMatchObject({ blocker: "Task revision is stale or superseded.", cancellationRequested: true });
  });

  it("fences an emergency-stop race and rejects terminal task authority", async () => {
    const execution = deferred<ContinuationExecutorResult>(); const value = await fixture(() => execution.promise); await value.enable(); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "RUNNING");
    await value.store.updateEmergencyStop(0, { active: true, reason: "human halt" }, { id: "human", role: "OPERATOR", human: true }, at); execution.resolve({ summary: "too late", usage: { tokens: 1, toolCalls: 0 } }); await eventually(async () => (await value.service.list())[0]?.status === "CANCELLED"); expect(await value.service.inbox("codex-sol")).toEqual([]);
    const terminal = await fixture(async () => ({ summary: "unused", usage: { tokens: 1, toolCalls: 0 } })); await terminal.enable(); const changed = await terminal.store.applyTaskChange(terminal.task, terminal.task.revision, { kind: "transition", to: "abandoned" }, { id: "human", roomRole: "owner" }, at); if (changed.kind !== "accepted") throw new Error("terminal setup failed");
    expect(await terminal.service.create({ owner: "codex-sol", developerMemberId: "dev-1", developerMemberConfigRevision: 1, taskId: changed.task.taskId, taskRevision: changed.task.revision, assignmentReferenceId: "assignment-ref", objective: "Continue", trigger: "test" })).toMatchObject({ kind: "rejected", reason: "Task is not active continuation authority." });
  });

  it("classifies project, policy, capability, claim, and assignment-epoch revocations as precise cancellations", async () => {
    const runRevocation = async (reason: string, revoke: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void) => { const execution = deferred<ContinuationExecutorResult>(); const value = await fixture(() => execution.promise); await value.enable(); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "RUNNING"); await revoke(value); execution.resolve({ summary: "late", usage: { tokens: 1, toolCalls: 0 } }); await eventually(async () => (await value.service.list())[0]?.status === "CANCELLED"); expect((await value.service.list())[0]).toMatchObject({ cancellationRequested: true, blocker: reason }); };
    await runRevocation("Continuation policy revision changed.", async (value) => { const policy = await value.service.policy(); await value.service.updatePolicy(policy!.revision, { enabled: false }, "human"); });
    await runRevocation("Continuation policy does not match the current room project.", (value) => value.store.updateSettings({ projectPath: `${value.assignment.workspacePath}/changed` }));
    await runRevocation("Developer-team identity or assignment capability changed", (value) => value.setAuthority(async () => ({ kind: "revoked", reason: "Developer-team identity or assignment capability changed" })));
    await runRevocation("An active, unexpired, correctly fenced work claim is required", (value) => value.setAuthority(async () => ({ kind: "revoked", reason: "An active, unexpired, correctly fenced work claim is required" })));
    await runRevocation("Assignment authority epoch changed.", (value) => value.setAuthority(async () => ({ kind: "ok", assignment: { ...value.assignment, fencingToken: value.assignment.fencingToken + 1 }, workspace: value.assignment.workspacePath })));
  });

  it("injects bounded relevant context without consuming it, then explicitly acknowledges, closes, and TTL-archives", async () => {
    let clock = new Date("2026-08-24T12:00:00.000Z"); const value = await fixture(async () => ({ summary: "abcdefghij", relevance: ["task-1"], usage: { tokens: 1, toolCalls: 0 } }), () => clock); await value.enable(); await value.create(); await eventually(async () => (await value.service.list())[0]?.status === "COMPLETED");
    expect(await value.service.contextForAgent("codex-sol", { taskId: "other", characterBudget: 5 })).toEqual([]);
    const context = await value.service.contextForAgent("codex-sol", { taskId: "task-1", characterBudget: 5, limit: 1 }); expect(context).toMatchObject([{ summary: "abcde", taskId: "task-1" }]);
    const provenance = { taskId: "task-1", assignmentId: "assignment-1", assignmentReferenceId: "assignment-ref", developerMemberId: "dev-1", developerMemberConfigRevision: 1 };
    expect(await value.service.contextForDeveloper("codex-sol", provenance)).toHaveLength(1); expect(await value.service.contextForDeveloper("codex-sol", { ...provenance, assignmentId: "historical-assignment" })).toEqual([]); expect(await value.service.contextForDeveloper("codex-sol", { ...provenance, assignmentReferenceId: "other-ref" })).toEqual([]); expect(await value.service.contextForDeveloper("codex-sol", { ...provenance, developerMemberConfigRevision: 2 })).toEqual([]);
    let inbox = (await value.service.inbox("codex-sol"))[0]!; expect(inbox.status).toBe("UNREAD"); expect((await value.service.acknowledgeInbox(inbox.inboxEntryId)).kind).toBe("ok"); inbox = (await value.service.inbox("codex-sol"))[0]!; expect(inbox.status).toBe("ACKNOWLEDGED"); expect((await value.service.acknowledgeInbox(inbox.inboxEntryId, true)).kind).toBe("ok"); expect((await value.service.list())[0]?.status).toBe("ACKNOWLEDGED");
    await value.create(); await eventually(async () => (await value.service.list()).some((job) => job.status === "COMPLETED" && job.jobId !== inbox.jobId));
    clock = new Date("2026-09-01T12:00:00.000Z"); expect((await value.service.inbox("codex-sol")).map((entry) => entry.status).sort()).toEqual(["ARCHIVED", "CLOSED"]); expect((await value.service.list()).find((job) => job.jobId !== inbox.jobId)).toMatchObject({ resultDisposition: "ARCHIVED", jobRevision: 4 });
  });
});
