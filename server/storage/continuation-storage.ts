import { continuationInboxMatchesJob, continuationIsNonterminal, continuationProjectionIsValid, continuationProvenanceHash, continuationRecordIsCanonical, normalizeContinuationAuditEvent, normalizeContinuationInboxEntry, normalizeContinuationPolicy, normalizeContinuationRecord, type ContinuationAuditAction, type ContinuationAuditEvent, type ContinuationInboxEntry, type ContinuationPolicy, type ContinuationRecord, type ContinuationStatus } from "../continuation-record.js";

export interface JsonContinuationState { readonly schemaVersion: 1; readonly policy: ContinuationPolicy | null; readonly jobs: Record<string, ContinuationRecord>; readonly inbox: Record<string, ContinuationInboxEntry>; readonly events: readonly ContinuationAuditEvent[]; }
export function emptyJsonContinuationState(): JsonContinuationState { return { schemaVersion: 1, policy: null, jobs: {}, inbox: {}, events: [] }; }
export function normalizeJsonContinuationState(value: unknown, canonicalRoomId?: string): JsonContinuationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed continuation state");
  const source = value as { schemaVersion?: unknown; policy?: unknown; jobs?: unknown; inbox?: unknown; events?: unknown };
  if (source.schemaVersion !== 1 || !plainRecord(source.jobs) || !plainRecord(source.inbox) || !Array.isArray(source.events) || !(source.policy === null || source.policy && typeof source.policy === "object")) throw new Error("Malformed continuation state");
  let policy: ContinuationPolicy | null; if (source.policy === null) policy = null; else { const parsed = normalizeContinuationPolicy(source.policy); if (!parsed) throw new Error("Malformed continuation policy"); policy = parsed; }
  const jobs: Record<string, ContinuationRecord> = {}; for (const [key, raw] of Object.entries(source.jobs)) { const record = normalizeContinuationRecord(raw); if (!record || record.jobId !== key) throw new Error("Malformed continuation job or key mismatch"); jobs[key] = record; }
  const inbox: Record<string, ContinuationInboxEntry> = {}; for (const [key, raw] of Object.entries(source.inbox)) { const entry = normalizeContinuationInboxEntry(raw); if (!entry || entry.inboxEntryId !== key) throw new Error("Malformed continuation inbox entry or key mismatch"); inbox[key] = entry; }
  const events = source.events.map((raw) => { const event = normalizeContinuationAuditEvent(raw); if (!event) throw new Error("Malformed continuation audit event"); return event; });
  validateContinuationDurableState(policy, Object.values(jobs), Object.values(inbox), events, canonicalRoomId);
  return { schemaVersion: 1, policy, jobs, inbox, events };
}
export function validateContinuationDurableState(policy: ContinuationPolicy | null | undefined, jobs: readonly ContinuationRecord[], inbox: readonly ContinuationInboxEntry[], events: readonly ContinuationAuditEvent[], canonicalRoomId?: string) {
  if (jobs.length && !policy) throw new Error("Durable continuation jobs require their governing policy");
  const byJob = new Map<string, ContinuationRecord>(); for (const job of jobs) { if (byJob.has(job.jobId) || !continuationProjectionIsValid(job) || canonicalRoomId && !continuationRecordIsCanonical(job, canonicalRoomId) || policy && (job.projectPathHash !== policy.projectPathHash || job.policyVersion !== policy.policyVersion || job.policyRevision > policy.revision)) throw new Error("Invalid durable continuation job"); byJob.set(job.jobId, job); }
  if (canonicalRoomId && policy && policy.roomId !== canonicalRoomId) throw new Error("Invalid durable continuation policy provenance");
  const inboxIds = new Set<string>(); for (const entry of inbox) { const job = byJob.get(entry.jobId); if (inboxIds.has(entry.inboxEntryId) || !job || canonicalRoomId && entry.roomId !== canonicalRoomId || !continuationInboxMatchesJob(entry, job) || !inboxProjectionIsValid(entry)) throw new Error("Invalid durable continuation inbox provenance"); inboxIds.add(entry.inboxEntryId); }
  const grouped = new Map<string, ContinuationAuditEvent[]>(); const eventIds = new Set<string>(); for (const event of events) { if (eventIds.has(event.eventId) || !byJob.has(event.jobId)) throw new Error("Invalid durable continuation audit identity"); eventIds.add(event.eventId); const list = grouped.get(event.jobId) ?? []; list.push(event); grouped.set(event.jobId, list); }
  for (const job of jobs) validateAuditChain(job, grouped.get(job.jobId) ?? []);
}
function validateAuditChain(job: ContinuationRecord, input: readonly ContinuationAuditEvent[]) {
  const events = [...input].sort((a, b) => a.jobRevision - b.jobRevision); if (events.length !== job.jobRevision) throw new Error("Continuation audit history is not contiguous");
  let status: ContinuationStatus | null = null; let attempts = 0; let usage = { elapsedMs: 0, tokens: 0, toolCalls: 0, attempts: 0 }; let at = job.createdAt;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!; if (event.jobRevision !== index + 1 || event.jobId !== job.jobId || event.trigger !== job.trigger || event.policyRevision !== job.policyRevision || event.provenanceHash !== continuationProvenanceHash(job) || event.fromStatus !== status || Date.parse(event.at) < Date.parse(at) || index === 0 && event.at !== job.createdAt) throw new Error("Continuation audit history is not semantically bound");
    if (!auditStepIsValid(status, event)) throw new Error("Continuation audit transition is forged");
    if (event.action === "COMPLETED" && event.result !== job.resultSummary || (event.action === "FAILED" || event.action === "CANCELLED") && event.result !== job.blocker) throw new Error("Continuation audit result is forged");
    if (event.action === "DISPATCHED") attempts += 1;
    const expectedUsage = { elapsedMs: usage.elapsedMs + event.attemptUsage.elapsedMs, tokens: usage.tokens + event.attemptUsage.tokens, toolCalls: usage.toolCalls + event.attemptUsage.toolCalls, attempts };
    if (JSON.stringify(event.usage) !== JSON.stringify(expectedUsage) || event.attempt !== attempts) throw new Error("Continuation audit usage is forged");
    usage = event.usage; status = event.toStatus; at = event.at;
  }
  const final = events.at(-1)!; if (final.jobRevision !== job.jobRevision || final.toStatus !== job.status || final.at !== job.updatedAt || final.attempt !== job.usage.attempts || JSON.stringify(final.usage) !== JSON.stringify(job.usage) || final.nextEligibilityAt !== job.nextEligibilityAt || (final.action === "COMPLETED" && final.result !== job.resultSummary) || (["FAILED", "CANCELLED", "RESTART_INTERRUPTED", "RETRY_BLOCKED"].includes(final.action) && final.result !== job.blocker)) throw new Error("Continuation audit head does not match its job");
}
function auditStepIsValid(from: ContinuationStatus | null, event: ContinuationAuditEvent) {
  const fixed: Partial<Record<ContinuationAuditAction, string>> = { CREATED: "Queued by authorized developer.", DISPATCHED: "Executor dispatch started.", TOOL_RESUMED: "Tool work resumed.", RESUMED: "Retry/resume authorized.", ACKNOWLEDGED: "Inbox entry closed.", INBOX_ARCHIVED: "Inbox result archived by bounded retention policy." };
  if (fixed[event.action] && event.result !== fixed[event.action]) return false;
  if (event.action === "CREATED") return from === null && event.toStatus === "QUEUED" && event.nextEligibilityAt === null && zeroAttemptUsage(event);
  if (event.action === "DISPATCHED") return from === "QUEUED" && event.toStatus === "RUNNING" && event.nextEligibilityAt === null && zeroAttemptUsage(event);
  if (event.action === "WAITING_TOOL") return from === "RUNNING" && event.toStatus === "WAITING_TOOL" && !!event.result && event.nextEligibilityAt === null && zeroAttemptUsage(event);
  if (event.action === "TOOL_RESUMED") return from === "WAITING_TOOL" && event.toStatus === "RUNNING" && event.nextEligibilityAt === null && zeroAttemptUsage(event);
  if (event.action === "RETRY_BLOCKED") return (from === "RUNNING" || from === "WAITING_TOOL") && event.toStatus === "BLOCKED" && !!event.result && !!event.nextEligibilityAt && Date.parse(event.nextEligibilityAt) > Date.parse(event.at);
  if (event.action === "RESTART_INTERRUPTED") return (from === "RUNNING" || from === "WAITING_TOOL") && event.toStatus === "BLOCKED" && event.result?.startsWith("Executor interrupted by server restart;") === true && event.nextEligibilityAt === event.at && zeroAttemptUsage(event);
  if (event.action === "RESUMED") return from === "BLOCKED" && event.toStatus === "QUEUED" && event.nextEligibilityAt === null && zeroAttemptUsage(event);
  if (event.action === "COMPLETED") return from === "RUNNING" && event.toStatus === "COMPLETED" && !!event.result && event.nextEligibilityAt === null;
  if (event.action === "FAILED") return from !== null && ["QUEUED", "RUNNING", "WAITING_TOOL", "BLOCKED"].includes(from) && event.toStatus === "FAILED" && !!event.result && event.nextEligibilityAt === null;
  if (event.action === "CANCELLED") return from !== null && ["QUEUED", "RUNNING", "WAITING_TOOL", "BLOCKED"].includes(from) && event.toStatus === "CANCELLED" && !!event.result && event.nextEligibilityAt === null;
  if (event.action === "ACKNOWLEDGED") return from !== null && ["COMPLETED", "FAILED", "CANCELLED"].includes(from) && event.toStatus === "ACKNOWLEDGED" && event.nextEligibilityAt === null && zeroAttemptUsage(event);
  return event.action === "INBOX_ARCHIVED" && from === "COMPLETED" && event.toStatus === "COMPLETED" && event.nextEligibilityAt === null && zeroAttemptUsage(event);
}
function zeroAttemptUsage(event: ContinuationAuditEvent) { return event.attemptUsage.elapsedMs === 0 && event.attemptUsage.tokens === 0 && event.attemptUsage.toolCalls === 0; }
function inboxProjectionIsValid(entry: ContinuationInboxEntry) { return Date.parse(entry.updatedAt) >= Date.parse(entry.createdAt) && Date.parse(entry.expiresAt) > Date.parse(entry.createdAt) && (entry.status === "UNREAD" ? entry.acknowledgedAt === null && entry.closedAt === null : entry.status === "ACKNOWLEDGED" ? entry.acknowledgedAt !== null && entry.closedAt === null : entry.closedAt !== null); }
function plainRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function hasActiveOwner(state: JsonContinuationState, owner: ContinuationRecord["owner"], exceptJobId?: string) { return Object.values(state.jobs).some((job) => job.owner === owner && job.jobId !== exceptJobId && continuationIsNonterminal(job)); }
