import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isAgentId } from "../shared/participants.js";
import type { AssignmentRecord, AssignmentRecordStore, AssignmentRecoveryClassification } from "./assignment-record.js";
import { ASSIGNMENT_LIFECYCLE_METADATA } from "./assignment-record.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { RoomRepository } from "./storage/room-repository.js";
import type { AgentId } from "./types.js";

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

export class AssignmentLifecycleService {
  readonly metadata = ASSIGNMENT_LIFECYCLE_METADATA;
  private createQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly records: AssignmentRecordStore,
    private readonly rooms: RoomRepository,
    private readonly developers: DeveloperTeamRegistry,
    private readonly repositoryPath: string,
    private readonly worktreesRoot: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly singleWriter = true,
  ) {}

  create(authorization: string | undefined, input: CreateAssignmentInput): Promise<AssignmentResult<AssignmentRecord>> {
    const operation = this.createQueue.then(() => this.createLocked(authorization, input));
    this.createQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async createLocked(authorization: string | undefined, input: CreateAssignmentInput): Promise<AssignmentResult<AssignmentRecord>> {
    const authenticated = this.developers.authenticate(authorization, "ASSIGNMENT_WRITE", "OPERATOR");
    if (!authenticated) return { kind: "unauthorized" };
    if (!validId(input.assignmentId) || !validId(input.improvementId) || !isAgentId(input.agent)
      || !Number.isSafeInteger(input.fencingToken) || !Number.isSafeInteger(input.manifestRevision)) {
      return { kind: "rejected", reason: "Valid assignment, improvement, agent, fencing-token, and manifest-revision fields are required" };
    }
    if (this.rooms.snapshot().settings.writableAgent !== input.agent) {
      return { kind: "rejected", reason: "The project-write toggle does not grant this agent writable execution" };
    }
    const governed = await this.validateGovernance(authenticated.member.memberId, authenticated.member.revision, input);
    if (governed.kind !== "ok") return governed;
    const assignments = await this.records.listAssignments();
    if (assignments.some((assignment) => assignment.assignmentId === input.assignmentId)) {
      return { kind: "conflict", reason: "Assignment ID already exists" };
    }
    if (this.singleWriter && assignments.some(isWritableAssignment)) {
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
      recovery: { classification: "clean", reconciledAt: timestamp, previousStatus: null, detail: "New trusted single-writer worktree" },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.records.putAssignment(assignment);
    return { kind: "ok", value: assignment };
  }

  async list() { return this.records.listAssignments(); }

  async reconcile(): Promise<readonly AssignmentRecord[]> {
    const reconciled: AssignmentRecord[] = [];
    for (const assignment of await this.records.listAssignments()) {
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
    return reconciled;
  }

  async workspaceForAgent(agent: AgentId): Promise<string | undefined> {
    const assignments = await this.reconcile();
    const assignment = assignments.find((candidate) => candidate.agent === agent && isWritableAssignment(candidate));
    if (!assignment || this.rooms.snapshot().settings.writableAgent !== agent) return undefined;
    const governed = await this.validateGovernance(assignment.developerMemberId, assignment.developerMemberConfigRevision, assignment);
    if (governed.kind !== "ok") return undefined;
    return assignment.workspacePath;
  }

  /** Revalidates the exact immutable assignment epoch before every durable dispatch. */
  async authorityForContinuation(assignmentId: string, agent: AgentId): Promise<{ kind: "ok"; assignment: AssignmentRecord; workspace: string } | { kind: "revoked"; reason: string }> {
    const assignments = await this.reconcile();
    const assignment = assignments.find((candidate) => candidate.assignmentId === assignmentId && candidate.agent === agent);
    if (!assignment || assignment.agent !== agent) return { kind: "revoked", reason: "Assignment is missing or belongs to another agent." };
    if (!["ACTIVE", "RECOVERABLE"].includes(assignment.lifecycleStatus)) return { kind: "revoked", reason: `Assignment lifecycle is ${assignment.lifecycleStatus}.` };
    if (this.rooms.snapshot().settings.writableAgent !== agent) return { kind: "revoked", reason: "Project write capability was revoked for this agent." };
    const governed = await this.validateGovernance(assignment.developerMemberId, assignment.developerMemberConfigRevision, assignment);
    if (governed.kind !== "ok") return { kind: "revoked", reason: governed.kind === "rejected" || governed.kind === "conflict" ? governed.reason : "Assignment claim authority no longer exists." };
    const workspace = await this.workspaceForAgent(agent);
    if (!workspace || workspace !== assignment.workspacePath) return { kind: "revoked", reason: "Assignment workspace authority changed." };
    return { kind: "ok", assignment, workspace };
  }

  /** Cleanup is intentionally conservative: it only marks merged clean work complete. */
  async cleanup(): Promise<readonly AssignmentRecord[]> {
    const assignments = await this.reconcile();
    // The prototype never removes a worktree or branch. Dirty and unmerged paths
    // remain persisted and discoverable; physical cleanup requires a future,
    // separately authorized lifecycle capability.
    return assignments;
  }

  private async validateGovernance(memberId: string, memberRevision: number, input: {
    improvementId: string; fencingToken: number; manifestRevision: number;
  }): Promise<AssignmentResult<{ repositoryBaseCommit: string }>> {
    const member = this.developers.latest(memberId);
    if (!member || member.revision !== memberRevision || !member.capabilities.includes("ASSIGNMENT_WRITE")) {
      return { kind: "rejected", reason: "Developer-team identity or assignment capability changed" };
    }
    const improvement = await this.rooms.getImprovement(input.improvementId);
    if (!improvement) return { kind: "not_found" };
    const claim = improvement.workClaim;
    const manifest = claim.manifests.at(-1);
    if (claim.status !== "ACTIVE" || claim.holderMemberId !== memberId || claim.fencingToken !== input.fencingToken
      || !claim.leaseExpiresAt || Date.parse(claim.leaseExpiresAt) <= Date.parse(this.now())) {
      return { kind: "rejected", reason: "An active, unexpired, correctly fenced work claim is required" };
    }
    if (!manifest || manifest.revision !== input.manifestRevision || manifest.memberId !== memberId || manifest.memberConfigRevision !== memberRevision
      || manifest.effectiveToolGrants.some((grant) => PROHIBITED_GRANT.test(grant))) {
      return { kind: "rejected", reason: "The execution manifest does not authorize this trusted, non-publication lifecycle" };
    }
    return { kind: "ok", value: { repositoryBaseCommit: manifest.repositoryBaseCommit } };
  }
}

function isWritableAssignment(assignment: AssignmentRecord) {
  return assignment.lifecycleStatus === "ACTIVE" || assignment.lifecycleStatus === "RECOVERABLE" || assignment.lifecycleStatus === "MISSING";
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
function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48); }
