import { describe, expect, it, vi } from "vitest";
import type { ContributionRecord, ExactContributionApproval } from "./contribution-record.js";
import { GovernedContributionExecutor } from "./contribution-executor.js";
import type { DeveloperTeamRegistry } from "./developer-team.js";
import type { GitHubContributionBroker } from "./github-contribution-broker.js";
import type { GitHubContributionClient } from "./github-client.js";

const source = { repository: "owner/repo", taskId: "task", taskRevision: 4, improvementId: "improvement", improvementRevision: 8, assignmentId: "assignment", assignmentRevision: 2,
  authorId: "author", authorRevision: 1, fencingToken: 7, manifestRevision: 3, branch: "amfaa/assignment-one-12345678", baseSha: "a".repeat(40), headSha: "b".repeat(40), manifestDigest: "c".repeat(64), brokerRevision: "assignment-git-broker/v1" };
const contribution = { contributionId: "contribution", handoffKey: "handoff:key", handoffRequestDigest: "d".repeat(64), source, title: "Title", description: "Description", pullRequest: { number: 9, url: "url", publishedAt: "now" }, merged: null } as unknown as ContributionRecord;
const approval = { approvalId: "approval", repository: source.repository, branch: source.branch, baseSha: source.baseSha, headSha: source.headSha } as ExactContributionApproval;

describe("production exact contribution executor", () => {
  it("publishes through the scoped broker using the frozen source revisions", async () => {
    const execute = vi.fn(async () => ({ kind: "ok", value: { id: "pr", url: "url", number: 9 }, claims: {}, replayed: false }));
    const developers = { latest: () => ({ memberId: "author", revision: 1, roles: ["AUTHOR"] }) } as unknown as DeveloperTeamRegistry;
    const executor = new GovernedContributionExecutor({ execute } as unknown as GitHubContributionBroker, {} as GitHubContributionClient, developers, source.repository, "main");
    await expect(executor.publish({ contribution, approval })).resolves.toEqual({ number: 9, url: "url", resultId: "pr" });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ member: expect.objectContaining({ memberId: "author" }) }), expect.objectContaining({ operation: "PUBLISH_DRAFT_PULL_REQUEST", expectedTaskRevision: 4, expectedAssignmentRevision: 2, expectedHeadSha: source.headSha }));
  });

  it("revalidates the exact draft, marks it ready, revalidates again, and merges only the approved head", async () => {
    const client = { readBranchHead: vi.fn(async () => source.baseSha), pullRequestIdentity: vi.fn()
      .mockResolvedValueOnce({ state: "open", draft: true, headSha: source.headSha, baseSha: source.baseSha, headRef: source.branch })
      .mockResolvedValueOnce({ state: "open", draft: false, headSha: source.headSha, baseSha: source.baseSha, headRef: source.branch }),
      markPullRequestReady: vi.fn(async () => ({ id: "ready", url: "url" })), mergePullRequest: vi.fn(async () => ({ id: "merge", commitSha: "d".repeat(40) })) } as unknown as GitHubContributionClient;
    const executor = new GovernedContributionExecutor({} as GitHubContributionBroker, client, {} as DeveloperTeamRegistry, source.repository, "main");
    await expect(executor.merge({ contribution, approval })).resolves.toEqual({ commitSha: "d".repeat(40), resultId: "merge" });
    expect(client.markPullRequestReady).toHaveBeenCalledWith(source.repository, 9); expect(client.mergePullRequest).toHaveBeenCalledWith(source.repository, 9, source.headSha);
  });

  it("fails before readiness or merge when the protected base moved", async () => {
    const client = { readBranchHead: vi.fn(async () => "f".repeat(40)), pullRequestIdentity: vi.fn(), markPullRequestReady: vi.fn(), mergePullRequest: vi.fn() } as unknown as GitHubContributionClient;
    const executor = new GovernedContributionExecutor({} as GitHubContributionBroker, client, {} as DeveloperTeamRegistry, source.repository, "main");
    await expect(executor.merge({ contribution, approval })).rejects.toThrow("Protected base changed"); expect(client.mergePullRequest).not.toHaveBeenCalled();
  });
});
