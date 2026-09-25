import { randomUUID } from "node:crypto";
import type { ConversationActivity } from "../shared/conversation-activity.js";
import { isAgentId } from "../shared/participants.js";
import {
  CONVERSATION_EVENT_VERSION, CONVERSATION_EVIDENCE_ID_MAX_LENGTH,
  type ConversationJobEvent, type ConversationJobSource, type ConversationSnapshotEvidence, type ConversationTerminalReason, type JobQueueDecision,
} from "../shared/conversation-observability.js";
import type { AuthoritativeLogging } from "./authoritative-logging.js";
import type { CoalescingJobQueue, JobQueueObserver, QueuedJobIdentity } from "./job-queue.js";
import { observeSafely } from "./nonblocking-observer.js";
import type { RoomActivity } from "./room-activity.js";
import { withLogContext } from "./structured-logger.js";
import type { RoomState } from "./types.js";

export type ConversationJobLifecycle =
  | { stage: "decision"; decision: JobQueueDecision; elapsedMs: number }
  | { stage: "consumed"; job: QueuedJobIdentity; evidence: ConversationSnapshotEvidence; queueDelayMs: number }
  | { stage: "settled"; job: QueuedJobIdentity; elapsedMs: number };

/** Process-local trigger timing. A retained queue job may consume a newer message. */
export class ConversationTriggerTrace {
  readonly queuedAt: number;
  readonly queuedTriggerMessageId: string | null;
  triggerMessageId: string | null;
  acceptedAt: number;
  jobId: string | null = null;
  firstGenerationActive = false;
  firstVisible = false;
  terminalRecorded = false;

  constructor(readonly source: ConversationJobSource, triggerMessageId: string | null, private readonly now = Date.now) {
    this.queuedAt = now();
    this.acceptedAt = this.queuedAt;
    this.queuedTriggerMessageId = triggerMessageId;
    this.triggerMessageId = triggerMessageId;
  }

  consume(messageId: string | null, timestamp: string | undefined) {
    this.triggerMessageId = messageId;
    const acceptedAt = timestamp === undefined ? NaN : Date.parse(timestamp);
    if (Number.isFinite(acceptedAt)) this.acceptedAt = Math.min(acceptedAt, this.now());
  }

  sinceQueueMs() { return Math.max(0, this.now() - this.queuedAt); }
  sinceAcceptedMs() { return Math.max(0, this.now() - this.acceptedAt); }
}

const TRIGGER_STAGES = new Set(["queue", "consumed", "settled", "preflight-started", "preflight-completed", "classifier", "turn-preparation", "generation-active", "first-generation-active", "first-visible", "generation-completed", "terminal"]);
const NUMBER_FIELDS = new Set(["queueElapsedMs", "queueDelayMs", "candidateCount", "selectedCount", "durationMs", "preparationDurationMs", "attemptOrdinal", "reportedInputTokens", "reportedOutputTokens", "reportedCostUsd", "openCodeEstimatedCostUsd", "queueToGenerationActiveMs", "timeToFirstVisibleMs", "attemptedTurns", "yieldedTurns", "respondedTurns"]);
const TERMINAL_REASONS: Record<ConversationTerminalReason, true> = {
  cancelled: true,
  "no-visible-output": true,
  "broadcast-settled-response": true,
  "conversation-floor-completed": true,
  "no-explicit-unresolved-state": true,
  "no-material-disagreement": true,
  "open-without-second-responder": true,
  "safety-ceiling": true,
  "synthesis-no-response": true,
  "synthesis-settled": true,
  "blocked-input": true,
  "no-material-objection": true,
  "reconciliation-no-response": true,
  "reconciliation-settled": true,
  "unresolved-reconciliation": true,
  "queue-exhausted": true,
  "follow-up-limit": true,
  "attempt-ceiling": true,
  "run-failed": true,
};
const ENUM_FIELDS: Record<string, ReadonlySet<string>> = {
  action: new Set(["queued", "started", "coalesced", "rejected", "dropped"]),
  outcome: new Set(["off", "no-trigger", "cancelled", "routed", "skipped", "completed", "failed"]),
  reason: new Set(["no-candidates", "room-disabled", "disabled", "cooldown", "empty_input", "no_credential", ...Object.keys(TERMINAL_REASONS)]),
  mode: new Set(["off", "shadow", "enforce"]),
  classifier: new Set(["completed", "fallback"]),
  failureCategory: new Set(["timeout", "authentication", "http", "transport", "schema"]),
};

function evidenceId(value: string | null): string | null {
  return value && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
}

