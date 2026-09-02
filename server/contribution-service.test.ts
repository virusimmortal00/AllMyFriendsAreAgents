import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "../shared/task-domain.js";
import type { AssignmentRecord } from "./assignment-record.js";
import { CONTRIBUTION_POLICY_REVISION, type ContributionRecord } from "./contribution-record.js";
import { ContributionService, type ContributionExternalExecutor, type CreateHandoffInput } from "./contribution-service.js";
import { ContributionStore } from "./contribution-store.js";
import { contributionRepositoryReference } from "./contribution-repository-reference.js";
import { DeveloperTeamRegistry, hashToken, type AuthenticatedDeveloper } from "./developer-team.js";
import type { RoomRepository } from "./storage/room-repository.js";

const exec = promisify(execFile); const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

class FakeExternal implements ContributionExternalExecutor {
  calls: string[] = []; fail?: { message: string; retryable: boolean };
  private check(kind: string) { this.calls.push(kind); if (this.fail) { const failure = this.fail; this.fail = undefined; throw Object.assign(new Error(failure.message), { retryable: failure.retryable }); } }
  async publish() { this.check("publish"); return { number: 55, url: "https://github.test/pull/55", resultId: "pr-55" }; }
  async merge() { this.check("merge"); return { commitSha: "c".repeat(40), resultId: "merge-55" }; }
  async deploy({ approval }: Parameters<ContributionExternalExecutor["deploy"]>[0]) { this.check("deploy"); return { environment: approval.environment!, commitSha: approval.mergedSha!, artifactDigest: approval.artifactDigest!, resultId: "deploy-55" }; }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amfaa-contribution-")); roots.push(root); await git(root, ["init", "-b", "main"]); await git(root, ["config", "user.name", "Test"]); await git(root, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(root, "base.txt"), "base\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]); const base = await git(root, ["rev-parse", "HEAD"]);
  const workspace = `${root}-worktree`; roots.push(workspace); const branch = "amfaa/assignment-contribution-12345678"; await git(root, ["worktree", "add", "-b", branch, workspace, base]);
  await writeFile(path.join(workspace, "change.txt"), "change\n"); await git(workspace, ["add", "."]); await git(workspace, ["commit", "-m", "change"]); const head = await git(workspace, ["rev-parse", "HEAD"]);
  const now = "2026-08-24T21:00:00.000Z"; let clock = 0; const timestamp = () => new Date(Date.parse(now) + clock++ * 1_000).toISOString();
  let assignment: AssignmentRecord = { assignmentId: "assignment-1", improvementId: "improvement-1", developerMemberId: "author", developerMemberConfigRevision: 1, agent: "codex-sol",
    fencingToken: 7, manifestRevision: 3, pinnedBaseSha: base, branch, observedHeadSha: head, workspacePath: workspace, lifecycleStatus: "ACTIVE", lifecycleRevision: 2,
    recovery: { classification: "clean", reconciledAt: now, previousStatus: null, detail: "test" }, createdAt: now, updatedAt: now };
  let task = { roomId: "main", taskId: "task-1", revision: 4, state: "active", references: [{ kind: "assignment", targetId: assignment.assignmentId }] } as unknown as Task;
  let improvement = { revision: 8, workClaim: { status: "ACTIVE", holderMemberId: "author", fencingToken: 7, leaseExpiresAt: "2026-08-25T23:00:00.000Z",
    manifests: [{ revision: 3, memberId: "author", memberConfigRevision: 1, repositoryBaseCommit: base, environmentId: "worktree", effectiveToolGrants: ["ASSIGNMENT_WRITE"] }] } };
  let emergency = false; const rooms = { getTask: async () => task, getAssignment: async () => assignment, getImprovement: async () => improvement, getEmergencyStop: async () => ({ active: emergency }) } as unknown as RoomRepository;
  const authorToken = "a".repeat(40); const reviewerToken = "r".repeat(40); const developers = new DeveloperTeamRegistry([
    { memberId: "author", revision: 1, displayName: "Author", roles: ["AUTHOR"], capabilities: ["CONTRIBUTION_HANDOFF", "GITHUB_PUBLISH_DRAFT"], tokenHash: hashToken(authorToken), createdAt: now },
    { memberId: "reviewer", revision: 1, displayName: "Reviewer", roles: ["REVIEWER"], capabilities: ["CONTRIBUTION_REVIEW"], tokenHash: hashToken(reviewerToken), createdAt: now },
  ]);
  const author = developers.authenticate(`Bearer ${authorToken}`, "CONTRIBUTION_HANDOFF")!; const reviewer = developers.authenticate(`Bearer ${reviewerToken}`, "CONTRIBUTION_REVIEW", "REVIEWER")!;
  const records = await ContributionStore.open(path.join(root, ".records", "contributions.json")); const external = new FakeExternal();
  const service = new ContributionService(rooms, rooms, developers, records, external, root, "virusimmortal00/AllMyFriendsAreAgents", undefined, timestamp);
  const input: CreateHandoffInput = { idempotencyKey: "handoff:test:0001", taskId: task.taskId, assignmentId: assignment.assignmentId, expectedTaskRevision: 4, expectedAssignmentRevision: 2, expectedFencingToken: 7,
    expectedManifestRevision: 3, expectedBaseSha: base, expectedHeadSha: head, expectedPolicyRevision: CONTRIBUTION_POLICY_REVISION, title: "Exact contribution", description: "Bounded reviewed work",
    testEvidence: [{ command: "pnpm test", result: "PASSED", digest: "d".repeat(64), at: now }], unresolvedFindings: [] };
  const restart = async () => new ContributionService(rooms, rooms, developers,
    await ContributionStore.open(path.join(root, ".records", "contributions.json")), external, root,
    "virusimmortal00/AllMyFriendsAreAgents", undefined, timestamp);
  return { root, service, records, external, author, reviewer, input, restart, setTask: (next: Task) => { task = next; }, setAssignment: (next: AssignmentRecord) => { assignment = next; }, setImprovement: (next: typeof improvement) => { improvement = next; }, setEmergency: (value: boolean) => { emergency = value; } };
}

