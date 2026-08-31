import type { YieldReason } from "./message-format.js";

export const CONVERSATION_EVENT_VERSION = 1 as const;
export const CONVERSATION_EVENT_MAX_BYTES = 8 * 1024;
export const CONVERSATION_EVIDENCE_ID_MAX_LENGTH = 256;

/** Queue facts are distinct from decisions to schedule a participant turn. */
type JobQueueDecisionFields = {
  readonly decisionId: string;
  readonly admissionId: string;
  /** Pending entries after the decision; excludes the active job. */
  readonly pendingCount: number;
  readonly active: boolean;
} & (
  | { readonly action: "queued"; readonly reason: "eligible"; readonly jobId: string; readonly retainedJobId: null }
  | { readonly action: "started"; readonly reason: "queue-ready"; readonly jobId: string; readonly retainedJobId: null }
  | { readonly action: "coalesced"; readonly reason: "key-already-pending"; readonly jobId: null; readonly retainedJobId: string }
  | { readonly action: "rejected"; readonly reason: "queue-closed"; readonly jobId: null; readonly retainedJobId: null }
  | { readonly action: "dropped"; readonly reason: "queue-closed"; readonly jobId: string; readonly retainedJobId: null }
);

export type JobQueueDecision = JobQueueDecisionFields & { readonly key: string };

export type ConversationJobSource = "room-message" | "developer-message" | "room-action";

/** Activity is process-local, not a durable room revision or message count. */
export interface ConversationSnapshotEvidence {
  readonly activityRevision: number | null;
  readonly latestMessageId: string | null;
  readonly latestHumanMessageId: string | null;
}

interface ConversationJobEvidence {
  readonly eventVersion: typeof CONVERSATION_EVENT_VERSION;
  readonly source: ConversationJobSource;
  readonly triggerMessageId: string | null;
  readonly queued: ConversationSnapshotEvidence;
  readonly omittedDetailCount: number;
}

export type ConversationJobDecisionEvent = ConversationJobEvidence & JobQueueDecisionFields & {
  readonly event: "conversation.job.decision";
  readonly queueKey: string | null;
};

export type ConversationJobConsumedEvent = ConversationJobEvidence & {
  readonly event: "conversation.job.consumed";
  readonly decisionId: string;
  readonly admissionId: string;
  readonly jobId: string;
  readonly consumed: ConversationSnapshotEvidence;
};

export type ConversationJobEvent = ConversationJobDecisionEvent | ConversationJobConsumedEvent;

export type ObservedConversationState = "settled" | "open" | "blocked";
export type VisibleMessageLimitSource = "default-burst-cap" | "caller-limit" | "remaining-budget" | "opening" | "conversation-floor" | "synthesis" | "objection" | "reconciliation";

export interface TurnInterpretationDiagnostics {
  parserRevision: 1;
  dispositionStatus: "missing" | "valid" | "malformed";
  dispositionAction: "speak" | "yield" | null;
  yieldReason: YieldReason | null;
  suppressionReason: "structured-yield" | "malformed-disposition" | "legacy-no-response" | null;
  declaredConversationState: ObservedConversationState | null;
  effectiveConversationState: ObservedConversationState | null;
  continuationWorthy: boolean;
  requestedVisibleMessageLimit: number | null;
  effectiveVisibleMessageLimit: number;
  limitSource: VisibleMessageLimitSource;
  burstAccounting: "evaluated" | "not-evaluated";
  parsedBurstCount: number | null;
  removedBurstCount: number | null;
  eligibleBurstCount: number | null;
  retainedBurstCount: number | null;
  truncatedBurstCount: number | null;
  /** Characters use UTF-16 code units, like string.length; unlike units are not summed. */
  removals: {
    protocolDirectives: number; protocolCharacters: number;
    workflowPrefaceParagraphs: number; workflowPrefaceCharacters: number;
    speakerLabelCharacters: number; unsupportedEmojiGraphemes: number; unsupportedEmojiCharacters: number;
    whitespaceCharacters: number; emptyBursts: number; legacyNoResponseBursts: number;
  };
}

export type DeliveryReason = "burst-delivered" | "no-visible-output" | "activity-changed-before-delivery"
  | "burst-interrupted" | "activity-changed-after-delivery" | "agent-disabled"
  | "activity-changed-during-session-save" | "activity-changed-during-style-save"
  | "post-interpretation-failed" | "message-write-unconfirmed";

export interface GenerationDeliverySummary {
  eventVersion: 1;
  outcome: "delivered" | "no_response" | "cancelled" | "failed";
  reason: DeliveryReason;
  retainedBurstCount: number;
  confirmedDeliveredBurstCount: number;
  confirmedUndeliveredBurstCount: number;
  unconfirmedBurstCount: number;
  acknowledgedMessageIds: string[];
}
export type ConversationPhase = "opening" | "follow-up" | "conversation-floor" | "synthesis" | "objection" | "reconciliation";
export type ConversationTerminalReason = "cancelled" | "no-visible-output" | "broadcast-settled-response"
  | "conversation-floor-completed" | "no-explicit-unresolved-state" | "open-without-second-responder"
  | "safety-ceiling" | "synthesis-no-response" | "synthesis-settled" | "blocked-input"
  | "no-material-objection" | "reconciliation-no-response" | "reconciliation-settled"
  | "unresolved-reconciliation" | "queue-exhausted" | "follow-up-limit" | "run-failed";

