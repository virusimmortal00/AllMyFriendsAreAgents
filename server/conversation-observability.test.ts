import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONVERSATION_EVENT_MAX_BYTES, CONVERSATION_EVIDENCE_ID_MAX_LENGTH, type ConversationJobSource } from "../shared/conversation-observability.js";
import { AuthoritativeLogging, type AuthoritativeStream } from "./authoritative-logging.js";
import { ConversationActivityTracker, ConversationTriggerTrace, conversationSnapshotEvidence, conversationTriggerStageRecord, createConversationJobObserver, enqueueObservedConversation, type ConversationJobLifecycle } from "./conversation-observability.js";
import { LocalFileDiagnosticsQueryService } from "./diagnostics-query.js";
import { CoalescingJobQueue } from "./job-queue.js";
import { RoomActivity } from "./room-activity.js";
import { currentLogContext, withLogContext } from "./structured-logger.js";
import { requiredAt } from "./test-invariants.js";
import type { RoomMessage } from "./types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function idle(queue: CoalescingJobQueue) {
  for (let attempt = 0; attempt < 100 && queue.busy; attempt++) await Promise.resolve();
  expect(queue.busy).toBe(false);
}

class MemorySink extends EventEmitter {
  readonly records: Record<string, unknown>[] = [];
  blocked = false;
  write(line: string) { this.records.push(JSON.parse(line)); return !this.blocked; }
  flush(callback?: () => void) { callback?.(); }
  end() {}
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(realFiles = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-conversation-observation-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sinks = new Map<AuthoritativeStream, MemorySink>();
  const logging = await AuthoritativeLogging.open({
    dataDirectory: root, projectId: "fixture-project", projectPath: "/projects/fixture", roomId: "fixture-room",
    now: () => Date.parse("2026-08-31T12:00:00Z"), maxIdentical: 1,
    ...(realFiles ? {} : { sinkFactory: async (stream: AuthoritativeStream) => {
      const sink = new MemorySink(); sinks.set(stream, sink); return sink;
    } }),
  });
  cleanups.push(async () => {
    for (const sink of sinks.values()) { sink.blocked = false; sink.emit("drain"); }
    await logging.close();
  });
  const queue = new CoalescingJobQueue();
  const activity = new RoomActivity();
  const messages: RoomMessage[] = [{ id: "message-a", speaker: "you", text: "Private fixture message, not routing evidence", timestamp: "2026-08-31T12:00:00Z" }];
  const snapshot = () => ({ messages: [...messages] });
  const dependencies = { queue, logging, activity, snapshot, runJob: async (run: () => Promise<void>) => { await run(); } };
  return { root, sinks, logging, queue, activity, messages, dependencies };
}

describe("conversation job observability", () => {
  it("logs only finite allowlisted trigger telemetry and excludes raw output", async () => {
    const { logging, sinks } = await fixture();
    const trace = new ConversationTriggerTrace("room-message", "message-a", () => 1_000);
    trace.jobId = "job-a";
    const record = conversationTriggerStageRecord(trace, "classifier", {
      outcome: "failed", failureCategory: "schema", durationMs: 250,
      modelOutput: "PRIVATE MODEL OUTPUT", error: "Bearer secret", transcript: "PRIVATE ROOM TEXT",
      costUsd: Number.POSITIVE_INFINITY, reason: "PRIVATE ROOM TEXT",
    });
    expect(record).toEqual({ eventVersion: 1, source: "room-message", queuedTriggerMessageId: "message-a", triggerMessageId: "message-a", jobId: "job-a", stage: "classifier", elapsedMs: 0, outcome: "failed", failureCategory: "schema", durationMs: 250 });
    expect(conversationTriggerStageRecord(trace, "terminal", { reason: "no-material-disagreement" })?.reason).toBe("no-material-disagreement");
    expect(conversationTriggerStageRecord(trace, "generation-completed", { openCodeEstimatedCostUsd: 0.004, providerReportedCostUsd: 9 })).toMatchObject({ openCodeEstimatedCostUsd: 0.004 });
    expect(conversationTriggerStageRecord(trace, "generation-completed", { openCodeEstimatedCostUsd: 0.004, providerReportedCostUsd: 9 })).not.toHaveProperty("providerReportedCostUsd");
    expect(conversationTriggerStageRecord(trace, "PRIVATE ROOM TEXT", { outcome: "failed" })).toBeUndefined();
    await logging.log("generations", "info", "conversation.trigger.stage", record, { visibility: "operator" });
    await logging.flush();
    expect(JSON.stringify(sinks.get("generations")?.records)).not.toMatch(/PRIVATE|Bearer|Infinity/);
  });

  it("rebases consumed trigger timing when a retained job sees a newer human message", () => {
    let now = Date.parse("2026-08-31T12:00:00Z");
    const trace = new ConversationTriggerTrace("room-message", "old-message", () => now);
    now += 4_000;
    trace.consume("new-message", new Date(now - 200).toISOString());
    expect(trace.queuedTriggerMessageId).toBe("old-message");
    expect(trace.triggerMessageId).toBe("new-message");
    expect(trace.sinceQueueMs()).toBe(4_000);
    expect(trace.sinceAcceptedMs()).toBe(200);
  });

  it("keeps room actions unattributed to an earlier human trigger", () => {
    let now = 1_000;
    const trace = new ConversationTriggerTrace("room-action", null, () => now);
    now = 1_200;
    expect(trace.triggerMessageId).toBeNull();
    expect(trace.queuedTriggerMessageId).toBeNull();
    expect(trace.sinceAcceptedMs()).toBe(200);
    expect(conversationTriggerStageRecord(trace, "consumed", { queueDelayMs: 200 })).toMatchObject({
      triggerMessageId: null,
      queuedTriggerMessageId: null,
      queueDelayMs: 200,
    });
  });

  it("keeps deciding visible through overlapping preparation until the job settles", () => {
    const phases: Array<string | undefined> = [];
    let tracker!: ConversationActivityTracker;
    tracker = new ConversationActivityTracker(() => phases.push(tracker.snapshot()?.phase));
    const base = { decisionId: "decision", admissionId: "admission", key: "room-message", active: false, pendingCount: 1 };
    tracker.observe({ stage: "decision", elapsedMs: 0, decision: { ...base, action: "queued", reason: "eligible", jobId: "job", retainedJobId: null } });
    tracker.observe({ stage: "decision", elapsedMs: 10, decision: { ...base, action: "started", reason: "queue-ready", jobId: "job", retainedJobId: null } });
    tracker.preparing("job");
    expect(tracker.snapshot()).toEqual({ phase: "deciding" });
    tracker.observe({ stage: "settled", job: { jobId: "job", admissionId: "admission" }, elapsedMs: 100 });
    expect(tracker.snapshot()).toBeUndefined();
    expect(phases).toEqual(["queued", "deciding", undefined]);
  });

  it("clears queued activity when a pending job is dropped before generation", () => {
    const tracker = new ConversationActivityTracker(() => {});
    const base = { decisionId: "decision", admissionId: "admission", key: "room-message", active: true, pendingCount: 1 };
    tracker.observe({ stage: "decision", elapsedMs: 0, decision: { ...base, action: "queued", reason: "eligible", jobId: "job", retainedJobId: null } });
    expect(tracker.snapshot()).toEqual({ phase: "queued" });
    tracker.observe({ stage: "decision", elapsedMs: 20, decision: { ...base, action: "dropped", reason: "queue-closed", jobId: "job", retainedJobId: null } });
    expect(tracker.snapshot()).toBeUndefined();
  });

  it("reports bounded queue lifecycle facts from the consumed snapshot and contains observer failures", async () => {
    const { dependencies, queue, logging } = await fixture();
    const lifecycle: ConversationJobLifecycle[] = [];
    enqueueObservedConversation(
      dependencies,
      {
        key: "conversation",
        source: "room-message",
        triggerMessageId: "message-a",
        onLifecycle: (event) => {
          lifecycle.push(event);
          if (event.stage === "consumed") throw new Error("observer failure");
        },
      },
      async () => {},
    );
    await idle(queue);
    await logging.flush();
    expect(lifecycle.map((event) => event.stage)).toEqual(["decision", "decision", "consumed", "settled"]);
    expect(lifecycle[0]).toMatchObject({
      stage: "decision",
      decision: { action: "queued" },
      elapsedMs: expect.any(Number),
    });
    expect(lifecycle[2]).toMatchObject({
      stage: "consumed",
      evidence: { latestHumanMessageId: "message-a" },
      queueDelayMs: expect.any(Number),
    });
    expect(JSON.stringify(lifecycle)).not.toContain("Private fixture message");
  });

  it("records accepted/coalesced requests and the exact newer snapshot consumed by retained work", async () => {
    const { sinks, logging, queue, activity, messages, dependencies } = await fixture();
    const gate = deferred();
    const consumed: Array<{ messageId?: string; requestId?: string; jobId?: string }> = [];
    const enqueue = (requestId: string, triggerMessageId: string, run: Parameters<typeof enqueueObservedConversation>[2]) =>
      withLogContext({ requestId, traceId: requestId.at(-1)!.repeat(32), visibility: "project" }, () =>
        enqueueObservedConversation(dependencies, { key: "conversation", source: "room-message", triggerMessageId }, run));
    const initialMessage = requiredAt(messages, 0, "initial conversation message");

    enqueue("request-a", "message-a", async () => { await gate.promise; });
    messages.push({ ...initialMessage, id: "message-b" }); activity.interrupt();
    enqueue("request-b", "message-b", async (snapshot) => {
      const messageId=snapshot.messages.at(-1)?.id;const context=currentLogContext();
      consumed.push({ ...(messageId?{messageId}:{}), ...(context?.requestId?{requestId:context.requestId}:{}), ...(context?.jobId?{jobId:context.jobId}:{}) });
    });
    messages.push({ ...initialMessage, id: "message-c" }); activity.interrupt();
    let discardedRuns = 0;
    expect(enqueue("request-c", "message-c", async () => { discardedRuns++; })).toBe(false);
    expect(enqueue("request-d", "message-c", async () => { discardedRuns++; })).toBe(false);
    gate.resolve();
    await idle(queue); await logging.flush();

    const records = sinks.get("generations")!.records;
    const accepted = records.find((record) => record.requestId === "request-b" && record.action === "queued")!;
    const duplicates = records.filter((record) => record.action === "coalesced");
    expect(duplicates).toHaveLength(2);
    expect(duplicates.map((record) => record.requestId)).toEqual(["request-c", "request-d"]);
    for (const record of duplicates) expect(record).toMatchObject({ jobId: null, retainedJobId: accepted.jobId, triggerMessageId: "message-c", queued: { activityRevision: 2, latestMessageId: "message-c", latestHumanMessageId: "message-c" } });
    expect(consumed).toEqual([{ messageId: "message-c", requestId: "request-b", jobId: accepted.jobId }]);
    expect(discardedRuns).toBe(0);
    expect(records.find((record) => record.requestId === "request-b" && record.event === "conversation.job.consumed")).toMatchObject({
      jobId: accepted.jobId, admissionId: accepted.admissionId, triggerMessageId: "message-b",
      queued: { activityRevision: 1, latestMessageId: "message-b", latestHumanMessageId: "message-b" },
      consumed: { activityRevision: 2, latestMessageId: "message-c", latestHumanMessageId: "message-c" },
    });
    expect(records.every((record) => record.visibility === "operator" && record.eventVersion === 1)).toBe(true);
    expect(JSON.stringify(records)).not.toContain(initialMessage.text);
    expect(records.every((record) => !Object.hasOwn(record, "runId") && record.generationId === null)).toBe(true);
    expect(logging.metrics().generations.coalesced).toBe(0);
  });

  it.each<ConversationJobSource>(["room-message", "developer-message", "room-action"])("preserves %s origin and creates a background trace without a request", async (source) => {
    const { sinks, queue, logging, dependencies } = await fixture();
    let jobContext = currentLogContext();
    enqueueObservedConversation(dependencies, { key: "fixture", source, triggerMessageId: null }, async () => { jobContext = currentLogContext(); });
    await idle(queue); await logging.flush();
    const records = sinks.get("generations")!.records;
    expect(records.map((record) => record.event)).toEqual(["conversation.job.decision", "conversation.job.decision", "conversation.job.consumed"]);
    expect(records.every((record) => record.source === source && record.requestId === null && record.traceId === jobContext?.traceId)).toBe(true);
    expect(requiredAt(records, 0, "initial background job record").jobId).toBe(jobContext?.jobId);
    expect(currentLogContext()).toBeUndefined();
  });

  it("keeps shutdown disposition under the original pending trace with no consumption", async () => {
    const { sinks, queue, logging, dependencies } = await fixture();
    const gate = deferred();
    enqueueObservedConversation(dependencies, { key: "active", source: "room-action", triggerMessageId: null }, async () => { await gate.promise; });
    withLogContext({ requestId: "pending-request" }, () => enqueueObservedConversation(dependencies, { key: "pending", source: "room-message", triggerMessageId: "pending-message" }, async () => {}));
    withLogContext({ requestId: "shutdown-request" }, () => queue.close());
    withLogContext({ requestId: "late-request" }, () => {
      expect(enqueueObservedConversation(dependencies, { key: "late", source: "room-action", triggerMessageId: null }, async () => {})).toBe(false);
    });
    gate.resolve(); await idle(queue); await logging.flush();
    const pending = sinks.get("generations")!.records.filter((record) => record.requestId === "pending-request");
    expect(pending.map((record) => record.action)).toEqual(["queued", "dropped"]);
    const queued = requiredAt(pending, 0, "queued pending job record");
    const dropped = requiredAt(pending, 1, "dropped pending job record");
    expect(queued.traceId).toBe(dropped.traceId);
    expect(queued.jobId).toBe(dropped.jobId);
    expect(sinks.get("generations")!.records.at(-1)).toMatchObject({ requestId: "late-request", action: "rejected", jobId: null });
  });

  it("does not wait for a slow destination before completing jobs", async () => {
    const { sinks, queue, logging, dependencies } = await fixture();
    const sink = sinks.get("generations")!;
    sink.blocked = true;
    let completed = false;
    enqueueObservedConversation(dependencies, { key: "fixture", source: "room-action", triggerMessageId: null }, async () => { completed = true; });
    await idle(queue);
    expect(completed).toBe(true);
    expect(sink.listenerCount("drain")).toBeGreaterThan(0);
    expect(logging.metrics().generations.dropped).toBe(0);
    sink.blocked = false; sink.emit("drain");
    await logging.flush();
    expect(sink.records).toHaveLength(3);
  });

  it.each(["throw", "reject"])("contains adapter %s without changing the existing job failure handler", async (failure) => {
    const { queue, dependencies } = await fixture();
    const handled: unknown[] = [];
    const original = new Error("Original job failure");
    const failing = {
      ...dependencies,
      logging: { log: () => { if (failure === "throw") throw new Error("Logger failure"); return Promise.reject(new Error("Logger rejection")); } },
      runJob: async (run: () => Promise<void>) => { try { await run(); } catch (error) { handled.push(error); } },
    };
    enqueueObservedConversation(failing, { key: "fixture", source: "room-action", triggerMessageId: null }, async () => { throw original; });
    await idle(queue);
    expect(handled).toEqual([original]);
  });

  it("bounds optional identity detail without leaking text or claiming unavailable revision evidence", async () => {
    const { queue, sinks, logging } = await fixture();
    const oversized = "x".repeat(10_000);
    const observation = createConversationJobObserver(logging, {
      source: "room-message", triggerMessageId: oversized,
      queued: { latestMessageId: oversized, latestHumanMessageId: oversized, activityRevision: null },
    });
    queue.enqueue(oversized, async (job) => {
      observation.consumed(job, { latestMessageId: "consumed-message", latestHumanMessageId: "consumed-human-message", activityRevision: 2 });
    }, observation.onDecision);
    await idle(queue); await logging.flush();
    const records = sinks.get("generations")!.records;
    expect(records[0]).toMatchObject({ triggerMessageId: null, queueKey: null, omittedDetailCount: 4, queued: { latestMessageId: null, latestHumanMessageId: null, activityRevision: null } });
    expect(records[2]).toMatchObject({ omittedDetailCount: 3, consumed: { latestMessageId: "consumed-message", activityRevision: 2 } });
    expect(records.every((record) => Buffer.byteLength(JSON.stringify(record)) < CONVERSATION_EVENT_MAX_BYTES)).toBe(true);
    expect(conversationSnapshotEvidence({ messages: [] }, 0)).toEqual({ activityRevision: 0, latestMessageId: null, latestHumanMessageId: null });
  });

  it("round-trips real records through OWNER queries alongside raw evidence without granting project access", async () => {
    const { queue, logging, root, dependencies } = await fixture(true);
    const traceId = "a".repeat(32);
    withLogContext({ traceId, requestId: "fixture-request", visibility: "project" }, () => {
      enqueueObservedConversation(dependencies, { key: "fixture", source: "room-message", triggerMessageId: "message-a" }, async () => {
        logging.log("opencode-harness", "info", "fixture.raw", { output: "Keep useful raw failure evidence", authorization: "Bearer fixture-secret" }, { visibility: "project" });
      });
    });
    await idle(queue); await logging.flush();
    // A fresh reader reconstructs persisted evidence without in-memory observer state.
    const service = new LocalFileDiagnosticsQueryService(root, "fixture-project");
    const range = { from: "2026-08-31T00:00:00Z", to: "2026-09-01T00:00:00Z", correlation: { traceId } };
    const owner = { principalId: "fixture-owner", operator: true, projectIds: [], roomIds: [] };
    const result = await service.query(owner, { ...range, scope: "operator" });
    expect(result.records).toHaveLength(4);
    expect(result.records.find((record) => record.event === "conversation.job.consumed")?.content).toMatchObject({ consumed: { latestMessageId: "message-a" }, eventVersion: 1 });
    expect(JSON.stringify(result)).toContain("Keep useful raw failure evidence");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    const member = { ...owner, operator: false, projectIds: ["fixture-project"] };
    expect((await service.query(member, { ...range, scope: "project" })).records.map((record) => record.event)).toEqual(["fixture.raw"]);
    await expect(service.query(member, { ...range, scope: "operator" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("fits the event budget even when every retained optional ID needs JSON escaping", async () => {
    const { queue, logging, sinks } = await fixture();
    const id = "\u0000".repeat(CONVERSATION_EVIDENCE_ID_MAX_LENGTH);
    const evidence = { latestMessageId: id, latestHumanMessageId: id, activityRevision: Number.MAX_SAFE_INTEGER };
    const observation = createConversationJobObserver(logging, { source: "developer-message", triggerMessageId: id, queued: evidence });
    queue.enqueue(id, async (job) => { observation.consumed(job, evidence); }, observation.onDecision);
    await idle(queue); await logging.flush();
    for (const record of sinks.get("generations")!.records) {
      expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(CONVERSATION_EVENT_MAX_BYTES);
    }
  });

  it("does not fabricate consumption when the authoritative execution snapshot fails", async () => {
    const { queue, logging, sinks, dependencies } = await fixture();
    let reads = 0;
    const original = new Error("Snapshot unavailable");
    const handled: unknown[] = [];
    let ran = false;
    enqueueObservedConversation({
      ...dependencies,
      snapshot: () => { if (++reads === 2) throw original; return dependencies.snapshot(); },
      runJob: async (run) => { try { await run(); } catch (error) { handled.push(error); } },
    }, { key: "fixture", source: "room-message", triggerMessageId: "message-a" }, async () => { ran = true; });
    await idle(queue); await logging.flush();
    expect(handled).toEqual([original]);
    expect(ran).toBe(false);
    expect(sinks.get("generations")!.records.map((record) => record.action)).toEqual(["queued", "started"]);
  });
});