async function accepted(value: Awaited<ReturnType<typeof fixture>>) {
  const created = await value.service.create(value.author, value.input); expect(created.kind).toBe("ok"); const first = (created as { kind: "ok"; value: ContributionRecord }).value;
  const reviewed = await value.service.review(value.reviewer, first.contributionId, first.revision, "ACCEPTED", "Exact source evidence accepted"); expect(reviewed.kind).toBe("ok"); return (reviewed as { kind: "ok"; value: ContributionRecord }).value;
}

describe("reviewed exact-commit contribution lifecycle", () => {
  it("creates one immutable handoff across retries and rejects idempotency substitution", async () => {
    const value = await fixture(); const first = valueOf(await value.service.create(value.author, value.input)); const replay = valueOf(await value.service.create(value.author, value.input));
    expect(replay.contributionId).toBe(first.contributionId); expect(value.service.list()).toHaveLength(1);
    await expect(value.service.create(value.author, { ...value.input, title: "Substituted" })).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("idempotency") });
  });
  it("keeps publication, merge, and deployment as distinct single-use exact gates", async () => {
    const value = await fixture(); let record = await accepted(value); expect(record.stage).toBe("REVIEW_ACCEPTED");
    record = valueOf(await value.service.approve("human", record.contributionId, record.revision, "PUBLICATION", {})); expect(record.stage).toBe("REVIEW_ACCEPTED");
    record = valueOf(await value.service.execute("human", record.contributionId, record.revision, "PUBLICATION")); expect(record).toMatchObject({ stage: "PR_PUBLISHED", pullRequest: { number: 55 } });
    await expect(value.service.execute("human", record.contributionId, record.revision, "PUBLICATION")).resolves.toMatchObject({ kind: "rejected" });
    record = valueOf(await value.service.approve("human", record.contributionId, record.revision, "MERGE", {}));
    record = valueOf(await value.service.execute("human", record.contributionId, record.revision, "MERGE")); expect(record).toMatchObject({ stage: "MERGED", merged: { commitSha: "c".repeat(40) } });
    record = valueOf(await value.service.approve("human", record.contributionId, record.revision, "DEPLOYMENT", { environment: "dev", artifactDigest: "e".repeat(64) }));
    record = valueOf(await value.service.execute("human", record.contributionId, record.revision, "DEPLOYMENT")); expect(record).toMatchObject({ stage: "DEPLOYED", deployed: { environment: "dev", artifactDigest: "e".repeat(64) } });
    expect(value.external.calls).toEqual(["publish", "merge", "deploy"]); expect(record.approvals.every(({ consumedAt }) => consumedAt)).toBe(true);
    expect(value.records.events(record.contributionId).map(({ action }) => action)).toEqual(["HANDOFF_CREATED", "REVIEW_ACCEPTED", "PUBLICATION_APPROVED", "PUBLICATION_EXECUTED", "PUBLICATION_EXECUTION_REJECTED", "MERGE_APPROVED", "MERGE_EXECUTED", "DEPLOYMENT_APPROVED", "DEPLOYMENT_EXECUTED"]);
  });

  it("requires an independent current reviewer and read-only immutable source evidence", async () => {
    const value = await fixture(); const created = valueOf(await value.service.create(value.author, value.input));
    await expect(value.service.review(value.author as AuthenticatedDeveloper, created.contributionId, created.revision, "ACCEPTED", "self review")).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("independent") });
    const acceptedReview = await value.service.review(value.reviewer, created.contributionId, created.revision, "ACCEPTED", "independent"); expect(acceptedReview).toMatchObject({ kind: "ok", value: { review: { sourceEvidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/) } } });
  });

  it("invalidates approval eligibility after task, assignment, manifest, source, or emergency-stop changes", async () => {
    const current = (await fixture()); const currentRecord = await accepted(current); current.setEmergency(true);
    await expect(current.service.approve("human", currentRecord.contributionId, currentRecord.revision, "PUBLICATION", {})).resolves.toMatchObject({ kind: "rejected", reason: "Emergency stop is active" });
    const changed = await fixture(); const changedRecord = await accepted(changed); changed.setTask({ ...({ roomId: "main", taskId: "task-1", state: "active", references: [{ kind: "assignment", targetId: "assignment-1" }] } as unknown as Task), revision: 5 });
    await expect(changed.service.approve("human", changedRecord.contributionId, changedRecord.revision, "PUBLICATION", {})).resolves.toMatchObject({ kind: "rejected", reason: expect.stringContaining("Task") });
  });

  it("keeps an exact approval unused after retryable external failure and audits the failed attempt", async () => {
    const value = await fixture(); let record = await accepted(value); record = valueOf(await value.service.approve("human", record.contributionId, record.revision, "PUBLICATION", {}));
    value.external.fail = { message: "ambiguous network failure", retryable: true };
    await expect(value.service.execute("human", record.contributionId, record.revision, "PUBLICATION")).resolves.toEqual({ kind: "failed", reason: "ambiguous network failure", retryable: true });
    expect(value.service.get(record.contributionId)?.approvals[0]?.consumedAt).toBeNull();
    record = valueOf(await value.service.execute("human", record.contributionId, record.revision, "PUBLICATION")); expect(record.stage).toBe("PR_PUBLISHED");
    expect(value.records.events(record.contributionId).map(({ outcome }) => outcome)).toContain("FAILED");
  });

  it("survives restart with immutable record and hash-chained audit history", async () => {
    const value = await fixture(); const record = await accepted(value); const reopened = await ContributionStore.open(path.join(value.root, ".records", "contributions.json"));
    expect(reopened.get(record.contributionId)).toEqual(record); const events = reopened.events(record.contributionId); expect(events[1]!.previousHash).toBe(events[0]!.eventHash);
  });

  it.each(["rejected review", "restored emergency stop", "nonretryable publication failure", "retryable publication failure before emergency stop"] as const)(
    "classifies terminal repair references without reopening blocked work after %s", async (cause) => {
      const value = await fixture();
      let record = valueOf(await value.service.create(value.author, value.input));
      if (cause === "rejected review") {
        record = valueOf(await value.service.review(value.reviewer, record.contributionId, record.revision, "REJECTED", "Changes require revision"));
      } else {
        record = valueOf(await value.service.review(value.reviewer, record.contributionId, record.revision, "ACCEPTED", "Exact source accepted"));
        if (cause === "restored emergency stop") {
          value.setEmergency(true);
          expect(await value.service.approve("human", record.contributionId, record.revision, "PUBLICATION", {}))
            .toMatchObject({ kind: "rejected", reason: "Emergency stop is active" });
          value.setEmergency(false);
        } else {
          record = valueOf(await value.service.approve("human", record.contributionId, record.revision, "PUBLICATION", {}));
          const retryable = cause === "retryable publication failure before emergency stop";
          value.external.fail = { message: "Publication failed", retryable };
          expect(await value.service.execute("human", record.contributionId, record.revision, "PUBLICATION"))
            .toEqual({ kind: "failed", reason: "Publication failed", retryable });
          if (retryable) {
            value.setEmergency(true);
            expect(await value.service.execute("human", record.contributionId, record.revision, "PUBLICATION"))
              .toEqual({ kind: "rejected", reason: "Emergency stop is active" });
            value.setEmergency(false);
          }
        }
        record = value.service.get(record.contributionId)!;
      }
      expect(record).toMatchObject({ stage: "BLOCKED", blockedReason: expect.any(String) });
      const externalCalls = [...value.external.calls];
      async function attemptRecovery(service: ContributionService) {
        expect(valueOf(await service.create(value.author, value.input))).toEqual(record);
        for (const decision of ["ACCEPTED", "REJECTED"] as const) {
          expect(await service.review(value.reviewer, record.contributionId, record.revision, decision, "Reviewed again"))
            .toEqual({ kind: "rejected", reason: "Contribution is not awaiting review" });
        }
        for (const kind of ["PUBLICATION", "MERGE", "DEPLOYMENT"] as const) {
          expect(await service.approve("human", record.contributionId, record.revision, kind, { environment: "test", artifactDigest: "e".repeat(64) }))
            .toEqual({ kind: "rejected", reason: `${kind} approval is out of order` });
          expect(await service.execute("human", record.contributionId, record.revision, kind)).toMatchObject({ kind: "rejected" });
        }
        expect(service.get(record.contributionId)).toEqual(record);
        expect(contributionRepositoryReference(record, service.audit(record.contributionId)))
          .toMatchObject({ terminal: true, reconciled: cause === "rejected review" || cause === "restored emergency stop" });
        expect(value.external.calls).toEqual(externalCalls);
      }
      await attemptRecovery(value.service);
      await attemptRecovery(await value.restart());
      const reopened = await ContributionStore.open(path.join(value.root, ".records", "contributions.json"));
      expect(reopened.get(record.contributionId)).toEqual(record);
    },
  );

  it("fails closed for absent, unknown, or mismatched blocked-contribution evidence", async () => {
    const f = await fixture();
    const created = valueOf(await f.service.create(f.author, f.input));
    expect(contributionRepositoryReference(created, f.service.audit(created.contributionId)).terminal).toBe(false);
    const blocked = valueOf(await f.service.review(f.reviewer, created.contributionId, created.revision, "REJECTED", "Needs revision"));
    const audit = f.service.audit(blocked.contributionId);
    expect(contributionRepositoryReference(blocked, audit).reconciled).toBe(true);
    for (const history of [[], audit.slice(1), audit.slice(0, 1), audit.map((event) => ({ ...event, action: "UNKNOWN_TRANSITION" })),
      audit.map((event) => ({ ...event, recordDigest: "0".repeat(64) })), audit.map((event) => ({ ...event, externalResultId: "unknown-result" }))]) {
      expect(contributionRepositoryReference(blocked, history).reconciled).toBe(false);
    }
    expect(contributionRepositoryReference({ ...blocked, blockedReason: null }, audit).reconciled).toBe(false);
  });

  it.each(["MERGE", "DEPLOYMENT"] as const)("keeps published work blocking repair after a failed %s", async (kind) => {
    const f = await fixture(); let record = await accepted(f);
    record = valueOf(await f.service.approve("human", record.contributionId, record.revision, "PUBLICATION", {}));
    record = valueOf(await f.service.execute("human", record.contributionId, record.revision, "PUBLICATION"));
    if (kind === "DEPLOYMENT") {
      record = valueOf(await f.service.approve("human", record.contributionId, record.revision, "MERGE", {}));
      record = valueOf(await f.service.execute("human", record.contributionId, record.revision, "MERGE"));
    }
    record = valueOf(await f.service.approve("human", record.contributionId, record.revision, kind, { environment: "test", artifactDigest: "e".repeat(64) }));
    f.external.fail = { message: "External failure", retryable: false };
    expect(await f.service.execute("human", record.contributionId, record.revision, kind)).toMatchObject({ kind: "failed" });
    const restarted = await f.restart();
    record = restarted.get(record.contributionId)!;
    expect(record.stage).toBe("BLOCKED");
    expect(contributionRepositoryReference(record, restarted.audit(record.contributionId))).toMatchObject({ terminal: true, reconciled: false });
  });

  it("does not infer absence of external effects from an unused approval after a lost result", async () => {
    const f = await fixture(); let record = await accepted(f);
    record = valueOf(await f.service.approve("human", record.contributionId, record.revision, "PUBLICATION", {}));
    // Reproduce the durable boundary after publication acts but the process
    // crashes before ContributionService can record its result or a failure.
    await f.external.publish();
    const restarted = await f.restart();
    f.setEmergency(true);
    expect(await restarted.execute("human", record.contributionId, record.revision, "PUBLICATION"))
      .toEqual({ kind: "rejected", reason: "Emergency stop is active" });
    f.setEmergency(false);
    record = restarted.get(record.contributionId)!;
    expect(record).toMatchObject({ stage: "BLOCKED", pullRequest: null, approvals: [{ consumedAt: null, externalResultId: null }] });
    expect(restarted.audit(record.contributionId).some((event) => event.action === "PUBLICATION_FAILED" || event.action === "PUBLICATION_EXECUTED")).toBe(false);
    expect(contributionRepositoryReference(record, restarted.audit(record.contributionId))).toMatchObject({ terminal: true, reconciled: false });
    const reopened = await f.restart();
    expect(contributionRepositoryReference(reopened.get(record.contributionId)!, reopened.audit(record.contributionId)).reconciled).toBe(false);
    expect(f.external.calls).toEqual(["publish"]);
  });
});

function valueOf(result: Awaited<ReturnType<ContributionService["approve"]>>) { if (result.kind !== "ok") throw new Error(JSON.stringify(result)); return result.value; }
async function git(cwd: string, args: readonly string[]) { const { stdout } = await exec("git", [...args], { cwd }); return stdout.trim(); }
