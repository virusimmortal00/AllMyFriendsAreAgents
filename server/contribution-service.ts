import { randomUUID } from "node:crypto";
import type { AssignmentRecord, AssignmentRecordStore } from "./assignment-record.js";
import type { AuthenticatedDeveloper, DeveloperTeamRegistry } from "./developer-team.js";
import { GITHUB_BROKER_REVISION } from "./github-contribution-record.js";
import {
  CONTRIBUTION_POLICY_REVISION, type ContributionRecord, type ContributionResult, type ExactContributionApproval,
  type ReviewEvidence, type TestEvidence,
} from "./contribution-record.js";
import { ContributionStore, contributionDigest } from "./contribution-store.js";
import { GovernedSourceExecutor, ReadonlySourceControlAdapter } from "./source-control-adapter.js";
import { CANONICAL_ROOM_ID, type RoomRepository } from "./storage/room-repository.js";
import { authorizeSourceWorkForCurrentBoot, sourceWorkReconciliationBlocker } from "./storage/identity-domain.js";

export interface ContributionExternalExecutor {
  publish(input: { contribution: ContributionRecord; approval: ExactContributionApproval }): Promise<{ number: number; url: string; resultId: string }>;
  merge(input: { contribution: ContributionRecord; approval: ExactContributionApproval }): Promise<{ commitSha: string; resultId: string }>;
  deploy(input: { contribution: ContributionRecord; approval: ExactContributionApproval }): Promise<{ environment: string; commitSha: string; artifactDigest: string; resultId: string }>;
}

export interface CreateHandoffInput {
  readonly idempotencyKey: string;
  readonly taskId: string; readonly assignmentId: string; readonly expectedTaskRevision: number; readonly expectedAssignmentRevision: number;
  readonly expectedFencingToken: number; readonly expectedManifestRevision: number; readonly expectedBaseSha: string; readonly expectedHeadSha: string;
  readonly expectedPolicyRevision: typeof CONTRIBUTION_POLICY_REVISION; readonly title: string; readonly description: string;
  readonly testEvidence: readonly TestEvidence[]; readonly unresolvedFindings: readonly string[];
}

