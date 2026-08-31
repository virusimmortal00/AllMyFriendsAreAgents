import { describe, expect, it } from "vitest";
import { CoalescingJobQueue, type JobQueueDecision } from "./job-queue.js";
import { currentLogContext, withLogContext } from "./structured-logger.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(assertion: () => void) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}

describe("CoalescingJobQueue", () => {
  it("restores each pending job's enqueue-time context across awaits", async () => {
    const queue = new CoalescingJobQueue();
    const first = deferred();
    const contexts: unknown[] = [];
    const incoming = [
      { requestId: "request-a", traceId: "a".repeat(32), spanId: "1".repeat(16), roomId: "room-a" },
      { requestId: "request-b", traceId: "b".repeat(32), spanId: "2".repeat(16), roomId: "room-b" },
    ];

    for (const [index, context] of incoming.entries()) {
      withLogContext(context, () => queue.enqueue("conversation", async () => {
        if (index === 0) await first.promise;
        contexts.push(currentLogContext());
        await Promise.resolve();
        contexts.push(currentLogContext());
      }));
    }
    first.resolve();
    await eventually(() => expect(queue.busy).toBe(false));

    expect(contexts).toEqual([incoming[0], incoming[0], incoming[1], incoming[1]]);
    expect(currentLogContext()).toBeUndefined();
  });

  it("does not lend the active request's context to context-free background work", async () => {
    const queue = new CoalescingJobQueue();
    const first = deferred();
    const contexts: unknown[] = [];
    withLogContext({ requestId: "request-a", generationId: "generation-a" }, () => {
      queue.enqueue("active", async () => { await first.promise; });
    });
    expect(currentLogContext()).toBeUndefined();
    queue.enqueue("background", async () => {
      contexts.push(currentLogContext());
      await Promise.resolve();
      contexts.push(currentLogContext());
    });

    first.resolve();
    await eventually(() => expect(queue.busy).toBe(false));
    expect(contexts).toEqual([undefined, undefined]);
  });

  it("accepts work while busy and runs it after the active job", async () => {
    const queue = new CoalescingJobQueue();
    const first = deferred();
    const order: string[] = [];

    queue.enqueue("conversation", async () => {
      order.push("first:start");
      await first.promise;
      order.push("first:end");
    });
    expect(queue.busy).toBe(true);
    expect(queue.enqueue("conversation", async () => { order.push("second"); })).toBe(true);
    expect(queue.enqueue("conversation", async () => { order.push("redundant"); })).toBe(false);

    first.resolve();
    await eventually(() => expect(order).toEqual(["first:start", "first:end", "second"]));
    expect(queue.busy).toBe(false);
  });

  it("records admission before dispatch and keeps a duplicate's own request identity", async () => {
    const queue = new CoalescingJobQueue();
    const first = deferred();
    const observations: Array<{ decision: JobQueueDecision; requestId?: string }> = [];
    const observe = (decision: JobQueueDecision) => {
      observations.push({ decision, requestId: currentLogContext()?.requestId });
    };
    const executions: string[] = [];
    withLogContext({ requestId: "request-a" }, () => queue.enqueue("conversation", async ({ jobId }) => {
      expect(observations.map(({ decision }) => decision.action)).toEqual(["queued", "started"]);
      executions.push(jobId);
      await first.promise;
    }, observe));
    withLogContext({ requestId: "request-b" }, () => queue.enqueue("conversation", async ({ jobId }) => { executions.push(jobId); }, observe));
    withLogContext({ requestId: "request-c" }, () => {
      expect(queue.enqueue("conversation", async () => { throw new Error("Discarded callback ran"); }, observe)).toBe(false);
    });

    expect(observations.map(({ decision, requestId }) => [decision.action, requestId])).toEqual([
      ["queued", "request-a"], ["started", "request-a"], ["queued", "request-b"], ["coalesced", "request-c"],
    ]);
    const accepted = observations[2].decision;
    expect(observations[3].decision).toMatchObject({ action: "coalesced", reason: "key-already-pending", jobId: null, retainedJobId: accepted.jobId, pendingCount: 1, active: true });
    expect(observations[3].decision.admissionId).not.toBe(accepted.admissionId);
    first.resolve();
    await eventually(() => expect(queue.busy).toBe(false));
    expect(executions).toEqual([observations[0].decision.jobId, accepted.jobId]);
    expect(observations.at(-1)).toMatchObject({ requestId: "request-b", decision: { action: "started", jobId: accepted.jobId, admissionId: accepted.admissionId } });
    expect(new Set(observations.map(({ decision }) => decision.decisionId)).size).toBe(observations.length);
  });

  it("records shutdown drops in pending jobs' contexts and closed admissions in the caller's context", async () => {
    const queue = new CoalescingJobQueue();
    const first = deferred();
    const observations: Array<{ decision: JobQueueDecision; requestId?: string }> = [];
    const observe = (decision: JobQueueDecision) => { observations.push({ decision, requestId: currentLogContext()?.requestId }); };
    queue.enqueue("active", async () => { await first.promise; }, observe);
    withLogContext({ requestId: "pending-request" }, () => queue.enqueue("pending", async () => { throw new Error("Dropped job ran"); }, observe));
    withLogContext({ requestId: "shutdown-request" }, () => { queue.close(); queue.close(); });
    withLogContext({ requestId: "late-request" }, () => {
      expect(queue.enqueue("late", async () => {}, observe)).toBe(false);
    });
    first.resolve();
    await eventually(() => expect(queue.busy).toBe(false));
    expect(observations.filter(({ decision }) => decision.action === "dropped")).toEqual([
      { requestId: "pending-request", decision: expect.objectContaining({ reason: "queue-closed", jobId: observations[2].decision.jobId, pendingCount: 0 }) },
    ]);
    expect(observations.at(-1)).toMatchObject({ requestId: "late-request", decision: { action: "rejected", reason: "queue-closed", jobId: null, retainedJobId: null } });
  });

  it.each(["throw", "reject", "stall"])("keeps observer %s isolated from queue execution", async (failure) => {
    const queue = new CoalescingJobQueue();
    const executions: string[] = [];
    const observe = () => {
      if (failure === "throw") throw new Error("Observer failed");
      if (failure === "reject") return Promise.reject(new Error("Observer rejected"));
      return new Promise<void>(() => {});
    };
    expect(queue.enqueue("first", async () => { executions.push("first"); }, observe)).toBe(true);
    expect(queue.enqueue("second", async () => { executions.push("second"); }, observe)).toBe(true);
    await eventually(() => expect(queue.busy).toBe(false));
    expect(executions).toEqual(["first", "second"]);
  });

  it("drops pending work and rejects new work after shutdown", async () => {
    const queue = new CoalescingJobQueue();
    const first = deferred();
    const order: string[] = [];
    queue.enqueue("active", async () => {
      order.push("active");
      await first.promise;
    });
    queue.enqueue("pending", async () => { order.push("pending"); });

    queue.close();
    expect(queue.enqueue("late", async () => { order.push("late"); })).toBe(false);
    first.resolve();
    await eventually(() => expect(queue.busy).toBe(false));
    expect(order).toEqual(["active"]);
  });
});
