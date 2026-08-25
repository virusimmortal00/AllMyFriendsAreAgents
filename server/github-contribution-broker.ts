import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AssignmentRecordStore } from "./assignment-record.js";
import type { AuthenticatedDeveloper, DeveloperTeamRegistry } from "./developer-team.js";
import { GitHubClientError, type GitHubContributionClient } from "./github-client.js";
import {
  GITHUB_BROKER_REVISION, GITHUB_OPERATION_CAPABILITY, GITHUB_OPERATIONS, GITHUB_POLICY_REVISION,
  type GitHubBrokerClaims, type GitHubBrokerRequest, type GitHubBrokerResult, type GitHubExternalResult,
} from "./github-contribution-record.js";
import type { GitHubContributionStore } from "./github-contribution-store.js";
import { CANONICAL_ROOM_ID, type RoomRepository } from "./storage/room-repository.js";

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ASSIGNMENT_BRANCH = /^amfaa\/assignment-[a-z0-9-]+-[0-9a-f]{8}$/;
const TERMINAL_TASKS = new Set(["completed", "abandoned", "archived"]);
const REQUEST_FIELDS = new Set([
  "idempotencyKey", "operation", "taskId", "assignmentId", "expectedTaskRevision", "expectedAssignmentRevision",
  "expectedFencingToken", "expectedManifestRevision", "expectedPolicyRevision", "expectedBaseSha", "expectedHeadSha",
  "issueNumber", "pullNumber", "body", "title", "reviewers",
]);