export class ContributionService {
  private queue: Promise<void> = Promise.resolve();
  private readonly sourceExecutor = new GovernedSourceExecutor();
  constructor(
    private readonly assignments: AssignmentRecordStore, private readonly rooms: RoomRepository, private readonly developers: DeveloperTeamRegistry,
    private readonly records: ContributionStore, private readonly external: ContributionExternalExecutor, private readonly repositoryPath: string,
    private readonly repository: string, private readonly source = new ReadonlySourceControlAdapter(), private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list() { return this.records.list(); }
  get(id: string) { return this.records.get(id); }
  audit(id: string) { return this.records.events(id); }

  create(auth: AuthenticatedDeveloper, input: CreateHandoffInput): Promise<ContributionResult> {
    return this.serial(() => this.createLocked(auth, input));
  }
  review(auth: AuthenticatedDeveloper, contributionId: string, expectedRevision: number, decision: "ACCEPTED" | "REJECTED", summary: string): Promise<ContributionResult> {
    return this.serial(() => this.reviewLocked(auth, contributionId, expectedRevision, decision, summary));
  }
  approve(actorId: string, contributionId: string, expectedRevision: number, kind: "PUBLICATION" | "MERGE" | "DEPLOYMENT", input: { environment?: string; artifactDigest?: string }): Promise<ContributionResult> {
    return this.serial(() => this.approveLocked(actorId, contributionId, expectedRevision, kind, input));
  }
  execute(actorId: string, contributionId: string, expectedRevision: number, kind: "PUBLICATION" | "MERGE" | "DEPLOYMENT"): Promise<ContributionResult> {
    return this.serial(() => this.executeLocked(actorId, contributionId, expectedRevision, kind));
  }

  private serial(operation: () => Promise<ContributionResult>) {
    let result!: ContributionResult; const pending = this.queue.then(async () => { result = await operation(); }); this.queue = pending.then(() => undefined, () => undefined); return pending.then(() => result);
  }

  private async createLocked(auth: AuthenticatedDeveloper, input: CreateHandoffInput): Promise<ContributionResult> {
    try {
      if (!this.currentCapability(auth, "CONTRIBUTION_HANDOFF")) return { kind: "rejected", reason: "Developer identity or handoff capability changed" };
      validateCreateShape(input); const requestDigest = contributionDigest(input); const existing = this.records.list().find((record) => record.source.authorId === auth.member.memberId && record.handoffKey === input.idempotencyKey);
      if (existing) { const blocker=await sourceWorkReconciliationBlocker(this.rooms,"contribution",existing.contributionId);if(blocker)return{kind:"rejected",reason:`Contribution provenance requires reconciliation (${blocker})`};return existing.handoffRequestDigest === requestDigest ? { kind: "ok", value: existing } : { kind: "rejected", reason: "Handoff idempotency key was already used for another request" };}
      const { assignment, task, improvement, manifest } = await this.deriveSource(auth.member.memberId, auth.member.revision, input);
      const timestamp = this.now(); const record: ContributionRecord = {
        schemaVersion: 1, contributionId: randomUUID(), handoffKey: input.idempotencyKey, handoffRequestDigest: requestDigest, revision: 1, stage: "REVIEW_PENDING",
        source: { repository: this.repository, taskId: task.taskId, taskRevision: task.revision, improvementId: assignment.improvementId, improvementRevision: improvement.revision,
          assignmentId: assignment.assignmentId, assignmentRevision: assignment.lifecycleRevision ?? 1, authorId: auth.member.memberId, authorRevision: auth.member.revision,
          fencingToken: assignment.fencingToken, manifestRevision: assignment.manifestRevision, branch: assignment.branch, baseSha: assignment.pinnedBaseSha,
          headSha: assignment.observedHeadSha, manifestDigest: contributionDigest(manifest), brokerRevision: GITHUB_BROKER_REVISION },
        title: bounded(input.title, 160, "Title"), description: bounded(input.description, 8_000, "Description"),
        testEvidence: validTests(input.testEvidence), unresolvedFindings: validFindings(input.unresolvedFindings), review: null, pullRequest: null, merged: null, deployed: null,
        approvals: [], blockedReason: null, createdAt: timestamp, updatedAt: timestamp,
      };
      const created = await this.records.transact({ record, action: "HANDOFF_CREATED", actorId: auth.member.memberId, detail: "Immutable contribution handoff created" });
      authorizeSourceWorkForCurrentBoot(this.rooms, "contribution", created.contributionId);
      return { kind: "ok", value: created };
    } catch (error) { return { kind: "rejected", reason: message(error) }; }
  }

  private async reviewLocked(auth: AuthenticatedDeveloper, id: string, expectedRevision: number, decision: "ACCEPTED" | "REJECTED", summary: string): Promise<ContributionResult> {
    const record = this.records.get(id); if (!record) return { kind: "not_found" }; if (record.revision !== expectedRevision) return conflict(record);
    if (!this.currentCapability(auth, "CONTRIBUTION_REVIEW") || auth.member.memberId === record.source.authorId) return this.reject(record, auth.member.memberId, "REVIEW_REJECTED", "An independent current reviewer is required");
    if (record.stage !== "REVIEW_PENDING") return this.reject(record, auth.member.memberId, "REVIEW_REJECTED", "Contribution is not awaiting review");
    const current = await this.revalidate(record); if (current) return this.block(record, auth.member.memberId, "REVIEW_STALE", current);
    try {
      const target = this.sourceExecutor.createSourceTarget({ targetId: record.contributionId, improvementId: record.source.improvementId });
      const binding = await this.source.bind(target, { kind: "worktree", repository: this.repositoryPath, worktree: (await this.assignments.getAssignment(record.source.assignmentId))!.workspacePath,
        branch: record.source.branch, base: record.source.baseSha, head: record.source.headSha });
      if (binding.kind !== "ok") return this.reject(record, auth.member.memberId, "REVIEW_SOURCE_REJECTED", binding.kind === "rejected" ? binding.reason : `Missing revision ${binding.revision}`);
      const evidence = await this.source.readEvidence({ item: { canonicalId: record.source.improvementId }, binding: binding.value, capabilities: ["SOURCE_PROVENANCE", "SOURCE_DIFF", "SOURCE_CHECKS"] });
      if (evidence.kind !== "ok") return this.reject(record, auth.member.memberId, "REVIEW_SOURCE_REJECTED", evidence.kind === "rejected" ? evidence.reason : `Missing revision ${evidence.revision}`);
      const review: ReviewEvidence = { reviewerId: auth.member.memberId, reviewerRevision: auth.member.revision, decision, summary: bounded(summary, 4_000, "Review summary"), sourceEvidenceDigest: contributionDigest(evidence.value), at: this.now() };
      const next = nextRecord(record, { stage: decision === "ACCEPTED" ? "REVIEW_ACCEPTED" : "BLOCKED", review, blockedReason: decision === "ACCEPTED" ? null : review.summary }, this.now());
      return { kind: "ok", value: await this.records.transact({ record: next, action: `REVIEW_${decision}`, actorId: auth.member.memberId, detail: review.summary }) };
    } catch (error) { return this.reject(record, auth.member.memberId, "REVIEW_FAILED", message(error)); }
  }

  private async approveLocked(actorId: string, id: string, expectedRevision: number, kind: "PUBLICATION" | "MERGE" | "DEPLOYMENT", input: { environment?: string; artifactDigest?: string }): Promise<ContributionResult> {
    const record = this.records.get(id); if (!record) return { kind: "not_found" }; if (record.revision !== expectedRevision) return conflict(record);
    const expectedStage = kind === "PUBLICATION" ? "REVIEW_ACCEPTED" : kind === "MERGE" ? "PR_PUBLISHED" : "MERGED";
    if (record.stage !== expectedStage) return this.reject(record, actorId, `${kind}_APPROVAL_REJECTED`, `${kind} approval is out of order`);
    const stale = await this.revalidate(record); if (stale) return this.block(record, actorId, `${kind}_APPROVAL_STALE`, stale);
    if (record.approvals.some((approval) => approval.kind === kind && !approval.consumedAt)) return this.reject(record, actorId, `${kind}_APPROVAL_REJECTED`, `An unused ${kind.toLowerCase()} approval already exists`);
    const environment = kind === "DEPLOYMENT" ? bounded(input.environment, 128, "Deployment environment") : null;
    const artifactDigest = kind === "DEPLOYMENT" ? sha256(input.artifactDigest, "Artifact digest") : null;
    const timestamp = this.now(); const approval: ExactContributionApproval = { approvalId: randomUUID(), kind, revision: record.revision,
      grantedBy: actorId, grantedAt: timestamp, repository: record.source.repository, branch: record.source.branch, baseSha: record.source.baseSha,
      headSha: record.source.headSha, pullNumber: record.pullRequest?.number ?? null, mergedSha: record.merged?.commitSha ?? null,
      environment, artifactDigest, consumedAt: null, externalResultId: null };
    const next = nextRecord(record, { approvals: [...record.approvals, approval], blockedReason: null }, timestamp);
    return { kind: "ok", value: await this.records.transact({ record: next, action: `${kind}_APPROVED`, actorId, detail: `Exact ${kind.toLowerCase()} approval granted` }) };
  }

  private async executeLocked(actorId: string, id: string, expectedRevision: number, kind: "PUBLICATION" | "MERGE" | "DEPLOYMENT"): Promise<ContributionResult> {
    const record = this.records.get(id); if (!record) return { kind: "not_found" }; if (record.revision !== expectedRevision) return conflict(record);
    const approval = record.approvals.findLast((value) => value.kind === kind && !value.consumedAt);
    if (!approval || approval.revision >= record.revision) return this.reject(record, actorId, `${kind}_EXECUTION_REJECTED`, `A prior exact unused ${kind.toLowerCase()} approval is required`);
    const stage = kind === "PUBLICATION" ? "REVIEW_ACCEPTED" : kind === "MERGE" ? "PR_PUBLISHED" : "MERGED";
    if (record.stage !== stage || !sameApproval(record, approval)) return this.reject(record, actorId, `${kind}_EXECUTION_REJECTED`, "Approval does not match the current exact contribution state");
    const stale = await this.revalidate(record); if (stale) return this.block(record, actorId, `${kind}_EXECUTION_STALE`, stale);
    try {
      const result = kind === "PUBLICATION" ? await this.external.publish({ contribution: record, approval })
        : kind === "MERGE" ? await this.external.merge({ contribution: record, approval }) : await this.external.deploy({ contribution: record, approval });
      const timestamp = this.now(); const consumed = record.approvals.map((value) => value.approvalId === approval.approvalId ? { ...value, consumedAt: timestamp, externalResultId: result.resultId } : value);
      const patch = kind === "PUBLICATION" ? { stage: "PR_PUBLISHED" as const, approvals: consumed, pullRequest: { number: (result as Awaited<ReturnType<ContributionExternalExecutor["publish"]>>).number, url: (result as Awaited<ReturnType<ContributionExternalExecutor["publish"]>>).url, publishedAt: timestamp } }
        : kind === "MERGE" ? { stage: "MERGED" as const, approvals: consumed, merged: { commitSha: (result as Awaited<ReturnType<ContributionExternalExecutor["merge"]>>).commitSha, resultId: result.resultId, mergedAt: timestamp } }
          : { stage: "DEPLOYED" as const, approvals: consumed, deployed: { environment: (result as Awaited<ReturnType<ContributionExternalExecutor["deploy"]>>).environment, commitSha: (result as Awaited<ReturnType<ContributionExternalExecutor["deploy"]>>).commitSha, artifactDigest: (result as Awaited<ReturnType<ContributionExternalExecutor["deploy"]>>).artifactDigest, resultId: result.resultId, deployedAt: timestamp } };
      const next = nextRecord(record, { ...patch, blockedReason: null }, timestamp);
      return { kind: "ok", value: await this.records.transact({ record: next, action: `${kind}_EXECUTED`, actorId, detail: `Exact ${kind.toLowerCase()} action completed`, externalResultId: result.resultId }) };
    } catch (error) {
      const retryable = Boolean((error as { retryable?: boolean }).retryable);
      if (retryable) await this.records.appendEvent({ contribution: record, action: `${kind}_FAILED`, actorId, outcome: "FAILED", detail: message(error) });
      else await this.records.transact({ record: nextRecord(record, { stage: "BLOCKED", blockedReason: message(error) }, this.now()), action: `${kind}_FAILED`, actorId, outcome: "FAILED", detail: message(error) });
      return { kind: "failed", reason: message(error), retryable };
    }
  }

  private async deriveSource(memberId: string, memberRevision: number, input: CreateHandoffInput) {
    if (input.expectedPolicyRevision !== CONTRIBUTION_POLICY_REVISION) throw new Error("Contribution policy revision changed");
    const provenanceBlocker = await sourceWorkReconciliationBlocker(this.rooms, "assignment", input.assignmentId);
    if (provenanceBlocker) throw new Error(`Assignment provenance requires reconciliation (${provenanceBlocker})`);
    const task = await this.rooms.getTask({ roomId: CANONICAL_ROOM_ID, taskId: input.taskId }); if (!task || task.revision !== input.expectedTaskRevision || !["active", "blocked"].includes(task.state)) throw new Error("Task is missing, stale, or not active");
    if (!task.references.some((reference) => reference.kind === "assignment" && reference.targetId === input.assignmentId)) throw new Error("Task is not linked to the assignment");
    const assignment = await this.assignments.getAssignment(input.assignmentId); if (!assignment || assignment.developerMemberId !== memberId || assignment.developerMemberConfigRevision !== memberRevision
      || (assignment.lifecycleRevision ?? 1) !== input.expectedAssignmentRevision || assignment.fencingToken !== input.expectedFencingToken || assignment.manifestRevision !== input.expectedManifestRevision
      || assignment.pinnedBaseSha !== input.expectedBaseSha || assignment.observedHeadSha !== input.expectedHeadSha || !["ACTIVE", "RECOVERABLE"].includes(assignment.lifecycleStatus)) throw new Error("Assignment source authority is stale or mismatched");
    const improvement = await this.rooms.getImprovement(assignment.improvementId); const claim = improvement?.workClaim; const manifest = claim?.manifests.at(-1);
    if (!improvement || !claim || claim.status !== "ACTIVE" || claim.holderMemberId !== memberId || claim.fencingToken !== assignment.fencingToken || !claim.leaseExpiresAt || Date.parse(claim.leaseExpiresAt) <= Date.parse(this.now())
      || !manifest || manifest.revision !== assignment.manifestRevision || manifest.memberConfigRevision !== memberRevision || manifest.repositoryBaseCommit !== assignment.pinnedBaseSha) throw new Error("Work claim or manifest is stale, expired, or revoked");
    if ((await this.rooms.getEmergencyStop()).active) throw new Error("Emergency stop is active");
    return { assignment, task, improvement, manifest };
  }

  private async revalidate(record: ContributionRecord) {
    const provenanceBlocker = await sourceWorkReconciliationBlocker(this.rooms, "contribution", record.contributionId); if (provenanceBlocker) return `Contribution provenance requires reconciliation (${provenanceBlocker})`;
    const member = this.developers.latest(record.source.authorId); if (!member || member.revision !== record.source.authorRevision) return "Author identity revision changed";
    if (record.review?.decision === "ACCEPTED") { const reviewer = this.developers.latest(record.review.reviewerId); if (!reviewer || reviewer.revision !== record.review.reviewerRevision || !reviewer.capabilities.includes("CONTRIBUTION_REVIEW")) return "Independent reviewer identity or capability changed"; }
    try { const value = await this.deriveSource(record.source.authorId, record.source.authorRevision, {
      taskId: record.source.taskId, assignmentId: record.source.assignmentId, expectedTaskRevision: record.source.taskRevision, expectedAssignmentRevision: record.source.assignmentRevision,
      expectedFencingToken: record.source.fencingToken, expectedManifestRevision: record.source.manifestRevision, expectedBaseSha: record.source.baseSha, expectedHeadSha: record.source.headSha,
      expectedPolicyRevision: CONTRIBUTION_POLICY_REVISION, title: record.title, description: record.description, testEvidence: record.testEvidence, unresolvedFindings: record.unresolvedFindings,
      idempotencyKey: record.handoffKey,
    }); if (value.improvement.revision !== record.source.improvementRevision || contributionDigest(value.manifest) !== record.source.manifestDigest) return "Improvement or manifest revision changed"; }
    catch (error) { return message(error); }
    return null;
  }

  private currentCapability(auth: AuthenticatedDeveloper, capability: "CONTRIBUTION_HANDOFF" | "CONTRIBUTION_REVIEW") { const current = this.developers.latest(auth.member.memberId); return current?.revision === auth.member.revision && current.capabilities.includes(capability); }
  private async reject(record: ContributionRecord, actorId: string, action: string, reason: string): Promise<ContributionResult> { await this.records.appendEvent({ contribution: record, action, actorId, outcome: "REJECTED", detail: reason }); return { kind: "rejected", reason }; }
  private async block(record: ContributionRecord, actorId: string, action: string, reason: string): Promise<ContributionResult> { await this.records.transact({ record: nextRecord(record, { stage: "BLOCKED", blockedReason: reason }, this.now()), action, actorId, outcome: "REJECTED", detail: reason }); return { kind: "rejected", reason }; }
}

function nextRecord(record: ContributionRecord, patch: Partial<ContributionRecord>, at: string): ContributionRecord { return { ...record, ...patch, revision: record.revision + 1, updatedAt: at }; }
function conflict(record: ContributionRecord): ContributionResult { return { kind: "conflict", reason: "Contribution changed since it was loaded", actualRevision: record.revision }; }
function message(error: unknown) { return (error instanceof Error ? error.message : "Contribution operation failed").slice(0, 2_000); }
function bounded(value: unknown, max: number, label: string) { if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error(`${label} must be non-empty and at most ${max} characters`); return value.trim(); }
function sha256(value: unknown, label: string) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 digest`); return value; }
function validTests(value: readonly TestEvidence[]) { if (!Array.isArray(value) || !value.length || value.length > 50) throw new Error("One to fifty test evidence records are required"); return value.map((entry) => ({ command: bounded(entry.command, 1_000, "Test command"), result: entry.result, digest: sha256(entry.digest, "Test evidence digest"), at: bounded(entry.at, 64, "Test timestamp") })).filter((entry) => { if (!['PASSED', 'FAILED'].includes(entry.result)) throw new Error('Test result is invalid'); return true; }); }
function validFindings(value: readonly string[]) { if (!Array.isArray(value) || value.length > 100) throw new Error("At most one hundred unresolved findings are allowed"); return value.map((finding) => bounded(finding, 2_000, "Finding")); }
function sameApproval(record: ContributionRecord, approval: ExactContributionApproval) { return approval.repository === record.source.repository && approval.branch === record.source.branch && approval.baseSha === record.source.baseSha && approval.headSha === record.source.headSha
  && (approval.kind !== "MERGE" || approval.pullNumber === record.pullRequest?.number) && (approval.kind !== "DEPLOYMENT" || approval.mergedSha === record.merged?.commitSha); }
const CREATE_FIELDS = new Set(["idempotencyKey", "taskId", "assignmentId", "expectedTaskRevision", "expectedAssignmentRevision", "expectedFencingToken", "expectedManifestRevision", "expectedBaseSha", "expectedHeadSha", "expectedPolicyRevision", "title", "description", "testEvidence", "unresolvedFindings"]);
function validateCreateShape(input: CreateHandoffInput) { if (!input || Object.keys(input).some((key) => !CREATE_FIELDS.has(key)) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(input.idempotencyKey || "")
  || !input.taskId?.trim() || !input.assignmentId?.trim() || ![input.expectedTaskRevision, input.expectedAssignmentRevision, input.expectedFencingToken, input.expectedManifestRevision].every((value) => Number.isSafeInteger(value) && value > 0)
  || !/^[0-9a-f]{40}$/.test(input.expectedBaseSha || "") || !/^[0-9a-f]{40}$/.test(input.expectedHeadSha || "")) throw new Error("A strict, revision-qualified handoff request is required"); }
