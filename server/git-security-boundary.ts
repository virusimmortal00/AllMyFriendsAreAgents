import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AssignmentRecord, AssignmentRecordStore } from "./assignment-record.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { RoomRepository } from "./storage/room-repository.js";
import type { AgentId } from "./types.js";
import { requireReconciledSourceWork } from "./storage/identity-domain.js";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const SAFE_BRANCH = /^amfaa\/assignment-[a-z0-9-]+-[0-9a-f]{8}$/;
const PROHIBITED_GRANT = /(^|[._:/-])(push|merge|deploy|publish)([._:/-]|$)/i;

export const GIT_SECURITY_BOUNDARY_REVISION = "assignment-git-broker/v1" as const;
export const BROKERED_GIT_OPERATIONS = ["status", "diff", "stage", "commit"] as const;
export type BrokeredGitOperation = (typeof BROKERED_GIT_OPERATIONS)[number];

export interface AssignmentGitClaims {
  readonly assignmentId: string;
  readonly improvementId: string;
  readonly developerMemberId: string;
  readonly developerMemberConfigRevision: number;
  readonly agent: AgentId;
  readonly fencingToken: number;
  readonly manifestRevision: number;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly workspacePath: string;
}

export interface AssignmentGitRequest {
  readonly requestId: string;
  readonly claims: AssignmentGitClaims;
  readonly operation: BrokeredGitOperation;
  readonly paths?: readonly string[];
  readonly message?: string;
  /** The protocol never forwards caller-controlled process environment. */
  readonly environment?: Readonly<Record<string, string>>;
}

export type AssignmentGitResult =
  | { readonly kind: "ok"; readonly output: string; readonly claims: AssignmentGitClaims }
  | { readonly kind: "rejected"; readonly reason: string };

interface AuditEntry {
  readonly schemaVersion: 1;
  readonly boundaryRevision: typeof GIT_SECURITY_BOUNDARY_REVISION;
  readonly timestamp: string;
  readonly requestId: string;
  readonly assignmentId: string;
  readonly memberId: string;
  readonly operation: string;
  readonly outcome: "ok" | "rejected";
  readonly detail: string;
  readonly previousHash: string;
  readonly entryHash: string;
}

/**
 * Trusted, server-side Git authority. Callers choose an operation, never a Git
 * command, option, ref, repository, config, remote, hook, credential helper, or
 * environment. Every request is rebound to durable governance before Git runs.
 */
export class AssignmentGitBroker {
  private operationQueue: Promise<void> = Promise.resolve();
  private auditQueue: Promise<void> = Promise.resolve();
  private previousAuditHash = "0".repeat(64);

