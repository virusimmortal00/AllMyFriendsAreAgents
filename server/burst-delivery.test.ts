import { describe, expect, it, vi } from "vitest";
import { deliverBurst } from "./burst-delivery.js";
import { RoomActivity } from "./room-activity.js";

describe("burst delivery", () => {
  it("stores each explicit unit separately and allows unrelated agent activity between units", async () => {
    vi.useFakeTimers();
    const activity = new RoomActivity();
    const delivered: string[] = [];
    const burst = deliverBurst({
      messages: ["first", "second"],
      activity,
      revision: activity.current(),
      firstDelayMs: 0,
      deliver: async (message) => { delivered.push(message); },
      cancel: async () => undefined,
    });
    await Promise.resolve();
    delivered.push("other agent");

    await vi.runAllTimersAsync();

    await expect(burst).resolves.toBe(true);
    expect(delivered).toEqual(["first", "other agent", "second"]);
    vi.useRealTimers();
  });

  it("cancels unsent continuation units as soon as human activity supersedes them", async () => {
    vi.useFakeTimers();
    const activity = new RoomActivity();
    const delivered: string[] = [];
    const cancel = vi.fn(async () => undefined);
    const burst = deliverBurst({
      messages: ["first", "stale second", "stale third"],
      activity,
      revision: activity.current(),
      firstDelayMs: 0,
      deliver: async (message) => { delivered.push(message); },
      cancel,
    });
    await Promise.resolve();

    activity.interrupt();

    await expect(burst).resolves.toBe(false);
    expect(delivered).toEqual(["first"]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("does not commit a unit when activity changes during its pre-delivery work", async () => {
    const activity = new RoomActivity();
    const delivered: string[] = [];
    const cancel = vi.fn(async () => undefined);

    await expect(deliverBurst({
      messages: ["stale"],
      activity,
      revision: activity.current(),
      firstDelayMs: 0,
      deliver: async (message) => {
        activity.interrupt();
        if (!activity.isCurrent(0)) return false;
        delivered.push(message);
      },
      cancel,
    })).resolves.toBe(false);

    expect(delivered).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
