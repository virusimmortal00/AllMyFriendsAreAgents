import type { DeliveryReason, GenerationDeliverySummary } from "../shared/conversation-observability.js";
import { observeSafely } from "./nonblocking-observer.js";

/** Observes existing writes; it does not retry, deduplicate, or authorize them. */
export class GenerationDeliveryLedger {
  private readonly acknowledged = new Map<number, string>();
  private readonly unconfirmed = new Set<number>();
  private outcome: GenerationDeliverySummary["outcome"] = "failed";
  private reason: DeliveryReason = "post-interpretation-failed";

  constructor(private readonly retainedBurstCount: number) {}

  async write<T extends { id: string }>(sequence: number, persist: () => Promise<T>): Promise<T> {
    if (!Number.isInteger(sequence) || sequence < 0 || sequence >= this.retainedBurstCount) throw new RangeError("Delivery sequence is outside the interpreted burst");
    // Mark uncertainty at the actual write boundary, not during pacing/session work.
    if (!this.acknowledged.has(sequence)) this.unconfirmed.add(sequence);
    const message = await persist();
    this.acknowledged.set(sequence, message.id);
    this.unconfirmed.delete(sequence);
    return message;
  }

  finish(outcome: GenerationDeliverySummary["outcome"], reason: DeliveryReason) {
    this.outcome = outcome;
    this.reason = reason;
  }

  fail() {
    this.finish("failed", this.unconfirmed.size > 0 ? "message-write-unconfirmed" : "post-interpretation-failed");
  }

  snapshot(): GenerationDeliverySummary {
    return {
      eventVersion: 1, outcome: this.outcome, reason: this.reason, retainedBurstCount: this.retainedBurstCount,
      confirmedDeliveredBurstCount: this.acknowledged.size,
      confirmedUndeliveredBurstCount: this.retainedBurstCount - this.acknowledged.size - this.unconfirmed.size,
      unconfirmedBurstCount: this.unconfirmed.size,
      acknowledgedMessageIds: [...new Set(this.acknowledged.values())],
    };
  }
}

/** One finalization attempt, including empty output and thrown post-interpretation paths. */
export async function withGenerationDelivery<T extends object>(
  retainedBurstCount: number,
  finalize: (summary: GenerationDeliverySummary) => unknown,
  deliver: (ledger: GenerationDeliveryLedger) => Promise<T>,
): Promise<T & { delivery: GenerationDeliverySummary }> {
  const ledger = new GenerationDeliveryLedger(retainedBurstCount);
  try {
    const result = await deliver(ledger);
    return { ...result, delivery: ledger.snapshot() };
  } catch (error) {
    ledger.fail();
    throw error;
  } finally {
    observeSafely(finalize, ledger.snapshot());
  }
}
