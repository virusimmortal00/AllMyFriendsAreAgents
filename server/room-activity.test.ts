import { describe, expect, it, vi } from "vitest";
import { RoomActivity } from "./room-activity.js";

describe("RoomActivity", () => {
  it("cancels a pending continuation immediately when room activity changes", async () => {
    vi.useFakeTimers();
    const activity = new RoomActivity();
    const revision = activity.current();
    const continuation = activity.wait(3_500, revision);

    activity.interrupt();

    await expect(continuation).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("allows other activity that does not interrupt the room", async () => {
    vi.useFakeTimers();
    const activity = new RoomActivity();
    const continuation = activity.wait(800, activity.current());

    await vi.advanceTimersByTimeAsync(800);

    await expect(continuation).resolves.toBe(true);
    vi.useRealTimers();
  });
});
