import { randomUUID } from "node:crypto";
import type { Task } from "../shared/task-domain.js";
import type { AssignmentLifecycleService } from "./assignment-lifecycle.js";
import type { AssignmentRecord } from "./assignment-record.js";
import {
  CONTINUATION_POLICY_VERSION, canTransitionContinuation, continuationIsNonterminal, projectPathHash,
  type ContinuationBudget, type ContinuationCapability, type ContinuationInboxEntry, type ContinuationPolicy,
  type ContinuationRecord, type ContinuationRecordStore, type ContinuationStatus, type ContinuationUsage,
} from "./continuation-record.js";
import { CANONICAL_ROOM_ID, type RoomRepository } from "./storage/room-repository.js";
import type { AgentId } from "./types.js";

export const DEFAULT_CONTINUATION_BUDGET: ContinuationBudget = Object.freeze({ timeMs: 60_000, tokenLimit: 8_000, toolCallLimit: 20, retryLimit: 1 });
const MAX_BUDGET: ContinuationBudget = Object.freeze({ timeMs: 300_000, tokenLimit: 20_000, toolCallLimit: 50, retryLimit: 3 });
const SAFE_CAPABILITIES: readonly ContinuationCapability[] = ["ANALYZE", "EDIT_ASSIGNMENT_WORKSPACE", "RUN_TESTS"];

export interface ContinuationExecutorInput {
  readonly jobId: string; readonly attempt: number; readonly owner: AgentId; readonly objective: string; readonly trigger: string;
  readonly task: { readonly roomId: string; readonly taskId: string; readonly revision: number };
  readonly assignmentId: string; readonly cwd: string; readonly capabilities: readonly ContinuationCapability[];
  readonly remainingBudget: Omit<ContinuationBudget, "retryLimit">; readonly signal: AbortSignal;
}
export interface ContinuationExecutorResult { readonly summary: string; readonly relevance?: readonly string[]; readonly usage: { readonly tokens: number; readonly toolCalls: number } }
export interface ContinuationExecutor { dispatch(input: ContinuationExecutorInput): Promise<ContinuationExecutorResult> }
export class HttpContinuationExecutor implements ContinuationExecutor {
  constructor(private readonly url: string, private readonly authorization?: string) {}
  async dispatch(input: ContinuationExecutorInput): Promise<ContinuationExecutorResult> {
    const response = await fetch(this.url, { method: "POST", signal: input.signal, headers: { "content-type": "application/json", ...(this.authorization ? { authorization: this.authorization } : {}) },
      body: JSON.stringify({ schemaVersion: 1, jobId: input.jobId, attempt: input.attempt, owner: input.owner, objective: input.objective, trigger: input.trigger,
        task: input.task, assignmentId: input.assignmentId, cwd: input.cwd, capabilities: input.capabilities, remainingBudget: input.remainingBudget,
        excludedCapabilities: ["COMMIT", "PUSH", "MERGE", "DEPLOY", "PUBLISH", "EXTERNAL_REQUEST"] }) });
    if (!response.ok) throw new Error(`Continuation executor returned HTTP ${response.status}.`);
    const body = await response.json() as Partial<ContinuationExecutorResult>;
    if (typeof body.summary !== "string" || !body.usage || !Number.isSafeInteger(body.usage.tokens) || !Number.isSafeInteger(body.usage.toolCalls)) throw new Error("Continuation executor returned an invalid bounded result.");
    return { summary: body.summary, relevance: Array.isArray(body.relevance) ? body.relevance.map(String) : [], usage: { tokens: body.usage.tokens, toolCalls: body.usage.toolCalls } };
  }
}
export type ContinuationResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "not_found" } | { readonly kind: "conflict"; readonly reason: string } | { readonly kind: "rejected"; readonly reason: string };

