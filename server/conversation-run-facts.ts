import type { ConversationRunSummary } from "../shared/conversation-observability.js";
import type { ConversationTurn, TurnResult } from "./conversation.js";

/** Counts observations only. Scheduling must never consult these counters. */
export class ConversationRunFacts {
  readonly counts: ConversationRunSummary["counts"] = {
    attemptedTurns: 0, respondedTurns: 0, yieldedTurns: 0, noResponseTurns: 0,
    failedTurns: 0, cancelledTurns: 0, skippedTurns: 0,
    declaredSettledTurns: 0, effectiveSettledTurns: 0,
    confirmedDeliveredBursts: 0, confirmedUndeliveredBursts: 0, unconfirmedBursts: 0,
    turnsWithoutDeliveryEvidence: 0,
  };

  start() { this.counts.attemptedTurns += 1; }

  complete(turn: ConversationTurn, result?: TurnResult, threw = false) {
    const counts = this.counts;
    if (threw || result?.failed) counts.failedTurns += 1;
    if (result?.cancelled) counts.cancelledTurns += 1;
    if ((result?.visibleMessageCount || 0) > 0) counts.respondedTurns += 1;
    else if (!threw && !result?.failed && !result?.cancelled) counts.noResponseTurns += 1;
    const interpretation = result?.interpretation || turn.evidence?.interpretation;
    if (interpretation?.dispositionAction === "yield" || interpretation?.suppressionReason === "legacy-no-response") counts.yieldedTurns += 1;
    if (interpretation?.declaredConversationState === "settled") counts.declaredSettledTurns += 1;
    if (result?.conversationState === "settled") counts.effectiveSettledTurns += 1;
    const delivery = result?.delivery || turn.evidence?.delivery;
    if (delivery) {
      counts.confirmedDeliveredBursts += delivery.confirmedDeliveredBurstCount;
      counts.confirmedUndeliveredBursts += delivery.confirmedUndeliveredBurstCount;
      counts.unconfirmedBursts += delivery.unconfirmedBurstCount;
    } else counts.turnsWithoutDeliveryEvidence += 1;
  }
}
