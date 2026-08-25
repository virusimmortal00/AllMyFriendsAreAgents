import { createHash } from "node:crypto";
import { isAgentId } from "../shared/participants.js";
import type { AgentId } from "./types.js";

export const INVESTIGATION_SCHEMA_VERSION = 1;
export const INVESTIGATION_POLICY_VERSION = "investigation-policy-v1";
export const INVESTIGATION_STATUSES = ["REQUESTED", "QUEUED", "RUNNING", "WAITING_TOOL", "CHECKPOINTED", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED", "ACKNOWLEDGED", "ARCHIVED"] as const;
export type InvestigationStatus = typeof INVESTIGATION_STATUSES[number];
export type InvestigationSignal = "AGENT_DECISION" | "AUTHENTICATED_HUMAN" | "TRUSTED_POLICY";
export type InvestigationEvidenceRef = { readonly kind: "room_message" | "project_artifact" | "observability"; readonly ref: string; readonly label?: string };
export interface InvestigationBudget { readonly timeMs: number; readonly tokenLimit: number; readonly toolCallLimit: number; readonly retryLimit: number }
export interface InvestigationUsage { readonly elapsedMs: number; readonly tokens: number; readonly toolCalls: number; readonly attempts: number }
export interface InvestigationCheckpoint { readonly schemaVersion: 1; readonly attempt: number; readonly summary: string; readonly opaqueState: string; readonly createdAt: string; readonly digest: string }
export interface InvestigationPolicy {
  readonly schemaVersion: 1; readonly policyVersion: typeof INVESTIGATION_POLICY_VERSION; readonly revision: number; readonly enabled: boolean;
  readonly projectPathHash: string; readonly maxConcurrentGlobal: number; readonly maxConcurrentPerAgent: 1; readonly defaultBudget: InvestigationBudget;
  readonly maxInboxEntriesPerAgent: number; readonly inboxTtlMs: number; readonly updatedAt: string; readonly updatedBy: string;
}
export interface InvestigationRecord {
  readonly schemaVersion: 1; readonly investigationId: string; readonly revision: number; readonly owner: AgentId; readonly objective: string;
  readonly trigger: string; readonly signal: InvestigationSignal; readonly evidenceRefs: readonly InvestigationEvidenceRef[]; readonly contextSnapshot: string;
  readonly projectPathHash: string; readonly policyRevision: number; readonly policyVersion: typeof INVESTIGATION_POLICY_VERSION;
  readonly capabilities: readonly ["READ_PROJECT", "READ_OBSERVABILITY", "RUN_READ_ONLY_TESTS"];
  readonly status: InvestigationStatus; readonly budget: InvestigationBudget; readonly usage: InvestigationUsage; readonly providerSessionId: string | null;
  readonly checkpoint: InvestigationCheckpoint | null; readonly resultSummary: string | null; readonly resultEvidence: readonly InvestigationEvidenceRef[];
  readonly unresolvedQuestions: readonly string[]; readonly resultWaiting: boolean; readonly blocker: string | null;
  readonly createdAt: string; readonly startedAt: string | null; readonly updatedAt: string; readonly completedAt: string | null;
}
export interface InvestigationInboxEntry {
  readonly schemaVersion: 1; readonly inboxEntryId: string; readonly revision: number; readonly investigationId: string; readonly owner: AgentId;
  readonly status: "UNREAD" | "ACKNOWLEDGED" | "CLOSED" | "ARCHIVED"; readonly summary: string; readonly evidenceRefs: readonly InvestigationEvidenceRef[];
  readonly unresolvedQuestions: readonly string[]; readonly createdAt: string; readonly updatedAt: string; readonly expiresAt: string;
}
export interface InvestigationEvent {
  readonly schemaVersion: 1; readonly eventId: string; readonly investigationId: string; readonly revision: number; readonly at: string;
  readonly action: string; readonly fromStatus: InvestigationStatus | null; readonly toStatus: InvestigationStatus; readonly detail: string;
  readonly usage: InvestigationUsage; readonly previousHash: string | null; readonly projectionHash: string; readonly eventHash: string;
}
export interface InvestigationState { readonly schemaVersion: 1; readonly policy: InvestigationPolicy | null; readonly jobs: Record<string, InvestigationRecord>; readonly inbox: Record<string, InvestigationInboxEntry>; readonly events: readonly InvestigationEvent[] }

const NONTERMINAL = new Set<InvestigationStatus>(["REQUESTED", "QUEUED", "RUNNING", "WAITING_TOOL", "CHECKPOINTED", "BLOCKED"]);
const TRANSITIONS: Record<InvestigationStatus, readonly InvestigationStatus[]> = {
  REQUESTED: ["QUEUED", "FAILED", "CANCELLED"], QUEUED: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["WAITING_TOOL", "CHECKPOINTED", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"],
  WAITING_TOOL: ["RUNNING", "CHECKPOINTED", "BLOCKED", "FAILED", "CANCELLED"], CHECKPOINTED: ["QUEUED", "FAILED", "CANCELLED"],
  BLOCKED: ["QUEUED", "FAILED", "CANCELLED"], COMPLETED: ["ACKNOWLEDGED", "ARCHIVED"], FAILED: ["ACKNOWLEDGED", "ARCHIVED"],
  CANCELLED: ["ACKNOWLEDGED", "ARCHIVED"], ACKNOWLEDGED: ["ARCHIVED"], ARCHIVED: [],
};
export function investigationIsNonterminal(value: Pick<InvestigationRecord, "status">) { return NONTERMINAL.has(value.status); }
export function canTransitionInvestigation(from: InvestigationStatus, to: InvestigationStatus) { return TRANSITIONS[from].includes(to); }
export function investigationProjectHash(projectPath: string) { return createHash("sha256").update(projectPath).digest("hex"); }
export function checkpointDigest(investigationId: string, projectPathHash: string, checkpoint: Omit<InvestigationCheckpoint, "digest">) {
  return createHash("sha256").update(JSON.stringify({ investigationId, projectPathHash, ...checkpoint })).digest("hex");
}
export function makeInvestigationEvent(record: InvestigationRecord, previous: InvestigationEvent | undefined, action: string, fromStatus: InvestigationStatus | null, detail: string, eventId: string): InvestigationEvent {
  const unsigned = { schemaVersion: 1 as const, eventId, investigationId: record.investigationId, revision: record.revision, at: record.updatedAt, action, fromStatus, toStatus: record.status, detail: redactInvestigationText(detail).slice(0, 2_000), usage: record.usage, previousHash: previous?.eventHash ?? null, projectionHash: investigationProjectionHash(record) };
  return { ...unsigned, eventHash: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") };
}
export function redactInvestigationText(value: string) {
  return value.replace(/<(analysis|reasoning|thinking)>[\s\S]*?(?:<\/\1>|$)/gi, "[REDACTED]")
    .replace(/(?:sk|ghp|github_pat|Bearer)[-_\s]?[A-Za-z0-9_=-]{12,}/gi, "[REDACTED]");
}
export function emptyInvestigationState(): InvestigationState { return { schemaVersion: 1, policy: null, jobs: {}, inbox: {}, events: [] }; }
export function normalizeInvestigationState(value: unknown): InvestigationState {
  if (!value || typeof value !== "object" || (value as InvestigationState).schemaVersion !== 1) throw new Error("Invalid investigation state schema.");
  const state = value as InvestigationState;
  if (state.policy && !validPolicy(state.policy)) throw new Error("Invalid investigation policy.");
  if (!state.jobs || !state.inbox || !Array.isArray(state.events)) throw new Error("Invalid investigation durable state.");
  for (const [id, job] of Object.entries(state.jobs)) if (id !== job.investigationId || !validRecord(job)) throw new Error(`Invalid investigation ${id}.`);
  for (const [id, entry] of Object.entries(state.inbox)) if (id !== entry.inboxEntryId || !validInbox(entry) || !state.jobs[entry.investigationId]) throw new Error(`Invalid investigation inbox ${id}.`);
  const activeOwners = new Set<AgentId>();
  for (const job of Object.values(state.jobs)) if (investigationIsNonterminal(job)) { if (activeOwners.has(job.owner)) throw new Error("Multiple nonterminal investigations for one agent."); activeOwners.add(job.owner); }
  const providerSessions = new Set<string>();
  for (const job of Object.values(state.jobs)) if (job.providerSessionId) { if (providerSessions.has(job.providerSessionId)) throw new Error("Multiple investigations share one provider session."); providerSessions.add(job.providerSessionId); }
  const previous = new Map<string, InvestigationEvent>();
  for (const event of state.events) {
    const { eventHash: _eventHash, ...unsigned } = event;
    if (!validEvent(event) || event.previousHash !== (previous.get(event.investigationId)?.eventHash ?? null) || event.eventHash !== createHash("sha256").update(JSON.stringify(unsigned)).digest("hex")) throw new Error("Invalid investigation audit chain.");
    previous.set(event.investigationId, event);
  }
  for (const job of Object.values(state.jobs)) { const head = previous.get(job.investigationId); if (head?.revision !== job.revision || head.projectionHash !== investigationProjectionHash(job) || head.toStatus !== job.status || JSON.stringify(head.usage) !== JSON.stringify(job.usage)) throw new Error(`Investigation ${job.investigationId} has no matching audit head.`); }
  return structuredClone(state);
}

function validPolicy(p: InvestigationPolicy) { return p.schemaVersion === 1 && p.policyVersion === INVESTIGATION_POLICY_VERSION && positive(p.revision) && typeof p.enabled === "boolean" && hash(p.projectPathHash) && positive(p.maxConcurrentGlobal) && p.maxConcurrentGlobal <= 8 && p.maxConcurrentPerAgent === 1 && validBudget(p.defaultBudget) && positive(p.maxInboxEntriesPerAgent) && positive(p.inboxTtlMs) && date(p.updatedAt) && text(p.updatedBy, 200); }
function validRecord(r: InvestigationRecord) { return r.schemaVersion === 1 && id(r.investigationId) && positive(r.revision) && isAgentId(r.owner) && text(r.objective, 4_000) && text(r.trigger, 1_000) && ["AGENT_DECISION", "AUTHENTICATED_HUMAN", "TRUSTED_POLICY"].includes(r.signal) && validRefs(r.evidenceRefs) && typeof r.contextSnapshot === "string" && r.contextSnapshot.length <= 16_000 && hash(r.projectPathHash) && positive(r.policyRevision) && r.policyVersion === INVESTIGATION_POLICY_VERSION && JSON.stringify(r.capabilities) === JSON.stringify(["READ_PROJECT", "READ_OBSERVABILITY", "RUN_READ_ONLY_TESTS"]) && INVESTIGATION_STATUSES.includes(r.status) && validBudget(r.budget) && validUsage(r.usage) && (r.providerSessionId === null || text(r.providerSessionId, 500)) && validCheckpoint(r) && (r.resultSummary === null || text(r.resultSummary, 16_000)) && validRefs(r.resultEvidence) && Array.isArray(r.unresolvedQuestions) && r.unresolvedQuestions.length <= 16 && r.unresolvedQuestions.every((q) => text(q, 500)) && typeof r.resultWaiting === "boolean" && (r.blocker === null || text(r.blocker, 2_000)) && date(r.createdAt) && (r.startedAt === null || date(r.startedAt)) && date(r.updatedAt) && (r.completedAt === null || date(r.completedAt)); }
function validCheckpoint(r: InvestigationRecord) { const c = r.checkpoint; if (!c) return true; if (c.schemaVersion !== 1 || !positive(c.attempt) || !text(c.summary, 2_000) || typeof c.opaqueState !== "string" || c.opaqueState.length > 8_000 || !date(c.createdAt) || !hash(c.digest)) return false; const { digest: _digest, ...draft } = c; return c.digest === checkpointDigest(r.investigationId, r.projectPathHash, draft); }
function validInbox(e: InvestigationInboxEntry) { return e.schemaVersion === 1 && id(e.inboxEntryId) && positive(e.revision) && id(e.investigationId) && isAgentId(e.owner) && ["UNREAD", "ACKNOWLEDGED", "CLOSED", "ARCHIVED"].includes(e.status) && text(e.summary, 16_000) && validRefs(e.evidenceRefs) && Array.isArray(e.unresolvedQuestions) && e.unresolvedQuestions.length <= 16 && e.unresolvedQuestions.every((q) => text(q, 500)) && date(e.createdAt) && date(e.updatedAt) && date(e.expiresAt); }
function validEvent(e: InvestigationEvent) { return e.schemaVersion === 1 && id(e.eventId) && id(e.investigationId) && positive(e.revision) && date(e.at) && text(e.action, 100) && (e.fromStatus === null || INVESTIGATION_STATUSES.includes(e.fromStatus)) && INVESTIGATION_STATUSES.includes(e.toStatus) && typeof e.detail === "string" && e.detail.length <= 2_000 && validUsage(e.usage) && (e.previousHash === null || hash(e.previousHash)) && hash(e.projectionHash) && hash(e.eventHash); }
function investigationProjectionHash(record: InvestigationRecord) { return createHash("sha256").update(JSON.stringify(record)).digest("hex"); }
function validRefs(refs: readonly InvestigationEvidenceRef[]) { return Array.isArray(refs) && refs.length <= 32 && refs.every((r) => ["room_message", "project_artifact", "observability"].includes(r.kind) && text(r.ref, 1_000) && (r.label === undefined || text(r.label, 500))); }
function validBudget(b: InvestigationBudget) { return positive(b?.timeMs) && positive(b?.tokenLimit) && positive(b?.toolCallLimit) && Number.isSafeInteger(b?.retryLimit) && b.retryLimit >= 0; }
function validUsage(u: InvestigationUsage) { return Number.isSafeInteger(u?.elapsedMs) && u.elapsedMs >= 0 && Number.isSafeInteger(u?.tokens) && u.tokens >= 0 && Number.isSafeInteger(u?.toolCalls) && u.toolCalls >= 0 && Number.isSafeInteger(u?.attempts) && u.attempts >= 0; }
function positive(v: unknown): v is number { return Number.isSafeInteger(v) && Number(v) > 0; }
function id(v: unknown): v is string { return typeof v === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(v); }
function hash(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{64}$/.test(v); }
function date(v: unknown): v is string { return typeof v === "string" && Number.isFinite(Date.parse(v)); }
function text(v: unknown, max: number): v is string { return typeof v === "string" && v.trim().length > 0 && v.length <= max; }
