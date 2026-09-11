import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyDefaultRoomAgentRoster } from "../shared/roster.js";
import { RoomStore } from "./room-store.js";
import { SqliteRoomRepository } from "./storage/sqlite-room-repository.js";
import { InvestigationStore } from "./investigation-store.js";
import { InvestigationService, type InvestigationExecutorInput, type InvestigationExecutorResult } from "./investigation-service.js";
import { ParticipantReservations, ProtectedWorkStore, type ProtectedReturnReport, type ProtectedWorkRetention } from "./protected-work-store.js";
import { ProtectedReturnCapacityError, ProtectedWorkService } from "./protected-work-service.js";
import { protectedReturnCursor } from "./protected-return.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(backend: "json" | "sqlite" = "json", retention: Partial<ProtectedWorkRetention> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-protected-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const rooms = backend === "json" ? await RoomStore.open(root, path.join(root, "room")) : await SqliteRoomRepository.open(root, path.join(root, "room.sqlite"));
  if (rooms instanceof SqliteRoomRepository) cleanup.push(async () => rooms.close());
  await rooms.updateRoster(rooms.snapshot().roster!.revision, legacyDefaultRoomAgentRoster().entries);
  let foreground = false, confirmed = true;
  const reservations = new ParticipantReservations(() => foreground);
  const inputs: InvestigationExecutorInput[] = [];
  let complete!: (result: InvestigationExecutorResult) => void;
  let reject!: (error: Error) => void;
  const executor = { dispatch: (input: InvestigationExecutorInput) => {
    inputs.push(input); return new Promise<InvestigationExecutorResult>((resolve, no) => { complete = resolve; reject = no; });
  }, confirmStopped: vi.fn(async () => confirmed) };
  const investigations = new InvestigationService(await InvestigationStore.open(path.join(root, "work")), rooms, executor,
    { configuredEnabled: true, ownerAllowed: (owner, workId) => reservations.allows(owner, workId) });
  await investigations.initialize();
  cleanup.push(async () => { await investigations.shutdown(); reject?.(new Error("cleanup")); await expect.poll(() => investigations.activeCount()).toBe(0); });
  const work = await ProtectedWorkStore.open(path.join(root, "protected"), retention);
  const runReturn = vi.fn(async (): Promise<ProtectedReturnReport> => ({ text: "Here are the relevant findings.", relevance: "relevant" as const, cursor: protectedReturnCursor(rooms.snapshot()) }));
  const options = { roomId: rooms.roomId, canStart: () => true, departureCursor: () => rooms.snapshot().messages.at(-1)?.id ?? null,
    cursor: () => protectedReturnCursor(rooms.snapshot()), hasDelivered: (workId: string) => rooms.snapshot().messages.some((message) => message.id === `command-delivery:${workId}:0`),
    runReturn, scheduleReturn: async (_workId: string, operation: () => Promise<void>) => operation(),
    deliver: vi.fn(async (record: any) => { if (record.report.cursor !== protectedReturnCursor(rooms.snapshot())) return false; await rooms.addCommandDeliveryMessageOnce(record.workId, 0, record.owner, record.report.text); return true; }),
  };
  const service = new ProtectedWorkService(work, investigations, reservations, options);
  await service.initialize(); cleanup.push(() => service.shutdown());
  const start = (requestId = "request-0001") => service.start({ roomId: rooms.roomId, owner: "codex-sol", objective: "Inspect bounded evidence", requestId }, "human:fixture");
  const finish = async () => {
    const investigationId = inputs.at(-1)!.investigationId;
    complete({ providerSessionId: `worker-private-${inputs.length}`, summary: "Durable finding", evidenceRefs: [], usage: { tokens: 1, toolCalls: 1 } });
    await expect.poll(async () => (await investigations.list()).find((job) => job.investigationId === investigationId)?.status).toBe("COMPLETED");
  };
  return { root, rooms, work, service, investigations, inputs, reservations, start, finish, options, runReturn, executor,
    foreground: (value: boolean) => { foreground = value; }, confirmed: (value: boolean) => { confirmed = value; },
    complete: () => complete({ providerSessionId: "late-private", summary: "Late output must be discarded", usage: { tokens: 1, toolCalls: 0 } }) };
}

