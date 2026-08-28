import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isAgentId } from "../shared/participants.js";
import type { ImplementationCapability } from "../shared/protocol.js";
import { normalizeRoomAgentRoster } from "../shared/roster.js";
import type { AssignmentRecord, AssignmentRecordStore, AssignmentRecoveryClassification } from "./assignment-record.js";
import { ASSIGNMENT_LIFECYCLE_METADATA } from "./assignment-record.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { RoomRepository } from "./storage/room-repository.js";
import type { AgentId } from "./types.js";
import { logOperationSafely, type OperationLog } from "./operation-log.js";

const execFileAsync = promisify(execFile);
const PROHIBITED_GRANT = /(^|[._:/-])(push|merge|deploy|publish)([._:/-]|$)/i;

export type AssignmentResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string };

export interface CreateAssignmentInput {
  readonly assignmentId: string;
  readonly improvementId: string;
  readonly agent: AgentId;
  readonly baseRef?: string;
  readonly fencingToken: number;
  readonly manifestRevision: number;
}

export interface AssignmentMutationInput {
  readonly assignmentId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
}

export interface DisposeAssignmentInput extends AssignmentMutationInput { readonly confirmDisposable: boolean; }

export class AssignmentLifecycleService {
  readonly metadata = ASSIGNMENT_LIFECYCLE_METADATA;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly records: AssignmentRecordStore,
    private readonly rooms: RoomRepository,
    private readonly developers: DeveloperTeamRegistry,
    private readonly repositoryPath: string,
    private readonly worktreesRoot: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly singleWriter = true,
    private readonly processes?: { terminateScope(scope: string): Promise<void> },
    private readonly implementationConfinementAvailable = true,
    private readonly operationLog?: OperationLog,
  ) {}

  create(authorization: string | undefined, input: CreateAssignmentInput): Promise<AssignmentResult<AssignmentRecord>> {
    const operation = this.mutationQueue.then(() => this.createLocked(authorization, input));
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async createLocked(authorization: string | undefined, input: CreateAssignmentInput): Promise<AssignmentResult<AssignmentRecord>> {
    const authenticated = this.developers.authenticate(authorization, "ASSIGNMENT_WRITE", "OPERATOR");
    if (!authenticated) return { kind: "unauthorized" };
    if (!validId(input.assignmentId) || !validId(input.improvementId) || !isAgentId(input.agent)
      || !Number.isSafeInteger(input.fencingToken) || !Number.isSafeInteger(input.manifestRevision)) {
      return { kind: "rejected", reason: "Valid assignment, improvement, agent, fencing-token, and manifest-revision fields are required" };
    }
    if (!this.participantEligible(input.agent)) {
      return { kind: "rejected", reason: "The implementation assignment participant is not enabled or eligible" };
    }
    const governed = await this.validateGovernance(authenticated.member.memberId, authenticated.member.revision, input);
    if (governed.kind !== "ok") return governed;
    const assignments = await this.records.listAssignments();
    if (assignments.some((assignment) => assignment.assignmentId === input.assignmentId)) {
      return { kind: "conflict", reason: "Assignment ID already exists" };
    }
    if (this.singleWriter && assignments.some(reservesWriterSlot)) {
      return { kind: "conflict", reason: "Trusted lifecycle prototype permits only one active writable assignment" };
    }

    const baseRef = input.baseRef?.trim() || governed.value.repositoryBaseCommit;
    const pinnedBaseSha = await git(this.repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`]).catch(() => "");
    if (!pinnedBaseSha) return { kind: "rejected", reason: "Assignment base does not resolve to an immutable commit" };
    const manifestBaseSha = await git(this.repositoryPath, ["rev-parse", "--verify", "--end-of-options", `${governed.value.repositoryBaseCommit}^{commit}`]).catch(() => "");
    if (manifestBaseSha !== pinnedBaseSha) return { kind: "rejected", reason: "Pinned base does not match the governed execution manifest" };

    await mkdir(this.worktreesRoot, { recursive: true, mode: 0o700 });
    const requestedWorkspace = path.join(this.worktreesRoot, input.assignmentId);
    if (await exists(requestedWorkspace)) return { kind: "conflict", reason: "Assignment workspace already exists" };
    const branch = `amfaa/assignment-${slug(input.assignmentId)}-${pinnedBaseSha.slice(0, 8)}`;
    if (await branchExists(this.repositoryPath, branch)) return { kind: "conflict", reason: "Assignment branch already exists" };
    await git(this.repositoryPath, ["worktree", "add", "-b", branch, requestedWorkspace, pinnedBaseSha]);
    const workspacePath = await realpath(requestedWorkspace);
    const observedHeadSha = await git(workspacePath, ["rev-parse", "HEAD"]);
    const timestamp = this.now();
    const assignment: AssignmentRecord = {
      assignmentId: input.assignmentId,
      improvementId: input.improvementId,
      developerMemberId: authenticated.member.memberId,
      developerMemberConfigRevision: authenticated.member.revision,
      agent: input.agent,
      fencingToken: input.fencingToken,
      manifestRevision: input.manifestRevision,
      pinnedBaseSha,
      branch,
      observedHeadSha,
      workspacePath,
      lifecycleStatus: "ACTIVE",
      lifecycleRevision: 1,
      cancelledAt: null,
      disposedAt: null,
      lastOperationKey: null,
      recovery: { classification: "clean", reconciledAt: timestamp, previousStatus: null, detail: "New trusted single-writer worktree" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.records.putAssignment(assignment);
    return { kind: "ok", value: assignment };
  }

  async list() { return this.records.listAssignments(); }

  reconcile(): Promise<readonly AssignmentRecord[]> {
    const operation = this.mutationQueue.then(() => this.reconcileLocked());
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async reconcileLocked(): Promise<readonly AssignmentRecord[]> {
    const reconciled: AssignmentRecord[] = [];
    const persisted = await this.records.listAssignments();
    await logOperationSafely(this.operationLog, "info", "assignment.lifecycle.reconcile.started", { assignments: persisted.length, phase: "startup-or-refresh" });
    for (const assignment of persisted) {
      if (assignment.lifecycleStatus === "CANCELLED" || assignment.lifecycleStatus === "DISPOSED") {
        reconciled.push(assignment); continue;
      }
      const evidence = await inspect(this.repositoryPath, assignment);
      const lifecycleStatus = evidence.classification === "missing" ? "MISSING"
        : evidence.classification === "merged" ? "COMPLETED"
          : evidence.classification === "clean" && assignment.lifecycleStatus === "COMPLETED" ? "COMPLETED"
            : evidence.classification === "clean" ? "ACTIVE" : "RECOVERABLE";
      const next: AssignmentRecord = {
        ...assignment,
        observedHeadSha: evidence.head || assignment.observedHeadSha,
        lifecycleStatus,
        recovery: {
          classification: evidence.classification,
          reconciledAt: this.now(),
          previousStatus: assignment.lifecycleStatus,
          detail: evidence.detail,
        },
        updatedAt: this.now(),
      };
      await this.records.putAssignment(next);
      reconciled.push(next);
    }
    await logOperationSafely(this.operationLog, "info", "assignment.lifecycle.reconcile.completed", { assignments: reconciled.length, activeAssignments: reconciled.filter(reservesWriterSlot).length });
    return reconciled;
  }

  async workspaceForAgent(agent: AgentId): Promise<string | undefined> {
    return (await this.assignmentForAgent(agent))?.workspacePath;
  }

  async assignmentForAgent(agent: AgentId): Promise<AssignmentRecord | undefined> {
    const assignments = await this.reconcile();
    const assignment = assignments.find((candidate) => candidate.agent === agent && isWritableAssignment(candidate));
    if (!assignment || !this.participantEligible(agent)) return undefined;
    const governed = await this.validateGovernance(assignment.developerMemberId, assignment.developerMemberConfigRevision, assignment);
    if (governed.kind !== "ok") return undefined;
    return assignment;
  }

  async implementationCapabilities(agents: readonly AgentId[]): Promise<Partial<Record<AgentId, ImplementationCapability>>> {
    return (await this.implementationCapabilitySnapshot(agents)).capabilities;
  }

  async implementationCapabilitySnapshot(agents: readonly AgentId[]): Promise<{
    capabilities: Partial<Record<AgentId, ImplementationCapability>>;
    refreshAt?: string;
  }> {
    const assignments = await this.reconcile();
    const roster = normalizeRoomAgentRoster(this.rooms.snapshot().roster);
    const capabilities: Partial<Record<AgentId, ImplementationCapability>> = {};
    let refreshAt: string | undefined;
    for (const agent of agents) {
      const participant = roster.entries.find((entry) => entry.agentId === agent && entry.enabled);
      if (!participant?.supportsProjectWrites) {
        capabilities[agent] = unavailable(false, "participant-ineligible");
        continue;
      }
      const current = assignments.filter((assignment) => ["ACTIVE", "RECOVERABLE", "MISSING"].includes(assignment.lifecycleStatus));
      const assignment = current.find((candidate) => candidate.agent === agent);
      if (!assignment) {
        capabilities[agent] = unavailable(true, current.length ? "assignment-owner-mismatch" : "no-active-assignment");
        continue;
      }
      if (assignment.lifecycleStatus === "MISSING" || !this.implementationConfinementAvailable) {
        capabilities[agent] = unavailable(true, "confinement-unavailable");
        continue;
      }
      const governed = await this.validateGovernance(assignment.developerMemberId, assignment.developerMemberConfigRevision, assignment);
      if (governed.kind !== "ok") {
        capabilities[agent] = unavailable(true, "governance-invalid");
        continue;
      }
      capabilities[agent] = await implementationWorkspaceIsConfined(this.repositoryPath, this.worktreesRoot, assignment)
        ? { eligible: true, available: true }
        : unavailable(true, "confinement-unavailable");
      if (capabilities[agent]?.available
        && (!refreshAt || Date.parse(governed.value.leaseExpiresAt) < Date.parse(refreshAt))) {
        refreshAt = governed.value.leaseExpiresAt;
      }
    }
    return { capabilities, ...(refreshAt ? { refreshAt } : {}) };
  }

  /** Revalidates the exact immutable assignment epoch before every durable dispatch. */
  async authorityForContinuation(assignmentId: string, agent: AgentId): Promise<{ kind: "ok"; assignment: AssignmentRecord; workspace: string } | { kind: "revoked"; reason: string }> {
    const assignments = await this.reconcile();
    const assignment = assignments.find((candidate) => candidate.assignmentId === assignmentId && candidate.agent === agent);
    if (!assignment || assignment.agent !== agent) return { kind: "revoked", reason: "Assignment is missing or belongs to another agent." };
    if (!["ACTIVE", "RECOVERABLE"].includes(assignment.lifecycleStatus)) return { kind: "revoked", reason: `Assignment lifecycle is ${assignment.lifecycleStatus}.` };
    if (!this.participantEligible(agent)) return { kind: "revoked", reason: "Implementation participant eligibility changed." };
    const governed = await this.validateGovernance(assignment.developerMemberId, assignment.developerMemberConfigRevision, assignment);
    if (governed.kind !== "ok") return { kind: "revoked", reason: governed.kind === "rejected" || governed.kind === "conflict" ? governed.reason : "Assignment claim authority no longer exists." };
    if (!this.implementationConfinementAvailable
      || !await implementationWorkspaceIsConfined(this.repositoryPath, this.worktreesRoot, assignment)) {
      return { kind: "revoked", reason: "Assignment workspace confinement is unavailable." };
    }
    const workspace = await this.workspaceForAgent(agent);
    if (!workspace || workspace !== assignment.workspacePath) return { kind: "revoked", reason: "Assignment workspace authority changed." };
    return { kind: "ok", assignment, workspace };
  }

  /** Resolves room initiation to the assignment's server-owned agent identity. */
  async authorityForRoomContinuation(assignmentId: string) {
    const assignment = (await this.records.getAssignment(assignmentId));
    if (!assignment) return { kind: "revoked" as const, reason: "Assignment is missing." };
    return this.authorityForContinuation(assignmentId, assignment.agent);
  }

  /** Cleanup is intentionally conservative: it only marks merged clean work complete. */
  async cleanup(): Promise<readonly AssignmentRecord[]> {
    const assignments = await this.reconcile();
    // The prototype never removes a worktree or branch. Dirty and unmerged paths
    // remain persisted and discoverable; physical cleanup requires a future,
    // separately authorized lifecycle capability.
    return assignments;
  }

  cancel(authorization: string | undefined, input: AssignmentMutationInput) {
    const operation = this.mutationQueue.then(() => this.cancelLocked(authorization, input));
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async cancelLocked(authorization: string | undefined, input: AssignmentMutationInput): Promise<AssignmentResult<AssignmentRecord>> {
    if (!this.developers.authenticate(authorization, "ASSIGNMENT_WRITE", "OPERATOR")) return { kind: "unauthorized" };
    if (!validMutation(input)) return { kind: "rejected", reason: "Valid assignment, expected revision, and idempotency key are required" };
    const assignment = await this.records.getAssignment(input.assignmentId);
    if (!assignment) return { kind: "not_found" };
    const revision = assignment.lifecycleRevision ?? 1;
    if (assignment.lifecycleStatus === "CANCELLED" && assignment.lastOperationKey === input.idempotencyKey) return { kind: "ok", value: assignment };
    if (assignment.lifecycleStatus === "CANCELLED") return { kind: "conflict", reason: "Assignment was already cancelled by another operation" };
    if (revision !== input.expectedRevision) return { kind: "conflict", reason: `Assignment lifecycle revision is ${revision}` };
    if (assignment.lifecycleStatus === "DISPOSED") return { kind: "conflict", reason: "Disposed assignments cannot be cancelled" };
    const timestamp = this.now();
    const cancelled: AssignmentRecord = {
      ...assignment, lifecycleStatus: "CANCELLED", lifecycleRevision: revision + 1, cancelledAt: timestamp,
      lastOperationKey: input.idempotencyKey, updatedAt: timestamp,
      recovery: { ...assignment.recovery, reconciledAt: timestamp, previousStatus: assignment.lifecycleStatus, detail: "Assignment write authority was explicitly cancelled; workspace preserved" },
    };
    // Persist revocation before waiting for any process cleanup.
    await this.records.putAssignment(cancelled);
    await this.processes?.terminateScope(assignment.assignmentId);
    return { kind: "ok", value: cancelled };
  }

  dispose(authorization: string | undefined, input: DisposeAssignmentInput) {
    const operation = this.mutationQueue.then(() => this.disposeLocked(authorization, input));
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async disposeLocked(authorization: string | undefined, input: DisposeAssignmentInput): Promise<AssignmentResult<AssignmentRecord>> {
    if (!this.developers.authenticate(authorization, "ASSIGNMENT_WRITE", "OPERATOR")) return { kind: "unauthorized" };
    if (!validMutation(input) || input.confirmDisposable !== true) return { kind: "rejected", reason: "Explicit disposable confirmation is required" };
    const assignment = await this.records.getAssignment(input.assignmentId);
    if (!assignment) return { kind: "not_found" };
    const revision = assignment.lifecycleRevision ?? 1;
    if (assignment.lifecycleStatus === "DISPOSED" && assignment.lastOperationKey === input.idempotencyKey) return { kind: "ok", value: assignment };
    if (revision !== input.expectedRevision) return { kind: "conflict", reason: `Assignment lifecycle revision is ${revision}` };
    if (assignment.lifecycleStatus !== "CANCELLED" && assignment.lifecycleStatus !== "COMPLETED") return { kind: "conflict", reason: "Only cancelled or completed assignments can be disposed" };
    const safety = await disposableWorkspace(this.repositoryPath, this.worktreesRoot, assignment);
    if (safety.kind !== "ok") return safety;
    await git(this.repositoryPath, ["worktree", "remove", assignment.workspacePath]);
    await git(this.repositoryPath, ["branch", "-d", assignment.branch]).catch(() => "");
    const timestamp = this.now();
    const disposed: AssignmentRecord = {
      ...assignment, lifecycleStatus: "DISPOSED", lifecycleRevision: revision + 1, disposedAt: timestamp,
      lastOperationKey: input.idempotencyKey, updatedAt: timestamp,
      recovery: { classification: "missing", reconciledAt: timestamp, previousStatus: assignment.lifecycleStatus, detail: "Explicitly confirmed clean assignment worktree was disposed" },
    };
    await this.records.putAssignment(disposed);
    return { kind: "ok", value: disposed };
  }

  private async validateGovernance(memberId: string, memberRevision: number, input: {
    improvementId: string; fencingToken: number; manifestRevision: number;
  }): Promise<AssignmentResult<{ repositoryBaseCommit: string; leaseExpiresAt: string }>> {
    const member = this.developers.latest(memberId);
    if (!member || member.revision !== memberRevision || !member.capabilities.includes("ASSIGNMENT_WRITE")) {
      await logOperationSafely(this.operationLog, "info", "assignment.tool.decision", { toolPolicy: "assignment-write", result: "denied", reason: "developer-capability-invalid", manifestRevision: input.manifestRevision, fencingToken: input.fencingToken });
      return { kind: "rejected", reason: "Developer-team identity or assignment capability changed" };
    }
    const improvement = await this.rooms.getImprovement(input.improvementId);
    if (!improvement) { await logOperationSafely(this.operationLog, "info", "assignment.manifest.decision", { result: "denied", manifestStatus: "improvement-not-found", manifestRevision: input.manifestRevision }); return { kind: "not_found" }; }
    const claim = improvement.workClaim;
    const manifest = claim.manifests.at(-1);
    if (claim.status !== "ACTIVE" || claim.holderMemberId !== memberId || claim.fencingToken !== input.fencingToken
      || !claim.leaseExpiresAt || Date.parse(claim.leaseExpiresAt) <= Date.parse(this.now())) {
      await logOperationSafely(this.operationLog, "info", "assignment.lease.decision", { result: "denied", leaseStatus: claim.status, fencingToken: input.fencingToken });
      return { kind: "rejected", reason: "An active, unexpired, correctly fenced work claim is required" };
    }
    if (!manifest || manifest.revision !== input.manifestRevision || manifest.memberId !== memberId || manifest.memberConfigRevision !== memberRevision
      || manifest.effectiveToolGrants.some((grant) => PROHIBITED_GRANT.test(grant))) {
      await logOperationSafely(this.operationLog, "info", "assignment.manifest.decision", { result: "denied", manifestStatus: manifest ? "invalid" : "missing", manifestRevision: input.manifestRevision });
      await logOperationSafely(this.operationLog, "info", "assignment.tool.decision", { toolPolicy: "non-publication", result: "denied", reason: "manifest-tool-grants-invalid", manifestRevision: input.manifestRevision });
      return { kind: "rejected", reason: "The execution manifest does not authorize this trusted, non-publication lifecycle" };
    }
    await logOperationSafely(this.operationLog, "info", "assignment.lease.decision", { result: "allowed", leaseStatus: "active", fencingToken: input.fencingToken });
    await logOperationSafely(this.operationLog, "info", "assignment.manifest.decision", { result: "allowed", manifestStatus: "valid", manifestRevision: input.manifestRevision });
    await logOperationSafely(this.operationLog, "info", "assignment.tool.decision", { toolPolicy: "non-publication", result: "allowed", manifestRevision: input.manifestRevision });
    return { kind: "ok", value: { repositoryBaseCommit: manifest.repositoryBaseCommit, leaseExpiresAt: claim.leaseExpiresAt } };
  }

  private participantEligible(agent: AgentId) {
    const participant = normalizeRoomAgentRoster(this.rooms.snapshot().roster).entries.find((entry) => entry.agentId === agent);
    return Boolean(participant?.enabled && participant.supportsProjectWrites);
  }
}

function isWritableAssignment(assignment: AssignmentRecord) {
  return assignment.lifecycleStatus === "ACTIVE" || assignment.lifecycleStatus === "RECOVERABLE";
}

function reservesWriterSlot(assignment: AssignmentRecord) {
  return isWritableAssignment(assignment) || assignment.lifecycleStatus === "MISSING";
}

function unavailable(eligible: boolean, unavailableReason: NonNullable<ImplementationCapability["unavailableReason"]>): ImplementationCapability {
  return { eligible, available: false, unavailableReason };
}

async function implementationWorkspaceIsConfined(repositoryPath: string, worktreesRoot: string, assignment: AssignmentRecord) {
  const [repository, root, workspace] = await Promise.all([
    realpath(repositoryPath).catch(() => ""),
    realpath(worktreesRoot).catch(() => ""),
    realpath(assignment.workspacePath).catch(() => ""),
  ]);
  if (!repository || !root || !workspace || workspace !== assignment.workspacePath || workspace === repository) return false;
  const relative = path.relative(root, workspace);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const [branch, common, repositoryCommon, head] = await Promise.all([
    git(workspace, ["branch", "--show-current"]).catch(() => ""),
    git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ""),
    git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => ""),
    git(workspace, ["rev-parse", "HEAD"]).catch(() => ""),
  ]);
  if (branch !== assignment.branch || !head || head !== assignment.observedHeadSha || !common || !repositoryCommon) return false;
  const [canonicalCommon, canonicalRepositoryCommon] = await Promise.all([realpath(common).catch(() => ""), realpath(repositoryCommon).catch(() => "")]);
  return Boolean(canonicalCommon && canonicalCommon === canonicalRepositoryCommon);
}

async function disposableWorkspace(repositoryPath: string, worktreesRoot: string, assignment: AssignmentRecord): Promise<AssignmentResult<true>> {
  const [repository, root, workspace] = await Promise.all([realpath(repositoryPath), realpath(worktreesRoot), realpath(assignment.workspacePath).catch(() => "")]);
  if (!workspace || workspace === repository || path.relative(root, workspace).startsWith("..") || path.relative(root, workspace) === "") {
    return { kind: "rejected", reason: "Recorded assignment workspace is outside the configured external worktree root" };
  }
  if (workspace !== assignment.workspacePath) return { kind: "rejected", reason: "Recorded assignment workspace path was substituted" };
  const branch = await git(workspace, ["branch", "--show-current"]).catch(() => "");
  if (branch !== assignment.branch) return { kind: "rejected", reason: "Assignment branch identity changed" };
  const common = await git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "");
  const repositoryCommon = await git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "");
  const expectedCommon = await realpath(repositoryCommon).catch(() => "");
  if (!common || await realpath(common).catch(() => "") !== expectedCommon) return { kind: "rejected", reason: "Assignment Git common directory changed" };
  const dirty = await git(workspace, ["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty) return { kind: "rejected", reason: "Dirty assignment work is preserved and cannot be disposed" };
  return { kind: "ok", value: true };
}

async function inspect(repositoryPath: string, assignment: AssignmentRecord): Promise<{ classification: AssignmentRecoveryClassification; head?: string; detail: string }> {
  if (!await exists(assignment.workspacePath)) return { classification: "missing", detail: "Recorded assignment workspace is missing" };
  const canonical = await realpath(assignment.workspacePath).catch(() => "");
  if (canonical !== assignment.workspacePath) return { classification: "missing", detail: "Recorded workspace no longer resolves to its canonical path" };
  const head = await git(assignment.workspacePath, ["rev-parse", "HEAD"]).catch(() => "");
  if (!head) return { classification: "missing", detail: "Recorded workspace is not a readable Git worktree" };
  const unmerged = await git(assignment.workspacePath, ["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged) return { classification: "unmerged", head, detail: "Worktree contains unmerged paths and was preserved" };
  const dirty = await git(assignment.workspacePath, ["status", "--porcelain", "--untracked-files=normal"]);
  if (dirty) return { classification: "dirty", head, detail: "Worktree contains local changes and was preserved" };
  const merged = await gitResult(repositoryPath, ["merge-base", "--is-ancestor", head, "HEAD"]);
  if (head !== assignment.pinnedBaseSha && merged === 0) return { classification: "merged", head, detail: "Assignment head is contained in the repository HEAD" };
  return { classification: "clean", head, detail: "Worktree is clean and remains recoverable" };
}

async function git(cwd: string, args: readonly string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}
async function gitResult(cwd: string, args: readonly string[]) {
  try { await git(cwd, args); return 0; } catch (error) { return typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1; }
}
async function branchExists(cwd: string, branch: string) { return (await gitResult(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])) === 0; }
async function exists(value: string) { return stat(value).then(() => true).catch(() => false); }
function validId(value: string) { return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value); }
function validMutation(value: AssignmentMutationInput) { return validId(value.assignmentId) && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 1 && validId(value.idempotencyKey); }
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48); }

export const __testing = { disposableWorkspace };