  constructor(
    private readonly assignmentId: string,
    private readonly records: AssignmentRecordStore,
    private readonly rooms: RoomRepository,
    private readonly developers: DeveloperTeamRegistry,
    private readonly repositoryPath: string,
    private readonly worktreesRoot: string,
    private readonly auditPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  execute(request: AssignmentGitRequest): Promise<AssignmentGitResult> {
    const operation = this.operationQueue.then(() => this.executeLocked(request));
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async executeLocked(request: AssignmentGitRequest): Promise<AssignmentGitResult> {
    let result: AssignmentGitResult;
    try {
      const assignment = await this.authorize(request);
      result = await this.perform(assignment, request);
    } catch (error) {
      result = { kind: "rejected", reason: error instanceof Error ? error.message : "Git broker rejected the request" };
    }
    await this.audit(request, result);
    return result;
  }

  /** Records transport/parser/authentication failures that cannot become a
   * normal operation request. It deliberately grants no Git authority. */
  async recordIngressRejection(input: { requestId: string; claims: AssignmentGitClaims; operation: string; reason: string }) {
    await this.audit({
      requestId: input.requestId || "missing",
      claims: input.claims,
      operation: input.operation as BrokeredGitOperation,
    }, { kind: "rejected", reason: input.reason });
  }

  private async authorize(request: AssignmentGitRequest) {
    if (!request || !request.requestId?.trim() || !BROKERED_GIT_OPERATIONS.includes(request.operation)) {
      throw new Error("A request ID and documented broker operation are required");
    }
    if (request.environment && Object.keys(request.environment).length > 0) {
      throw new Error("Caller-controlled environment variables are prohibited");
    }
    const claims = request.claims;
    if (claims.assignmentId !== this.assignmentId) throw new Error("Request targets another assignment broker");
    await requireReconciledSourceWork(this.rooms, "assignment", claims.assignmentId);
    const assignment = await this.records.getAssignment(claims.assignmentId);
    if (!assignment || !sameAssignmentClaims(assignment, claims)) throw new Error("Assignment claims are stale or mismatched");
    if (assignment.lifecycleStatus !== "ACTIVE" && assignment.lifecycleStatus !== "RECOVERABLE") {
      throw new Error("Assignment is not writable");
    }
    const member = this.developers.latest(claims.developerMemberId);
    if (!member || member.revision !== claims.developerMemberConfigRevision || !member.capabilities.includes("ASSIGNMENT_WRITE")) {
      throw new Error("Developer-team identity or capability changed");
    }
    const improvement = await this.rooms.getImprovement(claims.improvementId);
    const claim = improvement?.workClaim;
    const manifest = claim?.manifests.at(-1);
    if (!claim || claim.status !== "ACTIVE" || claim.holderMemberId !== claims.developerMemberId
      || claim.fencingToken !== claims.fencingToken || !claim.leaseExpiresAt
      || Date.parse(claim.leaseExpiresAt) <= Date.parse(this.now())) {
      throw new Error("The persisted work claim is missing, expired, or incorrectly fenced");
    }
    if (!manifest || manifest.revision !== claims.manifestRevision || manifest.memberId !== claims.developerMemberId
      || manifest.memberConfigRevision !== claims.developerMemberConfigRevision
      || manifest.repositoryBaseCommit !== claims.baseSha
      || manifest.effectiveToolGrants.some((grant) => PROHIBITED_GRANT.test(grant))) {
      throw new Error("The persisted execution manifest does not authorize this operation");
    }
    await this.validateRepositoryIdentity(assignment);
    return assignment;
  }

  private async validateRepositoryIdentity(assignment: AssignmentRecord) {
    if (!path.isAbsolute(assignment.workspacePath) || !path.isAbsolute(this.repositoryPath) || !path.isAbsolute(this.worktreesRoot)) {
      throw new Error("Repository and workspace paths must be absolute");
    }
    const [repository, root, workspace] = await Promise.all([
      realpath(this.repositoryPath), realpath(this.worktreesRoot), realpath(assignment.workspacePath),
    ]);
    if (workspace !== assignment.workspacePath || workspace === repository || !within(root, workspace)) {
      throw new Error("Workspace is not the assignment-owned canonical path");
    }
    const [repositoryTop, workspaceTop, repositoryCommon, workspaceCommon] = await Promise.all([
      git(repository, ["rev-parse", "--show-toplevel"]),
      git(workspace, ["rev-parse", "--show-toplevel"]),
      git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    if (await realpath(repositoryTop) !== repository || await realpath(workspaceTop) !== workspace
      || await realpath(repositoryCommon) !== await realpath(workspaceCommon)) {
      throw new Error("Workspace repository identity does not match the governed repository");
    }
    const [branch, head] = await Promise.all([
      git(workspace, ["branch", "--show-current"]), git(workspace, ["rev-parse", "--verify", "HEAD"]),
    ]);
    if (branch !== assignment.branch || head !== assignment.observedHeadSha || !SAFE_BRANCH.test(branch)) {
      throw new Error("Assignment branch or observed head changed outside the broker");
    }
  }

  private async perform(assignment: AssignmentRecord, request: AssignmentGitRequest): Promise<AssignmentGitResult> {
    const cwd = assignment.workspacePath;
    let output = "";
    if (request.operation === "status") {
      rejectExtraArguments(request, false, false);
      output = await governedGit(cwd, ["status", "--short", "--branch", "--untracked-files=normal"]);
    } else if (request.operation === "diff") {
      rejectExtraArguments(request, false, false);
      output = await governedGit(cwd, ["diff", "--no-ext-diff", "--no-renames", "--"]);
    } else if (request.operation === "stage") {
      if (request.message !== undefined || !request.paths?.length || request.paths.length > 256) throw new Error("Stage requires only a bounded non-empty path list");
      const paths = await Promise.all(request.paths.map((candidate) => validateOwnedPath(cwd, candidate)));
      // Revalidate immediately before use. Together with per-broker
      // serialization and the confined writer's immutable .git mount this
      // closes command interleaving and metadata check/use races.
      await this.validateRepositoryIdentity(assignment);
      await Promise.all(paths.map((candidate) => validateOwnedPath(cwd, candidate)));
      output = await governedGit(cwd, ["add", "--", ...paths]);
    } else {
      if (request.paths !== undefined || !request.message?.trim() || request.message.length > 4_000 || /[\0\r]/.test(request.message)) {
        throw new Error("Commit requires only a bounded commit message");
      }
      output = await governedGit(cwd, ["commit", "--no-verify", "-m", request.message]);
    }
    const headSha = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
    if (!SHA.test(headSha)) throw new Error("Broker produced an invalid assignment head");
    const next = headSha === assignment.observedHeadSha ? assignment : { ...assignment, observedHeadSha: headSha, updatedAt: this.now() };
    if (next !== assignment) await this.records.putAssignment(next);
    return { kind: "ok", output, claims: claimsFor(next) };
  }

  private audit(request: AssignmentGitRequest, result: AssignmentGitResult) {
    const operation = this.auditQueue.then(async () => {
      await mkdir(path.dirname(this.auditPath), { recursive: true, mode: 0o700 });
      const base = {
        schemaVersion: 1 as const,
        boundaryRevision: GIT_SECURITY_BOUNDARY_REVISION,
        timestamp: this.now(),
        requestId: request?.requestId || "missing",
        assignmentId: request?.claims?.assignmentId || "missing",
        memberId: request?.claims?.developerMemberId || "missing",
        operation: request?.operation || "missing",
        outcome: result.kind,
        detail: result.kind === "ok" ? `head=${result.claims.headSha}` : result.reason,
        previousHash: this.previousAuditHash,
      };
      const entryHash = createHash("sha256").update(JSON.stringify(base)).digest("hex");
      const entry: AuditEntry = { ...base, entryHash };
      await appendFile(this.auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      await chmod(this.auditPath, 0o600);
      this.previousAuditHash = entryHash;
    });
    this.auditQueue = operation.catch(() => undefined);
    return operation;
  }
}

export function claimsFor(assignment: AssignmentRecord): AssignmentGitClaims {
  return Object.freeze({
    assignmentId: assignment.assignmentId, improvementId: assignment.improvementId,
    developerMemberId: assignment.developerMemberId, developerMemberConfigRevision: assignment.developerMemberConfigRevision,
    agent: assignment.agent, fencingToken: assignment.fencingToken, manifestRevision: assignment.manifestRevision,
    branch: assignment.branch, baseSha: assignment.pinnedBaseSha, headSha: assignment.observedHeadSha,
    workspacePath: assignment.workspacePath,
  });
}

function sameAssignmentClaims(assignment: AssignmentRecord, claims: AssignmentGitClaims) {
  const expected = claimsFor(assignment);
  return Object.keys(expected).every((key) => expected[key as keyof AssignmentGitClaims] === claims[key as keyof AssignmentGitClaims]);
}

function rejectExtraArguments(request: AssignmentGitRequest, paths: boolean, message: boolean) {
  if ((!paths && request.paths !== undefined) || (!message && request.message !== undefined)) throw new Error("Operation received prohibited arguments");
}

async function validateOwnedPath(workspace: string, candidate: string) {
  if (!candidate || path.isAbsolute(candidate) || candidate.startsWith("-") || candidate.includes("\0")) throw new Error("Stage path is invalid");
  const normalized = path.normalize(candidate);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized === ".git" || normalized.startsWith(`.git${path.sep}`)) {
    throw new Error("Stage path escapes or targets Git metadata");
  }
  const target = path.resolve(workspace, normalized);
  if (!within(workspace, target)) throw new Error("Stage path escapes the assignment workspace");
  const parent = await realpath(path.dirname(target));
  if (parent !== workspace && !within(workspace, parent)) throw new Error("Stage path follows a symlink outside the assignment workspace");
  const targetInfo = await lstat(target).catch(() => undefined);
  if (targetInfo?.isSymbolicLink()) throw new Error("Symlink staging is prohibited");
  return normalized;
}

function within(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const CLEAN_GIT_ENV = Object.freeze({
  PATH: process.env.PATH || "/usr/bin:/bin", HOME: "/var/empty", LANG: "C", LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "1",
});

async function governedGit(cwd: string, args: readonly string[]) {
  return git(cwd, [
    "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "core.sshCommand=false",
    "-c", "commit.gpgSign=false", "-c", "user.name=Assignment Broker", "-c", "user.email=broker@localhost",
    ...args,
  ]);
}

async function git(cwd: string, args: readonly string[]) {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: CLEAN_GIT_ENV,
  });
  return result.stdout.trim();
}

export async function resolveGitCommonDirectory(workspace: string) {
  return realpath(await git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

export function newBrokerRequestId() { return randomUUID(); }
