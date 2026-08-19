import { describe, expect, it } from "vitest";
import { CoalescingJobQueue } from "./job-queue.js";

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
});
