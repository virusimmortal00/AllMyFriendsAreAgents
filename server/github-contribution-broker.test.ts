import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "../shared/task-domain.js";
import type { AssignmentRecord } from "./assignment-record.js";
import { DeveloperTeamRegistry, hashToken, type AuthenticatedDeveloper, type DeveloperCapability } from "./developer-team.js";
import { GitHubClientError, type GitHubContributionClient } from "./github-client.js";
import { GitHubContributionBroker } from "./github-contribution-broker.js";
import { GITHUB_POLICY_REVISION, type GitHubBrokerRequest, type GitHubExternalResult } from "./github-contribution-record.js";
import { GitHubContributionStore } from "./github-contribution-store.js";
import { githubBrokerRepositoryReferences } from "./github-broker-repository-references.js";
import type { RoomRepository } from "./storage/room-repository.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class FakeGitHub implements GitHubContributionClient {
  readonly calls: string[] = [];
  pull: GitHubExternalResult | null = null;
  failNext?: Error;
  private result(kind: string, number?: number) { this.calls.push(kind); if (this.failNext) { const error = this.failNext; this.failNext = undefined; throw error; } return Promise.resolve({ id: `${kind}-id`, url: `https://github.test/${kind}`, number }); }
  baseSha = ""; headSha = ""; headRef = "";
  readBranchHead() { this.calls.push("read-branch-head"); return Promise.resolve(this.baseSha); }
  pullRequestIdentity() { this.calls.push("pull-identity"); return Promise.resolve({ headSha: this.headSha, baseSha: this.baseSha, headRef: this.headRef, draft: true, state: "open" }); }
  readIssue(_repository: string, number: number) { return this.result("read-issue", number); }
  readPullRequest(_repository: string, number: number) { return this.result("read-pull", number); }
  readChecks() { return this.result("read-checks"); }
  comment() { return this.result("comment", 13); }
  async publishBranch() { await this.result("publish-branch"); }
  findDraftPullRequest() { this.calls.push("find-pull"); return Promise.resolve(this.pull); }
  async createDraftPullRequest() { const result = await this.result("create-pull", 44); this.pull = result; return result; }
  updatePullRequest(_repository: string, number: number) { return this.result("update-pull", number); }
  requestReview(_repository: string, number: number) { return this.result("request-review", number); }
  markPullRequestReady(_repository: string, number: number) { return this.result("ready-pull", number); }
  async mergePullRequest(_repository: string, _number: number, headSha: string) { this.calls.push("merge-pull"); return { id: headSha, commitSha: headSha }; }
}

