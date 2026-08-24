import { continuationIsNonterminal, normalizeContinuationInboxEntry, normalizeContinuationPolicy, normalizeContinuationRecord, type ContinuationInboxEntry, type ContinuationPolicy, type ContinuationRecord } from "../continuation-record.js";

export interface JsonContinuationState {
  readonly schemaVersion: 1;
  readonly policy: ContinuationPolicy | null;
  readonly jobs: Record<string, ContinuationRecord>;
  readonly inbox: Record<string, ContinuationInboxEntry>;
}
export function emptyJsonContinuationState(): JsonContinuationState { return { schemaVersion: 1, policy: null, jobs: {}, inbox: {} }; }
export function normalizeJsonContinuationState(value: unknown): JsonContinuationState {
  if (!value || typeof value !== "object") return emptyJsonContinuationState();
  const source = value as { policy?: unknown; jobs?: unknown; inbox?: unknown };
  const jobs = Object.fromEntries(Object.values(source.jobs && typeof source.jobs === "object" ? source.jobs : {}).map(normalizeContinuationRecord).filter(Boolean).map((job) => [job!.jobId, job!]));
  const inbox = Object.fromEntries(Object.values(source.inbox && typeof source.inbox === "object" ? source.inbox : {}).map(normalizeContinuationInboxEntry).filter(Boolean).map((entry) => [entry!.inboxEntryId, entry!]));
  return { schemaVersion: 1, policy: normalizeContinuationPolicy(source.policy) ?? null, jobs, inbox };
}
export function hasActiveOwner(state: JsonContinuationState, owner: ContinuationRecord["owner"], exceptJobId?: string) {
  return Object.values(state.jobs).some((job) => job.owner === owner && job.jobId !== exceptJobId && continuationIsNonterminal(job));
}