export class GitHubContributionBroker {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly records: AssignmentRecordStore,
    private readonly rooms: RoomRepository,
    private readonly developers: DeveloperTeamRegistry,
    private readonly store: GitHubContributionStore,
    private readonly client: GitHubContributionClient,
    private readonly repositoryPath: string,
    private readonly repository: string,
    private readonly baseBranch = "main",
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (!REPOSITORY.test(repository) || !baseBranch || baseBranch.startsWith("-") || baseBranch.includes("..")) throw new Error("A canonical GitHub repository and base branch are required");
  }

  execute(auth: AuthenticatedDeveloper, request: GitHubBrokerRequest): Promise<GitHubBrokerResult> {
    let result!: GitHubBrokerResult;
    const operation = this.queue.then(async () => { result = await this.executeLocked(auth, request); });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation.then(() => result);
  }

  audit() { return this.store.records(); }

  private async executeLocked(auth: AuthenticatedDeveloper, request: GitHubBrokerRequest): Promise<GitHubBrokerResult> {
    const requestHash = hash(normalizedRequest(request));
    const prior = this.store.latest(request?.idempotencyKey || "");
    if (prior) {
      if (prior.requestHash !== requestHash || prior.actorId !== auth.member.memberId) return { kind: "rejected", reason: "Idempotency key was already used for another request" };
      if (prior.outcome === "SUCCEEDED" && prior.result && prior.claims) return { kind: "ok", value: prior.result, claims: prior.claims, replayed: true };
      if (prior.outcome === "REJECTED") return { kind: "rejected", reason: prior.detail };
      if (prior.outcome === "FAILED" && !prior.detail.startsWith("retryable:")) return { kind: "failed", reason: prior.detail, retryable: false };
    }

    let claims: GitHubBrokerClaims | null = null;
    let target = "invalid";
    try {
      claims = await this.authorize(auth, request);
      target = targetFor(request);
      if (!prior || prior.outcome !== "PENDING") await this.record(request, requestHash, auth.member.memberId, target, claims, "PENDING", null, "Authorized; external operation pending");
      if (!["READ_ISSUE", "READ_PULL_REQUEST", "READ_CHECKS"].includes(request.operation)) {
        const current = await this.authorize(auth, request);
        if (JSON.stringify(current) !== JSON.stringify(claims)) throw new Error("Authority changed before external mutation");
      }
      const value = await this.perform(request, claims);
      await this.record(request, requestHash, auth.member.memberId, target, claims, "SUCCEEDED", value, "External operation completed");
      return { kind: "ok", value, claims, replayed: false };
    } catch (error) {
      const retryable = error instanceof GitHubClientError && error.retryable;
      const detail = safeError(error);
      const outcome = claims ? "FAILED" as const : "REJECTED" as const;
      await this.record(request, requestHash, auth.member.memberId, target, claims, outcome, null, retryable ? `retryable:${detail}` : detail);
      return claims ? { kind: "failed", reason: detail, retryable } : { kind: "rejected", reason: detail };
    }
  }

  private async authorize(auth: AuthenticatedDeveloper, request: GitHubBrokerRequest): Promise<GitHubBrokerClaims> {
    if (!request || !KEY.test(request.idempotencyKey || "") || !GITHUB_OPERATIONS.includes(request.operation)) throw new Error("A bounded idempotency key and documented GitHub operation are required");
    if (Object.keys(request).some((field) => !REQUEST_FIELDS.has(field))) throw new Error("Request contains a field outside the GitHub broker contract");
    const latestMember = this.developers.latest(auth.member.memberId);
    const capability = GITHUB_OPERATION_CAPABILITY[request.operation];
    if (!latestMember || latestMember.revision !== auth.member.revision || !latestMember.capabilities.includes(capability)) throw new Error("Developer identity or operation capability changed");
    if (request.expectedPolicyRevision !== GITHUB_POLICY_REVISION) throw new Error("GitHub broker policy revision changed");
    if ((await this.rooms.getEmergencyStop()).active) throw new Error("Emergency stop is active");

    const task = await this.rooms.getTask({ roomId: CANONICAL_ROOM_ID, taskId: request.taskId });
    if (!task || task.revision !== request.expectedTaskRevision || TERMINAL_TASKS.has(task.state)) throw new Error("Task is missing, stale, or closed");
    if (!task.references.some((reference) => reference.kind === "assignment" && reference.targetId === request.assignmentId)) throw new Error("Task is not linked to this assignment");
    const assignment = await this.records.getAssignment(request.assignmentId);
    const assignmentRevision = assignment?.lifecycleRevision ?? 1;
    if (!assignment || assignment.lifecycleStatus !== "ACTIVE" || assignmentRevision !== request.expectedAssignmentRevision
      || assignment.developerMemberId !== auth.member.memberId || assignment.developerMemberConfigRevision !== auth.member.revision
      || assignment.fencingToken !== request.expectedFencingToken || assignment.manifestRevision !== request.expectedManifestRevision
      || assignment.pinnedBaseSha !== request.expectedBaseSha || assignment.observedHeadSha !== request.expectedHeadSha) {
      throw new Error("Assignment identity, authority, revision, or source head is stale");
    }
    if (!SHA.test(assignment.pinnedBaseSha) || !SHA.test(assignment.observedHeadSha)) throw new Error("Assignment source identity is invalid");
    const improvement = await this.rooms.getImprovement(assignment.improvementId);
    const claim = improvement?.workClaim; const manifest = claim?.manifests.at(-1);
    if (!claim || claim.status !== "ACTIVE" || claim.holderMemberId !== auth.member.memberId || claim.fencingToken !== assignment.fencingToken
      || !claim.leaseExpiresAt || Date.parse(claim.leaseExpiresAt) <= Date.parse(this.now()) || manifest?.revision !== assignment.manifestRevision
      || manifest.memberConfigRevision !== auth.member.revision || manifest.repositoryBaseCommit !== assignment.pinnedBaseSha) {
      throw new Error("Work claim or execution manifest is stale, expired, or revoked");
    }
    await this.validateRepository(assignment.workspacePath, assignment.branch, assignment.pinnedBaseSha, assignment.observedHeadSha);
    if (["READ_ISSUE", "COMMENT"].includes(request.operation) && request.issueNumber && !linkedNumber(task.references, "issue", request.issueNumber)) throw new Error("Issue is not linked to the governed task");
    if (["READ_PULL_REQUEST", "COMMENT"].includes(request.operation) && request.pullNumber && !linkedNumber(task.references, "pull", request.pullNumber) && !this.ownedPull(request.pullNumber, request.assignmentId)) throw new Error("Pull request is not linked to the governed task or broker-owned assignment");
    if (["UPDATE_PULL_REQUEST", "REQUEST_REVIEW"].includes(request.operation) && !this.ownedPull(request.pullNumber, request.assignmentId)) throw new Error("Pull request is not broker-owned by this assignment");
    return {
      repository: this.repository, roomId: CANONICAL_ROOM_ID, taskId: task.taskId, taskRevision: task.revision,
      assignmentId: assignment.assignmentId, assignmentRevision, memberId: auth.member.memberId, memberRevision: auth.member.revision,
      fencingToken: assignment.fencingToken, manifestRevision: assignment.manifestRevision, branch: assignment.branch,
      baseSha: assignment.pinnedBaseSha, headSha: assignment.observedHeadSha, policyRevision: GITHUB_POLICY_REVISION,
    };
  }

  private async validateRepository(workspacePath: string, branch: string, baseSha: string, headSha: string) {
    const [repository, workspace] = await Promise.all([realpath(this.repositoryPath), realpath(workspacePath)]);
    if (repository === workspace || !path.isAbsolute(workspacePath)) throw new Error("Assignment workspace is not isolated from the repository checkout");
    if (!ASSIGNMENT_BRANCH.test(branch)) throw new Error("Assignment branch is outside the broker namespace");
    const [top, actualBranch, actualHead, baseRef, remote, repositoryCommon, workspaceCommon] = await Promise.all([
      git(workspace, ["rev-parse", "--show-toplevel"]), git(workspace, ["branch", "--show-current"]), git(workspace, ["rev-parse", "HEAD"]),
      git(repository, ["rev-parse", `refs/remotes/origin/${this.baseBranch}`]), git(repository, ["remote", "get-url", "origin"]),
      git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    if (await realpath(top) !== workspace || await realpath(repositoryCommon) !== await realpath(workspaceCommon)
      || actualBranch !== branch || actualHead !== headSha || baseRef !== baseSha) throw new Error("Repository identity, branch, base, or head changed");
    if (canonicalRemote(remote) !== this.repository.toLowerCase()) throw new Error("Repository origin changed");
    await git(workspace, ["merge-base", "--is-ancestor", baseSha, headSha]);
  }

  private async perform(request: GitHubBrokerRequest, claims: GitHubBrokerClaims): Promise<GitHubExternalResult> {
    switch (request.operation) {
      case "READ_ISSUE": return this.client.readIssue(this.repository, positive(request.issueNumber, "issue"));
      case "READ_PULL_REQUEST": return this.client.readPullRequest(this.repository, positive(request.pullNumber, "pull request"));
      case "READ_CHECKS": return this.client.readChecks(this.repository, claims.headSha);
      case "COMMENT": {
        const body = boundedText(request.body, 8_000, "Comment body");
        if (!!request.issueNumber === !!request.pullNumber) throw new Error("Comment requires exactly one issue or pull request target");
        return this.client.comment(this.repository, { issueNumber: request.issueNumber, pullNumber: request.pullNumber }, body, marker(request.idempotencyKey));
      }
      case "PUBLISH_DRAFT_PULL_REQUEST": {
        const title = boundedText(request.title, 160, "Pull request title"); const body = boundedText(request.body, 32_000, "Pull request body");
        if (await this.client.readBranchHead(this.repository, this.baseBranch) !== claims.baseSha) throw new Error("GitHub base branch changed since assignment authorization");
        const existing = await this.client.findDraftPullRequest(this.repository, claims.branch);
        if (existing) return existing;
        await this.client.publishBranch(this.repository, (await this.records.getAssignment(claims.assignmentId))!.workspacePath, claims.branch, claims.headSha);
        return this.client.createDraftPullRequest(this.repository, claims.branch, this.baseBranch, title, `${body}\n\n${marker(request.idempotencyKey)}`);
      }
      case "UPDATE_PULL_REQUEST": {
        const number = positive(request.pullNumber, "pull request");
        await this.verifyOwnedPullIdentity(number, claims);
        if (request.title === undefined && request.body === undefined) throw new Error("An allowed pull request metadata field is required");
        return this.client.updatePullRequest(this.repository, number, {
          ...(request.title !== undefined ? { title: boundedText(request.title, 160, "Pull request title") } : {}),
          ...(request.body !== undefined ? { body: boundedText(request.body, 32_000, "Pull request body") } : {}),
        });
      }
      case "REQUEST_REVIEW": {
        await this.verifyOwnedPullIdentity(positive(request.pullNumber, "pull request"), claims);
        const reviewers = [...new Set(request.reviewers ?? [])];
        if (!reviewers.length || reviewers.length > 10 || reviewers.some((reviewer) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(reviewer))) throw new Error("One to ten valid GitHub reviewer logins are required");
        return this.client.requestReview(this.repository, positive(request.pullNumber, "pull request"), reviewers);
      }
    }
  }

  private ownedPull(number: number | undefined, assignmentId: string) {
    return Number.isSafeInteger(number) && this.store.records().some((record) => record.outcome === "SUCCEEDED"
      && record.operation === "PUBLISH_DRAFT_PULL_REQUEST" && record.claims?.assignmentId === assignmentId && record.result?.number === number);
  }

  private async verifyOwnedPullIdentity(number: number, claims: GitHubBrokerClaims) {
    const identity = await this.client.pullRequestIdentity(this.repository, number);
    if (identity.state !== "open" || !identity.draft || identity.headRef !== claims.branch || identity.headSha !== claims.headSha || identity.baseSha !== claims.baseSha) {
      throw new Error("Broker-owned pull request source identity changed");
    }
  }

  private record(request: GitHubBrokerRequest, requestHash: string, actorId: string, target: string, claims: GitHubBrokerClaims | null,
    outcome: "PENDING" | "SUCCEEDED" | "REJECTED" | "FAILED", result: GitHubExternalResult | null, detail: string) {
    return this.store.append({ timestamp: this.now(), idempotencyKey: request?.idempotencyKey || "invalid", requestHash, actorId,
      operation: GITHUB_OPERATIONS.includes(request?.operation) ? request.operation : "READ_ISSUE", target, claims, outcome, result, detail });
  }
}

function normalizedRequest(request: GitHubBrokerRequest) { return request && typeof request === "object" ? request : {}; }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function marker(key: string) { return `<!-- amfaa-github-broker:${hash(key).slice(0, 24)} -->`; }
function targetFor(request: GitHubBrokerRequest) { return request.issueNumber ? `issue:${request.issueNumber}` : request.pullNumber ? `pull:${request.pullNumber}` : request.operation === "READ_CHECKS" ? `commit:${request.expectedHeadSha}` : `branch:${request.assignmentId}`; }
function positive(value: unknown, label: string) { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`A valid ${label} number is required`); return Number(value); }
function boundedText(value: unknown, maximum: number, label: string) { if (typeof value !== "string" || !value.trim() || value.length > maximum || /\0/.test(value)) throw new Error(`${label} must be non-empty and at most ${maximum} characters`); return value.trim(); }
function safeError(error: unknown) { return (error instanceof Error ? error.message : "GitHub broker rejected the request").slice(0, 2_000); }
function linkedNumber(references: readonly { targetId: string; uri?: string }[], kind: "issue" | "pull", number: number) { const pattern = new RegExp(`(?:${kind}|${kind === "pull" ? "pulls" : "issues"})[/:#-]${number}(?:$|\\b)`, "i"); return references.some((reference) => pattern.test(reference.targetId) || pattern.test(reference.uri || "")); }
function canonicalRemote(remote: string) { const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote.trim()); return (match?.[1] || "").replace(/\.git$/, "").toLowerCase(); }
async function git(cwd: string, args: readonly string[]) { const { stdout } = await execFileAsync("git", [...args], { cwd, timeout: 10_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/var/empty", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } }); return stdout.trim(); }