export class ContinuationService {
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly records: ContinuationRecordStore, private readonly rooms: RoomRepository,
    private readonly assignments: AssignmentLifecycleService, private readonly executor: ContinuationExecutor,
    private readonly options: { readonly now?: () => Date; readonly onTransition?: () => void; readonly configuredEnabled?: boolean } = {}) {}

  async initialize() {
    if (!await this.records.getContinuationPolicy()) {
      const now = this.now(); const policy: ContinuationPolicy = { schemaVersion: 1, policyVersion: CONTINUATION_POLICY_VERSION, revision: 1,
        roomId: CANONICAL_ROOM_ID, projectPathHash: projectPathHash(this.rooms.snapshot().settings.projectPath), enabled: this.options.configuredEnabled === true,
        maxConcurrentPerAgent: 1, defaultBudget: DEFAULT_CONTINUATION_BUDGET, maxInboxEntriesPerAgent: 20,
        inboxTtlMs: 7 * 24 * 60 * 60_000, retryBackoffMs: 5_000, updatedAt: now, updatedBy: "server-initialization" };
      await this.records.compareAndSetContinuationPolicy(0, policy);
    }
    return this.reconcile();
  }
  async policy() { return this.records.getContinuationPolicy(); }
  async updatePolicy(expectedRevision: number, update: { enabled: boolean }, actor: string) {
    const current = await this.records.getContinuationPolicy(); if (!current) return { kind: "not_found" } as const;
    const next = { ...current, revision: current.revision + 1, enabled: update.enabled, updatedAt: this.now(), updatedBy: actor };
    const result = await this.records.compareAndSetContinuationPolicy(expectedRevision, next);
    if (result.kind === "accepted") await this.cancelAll("Continuation policy revision changed.");
    return result;
  }
  async list(owner?: AgentId) { return this.records.listContinuations(owner); }
  async inbox(owner: AgentId) { await this.archiveExpired(owner); return this.records.listContinuationInbox(owner); }

  async create(input: { owner: AgentId; developerMemberId: string; developerMemberConfigRevision: number; taskId: string; taskRevision: number; assignmentReferenceId: string; objective: string; trigger: string; budget?: Partial<ContinuationBudget> }): Promise<ContinuationResult<ContinuationRecord>> {
    const policy = await this.currentPolicy(); if ("reason" in policy) return { kind: "rejected", reason: policy.reason };
    if ((await this.rooms.getEmergencyStop()).active) return { kind: "rejected", reason: "Emergency stop is active." };
    const task = await this.rooms.getTask({ roomId: CANONICAL_ROOM_ID, taskId: input.taskId });
    const authority = await this.authority(task, input.taskRevision, input.assignmentReferenceId, input.owner);
    if ("reason" in authority) return { kind: "rejected", reason: authority.reason! };
    if (authority.assignment.developerMemberId !== input.developerMemberId || authority.assignment.developerMemberConfigRevision !== input.developerMemberConfigRevision) return { kind: "rejected", reason: "Requesting developer identity does not own the assignment authority epoch." };
    const objective = input.objective?.trim(); const trigger = input.trigger?.trim();
    if (!objective || objective.length > 4_000 || !trigger || trigger.length > 500) return { kind: "rejected", reason: "A bounded objective and trigger are required." };
    const budget = boundedBudget(input.budget, policy.defaultBudget); if (!budget) return { kind: "rejected", reason: "Continuation budget exceeds policy limits." };
    const now = this.now(); const assignment = authority.assignment;
    const record: ContinuationRecord = { schemaVersion: 1, jobId: randomUUID(), jobRevision: 1, roomId: CANONICAL_ROOM_ID,
      projectPathHash: policy.projectPathHash, owner: input.owner, task: { roomId: CANONICAL_ROOM_ID, taskId: input.taskId }, taskRevision: input.taskRevision,
      assignmentReferenceId: input.assignmentReferenceId, authority: epoch(assignment), objective, trigger, policyRevision: policy.revision,
      policyVersion: policy.policyVersion, capabilities: SAFE_CAPABILITIES, status: "QUEUED", budget,
      usage: { elapsedMs: 0, tokens: 0, toolCalls: 0, attempts: 0 }, cancellationRequested: false, resultDisposition: "PENDING",
      resultSummary: null, blocker: null, nextEligibilityAt: null, createdAt: now, startedAt: null, updatedAt: now, completedAt: null };
    const created = await this.records.createContinuation(record);
    if (created.kind !== "accepted") return { kind: "conflict", reason: "This agent already has a nonterminal continuation." };
    this.changed(); void this.run(record.jobId); return { kind: "ok", value: created.value };
  }

  async resume(jobId: string): Promise<ContinuationResult<ContinuationRecord>> {
    const record = await this.records.getContinuation(jobId); if (!record) return { kind: "not_found" };
    if (record.status !== "BLOCKED") return { kind: "conflict", reason: "Only a blocked continuation can be resumed." };
    if (record.nextEligibilityAt && Date.parse(record.nextEligibilityAt) > Date.parse(this.now())) return { kind: "conflict", reason: "Retry backoff has not elapsed." };
    const validation = await this.revalidate(record); if ("reason" in validation) return this.failValidation(record, validation.reason!);
    const queued = transition(record, "QUEUED", this.now(), { blocker: null, nextEligibilityAt: null });
    const result = await this.records.compareAndSetContinuation(record.jobRevision, queued);
    if (result.kind !== "accepted") return { kind: "conflict", reason: "Continuation changed concurrently." };
    this.changed(); void this.run(jobId); return { kind: "ok", value: result.value };
  }

  async cancel(jobId: string): Promise<ContinuationResult<ContinuationRecord>> {
    for (;;) {
      const record = await this.records.getContinuation(jobId); if (!record) return { kind: "not_found" };
      if (!continuationIsNonterminal(record)) return { kind: "conflict", reason: "Only a nonterminal continuation can be cancelled." };
      const now = this.now(); const next = transition(record, "CANCELLED", now, { cancellationRequested: true, blocker: "Cancelled by a human.", resultDisposition: "CLOSED", completedAt: now });
      const result = await this.records.compareAndSetContinuation(record.jobRevision, next);
      if (result.kind === "accepted") { this.active.get(jobId)?.abort("cancelled"); this.changed(); return { kind: "ok", value: result.value }; }
      if (result.kind === "not_found") return { kind: "not_found" };
    }
  }

  async acknowledgeInbox(inboxEntryId: string, close = false): Promise<ContinuationResult<ContinuationInboxEntry>> {
    for (;;) {
      const entry = await this.records.getContinuationInboxEntry(inboxEntryId); if (!entry) return { kind: "not_found" };
      if (entry.status === "ARCHIVED" || entry.status === "CLOSED") return { kind: "conflict", reason: "Inbox entry is already closed or archived." };
      const now = this.now(); const next = { ...entry, inboxRevision: entry.inboxRevision + 1, status: close ? "CLOSED" as const : "ACKNOWLEDGED" as const,
        acknowledgedAt: entry.acknowledgedAt ?? now, closedAt: close ? now : entry.closedAt, updatedAt: now };
      const changed = await this.records.compareAndSetContinuationInbox(entry.inboxRevision, next);
      if (changed.kind === "accepted") { if (close) await this.acknowledgeJob(entry.jobId); this.changed(); return { kind: "ok", value: changed.value }; }
      if (changed.kind === "not_found") return { kind: "not_found" };
    }
  }

  async contextForAgent(owner: AgentId, input: { taskId?: string; assignmentId?: string; characterBudget?: number; limit?: number } = {}) {
    const budget = Math.max(0, Math.min(8_000, input.characterBudget ?? 4_000)); const limit = Math.max(0, Math.min(10, input.limit ?? 5));
    const entries = (await this.inbox(owner)).filter((e) => e.status === "UNREAD" || e.status === "ACKNOWLEDGED")
      .filter((e) => !input.taskId || e.task.taskId === input.taskId).filter((e) => !input.assignmentId || e.assignmentId === input.assignmentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.inboxEntryId.localeCompare(b.inboxEntryId));
    let remaining = budget; const result: Array<{ inboxEntryId: string; taskId: string; assignmentId: string; summary: string; createdAt: string; expiresAt: string }> = [];
    for (const entry of entries.slice(0, limit)) { if (!remaining) break; const summary = redact(entry.summary).slice(0, remaining); if (!summary) continue; remaining -= summary.length; result.push({ inboxEntryId: entry.inboxEntryId, taskId: entry.task.taskId, assignmentId: entry.assignmentId, summary, createdAt: entry.createdAt, expiresAt: entry.expiresAt }); }
    return result;
  }

  async reconcile() {
    const now = this.now();
    for (const record of await this.records.listContinuations()) {
      if (record.status === "RUNNING" || record.status === "WAITING_TOOL") {
        const next = transition(record, "BLOCKED", now, { blocker: "Executor interrupted by server restart; authority must be revalidated before resume.", nextEligibilityAt: now });
        await this.records.compareAndSetContinuation(record.jobRevision, next);
      } else if (continuationIsNonterminal(record)) {
        const validation = await this.revalidate(record); if ("reason" in validation) await this.failValidation(record, validation.reason!);
      }
    }
    for (const owner of new Set((await this.records.listContinuations()).map((r) => r.owner))) await this.archiveExpired(owner);
    return this.list();
  }
  async enforceEmergencyStop() { if (!(await this.rooms.getEmergencyStop()).active) return; for (const record of await this.records.listContinuations()) if (continuationIsNonterminal(record)) await this.cancelWithReason(record, "Emergency stop is active."); }
  async cancelAll(reason: string) { for (const record of await this.records.listContinuations()) if (continuationIsNonterminal(record)) await this.cancelWithReason(record, reason); }

  private async run(jobId: string) {
    let record = await this.records.getContinuation(jobId); if (!record || record.status !== "QUEUED") return;
    const validation = await this.revalidate(record); if ("reason" in validation) { await this.failValidation(record, validation.reason!); return; }
    const now = this.now(); const running = transition(record, "RUNNING", now, { startedAt: record.startedAt ?? now, usage: { ...record.usage, attempts: record.usage.attempts + 1 } });
    const claimed = await this.records.compareAndSetContinuation(record.jobRevision, running); if (claimed.kind !== "accepted") return;
    record = claimed.value; const controller = new AbortController(); this.active.set(jobId, controller); this.changed();
    const remainingTime = record.budget.timeMs - record.usage.elapsedMs; const started = Date.now();
    if (remainingTime <= 0) { await this.finishFailure(record, "Time budget exhausted."); return; }
    const timer = setTimeout(() => controller.abort("time-budget"), remainingTime);
    try {
      const output = await this.executor.dispatch({ jobId, attempt: record.usage.attempts, owner: record.owner, objective: record.objective,
        trigger: record.trigger, task: { ...record.task, revision: record.taskRevision }, assignmentId: record.authority.assignmentId,
        cwd: validation.workspace, capabilities: record.capabilities,
        remainingBudget: { timeMs: remainingTime, tokenLimit: record.budget.tokenLimit - record.usage.tokens, toolCallLimit: record.budget.toolCallLimit - record.usage.toolCalls }, signal: controller.signal });
      const current = await this.records.getContinuation(jobId); if (!current || current.status !== "RUNNING") return;
      const post = await this.revalidate(current); if ("reason" in post) { await this.failValidation(current, post.reason!); return; }
      const usage = addUsage(current.usage, Date.now() - started, output.usage);
      if (usage.elapsedMs > current.budget.timeMs || usage.tokens > current.budget.tokenLimit || usage.toolCalls > current.budget.toolCallLimit) { await this.finishFailure(current, "Continuation budget exhausted.", usage); return; }
      const summary = redact(output.summary).trim().slice(0, 16_000); if (!summary) { await this.finishFailure(current, "Executor returned no bounded public summary.", usage); return; }
      const completedAt = this.now(); const completed = transition(current, "COMPLETED", completedAt, { usage, resultSummary: summary, resultDisposition: "INBOX", completedAt });
      const policy = await this.currentPolicy(); if ("reason" in policy) { await this.finishFailure(current, policy.reason, usage); return; }
      const entry: ContinuationInboxEntry = { schemaVersion: 1, inboxEntryId: randomUUID(), inboxRevision: 1, jobId, owner: current.owner, roomId: current.roomId,
        task: current.task, taskRevision: current.taskRevision, assignmentId: current.authority.assignmentId, status: "UNREAD", summary,
        relevance: (output.relevance ?? []).map((v) => redact(String(v)).trim()).filter(Boolean).slice(0, 16).map((v) => v.slice(0, 160)),
        createdAt: completedAt, updatedAt: completedAt, expiresAt: new Date(Date.parse(completedAt) + policy.inboxTtlMs).toISOString(), acknowledgedAt: null, closedAt: null };
      await this.records.completeContinuation(current.jobRevision, completed, entry, policy.maxInboxEntriesPerAgent);
    } catch (error) {
      const current = await this.records.getContinuation(jobId); if (!current || current.status !== "RUNNING") return;
      const elapsed = addUsage(current.usage, Date.now() - started, { tokens: 0, toolCalls: 0 });
      if (controller.signal.reason === "cancelled") return;
      if (controller.signal.reason === "time-budget") await this.finishFailure(current, "Time budget exhausted.", elapsed);
      else if (current.usage.attempts <= current.budget.retryLimit) {
        const policy = await this.currentPolicy(); const delay = "reason" in policy ? 5_000 : policy.retryBackoffMs * 2 ** Math.max(0, current.usage.attempts - 1);
        const blocked = transition(current, "BLOCKED", this.now(), { usage: elapsed, blocker: publicError(error), nextEligibilityAt: new Date(Date.parse(this.now()) + delay).toISOString() });
        await this.records.compareAndSetContinuation(current.jobRevision, blocked);
      } else await this.finishFailure(current, publicError(error), elapsed);
    } finally { clearTimeout(timer); this.active.delete(jobId); this.changed(); }
  }

  private async currentPolicy(): Promise<ContinuationPolicy | { reason: string }> {
    const p = await this.records.getContinuationPolicy(); if (!p?.enabled) return { reason: "Continuation policy is disabled." };
    if (p.roomId !== CANONICAL_ROOM_ID || p.projectPathHash !== projectPathHash(this.rooms.snapshot().settings.projectPath)) return { reason: "Continuation policy does not match the current room project." };
    return p;
  }
  private async authority(task: Task | undefined, revision: number, referenceId: string, owner: AgentId) {
    if (!task || task.roomId !== CANONICAL_ROOM_ID) return { reason: "Task does not exist in this room." };
    if (task.revision !== revision) return { reason: "Task revision is stale or superseded." };
    if (!["approved", "active", "blocked"].includes(task.state)) return { reason: "Task is not active continuation authority." };
    const reference = task.references.find((r) => r.id === referenceId);
    if (!reference || reference.kind !== "assignment") return { reason: "Immutable assignment task reference is required." };
    const validated = await this.assignments.authorityForContinuation(reference.targetId, owner);
    if (!validated) return { reason: "Assignment authority is stale, terminal, revoked, or cross-agent." };
    return { assignment: validated.assignment, workspace: validated.workspace };
  }
  private async revalidate(record: ContinuationRecord) {
    const policy = await this.currentPolicy(); if ("reason" in policy) return policy;
    if (record.policyVersion !== policy.policyVersion || record.policyRevision !== policy.revision) return { reason: "Continuation policy revision changed." };
    if ((await this.rooms.getEmergencyStop()).active) return { reason: "Emergency stop is active." };
    const task = await this.rooms.getTask(record.task); const validated = await this.authority(task, record.taskRevision, record.assignmentReferenceId, record.owner);
    if ("reason" in validated) return validated;
    if (JSON.stringify(epoch(validated.assignment)) !== JSON.stringify(record.authority)) return { reason: "Assignment authority epoch changed." };
    return validated;
  }
  private async failValidation(record: ContinuationRecord, reason: string): Promise<ContinuationResult<ContinuationRecord>> {
    const current = await this.records.getContinuation(record.jobId); if (!current) return { kind: "not_found" };
    if (!continuationIsNonterminal(current)) return { kind: "conflict", reason: "Continuation is already terminal." };
    const now = this.now(); const next = transition(current, reason.includes("Emergency stop") ? "CANCELLED" : "FAILED", now, { blocker: reason, cancellationRequested: reason.includes("Emergency stop"), resultDisposition: "CLOSED", completedAt: now });
    const changed = await this.records.compareAndSetContinuation(current.jobRevision, next);
    if (changed.kind === "accepted") this.active.get(record.jobId)?.abort("cancelled");
    return changed.kind === "accepted" ? { kind: "rejected", reason } : { kind: "conflict", reason: "Continuation changed concurrently." };
  }
  private async finishFailure(record: ContinuationRecord, reason: string, usage = record.usage) { const now = this.now(); const next = transition(record, "FAILED", now, { usage, blocker: reason.slice(0, 2_000), resultDisposition: "CLOSED", completedAt: now }); await this.records.compareAndSetContinuation(record.jobRevision, next); }
  private async cancelWithReason(record: ContinuationRecord, reason: string) { const now = this.now(); const next = transition(record, "CANCELLED", now, { cancellationRequested: true, blocker: reason, resultDisposition: "CLOSED", completedAt: now }); const result = await this.records.compareAndSetContinuation(record.jobRevision, next); if (result.kind === "accepted") this.active.get(record.jobId)?.abort("cancelled"); }
  private async acknowledgeJob(jobId: string) { const job = await this.records.getContinuation(jobId); if (!job || !["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) return; const next = transition(job, "ACKNOWLEDGED", this.now(), { resultDisposition: "CLOSED" }); await this.records.compareAndSetContinuation(job.jobRevision, next); }
  private async archiveExpired(owner: AgentId) { const now = this.now(); for (const entry of await this.records.listContinuationInbox(owner)) if (entry.status !== "ARCHIVED" && Date.parse(entry.expiresAt) <= Date.parse(now)) { const next = { ...entry, inboxRevision: entry.inboxRevision + 1, status: "ARCHIVED" as const, updatedAt: now, closedAt: now }; await this.records.compareAndSetContinuationInbox(entry.inboxRevision, next); } }
  private now() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private changed() { this.options.onTransition?.(); }
}

function epoch(a: AssignmentRecord) { return { assignmentId: a.assignmentId, developerMemberId: a.developerMemberId, developerMemberConfigRevision: a.developerMemberConfigRevision, agent: a.agent, fencingToken: a.fencingToken, manifestRevision: a.manifestRevision, pinnedBaseSha: a.pinnedBaseSha }; }
function transition(record: ContinuationRecord, status: ContinuationStatus, now: string, patch: Partial<ContinuationRecord> = {}): ContinuationRecord { if (!canTransitionContinuation(record.status, status)) throw new Error(`Illegal continuation transition ${record.status} -> ${status}`); return { ...record, ...patch, status, jobRevision: record.jobRevision + 1, updatedAt: now }; }
function boundedBudget(input: Partial<ContinuationBudget> = {}, defaults = DEFAULT_CONTINUATION_BUDGET) { const b = { ...defaults, ...input }; return Number.isSafeInteger(b.timeMs) && b.timeMs >= 1_000 && b.timeMs <= MAX_BUDGET.timeMs && Number.isSafeInteger(b.tokenLimit) && b.tokenLimit > 0 && b.tokenLimit <= MAX_BUDGET.tokenLimit && Number.isSafeInteger(b.toolCallLimit) && b.toolCallLimit > 0 && b.toolCallLimit <= MAX_BUDGET.toolCallLimit && Number.isSafeInteger(b.retryLimit) && b.retryLimit >= 0 && b.retryLimit <= MAX_BUDGET.retryLimit ? b : undefined; }
function addUsage(current: ContinuationUsage, elapsedMs: number, reported: { tokens: number; toolCalls: number }): ContinuationUsage { return { ...current, elapsedMs: current.elapsedMs + Math.max(0, Math.ceil(elapsedMs)), tokens: current.tokens + Math.max(0, Math.ceil(reported.tokens)), toolCalls: current.toolCalls + Math.max(0, Math.ceil(reported.toolCalls)) }; }
function redact(value: string) { return value.replace(/<(analysis|reasoning|thinking)>[\s\S]*?<\/\1>/gi, "[REDACTED]").replace(/(?:sk|ghp|github_pat|Bearer)[-_\s]?[A-Za-z0-9_=-]{12,}/gi, "[REDACTED]"); }
function publicError(error: unknown) { const value = error instanceof Error ? error.message : "Continuation executor failed."; return redact(value).slice(0, 2_000); }