/** Additive observation: engine policy counters are not proof of persisted delivery. */
export interface ConversationRunSummary {
  eventVersion: 1;
  engine: "energy" | "legacy";
  reason: ConversationTerminalReason;
  phase: ConversationPhase;
  engineSettled: boolean | null;
  counts: {
    attemptedTurns: number; respondedTurns: number; yieldedTurns: number;
    noResponseTurns: number; failedTurns: number; cancelledTurns: number; skippedTurns: number;
    declaredSettledTurns: number; effectiveSettledTurns: number;
    confirmedDeliveredBursts: number; confirmedUndeliveredBursts: number; unconfirmedBursts: number;
    turnsWithoutDeliveryEvidence: number;
  };
  policy: {
    responseTurns: number; visibleMessages: number; energySpent: number;
    hardTurnCeiling: number | null; hardMessageCeiling: number | null;
    turnCeilingReached: boolean; messageCeilingReached: boolean;
    followUps: number | null; maxFollowUps: number | null; followUpLimitReached: boolean;
  };
  pending: { candidates: number; mentions: number; activeTurns: number; disposition: "none" | "not-scheduled" | "abandoned" };
}

export type ConversationSelection = "initial-candidate" | "legacy-name-match" | "ambient-continuation" | "fresh-candidate" | "conversation-floor" | "synthesis" | "objection" | "reconciliation";
export type ConversationDecisionReason = "eligible" | "target-active" | "target-queued" | "target-already-responded"
  | "pair-cap-reached" | "secondary-chance-missed" | "soft-budget-exhausted" | "participant-limit"
  | "no-fresh-candidate" | "source-already-used" | "no-continuation-cue" | "hard-message-ceiling" | "hard-turn-ceiling"
  | "follow-up-allowance-exhausted" | "deferred-replaced" | "run-cancelled" | "run-failed" | "run-ended" | "candidate-not-completed";
export type ConversationTurnReason = "agent-disabled" | "agent-health-unavailable" | "generation-capacity-unavailable"
  | "provider-health-unavailable" | "provider-failed" | "generation-failed" | "preparation-failed" | "turn-failed"
  | "cancelled" | "delivered" | "yielded" | "malformed-disposition" | "no-visible-output" | DeliveryReason;

export interface ConversationSelectionIdentity {
  pendingDecisionId: string;
  selectionFamily: ConversationSelection;
  targetAgentId: string;
  sourceAgentId: string | null;
  sourceTurnId: string | null;
  sourceGenerationId: string | null;
  sourceMessageId: string | null;
  turnId?: string;
}

export interface ConversationDecisionState {
  phase: ConversationPhase;
  queuedCount: number; activeCount: number; attemptedTurns: number; responseTurns: number;
  visibleMessages: number; remainingMessageBudget: number | null; energySpent: number | null;
  followUps: number | null; remainingFollowUps: number | null;
  targetActive: boolean; targetQueued: boolean;
}

export interface ConversationConfiguration {
  engine: "energy" | "legacy";
  energy: string | null; policyRevision: 1;
  candidateIds: string[]; candidateCount: number;
  concurrencyLimit: number; participantLimit: number;
  hardMessageCeiling: number | null; hardTurnCeiling: number | null; softMessageBudget: number | null;
  secondaryChance: number | null; maxFollowUps: number | null;
  inviteAll: boolean; stopOnSettledResponse: boolean; conversationalFloor: boolean;
}

export type ConversationFact =
  | { kind: "configuration"; configuration: ConversationConfiguration }
  | ({ kind: "decision"; decisionId: string; action: "queued" | "started" | "deferred" | "deduplicated" | "dropped" | "blocked";
       reason: ConversationDecisionReason; relatedDecisionId: string | null;
       pairCount: number | null; pairLimit: number | null; randomDraw: number | null; randomThreshold: number | null;
       visibleMessageLimit: number | null; preflightDecisionId: string | null;
     } & ConversationSelectionIdentity & ConversationDecisionState)
  | { kind: "turn-finished"; turnId: string; pendingDecisionId: string; agentId: string;
      generationId: string | null; attemptOrdinal: number | null; durationMs: number;
      outcome: "responded" | "yielded" | "no-response" | "blocked" | "failed" | "cancelled";
      reason: ConversationTurnReason;
      engineFailed: boolean; engineCancelled: boolean; visibleMessageCount: number;
      interpretation: Pick<TurnInterpretationDiagnostics, "parserRevision" | "dispositionStatus" | "dispositionAction" | "yieldReason" | "suppressionReason" | "declaredConversationState" | "effectiveConversationState" | "continuationWorthy" | "effectiveVisibleMessageLimit" | "limitSource" | "parsedBurstCount" | "retainedBurstCount" | "truncatedBurstCount"> | null;
      delivery: Pick<GenerationDeliverySummary, "outcome" | "reason" | "retainedBurstCount" | "confirmedDeliveredBurstCount" | "confirmedUndeliveredBurstCount" | "unconfirmedBurstCount"> | null;
    }
  | { kind: "summary"; summary: ConversationRunSummary };

export type ConversationObserver = (fact: ConversationFact) => unknown;