describe("protected participation", () => {
  it("atomically excludes foreground and concurrent admission, preserves ordinary chat/topic activity and rejects ordinary investigation dispatch", async () => {
    const f = await fixture();
    f.foreground(true); await expect(f.start()).rejects.toThrow(/active/); f.foreground(false);
    const starts = await Promise.allSettled([f.start(), f.start("request-0002")]);
    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect.poll(() => f.inputs.length).toBe(1);
    expect(f.reservations.allows("codex-sol")).toBe(false); expect(f.reservations.allows("claude-sonnet")).toBe(true);
    expect(await f.investigations.request({ owner: "codex-sol", objective: "Bypass", trigger: "Normal request", signal: "AUTHENTICATED_HUMAN" })).toMatchObject({ kind: "rejected" });
    await f.rooms.addMessage("you", "Sol, a new direct invitation"); await f.rooms.updateSettings({ topic: "New topic" });
    expect(f.inputs[0].signal.aborted).toBe(false);
    await f.service.tick(); expect((await f.service.list())[0].phase).toBe("busy");
    await f.finish(); await f.service.tick();
    expect(f.runReturn).toHaveBeenCalledOnce(); expect(f.reservations.allows("codex-sol")).toBe(true);
    expect(f.rooms.snapshot().messages.at(-1)?.text).toBe("Here are the relevant findings.");
  });
  it.each(["message", "topic"] as const)("reassesses no-update when %s changes during final authority validation", async (change) => {
    const f = await fixture(); await f.start(); await expect.poll(() => f.inputs.length).toBe(1); await f.finish();
    f.runReturn.mockImplementation(async () => ({ text: null, relevance: "superseded", cursor: protectedReturnCursor(f.rooms.snapshot()) }));
    const returnBlocker = f.investigations.returnBlocker.bind(f.investigations);
    let changed = false;
    vi.spyOn(f.investigations, "returnBlocker").mockImplementation(async (workId) => {
      const result = await returnBlocker(workId);
      if (!changed && f.runReturn.mock.calls.length === 1) {
        changed = true;
        if (change === "message") await f.rooms.addMessage("you", "New relevant context");
        else await f.rooms.updateSettings({ topic: "Changed return context" });
      }
      return result;
    });
    await f.service.tick();
    expect((await f.service.list())[0].phase).toBe("report-pending");
    expect(f.reservations.allows("codex-sol")).toBe(false);
    expect(f.options.deliver).not.toHaveBeenCalled();
    await f.service.tick();
    expect(f.runReturn).toHaveBeenCalledTimes(2);
    expect((await f.service.list())[0]).toMatchObject({ phase: "available", disposition: "no-update" });
  });
  it("shares pending admission failures and preserves failure on durable replay", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const admission = vi.spyOn(f.investigations, "request").mockImplementation(async () => { await gate; return { kind: "rejected", reason: "Investigations disabled" }; });
    const first = f.start();
    await expect.poll(() => admission.mock.calls.length).toBe(1);
    const second = f.start();
    let completed = false; const outcomes = Promise.allSettled([first, second]).then((value) => { completed = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 10)); expect(completed).toBe(false);
    release();
    expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
    expect(admission).toHaveBeenCalledOnce(); expect(f.reservations.allows("codex-sol")).toBe(true);
    const reopened = await ProtectedWorkStore.open(path.join(f.root, "protected"));
    const restored = new ProtectedWorkService(reopened, f.investigations, new ParticipantReservations(() => false), f.options);
    await restored.initialize(); cleanup.push(() => restored.shutdown());
    await expect(restored.start({ roomId: f.rooms.roomId, owner: "codex-sol", objective: "Inspect bounded evidence", requestId: "request-0001" }, "human:fixture")).rejects.toThrow("Investigations disabled");
  });
  it.each(["tick", "dismiss"] as const)("keeps exclusion until inbox closure succeeds and recovers via %s without duplicate delivery", async (recovery) => {
    const f = await fixture(); const job = await f.start(); await expect.poll(() => f.inputs.length).toBe(1); await f.finish();
    const acknowledge = f.investigations.acknowledge.bind(f.investigations);
    let attempts = 0;
    vi.spyOn(f.investigations, "acknowledge").mockImplementation(async (id, close) => {
      expect(f.reservations.allows("codex-sol")).toBe(false);
      if (++attempts === 1) return { kind: "conflict", reason: "Concurrent inbox update" };
      return acknowledge(id, close);
    });
    await f.service.tick();
    expect((await f.service.list())[0].phase).not.toBe("available");
    expect(f.reservations.allows("codex-sol")).toBe(false);
    if (recovery === "tick") await f.service.tick(); else await f.service.action(job.workId, "dismiss");
    expect((await f.service.list())[0]).toMatchObject({ phase: "available", disposition: "delivered" });
    expect(f.options.deliver).toHaveBeenCalledOnce();
    expect((await f.investigations.inbox("codex-sol"))[0].status).toBe("CLOSED");
  });
  it("does not publish a stale report after dismissal during final authority validation", async () => {
    const f = await fixture(); const job = await f.start(); await expect.poll(() => f.inputs.length).toBe(1); await f.finish();
    const check = f.investigations.returnBlocker.bind(f.investigations); let dismissed = false;
    vi.spyOn(f.investigations, "returnBlocker").mockImplementation(async (id) => {
      const result = await check(id);
      if (!dismissed && f.runReturn.mock.calls.length) { dismissed = true; await f.service.action(job.workId, "dismiss"); }
      return result;
    });
    await f.service.tick();
    expect((await f.service.list())[0]).toMatchObject({ phase: "available", disposition: "no-update" });
    expect(f.options.deliver).not.toHaveBeenCalled();
    expect((await f.investigations.inbox("codex-sol"))[0].status).toBe("CLOSED");
  });
  it("retains exclusion when missing-job recovery loses a race to Stop", async () => {
    const f = await fixture(); const job = await f.start(); await expect.poll(() => f.inputs.length).toBe(1);
    let raced = false;
    vi.spyOn(f.investigations, "list").mockImplementation(async () => {
      if (!raced) { raced = true; await f.service.action(job.workId, "stop"); }
      return [];
    });
    await f.service.tick();
    expect((await f.service.list())[0].phase).toBe("stopping");
    expect(f.reservations.allows("codex-sol")).toBe(false);
    await f.service.tick();
    expect((await f.service.list())[0].phase).toBe("available");
    expect(f.reservations.allows("codex-sol")).toBe(true);
  });
  it("rejects public acknowledgement of a protected inbox while allowing internal return closure", async () => {
    const f = await fixture(); await f.start(); await expect.poll(() => f.inputs.length).toBe(1); await f.finish();
    const entry = (await f.investigations.inbox("codex-sol"))[0];
    expect(await f.investigations.acknowledgePublicInbox(entry.inboxEntryId, true)).toEqual({ kind: "not_found" });
    expect((await f.investigations.inbox("codex-sol"))[0].status).toBe("UNREAD");
    await f.service.tick();
    expect((await f.service.list())[0]).toMatchObject({ phase: "available", disposition: "delivered" });
  });
  it("replays exact admission and rejects a substituted objective under the same request ID", async () => {
    const f = await fixture(); const job = await f.start();
    expect((await f.start()).workId).toBe(job.workId);
    await expect(f.service.start({ roomId: f.rooms.roomId, owner: "codex-sol", objective: "Substitution", requestId: "request-0001" }, "human:fixture")).rejects.toThrow(/different/);
  });
  it("replays archived admission after restart and rejects objective substitution", async () => {
    const f = await fixture("json", { maxTerminalRecords: 1 });
    const first = await f.start("request-archived"); await expect.poll(() => f.inputs.length).toBe(1); await f.finish(); await f.service.tick();
    await f.start("request-current"); await expect.poll(() => f.inputs.length).toBe(2); await f.finish(); await f.service.tick();
    expect((await f.work.list()).map((record) => record.workId)).not.toContain(first.workId);
    await f.service.shutdown();
    const reopened = await ProtectedWorkStore.open(path.join(f.root, "protected"), { maxTerminalRecords: 1 });
    const restored = new ProtectedWorkService(reopened, f.investigations, new ParticipantReservations(() => false), f.options);
    await restored.initialize(); cleanup.push(() => restored.shutdown());
    expect((await restored.start({ roomId: f.rooms.roomId, owner: "codex-sol", objective: "Inspect bounded evidence", requestId: "request-archived" }, "human:fixture")).workId).toBe(first.workId);
    await expect(restored.start({ roomId: f.rooms.roomId, owner: "codex-sol", objective: "Substituted archived objective", requestId: "request-archived" }, "human:fixture")).rejects.toThrow(/different/);
  });
  it("retires terminal backing investigations when archive detail is checkpointed", async () => {
    const f = await fixture("json", { maxTerminalRecords: 1, maxArchiveBytes: 512 });
    const retired = await f.start("request-retired"); await expect.poll(() => f.inputs.length).toBe(1); await f.finish(); await f.service.tick();
    await f.start("request-current"); await expect.poll(() => f.inputs.length).toBe(2); await f.finish(); await f.service.tick();
    expect(await f.work.get(retired.workId)).toBeUndefined();
    expect((await f.investigations.list()).map((job) => job.investigationId)).not.toContain(retired.workId);
    expect(await f.investigations.audit(retired.workId)).toEqual([]);
    const reused = await f.start("request-retired");
    expect(reused.workId).toBe(retired.workId);
    await expect.poll(() => f.inputs.length).toBe(3);
  });
  it("does not poison a reused admission when backing cleanup is temporarily unavailable", async () => {
    const f = await fixture("json", { maxTerminalRecords: 1, maxArchiveBytes: 512 });
    const retired = await f.start("request-cleanup-retry"); await expect.poll(() => f.inputs.length).toBe(1); await f.finish(); await f.service.tick();
    const prune = f.investigations.pruneTerminalProtectedWork.bind(f.investigations);
    let failures = 2;
    vi.spyOn(f.investigations, "pruneTerminalProtectedWork").mockImplementation(async (retainedIds) => {
      if (!retainedIds.includes(retired.workId) && failures > 0) { failures -= 1; throw new Error("Fixture cleanup unavailable."); }
      return prune(retainedIds);
    });
    await f.start("request-newer"); await expect.poll(() => f.inputs.length).toBe(2); await f.finish(); await f.service.tick();
    expect(await f.work.get(retired.workId)).toBeUndefined();
    expect((await f.investigations.list()).map((job) => job.investigationId)).toContain(retired.workId);
    await expect(f.start("request-cleanup-retry")).rejects.toThrow(/cleanup unavailable/);
    expect(await f.work.get(retired.workId)).toBeUndefined();
    expect((await f.start("request-cleanup-retry")).workId).toBe(retired.workId);
    await expect.poll(() => f.inputs.length).toBe(3);
  });
  it("forces pre-admission cleanup even when the retention generation appears current", async () => {
    const f = await fixture();
    const requestId = "request-stale-cleanup-generation";
    const workId = `protected-${createHash("sha256").update(JSON.stringify([f.rooms.roomId, "human:fixture", requestId])).digest("hex")}`;
    const orphan = await f.investigations.request({ investigationId: workId, owner: "codex-sol", objective: "Stale backing job",
      trigger: "Protected retention fixture", signal: "AUTHENTICATED_HUMAN" });
    expect(orphan.kind).toBe("ok"); await expect.poll(() => f.inputs.length).toBe(1);
    await f.investigations.cancel(workId, "Terminal orphan fixture.");
    f.complete();
    await expect.poll(() => f.investigations.activeCount()).toBe(0);
    expect(await f.work.get(workId)).toBeUndefined();
    expect((await f.start(requestId)).workId).toBe(workId);
    await expect.poll(() => f.inputs.length).toBe(2);
    expect((await f.investigations.list()).filter((job) => job.investigationId === workId)).toHaveLength(1);
  });
  it("waits for confirmed termination, preserves a checkpoint, discards late results, and isolates replacement work", async () => {
    const f = await fixture(); const job = await f.start(); await expect.poll(() => f.inputs.length).toBe(1);
    await f.inputs[0].progress("WAITING_TOOL", "Reading", { summary: "Partial finding", opaqueState: "private-checkpoint" });
    f.confirmed(false); await f.service.action(job.workId, "stop"); expect((await f.service.list())[0].phase).toBe("stopping");
    await f.service.tick(); expect((await f.service.list())[0].phase).toBe("blocked"); expect(f.runReturn).not.toHaveBeenCalled();
    await expect(f.service.action(job.workId, "dismiss")).rejects.toThrow(/termination/);
    f.confirmed(true); await f.service.action(job.workId, "stop"); await f.service.tick();
    expect((await f.work.get(job.workId))?.package).toMatchObject({ summary: "Partial finding", status: "interrupted" });
    f.complete(); await expect.poll(() => f.investigations.activeCount()).toBe(0);
    expect(f.rooms.snapshot().messages.some((message) => message.text.includes("Late output"))).toBe(false);
    const replacement = await f.start("request-0003"); await f.service.action(job.workId, "stop");
    expect(f.reservations.allows("codex-sol", replacement.workId)).toBe(true);
    expect(f.reservations.allows("codex-sol")).toBe(false);
  });
  it("reassesses after chat changes during catch-up and bounds repeated interruptions", async () => {
    const f = await fixture(); await f.start(); await expect.poll(() => f.inputs.length).toBe(1); await f.finish();
    f.runReturn.mockImplementation(async () => { const cursor = protectedReturnCursor(f.rooms.snapshot()); await f.rooms.addMessage("you", "More current context"); return { text: "Obsolete", relevance: "relevant", cursor }; });
    for (let i = 0; i < 4; i++) await f.service.tick();
    expect(f.runReturn).toHaveBeenCalledTimes(3); expect((await f.service.list())[0].phase).toBe("blocked");
    expect(f.options.deliver).not.toHaveBeenCalled(); expect(f.reservations.allows("codex-sol")).toBe(false);
    await f.service.action((await f.service.list())[0].workId, "dismiss"); expect(f.reservations.allows("codex-sol")).toBe(true);
  });
  it("blocks return after policy revocation and releases only through an explicit no-update disposition", async () => {
    const f = await fixture(); const job = await f.start(); await expect.poll(() => f.inputs.length).toBe(1); await f.finish();
    const policy = (await f.investigations.policy())!; await f.investigations.updatePolicy(policy.revision, false, "fixture");
    await f.service.tick(); expect((await f.service.list())[0].phase).toBe("blocked"); expect(f.runReturn).not.toHaveBeenCalled();
    await f.service.action(job.workId, "dismiss"); expect((await f.service.list())[0].disposition).toBe("no-update");
  });
  it("waits for shared capacity without exhausting its assessment budget", async () => {
    const f = await fixture(); const job = await f.start(); await expect.poll(() => f.inputs.length).toBe(1); await f.finish();
    f.runReturn.mockRejectedValue(new ProtectedReturnCapacityError());
    for (let i = 0; i < 5; i++) await f.service.tick();
    expect(await f.work.get(job.workId)).toMatchObject({ phase: "catching-up", returnAttempts: 0 });
    f.runReturn.mockResolvedValue({ relevance: "relevant", text: "Capacity recovered", cursor: f.options.cursor() });
    await f.service.tick();
    expect(await f.work.get(job.workId)).toMatchObject({ phase: "available", disposition: "delivered", returnAttempts: 1 });
  });
  it("does not reset an exhausted retry budget when an acknowledged retry is replayed", async () => {
    const f = await fixture(); const job = await f.start(); await expect.poll(() => f.inputs.length).toBe(1); await f.finish();
    f.runReturn.mockRejectedValue(new Error("Fixture provider unavailable"));
    for (let i = 0; i < 3; i++) await f.service.tick();
    const request = { actor: "human:fixture", id: "retry-request-0001" };
    await f.service.action(job.workId, "retry-return", request);
    for (let i = 0; i < 3; i++) await f.service.tick();
    expect((await f.work.get(job.workId))?.returnAttempts).toBe(3);
    await f.service.action(job.workId, "retry-return", request); await f.service.tick();
    expect(f.runReturn).toHaveBeenCalledTimes(6);
    expect((await f.service.list())[0].phase).toBe("blocked");
    await expect(f.service.action(job.workId, "dismiss", request)).rejects.toThrow(/different operation/);
  });
  it("bounds unique retry receipts while reserving durable terminal recovery", async () => {
    const f = await fixture("json", { maxActionReceipts: 4, actionRecoveryReserve: 2 });
    const job = await f.start(); await expect.poll(() => f.inputs.length).toBe(1); await f.finish();
    f.runReturn.mockRejectedValue(new Error("Fixture provider unavailable"));
    for (let cycle = 0; cycle < 2; cycle += 1) {
      for (let attempt = 0; attempt < 3; attempt += 1) await f.service.tick();
      await f.service.action(job.workId, "retry-return", { actor: "human:fixture", id: `retry-${cycle}` });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) await f.service.tick();
    await expect(f.service.action(job.workId, "retry-return", { actor: "human:fixture", id: "retry-overflow" })).rejects.toThrow(/receipt budget/);
    expect((await f.work.get(job.workId))?.actions).toHaveLength(2);
    await f.service.action(job.workId, "dismiss", { actor: "human:fixture", id: "dismiss-after-capacity" });
    expect(await f.work.get(job.workId)).toMatchObject({ phase: "available", disposition: "no-update", actions: expect.arrayContaining([expect.objectContaining({ action: "dismiss" })]) });
  });
  it("stops a running worker when its participant configuration is revoked", async () => {
    const f = await fixture(); await f.start(); await expect.poll(() => f.inputs.length).toBe(1);
    const roster = f.rooms.snapshot().roster!;
    await f.rooms.updateRoster(roster.revision, roster.entries.map((entry) => entry.agentId === "codex-sol" ? { ...entry, enabled: false } : entry));
    await f.service.tick();
    expect(f.inputs[0].signal.aborted).toBe(true);
    expect((await f.service.list())[0]).toMatchObject({ phase: "blocked" });
    expect(f.runReturn).not.toHaveBeenCalled();
    expect(f.reservations.allows("codex-sol")).toBe(false);
  });
  it.each(["json", "sqlite"] as const)("recovers delivered-before-ack after reopening the protected store with a %s room without duplicate output", async (backend) => {
    const f = await fixture(backend); const job = await f.start(); await expect.poll(() => f.inputs.length).toBe(1); await f.finish();
    // A third-attempt delivery can crash before acknowledgement and be blocked.
    // Its already visible message must still be reconciled before that phase gate.
    const admitted = (await f.work.get(job.workId))!;
    await f.work.put({ ...admitted, revision: admitted.revision + 1, returnAttempts: 2 }, admitted.revision);
    const put = f.work.put.bind(f.work);
    vi.spyOn(f.work, "put").mockImplementation(async (record, revision) => { if (record.phase === "available") throw new Error("Crash before acknowledgement"); return put(record, revision); });
    await f.service.tick(); await f.service.shutdown();
    expect(f.rooms.snapshot().messages.filter((message) => message.id === `command-delivery:${job.workId}:0`)).toHaveLength(1);
    const reopened = await ProtectedWorkStore.open(path.join(f.root, "protected"));
    const restored = new ProtectedWorkService(reopened, f.investigations, new ParticipantReservations(() => false), f.options);
    await restored.initialize(); cleanup.push(() => restored.shutdown()); await restored.tick();
    expect((await restored.list())[0]).toMatchObject({ phase: "available", disposition: "delivered" });
    expect(f.options.deliver).toHaveBeenCalledOnce(); expect(f.runReturn).toHaveBeenCalledOnce();
  });
});