/** A closed, scalar projection: caller errors, transcript text, and model output cannot enter this event. */
export function conversationTriggerStageRecord(trace: ConversationTriggerTrace, stage: string, fields: Record<string, unknown> = {}) {
  if (!TRIGGER_STAGES.has(stage)) return undefined;
  const safe: Record<string, string | number | null> = {
    eventVersion: 1,
    source: trace.source,
    queuedTriggerMessageId: evidenceId(trace.queuedTriggerMessageId),
    triggerMessageId: evidenceId(trace.triggerMessageId),
    jobId: evidenceId(trace.jobId),
    stage,
    elapsedMs: trace.sinceAcceptedMs(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (NUMBER_FIELDS.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
    else if (key === "agentId" && typeof value === "string" && isAgentId(value)) safe[key] = value;
    else if ((key === "generationId" || key === "consumedTriggerMessageId") && typeof value === "string") safe[key] = evidenceId(value);
    else if (typeof value === "string" && ENUM_FIELDS[key]?.has(value)) safe[key] = value;
  }
  return safe;
}

/** Queue decisions are authoritative; no transcript or unbounded job map is retained. */
export class ConversationActivityTracker {
  private queued = 0;
  private decidingJobId: string | null = null;
  constructor(private readonly onChange: () => void) {}

  snapshot(): ConversationActivity | undefined {
    return this.decidingJobId ? { phase: "deciding" } : this.queued > 0 ? { phase: "queued" } : undefined;
  }

  observe(event: ConversationJobLifecycle) {
    const before = this.snapshot()?.phase;
    if (event.stage === "decision") {
      if (event.decision.action === "queued") this.queued += 1;
      if (event.decision.action === "started" || event.decision.action === "dropped") this.queued = Math.max(0, this.queued - 1);
      if (event.decision.action === "started") this.decidingJobId = event.decision.jobId;
    } else if (event.stage === "settled" && this.decidingJobId === event.job.jobId) {
      this.decidingJobId = null;
    }
    if (before !== this.snapshot()?.phase) this.onChange();
  }

  preparing(jobId: string | null) {
    if (!jobId) return;
    const before = this.snapshot()?.phase;
    this.decidingJobId = jobId;
    if (before !== this.snapshot()?.phase) this.onChange();
  }

}

/** Project only snapshot identity; never retain the snapshot or its message text. */
export function conversationSnapshotEvidence(snapshot: Pick<RoomState, "messages">, activityRevision: number): ConversationSnapshotEvidence {
  return {
    activityRevision,
    latestMessageId: snapshot.messages.at(-1)?.id ?? null,
    latestHumanMessageId: snapshot.messages.findLast(({ speaker }) => speaker === "you")?.id ?? null,
  };
}

export function createConversationJobObserver(logging: Pick<AuthoritativeLogging, "log">, input: {
  source: ConversationJobSource;
  triggerMessageId: string | null;
  queued: ConversationSnapshotEvidence;
}) {
  let omittedDetailCount = 0;
  const identity = (value: string | null) => {
    if (value === null || value.length <= CONVERSATION_EVIDENCE_ID_MAX_LENGTH) return value;
    omittedDetailCount++;
    return null;
  };
  const snapshot = (value: ConversationSnapshotEvidence): ConversationSnapshotEvidence => ({
    activityRevision: value.activityRevision !== null && Number.isSafeInteger(value.activityRevision) && value.activityRevision >= 0 ? value.activityRevision : null,
    latestMessageId: identity(value.latestMessageId),
    latestHumanMessageId: identity(value.latestHumanMessageId),
  });
  const base = {
    eventVersion: CONVERSATION_EVENT_VERSION,
    source: input.source,
    triggerMessageId: identity(input.triggerMessageId),
    queued: snapshot(input.queued),
  };
  const queuedOmissions = omittedDetailCount;
  const emit = (event: ConversationJobEvent) => observeSafely((record: ConversationJobEvent) => {
    const { event: name, ...fields } = record;
    return logging.log("generations", "info", name, fields, { visibility: "operator" });
  }, event);

  const onDecision: JobQueueObserver = (decision) => {
    omittedDetailCount = queuedOmissions;
    // The queue owns this closed union of scalar facts, never job arguments.
    const { key, ...facts } = decision;
    const queueKey = identity(key);
    emit({
      ...base, ...facts, event: "conversation.job.decision", queueKey, omittedDetailCount,
    });
  };
  const consumed = (job: QueuedJobIdentity, evidence: ConversationSnapshotEvidence) => {
    omittedDetailCount = queuedOmissions;
    const consumedSnapshot = snapshot(evidence);
    emit({
      ...base, event: "conversation.job.consumed", decisionId: randomUUID(),
      admissionId: job.admissionId, jobId: job.jobId,
      consumed: consumedSnapshot, omittedDetailCount,
    });
  };
  return { onDecision, consumed };
}

/** Shared boundary for message, developer-message, and explicit-action jobs. */
export function enqueueObservedConversation<State extends Pick<RoomState, "messages">>(
  dependencies: {
    queue: CoalescingJobQueue;
    logging: Pick<AuthoritativeLogging, "log">;
    snapshot: () => State;
    activity: Pick<RoomActivity, "current">;
    runJob: (run: () => Promise<void>) => Promise<void>;
  },
  job: {
    key: string;
    source: ConversationJobSource;
    triggerMessageId: string | null;
    onLifecycle?: (event: ConversationJobLifecycle) => unknown;
  },
  run: (snapshot: State) => Promise<void>,
) {
  // Establish a trace for non-HTTP entry points without inventing a request ID.
  return withLogContext({}, () => {
    const queuedAt = Date.now();
    const observation = createConversationJobObserver(dependencies.logging, {
      source: job.source,
      triggerMessageId: job.triggerMessageId,
      queued: conversationSnapshotEvidence(dependencies.snapshot(), dependencies.activity.current()),
    });
    return dependencies.queue.enqueue(
      job.key,
      (identity) =>
        withLogContext({ jobId: identity.jobId }, async () => {
          try {
            await dependencies.runJob(async () => {
              const state = dependencies.snapshot();
              const evidence = conversationSnapshotEvidence(state, dependencies.activity.current());
              observation.consumed(identity, evidence);
              observeSafely(job.onLifecycle, {
                stage: "consumed",
                job: identity,
                evidence,
                queueDelayMs: Math.max(0, Date.now() - queuedAt),
              });
              await run(state);
            });
          } finally {
            observeSafely(job.onLifecycle, {
              stage: "settled",
              job: identity,
              elapsedMs: Math.max(0, Date.now() - queuedAt),
            });
          }
        }),
      (decision) => {
        observation.onDecision(decision);
        observeSafely(job.onLifecycle, { stage: "decision", decision, elapsedMs: Math.max(0, Date.now() - queuedAt) });
      },
    );
  });
}
