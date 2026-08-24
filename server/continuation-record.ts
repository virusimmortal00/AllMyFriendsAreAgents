import { createHash } from "node:crypto";
import { isAgentId } from "../shared/participants.js";
import type { TaskIdentity } from "../shared/task-domain.js";
import type { AgentId } from "./types.js";

export const CONTINUATION_SCHEMA_VERSION = 1;
export const CONTINUATION_POLICY_VERSION = "continuation-policy-v1";
export const CONTINUATION_STATUSES = ["QUEUED", "RUNNING", "WAITING_TOOL", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED", "ACKNOWLEDGED"] as const;
export type ContinuationStatus = typeof CONTINUATION_STATUSES[number];
export const INBOX_STATUSES = ["UNREAD", "ACKNOWLEDGED", "CLOSED", "ARCHIVED"] as const;
export type ContinuationInboxStatus = typeof INBOX_STATUSES[number];
export const CONTINUATION_CAPABILITIES = ["ANALYZE", "EDIT_ASSIGNMENT_WORKSPACE", "RUN_TESTS"] as const;
export type ContinuationCapability = typeof CONTINUATION_CAPABILITIES[number];

export interface ContinuationBudget { readonly timeMs: number; readonly tokenLimit: number; readonly toolCallLimit: number; readonly retryLimit: number }
export interface ContinuationUsage { readonly elapsedMs: number; readonly tokens: number; readonly toolCalls: number; readonly attempts: number }
export interface ContinuationAuthorityEpoch {
  readonly assignmentId: string; readonly developerMemberId: string; readonly developerMemberConfigRevision: number;
  readonly agent: AgentId; readonly fencingToken: number; readonly manifestRevision: number; readonly pinnedBaseSha: string;
}
export interface ContinuationPolicy {
  readonly schemaVersion: 1; readonly policyVersion: typeof CONTINUATION_POLICY_VERSION; readonly revision: number;
  readonly roomId: string; readonly projectPathHash: string; readonly enabled: boolean; readonly maxConcurrentPerAgent: 1;
  readonly defaultBudget: ContinuationBudget; readonly maxInboxEntriesPerAgent: number; readonly inboxTtlMs: number;
  readonly retryBackoffMs: number; readonly updatedAt: string; readonly updatedBy: string;
}
export interface ContinuationRecord {
  readonly schemaVersion: 1; readonly jobId: string; readonly jobRevision: number; readonly roomId: string;
  readonly projectPathHash: string; readonly owner: AgentId; readonly task: TaskIdentity; readonly taskRevision: number;
  readonly assignmentReferenceId: string; readonly authority: ContinuationAuthorityEpoch; readonly objective: string;
  readonly trigger: string; readonly policyRevision: number; readonly policyVersion: typeof CONTINUATION_POLICY_VERSION;
  readonly capabilities: readonly ContinuationCapability[]; readonly status: ContinuationStatus; readonly budget: ContinuationBudget;
  readonly usage: ContinuationUsage; readonly cancellationRequested: boolean;
  readonly auditHeadHash: string | null; readonly auditEventCount: number;
  readonly resultDisposition: "PENDING" | "INBOX" | "CLOSED" | "ARCHIVED"; readonly resultSummary: string | null;
  readonly blocker: string | null; readonly nextEligibilityAt: string | null; readonly createdAt: string;
  readonly startedAt: string | null; readonly updatedAt: string; readonly completedAt: string | null;
}
export interface ContinuationInboxEntry {
  readonly schemaVersion: 1; readonly inboxEntryId: string; readonly inboxRevision: number; readonly jobId: string;
  readonly owner: AgentId; readonly roomId: string; readonly task: TaskIdentity; readonly taskRevision: number;
  readonly assignmentId: string; readonly status: ContinuationInboxStatus; readonly summary: string;
  readonly relevance: readonly string[]; readonly createdAt: string; readonly updatedAt: string; readonly expiresAt: string;
  readonly acknowledgedAt: string | null; readonly closedAt: string | null;
}
export type ContinuationAuditAction = "CREATED" | "DISPATCHED" | "WAITING_TOOL" | "TOOL_RESUMED" | "RETRY_BLOCKED" | "RESUMED" | "COMPLETED" | "FAILED" | "CANCELLED" | "RESTART_INTERRUPTED" | "ACKNOWLEDGED" | "INBOX_ARCHIVED";
export interface ContinuationAuditEvent {
  readonly schemaVersion: 1; readonly eventId: string; readonly jobId: string; readonly jobRevision: number;
  readonly attempt: number; readonly trigger: string; readonly policyRevision: number; readonly provenanceHash: string; readonly previousEventHash: string | null; readonly projectionHash: string; readonly eventHash: string; readonly at: string;
  readonly action: ContinuationAuditAction; readonly fromStatus: ContinuationStatus | null; readonly toStatus: ContinuationStatus;
  readonly usage: ContinuationUsage; readonly attemptUsage: { readonly elapsedMs: number; readonly tokens: number; readonly toolCalls: number }; readonly result: string | null; readonly nextEligibilityAt: string | null;
}

export type CasResult<T> = { readonly kind: "accepted"; readonly value: T } | { readonly kind: "conflict"; readonly actualRevision?: number } | { readonly kind: "not_found" };
export interface ContinuationRecordStore {
  getContinuationPolicy(): Promise<ContinuationPolicy | undefined>;
  compareAndSetContinuationPolicy(expectedRevision: number, policy: ContinuationPolicy): Promise<CasResult<ContinuationPolicy>>;
  listContinuations(owner?: AgentId): Promise<readonly ContinuationRecord[]>;
  getContinuation(jobId: string): Promise<ContinuationRecord | undefined>;
  createContinuation(record: ContinuationRecord, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>>;
  compareAndSetContinuation(expectedRevision: number, record: ContinuationRecord, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>>;
  completeContinuation(expectedRevision: number, record: ContinuationRecord, entry: ContinuationInboxEntry, maxEntries: number, event: ContinuationAuditEvent): Promise<CasResult<ContinuationRecord>>;
  listContinuationAudit(jobId: string): Promise<readonly ContinuationAuditEvent[]>;
  listContinuationInbox(owner: AgentId): Promise<readonly ContinuationInboxEntry[]>;
  getContinuationInboxEntry(inboxEntryId: string): Promise<ContinuationInboxEntry | undefined>;
  compareAndSetContinuationInbox(expectedRevision: number, entry: ContinuationInboxEntry): Promise<CasResult<ContinuationInboxEntry>>;
  archiveContinuationInbox(expectedRevision: number, entry: ContinuationInboxEntry): Promise<CasResult<ContinuationInboxEntry>>;
}

const TRANSITIONS: Record<ContinuationStatus, readonly ContinuationStatus[]> = {
  QUEUED: ["RUNNING", "CANCELLED", "FAILED"], RUNNING: ["WAITING_TOOL", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING_TOOL: ["RUNNING", "BLOCKED", "FAILED", "CANCELLED"], BLOCKED: ["QUEUED", "FAILED", "CANCELLED"],
  COMPLETED: ["ACKNOWLEDGED"], FAILED: ["ACKNOWLEDGED"], CANCELLED: ["ACKNOWLEDGED"], ACKNOWLEDGED: [],
};
export function canTransitionContinuation(from: ContinuationStatus, to: ContinuationStatus) { return TRANSITIONS[from].includes(to); }
const INBOX_TRANSITIONS: Record<ContinuationInboxStatus, readonly ContinuationInboxStatus[]> = { UNREAD: ["ACKNOWLEDGED", "CLOSED", "ARCHIVED"], ACKNOWLEDGED: ["CLOSED", "ARCHIVED"], CLOSED: [], ARCHIVED: [] };
export function canTransitionContinuationInbox(from: ContinuationInboxStatus, to: ContinuationInboxStatus) { return INBOX_TRANSITIONS[from].includes(to); }
export function continuationIsNonterminal(record: Pick<ContinuationRecord, "status">) { return ["QUEUED", "RUNNING", "WAITING_TOOL", "BLOCKED"].includes(record.status); }
export function projectPathHash(projectPath: string) { return createHash("sha256").update(projectPath).digest("hex"); }

export function normalizeContinuationPolicy(value: unknown): ContinuationPolicy | undefined {
  if (!value || typeof value !== "object") return undefined; const p = value as Partial<ContinuationPolicy>;
  if (p.schemaVersion !== 1 || p.policyVersion !== CONTINUATION_POLICY_VERSION || !positive(p.revision) || !validId(p.roomId)
    || !hash(p.projectPathHash) || typeof p.enabled !== "boolean" || p.maxConcurrentPerAgent !== 1 || !validBudget(p.defaultBudget)
    || !positive(p.maxInboxEntriesPerAgent) || p.maxInboxEntriesPerAgent! > 100 || !positive(p.inboxTtlMs)
    || !positive(p.retryBackoffMs) || !validDate(p.updatedAt) || !boundedText(p.updatedBy, 200)) return undefined;
  return structuredClone(p as ContinuationPolicy);
}
export function normalizeContinuationRecord(value: unknown): ContinuationRecord | undefined {
  if (!value || typeof value !== "object") return undefined; const r = value as Partial<ContinuationRecord>; const a = r.authority as Partial<ContinuationAuthorityEpoch> | undefined;
  if (r.schemaVersion !== 1 || !validId(r.jobId) || !positive(r.jobRevision) || !validId(r.roomId) || !hash(r.projectPathHash)
    || !isAgentId(r.owner) || !r.task || r.task.roomId !== r.roomId || !validId(r.task.taskId) || !positive(r.taskRevision)
    || !validId(r.assignmentReferenceId) || !a || !validId(a.assignmentId) || !validId(a.developerMemberId)
    || !positive(a.developerMemberConfigRevision) || a.agent !== r.owner || !nonnegative(a.fencingToken) || !nonnegative(a.manifestRevision)
    || !sha(a.pinnedBaseSha) || !boundedText(r.objective, 4_000) || !boundedText(r.trigger, 500)
    || !positive(r.policyRevision) || r.policyVersion !== CONTINUATION_POLICY_VERSION || !Array.isArray(r.capabilities)
    || r.capabilities.some((c) => !CONTINUATION_CAPABILITIES.includes(c)) || !CONTINUATION_STATUSES.includes(r.status as ContinuationStatus)
    || !validBudget(r.budget) || !validUsage(r.usage) || typeof r.cancellationRequested !== "boolean" || !nullableHash(r.auditHeadHash) || !nonnegative(r.auditEventCount)
    || !["PENDING", "INBOX", "CLOSED", "ARCHIVED"].includes(r.resultDisposition || "") || !nullableText(r.resultSummary, 16_000)
    || !nullableText(r.blocker, 2_000) || !nullableDate(r.nextEligibilityAt) || !validDate(r.createdAt) || !nullableDate(r.startedAt)
    || !validDate(r.updatedAt) || !nullableDate(r.completedAt)) return undefined;
  return structuredClone(r as ContinuationRecord);
}
export function normalizeContinuationInboxEntry(value: unknown): ContinuationInboxEntry | undefined {
  if (!value || typeof value !== "object") return undefined; const e = value as Partial<ContinuationInboxEntry>;
  if (e.schemaVersion !== 1 || !validId(e.inboxEntryId) || !positive(e.inboxRevision) || !validId(e.jobId) || !isAgentId(e.owner)
    || !validId(e.roomId) || !e.task || e.task.roomId !== e.roomId || !validId(e.task.taskId) || !positive(e.taskRevision)
    || !validId(e.assignmentId) || !INBOX_STATUSES.includes(e.status as ContinuationInboxStatus) || !boundedText(e.summary, 16_000)
    || !Array.isArray(e.relevance) || e.relevance.length > 16 || e.relevance.some((v) => !boundedText(v, 160))
    || !validDate(e.createdAt) || !validDate(e.updatedAt) || !validDate(e.expiresAt) || !nullableDate(e.acknowledgedAt) || !nullableDate(e.closedAt)) return undefined;
  return structuredClone(e as ContinuationInboxEntry);
}
export function normalizeContinuationAuditEvent(value: unknown): ContinuationAuditEvent | undefined {
  if (!value || typeof value !== "object") return undefined; const e = value as Partial<ContinuationAuditEvent>;
  if (e.schemaVersion !== 1 || !validId(e.eventId) || !validId(e.jobId) || !positive(e.jobRevision) || !nonnegative(e.attempt)
    || !boundedText(e.trigger, 500) || !positive(e.policyRevision) || !hash(e.provenanceHash) || !nullableHash(e.previousEventHash) || !hash(e.projectionHash) || !hash(e.eventHash) || !validDate(e.at) || !["CREATED", "DISPATCHED", "WAITING_TOOL", "TOOL_RESUMED", "RETRY_BLOCKED", "RESUMED", "COMPLETED", "FAILED", "CANCELLED", "RESTART_INTERRUPTED", "ACKNOWLEDGED", "INBOX_ARCHIVED"].includes(e.action || "")
    || !(e.fromStatus === null || CONTINUATION_STATUSES.includes(e.fromStatus as ContinuationStatus)) || !CONTINUATION_STATUSES.includes(e.toStatus as ContinuationStatus)
    || !validUsage(e.usage) || !validAttemptUsage(e.attemptUsage) || !nullableText(e.result, 2_000) || !nullableDate(e.nextEligibilityAt)) return undefined;
  return structuredClone(e as ContinuationAuditEvent);
}
export function redactContinuationText(value: string) {
  return value.replace(/<(analysis|reasoning|thinking)>[\s\S]*?(?:<\/\1>|$)/gi, "[REDACTED]")
    .replace(/(?:sk|ghp|github_pat|Bearer)[-_\s]?[A-Za-z0-9_=-]{12,}/gi, "[REDACTED]");
}
export function continuationRecordIsCanonical(record: ContinuationRecord, roomId: string) { return record.roomId === roomId && record.task.roomId === roomId; }
export function continuationRecordProvenanceMatches(before: ContinuationRecord, after: ContinuationRecord) {
  return JSON.stringify(immutableProvenance(before)) === JSON.stringify(immutableProvenance(after));
}
export function continuationProvenanceHash(record: ContinuationRecord) { return createHash("sha256").update(canonicalJson(immutableProvenance(record))).digest("hex"); }
export type ContinuationAuditDraft = Omit<ContinuationAuditEvent, "previousEventHash" | "projectionHash" | "eventHash">;
export function finalizeContinuationAudit(record: ContinuationRecord, draft: ContinuationAuditDraft): ContinuationAuditEvent {
  const previousEventHash = record.auditHeadHash; const projectionHash = continuationProjectionHash(record);
  const unsigned = { ...draft, previousEventHash, projectionHash }; const eventHash = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
  (record as { auditHeadHash: string | null; auditEventCount: number }).auditHeadHash = eventHash; (record as { auditHeadHash: string | null; auditEventCount: number }).auditEventCount += 1;
  return { ...unsigned, eventHash };
}
export function continuationAuditHashMatches(record: ContinuationRecord, event: ContinuationAuditEvent, previousHash: string | null) {
  return continuationEventHashMatches(event, previousHash) && event.projectionHash === continuationProjectionHash(record) && record.auditHeadHash === event.eventHash && record.auditEventCount === record.jobRevision;
}
export function continuationEventHashMatches(event: ContinuationAuditEvent, previousHash: string | null) { const { eventHash, ...unsigned } = event; return event.previousEventHash === previousHash && eventHash === createHash("sha256").update(canonicalJson(unsigned)).digest("hex"); }
function continuationProjectionHash(record: ContinuationRecord) { const { auditHeadHash: _head, auditEventCount: _count, ...projection } = record; return createHash("sha256").update(canonicalJson(projection)).digest("hex"); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
export function continuationInboxProvenanceMatches(before: ContinuationInboxEntry, after: ContinuationInboxEntry) {
  return JSON.stringify({ schemaVersion: before.schemaVersion, inboxEntryId: before.inboxEntryId, jobId: before.jobId, owner: before.owner, roomId: before.roomId, task: before.task, taskRevision: before.taskRevision, assignmentId: before.assignmentId, summary: before.summary, relevance: before.relevance, createdAt: before.createdAt, expiresAt: before.expiresAt })
    === JSON.stringify({ schemaVersion: after.schemaVersion, inboxEntryId: after.inboxEntryId, jobId: after.jobId, owner: after.owner, roomId: after.roomId, task: after.task, taskRevision: after.taskRevision, assignmentId: after.assignmentId, summary: after.summary, relevance: after.relevance, createdAt: after.createdAt, expiresAt: after.expiresAt });
}
export function continuationInboxMatchesJob(entry: ContinuationInboxEntry, job: ContinuationRecord) {
  return entry.jobId === job.jobId && entry.roomId === job.roomId && entry.owner === job.owner && entry.task.roomId === job.task.roomId && entry.task.taskId === job.task.taskId && entry.taskRevision === job.taskRevision && entry.assignmentId === job.authority.assignmentId;
}
export function continuationInboxStartsJobResult(entry: ContinuationInboxEntry, job: ContinuationRecord) {
  return continuationInboxMatchesJob(entry, job) && entry.inboxRevision === 1 && entry.status === "UNREAD" && entry.summary === job.resultSummary
    && entry.createdAt === job.completedAt && continuationInboxProjectionIsValid(entry)
    && job.status === "COMPLETED" && job.resultDisposition === "INBOX" && job.completedAt !== null;
}
export function continuationInboxProjectionIsValid(entry: ContinuationInboxEntry) {
  return Date.parse(entry.updatedAt) >= Date.parse(entry.createdAt) && Date.parse(entry.expiresAt) > Date.parse(entry.createdAt)
    && (entry.status === "UNREAD" ? entry.acknowledgedAt === null && entry.closedAt === null
      : entry.status === "ACKNOWLEDGED" ? entry.acknowledgedAt !== null && entry.closedAt === null
        : entry.closedAt !== null);
}
export function continuationInboxMutationMatches(before: ContinuationInboxEntry, after: ContinuationInboxEntry, archive: boolean) {
  return after.inboxRevision === before.inboxRevision + 1 && continuationInboxProvenanceMatches(before, after)
    && continuationInboxProjectionIsValid(after) && canTransitionContinuationInbox(before.status, after.status)
    && (archive ? after.status === "ARCHIVED" : after.status !== "ARCHIVED");
}
export function continuationAuditMatches(before: ContinuationRecord | null, after: ContinuationRecord, candidate: ContinuationAuditEvent | undefined) {
  if (!candidate || !continuationProjectionMatches(before, after) || !continuationUsageProgresses(before, after)) return false;
  const actions = auditActions(before?.status ?? null, after); if (!actions.includes(candidate.action)) return false;
  const result = auditResult(candidate.action, after);
  const attemptUsage = before ? { elapsedMs: after.usage.elapsedMs - before.usage.elapsedMs, tokens: after.usage.tokens - before.usage.tokens, toolCalls: after.usage.toolCalls - before.usage.toolCalls } : { elapsedMs: 0, tokens: 0, toolCalls: 0 };
  return candidate.jobId === after.jobId && candidate.jobRevision === after.jobRevision && candidate.attempt === after.usage.attempts
    && candidate.trigger === after.trigger && candidate.policyRevision === after.policyRevision && candidate.provenanceHash === continuationProvenanceHash(after) && candidate.at === after.updatedAt
    && candidate.fromStatus === (before?.status ?? null) && candidate.toStatus === after.status && candidate.result === result
    && candidate.nextEligibilityAt === after.nextEligibilityAt && JSON.stringify(candidate.usage) === JSON.stringify(after.usage)
    && JSON.stringify(candidate.attemptUsage) === JSON.stringify(attemptUsage) && continuationAuditStepMatches(before?.status ?? null, candidate)
    && continuationAuditHashMatches(after, candidate, before?.auditHeadHash ?? null);
}
export function continuationAuditStepMatches(from: ContinuationStatus | null, event: ContinuationAuditEvent) {
  const fixed: Partial<Record<ContinuationAuditAction, string>> = { CREATED: "Queued by authorized developer.", DISPATCHED: "Executor dispatch started.", TOOL_RESUMED: "Tool work resumed.", RESUMED: "Retry/resume authorized.", ACKNOWLEDGED: "Inbox entry closed.", INBOX_ARCHIVED: "Inbox result archived by bounded retention policy." };
  if (fixed[event.action] && event.result !== fixed[event.action]) return false;
  const zero = event.attemptUsage.elapsedMs === 0 && event.attemptUsage.tokens === 0 && event.attemptUsage.toolCalls === 0;
  if (event.action === "CREATED") return from === null && event.toStatus === "QUEUED" && event.nextEligibilityAt === null && zero;
  if (event.action === "DISPATCHED") return from === "QUEUED" && event.toStatus === "RUNNING" && event.nextEligibilityAt === null && zero;
  if (event.action === "WAITING_TOOL") return from === "RUNNING" && event.toStatus === "WAITING_TOOL" && !!event.result && event.nextEligibilityAt === null && zero;
  if (event.action === "TOOL_RESUMED") return from === "WAITING_TOOL" && event.toStatus === "RUNNING" && event.nextEligibilityAt === null && zero;
  if (event.action === "RETRY_BLOCKED") return (from === "RUNNING" || from === "WAITING_TOOL") && event.toStatus === "BLOCKED" && !!event.result && !!event.nextEligibilityAt && Date.parse(event.nextEligibilityAt) > Date.parse(event.at);
  if (event.action === "RESTART_INTERRUPTED") return (from === "RUNNING" || from === "WAITING_TOOL") && event.toStatus === "BLOCKED" && event.result?.startsWith("Executor interrupted by server restart;") === true && event.nextEligibilityAt === event.at && zero;
  if (event.action === "RESUMED") return from === "BLOCKED" && event.toStatus === "QUEUED" && event.nextEligibilityAt === null && zero;
  if (event.action === "COMPLETED") return from === "RUNNING" && event.toStatus === "COMPLETED" && !!event.result && event.nextEligibilityAt === null;
  if (event.action === "FAILED") return from !== null && ["QUEUED", "RUNNING", "WAITING_TOOL", "BLOCKED"].includes(from) && event.toStatus === "FAILED" && !!event.result && event.nextEligibilityAt === null;
  if (event.action === "CANCELLED") return from !== null && ["QUEUED", "RUNNING", "WAITING_TOOL", "BLOCKED"].includes(from) && event.toStatus === "CANCELLED" && !!event.result && event.nextEligibilityAt === null;
  if (event.action === "ACKNOWLEDGED") return from !== null && ["COMPLETED", "FAILED", "CANCELLED"].includes(from) && event.toStatus === "ACKNOWLEDGED" && event.nextEligibilityAt === null && zero;
  return event.action === "INBOX_ARCHIVED" && from === "COMPLETED" && event.toStatus === "COMPLETED" && event.nextEligibilityAt === null && zero;
}
function immutableProvenance(record: ContinuationRecord) { return { schemaVersion: record.schemaVersion, jobId: record.jobId, roomId: record.roomId, projectPathHash: record.projectPathHash, owner: record.owner, task: record.task, taskRevision: record.taskRevision, assignmentReferenceId: record.assignmentReferenceId, authority: record.authority, objective: record.objective, trigger: record.trigger, policyRevision: record.policyRevision, policyVersion: record.policyVersion, capabilities: record.capabilities, budget: record.budget, createdAt: record.createdAt }; }
export function continuationProjectionMatches(before: ContinuationRecord | null, after: ContinuationRecord) {
  if (!continuationProjectionIsValid(after)) return false;
  if (!before) return after.status === "QUEUED" && after.jobRevision === 1;
  if (after.jobRevision !== before.jobRevision + 1) return false;
  if (after.status === before.status) return before.status === "COMPLETED" && before.resultDisposition === "INBOX" && after.resultDisposition === "ARCHIVED"
    && after.startedAt === before.startedAt && after.completedAt === before.completedAt && after.resultSummary === before.resultSummary && after.blocker === before.blocker
    && after.nextEligibilityAt === before.nextEligibilityAt && after.cancellationRequested === before.cancellationRequested;
  if (!canTransitionContinuation(before.status, after.status)) return false;
  const expectedStartedAt = before.status === "QUEUED" && after.status === "RUNNING" ? before.startedAt ?? after.updatedAt : before.startedAt;
  if (after.startedAt !== expectedStartedAt) return false;
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(after.status)) return after.completedAt === after.updatedAt;
  if (after.status === "ACKNOWLEDGED") return after.completedAt === before.completedAt && after.resultSummary === before.resultSummary && after.blocker === before.blocker && after.cancellationRequested === before.cancellationRequested;
  return after.completedAt === before.completedAt;
}
export function continuationProjectionIsValid(record: ContinuationRecord) {
  if (!record.auditHeadHash || record.auditEventCount !== record.jobRevision || Date.parse(record.updatedAt) < Date.parse(record.createdAt) || record.startedAt && Date.parse(record.startedAt) > Date.parse(record.updatedAt) || record.completedAt && Date.parse(record.completedAt) > Date.parse(record.updatedAt)) return false;
  if (record.status === "QUEUED") return record.resultDisposition === "PENDING" && record.resultSummary === null && record.blocker === null && record.nextEligibilityAt === null && record.completedAt === null && !record.cancellationRequested;
  if (record.status === "RUNNING") return record.startedAt !== null && record.resultDisposition === "PENDING" && record.resultSummary === null && record.blocker === null && record.nextEligibilityAt === null && record.completedAt === null && !record.cancellationRequested;
  if (record.status === "WAITING_TOOL") return record.startedAt !== null && record.resultDisposition === "PENDING" && record.resultSummary === null && record.blocker !== null && record.nextEligibilityAt === null && record.completedAt === null && !record.cancellationRequested;
  if (record.status === "BLOCKED") return record.startedAt !== null && record.resultDisposition === "PENDING" && record.resultSummary === null && record.blocker !== null && record.nextEligibilityAt !== null && record.completedAt === null && !record.cancellationRequested;
  if (record.status === "COMPLETED") return record.startedAt !== null && (record.resultDisposition === "INBOX" || record.resultDisposition === "ARCHIVED") && record.resultSummary !== null && record.blocker === null && record.nextEligibilityAt === null && record.completedAt !== null && !record.cancellationRequested;
  if (record.status === "FAILED") return record.resultDisposition === "CLOSED" && record.resultSummary === null && record.blocker !== null && record.nextEligibilityAt === null && record.completedAt !== null && !record.cancellationRequested;
  if (record.status === "CANCELLED") return record.resultDisposition === "CLOSED" && record.resultSummary === null && record.blocker !== null && record.nextEligibilityAt === null && record.completedAt !== null && record.cancellationRequested;
  return record.resultDisposition === "CLOSED" && record.nextEligibilityAt === null && record.completedAt !== null && (record.resultSummary !== null && record.blocker === null && !record.cancellationRequested || record.resultSummary === null && record.blocker !== null);
}
function continuationUsageProgresses(before: ContinuationRecord | null, after: ContinuationRecord) {
  if (!before) return after.status === "QUEUED" && after.jobRevision === 1 && after.usage.elapsedMs === 0 && after.usage.tokens === 0 && after.usage.toolCalls === 0 && after.usage.attempts === 0 && after.createdAt === after.updatedAt && after.startedAt === null && after.completedAt === null && after.resultDisposition === "PENDING" && after.resultSummary === null && after.blocker === null && after.nextEligibilityAt === null && !after.cancellationRequested;
  const dispatch = before.status === "QUEUED" && after.status === "RUNNING";
  return after.usage.elapsedMs >= before.usage.elapsedMs && after.usage.tokens >= before.usage.tokens && after.usage.toolCalls >= before.usage.toolCalls
    && after.usage.attempts === before.usage.attempts + (dispatch ? 1 : 0) && Date.parse(after.updatedAt) >= Date.parse(before.updatedAt);
}
function auditActions(from: ContinuationStatus | null, after: ContinuationRecord): readonly ContinuationAuditAction[] { const to = after.status;
  if (from === to) return ["INBOX_ARCHIVED"];
  if (from === null && to === "QUEUED") return ["CREATED"];
  if (from === "QUEUED" && to === "RUNNING") return ["DISPATCHED"];
  if (from === "RUNNING" && to === "WAITING_TOOL") return ["WAITING_TOOL"];
  if (from === "WAITING_TOOL" && to === "RUNNING") return ["TOOL_RESUMED"];
  if ((from === "RUNNING" || from === "WAITING_TOOL") && to === "BLOCKED") return after.blocker?.startsWith("Executor interrupted by server restart;") ? ["RESTART_INTERRUPTED"] : ["RETRY_BLOCKED"];
  if (from === "BLOCKED" && to === "QUEUED") return ["RESUMED"];
  if (to === "COMPLETED") return ["COMPLETED"];
  if (to === "FAILED") return ["FAILED"];
  if (to === "CANCELLED") return ["CANCELLED"];
  if (to === "ACKNOWLEDGED") return ["ACKNOWLEDGED"];
  return [];
}
function auditResult(action: ContinuationAuditAction, record: ContinuationRecord): string | null {
  if (action === "CREATED") return "Queued by authorized developer.";
  if (action === "DISPATCHED") return "Executor dispatch started.";
  if (action === "TOOL_RESUMED") return "Tool work resumed.";
  if (action === "RESUMED") return "Retry/resume authorized.";
  if (action === "ACKNOWLEDGED") return "Inbox entry closed.";
  if (action === "INBOX_ARCHIVED") return "Inbox result archived by bounded retention policy.";
  if (action === "COMPLETED") return record.resultSummary;
  return record.blocker;
}
function validBudget(value: unknown): value is ContinuationBudget { const b = value as Partial<ContinuationBudget> | undefined; return !!b && positive(b.timeMs) && positive(b.tokenLimit) && positive(b.toolCallLimit) && nonnegative(b.retryLimit); }
function validUsage(value: unknown): value is ContinuationUsage { const u = value as Partial<ContinuationUsage> | undefined; return !!u && nonnegative(u.elapsedMs) && nonnegative(u.tokens) && nonnegative(u.toolCalls) && nonnegative(u.attempts); }
function validAttemptUsage(value: unknown): value is ContinuationAuditEvent["attemptUsage"] { const u = value as Partial<ContinuationAuditEvent["attemptUsage"]> | undefined; return !!u && nonnegative(u.elapsedMs) && nonnegative(u.tokens) && nonnegative(u.toolCalls); }
function validId(v: unknown): v is string { return typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/.test(v); }
function boundedText(v: unknown, n: number): v is string { return typeof v === "string" && v.trim().length > 0 && v.length <= n; }
function nullableText(v: unknown, n: number) { return v === null || typeof v === "string" && v.length <= n; }
function validDate(v: unknown): v is string { return typeof v === "string" && Number.isFinite(Date.parse(v)); }
function nullableDate(v: unknown) { return v === null || validDate(v); }
function positive(v: unknown): v is number { return Number.isSafeInteger(v) && Number(v) > 0; }
function nonnegative(v: unknown): v is number { return Number.isSafeInteger(v) && Number(v) >= 0; }
function hash(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{64}$/.test(v); }
function nullableHash(v: unknown): v is string | null { return v === null || hash(v); }
function sha(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{40,64}$/.test(v); }