async function fixture(capabilities: readonly DeveloperCapability[] = ["GITHUB_READ", "GITHUB_COMMENT", "GITHUB_PUBLISH_DRAFT", "GITHUB_PR_METADATA", "GITHUB_REQUEST_REVIEW"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-github-broker-")); roots.push(root);
  await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.name", "Test"]); await git(root, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(root, "README.md"), "base\n"); await git(root, ["add", "README.md"]); await git(root, ["commit", "-m", "base"]);
  const baseSha = await git(root, ["rev-parse", "HEAD"]); await git(root, ["remote", "add", "origin", "https://github.com/virusimmortal00/AllMyFriendsAreAgents.git"]);
  await git(root, ["update-ref", "refs/remotes/origin/main", baseSha]);
  const workspace = path.join(root, "..", `${path.basename(root)}-worktree`); roots.push(workspace);
  const branch = "amfaa/assignment-task-12345678"; await git(root, ["worktree", "add", "-b", branch, workspace, baseSha]);
  await writeFile(path.join(workspace, "change.txt"), "bounded\n"); await git(workspace, ["add", "change.txt"]); await git(workspace, ["commit", "-m", "bounded"]);
  const headSha = await git(workspace, ["rev-parse", "HEAD"]); const now = new Date(Date.now() + 60_000).toISOString();
  const assignment: AssignmentRecord = {
    assignmentId: "assignment-1", improvementId: "improvement-1", developerMemberId: "developer-1", developerMemberConfigRevision: 1,
    agent: "codex-sol", fencingToken: 7, manifestRevision: 3, pinnedBaseSha: baseSha, branch, observedHeadSha: headSha, workspacePath: workspace,
    lifecycleStatus: "ACTIVE", lifecycleRevision: 2, cancelledAt: null, disposedAt: null, lastOperationKey: null,
    recovery: { classification: "clean", reconciledAt: now, previousStatus: null, detail: "test" }, createdAt: now, updatedAt: now,
  };
  const task = { roomId: "main", taskId: "task-1", revision: 4, state: "active", references: [
    { id: "assignment-ref", kind: "assignment", targetId: assignment.assignmentId },
    { id: "issue-ref", kind: "evidence", targetId: "github:issue:13", uri: "https://github.com/virusimmortal00/AllMyFriendsAreAgents/issues/13" },
  ] } as unknown as Task;
  let emergency = false;
  const room = {
    getTask: async () => task,
    getEmergencyStop: async () => ({ active: emergency }),
    getImprovement: async () => ({ workClaim: { status: "ACTIVE", holderMemberId: "developer-1", fencingToken: 7, leaseExpiresAt: now,
      manifests: [{ revision: 3, memberId: "developer-1", memberConfigRevision: 1, repositoryBaseCommit: baseSha }] } }),
  } as unknown as RoomRepository;
  const assignments = { getAssignment: async (id: string) => id === assignment.assignmentId ? assignment : undefined };
  const token = "t".repeat(40); const developers = new DeveloperTeamRegistry([{ memberId: "developer-1", revision: 1, displayName: "Developer",
    roles: ["AUTHOR", "REVIEWER"], capabilities, tokenHash: hashToken(token), createdAt: now }]);
  const auth = developers.authenticate(`Bearer ${token}`, capabilities[0] || "GITHUB_READ") as AuthenticatedDeveloper;
  const client = new FakeGitHub(); const file = path.join(root, ".broker", "audit.json"); const store = await GitHubContributionStore.open(file);
  client.baseSha = baseSha; client.headSha = headSha; client.headRef = branch;
  const broker = new GitHubContributionBroker(assignments as never, room, developers, store, client, root, "virusimmortal00/AllMyFriendsAreAgents", "main");
  const request: GitHubBrokerRequest = { idempotencyKey: "github:test:0001", operation: "READ_ISSUE", taskId: task.taskId, assignmentId: assignment.assignmentId,
    expectedTaskRevision: task.revision, expectedAssignmentRevision: 2, expectedFencingToken: 7, expectedManifestRevision: 3,
    expectedPolicyRevision: GITHUB_POLICY_REVISION, expectedBaseSha: baseSha, expectedHeadSha: headSha, issueNumber: 13 };
  return { root, file, assignment, task, developers, auth, client, store, broker, request, setEmergency: (value: boolean) => { emergency = value; } };
}

describe("scoped GitHub contribution broker", () => {
  it("derives immutable authority, records a hash-chained audit, and replays idempotently after restart", async () => {
    const value = await fixture();
    await expect(value.broker.execute(value.auth, value.request)).resolves.toMatchObject({ kind: "ok", replayed: false, claims: { repository: "virusimmortal00/AllMyFriendsAreAgents", taskRevision: 4, headSha: value.assignment.observedHeadSha } });
    await expect(value.broker.execute(value.auth, value.request)).resolves.toMatchObject({ kind: "ok", replayed: true });
    expect(value.client.calls).toEqual(["read-issue"]);
    const reopened = await GitHubContributionStore.open(value.file); expect(reopened.records().map(({ outcome }) => outcome)).toEqual(["PENDING", "SUCCEEDED"]);
    expect(reopened.records()[1]!.previousHash).toBe(reopened.records()[0]!.recordHash);
  });

  it("fails closed for stale, cross-target, revoked, stopped, and replay-substitution requests", async () => {
    const value = await fixture();
    await expect(value.broker.execute(value.auth, { ...value.request, idempotencyKey: "github:stale:0001", expectedHeadSha: "f".repeat(40) })).resolves.toMatchObject({ kind: "rejected" });
    await expect(value.broker.execute(value.auth, { ...value.request, idempotencyKey: "github:cross:0001", issueNumber: 99 })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("not linked") });
    const originalReferences = value.task.references;
    (value.task as unknown as { references: unknown[] }).references = [originalReferences[0], { id: "foreign", kind: "evidence", targetId: "foreign", uri: "https://github.com/other/repo/issues/13" }];
    await expect(value.broker.execute(value.auth, { ...value.request, idempotencyKey: "github:foreign-repository:0001" })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("repository") });
    (value.task as unknown as { references: readonly unknown[] }).references = originalReferences;
    value.setEmergency(true);
    await expect(value.broker.execute(value.auth, { ...value.request, idempotencyKey: "github:stop:0001" })).resolves.toMatchObject({ kind: "rejected", reason: "Emergency stop is active" });
    value.setEmergency(false); await value.broker.execute(value.auth, value.request);
    await expect(value.broker.execute(value.auth, { ...value.request, issueNumber: 99 })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("Idempotency key") });
    expect(value.client.calls).toEqual(["read-issue"]);
  });

  it("publishes only an assignment branch to a draft PR and confines subsequent metadata and review operations", async () => {
    const value = await fixture();
    const publish = { ...value.request, operation: "PUBLISH_DRAFT_PULL_REQUEST" as const, idempotencyKey: "github:publish:0001", issueNumber: undefined, title: "Bounded contribution", body: "Exact commit evidence" };
    await expect(value.broker.execute(value.auth, publish)).resolves.toMatchObject({ kind: "ok", value: { number: 44 } });
    expect(value.client.calls).toEqual(["read-branch-head", "find-pull", "publish-branch", "create-pull"]);
    await expect(value.broker.execute(value.auth, { ...value.request, operation: "UPDATE_PULL_REQUEST", idempotencyKey: "github:update:0001", issueNumber: undefined, pullNumber: 44, title: "Reviewed title" })).resolves.toMatchObject({ kind: "ok" });
    await expect(value.broker.execute(value.auth, { ...value.request, operation: "REQUEST_REVIEW", idempotencyKey: "github:review:0001", issueNumber: undefined, pullNumber: 44, reviewers: ["reviewer-one"] })).resolves.toMatchObject({ kind: "ok" });
    await expect(value.broker.execute(value.auth, { ...value.request, operation: "UPDATE_PULL_REQUEST", idempotencyKey: "github:foreign:0001", issueNumber: undefined, pullNumber: 45, title: "No" })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("broker-owned") });
  });

  it("allows retry only for retryable partial failures and reconciles an existing draft without duplicating it", async () => {
    const value = await fixture(); value.client.failNext = new GitHubClientError("rate limited", true);
    const publish = { ...value.request, operation: "PUBLISH_DRAFT_PULL_REQUEST" as const, idempotencyKey: "github:retry:0001", issueNumber: undefined, title: "Contribution", body: "Evidence" };
    await expect(value.broker.execute(value.auth, publish)).resolves.toEqual({ kind: "failed", reason: "rate limited", retryable: true });
    expect(githubBrokerRepositoryReferences((await GitHubContributionStore.open(value.file)).records())).toMatchObject([{ reconciled: false }]);
    value.client.pull = { id: "existing", url: "https://github.test/pull/44", number: 44 };
    await expect(value.broker.execute(value.auth, publish)).resolves.toMatchObject({ kind: "ok", value: { id: "existing" } });
    expect(githubBrokerRepositoryReferences((await GitHubContributionStore.open(value.file)).records())).toMatchObject([{ terminal: true, reconciled: true }]);
    expect(value.client.calls.filter((call) => call === "create-pull")).toHaveLength(0);
  });

  it("retains a lost mutation response across restart and a later authorization rejection", async () => {
    const value = await fixture();
    const comment = value.client.comment.bind(value.client);
    value.client.comment = async () => { await comment(); throw new GitHubClientError("Fixture response lost after mutation", true); };
    const request = { ...value.request, operation: "COMMENT" as const, body: "Fixture comment" };
    expect(await value.broker.execute(value.auth, request)).toEqual({ kind: "failed", reason: "Fixture response lost after mutation", retryable: true });
    expect(value.client.calls).toEqual(["comment"]);
    const failed = await GitHubContributionStore.open(value.file);
    expect(failed.records().map(({ outcome }) => outcome)).toEqual(["PENDING", "FAILED"]);
    expect(failed.latest(request.idempotencyKey)?.detail).toMatch(/^retryable:/);
    expect(githubBrokerRepositoryReferences(failed.records())).toMatchObject([{ terminal: false, reconciled: false }]);
    value.setEmergency(true);
    expect(await value.broker.execute(value.auth, request)).toEqual({ kind: "rejected", reason: "Emergency stop is active" });
    const rejected = await GitHubContributionStore.open(value.file);
    expect(rejected.records().map(({ outcome }) => outcome)).toEqual(["PENDING", "FAILED", "REJECTED"]);
    expect(githubBrokerRepositoryReferences(rejected.records())).toMatchObject([{ terminal: false, reconciled: false }]);
    expect(value.client.calls).toEqual(["comment"]);
  });

  it("rejects an existing draft whose externally observed head or base changed", async () => {
    const value = await fixture(); value.client.pull = { id: "existing", url: "https://github.test/pull/44", number: 44 }; value.client.headSha = "f".repeat(40);
    const publish = { ...value.request, operation: "PUBLISH_DRAFT_PULL_REQUEST" as const, idempotencyKey: "github:stale-draft:0001", issueNumber: undefined, title: "Contribution", body: "Evidence" };
    await expect(value.broker.execute(value.auth, publish)).resolves.toMatchObject({ kind: "failed", retryable: false, reason: expect.stringContaining("source identity changed") });
    expect(value.client.calls).not.toContain("publish-branch"); expect(value.client.calls).not.toContain("create-pull");
  });

  it("stores no reusable GitHub credential or caller-controlled content outside bounded hashes/results", async () => {
    const value = await fixture(); await value.broker.execute(value.auth, { ...value.request, operation: "COMMENT", idempotencyKey: "github:comment:0001", body: "Agent comment" });
    const persisted = await readFile(value.file, "utf8");
    expect(persisted).not.toContain("Agent comment"); expect(persisted).not.toContain("authorization"); expect(persisted).toContain("requestHash");
  });
});

async function git(cwd: string, args: readonly string[]) { const { stdout } = await exec("git", [...args], { cwd }); return stdout.trim(); }
