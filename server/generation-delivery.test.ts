import { describe, expect, it, vi } from "vitest";
import type { GenerationDeliverySummary } from "../shared/conversation-observability.js";
import { GenerationDeliveryLedger, withGenerationDelivery } from "./generation-delivery.js";
import { deliverBurst } from "./burst-delivery.js";
import { RoomActivity } from "./room-activity.js";

describe("generation delivery accounting", () => {
  it("accounts for interruption in the real paced burst path", async () => {
    const activity = new RoomActivity();
    const result = await withGenerationDelivery(3, () => {}, async (ledger) => {
      const completed = await deliverBurst({
        messages: ["one", "two", "three"], activity, revision: activity.current(), firstDelayMs: 0,
        cancel: async () => {},
        deliver: async (_message, sequence) => {
          await ledger.write(sequence, async () => ({ id: `message-${sequence}` }));
          activity.interrupt();
        },
      });
      ledger.finish(completed ? "delivered" : "cancelled", completed ? "burst-delivered" : "burst-interrupted");
      return { cancelled: !completed };
    });
    expect(result.delivery).toMatchObject({ confirmedDeliveredBurstCount: 1, confirmedUndeliveredBurstCount: 2, unconfirmedBurstCount: 0 });
  });

  it("preserves confirmed writes when later cursor or disposition work throws", async () => {
    const finalize = vi.fn();
    const failure = new Error("Post-delivery state update failed");
    await expect(withGenerationDelivery(1, finalize, async (ledger) => {
      await ledger.write(0, async () => ({ id: "one" }));
      ledger.finish("delivered", "burst-delivered");
      throw failure;
    })).rejects.toBe(failure);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", confirmedDeliveredBurstCount: 1, unconfirmedBurstCount: 0 }));
  });
  it("finalizes zero-message output exactly once", async () => {
    const finalize = vi.fn();
    const result = await withGenerationDelivery(0, finalize, async (ledger) => {
      ledger.finish("no_response", "no-visible-output"); return { visibleMessageCount: 0 };
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(result.delivery).toMatchObject({ outcome: "no_response", confirmedDeliveredBurstCount: 0, confirmedUndeliveredBurstCount: 0, unconfirmedBurstCount: 0 });
  });

  it("retains confirmed delivery on cancellation without changing the scheduler-facing result", async () => {
    const result = await withGenerationDelivery(3, () => {}, async (ledger) => {
      await ledger.write(0, async () => ({ id: "message-one" }));
      ledger.finish("cancelled", "burst-interrupted"); return { cancelled: true };
    });
    expect(result).not.toHaveProperty("visibleMessageCount");
    expect(result.delivery).toMatchObject({ outcome: "cancelled", confirmedDeliveredBurstCount: 1, confirmedUndeliveredBurstCount: 2, unconfirmedBurstCount: 0, acknowledgedMessageIds: ["message-one"] });
  });

  it.each([false, true])("preserves an uncertain acknowledgement after a thrown write (commit=%s)", async (commit) => {
    const stored: string[] = [];
    const failure = new Error("Fixture write failure");
    const finalized: GenerationDeliverySummary[] = [];
    await expect(withGenerationDelivery(3, (summary) => { finalized.push(summary); }, async (ledger) => {
      await ledger.write(0, async () => { stored.push("one"); return { id: "one" }; });
      await ledger.write(1, async () => { if (commit) stored.push("two"); throw failure; });
      return {};
    })).rejects.toBe(failure);
    expect(stored).toHaveLength(commit ? 2 : 1);
    expect(finalized).toEqual([expect.objectContaining({ outcome: "failed", reason: "message-write-unconfirmed", confirmedDeliveredBurstCount: 1, confirmedUndeliveredBurstCount: 1, unconfirmedBurstCount: 1 })]);
  });

  it("does not infer insertion counts or suppress writes when an idempotent sequence is replayed", async () => {
    const ledger = new GenerationDeliveryLedger(1);
    const persist = vi.fn(async () => ({ id: "existing-message" }));
    await ledger.write(0, persist); await ledger.write(0, persist);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(ledger.snapshot()).toMatchObject({ confirmedDeliveredBurstCount: 1, acknowledgedMessageIds: ["existing-message"] });
    expect(ledger.snapshot()).not.toHaveProperty("insertedMessageCount");
  });

  it.each(["throw", "reject", "stall"])("contains finalizer %s and preserves the original failure", async (mode) => {
    const failure = new Error("Original failure");
    const finalize = vi.fn(() => {
      if (mode === "throw") throw new Error("Finalizer failure");
      if (mode === "reject") return Promise.reject(new Error("Finalizer rejection"));
      return new Promise<void>(() => {});
    });
    await expect(withGenerationDelivery(1, finalize, async () => { throw failure; })).rejects.toBe(failure);
    expect(finalize).toHaveBeenCalledOnce();
  });
});
