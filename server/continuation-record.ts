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
  readonly attempt: number; readonly trigger: string; readonly policyRevision: number; readonly at: string;
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
    || !validBudget(r.budget) || !validUsage(r.usage) || typeof r.cancellationRequested !== "boolean"
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
    || !boundedText(e.trigger, 500) || !positive(e.policyRevision) || !validDate(e.at) || !["CREATED", "DISPATCHED", "WAITING_TOOL", "TOOL_RESUMED", "RETRY_BLOCKED", "RESUMED", "COMPLETED", "FAILED", "CANCELLED", "RESTART_INTERRUPTED", "ACKNOWLEDGED", "INBOX_ARCHIVED"].includes(e.action || "")
    || !(e.fromStatus === null || CONTINUATION_STATUSES.includes(e.fromStatus as ContinuationStatus)) || !CONTINUATION_STATUSES.includes(e.toStatus as ContinuationStatus)
    || !validUsage(e.usage) || !validAttemptUsage(e.attemptUsage) || !nullableText(e.result, 2_000) || !nullableDate(e.nextEligibilityAt)) return undefined;
  return structuredClone(e as ContinuationAuditEvent);
}
export function redactContinuationText(value: string) {
  return value.replace(/<(analysis|reasoning|thinking)>[\s\S]*?(?:<\/\1>|$)/gi, "[REDACTED]")
    .replace(/(?:sk|ghp|github_pat|Bearer)[-_\s]?[A-Za-z0-9_=-]{12,}/gi, "[REDACTED]");
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
function sha(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{40,64}$/.test(v); }
