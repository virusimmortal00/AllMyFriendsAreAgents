import { randomUUID } from "node:crypto";
import type { ConversationDecisionReason, ConversationDecisionState, ConversationFact, ConversationObserver, ConversationSelection, ConversationSelectionIdentity } from "../shared/conversation-observability.js";
import type { ConversationTurn, TurnResult } from "./conversation.js";
import { observeSafely } from "./nonblocking-observer.js";

type Decision = Extract<ConversationFact, { kind: "decision" }>;
type Detail = Partial<Pick<Decision, "pairCount" | "pairLimit" | "randomDraw" | "randomThreshold" | "visibleMessageLimit" | "relatedDecisionId" | "preflightDecisionId">>;

/** Evidence-only pending identities: this map is never consulted by scheduling policy. */
export class ConversationDecisions {
  private readonly pending = new Map<string, ConversationSelectionIdentity>();
  constructor(private readonly observer: ConversationObserver | undefined, private readonly state: (agent?: string) => ConversationDecisionState) {}

  emit(fact: ConversationFact) { if (this.observer) observeSafely(this.observer, structuredClone(fact)); }

  decision(identity: ConversationSelectionIdentity, action: Decision["action"], reason: ConversationDecisionReason, detail: Detail = {}) {
    this.emit({ kind: "decision", ...identity, ...this.state(identity.targetAgentId), action, reason,
      decisionId: randomUUID(), relatedDecisionId: null, pairCount: null, pairLimit: null,
      randomDraw: null, randomThreshold: null, visibleMessageLimit: null, preflightDecisionId: null, ...detail });
  }

  identity(agent: string, selectionFamily: ConversationSelection, source?: ConversationTurn): ConversationSelectionIdentity {
    return { pendingDecisionId: randomUUID(), selectionFamily, targetAgentId: agent,
      sourceAgentId: source?.agent || null, sourceTurnId: source?.observation?.turnId || null,
      sourceGenerationId: source?.evidence?.generationId || null,
      sourceMessageId: source?.evidence?.delivery?.acknowledgedMessageIds.at(-1) || null };
  }

  queue(turn: ConversationTurn, family: ConversationSelection, source?: ConversationTurn, detail: Detail = {}): ConversationTurn {
    const observation = this.identity(turn.agent, family, source);
    this.pending.set(observation.pendingDecisionId, observation);
    this.decision(observation, "queued", "eligible", { preflightDecisionId: turn.preflight?.decisionId || null, ...detail });
    return { ...turn, observation };
  }

  select(turn: ConversationTurn, family: ConversationSelection, source?: ConversationTurn): ConversationTurn {
    if (!turn.observation) return this.queue(turn, family, source);
    const observation = { ...this.identity(turn.agent, family, source), pendingDecisionId: turn.observation.pendingDecisionId };
    this.pending.set(observation.pendingDecisionId, observation);
    return { ...turn, observation };
  }

  defer(agent: string, source: ConversationTurn, reason: "target-active" | "target-queued", previous?: ConversationSelectionIdentity) {
    const identity = this.identity(agent, "legacy-name-match", source);
    if (previous) this.drop(previous, "deferred-replaced", { relatedDecisionId: identity.pendingDecisionId });
    this.pending.set(identity.pendingDecisionId, identity);
    this.decision(identity, "deferred", reason, { relatedDecisionId: previous?.pendingDecisionId || null });
    return identity;
  }

  start(turn: ConversationTurn, visibleMessageLimit?: number) {
    const identity = turn.observation || this.queue(turn, "initial-candidate").observation!;
    this.pending.delete(identity.pendingDecisionId);
    const observation = { ...identity, turnId: randomUUID() };
    this.decision(observation, "started", "eligible", { visibleMessageLimit: visibleMessageLimit ?? null, preflightDecisionId: turn.preflight?.decisionId || null });
    return { ...turn, observation, evidence: {} } satisfies ConversationTurn;
  }

  drop(identity: ConversationSelectionIdentity, reason: ConversationDecisionReason, detail: Detail = {}) {
    this.pending.delete(identity.pendingDecisionId);
    this.decision(identity, "dropped", reason, detail);
  }

  end(reason: ConversationDecisionReason) {
    for (const identity of this.pending.values()) this.drop(identity, reason);
  }

  finish(turn: ConversationTurn, startedAt: number, result?: TurnResult, threw = false) {
    const parsed = result?.interpretation || turn.evidence?.interpretation;
    const delivered = result?.delivery || turn.evidence?.delivery;
    const reason = result?.outcomeReason || (threw ? delivered?.reason || "turn-failed" : result?.cancelled ? delivered?.reason || "cancelled"
      : result?.failed ? "turn-failed" : parsed?.dispositionStatus === "malformed" ? "malformed-disposition"
      : parsed?.dispositionAction === "yield" || parsed?.suppressionReason === "legacy-no-response" ? "yielded"
      : (result?.visibleMessageCount || 0) > 0 ? "delivered" : "no-visible-output");
    const blocked = reason === "agent-health-unavailable" || reason === "generation-capacity-unavailable" || reason === "provider-health-unavailable";
    this.emit({ kind: "turn-finished", turnId: turn.observation!.turnId!, pendingDecisionId: turn.observation!.pendingDecisionId, agentId: turn.agent,
      generationId: turn.evidence?.generationId || null, attemptOrdinal: turn.evidence?.attemptOrdinal ?? null, durationMs: Math.max(0, Date.now() - startedAt),
      outcome: threw ? "failed" : result?.cancelled ? "cancelled" : blocked ? "blocked" : result?.failed ? "failed"
        : reason === "yielded" ? "yielded" : (result?.visibleMessageCount || 0) > 0 ? "responded" : "no-response",
      reason, engineFailed: threw || Boolean(result?.failed), engineCancelled: Boolean(result?.cancelled), visibleMessageCount: result?.visibleMessageCount || 0,
      interpretation: parsed ? {
        parserRevision: parsed.parserRevision, dispositionStatus: parsed.dispositionStatus, dispositionAction: parsed.dispositionAction, yieldReason: parsed.yieldReason,
        suppressionReason: parsed.suppressionReason, declaredConversationState: parsed.declaredConversationState, effectiveConversationState: parsed.effectiveConversationState,
        continuationWorthy: parsed.continuationWorthy, effectiveVisibleMessageLimit: parsed.effectiveVisibleMessageLimit, limitSource: parsed.limitSource,
        parsedBurstCount: parsed.parsedBurstCount, retainedBurstCount: parsed.retainedBurstCount, truncatedBurstCount: parsed.truncatedBurstCount,
      } : null,
      delivery: delivered ? { outcome: delivered.outcome, reason: delivered.reason, retainedBurstCount: delivered.retainedBurstCount,
        confirmedDeliveredBurstCount: delivered.confirmedDeliveredBurstCount, confirmedUndeliveredBurstCount: delivered.confirmedUndeliveredBurstCount, unconfirmedBurstCount: delivered.unconfirmedBurstCount } : null,
    });
  }
}
