import { randomUUID } from "node:crypto";
import {
  CONVERSATION_EVENT_VERSION, CONVERSATION_EVIDENCE_ID_MAX_LENGTH,
  type ConversationJobEvent, type ConversationJobSource, type ConversationSnapshotEvidence,
} from "../shared/conversation-observability.js";
import type { AuthoritativeLogging } from "./authoritative-logging.js";
import type { CoalescingJobQueue, JobQueueObserver, QueuedJobIdentity } from "./job-queue.js";
import { observeSafely } from "./nonblocking-observer.js";
import type { RoomActivity } from "./room-activity.js";
import { withLogContext } from "./structured-logger.js";
import type { RoomState } from "./types.js";

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
export function enqueueObservedConversation<State extends Pick<RoomState, "messages">>(dependencies: {
  queue: CoalescingJobQueue;
  logging: Pick<AuthoritativeLogging, "log">;
  snapshot: () => State;
  activity: Pick<RoomActivity, "current">;
  runJob: (run: () => Promise<void>) => Promise<void>;
}, job: { key: string; source: ConversationJobSource; triggerMessageId: string | null }, run: (snapshot: State) => Promise<void>) {
  // Establish a trace for non-HTTP entry points without inventing a request ID.
  return withLogContext({}, () => {
    const observation = createConversationJobObserver(dependencies.logging, {
      source: job.source, triggerMessageId: job.triggerMessageId,
      queued: conversationSnapshotEvidence(dependencies.snapshot(), dependencies.activity.current()),
    });
    return dependencies.queue.enqueue(job.key, (identity) => withLogContext({ jobId: identity.jobId }, () => dependencies.runJob(async () => {
      const state = dependencies.snapshot();
      observation.consumed(identity, conversationSnapshotEvidence(state, dependencies.activity.current()));
      await run(state);
    })), observation.onDecision);
  });
}
