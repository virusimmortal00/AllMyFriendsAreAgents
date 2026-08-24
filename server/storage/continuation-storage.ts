import { continuationInboxMatchesJob, continuationIsNonterminal, continuationRecordIsCanonical, normalizeContinuationAuditEvent, normalizeContinuationInboxEntry, normalizeContinuationPolicy, normalizeContinuationRecord, type ContinuationAuditEvent, type ContinuationInboxEntry, type ContinuationPolicy, type ContinuationRecord } from "../continuation-record.js";

export interface JsonContinuationState {
  readonly schemaVersion: 1;
  readonly policy: ContinuationPolicy | null;
  readonly jobs: Record<string, ContinuationRecord>;
  readonly inbox: Record<string, ContinuationInboxEntry>;
  readonly events: readonly ContinuationAuditEvent[];
}
export function emptyJsonContinuationState(): JsonContinuationState { return { schemaVersion: 1, policy: null, jobs: {}, inbox: {}, events: [] }; }
export function normalizeJsonContinuationState(value: unknown, canonicalRoomId?: string): JsonContinuationState {
  if (!value || typeof value !== "object") return emptyJsonContinuationState();
  const source = value as { policy?: unknown; jobs?: unknown; inbox?: unknown; events?: unknown };
  const jobs = Object.fromEntries(Object.values(source.jobs && typeof source.jobs === "object" ? source.jobs : {}).map(normalizeContinuationRecord).filter(Boolean).map((job) => [job!.jobId, job!]));
  const inbox = Object.fromEntries(Object.values(source.inbox && typeof source.inbox === "object" ? source.inbox : {}).map(normalizeContinuationInboxEntry).filter(Boolean).map((entry) => [entry!.inboxEntryId, entry!]));
  const events = (Array.isArray(source.events) ? source.events : []).map(normalizeContinuationAuditEvent).filter((event): event is ContinuationAuditEvent => Boolean(event));
  const policy = normalizeContinuationPolicy(source.policy) ?? null;
  if (canonicalRoomId && (policy && policy.roomId !== canonicalRoomId || Object.values(jobs).some((job) => !continuationRecordIsCanonical(job, canonicalRoomId)) || Object.values(inbox).some((entry) => entry.roomId !== canonicalRoomId || !jobs[entry.jobId] || !continuationInboxMatchesJob(entry, jobs[entry.jobId]!)) || events.some((event) => !jobs[event.jobId]))) throw new Error("Persisted continuation provenance is noncanonical");
  return { schemaVersion: 1, policy, jobs, inbox, events };
}
export function hasActiveOwner(state: JsonContinuationState, owner: ContinuationRecord["owner"], exceptJobId?: string) {
  return Object.values(state.jobs).some((job) => job.owner === owner && job.jobId !== exceptJobId && continuationIsNonterminal(job));
}
