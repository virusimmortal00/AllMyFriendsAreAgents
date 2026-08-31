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
