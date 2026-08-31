import { describe, expect, it } from "vitest";
import { CoalescingJobQueue } from "./job-queue.js";
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
